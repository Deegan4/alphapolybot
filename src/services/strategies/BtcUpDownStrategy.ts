import { BaseStrategy } from './BaseStrategy'
import type { BtcUpDownConfig, Market } from '@/types'
import { gammaClient } from '@/services/api/GammaClient'
import { priceOracleService } from '@/services/api/PriceOracleService'
import { tradingService } from '@/services/trading/TradingService'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { tradeLogger } from '@/services/trading/TradeLogger'
import { KellySizer } from '@/services/trading/KellySizer'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'
import { rejectionTracker } from '@/services/trading/RejectionTracker'

// ==========================================
// TYPES
// ==========================================

export interface SignalInput {
  asset: 'BTC' | 'ETH' | 'SOL'
  currentPrice: number       // Live asset price from oracle
  windowOpenPrice: number    // "Price to beat" from market question
  upPrice: number            // Current Up outcome price (0-1)
  downPrice: number          // Current Down outcome price (0-1)
  timeIntoWindowMs: number   // Elapsed ms since window start
  windowDurationMs: number   // Always 15 * 60 * 1000
  recentPriceHistory: Array<{ price: number; timestamp: number }>
  market: Market
}

export interface Signal {
  direction: 'up' | 'down'
  confidence: number // 0-1
}

// ==========================================
// DEFAULTS
// ==========================================

const DEFAULT_CONFIG: BtcUpDownConfig = {
  enableBtc: true,
  enableEth: false,
  enableSol: false,
  tradeSize: 2.0,
  useKellySizing: true,
  minConfidence: 0.40,  // Was 0.55 — too high for the 5-factor formula's output range
  maxEntryPrice: 0.75,
  minWindowRemaining: 120, // 2 min before resolution (was 300 — wasted 1/3 of 15-min window)
  scanIntervalMs: 15_000,
  maxConcurrentPositions: 2,
  cooldownMs: 30_000, // 30s per-market cooldown (was 120s — blocked re-entry on same window)
  stopLossPercent: 0.25,
  takeProfitPercent: 0.20,
  maxHoldMs: 14 * 60 * 1000,
}

const WINDOW_DURATION_MS = 15 * 60 * 1000

const ASSET_NAMES: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
}

/** Slug prefix for each asset's 15-min Up/Down events on Polymarket */
const ASSET_SLUG_PREFIX: Record<string, string> = {
  BTC: 'btc-updown-15m-',
  ETH: 'eth-updown-15m-',
  SOL: 'sol-updown-15m-',
}

// ==========================================
// STRATEGY
// ==========================================

/**
 * BTC Up/Down Strategy
 *
 * Trades 15-minute binary markets where the outcome is "Up" if the asset's
 * price finishes >= the window-start price, "Down" otherwise.
 *
 * Market discovery via slug-based lookup: slugs follow the pattern
 * {asset}-updown-15m-{windowStartUnix} where windowStartUnix aligns to
 * 900-second boundaries. Two lookups per asset per scan (current + next window).
 *
 * "Price to beat" is captured from the live price oracle at window start,
 * since the Gamma API doesn't include it in the market data.
 */
export class BtcUpDownStrategy extends BaseStrategy {
  name = 'BTC Up/Down'
  description = '15-minute binary markets on crypto price direction'
  strategyType = 'mechanical' as const

  private btcConfig: BtcUpDownConfig = DEFAULT_CONFIG
  private scanInterval: number | null = null

  // Market tracking
  private activeMarkets = new Map<string, {
    market: Market
    windowOpenPrice: number
    asset: 'BTC' | 'ETH' | 'SOL'
    windowEndMs: number
  }>()
  private positionsByWindow = new Map<string, boolean>()
  private lastTradeTimes = new Map<string, number>()
  private priceHistory = new Map<string, Array<{ price: number; timestamp: number }>>()
  /** Cached live price at window start — keyed by "{asset}:{windowStartMs}" */
  private windowOpenPriceCache = new Map<string, number>()
  /** Last computed signal per asset — exposed for dashboard display */
  private _lastSignals = new Map<string, { signal: Signal; windowOpenPrice: number; currentPrice: number }>()

  constructor(config?: Partial<BtcUpDownConfig>) {
    super()
    // Hydrate from persisted settings (same pattern as TradingService.ts line 45)
    const s = useSettingsStore.getState()
    const persisted: Partial<BtcUpDownConfig> = {
      enableBtc: s.btcEnableBtc,
      enableEth: s.btcEnableEth,
      enableSol: s.btcEnableSol,
      minConfidence: s.btcMinConfidence,
      maxEntryPrice: s.btcMaxEntryPrice,
      minWindowRemaining: s.btcMinWindowRemaining,
      tradeSize: s.btcTradeSize,
      useKellySizing: s.btcUseKellySizing,
      stopLossPercent: s.btcStopLossPercent,
      takeProfitPercent: s.btcTakeProfitPercent,
    }
    this.btcConfig = { ...DEFAULT_CONFIG, ...persisted, ...config }
    this._config = { enabled: false, ...this.btcConfig }
  }

  async initialize(): Promise<void> {
    this.log('BTC Up/Down Strategy initialized')
    this.setStatus('idle')
  }

  async start(): Promise<void> {
    if (this._status === 'running') return

    this.log('Starting BTC Up/Down Strategy')
    this.setStatus('running')

    // Connect WebSocket for order flow signals (idempotent — safe if already connected)
    try {
      const { realtimeService } = await import('@/services/realtime')
      const connected = await realtimeService.connect()
      this.log(`WebSocket connected: ${connected}`)
    } catch (error) {
      this.logError('WebSocket connection failed — order flow signals unavailable', error)
    }

    // Immediate first scan, then interval
    await this.runScanCycle()
    this.scanInterval = window.setInterval(
      () => this.runScanCycle(),
      this.btcConfig.scanIntervalMs,
    )

    activityLogger.logSystem('BTC Up/Down Strategy started')
  }

  async stop(): Promise<void> {
    this.log('Stopping BTC Up/Down Strategy')

    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }

    this.activeMarkets.clear()
    this.positionsByWindow.clear()
    this.lastTradeTimes.clear()
    this.priceHistory.clear()
    this.windowOpenPriceCache.clear()
    this._lastSignals.clear()

    this.setStatus('idle')
    activityLogger.logSystem('BTC Up/Down Strategy stopped')
  }

  // ==========================================
  // SCAN LOOP
  // ==========================================

  private async runScanCycle(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    try {
      // 1. Discover markets for enabled assets
      await this.discoverMarkets()

      if (this.activeMarkets.size === 0) {
        const msg = 'BTC: No Up/Down markets found — these 15-min markets may be unavailable right now'
        console.log(`[BTC Scan] ${msg}`)
        activityLogger.logScan(msg, { total: 0, eligible: 0 })
        return
      }

      // 2. Check position limits
      let btcPositionCount = 0
      try {
        const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
        btcPositionCount = positionLifecycleManager.getPositions()
          .filter((p: { strategy: string }) => p.strategy === 'btc').length
      } catch { /* PLM not available */ }

      if (btcPositionCount >= this.btcConfig.maxConcurrentPositions) {
        rejectionTracker.record('position_limit', 'btc', `${btcPositionCount}/${this.btcConfig.maxConcurrentPositions} BTC positions`)
        return
      }

      // 3. Analyze each active market
      for (const [marketId, entry] of this.activeMarkets) {
        if (!this._enabled) break
        if (this.positionsByWindow.get(marketId)) continue

        const lastTrade = this.lastTradeTimes.get(marketId) || 0
        if (Date.now() - lastTrade < this.btcConfig.cooldownMs) continue

        await this.analyzeAndTrade(entry.market, entry.windowOpenPrice, entry.asset)
      }
    } catch (error) {
      this.logError('Scan cycle failed', error)
    }
  }

  // ==========================================
  // MARKET DISCOVERY
  // ==========================================

  private async discoverMarkets(): Promise<void> {
    const assets: Array<'BTC' | 'ETH' | 'SOL'> = []
    if (this.btcConfig.enableBtc) assets.push('BTC')
    if (this.btcConfig.enableEth) assets.push('ETH')
    if (this.btcConfig.enableSol) assets.push('SOL')

    // Evict expired markets and associated tracking data
    const now = Date.now()
    for (const [id, entry] of this.activeMarkets) {
      if (entry.windowEndMs < now) {
        this.activeMarkets.delete(id)
        this.positionsByWindow.delete(id)
        this.lastTradeTimes.delete(id)
      }
    }

    // Prune stale priceHistory and windowOpenPriceCache entries
    const activeAssets = new Set<string>()
    for (const entry of this.activeMarkets.values()) activeAssets.add(entry.asset)
    for (const asset of this.priceHistory.keys()) {
      if (!activeAssets.has(asset)) this.priceHistory.delete(asset)
    }
    for (const key of this.windowOpenPriceCache.keys()) {
      // Key format: "{asset}:{windowStartMs}" — prune if asset not active
      const cachedAsset = key.split(':')[0]
      if (!activeAssets.has(cachedAsset) && !assets.includes(cachedAsset as 'BTC' | 'ETH' | 'SOL')) {
        this.windowOpenPriceCache.delete(key)
      }
    }

    for (const asset of assets) {
      try {
        const markets = await this.discoverBySlug(asset)

        this.log(`[Discovery] ${markets.length} slug results for ${asset}`)
        console.log(`[BTC Discovery] ${asset}: ${markets.length} markets found via slug`)

        if (markets.length === 0) {
          console.log(`[BTC Discovery] No ${asset} Up/Down markets currently active on Polymarket`)
        }

        for (const market of markets) {
          if (!market.active || market.closed) continue
          if (this.activeMarkets.has(market.id)) continue

          // Must be binary (Up/Down markets have exactly 2 outcomes)
          if (!market.outcomes || market.outcomes.length !== 2) continue

          // Check time remaining
          const windowEndMs = new Date(market.endDate).getTime()
          const timeRemaining = windowEndMs - now
          if (timeRemaining < this.btcConfig.minWindowRemaining * 1000) {
            this.log(`[Discovery] ${market.id}: only ${Math.round(timeRemaining / 1000)}s left (need ${this.btcConfig.minWindowRemaining}s)`)
            continue
          }

          // Capture "price to beat" from live oracle (not from question text — it's not there)
          const windowStartMs = windowEndMs - WINDOW_DURATION_MS
          const windowOpenPrice = await this.getWindowOpenPrice(asset, windowStartMs)

          this.activeMarkets.set(market.id, { market, windowOpenPrice, asset, windowEndMs })
          this.log(`Found: ${market.question.substring(0, 60)}... (${Math.round(timeRemaining / 1000)}s left, open $${windowOpenPrice.toFixed(2)})`)
        }
      } catch (error) {
        this.logError(`Discovery failed for ${asset}`, error)
      }
    }
  }

  /**
   * Slug-based market discovery for Up/Down 15-minute markets.
   * Slugs follow the pattern: {asset}-updown-15m-{windowStartUnix}
   * where windowStartUnix aligns to 900-second (15-min) boundaries.
   *
   * Queries current window + next window (2 API calls per asset).
   */
  private async discoverBySlug(asset: 'BTC' | 'ETH' | 'SOL'): Promise<Market[]> {
    const prefix = ASSET_SLUG_PREFIX[asset]
    const nowSec = Math.floor(Date.now() / 1000)
    const currentWindowStart = Math.floor(nowSec / 900) * 900
    const nextWindowStart = currentWindowStart + 900

    const slugs = [
      `${prefix}${currentWindowStart}`,
      `${prefix}${nextWindowStart}`,
    ]

    const markets: Market[] = []

    for (const slug of slugs) {
      try {
        const event = await gammaClient.getEventBySlug(slug)
        if (!event) continue

        // Event contains child markets — extract them
        const eventMarkets = event.markets || []
        for (const m of eventMarkets) {
          if (m.active && !m.closed) {
            markets.push(m)
          }
        }
      } catch (error) {
        this.log(`[Discovery] Slug lookup failed for ${slug}: ${error}`)
      }
    }

    return markets
  }

  /**
   * Get the "price to beat" for a window.
   * Captures live BTC/ETH/SOL price from oracle and caches per window.
   * If discovered mid-window, uses current price as approximation
   * (momentum factor degrades gracefully with approximate open price).
   */
  private async getWindowOpenPrice(asset: 'BTC' | 'ETH' | 'SOL', windowStartMs: number): Promise<number> {
    const cacheKey = `${asset}:${windowStartMs}`

    // Return cached if we already captured for this window
    const cached = this.windowOpenPriceCache.get(cacheKey)
    if (cached !== undefined) return cached

    // Capture live price
    try {
      const { priceUSD } = await priceOracleService.getPrice(asset)
      this.windowOpenPriceCache.set(cacheKey, priceUSD)
      return priceUSD
    } catch (error) {
      this.logError(`Failed to capture open price for ${asset}`, error)
      // Fallback: return a rough estimate that won't break signal computation
      return asset === 'BTC' ? 97000 : asset === 'ETH' ? 2600 : 150
    }
  }

  // ==========================================
  // ANALYSIS & TRADE EXECUTION
  // ==========================================

  private async analyzeAndTrade(
    market: Market,
    windowOpenPrice: number,
    asset: 'BTC' | 'ETH' | 'SOL',
  ): Promise<void> {
    try {
      // Fetch live asset price
      const { priceUSD: currentPrice } = await priceOracleService.getPrice(asset)

      // Update price history (rolling window of 20)
      const history = this.priceHistory.get(asset) || []
      history.push({ price: currentPrice, timestamp: Date.now() })
      if (history.length > 20) history.shift()
      this.priceHistory.set(asset, history)

      // BTC Up/Down markets use ["Up", "Down"] outcomes (NOT ["Yes", "No"]).
      // Detect format and map to conceptual up/down prices for signal computation.
      let upIndex: number, downIndex: number
      let upPrice: number, downPrice: number

      const hasUpDown = market.outcomes.includes('Up') && market.outcomes.includes('Down')
      const hasYesNo = market.outcomes.includes('Yes') && market.outcomes.includes('No')

      if (hasUpDown) {
        upIndex = market.outcomes.indexOf('Up')
        downIndex = market.outcomes.indexOf('Down')
        upPrice = market.outcomePrices[upIndex]
        downPrice = market.outcomePrices[downIndex]
      } else if (hasYesNo) {
        // Fallback for legacy markets that use Yes/No with question-text direction
        const yesIndex = market.outcomes.indexOf('Yes')
        const noIndex = market.outcomes.indexOf('No')
        const questionMeansUp = market.question.toUpperCase().includes('UP')
        upIndex = questionMeansUp ? yesIndex : noIndex
        downIndex = questionMeansUp ? noIndex : yesIndex
        upPrice = market.outcomePrices[upIndex]
        downPrice = market.outcomePrices[downIndex]
      } else {
        console.warn(`[BTC] Unrecognized outcomes: ${JSON.stringify(market.outcomes)}`)
        return
      }

      // Build signal input
      const windowEndMs = new Date(market.endDate).getTime()
      const windowStartMs = windowEndMs - WINDOW_DURATION_MS
      const timeIntoWindowMs = Date.now() - windowStartMs

      const signalInput: SignalInput = {
        asset,
        currentPrice,
        windowOpenPrice,
        upPrice,
        downPrice,
        timeIntoWindowMs,
        windowDurationMs: WINDOW_DURATION_MS,
        recentPriceHistory: history,
        market,
      }

      // Multi-factor mechanical signal
      const signal = this.computeSignal(signalInput)

      // Store for dashboard display + emit event for real-time UI updates
      this._lastSignals.set(asset, { signal, windowOpenPrice, currentPrice })
      this.emit('signalComputed', { asset, signal, windowOpenPrice, currentPrice })

      // Log signal details for diagnostics
      this.log(
        `${asset} signal: ${signal.direction.toUpperCase()} conf=${(signal.confidence * 100).toFixed(0)}% ` +
        `(price $${currentPrice.toFixed(2)} vs open $${windowOpenPrice.toFixed(2)}, ` +
        `${Math.round(timeIntoWindowMs / 1000)}s into window, ${history.length} readings)`,
      )

      // Gate: confidence
      if (signal.confidence < this.btcConfig.minConfidence) {
        console.log(`[BTC Signal] ${asset} REJECTED: conf=${(signal.confidence * 100).toFixed(0)}% < min ${(this.btcConfig.minConfidence * 100).toFixed(0)}%`)
        rejectionTracker.record('confidence', 'btc', `${asset} ${(signal.confidence * 100).toFixed(0)}% < ${(this.btcConfig.minConfidence * 100).toFixed(0)}%`)
        return
      }

      // Gate: max entry price
      // Map signal direction → outcome index directly (Up/Down format is 1:1)
      const targetIndex = signal.direction === 'up' ? upIndex : downIndex
      const targetPrice = market.outcomePrices[targetIndex]
      if (targetPrice > this.btcConfig.maxEntryPrice) {
        this.log(`${asset} ${signal.direction.toUpperCase()} at ${(targetPrice * 100).toFixed(0)}c exceeds max ${(this.btcConfig.maxEntryPrice * 100).toFixed(0)}c`)
        rejectionTracker.record('market_filter', 'btc', `${asset} price ${(targetPrice * 100).toFixed(0)}c > ${(this.btcConfig.maxEntryPrice * 100).toFixed(0)}c max`)
        return
      }

      // Position sizing
      const positionSize = this.calculatePositionSize(signal.confidence, targetPrice)

      this.log(
        `SIGNAL: ${asset} ${signal.direction.toUpperCase()} ` +
        `@ ${(targetPrice * 100).toFixed(0)}c ` +
        `(conf ${(signal.confidence * 100).toFixed(0)}%, $${positionSize.toFixed(2)})`,
      )

      // Execute trade
      // TradingService.placeBet() expects 'yes'/'no' but we pass explicit outcomeIndex
      // which overrides the yes/no mapping. Map index 0 → 'yes', index 1 → 'no'.
      const outcomeStr: 'yes' | 'no' = targetIndex === 0 ? 'yes' : 'no'
      const result = await tradingService.placeBet(
        market,
        outcomeStr,
        positionSize,
        { skipGtcFallback: true, outcomeIndex: targetIndex },
      )

      if (!result.success) {
        activityLogger.logError(`BTC ${asset} trade failed: ${result.error}`)
        return
      }

      // Record success
      activityLogger.logTrade(
        `${asset} ${signal.direction.toUpperCase()} $${positionSize.toFixed(2)}`,
        { marketId: market.id, orderId: result.orderId },
      )
      this.positionsByWindow.set(market.id, true)
      this.lastTradeTimes.set(market.id, Date.now())

      // Track with PLM (dynamic import for circular dep safety)
      const filledSize = result.filledSize ?? positionSize / targetPrice
      import('@/services/trading/PositionLifecycleManager').then(m => {
        m.positionLifecycleManager.trackPosition({
          tokenId: market.clobTokenIds[targetIndex],
          marketId: market.id,
          conditionId: market.conditionId,
          outcome: outcomeStr,
          question: market.question,
          entryPrice: targetPrice,
          size: filledSize,
          costBasis: positionSize,
          entryTime: Date.now(),
          stopLossPercent: this.btcConfig.stopLossPercent,
          takeProfitPercent: this.btcConfig.takeProfitPercent,
          strategy: 'btc',
          negRisk: market.negRisk,
          maxHoldMs: this.btcConfig.maxHoldMs,
        })
      }).catch(err => console.warn('[BtcUpDown] PLM track failed:', err))

      // Log trade for backtest
      const kellyFraction = useSettingsStore.getState().kellyFraction
      const fStar = KellySizer.polymarketKelly(signal.confidence, targetPrice)
      tradeLogger.logEntry({
        marketId: market.id,
        conditionId: market.conditionId,
        question: market.question,
        outcomes: market.outcomes,
        strategy: 'btc',
        side: 'BUY',
        outcome: market.outcomes[targetIndex] || (targetIndex === 0 ? 'Yes' : 'No'),
        marketPrice: targetPrice,
        kellyFraction: fStar,
        kellyBetSize: KellySizer.sizeBet({
          kellyFraction,
          bankroll: useWalletStore.getState().usdcBridgedBalance ?? 0,
          fullKelly: fStar,
        }),
        actualBetSize: positionSize,
        orderId: result.orderId,
        orderType: 'FOK',
        fillPrice: result.avgPrice,
        filledSize: result.filledSize,
        success: true,
        modelProbability: signal.confidence,
      })

      this.emit('tradePlaced', { market, signal, result })
    } catch (error) {
      this.logError(`Analysis failed for ${asset}`, error)
    }
  }

  // ==========================================
  // SIGNAL COMPUTATION — Multi-Factor Mechanical Signal
  // ==========================================

  /**
   * Compute trading signal from market data using 5 mechanical factors:
   *
   * 1. MOMENTUM (25%):  Current price vs window-open price
   * 2. VELOCITY (25%):  Linear regression slope over price history
   * 3. TIME DECAY (20%): Confidence boost as window nears end with consistent direction
   * 4. VALUE BET (15%):  How cheap the target outcome is (value opportunity)
   * 5. ORDER FLOW (15%): Microstructure bid/ask imbalance (if available)
   *
   * Sharp money patterns incorporated:
   * - Skip first 60s of window (let price establish direction)
   * - Momentum chase: enter when price breaks away from open
   * - Order book thinning on opposite side = strong directional signal
   */
  private computeSignal(input: SignalInput): Signal {
    const {
      currentPrice, windowOpenPrice, upPrice, downPrice,
      timeIntoWindowMs, windowDurationMs, recentPriceHistory,
    } = input

    // === Factor 1: MOMENTUM (25%) ===
    // How far price has moved from window-open, normalized
    const priceDelta = (currentPrice - windowOpenPrice) / windowOpenPrice
    const momentumScore = Math.max(-1, Math.min(1, priceDelta * 50)) // 2% move = full signal

    // Direction from momentum sign
    const direction: 'up' | 'down' = priceDelta >= 0 ? 'up' : 'down'

    // === Factor 2: VELOCITY (25%) ===
    // Linear regression slope over recent price readings
    let velocityScore = 0
    if (recentPriceHistory.length >= 3) {
      const slope = this.linearRegressionSlope(recentPriceHistory)
      // Normalize: slope is price-change per millisecond
      // A typical BTC move of $100/min on a $95k price = ~0.0017/ms relative
      const relativeSlope = slope / windowOpenPrice
      velocityScore = Math.max(-1, Math.min(1, relativeSlope * 60_000 * 30))
      // 30x scaler: a 0.033%/min slope → score of ~1.0
    }

    // === Factor 3: TIME DECAY (20%) ===
    // Later in the window + consistent direction = higher confidence
    const timeRatio = Math.max(0, Math.min(1, timeIntoWindowMs / windowDurationMs))
    let directionConsistency = 0
    if (recentPriceHistory.length >= 2) {
      const onSameSide = recentPriceHistory.filter(p =>
        direction === 'up' ? p.price >= windowOpenPrice : p.price < windowOpenPrice,
      ).length
      directionConsistency = onSameSide / recentPriceHistory.length
    }
    const timeDecayBoost = timeRatio * directionConsistency

    // === Factor 4: VALUE BET (15%) ===
    // How cheap the target outcome is (value opportunity)
    const targetPrice = direction === 'up' ? upPrice : downPrice
    const cheapness = Math.max(0, Math.min(1, 1 - targetPrice))

    // === Factor 5: ORDER FLOW IMBALANCE (15%) ===
    // Use MicrostructureAnalyzer signal if available (best-effort, non-blocking)
    let imbalanceScore = 0
    try {
      // Dynamic import to avoid adding to critical path — fire-and-forget pattern
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { microstructureAnalyzer } = require('@/services/trading/MicrostructureAnalyzer')
      // Use the first token (Up outcome) — measures general order flow imbalance
      const firstTokenId = input.market.clobTokenIds?.[0]
      if (firstTokenId) {
        const signal = microstructureAnalyzer.getSignal(firstTokenId)
        if (signal && signal.signalConfidence > 0.3) {
          // compositeSignal is -1 to 1: positive = bullish for first outcome
          // First outcome is typically "Up" — positive signal = bullish for Up
          const isFirstUp = input.market.outcomes[0] === 'Up' || input.market.question.toUpperCase().includes('UP')
          const adjustedSignal = isFirstUp ? signal.compositeSignal : -signal.compositeSignal
          imbalanceScore = direction === 'up' ? adjustedSignal : -adjustedSignal
        }
      }
    } catch {
      // MicrostructureAnalyzer not available — no order flow data, continue without
    }

    // === COMPOSITE ===
    const rawScore =
      momentumScore * 0.25 +
      velocityScore * 0.25 +
      timeDecayBoost * 0.20 +
      cheapness * 0.15 +
      imbalanceScore * 0.15

    // Sqrt scaling: stretches the [0, 0.5] realistic range to [0, 0.7]
    // Without this, the linear composite rarely exceeds 0.50 in practice
    const amplifiedScore = Math.sign(rawScore) * Math.sqrt(Math.abs(rawScore))
    let confidence = Math.max(0, Math.min(1, Math.abs(amplifiedScore)))

    // === EARLY WINDOW RAMP ===
    // Soft penalty in first 60 seconds instead of hard cap (avoids missing early moves)
    if (timeIntoWindowMs < 60_000) {
      const earlyPenalty = 0.85 + 0.15 * (timeIntoWindowMs / 60_000) // 85% → 100% over first minute
      confidence *= earlyPenalty
    }

    return { direction, confidence }
  }

  /**
   * Compute linear regression slope over price history.
   * Returns price change per millisecond.
   */
  private linearRegressionSlope(
    points: Array<{ price: number; timestamp: number }>,
  ): number {
    const n = points.length
    if (n < 2) return 0

    // Use relative timestamps (ms from first point)
    const t0 = points[0].timestamp
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
    for (const p of points) {
      const x = p.timestamp - t0
      const y = p.price
      sumX += x
      sumY += y
      sumXY += x * y
      sumXX += x * x
    }

    const denom = n * sumXX - sumX * sumX
    if (Math.abs(denom) < 1e-12) return 0
    return (n * sumXY - sumX * sumY) / denom
  }

  // ==========================================
  // POSITION SIZING
  // ==========================================

  private calculatePositionSize(confidence: number, marketPrice: number): number {
    const pennyMode = useSettingsStore.getState().pennyTraderMode
    if (pennyMode) return 1.0

    if (!this.btcConfig.useKellySizing) {
      return this.btcConfig.tradeSize
    }

    const bankroll = useWalletStore.getState().usdcBridgedBalance ?? useWalletStore.getState().usdcBalance
    const kellyFraction = useSettingsStore.getState().kellyFraction
    const fStar = KellySizer.polymarketKelly(confidence, marketPrice)
    return Math.round(KellySizer.sizeBet({ kellyFraction, bankroll, fullKelly: fStar }) * 100) / 100
  }

  // ==========================================
  // DASHBOARD DATA API
  // ==========================================

  /** Get the latest computed signal for an asset (for dashboard gauge display) */
  getLastSignal(asset: 'BTC' | 'ETH' | 'SOL'): { signal: Signal; windowOpenPrice: number; currentPrice: number } | null {
    return this._lastSignals.get(asset) ?? null
  }

  /** Get the current active window timing (for dashboard timer display) */
  getActiveWindow(): { asset: string; windowStartMs: number; windowEndMs: number } | null {
    for (const entry of this.activeMarkets.values()) {
      return {
        asset: entry.asset,
        windowStartMs: entry.windowEndMs - WINDOW_DURATION_MS,
        windowEndMs: entry.windowEndMs,
      }
    }
    return null
  }

  /** Get all active market entries (for dashboard asset cards) */
  getActiveMarketEntries(): Array<{
    asset: 'BTC' | 'ETH' | 'SOL'
    windowOpenPrice: number
    windowEndMs: number
    marketId: string
  }> {
    return Array.from(this.activeMarkets.entries()).map(([id, entry]) => ({
      asset: entry.asset,
      windowOpenPrice: entry.windowOpenPrice,
      windowEndMs: entry.windowEndMs,
      marketId: id,
    }))
  }

  // ==========================================
  // CONFIG API
  // ==========================================

  getBtcConfig(): BtcUpDownConfig {
    return { ...this.btcConfig }
  }

  setBtcConfig(config: Partial<BtcUpDownConfig>): void {
    this.btcConfig = { ...this.btcConfig, ...config }
    this._config = { ...this._config, ...this.btcConfig }
    this.emit('configUpdated', this.btcConfig)
  }
}

// Singleton
export const btcUpDownStrategy = new BtcUpDownStrategy()
