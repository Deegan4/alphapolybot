import { BaseStrategy } from './BaseStrategy'
import type { MicroMomentumConfig, Market } from '@/types'
import { gammaClient } from '@/services/api/GammaClient'
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
 * Sharp money patterns:
 * - Order book thinning on opposite side = directional signal
 * - Aggressive buying/selling pressure detected via compositeSignal
 * - Tight SL/TP and short hold time (these are momentum scalps)
 */
export class MicrostructureMomentumStrategy extends BaseStrategy {
  name = 'Micro Momentum'
  description = 'Order flow-based directional trading using bid/ask imbalance signals'
  strategyType = 'mechanical' as const

  private microConfig: MicroMomentumConfig = DEFAULT_CONFIG
  private scanInterval: number | null = null

  // Market tracking
  private trackedMarkets = new Map<string, Market>()
  private subscribedTokens = new Set<string>()
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
    for (const tokenId of this.subscribedTokens) {
      try {
        realtimeService.unsubscribeMarket(tokenId)
      } catch { /* ignore */ }
    }

    this.trackedMarkets.clear()
    this.subscribedTokens.clear()
    this.positionMarkets.clear()
    this.lastTradeTimes.clear()
    this.warmupUntil = 0

    this.setStatus('idle')
    activityLogger.logSystem('Microstructure Momentum Strategy stopped')
  }

  // ==========================================
  // MARKET DISCOVERY
  // ==========================================

  private async refreshMarkets(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    try {
      const markets = await gammaClient.getBinaryMarkets()

      // Filter for active, liquid markets
      const eligible = markets
        .filter(m => m.active && !m.closed)
        .filter(m => (m.liquidity ?? 0) >= 500) // Need reasonable liquidity
        .filter(m => (m.volume24hr ?? 0) >= 100) // Need some trading activity
        .sort((a, b) => (b.volume24hr ?? 0) - (a.volume24hr ?? 0)) // Sort by volume
        .slice(0, this.microConfig.marketBatchSize)

      // Subscribe new markets to WebSocket feeds
      for (const market of eligible) {
        if (this.trackedMarkets.has(market.id)) continue

        this.trackedMarkets.set(market.id, market)

        // Subscribe both outcome tokens for price/order book updates
        for (const tokenId of market.clobTokenIds) {
          if (!this.subscribedTokens.has(tokenId)) {
            try {
              realtimeService.subscribeMarket(tokenId)
              this.subscribedTokens.add(tokenId)
            } catch {
              // Subscription failed — will retry on next refresh
            }
          }
        }
      }

      this.log(
        `[Refresh] WebSocket: ${realtimeService.isConnected() ? 'connected' : 'DISCONNECTED'} | ` +
        `API: ${markets.length} binary markets, ${eligible.length} eligible after filters | ` +
        `Tracking: ${this.trackedMarkets.size} markets, ${this.subscribedTokens.size} tokens subscribed`,
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

      // Get microstructure signal for the YES token (index 0)
      const yesTokenId = market.clobTokenIds[0]
      if (!yesTokenId) continue

      const signal = microstructureAnalyzer.getSignal(yesTokenId)
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

      // === DIRECTION ===
      // Positive compositeSignal = bullish (more bids than asks) → BUY YES
      // Negative compositeSignal = bearish (more asks than bids) → BUY NO
      const buyYes = signal.compositeSignal > 0
      const outcome: 'yes' | 'no' = buyYes ? 'yes' : 'no'
      const outcomeIndex = buyYes ? 0 : 1

      // Get current market price for the chosen outcome
      const currentPrice = market.outcomePrices[outcomeIndex]
      if (!currentPrice || currentPrice <= 0 || currentPrice >= 1) continue

      // 5. Check order book depth for fills
      let depthOk = true
      try {
        const { orderBookDepth } = await import('@/services/trading/OrderBookDepth')
        const depth = await orderBookDepth.checkBuyDepth(
          market.clobTokenIds[outcomeIndex],
          this.microConfig.tradeSize,
          0.03, // 3% max slippage
        )
        if (!depth.sufficient) depthOk = false
      } catch {
        // Depth check not available — proceed anyway
      }
      if (!depthOk) continue

      // === POSITION SIZING ===
      // Convert compositeSignal to probability estimate
      // compositeSignal of 0.6 → ~59% probability edge
      const modelProb = 0.5 + signal.compositeSignal * 0.15
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
          { skipGtcFallback: false },
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

        // Track with PLM — fetch per-token fee rate for accurate TP adjustment
        const filledSize = result.filledSize ?? positionSize / currentPrice
        const tokenIdForPlm = market.clobTokenIds[outcomeIndex]
        Promise.all([
          import('@/services/trading/PositionLifecycleManager'),
          import('@/services/api').then(api => api.clobClient.getFeeRateBps(tokenIdForPlm)).catch(() => undefined),
        ]).then(([m, feeRate]) => {
          m.positionLifecycleManager.trackPosition({
            tokenId: tokenIdForPlm,
            marketId: market.id,
            conditionId: market.conditionId,
            outcome,
            question: market.question,
            entryPrice: currentPrice,
            size: filledSize,
            costBasis: positionSize,
            entryTime: Date.now(),
            stopLossPercent: this.microConfig.stopLossPercent,
            takeProfitPercent: this.microConfig.takeProfitPercent,
            strategy: 'micro',
            negRisk: market.negRisk,
            maxHoldMs: this.microConfig.maxHoldMs,
            takerFeeBps: feeRate,
          })
        }).catch(err => console.warn('[MicroMomentum] PLM track failed:', err))

        // Log trade for backtest
        const kellyFraction = useSettingsStore.getState().kellyFraction
        const fStar = KellySizer.polymarketKelly(modelProb, currentPrice)
        tradeLogger.logEntry({
          marketId: market.id,
          conditionId: market.conditionId,
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
    const fStar = KellySizer.polymarketKelly(adaptiveProb, marketPrice)

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
