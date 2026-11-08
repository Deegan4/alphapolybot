import { BaseStrategy } from './BaseStrategy'
import type { ArbRound, DipArbConfig, Market } from '@/types'
import { polymarketUSClient } from '@/services/api'
import { realtimeService } from '@/services/realtime'
import { tradingService } from '@/services/trading/TradingService'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { tradeLogger } from '@/services/trading/TradeLogger'
import { rejectionTracker } from '@/services/trading/RejectionTracker'
import { KellySizer } from '@/services/trading/KellySizer'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'

// ==========================================
// DEFAULTS
// ==========================================

const DEFAULT_CONFIG: DipArbConfig = {
  shares: 5,
  sumTarget: 0.96,          // buy both legs only when asks sum to ≤ 96¢ (≥ ~4% locked in before fees)
  dipThreshold: 0.05,       // legacy dip-trigger field (unused on PM US — see class doc)
  slidingWindowMs: 30000,   // legacy dip-trigger field (unused on PM US)
  targetResolutionMinutes: 15,
  minVolume: 50,
  maxConcurrentTrades: 2,
  cooldownMs: 30000,
  spreadScanEnabled: true,
  spreadScanIntervalMs: 15_000,
  spreadScanBatchSize: 150,
  marketRefreshMs: 60_000,
  askPremium: 0.01,
  stopLossPercent: 0.20,    // only for a stranded single leg (fallback sell failed)
  takeProfitPercent: 0.10,
}

const round2 = (n: number) => Math.round(n * 100) / 100
const floor2 = (n: number) => Math.floor(n * 100) / 100

/** PLM thresholds that can never fire — arb legs are held to resolution */
const HOLD_TO_RESOLUTION = { stopLossPercent: 2, takeProfitPercent: 10, maxHoldMs: 0 } as const

// ==========================================
// PURE HELPERS (unit tested)
// ==========================================

export interface TwoLegArb {
  askSum: number
  legPriceA: number       // limit price for outcome A (ask + premium, ≤ 0.99)
  legPriceB: number
  costPerShare: number    // legPriceA + legPriceB
  profitPerShare: number  // 1 - costPerShare (each share pays $1 at resolution)
  profitPercent: number   // profitPerShare / costPerShare
}

/**
 * Two mutually exclusive outcome markets: buying one share of each costs
 * askA + askB and pays exactly $1 at resolution. An arb exists when the asks
 * (plus the premium we pay for fill certainty) sum to less than `sumTarget`.
 */
export function evaluateTwoLegArb(askA: number, askB: number, sumTarget: number, askPremium = 0.01): TwoLegArb | null {
  if (!(askA > 0 && askA < 1 && askB > 0 && askB < 1)) return null
  const askSum = askA + askB
  if (askSum >= sumTarget) return null

  const legPriceA = Math.min(0.99, round2(askA + askPremium))
  const legPriceB = Math.min(0.99, round2(askB + askPremium))
  const costPerShare = round2(legPriceA + legPriceB)
  if (costPerShare >= sumTarget) return null // premium ate the edge

  const profitPerShare = round2(1 - costPerShare)
  return {
    askSum: round2(askSum),
    legPriceA,
    legPriceB,
    costPerShare,
    profitPerShare,
    profitPercent: profitPerShare / costPerShare,
  }
}

export interface ArbLegSizes {
  shares: number     // identical on both legs — that is what makes the payoff certain
  amountA: number    // USD for leg A
  amountB: number    // USD for leg B
  totalCost: number
}

/** Equal share count on both legs, sized to `tradeAmountUSD`; null if a leg would be below `minLegUSD`. */
export function sizeArbLegs(tradeAmountUSD: number, arb: TwoLegArb, minLegUSD = 1): ArbLegSizes | null {
  if (!(tradeAmountUSD > 0) || arb.costPerShare <= 0) return null
  const shares = floor2(tradeAmountUSD / arb.costPerShare)
  if (shares <= 0) return null
  const amountA = round2(shares * arb.legPriceA)
  const amountB = round2(shares * arb.legPriceB)
  if (amountA < minLegUSD || amountB < minLegUSD) return null
  return { shares, amountA, amountB, totalCost: round2(amountA + amountB) }
}

/**
 * Candidate events: active, exactly two outcome markets (each with its own
 * order book), with some volume. Sorted so thin, moderately-traded markets
 * come first — that is where spreads are wide enough for asks to sum < $1.
 */
export function selectArbCandidates(markets: Market[], batchSize: number, minVolume: number): Market[] {
  return markets
    .filter(m => m.active && !m.closed)
    .filter(m => m.outcomeSlugs?.length === 2 && m.outcomes.length === 2)
    .filter(m => (m.volume24hr ?? m.volume ?? 0) >= minVolume)
    .sort((a, b) => {
      const score = (m: Market) => (m.liquidity ?? 0) - (m.volume24hr ?? m.volume ?? 0) * 0.1
      return score(a) - score(b)
    })
    .slice(0, batchSize)
}

/**
 * TradingService.placeBet orders against `market.slug`, so each leg is placed
 * through a synthetic Market whose slug is the outcome market and whose
 * "yes" is that outcome (buy-long on the outcome market).
 */
export function syntheticLegMarket(parent: Market, outcomeIndex: 0 | 1, legPrice: number): Market {
  const slug = parent.outcomeSlugs![outcomeIndex]
  const label = parent.outcomes[outcomeIndex]
  return {
    id: `${parent.id}:${slug}`,
    slug,
    question: `${parent.question} — ${label}`,
    outcomes: ['Yes', 'No'],
    outcomePrices: [legPrice, round2(1 - legPrice)],
    active: parent.active,
    closed: parent.closed,
    endDate: parent.endDate,
    createdAt: parent.createdAt,
    volume: parent.volume,
    liquidity: parent.liquidity,
    eventSlug: parent.eventSlug ?? parent.slug,
    category: parent.category,
  }
}

// ==========================================
// STRATEGY
// ==========================================

/**
 * Dip Arbitrage — Polymarket US two-leg arbitrage.
 *
 * On PM US an event with two mutually exclusive outcomes is two markets, each
 * with its own order book. Buying one share of each costs askA + askB and pays
 * exactly $1 when the event resolves. When the asks sum to less than
 * `sumTarget` the profit is locked in at entry; there is no on-chain merge —
 * positions simply settle at resolution.
 *
 * Detection is WebSocket-first (both outcome books are subscribed; every price
 * tick re-evaluates the pair) with a periodic REST spread scan as a fallback.
 * Both legs are FOK limit orders at ask + premium. If leg 2 fails, leg 1 is
 * sold back immediately; if that also fails the single leg is handed to PLM
 * with a normal stop-loss. Completed pairs are tracked by PLM with thresholds
 * that cannot fire, so they stay on the books until resolution.
 *
 * The legacy "dip trigger" (price drop within a sliding window) is not part of
 * this port; its config fields remain for settings compatibility.
 */
export class DipArbStrategy extends BaseStrategy {
  name = 'Dip Arbitrage'
  description = 'Two-leg arbitrage: buys both outcomes of a binary event when their asks sum to < $1'
  strategyType = 'arbitrage' as const

  private dipConfig: DipArbConfig = DEFAULT_CONFIG

  private trackedMarkets = new Map<string, Market>()      // market.id → Market
  private slugToMarketId = new Map<string, string>()      // outcome slug → market.id
  private subscribedSlugs = new Set<string>()
  private lastTradeTimes = new Map<string, number>()
  private inFlight = new Set<string>()
  private activeTrades = 0
  private arbRounds: ArbRound[] = []

  private unsubscribePrice: (() => void) | null = null
  private scanInterval: number | null = null
  private refreshInterval: number | null = null

  constructor(config?: Partial<DipArbConfig>) {
    super()
    if (config) this.dipConfig = { ...DEFAULT_CONFIG, ...config }
    this._config = { enabled: false, ...this.dipConfig }
  }

  async initialize(): Promise<void> {
    this.log('Dip Arbitrage Strategy initialized (Polymarket US two-leg mode)')
    this.setStatus('idle')
  }

  async start(): Promise<void> {
    if (this._status === 'running') return
    this.log('Starting Dip Arbitrage Strategy')
    this.setStatus('running')

    try {
      const connected = await realtimeService.connect()
      if (!connected) this.logError('WebSocket connection failed — relying on periodic spread scan')
    } catch (error) {
      this.logError('WebSocket connection error', error)
    }

    await this.refreshMarkets()

    this.unsubscribePrice = realtimeService.onPriceUpdate((slug) => {
      void this.onPriceUpdate(slug)
    })

    if (this.dipConfig.spreadScanEnabled !== false) {
      this.scanInterval = window.setInterval(
        () => void this.spreadScan(),
        this.dipConfig.spreadScanIntervalMs ?? 15_000,
      )
    }
    this.refreshInterval = window.setInterval(
      () => void this.refreshMarkets(),
      this.dipConfig.marketRefreshMs ?? 60_000,
    )

    activityLogger.logSystem('Dip Arbitrage Strategy started')
  }

  async stop(): Promise<void> {
    this.log('Stopping Dip Arbitrage Strategy')
    if (this.scanInterval) { clearInterval(this.scanInterval); this.scanInterval = null }
    if (this.refreshInterval) { clearInterval(this.refreshInterval); this.refreshInterval = null }
    if (this.unsubscribePrice) { this.unsubscribePrice(); this.unsubscribePrice = null }

    for (const slug of this.subscribedSlugs) {
      try { realtimeService.unsubscribeMarket(slug) } catch { /* ignore */ }
    }
    this.trackedMarkets.clear()
    this.slugToMarketId.clear()
    this.subscribedSlugs.clear()
    this.inFlight.clear()

    this.setStatus('idle')
    activityLogger.logSystem('Dip Arbitrage Strategy stopped')
  }

  // ==========================================
  // MARKET DISCOVERY
  // ==========================================

  private async refreshMarkets(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return
    try {
      const markets = await polymarketUSClient.getMarkets({ active: true, closed: false })
      const candidates = selectArbCandidates(
        markets,
        this.dipConfig.spreadScanBatchSize ?? 150,
        this.dipConfig.minVolume ?? 0,
      )

      for (const market of candidates) {
        this.trackedMarkets.set(market.id, market)
        for (const slug of market.outcomeSlugs ?? []) {
          this.slugToMarketId.set(slug, market.id)
          if (!this.subscribedSlugs.has(slug)) {
            try {
              realtimeService.subscribeMarket(slug)
              this.subscribedSlugs.add(slug)
            } catch { /* retry next refresh */ }
          }
        }
      }

      this.log(
        `[Refresh] ${markets.length} markets → ${candidates.length} two-outcome candidates | ` +
        `${this.subscribedSlugs.size} books subscribed | WS ${realtimeService.isConnected() ? 'connected' : 'DISCONNECTED'}`,
      )
    } catch (error) {
      this.logError('Market refresh failed', error)
    }
  }

  // ==========================================
  // DETECTION
  // ==========================================

  /** WebSocket path: a tick on either outcome book re-evaluates the pair */
  private async onPriceUpdate(slug: string): Promise<void> {
    const marketId = this.slugToMarketId.get(slug)
    if (!marketId) return
    const market = this.trackedMarkets.get(marketId)
    if (!market?.outcomeSlugs) return

    const [a, b] = market.outcomeSlugs.map(s => realtimeService.getPrice(s))
    if (!a || !b) return
    await this.tryArb(market, a.ask, b.ask, 'ws')
  }

  /** REST fallback: walk tracked markets and check asks where the WS has no data */
  private async spreadScan(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    let checked = 0
    let closest = Infinity
    for (const market of this.trackedMarkets.values()) {
      if (!this._enabled) break
      if (this.activeTrades >= (this.dipConfig.maxConcurrentTrades ?? 1)) break
      const [slugA, slugB] = market.outcomeSlugs ?? []
      if (!slugA || !slugB) continue

      try {
        const [a, b] = await Promise.all([
          realtimeService.getPrice(slugA) ?? polymarketUSClient.getBestPrices(slugA),
          realtimeService.getPrice(slugB) ?? polymarketUSClient.getBestPrices(slugB),
        ])
        if (!a || !b) continue
        checked++
        closest = Math.min(closest, a.ask + b.ask)
        await this.tryArb(market, a.ask, b.ask, 'scan')
      } catch {
        rejectionTracker.record('liquidity', 'dip', 'price fetch failed')
      }
    }

    if (checked > 0) {
      this.log(`Spread scan: ${checked} pairs checked, closest ask sum ${(closest * 100).toFixed(1)}¢ (target < ${((this.dipConfig.sumTarget) * 100).toFixed(0)}¢)`)
    }
  }

  private async tryArb(market: Market, askA: number, askB: number, source: 'ws' | 'scan'): Promise<void> {
    if (!this._enabled || this._status !== 'running') return
    if (this.inFlight.has(market.id)) return
    if (this.activeTrades >= (this.dipConfig.maxConcurrentTrades ?? 1)) return

    const cooldown = this.dipConfig.cooldownMs ?? 30_000
    if (Date.now() - (this.lastTradeTimes.get(market.id) ?? 0) < cooldown) return

    const arb = evaluateTwoLegArb(askA, askB, this.dipConfig.sumTarget, this.dipConfig.askPremium ?? 0.01)
    if (!arb) return

    this.inFlight.add(market.id)
    try {
      await this.executeArb(market, arb, source)
    } finally {
      this.inFlight.delete(market.id)
    }
  }

  // ==========================================
  // EXECUTION
  // ==========================================

  private async executeArb(market: Market, arb: TwoLegArb, source: 'ws' | 'scan'): Promise<void> {
    const [slugA, slugB] = market.outcomeSlugs!
    const [labelA, labelB] = market.outcomes

    this.log(
      `ARB (${source}): "${market.question.substring(0, 40)}…" ${labelA} ${(arb.legPriceA * 100).toFixed(0)}¢ + ` +
      `${labelB} ${(arb.legPriceB * 100).toFixed(0)}¢ = ${(arb.costPerShare * 100).toFixed(0)}¢ → locks ${(arb.profitPerShare * 100).toFixed(1)}¢/share (${(arb.profitPercent * 100).toFixed(1)}%)`,
    )
    activityLogger.logSystem(`ARB: ${labelA} ${(arb.legPriceA * 100).toFixed(0)}¢ + ${labelB} ${(arb.legPriceB * 100).toFixed(0)}¢ = ${(arb.costPerShare * 100).toFixed(0)}¢`, {
      market: market.question.substring(0, 50),
      askSum: arb.askSum,
      profitPerShare: arb.profitPerShare,
    })

    // Sizing: penny mode → ~$1 per leg, otherwise profit-scaled Kelly on bankroll
    const settings = useSettingsStore.getState()
    let tradeAmount: number
    if (settings.pennyTraderMode) {
      tradeAmount = 2 * Math.max(1, this.dipConfig.shares * Math.max(arb.legPriceA, arb.legPriceB))
    } else {
      const fStar = KellySizer.arbKelly(arb.profitPercent)
      tradeAmount = KellySizer.sizeBet({
        kellyFraction: settings.kellyFraction,
        bankroll: useWalletStore.getState().balance,
        fullKelly: fStar,
      })
    }

    const sizes = sizeArbLegs(tradeAmount, arb)
    if (!sizes) {
      rejectionTracker.record('order_too_small', 'dip', `$${tradeAmount.toFixed(2)} cannot fund two legs`)
      return
    }

    const round: ArbRound = { marketSlug: market.slug, leg1Executed: false, leg2Executed: false }
    this.activeTrades++
    this.lastTradeTimes.set(market.id, Date.now())

    try {
      // ─── Leg 1 (cheaper outcome first — it is the one most likely to move) ───
      const firstIsA = arb.legPriceA <= arb.legPriceB
      const leg1 = firstIsA
        ? { idx: 0 as const, slug: slugA, label: labelA, price: arb.legPriceA, amount: sizes.amountA }
        : { idx: 1 as const, slug: slugB, label: labelB, price: arb.legPriceB, amount: sizes.amountB }
      const leg2 = firstIsA
        ? { idx: 1 as const, slug: slugB, label: labelB, price: arb.legPriceB, amount: sizes.amountB }
        : { idx: 0 as const, slug: slugA, label: labelA, price: arb.legPriceA, amount: sizes.amountA }

      this.log(`LEG 1: BUY ${sizes.shares} × ${leg1.label} @ ${(leg1.price * 100).toFixed(0)}¢ (FOK)`)
      const leg1Result = await tradingService.placeBet(
        syntheticLegMarket(market, leg1.idx, leg1.price),
        'yes',
        leg1.amount,
        { skipGtcFallback: true, orderType: 'FOK', strategy: 'dip', outcomeIndex: 0 },
      )
      if (!leg1Result.success) {
        activityLogger.logWarning(`Dip Arb leg 1 failed: ${leg1Result.error}`)
        rejectionTracker.record('liquidity', 'dip', `leg 1: ${leg1Result.error ?? 'failed'}`)
        this.recordRound(round)
        return
      }
      const leg1Shares = leg1Result.filledSize ?? sizes.shares
      round.leg1Executed = true
      round.leg1Outcome = 'yes'
      round.leg1Price = leg1Result.avgPrice ?? leg1.price
      round.leg1Timestamp = Date.now()
      activityLogger.logTrade(`LEG 1: BUY ${leg1.label} $${leg1.amount.toFixed(2)}`, { marketSlug: leg1.slug, orderId: leg1Result.orderId })

      // ─── Leg 2 ───
      this.log(`LEG 2: BUY ${sizes.shares} × ${leg2.label} @ ${(leg2.price * 100).toFixed(0)}¢ (FOK)`)
      const leg2Result = await tradingService.placeBet(
        syntheticLegMarket(market, leg2.idx, leg2.price),
        'yes',
        leg2.amount,
        { skipGtcFallback: true, orderType: 'FOK', strategy: 'dip', outcomeIndex: 0 },
      )

      if (!leg2Result.success) {
        // Naked single leg — unwind immediately
        activityLogger.logWarning(`Dip Arb leg 2 failed: ${leg2Result.error} — selling leg 1 back`)
        const sell = await tradingService.placeSell(leg1.slug, 'yes', leg1Shares, undefined, 'FOK')
        if (sell.success) {
          activityLogger.logSell('Leg 1 sold back (leg 2 failed)', { marketSlug: leg1.slug, orderId: sell.orderId })
        } else {
          activityLogger.logError(`Fallback sell failed: ${sell.error} — handing leg 1 to PLM`)
          this.trackLeg(market, leg1.slug, leg1.label, round.leg1Price!, leg1Shares, leg1.amount, false)
        }
        this.recordRound(round)
        return
      }

      const leg2Shares = leg2Result.filledSize ?? sizes.shares
      round.leg2Executed = true
      round.leg2Outcome = 'yes'
      round.leg2Price = leg2Result.avgPrice ?? leg2.price
      round.leg2Timestamp = Date.now()
      activityLogger.logTrade(`LEG 2: BUY ${leg2.label} $${leg2.amount.toFixed(2)}`, { marketSlug: leg2.slug, orderId: leg2Result.orderId })

      // Locked-in profit = payout on the smaller leg minus total cost
      const payoutShares = Math.min(leg1Shares, leg2Shares)
      const totalCost = round.leg1Price! * leg1Shares + round.leg2Price! * leg2Shares
      round.profit = round2(payoutShares - totalCost)
      this.recordRound(round)

      // Hold both legs to resolution (PLM thresholds cannot fire)
      this.trackLeg(market, leg1.slug, leg1.label, round.leg1Price!, leg1Shares, leg1.amount, true)
      this.trackLeg(market, leg2.slug, leg2.label, round.leg2Price!, leg2Shares, leg2.amount, true)

      for (const leg of [
        { slug: leg1.slug, label: leg1.label, price: round.leg1Price!, amount: leg1.amount, shares: leg1Shares, orderId: leg1Result.orderId },
        { slug: leg2.slug, label: leg2.label, price: round.leg2Price!, amount: leg2.amount, shares: leg2Shares, orderId: leg2Result.orderId },
      ]) {
        tradeLogger.logEntry({
          marketId: market.id,
          slug: leg.slug,
          question: `${market.question} — ${leg.label}`,
          outcomes: market.outcomes,
          strategy: 'dip',
          side: 'BUY',
          outcome: leg.label,
          marketPrice: leg.price,
          kellyFraction: settings.kellyFraction,
          kellyBetSize: tradeAmount / 2,
          actualBetSize: leg.amount,
          orderId: leg.orderId,
          orderType: 'FOK',
          fillPrice: leg.price,
          filledSize: leg.shares,
          success: true,
          arbProfitRatio: arb.profitPercent,
          legCount: 2,
        })
      }

      activityLogger.logSystem(
        `ARB COMPLETE: ${(arb.costPerShare * 100).toFixed(0)}¢ for $1 at resolution — locked ≈ $${round.profit.toFixed(2)}`,
        { marketSlug: market.slug, profit: round.profit },
      )
      this.emit('arbCompleted', { market, round, arb })
    } catch (error) {
      this.logError('Arb execution failed', error)
      this.recordRound(round)
    } finally {
      this.activeTrades = Math.max(0, this.activeTrades - 1)
    }
  }

  private trackLeg(
    market: Market,
    slug: string,
    label: string,
    entryPrice: number,
    shares: number,
    costBasis: number,
    holdToResolution: boolean,
  ): void {
    import('@/services/trading/PositionLifecycleManager').then(m => {
      m.positionLifecycleManager.trackPosition({
        marketSlug: slug,
        outcome: 'yes',
        question: `${market.question} — ${label}`,
        entryPrice,
        size: shares,
        costBasis,
        entryTime: Date.now(),
        strategy: 'dip',
        ...(holdToResolution
          ? HOLD_TO_RESOLUTION
          : {
              stopLossPercent: this.dipConfig.stopLossPercent ?? 0.20,
              takeProfitPercent: this.dipConfig.takeProfitPercent ?? 0.10,
            }),
      })
    }).catch(err => console.warn('[DipArb] PLM track failed:', err))
  }

  private recordRound(round: ArbRound): void {
    this.arbRounds.push(round)
    if (this.arbRounds.length > 500) this.arbRounds.shift()
    import('@/services/storage').then(({ indexedDBService }) => indexedDBService.storeArbRound(round)).catch(() => {})
  }

  // ==========================================
  // CONFIG / STATS API
  // ==========================================

  getDipConfig(): DipArbConfig {
    return { ...this.dipConfig }
  }

  setDipConfig(config: Partial<DipArbConfig>): void {
    this.dipConfig = { ...this.dipConfig, ...config }
    this._config = { ...this._config, ...this.dipConfig }
    this.emit('configUpdated', this.dipConfig)
  }

  getArbRounds(): ArbRound[] {
    return [...this.arbRounds]
  }

  getArbStats(): { rounds: number; completed: number; failed: number; totalProfit: number } {
    const completed = this.arbRounds.filter(r => r.leg1Executed && r.leg2Executed)
    return {
      rounds: this.arbRounds.length,
      completed: completed.length,
      failed: this.arbRounds.length - completed.length,
      totalProfit: round2(completed.reduce((s, r) => s + (r.profit ?? 0), 0)),
    }
  }
}

export const dipArbStrategy = new DipArbStrategy()
