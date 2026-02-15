import { BaseStrategy } from './BaseStrategy'
import type { MeanRevConfig, SpotPosition, MeanRevSignal } from '@/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { tradeLogger } from '@/services/trading/TradeLogger'
import type { BinancePriceUpdate } from '@/services/realtime/BinanceWSService'

// ==========================================
// DEFAULTS
// ==========================================

const DEFAULT_CONFIG: MeanRevConfig = {
  enableBtc: false,
  enableEth: false,
  enableSol: false,
  lookbackPeriod: 20,
  entryZScore: 2.0,
  exitZScore: 0.5,
  bollingerMultiplier: 2.0,
  tradeSize: 10.0,
  scanIntervalMs: 10_000,
  maxConcurrentPositions: 1,
  cooldownMs: 60_000,
  stopLossPercent: 0.03,
  takeProfitPercent: 0.02,
  maxHoldMs: 3_600_000,
}

type MrSymbol = 'BTC' | 'ETH' | 'SOL'

// ==========================================
// STRATEGY
// ==========================================

/**
 * Mean Reversion Strategy — Coinbase Spot Trading
 *
 * Uses Bollinger Bands / Z-score signals from BinanceWS prices
 * to buy oversold dips and sell when price reverts to the mean.
 *
 * Signal computation:
 *   prices = rolling buffer of last N prices (from BinanceWSService)
 *   mean = average(prices)
 *   stdDev = stdev(prices)
 *   zScore = (currentPrice - mean) / stdDev
 *
 *   Z <= -entryZScore → BUY signal (oversold, expect reversion up)
 *   Z >= +exitZScore and holding → SELL signal (reverted to mean)
 *   Also: hard SL/TP checks, max hold time exit
 *
 * Execution: Coinbase Advanced Trade market orders via CoinbaseClient.
 */
export class MeanReversionStrategy extends BaseStrategy {
  name = 'Mean Reversion'
  description = 'Spot crypto mean reversion on Coinbase (Z-score / Bollinger Bands)'
  strategyType = 'mechanical' as const

  private mrConfig: MeanRevConfig = DEFAULT_CONFIG
  private scanInterval: number | null = null
  private unsubBinance: (() => void) | null = null

  // Rolling price buffers — keyed by symbol
  private priceBuffers = new Map<MrSymbol, number[]>()

  // Open spot positions
  private positions = new Map<MrSymbol, SpotPosition>()

  // Per-symbol cooldown tracking
  private lastTradeTimes = new Map<MrSymbol, number>()

  // Last computed signals (for dashboard display)
  private _lastSignals = new Map<MrSymbol, MeanRevSignal>()

  constructor(config?: Partial<MeanRevConfig>) {
    super()
    // Hydrate from persisted settings
    const s = useSettingsStore.getState()
    const persisted: Partial<MeanRevConfig> = {
      enableBtc: s.mrEnableBtc,
      enableEth: s.mrEnableEth,
      enableSol: s.mrEnableSol,
      lookbackPeriod: s.mrLookbackPeriod,
      entryZScore: s.mrEntryZScore,
      exitZScore: s.mrExitZScore,
      tradeSize: s.mrTradeSize,
      scanIntervalMs: s.mrScanIntervalMs,
      stopLossPercent: s.mrStopLossPercent,
      takeProfitPercent: s.mrTakeProfitPercent,
      maxHoldMs: s.mrMaxHoldMs,
    }
    this.mrConfig = { ...DEFAULT_CONFIG, ...persisted, ...config }
    this._config = { enabled: false, ...this.mrConfig }
  }

  async initialize(): Promise<void> {
    this.log('Mean Reversion Strategy initialized')
    this.setStatus('idle')
  }

  async start(): Promise<void> {
    if (this._status === 'running') return

    this.log('Starting Mean Reversion Strategy')
    this.setStatus('running')

    // Bootstrap price buffers from Coinbase candles
    await this.bootstrapBuffers()

    // Subscribe to BinanceWS for live price updates
    try {
      const { binanceWSService } = await import('@/services/realtime/BinanceWSService')
      await binanceWSService.connect()
      this.unsubBinance = binanceWSService.onPriceUpdate((update) => {
        this.handlePriceUpdate(update)
      })
      this.log('Subscribed to BinanceWS price feed')
    } catch (error) {
      this.logError('Failed to subscribe to BinanceWS', error)
    }

    // Start scan interval
    await this.runScanCycle()
    this.scanInterval = window.setInterval(
      () => this.runScanCycle(),
      this.mrConfig.scanIntervalMs,
    )

    activityLogger.logSystem('Mean Reversion Strategy started')
  }

  async stop(): Promise<void> {
    this.log('Stopping Mean Reversion Strategy')

    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }

    if (this.unsubBinance) {
      this.unsubBinance()
      this.unsubBinance = null
    }

    this.priceBuffers.clear()
    this.lastTradeTimes.clear()
    this._lastSignals.clear()
    // NOTE: positions are NOT cleared on stop — they persist until manually sold

    this.setStatus('idle')
    activityLogger.logSystem('Mean Reversion Strategy stopped')
  }

  // ==========================================
  // PRICE FEED
  // ==========================================

  private handlePriceUpdate(update: BinancePriceUpdate): void {
    const symbol = update.symbol as MrSymbol
    if (!this.isSymbolEnabled(symbol)) return

    const buffer = this.priceBuffers.get(symbol) || []
    buffer.push(update.priceUSD)

    // Keep only lookbackPeriod entries
    while (buffer.length > this.mrConfig.lookbackPeriod) {
      buffer.shift()
    }
    this.priceBuffers.set(symbol, buffer)

    // Update current price on open positions
    const pos = this.positions.get(symbol)
    if (pos) {
      pos.currentPrice = update.priceUSD
      pos.unrealizedPnl = (update.priceUSD - pos.entryPrice) * pos.quantity
      pos.unrealizedPnlPercent = (update.priceUSD - pos.entryPrice) / pos.entryPrice
    }
  }

  /**
   * Bootstrap price buffers from Coinbase candles so Z-score is
   * immediately usable without waiting for N live ticks.
   */
  private async bootstrapBuffers(): Promise<void> {
    try {
      const { coinbaseClient, CoinbaseClient } = await import('@/services/api/CoinbaseClient')
      if (!coinbaseClient.hasCredentials()) {
        this.log('No Coinbase credentials — skipping buffer bootstrap (will fill from live prices)')
        return
      }

      const symbols = this.getEnabledSymbols()
      for (const symbol of symbols) {
        try {
          const productId = CoinbaseClient.productId(symbol)
          const candles = await coinbaseClient.getCandles(productId, 'ONE_MINUTE', this.mrConfig.lookbackPeriod)

          if (candles.length > 0) {
            // Candles are newest-first, reverse for chronological order
            const prices = candles.reverse().map(c => c.close)
            this.priceBuffers.set(symbol, prices)
            this.log(`Bootstrapped ${symbol} buffer: ${prices.length} candles (latest $${prices[prices.length - 1].toFixed(2)})`)
          }
        } catch (error) {
          this.logError(`Bootstrap failed for ${symbol}`, error)
        }
      }
    } catch (error) {
      this.logError('Candle bootstrap failed', error)
    }
  }

  // ==========================================
  // SCAN LOOP
  // ==========================================

  private async runScanCycle(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    try {
      const symbols = this.getEnabledSymbols()
      for (const symbol of symbols) {
        if (!this._enabled) break
        await this.analyzeSymbol(symbol)
      }
    } catch (error) {
      this.logError('Scan cycle failed', error)
    }
  }

  private async analyzeSymbol(symbol: MrSymbol): Promise<void> {
    const buffer = this.priceBuffers.get(symbol)
    if (!buffer || buffer.length < 5) {
      // Need at least 5 data points for meaningful stats
      return
    }

    const currentPrice = buffer[buffer.length - 1]
    const signal = this.computeSignal(symbol, buffer, currentPrice)

    // Store for dashboard
    this._lastSignals.set(symbol, signal)
    this.emit('signalComputed', { symbol, signal })

    const hasPosition = this.positions.has(symbol)

    if (signal.action === 'buy' && !hasPosition) {
      await this.handleBuySignal(symbol, signal)
    } else if ((signal.action === 'sell' || this.shouldForceExit(symbol)) && hasPosition) {
      await this.handleSellSignal(symbol, signal)
    }
  }

  // ==========================================
  // SIGNAL COMPUTATION — Bollinger Bands / Z-Score
  // ==========================================

  /**
   * Compute mean reversion signal using Bollinger Bands.
   *
   * zScore = (price - mean) / stdDev
   *   Z <= -entryZScore → BUY (oversold)
   *   Z >= +exitZScore → SELL (reverted)
   *
   * Confidence maps |Z| to 0-1 range: higher |Z| = stronger signal.
   */
  private computeSignal(symbol: string, prices: number[], currentPrice: number): MeanRevSignal {
    const { mean, stdDev } = this.computeStats(prices)
    const zScore = stdDev > 0 ? (currentPrice - mean) / stdDev : 0

    const upperBand = mean + this.mrConfig.bollingerMultiplier * stdDev
    const lowerBand = mean - this.mrConfig.bollingerMultiplier * stdDev

    let action: 'buy' | 'sell' | 'hold' = 'hold'

    if (zScore <= -this.mrConfig.entryZScore) {
      action = 'buy'
    } else if (zScore >= this.mrConfig.exitZScore && this.positions.has(symbol as MrSymbol)) {
      action = 'sell'
    }

    // Confidence: map |Z| relative to entry threshold to 0-1
    const absZ = Math.abs(zScore)
    const confidence = Math.min(1, absZ / (this.mrConfig.entryZScore * 1.5))

    return {
      symbol,
      action,
      zScore,
      mean,
      stdDev,
      upperBand,
      lowerBand,
      currentPrice,
      confidence,
      timestamp: Date.now(),
    }
  }

  private computeStats(prices: number[]): { mean: number; stdDev: number } {
    const n = prices.length
    if (n === 0) return { mean: 0, stdDev: 0 }

    const mean = prices.reduce((sum, p) => sum + p, 0) / n
    const variance = prices.reduce((sum, p) => sum + (p - mean) ** 2, 0) / n
    const stdDev = Math.sqrt(variance)

    return { mean, stdDev }
  }

  // ==========================================
  // TRADE EXECUTION
  // ==========================================

  private async handleBuySignal(symbol: MrSymbol, signal: MeanRevSignal): Promise<void> {
    // Cooldown check
    const lastTrade = this.lastTradeTimes.get(symbol) || 0
    if (Date.now() - lastTrade < this.mrConfig.cooldownMs) return

    // RiskManager check (dynamic import to avoid circular deps)
    try {
      const { riskManager } = await import('@/services/trading/RiskManager')
      const productId = `${symbol}-USD`
      const validation = await riskManager.validateTrade(this.mrConfig.tradeSize, productId, 'Crypto Spot')
      if (!validation.approved) {
        this.log(`RiskManager rejected ${symbol} buy: ${validation.reason}`)
        return
      }
    } catch (error) {
      this.logError('RiskManager check failed', error)
    }

    const dryRun = useSettingsStore.getState().dryRun

    if (dryRun) {
      // Simulate buy
      this.log(`[DRY RUN] BUY ${symbol} @ $${signal.currentPrice.toFixed(2)} (Z=${signal.zScore.toFixed(2)}, $${this.mrConfig.tradeSize})`)
      const quantity = this.mrConfig.tradeSize / signal.currentPrice
      this.positions.set(symbol, {
        symbol,
        side: 'LONG',
        entryPrice: signal.currentPrice,
        quantity,
        costBasis: this.mrConfig.tradeSize,
        entryTime: Date.now(),
        currentPrice: signal.currentPrice,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
      })
      this.lastTradeTimes.set(symbol, Date.now())

      activityLogger.logTrade(
        `[DRY] Mean Rev BUY ${symbol} $${this.mrConfig.tradeSize.toFixed(2)} @ $${signal.currentPrice.toFixed(2)} (Z=${signal.zScore.toFixed(2)})`,
        { symbol, zScore: signal.zScore, dryRun: true },
      )
      this.emit('tradePlaced', { symbol, side: 'BUY', signal, dryRun: true })
      return
    }

    // Live execution via Coinbase
    try {
      const { coinbaseClient, CoinbaseClient } = await import('@/services/api/CoinbaseClient')
      const productId = CoinbaseClient.productId(symbol)
      const result = await coinbaseClient.placeMarketOrder(productId, 'BUY', this.mrConfig.tradeSize)

      if (!result.success) {
        this.logError(`${symbol} BUY failed: ${result.error}`)
        activityLogger.logError(`Mean Rev ${symbol} BUY failed: ${result.error}`)
        return
      }

      // Fetch fill details
      const orderDetails = result.orderId
        ? await coinbaseClient.getOrder(result.orderId)
        : result

      const fillPrice = orderDetails.avgPrice || signal.currentPrice
      const filledQty = orderDetails.filledSize || (this.mrConfig.tradeSize / fillPrice)

      this.positions.set(symbol, {
        symbol,
        side: 'LONG',
        entryPrice: fillPrice,
        quantity: filledQty,
        costBasis: this.mrConfig.tradeSize,
        entryTime: Date.now(),
        orderId: result.orderId,
        currentPrice: signal.currentPrice,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
      })
      this.lastTradeTimes.set(symbol, Date.now())

      activityLogger.logTrade(
        `Mean Rev BUY ${symbol} $${this.mrConfig.tradeSize.toFixed(2)} @ $${fillPrice.toFixed(2)} (Z=${signal.zScore.toFixed(2)})`,
        { symbol, orderId: result.orderId, zScore: signal.zScore },
      )

      tradeLogger.logEntry({
        marketId: productId,
        conditionId: productId,
        question: `Mean Reversion: ${symbol}-USD`,
        outcomes: ['LONG', 'FLAT'],
        strategy: 'meanrev',
        side: 'BUY',
        outcome: 'LONG',
        marketPrice: fillPrice,
        actualBetSize: this.mrConfig.tradeSize,
        orderId: result.orderId,
        orderType: 'MARKET',
        fillPrice,
        filledSize: filledQty,
        success: true,
        modelProbability: signal.confidence,
      })

      // Record with RiskManager
      try {
        const { riskManager } = await import('@/services/trading/RiskManager')
        riskManager.recordTradeResult(true, this.mrConfig.tradeSize)
      } catch { /* best effort */ }

      this.emit('tradePlaced', { symbol, side: 'BUY', signal, result })
    } catch (error) {
      this.logError(`${symbol} BUY execution error`, error)
    }
  }

  private async handleSellSignal(symbol: MrSymbol, signal: MeanRevSignal): Promise<void> {
    const pos = this.positions.get(symbol)
    if (!pos) return

    const dryRun = useSettingsStore.getState().dryRun
    const pnl = (signal.currentPrice - pos.entryPrice) * pos.quantity
    const holdTimeMs = Date.now() - pos.entryTime
    const exitReason = this.getExitReason(symbol, signal)

    if (dryRun) {
      this.log(`[DRY RUN] SELL ${symbol} @ $${signal.currentPrice.toFixed(2)} (${exitReason}, PnL $${pnl.toFixed(2)})`)
      this.recordTrade(pnl, pos.costBasis, holdTimeMs)
      this.positions.delete(symbol)

      activityLogger.logTrade(
        `[DRY] Mean Rev SELL ${symbol} @ $${signal.currentPrice.toFixed(2)} (${exitReason}, PnL $${pnl.toFixed(2)})`,
        { symbol, pnl, exitReason, dryRun: true },
      )
      this.emit('tradePlaced', { symbol, side: 'SELL', signal, pnl, exitReason, dryRun: true })
      return
    }

    // Live sell via Coinbase
    try {
      const { coinbaseClient, CoinbaseClient } = await import('@/services/api/CoinbaseClient')
      const productId = CoinbaseClient.productId(symbol)
      const result = await coinbaseClient.placeMarketOrder(productId, 'SELL', pos.quantity)

      if (!result.success) {
        this.logError(`${symbol} SELL failed: ${result.error}`)
        activityLogger.logError(`Mean Rev ${symbol} SELL failed: ${result.error}`)
        return
      }

      const orderDetails = result.orderId
        ? await coinbaseClient.getOrder(result.orderId)
        : result

      const exitPrice = orderDetails.avgPrice || signal.currentPrice
      const realizedPnl = (exitPrice - pos.entryPrice) * pos.quantity

      this.recordTrade(realizedPnl, pos.costBasis, holdTimeMs)
      this.positions.delete(symbol)

      activityLogger.logTrade(
        `Mean Rev SELL ${symbol} @ $${exitPrice.toFixed(2)} (${exitReason}, PnL $${realizedPnl.toFixed(2)})`,
        { symbol, orderId: result.orderId, pnl: realizedPnl, exitReason },
      )

      tradeLogger.logEntry({
        marketId: productId,
        conditionId: productId,
        question: `Mean Reversion: ${symbol}-USD`,
        outcomes: ['LONG', 'FLAT'],
        strategy: 'meanrev',
        side: 'SELL',
        outcome: 'FLAT',
        marketPrice: exitPrice,
        actualBetSize: pos.costBasis,
        orderId: result.orderId,
        orderType: 'MARKET',
        fillPrice: exitPrice,
        filledSize: pos.quantity,
        success: true,
        modelProbability: signal.confidence,
        pnl: realizedPnl,
      })

      // Record with RiskManager
      try {
        const { riskManager } = await import('@/services/trading/RiskManager')
        riskManager.recordTradeResult(realizedPnl >= 0, realizedPnl)
      } catch { /* best effort */ }

      this.emit('tradePlaced', { symbol, side: 'SELL', signal, result, pnl: realizedPnl, exitReason })
    } catch (error) {
      this.logError(`${symbol} SELL execution error`, error)
    }
  }

  // ==========================================
  // EXIT LOGIC
  // ==========================================

  private shouldForceExit(symbol: MrSymbol): boolean {
    const pos = this.positions.get(symbol)
    if (!pos) return false

    const pnlPct = pos.currentPrice > 0
      ? (pos.currentPrice - pos.entryPrice) / pos.entryPrice
      : 0

    // Stop loss
    if (pnlPct <= -this.mrConfig.stopLossPercent) return true

    // Take profit
    if (pnlPct >= this.mrConfig.takeProfitPercent) return true

    // Max hold time
    if (Date.now() - pos.entryTime >= this.mrConfig.maxHoldMs) return true

    return false
  }

  private getExitReason(symbol: MrSymbol, signal: MeanRevSignal): string {
    const pos = this.positions.get(symbol)
    if (!pos) return 'no_position'

    const pnlPct = pos.currentPrice > 0
      ? (pos.currentPrice - pos.entryPrice) / pos.entryPrice
      : 0

    if (pnlPct <= -this.mrConfig.stopLossPercent) return 'stop_loss'
    if (pnlPct >= this.mrConfig.takeProfitPercent) return 'take_profit'
    if (Date.now() - pos.entryTime >= this.mrConfig.maxHoldMs) return 'max_hold_time'
    if (signal.action === 'sell') return 'z_reversion'
    return 'unknown'
  }

  // ==========================================
  // HELPERS
  // ==========================================

  private isSymbolEnabled(symbol: string): boolean {
    switch (symbol) {
      case 'BTC': return this.mrConfig.enableBtc
      case 'ETH': return this.mrConfig.enableEth
      case 'SOL': return this.mrConfig.enableSol
      default: return false
    }
  }

  private getEnabledSymbols(): MrSymbol[] {
    const symbols: MrSymbol[] = []
    if (this.mrConfig.enableBtc) symbols.push('BTC')
    if (this.mrConfig.enableEth) symbols.push('ETH')
    if (this.mrConfig.enableSol) symbols.push('SOL')
    return symbols
  }

  // ==========================================
  // DASHBOARD DATA API
  // ==========================================

  /** Get the latest computed signal for a symbol */
  getLastSignal(symbol: MrSymbol): MeanRevSignal | null {
    return this._lastSignals.get(symbol) ?? null
  }

  /** Get all open spot positions */
  getOpenPositions(): SpotPosition[] {
    return Array.from(this.positions.values())
  }

  /** Get the rolling price buffer for a symbol (for chart display) */
  getPriceBuffer(symbol: MrSymbol): number[] {
    return [...(this.priceBuffers.get(symbol) || [])]
  }

  // ==========================================
  // CONFIG API
  // ==========================================

  getMrConfig(): MeanRevConfig {
    return { ...this.mrConfig }
  }

  setMrConfig(config: Partial<MeanRevConfig>): void {
    this.mrConfig = { ...this.mrConfig, ...config }
    this._config = { ...this._config, ...this.mrConfig }
    this.emit('configUpdated', this.mrConfig)
  }
}

// Singleton
export const meanReversionStrategy = new MeanReversionStrategy()
