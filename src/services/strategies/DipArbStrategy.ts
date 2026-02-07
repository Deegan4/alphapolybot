import { BaseStrategy } from './BaseStrategy'
import { DipDetector, type DipEvent } from './DipDetector'
import type { DipArbConfig, Market } from '@/types'
import { gammaClient } from '@/services/api'
import { realtimeService } from '@/services/realtime'
import { tradingService } from '@/services/trading/TradingService'
import { activityLogger } from '@/services/trading/ActivityLogger'

/**
 * Proven configuration with 86% ROI
 * "Dip Arbitrage - targets 15-minute crypto markets with high-frequency
 * trading on price dips"
 */
const DEFAULT_CONFIG: DipArbConfig = {
  shares: 25, // $25 per trade
  sumTarget: 0.95, // YES + NO >= 95 cents
  dipThreshold: 0.30, // 30% dip from recent high
  slidingWindowMs: 10000, // 10 second window
  targetResolutionMinutes: 15, // 15-minute markets only
  minVolume: 500,
  maxConcurrentTrades: 3,
  cooldownMs: 30000, // 30 seconds between trades on same market
}

/**
 * Dip Arbitrage Strategy
 * 
 * Per spec: "A mechanical strategy that monitors 15-minute crypto 
 * markets for sudden price dips"
 * 
 * Logic:
 * 1. Discover 15-minute crypto markets via Gamma API
 * 2. Subscribe to real-time price feeds via WebSocket
 * 3. Detect price dips (30% drop within 10s window)
 * 4. Execute FOK orders on dips when YES+NO >= 95 cents
 * 5. Hold until resolution (15 minutes)
 */
export class DipArbStrategy extends BaseStrategy {
  name = 'Dip Arbitrage'
  description = 'Automated crypto dip buying with proven 86% ROI'
  strategyType = 'arbitrage' as const

  private dipConfig: DipArbConfig = DEFAULT_CONFIG
  private dipDetector: DipDetector
  private trackedMarkets: Map<string, Market> = new Map()
  private marketRefreshInterval: number | null = null
  private unsubscribeDips: (() => void) | null = null
  private activeTrades = 0

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

    // Discover and subscribe to markets
    await this.refreshMarkets()

    // Set up periodic market refresh (every 5 minutes)
    this.marketRefreshInterval = window.setInterval(
      () => this.refreshMarkets(),
      5 * 60 * 1000
    )

    activityLogger.logSystem('Dip Arbitrage Strategy started')
    activityLogger.logSystem(`Config: $${this.dipConfig.shares}/trade, ${(this.dipConfig.dipThreshold * 100).toFixed(0)}% dip threshold`)
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

    // Unsubscribe from dip events
    if (this.unsubscribeDips) {
      this.unsubscribeDips()
      this.unsubscribeDips = null
    }

    // Unsubscribe from all markets
    for (const market of this.trackedMarkets.values()) {
      realtimeService.unsubscribeMarket(market.id)
    }
    this.trackedMarkets.clear()

    // Clear dip detector
    this.dipDetector.reset()

    this.setStatus('idle')
    activityLogger.logSystem('Dip Arbitrage Strategy stopped')
  }

  /**
   * Discover and subscribe to 15-minute crypto markets
   */
  private async refreshMarkets(): Promise<void> {
    try {
      this.log('Discovering 15-minute crypto markets')
      
      const markets = await gammaClient.getCryptoMarkets()
      
      // Filter for 15-minute resolution markets
      const eligible = markets.filter(market => {
        // Check resolution time
        const endTime = new Date(market.endDate).getTime()
        const now = Date.now()
        const minutesToResolution = (endTime - now) / 60000
        
        // Must be active 15-minute market
        if (minutesToResolution > 20 || minutesToResolution < 1) {
          return false
        }

        // Must have volume
        const minVolume = this.dipConfig.minVolume || 500
        if ((market.volume24hr || 0) < minVolume) {
          return false
        }

        return true
      })

      this.log(`Found ${eligible.length} eligible 15-minute crypto markets`)
      activityLogger.logScan(`Tracking ${eligible.length} 15-min crypto markets`)

      // Subscribe to new markets
      for (const market of eligible) {
        if (!this.trackedMarkets.has(market.id)) {
          this.subscribeToMarket(market)
        }
      }

      // Unsubscribe from markets no longer eligible
      for (const [marketId, market] of this.trackedMarkets) {
        if (!eligible.find(m => m.id === marketId)) {
          realtimeService.unsubscribeMarket(marketId)
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

    // Subscribe to market token IDs
    if (market.clobTokenIds && market.clobTokenIds.length > 0) {
      realtimeService.subscribeMarket(market.clobTokenIds)
    }

    this.log(`Subscribed to: ${market.question.substring(0, 40)}...`)
  }

  /**
   * Handle a detected dip event
   */
  private async handleDipEvent(event: DipEvent): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    // Check concurrent trade limit
    const maxConcurrent = this.dipConfig.maxConcurrentTrades || 3
    if (this.activeTrades >= maxConcurrent) {
      this.log('Max concurrent trades reached, skipping dip')
      return
    }

    this.log(`DIP DETECTED: ${event.market.question.substring(0, 30)}...`)
    this.log(`  ${event.outcome.toUpperCase()}: ${(event.previousPrice * 100).toFixed(1)}¢ → ${(event.currentPrice * 100).toFixed(1)}¢ (-${(event.dipPercent * 100).toFixed(1)}%)`)

    activityLogger.logSystem(`DIP: ${event.outcome.toUpperCase()} dropped ${(event.dipPercent * 100).toFixed(0)}%`, {
      market: event.market.question.substring(0, 50),
      from: event.previousPrice,
      to: event.currentPrice,
    })

    try {
      this.activeTrades++

      // Execute the trade
      const result = await tradingService.placeBet(
        event.market,
        event.outcome,
        this.dipConfig.shares
      )

      if (result.success) {
        // Record successful trade (pnl=0 for now, size, holdTime=0 until resolved)
        this.recordTrade(0, this.dipConfig.shares, 0)

        activityLogger.logTrade(`BUY ${event.outcome.toUpperCase()} $${this.dipConfig.shares}`, {
          dipPercent: event.dipPercent,
          price: event.currentPrice,
          orderId: result.orderId,
        })

        this.emit('tradePlaced', { event, result })
      } else {
        activityLogger.logError(`Dip trade failed: ${result.error}`)
      }
    } catch (error) {
      this.logError('Dip trade execution failed', error)
      activityLogger.logError('Dip trade failed', error)
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
}

// Export singleton instance
export const dipArbStrategy = new DipArbStrategy()
