import { BaseStrategy } from './BaseStrategy'
import type { StrategyStats, LLMPredictionConfig, Market } from '@/types'
import { marketScanner } from '@/services/trading/MarketScanner'
import { tradingService } from '@/services/trading/TradingService'
import { openRouterService } from '@/services/llm'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useWalletStore } from '@/stores'

const DEFAULT_CONFIG: LLMPredictionConfig = {
  baseSize: 0.05, // 5% of capital
  confidenceMultiplier: 2.0,
  maxPositionSize: 0.10, // 10% max
  minOdds: 0.40,
  maxOdds: 0.60,
  minLiquidity: 2000,
  minVolume24h: 1000,
  maxSpread: 0.05,
  maxCreatedHours: 48,
  orderType: 'FOK',
  maxSlippage: 0.02,
  executionCooldown: 5000,
  stopLossPercent: 0.15,
  takeProfitPercent: 0.30,
  maxOpenPositions: 5,
  maxCapitalExposure: 0.25,
  minConfidence: 0.60,
  excludedCategories: ['Sports', 'Crypto Price'],
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
  private openPositions = 0

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

    // Start scanning loop
    this.scanInterval = window.setInterval(
      () => this.runScanCycle(),
      60000 // Scan every 60 seconds
    )

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
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }

    this.setStatus('idle')
    activityLogger.logSystem('LLM Prediction Strategy stopped')
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

      this.log(`Found ${eligible.length} eligible markets`)
      activityLogger.logScan(`Found ${eligible.length} eligible markets`, {
        total: results.length,
        eligible: eligible.length,
      })

      // Check if we can open more positions
      if (this.openPositions >= this.llmConfig.maxOpenPositions) {
        this.log('Maximum open positions reached, skipping analysis')
        return
      }

      // Analyze top markets
      for (const market of eligible.slice(0, 3)) {
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

      // Calculate position size
      const positionSize = this.calculatePositionSize(prediction.confidence)
      
      // Place the trade
      this.log(`Placing ${prediction.predictedOutcome.toUpperCase()} bet: $${positionSize.toFixed(2)}`)
      
      const result = await tradingService.placeBet(
        market,
        prediction.predictedOutcome,
        positionSize
      )

      if (result.success) {
        this.openPositions++
        activityLogger.logTrade(`BUY ${prediction.predictedOutcome.toUpperCase()} $${positionSize.toFixed(2)}`, {
          marketId: market.id,
          orderId: result.orderId,
          txHash: result.txHash,
        })
        this.emit('tradePlaced', { market, prediction, result })
      } else {
        activityLogger.logError(`Trade failed: ${result.error}`)
      }
    } catch (error) {
      this.logError(`Analysis failed for market ${market.id}`, error)
      activityLogger.logError('Market analysis failed', error)
    }
  }

  /**
   * Calculate position size based on confidence
   */
  private calculatePositionSize(confidence: number): number {
    const walletState = useWalletStore.getState()
    const capital = walletState.usdcBalance

    // Base size is percentage of capital
    let size = capital * this.llmConfig.baseSize

    // Scale by confidence (higher confidence = larger position)
    const confidenceMultiplier = 1 + (confidence - this.llmConfig.minConfidence) * this.llmConfig.confidenceMultiplier
    size *= confidenceMultiplier

    // Cap at max position size
    const maxSize = capital * this.llmConfig.maxPositionSize
    size = Math.min(size, maxSize)

    // Ensure minimum trade size
    size = Math.max(size, 1) // At least $1

    return Math.round(size * 100) / 100 // Round to cents
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
