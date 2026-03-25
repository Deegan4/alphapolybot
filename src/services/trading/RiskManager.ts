import { activityLogger } from './ActivityLogger'
import { useWalletStore } from '@/stores/walletStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useBalanceHistoryStore } from '@/stores/balanceHistoryStore'

// ==========================================
// TYPES
// ==========================================

export interface RiskManagerConfig {
  dailyLossLimit: number
  weeklyLossLimit: number
  maxTradesPerHour: number
  consecutiveFailureLimit: number
  minBalanceForTrade: number
  minMaticForGas: number
  maxDrawdownPercent: number     // e.g. 0.30 = 30% max drawdown from peak balance
  maxPerMarketExposure: number   // e.g. 0.20 = 20% of capital per market
  maxCategoryExposure: number    // e.g. 0.40 = 40% of capital per category
  enabled: boolean
}

export type RiskCode =
  | 'DAILY_LOSS_EXCEEDED'
  | 'WEEKLY_LOSS_EXCEEDED'
  | 'HOURLY_TRADE_LIMIT'
  | 'CONSECUTIVE_FAILURES'
  | 'INSUFFICIENT_BALANCE'
  | 'INSUFFICIENT_GAS'
  | 'EMERGENCY_STOPPED'
  | 'MAX_DRAWDOWN'
  | 'MARKET_CONCENTRATION'
  | 'CATEGORY_CONCENTRATION'
  | 'CORRELATED_EXPOSURE'

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
  pnlLast7d: number
  config: RiskManagerConfig
}

// ==========================================
// DEFAULTS
// ==========================================

const DEFAULT_CONFIG: RiskManagerConfig = {
  dailyLossLimit: 3,        // $3/day = 15% of $20 bankroll
  weeklyLossLimit: 6,       // $6/week = 30% of $20
  maxTradesPerHour: 15,     // Fewer trades = less variance on small bankroll
  consecutiveFailureLimit: 3, // Tight circuit breaker
  minBalanceForTrade: 1,    // $1 CLOB minimum
  minMaticForGas: 0.01,
  maxDrawdownPercent: 0.25,       // 25% drawdown triggers emergency stop ($5 from $20 peak)
  maxPerMarketExposure: 0.50,     // 50% of capital max per market (was 20% — too tight for small bankrolls)
  maxCategoryExposure: 0.70,      // 70% of capital max per category (was 40% — BTC markets are same category)
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
  private capitalReservationFns: Array<() => number> = []
  private peakBalance = 0
  private marketExposure = new Map<string, number>() // conditionId → USD exposure
  private categoryExposure = new Map<string, number>() // category → USD exposure
  private marketToCategory = new Map<string, string>() // conditionId → category
  // Cross-strategy: per-underlying-asset exposure (BTC, ETH, SOL, XRP)
  private assetExposure = new Map<string, number>() // asset → total USD across all strategies
  private strategyExposure = new Map<string, number>() // strategyId → total USD exposure
  private strategyAssetExposure = new Map<string, number>() // "strategyId::asset" → USD (for correlation counting)
  // Drawdown throttle: reduce scan frequency after consecutive losses
  private recentLosses = 0
  private lastThrottleReset = Date.now()

  /**
   * Scale an absolute dollar limit for penny trader mode.
   * Penny mode uses 60% of normal limits so a $2 daily limit becomes $1.20
   * (survives at least one $1 losing trade before circuit-breaking).
   * Previous 20% scaling made $2 → $0.40 which was below the $1 CLOB minimum.
   */
  private getPennyScaledLimit(baseLimit: number): number {
    const pennyMode = useSettingsStore.getState().pennyTraderMode ?? false
    return pennyMode ? baseLimit * 0.6 : baseLimit
  }

  constructor(config?: Partial<RiskManagerConfig>) {
    const settings = useSettingsStore.getState()
    this.config = {
      dailyLossLimit: settings.dailyLossLimit ?? DEFAULT_CONFIG.dailyLossLimit,
      weeklyLossLimit: settings.weeklyLossLimit ?? DEFAULT_CONFIG.weeklyLossLimit,
      maxTradesPerHour: settings.maxTradesPerHour ?? DEFAULT_CONFIG.maxTradesPerHour,
      consecutiveFailureLimit: settings.consecutiveFailureLimit ?? DEFAULT_CONFIG.consecutiveFailureLimit,
      minBalanceForTrade: settings.minBalanceForTrade ?? DEFAULT_CONFIG.minBalanceForTrade,
      minMaticForGas: settings.minMaticForGas ?? DEFAULT_CONFIG.minMaticForGas,
      maxDrawdownPercent: settings.maxDrawdownPercent ?? DEFAULT_CONFIG.maxDrawdownPercent,
      maxPerMarketExposure: settings.maxPerMarketExposure ?? DEFAULT_CONFIG.maxPerMarketExposure,
      maxCategoryExposure: (settings as Record<string, unknown>).maxCategoryExposure as number ?? DEFAULT_CONFIG.maxCategoryExposure,
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
      // Skip monitoring when risk management is disabled
      if (!this.config.enabled) return

      // Reset failure counter on successful trade
      if (activity.type === 'trade') {
        this.consecutiveFailures = 0
      }
      // Failure counting handled exclusively by recordTradeResult()
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
  validateTrade(tradeAmountUSDC: number, conditionId?: string, category?: string, asset?: string, strategyId?: string): RiskCheckResult {
    // Risk management disabled: skip all checks
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

    // 4. Daily loss limit (rolling 24h window, scaled for penny mode)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
    this.tradePnLs = this.tradePnLs.filter(t => t.timestamp > oneDayAgo)
    const totalPnl = this.tradePnLs.reduce((sum, t) => sum + t.pnl, 0)
    const effectiveDailyLimit = this.getPennyScaledLimit(this.config.dailyLossLimit)
    if (totalPnl <= -effectiveDailyLimit) {
      this.emergencyStop(`Daily loss limit reached: $${Math.abs(totalPnl).toFixed(2)} lost`)
      return {
        allowed: false,
        reason: `Daily loss limit exceeded ($${effectiveDailyLimit})`,
        riskCode: 'DAILY_LOSS_EXCEEDED',
      }
    }

    // 4b. Weekly loss limit (rolling 7-day window, scaled for penny mode)
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const weeklyPnl = this.tradePnLs
      .filter(t => t.timestamp > oneWeekAgo)
      .reduce((sum, t) => sum + t.pnl, 0)
    const effectiveWeeklyLimit = this.getPennyScaledLimit(this.config.weeklyLossLimit)
    if (weeklyPnl <= -effectiveWeeklyLimit) {
      this.emergencyStop(`Weekly loss limit reached: $${Math.abs(weeklyPnl).toFixed(2)} lost`)
      return {
        allowed: false,
        reason: `Weekly loss limit exceeded ($${effectiveWeeklyLimit})`,
        riskCode: 'WEEKLY_LOSS_EXCEEDED',
      }
    }

    // 5. Read balance — wallet in live mode, paper balance in dry run.
    const settings = useSettingsStore.getState()
    const isDryRun = settings.dryRun
    const currentBalance = isDryRun
      ? (useBalanceHistoryStore.getState().simulatedBalance || settings.paperBalance)
      : useWalletStore.getState().balance
    const reserved = this.capitalReservationFns.reduce((sum, fn) => sum + (fn() ?? 0), 0)
    const tradeable = currentBalance - reserved

    // 5a. Max drawdown check — triggers emergency stop if balance drops too far from peak
    if (this.peakBalance > 0 && currentBalance > 0) {
      const drawdown = (this.peakBalance - currentBalance) / this.peakBalance
      if (drawdown >= this.config.maxDrawdownPercent) {
        this.emergencyStop(`Max drawdown breached: ${(drawdown * 100).toFixed(1)}% from peak $${this.peakBalance.toFixed(2)}`)
        return {
          allowed: false,
          reason: `Max drawdown breached (${(drawdown * 100).toFixed(1)}% ≥ ${(this.config.maxDrawdownPercent * 100).toFixed(0)}%)`,
          riskCode: 'MAX_DRAWDOWN',
        }
      }
    }
    // Update peak balance tracking
    if (currentBalance > this.peakBalance) {
      this.peakBalance = currentBalance
    }

    // 5b. Per-market concentration check
    if (conditionId && this.config.maxPerMarketExposure > 0) {
      const existingExposure = this.marketExposure.get(conditionId) ?? 0
      const totalCapital = currentBalance > 0 ? currentBalance : 1 // avoid /0
      const newExposureRatio = (existingExposure + tradeAmountUSDC) / totalCapital
      if (newExposureRatio > this.config.maxPerMarketExposure) {
        return {
          allowed: false,
          reason: `Market concentration limit: $${(existingExposure + tradeAmountUSDC).toFixed(2)} would be ${(newExposureRatio * 100).toFixed(0)}% of capital (max ${(this.config.maxPerMarketExposure * 100).toFixed(0)}%)`,
          riskCode: 'MARKET_CONCENTRATION',
        }
      }
    }

    // 5c. Category correlation check — caps exposure to any single category (e.g. "Crypto", "Politics")
    if (category && this.config.maxCategoryExposure > 0) {
      const existingCatExposure = this.categoryExposure.get(category) ?? 0
      const totalCapital = currentBalance > 0 ? currentBalance : 1
      const newCatRatio = (existingCatExposure + tradeAmountUSDC) / totalCapital
      if (newCatRatio > this.config.maxCategoryExposure) {
        return {
          allowed: false,
          reason: `Category '${category}' concentration: $${(existingCatExposure + tradeAmountUSDC).toFixed(2)} would be ${(newCatRatio * 100).toFixed(0)}% of capital (max ${(this.config.maxCategoryExposure * 100).toFixed(0)}%)`,
          riskCode: 'CATEGORY_CONCENTRATION',
        }
      }
    }

    // 5d. Cross-strategy asset correlation check — caps total exposure to any single
    // underlying asset (e.g., BTC) across ALL strategies. Tighter than category check
    // because multiple strategies trading BTC-derived markets are effectively one bet.
    if (asset) {
      const assetCheck = this.checkAssetConcentration(asset, tradeAmountUSDC)
      if (!assetCheck.allowed) {
        return { ...assetCheck, riskCode: 'CORRELATED_EXPOSURE' }
      }
      // Track strategy-level exposure for diagnostics
      if (strategyId) {
        const stratExisting = this.strategyExposure.get(strategyId) ?? 0
        const stratRatio = (stratExisting + tradeAmountUSDC) / (currentBalance > 0 ? currentBalance : 1)
        if (stratRatio > 0.40) {
          return {
            allowed: false,
            reason: `Strategy '${strategyId}' concentration: $${(stratExisting + tradeAmountUSDC).toFixed(2)} ` +
              `would be ${(stratRatio * 100).toFixed(0)}% of capital (max 40%)`,
            riskCode: 'CORRELATED_EXPOSURE',
          }
        }
      }
    }

    // 6. Balance check (uses wallet snapshot + reservations computed above)
    if (tradeable < tradeAmountUSDC || tradeable < this.config.minBalanceForTrade) {
      const reservedNote = reserved > 0
        ? ` ($${reserved.toFixed(2)} reserved in pending GTD orders)`
        : ''
      return {
        allowed: false,
        reason: `Insufficient balance: $${tradeable.toFixed(2)} (need $${tradeAmountUSDC.toFixed(2)}, min $${this.config.minBalanceForTrade})${reservedNote}`,
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
   *
   * @param reason - 'structural' for balance/allowance issues that don't count
   *   toward circuit breaker (these are config problems, not trade failures).
   *   Omit or pass undefined/'transient' for real execution failures.
   */
  recordTradeResult(success: boolean, pnl = 0, reason?: 'transient' | 'structural'): void {
    if (success) {
      this.consecutiveFailures = 0
      this.tradePnLs.push({ timestamp: Date.now(), pnl })
    } else {
      // Structural failures (balance, allowance, min-size) are config problems —
      // don't count toward consecutive failure circuit breaker
      if (reason === 'structural') {
        console.warn('[RiskManager] Structural failure recorded (not counted toward circuit breaker)')
        return
      }
      this.consecutiveFailures++
      if (this.consecutiveFailures >= this.config.consecutiveFailureLimit) {
        this.emergencyStop(`${this.consecutiveFailures} consecutive trade failures`)
      }
    }
  }

  /**
   * Record USD exposure for a market (called on successful buy).
   * Used by per-market concentration check in validateTrade().
   */
  recordMarketExposure(conditionId: string, amountUSDC: number): void {
    const existing = this.marketExposure.get(conditionId) ?? 0
    this.marketExposure.set(conditionId, existing + amountUSDC)
  }

  /**
   * Reduce USD exposure for a market (called on position close/sell).
   * Clears the entry entirely if exposure drops to zero or below.
   */
  reduceMarketExposure(conditionId: string, amountUSDC: number): void {
    const existing = this.marketExposure.get(conditionId) ?? 0
    const remaining = existing - amountUSDC
    if (remaining <= 0) {
      this.marketExposure.delete(conditionId)
    } else {
      this.marketExposure.set(conditionId, remaining)
    }
  }

  /**
   * Record category exposure for a market. Call alongside recordMarketExposure().
   */
  recordCategoryExposure(conditionId: string, category: string, amountUSDC: number): void {
    this.marketToCategory.set(conditionId, category)
    const existing = this.categoryExposure.get(category) ?? 0
    this.categoryExposure.set(category, existing + amountUSDC)
  }

  /**
   * Reduce category exposure when a position closes.
   * Also cleans up marketToCategory mapping when exposure hits zero.
   */
  reduceCategoryExposure(conditionId: string, amountUSDC: number): void {
    const category = this.marketToCategory.get(conditionId)
    if (!category) return
    const existing = this.categoryExposure.get(category) ?? 0
    const remaining = existing - amountUSDC
    if (remaining <= 0) {
      this.categoryExposure.delete(category)
    } else {
      this.categoryExposure.set(category, remaining)
    }
    // Clean up reverse lookup if market has no more exposure
    if (!this.marketExposure.has(conditionId)) {
      this.marketToCategory.delete(conditionId)
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

    // Cancel all pending GTD orders
    import('./GtcOrderManager').then(({ gtcOrderManager }) => {
      gtcOrderManager.cancelAll().then(cancelled => {
        if (cancelled > 0) {
          activityLogger.logWarning(`Emergency: cancelled ${cancelled} pending GTD order(s)`)
        }
      })
    }).catch(() => {})
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
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

    const tradesLastHour = this.tradeTimestamps.filter(t => t > oneHourAgo).length
    const pnlLast24h = this.tradePnLs
      .filter(t => t.timestamp > oneDayAgo)
      .reduce((sum, t) => sum + t.pnl, 0)
    const pnlLast7d = this.tradePnLs
      .filter(t => t.timestamp > oneWeekAgo)
      .reduce((sum, t) => sum + t.pnl, 0)

    return {
      emergencyStopped: this._emergencyStopped,
      emergencyReason: this._emergencyReason || undefined,
      consecutiveFailures: this.consecutiveFailures,
      tradesLastHour,
      pnlLast24h,
      pnlLast7d,
      config: {
        ...this.config,
        dailyLossLimit: this.getPennyScaledLimit(this.config.dailyLossLimit),
        weeklyLossLimit: this.getPennyScaledLimit(this.config.weeklyLossLimit),
      },
    }
  }

  /**
   * Register a function that returns capital reserved (GTD orders, in-flight trades, etc.)
   * Called by GtcOrderManager and TradingService — avoids circular dependency.
   * Multiple registrations are additive (all amounts are summed).
   */
  addCapitalReservationFn(fn: () => number): void {
    this.capitalReservationFns.push(fn)
  }

  /** @deprecated Use addCapitalReservationFn — kept for backward compatibility */
  setCapitalReservationFn(fn: () => number): void {
    this.addCapitalReservationFn(fn)
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

  // ==========================================
  // CROSS-STRATEGY EXPOSURE TRACKING
  // ==========================================

  /**
   * Record exposure for an underlying asset (BTC, ETH, SOL, XRP).
   * Multiple strategies trading BTC-derived markets all contribute to the
   * same asset bucket. This catches correlated risk that per-market limits miss.
   *
   * @param asset Underlying asset symbol (e.g., 'BTC')
   * @param strategyId Strategy placing the trade (e.g., 'btc-updown')
   * @param amountUSDC Dollar amount of the position
   */
  recordAssetExposure(asset: string, strategyId: string, amountUSDC: number): void {
    const existing = this.assetExposure.get(asset) ?? 0
    this.assetExposure.set(asset, existing + amountUSDC)
    const stratExisting = this.strategyExposure.get(strategyId) ?? 0
    this.strategyExposure.set(strategyId, stratExisting + amountUSDC)
    // Composite key for correlation counting: which strategies are on which assets
    const compositeKey = `${strategyId}::${asset}`
    const compositeExisting = this.strategyAssetExposure.get(compositeKey) ?? 0
    this.strategyAssetExposure.set(compositeKey, compositeExisting + amountUSDC)
  }

  /**
   * Reduce exposure for an underlying asset when a position closes.
   */
  reduceAssetExposure(asset: string, strategyId: string, amountUSDC: number): void {
    const remaining = (this.assetExposure.get(asset) ?? 0) - amountUSDC
    if (remaining <= 0) this.assetExposure.delete(asset)
    else this.assetExposure.set(asset, remaining)

    const stratRemaining = (this.strategyExposure.get(strategyId) ?? 0) - amountUSDC
    if (stratRemaining <= 0) this.strategyExposure.delete(strategyId)
    else this.strategyExposure.set(strategyId, stratRemaining)

    const compositeKey = `${strategyId}::${asset}`
    const compositeRemaining = (this.strategyAssetExposure.get(compositeKey) ?? 0) - amountUSDC
    if (compositeRemaining <= 0) this.strategyAssetExposure.delete(compositeKey)
    else this.strategyAssetExposure.set(compositeKey, compositeRemaining)
  }

  /**
   * Check if a new trade would exceed per-asset correlation limits.
   *
   * The cap is DYNAMIC based on how many strategies are already exposed to this asset:
   * - 1 strategy on the asset: 60% cap (single-strategy focus is fine)
   * - 2 strategies on the asset: 45% cap (correlated — tighten)
   * - 3+ strategies on the asset: 35% cap (heavily correlated — aggressive limit)
   *
   * This replaces the flat 80% cap. The intuition: if 3 strategies all bet BTC-up
   * and BTC drops, you lose 3x what any single strategy would lose.
   *
   * Can be overridden via maxAssetExposure setting in settingsStore.
   */
  checkAssetConcentration(asset: string, amountUSDC: number, maxAssetExposureOverride?: number): RiskCheckResult {
    if (!this.config.enabled) return { allowed: true }

    const settings = useSettingsStore.getState()
    const isDryRun = settings.dryRun
    const currentBalance = isDryRun
      ? (useBalanceHistoryStore.getState().simulatedBalance || settings.paperBalance)
      : useWalletStore.getState().balance
    if (currentBalance <= 0) return { allowed: true }

    // Count how many distinct strategies have exposure to this asset
    const strategiesOnAsset = this.getStrategiesOnAsset(asset)
    const strategyCount = strategiesOnAsset.length

    // Dynamic cap: tightens as more strategies pile onto the same asset
    // maxAssetExposure=0 means "use dynamic caps", any positive value overrides
    const settingOverride = settings.maxAssetExposure > 0 ? settings.maxAssetExposure : undefined
    const dynamicCap = maxAssetExposureOverride
      ?? settingOverride
      ?? this.getCorrelationAdjustedCap(strategyCount)

    const existingExposure = this.assetExposure.get(asset) ?? 0
    const newRatio = (existingExposure + amountUSDC) / currentBalance

    if (newRatio > dynamicCap) {
      return {
        allowed: false,
        reason: `Asset '${asset}' correlated exposure: $${(existingExposure + amountUSDC).toFixed(2)} ` +
          `would be ${(newRatio * 100).toFixed(0)}% of capital ` +
          `(max ${(dynamicCap * 100).toFixed(0)}% with ${strategyCount} strategies on ${asset})`,
        riskCode: 'CORRELATED_EXPOSURE',
      }
    }
    return { allowed: true }
  }

  /**
   * Dynamic cap based on strategy concentration on the same asset.
   * More strategies = tighter cap, because losses are correlated.
   */
  private getCorrelationAdjustedCap(strategyCount: number): number {
    if (strategyCount <= 1) return 0.60  // Single strategy: 60%
    if (strategyCount === 2) return 0.45 // Two strategies: 45%
    return 0.35                          // Three+: 35%
  }

  /**
   * Get list of strategy IDs that currently have exposure to a given asset.
   */
  private getStrategiesOnAsset(asset: string): string[] {
    const strategies: string[] = []
    // strategyAssetExposure tracks per-strategy-per-asset amounts
    for (const [key, amount] of this.strategyAssetExposure) {
      const [stratId, assetKey] = key.split('::')
      if (assetKey === asset && amount > 0) {
        strategies.push(stratId)
      }
    }
    return strategies
  }

  /**
   * Get total exposure per underlying asset (for UI display).
   */
  getAssetExposures(): Record<string, number> {
    return Object.fromEntries(this.assetExposure)
  }

  /**
   * Get total exposure per strategy (for UI display).
   */
  getStrategyExposures(): Record<string, number> {
    return Object.fromEntries(this.strategyExposure)
  }

  // ==========================================
  // DRAWDOWN-BASED THROTTLING
  // ==========================================

  /**
   * Get a throttle multiplier for scan intervals based on recent losses.
   * After consecutive losses, strategies should scan less frequently to
   * avoid panic-trading. Returns a multiplier (1.0 = normal, 2.0 = 2x slower).
   *
   * Resets after 30 minutes of no new losses.
   */
  getThrottleMultiplier(): number {
    // Reset if 30 minutes since last loss
    if (Date.now() - this.lastThrottleReset > 30 * 60 * 1000) {
      this.recentLosses = 0
    }

    // Exponential backoff: 1x, 1.5x, 2x, 3x, 4x
    if (this.recentLosses <= 0) return 1.0
    if (this.recentLosses === 1) return 1.5
    if (this.recentLosses === 2) return 2.0
    if (this.recentLosses === 3) return 3.0
    return 4.0
  }

  /**
   * Record a loss for throttle tracking (called alongside recordTradeResult).
   */
  recordLossForThrottle(): void {
    this.recentLosses++
    this.lastThrottleReset = Date.now()
  }

  /**
   * Reset throttle (called on successful trade).
   */
  resetThrottle(): void {
    this.recentLosses = 0
    this.lastThrottleReset = Date.now()
  }

  /**
   * Prune in-memory collections. Called periodically from App.tsx.
   * Removes expired rolling-window entries that validateTrade()
   * would also clean, but this ensures cleanup even during idle periods.
   */
  pruneInMemory(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

    const oldTimestamps = this.tradeTimestamps.length
    this.tradeTimestamps = this.tradeTimestamps.filter(t => t > oneHourAgo)

    const oldPnLs = this.tradePnLs.length
    this.tradePnLs = this.tradePnLs.filter(t => t.timestamp > oneWeekAgo)

    const pruned = (oldTimestamps - this.tradeTimestamps.length) + (oldPnLs - this.tradePnLs.length)
    if (pruned > 0) {
      console.log(`[RiskManager] Pruned ${pruned} expired in-memory entries`)
    }
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
