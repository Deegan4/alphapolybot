import { BaseStrategy } from './BaseStrategy'
import { LLMPredictionStrategy, llmPredictionStrategy } from './LLMPredictionStrategy'
import { DipArbStrategy, dipArbStrategy } from './DipArbStrategy'
import { activityLogger } from '@/services/trading/ActivityLogger'
import type { StrategyStats } from '@/types'

export interface StrategyState {
  name: string
  enabled: boolean
  status: 'idle' | 'running' | 'paused' | 'error'
  stats: StrategyStats
}

/**
 * StrategyManager - Orchestrates multiple trading strategies
 * 
 * Per spec: "Both strategies can run simultaneously with independent ON/OFF toggles"
 */
export class StrategyManager {
  private strategies: Map<string, BaseStrategy> = new Map()
  private initialized = false
  private listeners: Array<(states: StrategyState[]) => void> = []

  constructor() {
    // Register built-in strategies
    this.registerStrategy('llm-prediction', llmPredictionStrategy)
    this.registerStrategy('dip-arb', dipArbStrategy)
  }

  /**
   * Register a strategy
   */
  registerStrategy(id: string, strategy: BaseStrategy): void {
    this.strategies.set(id, strategy)
    
    // Listen to strategy events
    strategy.on('statusChanged', () => this.notifyListeners())
    strategy.on('configUpdated', () => this.notifyListeners())
    strategy.on('tradePlaced', () => this.notifyListeners())
  }

  /**
   * Initialize all strategies
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    console.log('[StrategyManager] Initializing strategies...')
    activityLogger.logSystem('Initializing strategy manager')

    for (const [id, strategy] of this.strategies) {
      try {
        await strategy.initialize()
        console.log(`[StrategyManager] ${strategy.name} initialized`)
      } catch (error) {
        console.error(`[StrategyManager] Failed to initialize ${id}:`, error)
        activityLogger.logError(`Failed to initialize ${strategy.name}`, error)
      }
    }

    this.initialized = true
    this.notifyListeners()
  }

  /**
   * Get a strategy by ID
   */
  getStrategy(id: string): BaseStrategy | undefined {
    return this.strategies.get(id)
  }

  /**
   * Get LLM Prediction strategy (typed)
   */
  getLLMStrategy(): LLMPredictionStrategy {
    return llmPredictionStrategy
  }

  /**
   * Get Dip Arbitrage strategy (typed)
   */
  getDipStrategy(): DipArbStrategy {
    return dipArbStrategy
  }

  /**
   * Enable a strategy
   */
  async enableStrategy(id: string): Promise<void> {
    const strategy = this.strategies.get(id)
    if (!strategy) {
      throw new Error(`Strategy ${id} not found`)
    }

    strategy.enable()
    await strategy.start()
    
    activityLogger.logSystem(`${strategy.name} enabled and started`)
    this.notifyListeners()
  }

  /**
   * Disable a strategy
   */
  async disableStrategy(id: string): Promise<void> {
    const strategy = this.strategies.get(id)
    if (!strategy) {
      throw new Error(`Strategy ${id} not found`)
    }

    await strategy.stop()
    strategy.disable()
    
    activityLogger.logSystem(`${strategy.name} disabled`)
    this.notifyListeners()
  }

  /**
   * Toggle a strategy
   */
  async toggleStrategy(id: string): Promise<void> {
    const strategy = this.strategies.get(id)
    if (!strategy) {
      throw new Error(`Strategy ${id} not found`)
    }

    if (strategy.enabled) {
      await this.disableStrategy(id)
    } else {
      await this.enableStrategy(id)
    }
  }

  /**
   * Get all strategy states
   */
  getStates(): StrategyState[] {
    return Array.from(this.strategies.entries()).map(([_id, strategy]) => ({
      name: strategy.name,
      enabled: strategy.enabled,
      status: strategy.status,
      stats: strategy.getStats(),
    }))
  }

  /**
   * Get strategy by name for display
   */
  getStateById(id: string): StrategyState | undefined {
    const strategy = this.strategies.get(id)
    if (!strategy) return undefined

    return {
      name: strategy.name,
      enabled: strategy.enabled,
      status: strategy.status,
      stats: strategy.getStats(),
    }
  }

  /**
   * Stop all strategies
   */
  async stopAll(): Promise<void> {
    console.log('[StrategyManager] Stopping all strategies...')
    activityLogger.logSystem('Stopping all strategies')

    for (const [id, strategy] of this.strategies) {
      try {
        if (strategy.enabled) {
          await strategy.stop()
          await strategy.disable()
        }
      } catch (error) {
        console.error(`[StrategyManager] Failed to stop ${id}:`, error)
      }
    }

    this.notifyListeners()
  }

  /**
   * Get combined stats from all strategies
   */
  getCombinedStats(): StrategyStats {
    const combined: StrategyStats = {
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

    for (const strategy of this.strategies.values()) {
      const stats = strategy.getStats()
      combined.totalTrades += stats.totalTrades
      combined.winningTrades += stats.winningTrades
      combined.losingTrades += stats.losingTrades
      combined.totalPnl += stats.totalPnl
    }

    if (combined.totalTrades > 0) {
      combined.winRate = combined.winningTrades / combined.totalTrades
    }

    return combined
  }

  /**
   * Subscribe to state changes
   */
  subscribe(callback: (states: StrategyState[]) => void): () => void {
    this.listeners.push(callback)
    return () => {
      const index = this.listeners.indexOf(callback)
      if (index !== -1) {
        this.listeners.splice(index, 1)
      }
    }
  }

  /**
   * Notify listeners of state change
   */
  private notifyListeners(): void {
    const states = this.getStates()
    this.listeners.forEach(callback => {
      try {
        callback(states)
      } catch (error) {
        console.error('[StrategyManager] Listener error:', error)
      }
    })
  }

  /**
   * Check if manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }
}

// Export singleton instance
export const strategyManager = new StrategyManager()
