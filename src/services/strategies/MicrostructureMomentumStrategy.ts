import { BaseStrategy } from './BaseStrategy'
import type { MicroMomentumConfig, Market } from '@/types'
import { polymarketUSClient } from '@/services/api'
import { realtimeService } from '@/services/realtime'
import { microstructureAnalyzer } from '@/services/trading/MicrostructureAnalyzer'
import { tradingService } from '@/services/trading/TradingService'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { tradeLogger } from '@/services/trading/TradeLogger'
import { KellySizer } from '@/services/trading/KellySizer'
import { edgeTracker } from '@/services/trading/EdgeTracker'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'
import { rejectionTracker } from '@/services/trading/RejectionTracker'

// ==========================================
// DEFAULTS
// ==========================================

const DEFAULT_CONFIG: MicroMomentumConfig = {
  minCompositeSignal: 0.4,
  minSignalConfidence: 0.5,
  maxSpreadFraction: 0.08,
  tradeSize: 2.0,
  scanIntervalMs: 20_000,
  maxConcurrentPositions: 3,
  cooldownMs: 60_000,
  stopLossPercent: 0.15,
  takeProfitPercent: 0.20,
  maxHoldMs: 30 * 60 * 1000, // 30 minutes
  marketBatchSize: 80,
}

// ==========================================
// MARKET SELECTION (pure — unit tested)
// ==========================================

/** Minimum liquidity / volume for a market to be worth watching */
export const MICRO_MIN_LIQUIDITY = 500
export const MICRO_MIN_VOLUME = 100

/**
 * Pick binary Polymarket US markets worth tracking: active, two outcomes with
 * per-outcome slugs (needed for the price feed), liquid, and with some volume.
 * Sorted by volume, capped at `batchSize`.
 */
export function selectEligibleMarkets(markets: Market[], batchSize: number): Market[] {
  return markets
    .filter(m => m.active && !m.closed)
    .filter(m => m.outcomes.length === 2 && m.outcomeSlugs?.length === 2)
    .filter(m => (m.liquidity ?? 0) >= MICRO_MIN_LIQUIDITY)
    .filter(m => (m.volume24hr ?? m.volume ?? 0) >= MICRO_MIN_VOLUME)
    .sort((a, b) => (b.volume24hr ?? b.volume ?? 0) - (a.volume24hr ?? a.volume ?? 0))
    .slice(0, batchSize)
}

/** Slug whose order book feeds the microstructure signal (the YES outcome) */
/** Trade flow this strongly against the book signal vetoes the entry */
export const TRADE_FLOW_VETO = 0.3

/** Whether recent executed trades contradict the order-book signal's direction */
export function tradeFlowOpposes(compositeSignal: number, tradeFlow: number | null | undefined): boolean {
  if (tradeFlow == null) return false
  return compositeSignal > 0 ? tradeFlow <= -TRADE_FLOW_VETO : tradeFlow >= TRADE_FLOW_VETO
}

export function signalSlugFor(market: Market): string | undefined {
  return market.outcomeSlugs?.[0]
}

// ==========================================
// STRATEGY
// ==========================================

/**
 * Microstructure Momentum Strategy
 *
 * Uses the already-built MicrostructureAnalyzer (bid/ask imbalance,
 * spread dynamics, order flow signals) to make directional trades.
 *
 * No LLM required — purely mechanical order flow analysis.
 *
 * Polymarket US model: a Market is an event with per-outcome slugs
 * (`outcomeSlugs`). Price feeds and the analyzer are keyed by outcome slug;
 * orders and position tracking use `market.slug` (see TradingService.placeBet).
 *
 * Sharp money patterns:
 * - Order book thinning on opposite side = directional signal
 * - Aggressive buying/selling pressure detected via compositeSignal
 * - Tight SL/TP and short hold time (these are momentum scalps)
 */
/** Most candidate markets to stream full order books for at once */
const MAX_WATCHED_BOOKS = 10

export class MicrostructureMomentumStrategy extends BaseStrategy {
  name = 'Micro Momentum'
  description = 'Order flow-based directional trading using bid/ask imbalance signals'
  strategyType = 'mechanical' as const

  private microConfig: MicroMomentumConfig = DEFAULT_CONFIG
  private scanInterval: number | null = null

  // Market tracking
  private trackedMarkets = new Map<string, Market>()
  private watchedBooks: string[] = []
  private subscribedSlugs = new Set<string>()
  private positionMarkets = new Set<string>() // Markets we already have positions in
  private lastTradeTimes = new Map<string, number>() // marketId → timestamp
  private marketRefreshInterval: number | null = null

  constructor(config?: Partial<MicroMomentumConfig>) {
    super()
    if (config) this.microConfig = { ...DEFAULT_CONFIG, ...config }
    this._config = { enabled: false, ...this.microConfig }
  }

  async initialize(): Promise<void> {
    this.log('Microstructure Momentum Strategy initialized')
    this.setStatus('idle')
  }

  private warmupUntil = 0 // Timestamp when warmup completes

  async start(): Promise<void> {
    if (this._status === 'running') return

    this.log('Starting Microstructure Momentum Strategy')
    this.setStatus('running')

    // Connect WebSocket (idempotent — safe if already connected by another strategy)
    try {
      const connected = await realtimeService.connect()
      this.log(`WebSocket connected: ${connected}`)
      if (!connected) {
        this.logError('WebSocket connection failed — signals will be unavailable')
      }
    } catch (error) {
      this.logError('WebSocket connection error', error)
    }

    // Discover and subscribe to markets
    await this.refreshMarkets()

    // 2-minute warmup — collect microstructure snapshots before first trade attempt
    const WARMUP_MS = 2 * 60 * 1000
    this.warmupUntil = Date.now() + WARMUP_MS
    this.log(`Warming up for ${WARMUP_MS / 1000}s — collecting microstructure snapshots before trading`)
    this.emit('warmup', { endsAt: this.warmupUntil })

    // Start scanning for signals
    this.scanInterval = window.setInterval(
      () => this.scanForSignals(),
      this.microConfig.scanIntervalMs,
    )

    // Refresh market list every 5 minutes
    this.marketRefreshInterval = window.setInterval(
      () => this.refreshMarkets(),
      5 * 60 * 1000,
    )

    activityLogger.logSystem('Microstructure Momentum Strategy started (warming up)')
  }

  async stop(): Promise<void> {
    this.log('Stopping Microstructure Momentum Strategy')

    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }
    if (this.marketRefreshInterval) {
      clearInterval(this.marketRefreshInterval)
      this.marketRefreshInterval = null
    }

    // Unsubscribe from price feeds
    for (const slug of this.subscribedSlugs) {
      try {
        realtimeService.unsubscribeMarket(slug)
      } catch { /* ignore */ }
    }

    realtimeService.unwatchBooks?.(this.watchedBooks)
    this.watchedBooks = []
    this.trackedMarkets.clear()
    this.subscribedSlugs.clear()
    this.positionMarkets.clear()
    this.lastTradeTimes.clear()
    this.warmupUntil = 0

    this.setStatus('idle')
    activityLogger.logSystem('Microstructure Momentum Strategy stopped')
  }

  // ==========================================
  // MARKET DISCOVERY
  // ==========================================

  /** Stream a candidate's full order book; keeps only the most recent few */
  private watchBook(slug: string): void {
    if (this.watchedBooks.includes(slug)) return
    this.watchedBooks.push(slug)
    realtimeService.watchBooks?.([slug])
    while (this.watchedBooks.length > MAX_WATCHED_BOOKS) {
      const evicted = this.watchedBooks.shift()!
      realtimeService.unwatchBooks?.([evicted])
    }
  }

  private async refreshMarkets(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    try {
      const markets = await polymarketUSClient.getMarkets({ active: true, closed: false, limit: 100, withStats: true })
      const eligible = selectEligibleMarkets(markets, this.microConfig.marketBatchSize)

      // Subscribe new markets to WebSocket feeds
      for (const market of eligible) {
        // Refresh cached prices for markets we already track
        this.trackedMarkets.set(market.id, market)

        // Subscribe both outcome slugs for price/order book updates
        for (const slug of market.outcomeSlugs ?? []) {
          if (!this.subscribedSlugs.has(slug)) {
            try {
              realtimeService.subscribeMarket(slug)
              realtimeService.subscribeTrades?.([slug])
              this.subscribedSlugs.add(slug)
            } catch {
              // Subscription failed — will retry on next refresh
            }
          }
        }
      }

      this.log(
        `[Refresh] WebSocket: ${realtimeService.isConnected() ? 'connected' : 'DISCONNECTED'} | ` +
        `API: ${markets.length} markets, ${eligible.length} eligible after filters | ` +
        `Tracking: ${this.trackedMarkets.size} markets, ${this.subscribedSlugs.size} slugs subscribed`,
      )
    } catch (error) {
      this.logError('Market refresh failed', error)
    }
  }

  // ==========================================
  // SIGNAL SCANNING
  // ==========================================

  private async scanForSignals(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    // Warmup gate — don't trade until we've collected enough microstructure data
    if (Date.now() < this.warmupUntil) {
      const remaining = Math.ceil((this.warmupUntil - Date.now()) / 1000)
      this.log(`[Warmup] ${remaining}s remaining — collecting snapshots, not trading yet`)
      return
    }

    // Check position limits
    let microPositionCount = 0
    try {
      const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
      microPositionCount = positionLifecycleManager.getPositions()
        .filter((p: { strategy: string }) => p.strategy === 'micro').length
    } catch { /* PLM not available */ }

    if (microPositionCount >= this.microConfig.maxConcurrentPositions) {
      rejectionTracker.record('position_limit', 'micro', `${microPositionCount}/${this.microConfig.maxConcurrentPositions} micro positions`)
      return
    }

    let signalsChecked = 0
    let signalsTriggered = 0

    for (const [marketId, market] of this.trackedMarkets) {
      if (!this._enabled) break
      if (this.positionMarkets.has(marketId)) continue

      // Cooldown check
      const lastTrade = this.lastTradeTimes.get(marketId) || 0
      if (Date.now() - lastTrade < this.microConfig.cooldownMs) continue

      // Position limit check
      if (microPositionCount + signalsTriggered >= this.microConfig.maxConcurrentPositions) break

      // Get microstructure signal for the YES outcome's order book
      const yesSlug = signalSlugFor(market)
      if (!yesSlug) continue

      const signal = microstructureAnalyzer.getSignal(yesSlug)
      if (!signal) continue // Not enough snapshots yet

      signalsChecked++

      // === ENTRY TRIGGERS ===
      // All must pass for a trade to fire

      // 1. Composite signal strength
      if (Math.abs(signal.compositeSignal) < this.microConfig.minCompositeSignal) {
        rejectionTracker.record('confidence', 'micro', `composite ${signal.compositeSignal.toFixed(2)} too weak`)
        continue
      }

      // 2. Signal confidence (data quality)
      if (signal.signalConfidence < this.microConfig.minSignalConfidence) {
        rejectionTracker.record('confidence', 'micro', `signal confidence ${(signal.signalConfidence * 100).toFixed(0)}% too low`)
        continue
      }

      // 3. Spread not widening (avoid uncertainty regimes)
      if (signal.spreadWidening) continue

      // 4. Spread reasonable (avoid illiquid markets)
      if (signal.spreadFraction > this.microConfig.maxSpreadFraction) continue

      // 4b. Recent trades must not be running the other way: resting depth
      // can be spoofed, executed trades cannot
      if (tradeFlowOpposes(signal.compositeSignal, signal.tradeFlow)) {
        rejectionTracker.record('microstructure', 'micro', `trade flow ${signal.tradeFlow?.toFixed(2)} opposes book signal ${signal.compositeSignal.toFixed(2)}`)
        continue
      }

      // === DIRECTION ===
      // Positive compositeSignal = bullish (more bids than asks) → BUY YES
      // Negative compositeSignal = bearish (more asks than bids) → BUY NO
      const buyYes = signal.compositeSignal > 0
      const outcome: 'yes' | 'no' = buyYes ? 'yes' : 'no'
      const outcomeIndex = buyYes ? 0 : 1

      // Get current market price for the chosen outcome
      const currentPrice = market.outcomePrices[outcomeIndex]
      if (!currentPrice || currentPrice <= 0 || currentPrice >= 1) continue

      // 5. Check order book depth for fills. A market that gets this far is a
      // live candidate: stream its full book so the next check (and the entry
      // itself) reads depth from memory instead of REST.
      this.watchBook(market.slug)
      let depthOk = true
      try {
        const { orderBookDepth } = await import('@/services/trading/OrderBookDepth')
        const depth = await orderBookDepth.checkBuyDepth(
          market.slug, // same slug TradingService.placeBet orders against
          this.microConfig.tradeSize,
          0.03, // 3% max slippage
          outcome, // YES-quoted book: a NO buy walks the YES bids
        )
        if (!depth.sufficient) depthOk = false
      } catch {
        // Depth check not available — proceed anyway
      }
      if (!depthOk) continue

      // === POSITION SIZING ===
      // Convert compositeSignal to a probability for the CHOSEN outcome
      // |compositeSignal| of 0.6 → ~59% (bearish signals back NO the same way)
      const modelProb = 0.5 + Math.abs(signal.compositeSignal) * 0.15
      const positionSize = this.calculatePositionSize(modelProb, currentPrice)
      if (positionSize <= 0) continue

      this.log(
        `SIGNAL: ${buyYes ? 'YES' : 'NO'} on "${market.question?.substring(0, 40)}..." ` +
        `composite=${signal.compositeSignal.toFixed(3)} conf=${(signal.signalConfidence * 100).toFixed(0)}% ` +
        `spread=${(signal.spreadFraction * 100).toFixed(1)}% → $${positionSize.toFixed(2)}`,
      )

      // === EXECUTE TRADE ===
      try {
        const result = await tradingService.placeBet(
          market,
          outcome,
          positionSize,
          {
            skipGtcFallback: false,
            outcomeIndex,
            strategy: 'micro',
            stopLossPercent: this.microConfig.stopLossPercent,
            takeProfitPercent: this.microConfig.takeProfitPercent,
          },
        )

        if (!result.success) {
          activityLogger.logError(`Micro trade failed: ${result.error}`)
          continue
        }

        signalsTriggered++
        this.positionMarkets.add(marketId)
        this.lastTradeTimes.set(marketId, Date.now())

        activityLogger.logTrade(
          `MICRO ${outcome.toUpperCase()} $${positionSize.toFixed(2)} (signal=${signal.compositeSignal.toFixed(2)})`,
          { marketId: market.id, orderId: result.orderId },
        )

        // Track with PLM for SL/TP enforcement (PM US taker fee uses PLM's default)
        const filledSize = result.filledSize ?? positionSize / currentPrice
        if (!result.pending) {
          import('@/services/trading/PositionLifecycleManager').then(m => {
            m.positionLifecycleManager.trackPosition({
              marketSlug: market.slug,
              outcome,
              question: market.question,
              entryPrice: result.avgPrice ?? currentPrice,
              size: filledSize,
              costBasis: positionSize,
              entryTime: Date.now(),
              stopLossPercent: this.microConfig.stopLossPercent,
              takeProfitPercent: this.microConfig.takeProfitPercent,
              strategy: 'micro',
              maxHoldMs: this.microConfig.maxHoldMs,
            })
          }).catch(err => console.warn('[MicroMomentum] PLM track failed:', err))
        }

        // Log trade for backtest
        const kellyFraction = useSettingsStore.getState().kellyFraction
        const fStar = KellySizer.pmusKelly(modelProb, currentPrice, market.feeCoefficient)
        tradeLogger.logEntry({
          marketId: market.id,
          slug: market.slug,
          question: market.question,
          outcomes: market.outcomes,
          strategy: 'micro',
          side: 'BUY',
          outcome: market.outcomes[outcomeIndex],
          marketPrice: currentPrice,
          kellyFraction: fStar,
          kellyBetSize: KellySizer.sizeBet({
            kellyFraction,
            bankroll: useWalletStore.getState().balance,
            fullKelly: fStar,
          }),
          actualBetSize: positionSize,
          orderId: result.orderId,
          orderType: 'FOK',
          fillPrice: result.avgPrice,
          filledSize: result.filledSize,
          success: true,
          modelProbability: modelProb,
        })

        this.emit('tradePlaced', { market, signal, result })
      } catch (error) {
        this.logError(`Trade execution failed for ${market.id}`, error)
      }
    }

    // Always log scan diagnostics so we can tell if the pipeline is alive
    this.log(
      `[Scan] Tracked: ${this.trackedMarkets.size} markets | ` +
      `Signals available: ${signalsChecked}/${this.trackedMarkets.size} | ` +
      `Triggered: ${signalsTriggered} trades | ` +
      `WS: ${realtimeService.isConnected() ? 'connected' : 'DISCONNECTED'}`,
    )
  }

  // ==========================================
  // POSITION SIZING
  // ==========================================

  private calculatePositionSize(modelProb: number, marketPrice: number): number {
    const pennyMode = useSettingsStore.getState().pennyTraderMode
    // Polymarket CLOB requires minimum 5 shares per order
    if (pennyMode) return Math.max(1.0, 5 * marketPrice)

    const bankroll = useWalletStore.getState().balance
    const kellyFraction = useSettingsStore.getState().kellyFraction
    const adaptiveProb = edgeTracker.getAdaptiveModelProb('micro', modelProb)
    const fStar = KellySizer.pmusKelly(adaptiveProb, marketPrice)

    if (fStar <= 0) return 0 // No edge — don't trade

    const kellySize = KellySizer.sizeBet({ kellyFraction, bankroll, fullKelly: fStar })
    // Cap at configured tradeSize
    return Math.round(Math.min(kellySize, this.microConfig.tradeSize) * 100) / 100
  }

  // ==========================================
  // CONFIG API
  // ==========================================

  getMicroConfig(): MicroMomentumConfig {
    return { ...this.microConfig }
  }

  setMicroConfig(config: Partial<MicroMomentumConfig>): void {
    this.microConfig = { ...this.microConfig, ...config }
    this._config = { ...this._config, ...this.microConfig }
    this.emit('configUpdated', this.microConfig)
  }
}

// Singleton
export const microMomentumStrategy = new MicrostructureMomentumStrategy()
