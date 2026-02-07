import type { StrategyStats, StrategyType, StrategyStatus, StrategyConfig } from '@/types'

type StrategyEventHandler = (event: string, data: unknown) => void

/**
 * Base Strategy Abstract Class
 * All trading strategies should extend this class
 */
export abstract class BaseStrategy {
  abstract name: string
  abstract description: string
  abstract strategyType: StrategyType

  protected _enabled = false
  protected _status: StrategyStatus = 'idle'
  protected _config: StrategyConfig = { enabled: false }
  protected _stats: StrategyStats = {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalPnl: 0,
    winRate: 0,
    avgTradeSize: 0,
    avgHoldTime: 0,
    bestTrade: 0,
    worstTrade: 0,
  }

  private eventHandlers = new Map<string, Set<StrategyEventHandler>>()

  /**
   * Get whether strategy is enabled
   */
  get enabled(): boolean {
    return this._enabled
  }

  /**
   * Get current status
   */
  get status(): StrategyStatus {
    return this._status
  }

  /**
   * Get strategy configuration
   */
  get config(): StrategyConfig {
    return this._config
  }

  /**
   * Initialize the strategy
   */
  abstract initialize(): Promise<void>

  /**
   * Start the strategy
   */
  abstract start(): Promise<void>

  /**
   * Stop the strategy
   */
  abstract stop(): Promise<void>

  /**
   * Get strategy statistics
   */
  getStats(): StrategyStats {
    return { ...this._stats }
  }

  /**
   * Update strategy configuration
   */
  setConfig(config: Partial<StrategyConfig>): void {
    this._config = { ...this._config, ...config }
    this.emit('configUpdated', this._config)
  }

  /**
   * Enable the strategy
   */
  async enable(): Promise<void> {
    this._enabled = true
    this._config.enabled = true
    await this.start()
    this.emit('enabled', null)
  }

  /**
   * Disable the strategy
   */
  async disable(): Promise<void> {
    this._enabled = false
    this._config.enabled = false
    await this.stop()
    this.emit('disabled', null)
  }

  /**
   * Subscribe to strategy events
   */
  on(event: string, handler: StrategyEventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set())
    }
    this.eventHandlers.get(event)!.add(handler)
    
    return () => {
      this.eventHandlers.get(event)?.delete(handler)
    }
  }

  /**
   * Emit an event
   */
  protected emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event, data)
        } catch (error) {
          console.error(`Strategy event handler error (${event}):`, error)
        }
      }
    }
  }

  /**
   * Update statistics after a trade
   */
  protected recordTrade(pnl: number, size: number, holdTimeMs: number): void {
    this._stats.totalTrades++
    this._stats.totalPnl += pnl

    if (pnl > 0) {
      this._stats.winningTrades++
      if (pnl > this._stats.bestTrade) {
        this._stats.bestTrade = pnl
      }
    } else {
      this._stats.losingTrades++
      if (pnl < this._stats.worstTrade) {
        this._stats.worstTrade = pnl
      }
    }

    // Update averages
    this._stats.winRate = this._stats.totalTrades > 0 
      ? (this._stats.winningTrades / this._stats.totalTrades) * 100 
      : 0

    // Running average for trade size
    this._stats.avgTradeSize = 
      (this._stats.avgTradeSize * (this._stats.totalTrades - 1) + size) / this._stats.totalTrades

    // Running average for hold time (convert to minutes)
    const holdTimeMinutes = holdTimeMs / (1000 * 60)
    this._stats.avgHoldTime = 
      (this._stats.avgHoldTime * (this._stats.totalTrades - 1) + holdTimeMinutes) / this._stats.totalTrades

    this.emit('tradeRecorded', { pnl, size, holdTimeMs, stats: this._stats })
  }

  /**
   * Set strategy status
   */
  protected setStatus(status: StrategyStatus): void {
    this._status = status
    this.emit('statusChanged', status)
  }

  /**
   * Log a message (emits to event handlers)
   */
  protected log(message: string, data?: unknown): void {
    this.emit('log', { message, data, timestamp: new Date() })
  }

  /**
   * Log an error
   */
  protected logError(message: string, error?: unknown): void {
    this.emit('error', { message, error, timestamp: new Date() })
  }
}
