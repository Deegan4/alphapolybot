import { activityLogger } from './ActivityLogger'
import { useWalletStore } from '@/stores/walletStore'
import { useSettingsStore } from '@/stores/settingsStore'

// ==========================================
// TYPES
// ==========================================

export interface RiskManagerConfig {
  dailyLossLimit: number
  maxTradesPerHour: number
  consecutiveFailureLimit: number
  minBalanceForTrade: number
  enabled: boolean
}

export type RiskCode =
  | 'DAILY_LOSS_EXCEEDED'
  | 'HOURLY_TRADE_LIMIT'
  | 'CONSECUTIVE_FAILURES'
  | 'INSUFFICIENT_BALANCE'
  | 'EMERGENCY_STOPPED'

export interface RiskCheckResult {
  allowed: boolean
  reason?: string
  riskCode?: RiskCode
}

export interface RiskManagerStatus {
  emergencyStopped: boolean
  emergencyReason?: string
  consecutiveFailures: number
  tradesLastHour: number
  pnlLast24h: number
  config: RiskManagerConfig
}

// ==========================================
// DEFAULTS
// ==========================================

const DEFAULT_CONFIG: RiskManagerConfig = {
  dailyLossLimit: 10,
  maxTradesPerHour: 20,
  consecutiveFailureLimit: 5,
  minBalanceForTrade: 5,
  enabled: true,
}

// ==========================================
// SERVICE
// ==========================================

/**
 * RiskManager - Circuit breaker and pre-trade validation gate
 *
 * Validates every trade before execution. Monitors error rates
 * and triggers emergency stop when safety limits are breached.
 */
export class RiskManager {
  private config: RiskManagerConfig
  private _emergencyStopped = false
  private _emergencyReason = ''
  private consecutiveFailures = 0
  private tradeTimestamps: number[] = []
  private tradePnLs: Array<{ timestamp: number; pnl: number }> = []
  private unsubscribeLogger: (() => void) | null = null

  constructor(config?: Partial<RiskManagerConfig>) {
    // Read persisted settings, falling back to defaults
    const settings = useSettingsStore.getState()
    this.config = {
      dailyLossLimit: settings.dailyLossLimit ?? DEFAULT_CONFIG.dailyLossLimit,
      maxTradesPerHour: settings.maxTradesPerHour ?? DEFAULT_CONFIG.maxTradesPerHour,
      consecutiveFailureLimit: settings.consecutiveFailureLimit ?? DEFAULT_CONFIG.consecutiveFailureLimit,
      minBalanceForTrade: settings.minBalanceForTrade ?? DEFAULT_CONFIG.minBalanceForTrade,
      enabled: settings.riskManagementEnabled ?? DEFAULT_CONFIG.enabled,
      ...config,
    }
  }

  /**
   * Initialize - subscribe to ActivityLogger for error-rate monitoring
   * Call this before strategyManager.initialize()
   */
  initialize(): void {
    this.unsubscribeLogger = activityLogger.subscribe((activity) => {
      // Reset failure counter on successful trade
      if (activity.type === 'trade') {
        this.consecutiveFailures = 0
      }

      // Increment on trade-related errors (defense-in-depth)
      if (activity.type === 'error') {
        const msg = activity.message.toLowerCase()
        if (msg.includes('trade') || msg.includes('order') || msg.includes('execution')) {
          this.consecutiveFailures++
          if (this.consecutiveFailures >= this.config.consecutiveFailureLimit) {
            this.emergencyStop(`${this.consecutiveFailures} consecutive trade-related errors`)
          }
        }
      }
    })

    console.log('[RiskManager] Initialized with config:', {
      dailyLossLimit: this.config.dailyLossLimit,
      maxTradesPerHour: this.config.maxTradesPerHour,
      consecutiveFailureLimit: this.config.consecutiveFailureLimit,
    })
  }

  /**
   * Pre-trade validation gate (synchronous)
   * Checks are ordered cheapest-first for fast rejection
   */
  validateTrade(tradeAmountUSDC: number): RiskCheckResult {
    // Skip all checks if risk management is disabled
    if (!this.config.enabled) {
      return { allowed: true }
    }

    // 1. Emergency stop latch
    if (this._emergencyStopped) {
      return {
        allowed: false,
        reason: `Emergency stop active: ${this._emergencyReason}`,
        riskCode: 'EMERGENCY_STOPPED',
      }
    }

    // 2. Consecutive failure check
    if (this.consecutiveFailures >= this.config.consecutiveFailureLimit) {
      this.emergencyStop(`${this.consecutiveFailures} consecutive failures`)
      return {
        allowed: false,
        reason: `Circuit breaker: ${this.consecutiveFailures} consecutive failures`,
        riskCode: 'CONSECUTIVE_FAILURES',
      }
    }

    // 3. Hourly trade limit (rolling window)
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    this.tradeTimestamps = this.tradeTimestamps.filter(t => t > oneHourAgo)
    if (this.tradeTimestamps.length >= this.config.maxTradesPerHour) {
      return {
        allowed: false,
        reason: `Hourly trade limit reached (${this.config.maxTradesPerHour}/hour)`,
        riskCode: 'HOURLY_TRADE_LIMIT',
      }
    }

    // 4. Daily loss limit (rolling 24h window)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
    this.tradePnLs = this.tradePnLs.filter(t => t.timestamp > oneDayAgo)
    const totalPnl = this.tradePnLs.reduce((sum, t) => sum + t.pnl, 0)
    if (totalPnl <= -this.config.dailyLossLimit) {
      this.emergencyStop(`Daily loss limit reached: $${Math.abs(totalPnl).toFixed(2)} lost`)
      return {
        allowed: false,
        reason: `Daily loss limit exceeded ($${this.config.dailyLossLimit})`,
        riskCode: 'DAILY_LOSS_EXCEEDED',
      }
    }

    // 5. Balance check
    const { usdcBalance } = useWalletStore.getState()
    if (usdcBalance < tradeAmountUSDC || usdcBalance < this.config.minBalanceForTrade) {
      return {
        allowed: false,
        reason: `Insufficient balance: $${usdcBalance.toFixed(2)} (need $${tradeAmountUSDC.toFixed(2)}, min $${this.config.minBalanceForTrade})`,
        riskCode: 'INSUFFICIENT_BALANCE',
      }
    }

    return { allowed: true }
  }

  /**
   * Record that a trade was attempted (for hourly rate tracking)
   */
  recordTradeAttempt(): void {
    this.tradeTimestamps.push(Date.now())
  }

  /**
   * Record trade outcome (success/failure + P&L)
   */
  recordTradeResult(success: boolean, pnl = 0): void {
    if (success) {
      this.consecutiveFailures = 0
      this.tradePnLs.push({ timestamp: Date.now(), pnl })
    } else {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= this.config.consecutiveFailureLimit) {
        this.emergencyStop(`${this.consecutiveFailures} consecutive trade failures`)
      }
    }
  }

  /**
   * Trigger emergency stop - latches until manual reset
   * Uses dynamic import to avoid circular dependency with StrategyManager
   */
  emergencyStop(reason: string): void {
    if (this._emergencyStopped) return

    this._emergencyStopped = true
    this._emergencyReason = reason

    activityLogger.logWarning(`EMERGENCY STOP: ${reason}`)
    activityLogger.logSystem('All strategies halted by RiskManager')

    // Dynamic import breaks: StrategyManager → strategies → TradingService → RiskManager → StrategyManager
    import('@/services/strategies').then(({ strategyManager }) => {
      strategyManager.stopAll()
    }).catch((error) => {
      console.error('[RiskManager] Failed to stop strategies:', error)
    })
  }

  /**
   * Manual reset - requires user action to resume trading
   */
  resetEmergencyStop(): void {
    this._emergencyStopped = false
    this._emergencyReason = ''
    this.consecutiveFailures = 0
    activityLogger.logSystem('Emergency stop reset by user')
  }

  /**
   * Get current risk manager status (for UI display)
   */
  getStatus(): RiskManagerStatus {
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000

    const tradesLastHour = this.tradeTimestamps.filter(t => t > oneHourAgo).length
    const pnlLast24h = this.tradePnLs
      .filter(t => t.timestamp > oneDayAgo)
      .reduce((sum, t) => sum + t.pnl, 0)

    return {
      emergencyStopped: this._emergencyStopped,
      emergencyReason: this._emergencyReason || undefined,
      consecutiveFailures: this.consecutiveFailures,
      tradesLastHour,
      pnlLast24h,
      config: { ...this.config },
    }
  }

  /**
   * Update configuration (called from settings store setters)
   */
  setConfig(config: Partial<RiskManagerConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Check if emergency stop is active
   */
  get emergencyStopped(): boolean {
    return this._emergencyStopped
  }

  /**
   * Cleanup subscriptions
   */
  destroy(): void {
    if (this.unsubscribeLogger) {
      this.unsubscribeLogger()
      this.unsubscribeLogger = null
    }
  }
}

// Export singleton instance
export const riskManager = new RiskManager()
