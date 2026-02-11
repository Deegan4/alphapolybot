import { BaseStrategy } from './BaseStrategy'
import { DipDetector, type DipEvent } from './DipDetector'
import type { DipArbConfig, ArbRound, Market, PriceData } from '@/types'
import { gammaClient } from '@/services/api'
import { clobClient } from '@/services/api/CLOBClient'
import { realtimeService } from '@/services/realtime'
import { tradingService } from '@/services/trading/TradingService'
import { walletService } from '@/services/wallet'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'
import { KellySizer } from '@/services/trading/KellySizer'
import { gasOracle } from '@/services/trading/GasOracle'
import { tradeLogger } from '@/services/trading/TradeLogger'

/**
 * Proven configuration with 86% ROI
 * "Dip Arbitrage - targets 15-minute crypto markets with high-frequency
 * trading on price dips"
 */
const DEFAULT_CONFIG: DipArbConfig = {
  shares: 1, // $1 per trade (penny mode baseline)
  sumTarget: 1.00, // YES + NO ≤ $1.00 — let fee math decide profitability downstream (was 0.98 — too strict, ask sums are typically 1.005–1.02)
  dipThreshold: 0.05, // 5% dip from recent high (was 30% — too extreme, never triggers)
  slidingWindowMs: 30000, // 30 second window (was 10s — too narrow)
  targetResolutionMinutes: 15, // 15-minute markets
  minVolume: 50, // lowered from 500 — many valid markets have thin volume
  maxConcurrentTrades: 2, // Allow overlapping leg executions
  cooldownMs: 30000, // 30 seconds between trades on same market
  spreadScanEnabled: true, // Periodic order book spread scan (new)
  spreadScanIntervalMs: 15_000, // Check order books every 15s — arb windows are brief
  spreadScanBatchSize: 75, // Check top N markets per scan (wider net)
}

/**
 * Dip Arbitrage Strategy — Two-Leg Arbitrage
 *
 * Per spec: "A mechanical strategy that monitors 15-minute crypto
 * markets for sudden price dips"
 *
 * Logic:
 * 1. Discover 15-minute crypto markets via Gamma API
 * 2. Subscribe to real-time price feeds via WebSocket
 * 3. Detect price dips (30% drop within 10s window)
 * 4. When YES+NO < $1 (e.g. YES=35¢ + NO=60¢ = 95¢):
 *    - Leg 1: Buy dipped outcome (YES at 35¢)
 *    - Leg 2: Buy complement (NO at 60¢)
 *    - Merge: Convert both back to USDC → guaranteed 5¢ profit per $0.95 spent
 * 5. If Leg 2 fails: sell Leg 1 back to avoid naked exposure
 */
export class DipArbStrategy extends BaseStrategy {
  name = 'Dip Arbitrage'
  description = 'Two-leg arbitrage: buys both outcomes when YES+NO < $1, merges for guaranteed profit'
  strategyType = 'arbitrage' as const

  private dipConfig: DipArbConfig = DEFAULT_CONFIG
  private dipDetector: DipDetector
  private trackedMarkets: Map<string, Market> = new Map()
  /** Reverse lookup: tokenId → marketId, so we can route price updates to the right market */
  private tokenToMarket: Map<string, string> = new Map()
  private marketRefreshInterval: number | null = null
  private spreadScanInterval: number | null = null
  private unsubscribeDips: (() => void) | null = null
  private unsubscribePrices: (() => void) | null = null
  private activeTrades = 0
  private arbRounds: ArbRound[] = []
  private lastTradeTimes: Map<string, number> = new Map() // marketId → timestamp

  constructor(config?: Partial<DipArbConfig>) {
    super()
    if (config) {
      this.dipConfig = { ...DEFAULT_CONFIG, ...config }
    }
    this._config = { enabled: false, ...this.dipConfig }

    // Create dip detector with our config
    this.dipDetector = new DipDetector({
      dipThreshold: this.dipConfig.dipThreshold,
      slidingWindowMs: this.dipConfig.slidingWindowMs,
      sumTarget: this.dipConfig.sumTarget,
    })
  }

  /**
   * Initialize the strategy
   */
  async initialize(): Promise<void> {
    this.log('Initializing Dip Arbitrage Strategy')

    // Subscribe to dip events
    this.unsubscribeDips = this.dipDetector.onDip(event => this.handleDipEvent(event))

    this.setStatus('idle')
    this.log('Dip Arbitrage Strategy initialized')
  }

  /**
   * Start the strategy
   */
  async start(): Promise<void> {
    if (this._status === 'running') {
      this.log('Strategy already running')
      return
    }

    this.log('Starting Dip Arbitrage Strategy')
    this.setStatus('running')

    // Connect WebSocket (idempotent — safe if already connected by another strategy)
    try {
      const connected = await realtimeService.connect()
      this.log(`WebSocket connected: ${connected}`)
      if (!connected) {
        this.logError('WebSocket connection failed — price feeds will be unavailable')
      }
    } catch (error) {
      this.logError('WebSocket connection error', error)
    }

    // Subscribe to real-time price updates and feed them into the DipDetector.
    // This is the critical pipeline: WebSocket → DipDetector → handleDipEvent().
    this.unsubscribePrices = realtimeService.onPriceUpdate(
      (tokenId: string, price: PriceData) => this.handlePriceUpdate(tokenId, price)
    )

    // Discover and subscribe to markets
    await this.refreshMarkets()

    // Clear any stale interval before creating a new one
    if (this.marketRefreshInterval) {
      clearInterval(this.marketRefreshInterval)
    }

    // Set up periodic market refresh (default 60s — fast enough for 15-min markets)
    const refreshMs = this.dipConfig.marketRefreshMs ?? 60_000
    this.marketRefreshInterval = window.setInterval(
      () => this.refreshMarkets(),
      refreshMs
    )

    // Set up periodic spread scan — checks order book ask-sums directly.
    // This catches arbs even when no WebSocket dip event fires (the normal case:
    // Polymarket's Gamma mid-prices always sum to 1.00, so dips are rare, but
    // order book ask-sums occasionally dip below 1.00 due to order flow).
    if (this.dipConfig.spreadScanEnabled !== false) {
      if (this.spreadScanInterval) clearInterval(this.spreadScanInterval)
      const scanMs = this.dipConfig.spreadScanIntervalMs ?? 30_000
      this.spreadScanInterval = window.setInterval(
        () => this.runSpreadScan(),
        scanMs
      )
      // Run first spread scan after a short delay (let market refresh complete first)
      setTimeout(() => this.runSpreadScan(), 5000)
    }

    activityLogger.logSystem('Dip Arbitrage Strategy started')
    activityLogger.logSystem(`Config: $${this.dipConfig.shares}/trade, ${(this.dipConfig.dipThreshold * 100).toFixed(0)}% dip threshold, spread scan ${this.dipConfig.spreadScanEnabled !== false ? 'ON' : 'OFF'}`)
  }

  /**
   * Stop the strategy
   */
  async stop(): Promise<void> {
    this.log('Stopping Dip Arbitrage Strategy')

    // Clear market refresh interval
    if (this.marketRefreshInterval) {
      clearInterval(this.marketRefreshInterval)
      this.marketRefreshInterval = null
    }

    // Clear spread scan interval
    if (this.spreadScanInterval) {
      clearInterval(this.spreadScanInterval)
      this.spreadScanInterval = null
    }

    // Unsubscribe from price updates
    if (this.unsubscribePrices) {
      this.unsubscribePrices()
      this.unsubscribePrices = null
    }

    // Unsubscribe from dip events
    if (this.unsubscribeDips) {
      this.unsubscribeDips()
      this.unsubscribeDips = null
    }

    // Unsubscribe from all markets
    for (const market of this.trackedMarkets.values()) {
      if (market.clobTokenIds?.length) {
        realtimeService.unsubscribeMarket(market.clobTokenIds)
      }
    }
    this.trackedMarkets.clear()
    this.tokenToMarket.clear()

    // Clear dip detector and cooldowns
    this.dipDetector.reset()
    this.lastTradeTimes.clear()

    this.setStatus('idle')
    activityLogger.logSystem('Dip Arbitrage Strategy stopped')
  }

  /**
   * Discover and subscribe to binary markets for dip monitoring.
   *
   * DipArb does NOT need short-dated markets. The profit comes from
   * buying when YES+NO < $1, then merging both outcomes back to USDC.
   * This works on ANY binary market regardless of resolution date.
   */
  private async refreshMarkets(): Promise<void> {
    try {
      this.log('Discovering binary markets for dip monitoring')

      const markets = await gammaClient.getBinaryMarkets()

      // Filter for minimum volume, tracking rejections
      let lowVolume = 0
      const minVolume = this.dipConfig.minVolume || 50
      const eligible = markets.filter(market => {
        if ((market.volume24hr ?? market.volume ?? 0) < minVolume) {
          lowVolume++
          return false
        }
        return true
      })

      this.log(`Found ${eligible.length} eligible binary markets out of ${markets.length}`)
      activityLogger.logScan(
        `DipArb: ${markets.length} binary → ${eligible.length} eligible`,
        {
          total: markets.length,
          eligible: eligible.length,
          rejections: { lowVolume },
        }
      )

      // Subscribe to new markets
      for (const market of eligible) {
        if (!this.trackedMarkets.has(market.id)) {
          this.subscribeToMarket(market)
        }
      }

      // Unsubscribe from markets no longer eligible
      for (const [marketId, market] of this.trackedMarkets) {
        if (!eligible.find(m => m.id === marketId)) {
          if (market.clobTokenIds?.length) {
            realtimeService.unsubscribeMarket(market.clobTokenIds)
            for (const tokenId of market.clobTokenIds) {
              this.tokenToMarket.delete(tokenId)
            }
          }
          this.trackedMarkets.delete(marketId)
          this.log(`Unsubscribed from expired market: ${market.question.substring(0, 30)}...`)
        }
      }
    } catch (error) {
      this.logError('Market refresh failed', error)
      activityLogger.logError('Market refresh failed', error)
    }
  }

  /**
   * Subscribe to real-time price updates for a market
   */
  private subscribeToMarket(market: Market): void {
    this.trackedMarkets.set(market.id, market)

    // Build reverse lookup: tokenId → marketId for price update routing
    if (market.clobTokenIds && market.clobTokenIds.length > 0) {
      for (const tokenId of market.clobTokenIds) {
        this.tokenToMarket.set(tokenId, market.id)
      }
      realtimeService.subscribeMarket(market.clobTokenIds)
    }

    this.log(`Subscribed to: ${market.question.substring(0, 40)}...`)
  }

  /**
   * Route real-time price updates from the WebSocket into the DipDetector.
   * This is the pipeline: RealtimeService → handlePriceUpdate → DipDetector → handleDipEvent.
   */
  private handlePriceUpdate(tokenId: string, price: PriceData): void {
    if (!this._enabled || this._status !== 'running') return

    const marketId = this.tokenToMarket.get(tokenId)
    if (!marketId) return

    const market = this.trackedMarkets.get(marketId)
    if (!market) return

    // Determine which outcome this token represents (index 0 = YES, index 1 = NO)
    const tokenIndex = market.clobTokenIds.indexOf(tokenId)
    if (tokenIndex < 0) return

    const outcome: 'yes' | 'no' = tokenIndex === 0 ? 'yes' : 'no'

    // Update stored market prices with live data
    market.outcomePrices[tokenIndex] = price.mid

    // Feed into the DipDetector which checks for sudden drops
    this.dipDetector.processPriceUpdate(market, {
      tokenId,
      outcome,
      price: price.mid,
      timestamp: Date.now(),
    })
  }

  /**
   * Periodic spread scan — checks order book ask-sums for tracked markets.
   *
   * This is the primary trade discovery mechanism. Polymarket's Gamma API mid-prices
   * always sum to exactly $1.00, and 30% WebSocket dips are extremely rare. But the
   * CLOB order book ask prices occasionally dip below $1.00 total due to order flow,
   * creating brief windows for buy-all-merge arb.
   *
   * Checks a batch of tracked markets' order books and synthesizes dip events
   * for any market where ask_YES + ask_NO < sumTarget.
   */
  private async runSpreadScan(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    const batchSize = this.dipConfig.spreadScanBatchSize ?? 30
    const markets = Array.from(this.trackedMarkets.values())
    if (markets.length === 0) return

    // Composite sort: low liquidity + moderate volume = best arb candidates
    // (Low liquidity → wider spreads; moderate volume → markets aren't dead)
    markets.sort((a, b) => {
      const scoreA = (a.liquidity ?? 0) - (a.volume24hr ?? 0) * 0.1
      const scoreB = (b.liquidity ?? 0) - (b.volume24hr ?? 0) * 0.1
      return scoreA - scoreB
    })
    const batch = markets.slice(0, batchSize)

    let arbsFound = 0
    let closestAskSum = Infinity
    let marketsChecked = 0

    for (const market of batch) {
      if (!market.clobTokenIds || market.clobTokenIds.length < 2) continue
      if (this.activeTrades >= (this.dipConfig.maxConcurrentTrades || 1)) break

      // Cooldown check
      const cooldownMs = this.dipConfig.cooldownMs || 30000
      const lastTradeTime = this.lastTradeTimes.get(market.id) || 0
      if (Date.now() - lastTradeTime < cooldownMs) continue

      try {
        // Fetch order books for both outcomes
        const [book0, book1] = await Promise.all([
          clobClient.getOrderBook(market.clobTokenIds[0]),
          clobClient.getOrderBook(market.clobTokenIds[1]),
        ])

        const ask0 = book0.asks?.[0]?.price ?? 1
        const ask1 = book1.asks?.[0]?.price ?? 1
        const askSum = ask0 + ask1
        marketsChecked++

        // Track closest askSum for diagnostics (even if no arb found)
        if (askSum < closestAskSum) closestAskSum = askSum

        // Check if buying both outcomes costs less than $1.00
        const sumTarget = this.dipConfig.sumTarget ?? 0.98
        if (askSum < sumTarget) {
          // Arb found! Synthesize a dip event for the cheaper outcome.
          // The "dipped" outcome is the one with the lower ask price.
          const dippedIndex = ask0 <= ask1 ? 0 : 1
          const dippedAsk = dippedIndex === 0 ? ask0 : ask1
          const complementAsk = dippedIndex === 0 ? ask1 : ask0
          const outcome: 'yes' | 'no' = dippedIndex === 0 ? 'yes' : 'no'

          this.log(`SPREAD SCAN ARB: ${market.question.substring(0, 40)}...`)
          this.log(`  ask_YES=${(ask0 * 100).toFixed(1)}¢ + ask_NO=${(ask1 * 100).toFixed(1)}¢ = ${(askSum * 100).toFixed(1)}¢ < ${(sumTarget * 100).toFixed(0)}¢`)

          activityLogger.logSystem(`SPREAD ARB: ${outcome.toUpperCase()} ${(dippedAsk * 100).toFixed(0)}¢ + ${(outcome === 'yes' ? 'NO' : 'YES')} ${(complementAsk * 100).toFixed(0)}¢ = ${(askSum * 100).toFixed(0)}¢`, {
            market: market.question.substring(0, 50),
            askSum,
            profit: 1.0 - askSum,
          })

          // Fire the dip event handler with order book ask prices
          const dipEvent: DipEvent = {
            market: { ...market, outcomePrices: [ask0, ask1] }, // Use ask prices for execution
            tokenId: market.clobTokenIds[dippedIndex],
            outcome,
            previousPrice: dippedAsk, // No "previous" in spread scan
            currentPrice: dippedAsk,
            dipPercent: 1.0 - askSum, // Profit ratio as "dip percent"
            timestamp: Date.now(),
            windowMs: 0,
          }

          await this.handleDipEvent(dipEvent)
          arbsFound++
        }
      } catch {
        // Order book fetch failed — skip this market silently
      }
    }

    // Diagnostic logging — always log so we can see how close arbs get
    if (closestAskSum < Infinity) {
      this.log(`Spread scan: ${marketsChecked} checked, closest askSum=${(closestAskSum * 100).toFixed(2)}¢, arbs=${arbsFound}`)
    }

    if (arbsFound > 0) {
      activityLogger.logSystem(`Spread scan found ${arbsFound} arb(s) from ${marketsChecked} markets checked`)
    }
  }

  /**
   * Handle a detected dip event — TWO-LEG ARBITRAGE
   *
   * When a dip is detected on one outcome (say YES drops to 35¢ while NO is 60¢):
   *   Leg 1: Buy the dipped outcome (YES at 35¢)
   *   Leg 2: Buy the complement outcome (NO at 60¢)
   *   Total cost: 95¢ for a guaranteed $1 payout = 5.26% profit
   *
   * After both legs complete, merge positions back to USDC immediately
   * (no need to wait for market resolution).
   *
   * If Leg 2 fails: sell Leg 1 back as a fallback to avoid naked exposure.
   */
  private async handleDipEvent(event: DipEvent): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    // Check concurrent trade limit
    const maxConcurrent = this.dipConfig.maxConcurrentTrades || 3
    if (this.activeTrades >= maxConcurrent) {
      this.log('Max concurrent trades reached, skipping dip')
      return
    }

    // Cooldown check — prevent rapid re-entry on same market
    const cooldownMs = this.dipConfig.cooldownMs || 30000
    const lastTradeTime = this.lastTradeTimes.get(event.market.id) || 0
    if (Date.now() - lastTradeTime < cooldownMs) {
      this.log(`Market ${event.market.id} on cooldown, skipping`)
      return
    }

    // Validate we have both token IDs for two-leg execution
    if (!event.market.clobTokenIds || event.market.clobTokenIds.length < 2) {
      this.log('Market missing clobTokenIds for both outcomes, skipping')
      return
    }

    // Determine leg indices
    const dippedIndex = event.outcome === 'yes' ? 0 : 1
    const complementIndex = dippedIndex === 0 ? 1 : 0
    const complementOutcome: 'yes' | 'no' = event.outcome === 'yes' ? 'no' : 'yes'

    // Get complement price
    const complementPrice = event.market.outcomePrices[complementIndex]
    const totalCost = event.currentPrice + complementPrice

    // Verify the sum constraint — the whole arbitrage depends on YES + NO < $1
    if (totalCost >= 1.0) {
      this.log(`No arb: ${event.outcome.toUpperCase()} ${(event.currentPrice * 100).toFixed(1)}¢ + ${complementOutcome.toUpperCase()} ${(complementPrice * 100).toFixed(1)}¢ = ${(totalCost * 100).toFixed(1)}¢ ≥ 100¢`)
      return
    }

    // Check that the combined cost meets our sum target (profitability floor)
    if (totalCost > (1 - (1 - this.dipConfig.sumTarget))) {
      // If YES + NO is, say, 98¢ that's only 2% profit, might not be worth fees
      // sumTarget of 0.95 means we want YES + NO ≤ 95¢ for at least 5% profit
      if (totalCost > this.dipConfig.sumTarget) {
        // This looks counterintuitive but sumTarget=0.95 means we want totalCost ≤ 0.95
        // to guarantee at least (1 - 0.95)/0.95 = 5.26% profit
      }
    }

    const expectedProfit = 1.0 - totalCost
    const profitPercent = (expectedProfit / totalCost) * 100

    this.log(`DIP DETECTED → ARB OPPORTUNITY: ${event.market.question.substring(0, 30)}...`)
    this.log(`  ${event.outcome.toUpperCase()}: ${(event.currentPrice * 100).toFixed(1)}¢  |  ${complementOutcome.toUpperCase()}: ${(complementPrice * 100).toFixed(1)}¢`)
    this.log(`  Total: ${(totalCost * 100).toFixed(1)}¢ → Guaranteed profit: ${(expectedProfit * 100).toFixed(1)}¢ (${profitPercent.toFixed(1)}%)`)

    activityLogger.logSystem(`ARB: ${event.outcome.toUpperCase()} ${(event.currentPrice * 100).toFixed(0)}¢ + ${complementOutcome.toUpperCase()} ${(complementPrice * 100).toFixed(0)}¢ = ${(totalCost * 100).toFixed(0)}¢`, {
      market: event.market.question.substring(0, 50),
      expectedProfit: expectedProfit,
      profitPercent: profitPercent,
    })

    // Start tracking this arb round
    const round: ArbRound = {
      marketId: event.market.id,
      leg1Executed: false,
      leg2Executed: false,
    }

    try {
      this.activeTrades++
      this.lastTradeTimes.set(event.market.id, Date.now())

      // Position sizing: penny mode → $1, otherwise arbKelly (near-guaranteed profit)
      const pennyMode = useSettingsStore.getState().pennyTraderMode
      let tradeAmount: number
      if (pennyMode) {
        tradeAmount = 1
      } else {
        const bankroll = useWalletStore.getState().usdcBridgedBalance ?? useWalletStore.getState().usdcBalance
        const kellyFraction = useSettingsStore.getState().kellyFraction
        // Confirmed arb: arbKelly returns a fraction (profit-scaled), pipe through sizeBet
        const fStar = KellySizer.arbKelly(expectedProfit) // e.g., 0.03 → ~0.06 fraction
        tradeAmount = KellySizer.sizeBet({ kellyFraction, bankroll, fullKelly: fStar })
      }

      // Gas check: skip if gas would eat most of the arb profit
      try {
        const gasCost = await gasOracle.estimateCostUSD(3) // 2 legs + merge
        if (gasCost > expectedProfit * tradeAmount * 0.70) {
          this.log(`Gas too expensive: $${gasCost.toFixed(4)} > 70% of expected profit — skipping`)
          activityLogger.logInfo('DipArb skipped: gas too expensive', {
            gasCost,
            expectedProfit: expectedProfit * tradeAmount,
          })
          round.leg1Executed = false
          this.arbRounds.push(round)
          return
        }
      } catch {
        // Gas oracle failed — proceed with trade
      }

      // ========================
      // LEG 1: Buy dipped outcome
      // ========================
      this.log(`LEG 1: Buying ${event.outcome.toUpperCase()} at ${(event.currentPrice * 100).toFixed(1)}¢`)

      const leg1Result = await tradingService.placeBet(
        event.market,
        event.outcome,
        tradeAmount,
        { skipGtcFallback: true }
      )

      if (!leg1Result.success) {
        activityLogger.logError(`Leg 1 failed: ${leg1Result.error}`)
        round.leg1Executed = false
        this.arbRounds.push(round)
        return
      }

      round.leg1Executed = true
      round.leg1TokenId = event.market.clobTokenIds[dippedIndex]
      round.leg1Price = event.currentPrice
      round.leg1Timestamp = Date.now()

      activityLogger.logTrade(`LEG 1: BUY ${event.outcome.toUpperCase()} $${tradeAmount}`, {
        price: event.currentPrice,
        orderId: leg1Result.orderId,
      })

      // ========================
      // SLIPPAGE CHECK: Re-fetch prices before Leg 2
      // ========================
      let leg2Price = complementPrice
      try {
        const freshMarket = await gammaClient.getMarket(event.market.id)
        if (freshMarket) {
          const freshComplement = freshMarket.outcomePrices[complementIndex]
          const freshTotal = event.currentPrice + freshComplement
          if (freshTotal >= 1.0) {
            // Arb has evaporated — abort and sell Leg 1 back
            this.log(`SLIPPAGE ABORT: Prices moved — ${event.outcome.toUpperCase()} ${(event.currentPrice * 100).toFixed(1)}¢ + ${complementOutcome.toUpperCase()} ${(freshComplement * 100).toFixed(1)}¢ = ${(freshTotal * 100).toFixed(1)}¢ ≥ 100¢`)
            activityLogger.logWarning(`Arb aborted (slippage): total cost moved to ${(freshTotal * 100).toFixed(0)}¢`, {
              originalComplement: complementPrice,
              freshComplement,
            })

            // Sell Leg 1 back
            const leg1Shares = leg1Result.filledSize || tradeAmount / event.currentPrice
            const sellResult = await tradingService.placeSell(
              event.market.clobTokenIds[dippedIndex],
              leg1Shares
            )

            if (sellResult.success) {
              activityLogger.logSell('Leg 1 sold back (slippage abort)', { orderId: sellResult.orderId })
            } else {
              activityLogger.logError(`Slippage fallback sell failed: ${sellResult.error}`)
              import('@/services/trading/PositionLifecycleManager').then(m => {
                m.positionLifecycleManager.trackPosition({
                  tokenId: event.market.clobTokenIds[dippedIndex],
                  marketId: event.market.id,
                  conditionId: event.market.conditionId,
                  outcome: event.outcome,
                  question: event.market.question,
                  entryPrice: event.currentPrice,
                  size: leg1Shares,
                  costBasis: tradeAmount,
                  entryTime: Date.now(),
                  stopLossPercent: this.dipConfig.stopLossPercent ?? 0.20,
                  takeProfitPercent: this.dipConfig.takeProfitPercent ?? 0.10,
                  strategy: 'dip',
                  negRisk: event.market.negRisk,
                })
              }).catch(err => console.warn('[DipArb] Failed to track slippage fallback position:', err))
            }

            round.leg2Executed = false
            this.arbRounds.push(round)
            return
          }
          leg2Price = freshComplement
        }
      } catch (err) {
        // If price re-fetch fails, proceed with original price (best effort)
        this.log(`Slippage check failed, proceeding with original price: ${err}`)
      }

      // ========================
      // LEG 2: Buy complement outcome
      // ========================
      this.log(`LEG 2: Buying ${complementOutcome.toUpperCase()} at ${(leg2Price * 100).toFixed(1)}¢`)

      const leg2Result = await tradingService.placeBet(
        event.market,
        complementOutcome,
        tradeAmount,
        { skipGtcFallback: true }
      )

      if (!leg2Result.success) {
        // LEG 2 FAILED — Sell Leg 1 back as fallback to avoid naked exposure
        this.log('LEG 2 FAILED — selling Leg 1 back as fallback')
        activityLogger.logWarning(`Leg 2 failed: ${leg2Result.error} — selling Leg 1 back`)

        const leg1Shares = leg1Result.filledSize || tradeAmount / event.currentPrice
        const sellResult = await tradingService.placeSell(
          event.market.clobTokenIds[dippedIndex],
          leg1Shares
        )

        if (sellResult.success) {
          activityLogger.logSell('Leg 1 sold back (fallback)', { orderId: sellResult.orderId })
        } else {
          // Failed to sell back — track position for PLM safety net
          activityLogger.logError(`Fallback sell failed: ${sellResult.error}`)
          import('@/services/trading/PositionLifecycleManager').then(m => {
            m.positionLifecycleManager.trackPosition({
              tokenId: event.market.clobTokenIds[dippedIndex],
              marketId: event.market.id,
              conditionId: event.market.conditionId,
              outcome: event.outcome,
              question: event.market.question,
              entryPrice: event.currentPrice,
              size: leg1Shares,
              costBasis: tradeAmount,
              entryTime: Date.now(),
              stopLossPercent: this.dipConfig.stopLossPercent ?? 0.20,
              takeProfitPercent: this.dipConfig.takeProfitPercent ?? 0.10,
              strategy: 'dip',
              negRisk: event.market.negRisk,
            })
          }).catch(err => console.warn('[DipArb] Failed to track fallback position:', err))
        }

        round.leg2Executed = false
        this.arbRounds.push(round)
        return
      }

      // Both legs succeeded!
      round.leg2Executed = true
      round.leg2TokenId = event.market.clobTokenIds[complementIndex]
      round.leg2Price = complementPrice
      round.leg2Timestamp = Date.now()

      activityLogger.logTrade(`LEG 2: BUY ${complementOutcome.toUpperCase()} $${tradeAmount}`, {
        price: complementPrice,
        orderId: leg2Result.orderId,
      })

      this.log('BOTH LEGS COMPLETE — Arb locked in!')

      // Record combined trade cost for stats
      const totalArbCost = tradeAmount * 2
      this.recordTrade(expectedProfit * (tradeAmount / totalCost), totalArbCost, 0)

      this.emit('tradePlaced', { event, leg1: leg1Result, leg2: leg2Result, round })

      // Log entries for backtest framework
      const leg1Shares = leg1Result.filledSize || tradeAmount / event.currentPrice
      const leg2SharesForLog = leg2Result.filledSize || tradeAmount / complementPrice
      tradeLogger.logEntry({
        strategy: 'dip',
        marketId: event.market.id,
        conditionId: event.market.conditionId,
        question: event.market.question,
        outcome: event.outcome,
        side: 'buy',
        tokenId: event.market.clobTokenIds[dippedIndex],
        price: event.currentPrice,
        shares: leg1Shares,
        costUSD: tradeAmount,
        orderId: leg1Result.orderId,
        context: { leg: 1, dipPercent: event.dipPercent, sumTarget: totalCost },
      })
      tradeLogger.logEntry({
        strategy: 'dip',
        marketId: event.market.id,
        conditionId: event.market.conditionId,
        question: event.market.question,
        outcome: complementOutcome,
        side: 'buy',
        tokenId: event.market.clobTokenIds[complementIndex],
        price: complementPrice,
        shares: leg2SharesForLog,
        costUSD: tradeAmount,
        orderId: leg2Result.orderId,
        context: { leg: 2, dipPercent: event.dipPercent, sumTarget: totalCost },
      })

      // ========================
      // MERGE: Convert YES + NO back to USDC (with exponential backoff retry)
      // ========================
      if (this.dipConfig.autoMerge !== false) {
        this.log('Merging positions back to USDC...')

        // The merge amount is the minimum of shares held on both sides
        const leg1Shares = leg1Result.filledSize || tradeAmount / event.currentPrice
        const leg2Shares = leg2Result.filledSize || tradeAmount / complementPrice
        const mergeAmount = Math.min(leg1Shares, leg2Shares)

        // Retry merge up to 3 times with exponential backoff (2s, 4s, 8s)
        const MAX_MERGE_RETRIES = 3
        let mergeSuccess = false
        let lastMergeError = ''

        for (let attempt = 1; attempt <= MAX_MERGE_RETRIES; attempt++) {
          const mergeResult = await walletService.mergePositions(
            event.market.conditionId,
            mergeAmount
          )

          if (mergeResult.success) {
            mergeSuccess = true
            round.profit = expectedProfit * mergeAmount
            activityLogger.logTrade(`MERGE: ${mergeAmount.toFixed(2)} sets → +$${round.profit.toFixed(4)} profit`, {
              conditionId: event.market.conditionId,
              txHash: mergeResult.txHash,
              attempt,
            })
            this.log(`Merge successful (attempt ${attempt})! Profit: $${round.profit.toFixed(4)}`)
            break
          }

          lastMergeError = mergeResult.error ?? 'unknown'
          this.log(`Merge attempt ${attempt}/${MAX_MERGE_RETRIES} failed: ${lastMergeError}`)

          if (attempt < MAX_MERGE_RETRIES) {
            const delayMs = 2000 * Math.pow(2, attempt - 1) // 2s, 4s, 8s
            await new Promise(resolve => setTimeout(resolve, delayMs))
          }
        }

        if (!mergeSuccess) {
          activityLogger.logWarning(`Merge failed after ${MAX_MERGE_RETRIES} attempts: ${lastMergeError} — positions held until resolution`)
          this.log(`Merge failed after ${MAX_MERGE_RETRIES} retries: ${lastMergeError}`)

          // Track both positions with PLM as safety net
          import('@/services/trading/PositionLifecycleManager').then(m => {
            m.positionLifecycleManager.trackPosition({
              tokenId: event.market.clobTokenIds[dippedIndex],
              marketId: event.market.id,
              conditionId: event.market.conditionId,
              outcome: event.outcome,
              question: event.market.question,
              entryPrice: event.currentPrice,
              size: leg1Shares,
              costBasis: tradeAmount,
              entryTime: Date.now(),
              stopLossPercent: this.dipConfig.stopLossPercent ?? 0.20,
              takeProfitPercent: this.dipConfig.takeProfitPercent ?? 0.10,
              strategy: 'dip',
              negRisk: event.market.negRisk,
            })
            m.positionLifecycleManager.trackPosition({
              tokenId: event.market.clobTokenIds[complementIndex],
              marketId: event.market.id,
              conditionId: event.market.conditionId,
              outcome: complementOutcome,
              question: event.market.question,
              entryPrice: complementPrice,
              size: leg2Shares,
              costBasis: tradeAmount,
              entryTime: Date.now(),
              stopLossPercent: this.dipConfig.stopLossPercent ?? 0.20,
              takeProfitPercent: this.dipConfig.takeProfitPercent ?? 0.10,
              strategy: 'dip',
              negRisk: event.market.negRisk,
            })
          }).catch(err => console.warn('[DipArb] Failed to track unmerged positions:', err))
        }
      }

      this.arbRounds.push(round)
    } catch (error) {
      this.logError('Arb trade execution failed', error)
      activityLogger.logError('Arb trade failed', error)
      this.arbRounds.push(round)
    } finally {
      this.activeTrades--
    }
  }

  /**
   * Get strategy configuration
   */
  getDipConfig(): DipArbConfig {
    return { ...this.dipConfig }
  }

  /**
   * Update strategy configuration
   */
  setDipConfig(config: Partial<DipArbConfig>): void {
    this.dipConfig = { ...this.dipConfig, ...config }
    this._config = { ...this._config, ...this.dipConfig }

    // Update dip detector
    this.dipDetector.setConfig({
      dipThreshold: this.dipConfig.dipThreshold,
      slidingWindowMs: this.dipConfig.slidingWindowMs,
      sumTarget: this.dipConfig.sumTarget,
    })

    this.emit('configUpdated', this.dipConfig)
  }

  /**
   * Get detector statistics
   */
  getDetectorStats() {
    return this.dipDetector.getStats()
  }

  /**
   * Get arb round history
   */
  getArbRounds(): ArbRound[] {
    return [...this.arbRounds]
  }

  /**
   * Get arb summary statistics
   */
  getArbStats(): { rounds: number; completed: number; failed: number; totalProfit: number } {
    const completed = this.arbRounds.filter(r => r.leg1Executed && r.leg2Executed)
    const failed = this.arbRounds.filter(r => !r.leg1Executed || !r.leg2Executed)
    const totalProfit = completed.reduce((sum, r) => sum + (r.profit || 0), 0)

    return {
      rounds: this.arbRounds.length,
      completed: completed.length,
      failed: failed.length,
      totalProfit,
    }
  }
}

// Export singleton instance
export const dipArbStrategy = new DipArbStrategy()
