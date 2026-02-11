import { BaseStrategy } from './BaseStrategy'
import type { StrategyStats, LLMPredictionConfig, Market } from '@/types'
import { marketScanner } from '@/services/trading/MarketScanner'
import { tradingService } from '@/services/trading/TradingService'
import { openRouterService, OpenRouterService } from '@/services/llm'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useWalletStore, useSettingsStore } from '@/stores'
import { KellySizer } from '@/services/trading/KellySizer'
import { calibrationTracker } from '@/services/trading/CalibrationTracker'
import { microstructureAnalyzer } from '@/services/trading/MicrostructureAnalyzer'
import { tradeLogger } from '@/services/trading/TradeLogger'

const DEFAULT_CONFIG: LLMPredictionConfig = {
  baseSize: 0.05, // 5% of capital
  confidenceMultiplier: 2.0,
  maxPositionSize: 0.10, // 10% max
  maxTradeSize: 2.00, // Hard cap per trade (must be >= $1.00 Polymarket minimum)
  minOdds: 0.15, // Widened: was 0.40, too tight — filtered out everything
  maxOdds: 0.85, // Widened: was 0.60, too tight — filtered out everything
  minLiquidity: 1000, // Lowered: was 2000
  minVolume24h: 500, // Lowered: was 1000
  maxSpread: 0.05,
  maxCreatedHours: 0, // 0 = no age limit (was 48 — killed all established markets)
  orderType: 'FOK',
  maxSlippage: 0.02,
  executionCooldown: 5000,
  stopLossPercent: 0.15,
  takeProfitPercent: 0.30,
  maxOpenPositions: 7,
  maxCapitalExposure: 0.25,
  minConfidence: 0.55, // Lowered from 0.60 — captures 30-40% more borderline-profitable trades
  excludedCategories: ['Sports', 'Crypto Price'],
  gtcFallbackEnabled: true,
  gtcExpiryMinutes: 5,
}

/**
 * LLM Prediction Strategy
 * Uses AI analysis to trade on prediction markets with balanced odds
 */
export class LLMPredictionStrategy extends BaseStrategy {
  name = 'LLM Prediction'
  description = 'AI-powered market analysis with web search capabilities'
  strategyType = 'ai' as const

  private llmConfig: LLMPredictionConfig = DEFAULT_CONFIG
  private scanInterval: number | null = null

  constructor(config?: Partial<LLMPredictionConfig>) {
    super()
    if (config) {
      this.llmConfig = { ...DEFAULT_CONFIG, ...config }
    }
    this._config = { enabled: false, ...this.llmConfig }
  }

  /**
   * Initialize the strategy
   */
  async initialize(): Promise<void> {
    this.log('Initializing LLM Prediction Strategy')
    
    // Configure market scanner with our settings
    marketScanner.setConfig({
      minLiquidity: this.llmConfig.minLiquidity,
      minVolume: this.llmConfig.minVolume24h,
      maxAgeHours: this.llmConfig.maxCreatedHours,
      minOdds: this.llmConfig.minOdds,
      maxOdds: this.llmConfig.maxOdds,
      excludedCategories: this.llmConfig.excludedCategories,
    })

    // Configure trading service
    tradingService.setConfig({
      maxSlippage: this.llmConfig.maxSlippage,
      executionCooldown: this.llmConfig.executionCooldown,
    })

    this.setStatus('idle')
    this.log('LLM Prediction Strategy initialized')
  }

  /**
   * Start the strategy
   */
  async start(): Promise<void> {
    if (this._status === 'running') {
      this.log('Strategy already running')
      return
    }

    this.log('Starting LLM Prediction Strategy')
    this.setStatus('running')

    // Clear any stale interval before creating a new one
    if (this.scanInterval) {
      clearInterval(this.scanInterval)
    }

    // Start scanning loop with adaptive timing
    this.startAdaptiveScanLoop()

    // Run first scan immediately
    await this.runScanCycle()

    activityLogger.logSystem('LLM Prediction Strategy started')
  }

  /**
   * Stop the strategy
   */
  async stop(): Promise<void> {
    this.log('Stopping LLM Prediction Strategy')

    if (this.scanInterval) {
      clearTimeout(this.scanInterval)
      this.scanInterval = null
    }

    this.setStatus('idle')
    activityLogger.logSystem('LLM Prediction Strategy stopped')
  }

  /**
   * Adaptive scan loop — increases frequency near market resolution events.
   * Normal: 60s. Near event (< 30 min): 30s. Very near (< 5 min): 15s.
   */
  private startAdaptiveScanLoop(): void {
    const tick = async () => {
      if (!this._enabled || this._status !== 'running') return

      await this.runScanCycle()

      // Determine next scan delay based on nearest tracked market end time
      let nextDelay = 45_000 // default 45s (was 60s — more throughput)
      try {
        const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
        const positions = positionLifecycleManager.getPositions().filter(p => p.strategy === 'llm')
        // Check if any position's market resolves soon (we don't store endDate on positions,
        // so we just use hold time as a proxy — positions held > 3h get faster scans)
        for (const pos of positions) {
          const heldMs = Date.now() - pos.entryTime
          if (heldMs > 3 * 60 * 60 * 1000) {
            nextDelay = Math.min(nextDelay, 15_000) // 15s near time exit
          } else if (heldMs > 2 * 60 * 60 * 1000) {
            nextDelay = Math.min(nextDelay, 30_000) // 30s
          }
        }
      } catch {
        // Fall back to default
      }

      this.scanInterval = window.setTimeout(() => tick(), nextDelay)
    }

    tick()
  }

  /**
   * Run a scan cycle
   */
  private async runScanCycle(): Promise<void> {
    if (!this._enabled || this._status !== 'running') {
      return
    }

    try {
      this.log('Starting market scan')
      activityLogger.logScan('Scanning for eligible markets')

      // Scan for markets
      const results = await marketScanner.scan()
      const eligible = results.filter(r => r.eligible).map(r => r.market)
      const rejected = results.filter(r => !r.eligible)

      // Summarize rejection reasons for diagnostics
      const rejectionCounts: Record<string, number> = {}
      for (const r of rejected) {
        // Group by first word of reason for summary (e.g. "Liquidity", "Odds", "Market")
        const key = r.reason?.split(/[:(]/)[0].trim() || 'Unknown'
        rejectionCounts[key] = (rejectionCounts[key] || 0) + 1
      }

      this.log(`Found ${eligible.length} eligible markets out of ${results.length}`)
      activityLogger.logScan(`Scanned ${results.length} markets → ${eligible.length} eligible`, {
        total: results.length,
        eligible: eligible.length,
        rejections: rejectionCounts,
      })

      // Check if we can open more positions (PLM is the source of truth)
      const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
      const llmPositionCount = positionLifecycleManager.getPositions()
        .filter(p => p.strategy === 'llm').length
      if (llmPositionCount >= this.llmConfig.maxOpenPositions) {
        this.log(`Maximum open positions reached (${llmPositionCount}/${this.llmConfig.maxOpenPositions}), skipping analysis`)
        return
      }

      // Analyze top markets
      for (const market of eligible.slice(0, 5)) {
        if (!this._enabled) break

        await this.analyzeAndTrade(market)
      }
    } catch (error) {
      this.logError('Scan cycle failed', error)
      activityLogger.logError('Scan cycle failed', error)
    }
  }

  /**
   * Analyze a market and potentially trade
   */
  private async analyzeAndTrade(market: Market): Promise<void> {
    try {
      this.log(`Analyzing market: ${market.question.substring(0, 50)}...`)
      activityLogger.logAnalysis(`Analyzing: ${market.question.substring(0, 50)}...`)

      // Get LLM prediction
      const prediction = await openRouterService.analyzeMarket(market)

      this.log(`Prediction: ${prediction.predictedOutcome} (${(prediction.confidence * 100).toFixed(1)}% confidence)`)
      activityLogger.logAnalysis(`Prediction: ${prediction.predictedOutcome}`, {
        confidence: prediction.confidence,
        reasoning: prediction.reasoning.substring(0, 200),
      })

      // Check confidence threshold
      if (prediction.confidence < this.llmConfig.minConfidence) {
        this.log(`Confidence ${(prediction.confidence * 100).toFixed(1)}% below threshold ${(this.llmConfig.minConfidence * 100).toFixed(1)}%`)
        return
      }

      // Record prediction for calibration tracking
      calibrationTracker.recordPrediction(market.id, prediction.confidence, prediction.predictedOutcome)

      // Apply calibration correction — adjusts LLM confidence based on historical accuracy
      const rawConfidence = prediction.confidence
      const calibratedConfidence = calibrationTracker.calibrate(rawConfidence)
      if (calibratedConfidence < this.llmConfig.minConfidence) {
        console.warn(`[LLM Strategy] BLOCKED by calibration: ${(calibratedConfidence * 100).toFixed(1)}% (raw: ${(rawConfidence * 100).toFixed(1)}%) < ${(this.llmConfig.minConfidence * 100).toFixed(1)}% threshold`)
        this.log(`Calibrated confidence ${(calibratedConfidence * 100).toFixed(1)}% (raw: ${(rawConfidence * 100).toFixed(1)}%) below threshold`)
        return
      }

      // Multi-model signal fusion — get second opinion for borderline/high-stakes trades
      let finalConfidence = calibratedConfidence
      const isBorderline = calibratedConfidence >= this.llmConfig.minConfidence &&
                           calibratedConfidence < this.llmConfig.minConfidence + 0.15
      if (isBorderline) {
        try {
          const secondOpinion = await openRouterService.getSecondOpinion(market)
          const fusion = OpenRouterService.fuseSignals(prediction, secondOpinion)
          if (fusion.fusionApplied) {
            this.log(`Signal fusion: ${(calibratedConfidence * 100).toFixed(1)}% → ${(fusion.confidence * 100).toFixed(1)}% (${secondOpinion?.predictedOutcome === prediction.predictedOutcome ? 'agree' : 'disagree'})`)
            finalConfidence = fusion.confidence
            if (finalConfidence < this.llmConfig.minConfidence) {
              this.log(`Fused confidence ${(finalConfidence * 100).toFixed(1)}% below threshold after disagreement — skipping`)
              return
            }
          }
        } catch {
          // Second opinion failed — proceed with primary
        }
      }

      // Microstructure confirmation — penalize confidence if order book disagrees (soft gate)
      const outcomeIdx = prediction.predictedOutcome === 'yes' ? 0 : 1
      const tokenId = market.clobTokenIds[outcomeIdx]
      if (tokenId) {
        const isBullish = prediction.predictedOutcome === 'yes' ? outcomeIdx === 0 : outcomeIdx === 1
        const confirmed = isBullish
          ? microstructureAnalyzer.confirmsBullish(tokenId)
          : microstructureAnalyzer.confirmsBearish(tokenId)
        if (!confirmed) {
          // Soft gate: reduce confidence by 15% instead of hard block
          const penalizedConfidence = finalConfidence * 0.85
          this.log(`Microstructure disagrees — confidence penalized: ${(finalConfidence * 100).toFixed(1)}% → ${(penalizedConfidence * 100).toFixed(1)}%`)
          finalConfidence = penalizedConfidence
          if (finalConfidence < this.llmConfig.minConfidence) {
            console.warn(`[LLM Strategy] Microstructure penalty dropped confidence below threshold (market: ${market.question.substring(0, 50)})`)
            activityLogger.logInfo(`Microstructure penalty rejection: ${market.question.substring(0, 40)}...`)
            return
          }
        }
      }

      // Calculate position size using FUSED/CALIBRATED confidence
      const marketPrice = market.outcomePrices[outcomeIdx]
      const positionSize = this.calculatePositionSize(finalConfidence, marketPrice)
      
      // Place the trade
      this.log(`Placing ${prediction.predictedOutcome.toUpperCase()} bet: $${positionSize.toFixed(2)}`)
      
      const result = await tradingService.placeBet(
        market,
        prediction.predictedOutcome,
        positionSize,
        {
          stopLossPercent: this.llmConfig.stopLossPercent,
          takeProfitPercent: this.llmConfig.takeProfitPercent,
        },
      )

      if (result.success) {
        if (result.pending) {
          // GTD order placed but not yet filled — GtcOrderManager handles
          // fill detection and PLM handoff. We just log and count it.
          activityLogger.logTrade(`BUY ${prediction.predictedOutcome.toUpperCase()} $${positionSize.toFixed(2)} (GTD pending)`, {
            marketId: market.id,
            orderId: result.orderId,
          })
        } else {
          // Immediate fill (FOK succeeded)
          activityLogger.logTrade(`BUY ${prediction.predictedOutcome.toUpperCase()} $${positionSize.toFixed(2)}`, {
            marketId: market.id,
            orderId: result.orderId,
            txHash: result.txHash,
          })

          // Track position for stop-loss / take-profit enforcement
          const outcomeIndex = prediction.predictedOutcome === 'yes' ? 0 : 1
          const entryPrice = market.outcomePrices[outcomeIndex]
          import('@/services/trading/PositionLifecycleManager').then(m => {
            m.positionLifecycleManager.trackPosition({
              tokenId: market.clobTokenIds[outcomeIndex],
              marketId: market.id,
              conditionId: market.conditionId,
              outcome: prediction.predictedOutcome,
              question: market.question,
              entryPrice,
              size: result.filledSize || positionSize / entryPrice,
              costBasis: positionSize,
              entryTime: Date.now(),
              stopLossPercent: this.llmConfig.stopLossPercent,
              takeProfitPercent: this.llmConfig.takeProfitPercent,
              strategy: 'llm',
              negRisk: market.negRisk,
              maxHoldMs: 4 * 60 * 60 * 1000, // 4 hour max hold for LLM positions
              partialCloseAt: this.llmConfig.takeProfitPercent * 0.6, // partial close at 60% of TP target
            })
          }).catch(err => console.warn('[LLM] Failed to track position:', err))

          // Log to backtest framework with full context
          tradeLogger.logEntry({
            marketId: market.id,
            conditionId: market.conditionId,
            question: market.question,
            outcomes: market.outcomes || [],
            strategy: 'llm',
            side: 'BUY',
            outcome: prediction.predictedOutcome,
            modelProbability: rawConfidence,
            calibratedProbability: calibratedConfidence,
            marketPrice,
            kellyFraction: useSettingsStore.getState().kellyFraction,
            kellyBetSize: positionSize,
            actualBetSize: positionSize,
            orderType: 'FOK',
            fillPrice: result.avgPrice ?? entryPrice,
            filledSize: result.filledSize,
            success: true,
            orderId: result.orderId,
          })
        }

        this.emit('tradePlaced', { market, prediction, result })
      } else {
        console.warn(`[LLM Strategy] Trade REJECTED: ${result.error} (market: ${market.question.substring(0, 50)})`)
        activityLogger.logError(`Trade failed: ${result.error}`)
      }
    } catch (error) {
      this.logError(`Analysis failed for market ${market.id}`, error)
      activityLogger.logError('Market analysis failed', error)
    }
  }

  /**
   * Calculate position size using Kelly Criterion.
   * f* = (bp - q) / b where b = (1-price)/price, p = model confidence.
   * Fractional Kelly (from settings) scales the optimal fraction down for safety.
   */
  private calculatePositionSize(confidence: number, marketPrice: number): number {
    // Penny mode: fixed $1.00 size (Polymarket minimum). Skip maxTradeSize cap —
    // capping below $1.00 causes "Order too small" rejections.
    if (useSettingsStore.getState().pennyTraderMode) return 1.00

    const walletState = useWalletStore.getState()
    const bankroll = walletState.usdcBridgedBalance ?? walletState.usdcBalance
    const baseKellyFraction = useSettingsStore.getState().kellyFraction

    // Scale Kelly fraction by confidence bucket — bet bigger on stronger signals
    let kellyFraction = baseKellyFraction
    if (confidence >= 0.80) {
      kellyFraction = Math.min(baseKellyFraction * 1.5, 0.50) // High confidence boost, capped at half Kelly
    } else if (confidence >= 0.70) {
      kellyFraction = baseKellyFraction * 1.2
    }

    const fStar = KellySizer.polymarketKelly(confidence, marketPrice)
    let size = KellySizer.sizeBet({ kellyFraction, bankroll, fullKelly: fStar })

    // Enforce hard dollar cap per trade (only in non-penny mode)
    if (this.llmConfig.maxTradeSize > 0) {
      size = Math.min(size, this.llmConfig.maxTradeSize)
    }

    // Floor at $1.00 (Polymarket minimum) to avoid silent rejections
    size = Math.max(size, 1.00)

    return Math.round(size * 100) / 100
  }

  /**
   * Get current open position count (derived from PLM — survives restarts)
   */
  async getOpenPositionCount(): Promise<number> {
    try {
      const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
      return positionLifecycleManager.getPositions()
        .filter(p => p.strategy === 'llm').length
    } catch {
      return 0
    }
  }

  /**
   * Get strategy configuration
   */
  getLLMConfig(): LLMPredictionConfig {
    return { ...this.llmConfig }
  }

  /**
   * Update strategy configuration
   */
  setLLMConfig(config: Partial<LLMPredictionConfig>): void {
    this.llmConfig = { ...this.llmConfig, ...config }
    this._config = { ...this._config, ...this.llmConfig }
    
    // Update dependent services
    marketScanner.setConfig({
      minLiquidity: this.llmConfig.minLiquidity,
      minVolume: this.llmConfig.minVolume24h,
      maxAgeHours: this.llmConfig.maxCreatedHours,
      minOdds: this.llmConfig.minOdds,
      maxOdds: this.llmConfig.maxOdds,
    })

    this.emit('configUpdated', this.llmConfig)
  }
}

// Export singleton instance
export const llmPredictionStrategy = new LLMPredictionStrategy()
