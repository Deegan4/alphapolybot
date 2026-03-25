import { BaseStrategy } from './BaseStrategy'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'
import type { StrategyStats } from '@/types'

// Lazy strategy loaders — each strategy module is only downloaded when first needed,
// keeping the main bundle free of heavy strategy code + their transitive deps
// (CLOBClient, GammaClient, signalEngine, OllamaService, etc.)
const strategyLoaders: Record<string, () => Promise<BaseStrategy>> = {
  'llm-prediction': () => import('./LLMPredictionStrategy').then(m => m.llmPredictionStrategy),
  'dip-arb': () => import('./DipArbStrategy').then(m => m.dipArbStrategy),
  'project-fw': () => import('./ProjectFWStrategy').then(m => m.projectFWStrategy),
  'btc-updown': () => import('./BtcUpDownStrategy').then(m => m.btcUpDownStrategy),
  'gabagool': () => import('./GabagoolStrategy').then(m => m.gabagoolStrategy),
  'dual-side': () => import('./DualSideHedgeStrategy').then(m => m.dualSideHedgeStrategy),
  'impulse-sniper': () => import('./ImpulseSniperStrategy').then(m => m.impulseSniperStrategy),
  'liquidation-momentum': () => import('./LiquidationMomentumStrategy').then(m => m.liquidationMomentumStrategy),
  'copy-trading': () => import('./CopyTradingStrategy').then(m => m.copyTradingStrategy),
}

export interface StrategyState {
  id: string
  name: string
  enabled: boolean
  status: 'idle' | 'running' | 'paused' | 'error'
  stats: StrategyStats
}

/**
 * StrategyManager - Orchestrates multiple trading strategies
 *
 * Strategies are lazy-loaded on initialize() to keep the main bundle small.
 * Per spec: "Both strategies can run simultaneously with independent ON/OFF toggles"
 */
export class StrategyManager {
  private strategies: Map<string, BaseStrategy> = new Map()
  private initialized = false
  private listeners: Array<(states: StrategyState[]) => void> = []

  constructor() {
    // Strategies are registered lazily in initialize() via dynamic imports
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
   * Initialize all strategies — lazy-loads each module in parallel,
   * registers them, then initializes sequentially.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    console.log('[StrategyManager] Loading strategies...')
    activityLogger.logSystem('Initializing strategy manager')

    // Load all strategy modules in parallel
    const entries = Object.entries(strategyLoaders)
    const loaded = await Promise.allSettled(
      entries.map(async ([id, loader]) => ({ id, strategy: await loader() }))
    )

    for (const result of loaded) {
      if (result.status === 'fulfilled') {
        const { id, strategy } = result.value
        this.registerStrategy(id, strategy)
      } else {
        console.error('[StrategyManager] Failed to load strategy:', result.reason)
      }
    }

    // Map strategy IDs to their settings-store enabled toggle
    const settings = useSettingsStore.getState()
    const enabledMap: Record<string, boolean> = {
      'llm-prediction': true, // always init (no dedicated toggle)
      'dip-arb': true,        // always init (no dedicated toggle)
      'project-fw': true,     // always init (no dedicated toggle)
      'btc-updown': settings.btcEnableBtc,
      'gabagool': settings.gabagoolEnabled,
      'dual-side': settings.dualSideEnabled,
      'impulse-sniper': settings.impulseEnabled,
      'liquidation-momentum': settings.liqEnabled,
      'copy-trading': !!settings.followedAddress,
    }

    // Initialize each registered strategy (skip verbose logging for disabled ones)
    for (const [id, strategy] of this.strategies) {
      try {
        await strategy.initialize()
        if (enabledMap[id] !== false) {
          console.log(`[StrategyManager] ${strategy.name} initialized`)
        }
      } catch (error) {
        console.error(`[StrategyManager] Failed to initialize ${id}:`, error)
        activityLogger.logError(`Failed to initialize ${strategy.name}`, error)
      }
    }

    // Start WeatherMarketAdapter if enabled (not a strategy, but a market scanner)
    if (settings.weatherScanEnabled) {
      import('./WeatherMarketAdapter').then(m => {
        m.weatherMarketAdapter.start()
        console.log('[StrategyManager] Weather market scanner started')
      }).catch(() => {})
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

  getLLMStrategy(): BaseStrategy | undefined {
    return this.strategies.get('llm-prediction')
  }

  getDipStrategy(): BaseStrategy | undefined {
    return this.strategies.get('dip-arb')
  }

  getProjectFWStrategy(): BaseStrategy | undefined {
    return this.strategies.get('project-fw')
  }

  getBtcUpDownStrategy(): BaseStrategy | undefined {
    return this.strategies.get('btc-updown')
  }

  getGabagoolStrategy(): BaseStrategy | undefined {
    return this.strategies.get('gabagool')
  }

  getDualSideStrategy(): BaseStrategy | undefined {
    return this.strategies.get('dual-side')
  }

  getImpulseSniperStrategy(): BaseStrategy | undefined {
    return this.strategies.get('impulse-sniper')
  }

  // Strategies that depend on btc-updown for signals and market discovery
  private static readonly BTC_DEPENDENTS = ['dual-side', 'gabagool']

  /**
   * Enable a strategy
   */
  async enableStrategy(id: string): Promise<void> {
    const strategy = this.strategies.get(id)
    if (!strategy) {
      throw new Error(`Strategy ${id} not found`)
    }

    // Auto-enable BTC Up/Down when a dependent strategy is turned on
    if (StrategyManager.BTC_DEPENDENTS.includes(id)) {
      const btc = this.strategies.get('btc-updown')
      if (btc && !btc.enabled) {
        await btc.enable()
        activityLogger.logSystem(`Crypto Up/Down auto-enabled (required by ${strategy.name})`)
      }
    }

    await strategy.enable() // enable() internally calls start()

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

    // Auto-disable dependents when BTC Up/Down is turned off
    if (id === 'btc-updown') {
      for (const depId of StrategyManager.BTC_DEPENDENTS) {
        const dep = this.strategies.get(depId)
        if (dep?.enabled) {
          await dep.disable()
          activityLogger.logSystem(`${dep.name} auto-disabled (depends on Crypto Up/Down)`)
        }
      }
    }

    await strategy.disable() // disable() internally calls stop()

    // Cancel pending GTD orders for this strategy (dynamic import avoids circular dep)
    const strategyTag = id === 'llm-prediction' ? 'llm' : id === 'dip-arb' ? 'dip' : id === 'project-fw' ? 'fw' : id === 'btc-updown' ? 'btc' : id === 'gabagool' ? 'gabagool' : id === 'dual-side' ? 'dual-side' : id === 'impulse-sniper' ? 'impulse' : id === 'liquidation-momentum' ? 'liquidation' : null
    if (strategyTag) {
      import('@/services/trading/GtcOrderManager').then(({ gtcOrderManager }) => {
        gtcOrderManager.cancelAllForStrategy(strategyTag as 'llm' | 'dip' | 'fw' | 'btc' | 'dual-side' | 'gabagool' | 'impulse' | 'liquidation').then(n => {
          if (n > 0) activityLogger.logSystem(`Cancelled ${n} pending GTD order(s) for ${strategy.name}`)
        })
      }).catch(() => {})
    }

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
    return Array.from(this.strategies.entries()).map(([id, strategy]) => ({
      id,
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
      id,
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

    // Cancel all pending GTD orders (emergency stop path)
    import('@/services/trading/GtcOrderManager').then(({ gtcOrderManager }) => {
      gtcOrderManager.cancelAll().then(n => {
        if (n > 0) activityLogger.logSystem(`Cancelled ${n} pending GTD order(s)`)
      })
    }).catch(() => {})

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
