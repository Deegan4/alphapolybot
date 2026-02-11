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
  minWindowRemaining: 300,
  scanIntervalMs: 15_000,
  maxConcurrentPositions: 2,
  cooldownMs: 120_000,
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

// ==========================================
// STRATEGY
// ==========================================

/**
 * BTC Up/Down Strategy
 *
 * Trades 15-minute binary markets where the outcome is "Up" if the asset's
 * price finishes >= the window-start price, "Down" otherwise.
 *
 * Market discovery via gammaClient.searchMarkets() since these ephemeral
 * markets don't appear in the /events active list.
 *
 * computeSignal() is the USER CONTRIBUTION POINT — replace the placeholder
 * with your own 5-10 lines of directional logic.
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
  /** Consecutive search failures — triggers fallback to /events after 2 failures */
  // Removed: searchFailures counter — /search endpoint requires auth we don't have.
  // Always use /events filtering instead (same results, no 401).

  constructor(config?: Partial<BtcUpDownConfig>) {
    super()
    if (config) this.btcConfig = { ...DEFAULT_CONFIG, ...config }
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

      // 2. Check position limits
      let btcPositionCount = 0
      try {
        const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
        btcPositionCount = positionLifecycleManager.getPositions()
          .filter((p: { strategy: string }) => p.strategy === 'btc').length
      } catch { /* PLM not available */ }

      if (btcPositionCount >= this.btcConfig.maxConcurrentPositions) {
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

    // Evict expired markets first
    const now = Date.now()
    for (const [id, entry] of this.activeMarkets) {
      if (entry.windowEndMs < now) {
        this.activeMarkets.delete(id)
        this.positionsByWindow.delete(id)
      }
    }

    for (const asset of assets) {
      try {
        const assetName = ASSET_NAMES[asset]
        let markets: Market[] = []

        // Use /events endpoint (public, no auth required) and filter by question text.
        // The /search endpoint requires auth tokens we don't have (returns 401).
        markets = await this.discoverViaEvents(assetName)

        this.log(`[Discovery] ${markets.length} results for ${assetName}`)

        for (const market of markets) {
          if (!market.active || market.closed) {
            this.log(`[Discovery] Skipped ${market.id}: active=${market.active}, closed=${market.closed}`)
            continue
          }
          if (this.activeMarkets.has(market.id)) continue

          // Must be binary (Polymarket uses "Yes"/"No" outcomes, not "Up"/"Down")
          if (!market.outcomes || market.outcomes.length !== 2) {
            this.log(`[Discovery] Skipped ${market.id}: not binary (${market.outcomes?.length} outcomes)`)
            continue
          }

          // Verify this is an Up/Down market from the question text
          const questionUpper = market.question.toUpperCase()
          if (!questionUpper.includes('UP') && !questionUpper.includes('DOWN')) {
            this.log(`[Discovery] Skipped ${market.id}: no UP/DOWN in question`)
            continue
          }

          // Parse window-open price from question (e.g., "$95,432.50")
          const windowOpenPrice = this.parseWindowOpenPrice(market)
          if (!windowOpenPrice) {
            this.log(`[Discovery] Skipped ${market.id}: no price in question "${market.question.substring(0, 50)}"`)
            continue
          }

          // Check time remaining
          const windowEndMs = new Date(market.endDate).getTime()
          const timeRemaining = windowEndMs - now
          if (timeRemaining < this.btcConfig.minWindowRemaining * 1000) {
            this.log(`[Discovery] Skipped ${market.id}: only ${Math.round(timeRemaining / 1000)}s left (need ${this.btcConfig.minWindowRemaining}s)`)
            continue
          }

          this.activeMarkets.set(market.id, { market, windowOpenPrice, asset, windowEndMs })
          this.log(`Found: ${market.question.substring(0, 60)}... (${Math.round(timeRemaining / 1000)}s left)`)
        }
      } catch (error) {
        this.logError(`Discovery failed for ${asset}`, error)
      }
    }
  }

  /**
   * Fallback market discovery via /events endpoint when /search returns 401.
   * Fetches all active markets and filters by question text.
   */
  private async discoverViaEvents(assetName: string): Promise<Market[]> {
    const allMarkets = await gammaClient.getActiveMarkets()
    const nameUpper = assetName.toUpperCase()
    return allMarkets.filter(m => {
      const q = m.question.toUpperCase()
      return q.includes(nameUpper) && (q.includes('UP') || q.includes('DOWN'))
    })
  }

  /**
   * Extract window-open price from market question text.
   * Example: "Will Bitcoin be UP or DOWN from $95,432.50 at 10:15 PM?"
   */
  private parseWindowOpenPrice(market: Market): number | null {
    const text = `${market.question} ${market.description || ''}`
    const match = text.match(/\$([0-9,]+\.?[0-9]*)/)
    if (!match) return null
    const price = parseFloat(match[1].replace(/,/g, ''))
    return isNaN(price) ? null : price
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

      // Polymarket uses "Yes"/"No" outcomes, not "Up"/"Down".
      // "Yes" = the event in the question (UP or DOWN) happens.
      // Determine direction from question text, then map to Yes/No indices.
      const yesIndex = market.outcomes.indexOf('Yes')
      const noIndex = market.outcomes.indexOf('No')
      if (yesIndex < 0 || noIndex < 0) return

      // Detect what "Yes" means from the question text
      const questionUpper = market.question.toUpperCase()
      const questionMeansUp = questionUpper.includes('UP')
      // "Yes" price = price of the thing the question asks about
      const yesPrice = market.outcomePrices[yesIndex]
      const noPrice = market.outcomePrices[noIndex]
      // Map to conceptual up/down prices for signal computation
      const upPrice = questionMeansUp ? yesPrice : noPrice
      const downPrice = questionMeansUp ? noPrice : yesPrice

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

      // Log signal details for diagnostics
      this.log(
        `${asset} signal: ${signal.direction.toUpperCase()} conf=${(signal.confidence * 100).toFixed(0)}% ` +
        `(price $${currentPrice.toFixed(2)} vs open $${windowOpenPrice.toFixed(2)}, ` +
        `${Math.round(timeIntoWindowMs / 1000)}s into window, ${history.length} readings)`,
      )

      // Gate: confidence
      if (signal.confidence < this.btcConfig.minConfidence) {
        this.log(`${asset} signal REJECTED: conf=${(signal.confidence * 100).toFixed(0)}% < min ${(this.btcConfig.minConfidence * 100).toFixed(0)}%`)
        return
      }

      // Gate: max entry price
      // Map signal direction → outcome index:
      // If question asks about "UP" and signal is "up", buy YES. If signal is "down", buy NO.
      // If question asks about "DOWN" and signal is "down", buy YES. If signal is "up", buy NO.
      const buyYes = (signal.direction === 'up') === questionMeansUp
      const targetIndex = buyYes ? yesIndex : noIndex
      const targetPrice = market.outcomePrices[targetIndex]
      if (targetPrice > this.btcConfig.maxEntryPrice) {
        this.log(`${asset} ${signal.direction.toUpperCase()} at ${(targetPrice * 100).toFixed(0)}c exceeds max ${(this.btcConfig.maxEntryPrice * 100).toFixed(0)}c`)
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
      const result = await tradingService.placeBet(
        market,
        buyYes ? 'yes' : 'no',
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
          outcome: buyYes ? 'yes' : 'no',
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
        outcome: buyYes ? 'Yes' : 'No',
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
      const yesTokenId = input.market.clobTokenIds?.[input.market.outcomes.indexOf('Yes')]
      if (yesTokenId) {
        const signal = microstructureAnalyzer.getSignal(yesTokenId)
        if (signal && signal.signalConfidence > 0.3) {
          // compositeSignal is -1 to 1: positive = bullish for YES outcome
          // Determine if YES = UP from question text
          const qMeansUp = input.market.question.toUpperCase().includes('UP')
          // If question asks about UP: YES bullish = UP bullish
          // If question asks about DOWN: YES bullish = DOWN bullish (inverted for our signal)
          const adjustedSignal = qMeansUp ? signal.compositeSignal : -signal.compositeSignal
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
