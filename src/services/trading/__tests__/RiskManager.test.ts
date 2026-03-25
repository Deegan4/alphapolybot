import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RiskManager } from '../RiskManager'

// Hoisted mutable state — vi.mock() is hoisted above const declarations,
// so we use vi.hoisted() to make these available inside mock factories.
const { mockWalletState, mockSettingsState } = vi.hoisted(() => ({
  mockWalletState: { balance: 100, buyingPower: 100 },
  mockSettingsState: {
    dailyLossLimit: 4,
    weeklyLossLimit: 20,
    maxTradesPerHour: 20,
    consecutiveFailureLimit: 5,
    minBalanceForTrade: 5,
    minMaticForGas: 0.01,
    riskManagementEnabled: true,
    pennyTraderMode: false,
  } as Record<string, unknown>,
}))

// Mock wallet store - default to healthy balance
vi.mock('@/stores/walletStore', () => ({
  useWalletStore: {
    getState: () => mockWalletState,
  },
}))

// Mock settings store - mutable so tests can toggle pennyTraderMode
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => mockSettingsState,
  },
}))

// Mock balanceHistoryStore (used by checkAssetConcentration for dry-run balance)
vi.mock('@/stores/balanceHistoryStore', () => ({
  useBalanceHistoryStore: {
    getState: () => ({ simulatedBalance: 0 }),
  },
}))

// Mock ActivityLogger
vi.mock('../ActivityLogger', () => ({
  activityLogger: {
    subscribe: vi.fn(() => vi.fn()),
    logWarning: vi.fn(),
    logSystem: vi.fn(),
  },
}))

// Mock strategies module (for emergencyStop dynamic import)
vi.mock('@/services/strategies', () => ({
  strategyManager: {
    stopAll: vi.fn(),
  },
}))

describe('RiskManager', () => {
  let rm: RiskManager

  beforeEach(() => {
    // Fresh instance per test (not the singleton)
    rm = new RiskManager()
    // Reset wallet balances to defaults
    mockWalletState.balance = 100
    mockWalletState.buyingPower = 100
    // Reset penny mode
    mockSettingsState.pennyTraderMode = false
  })

  // ────────────────────────────────────────────
  // validateTrade
  // ────────────────────────────────────────────

  it('allows trade when all checks pass', () => {
    const result = rm.validateTrade(10)
    expect(result.allowed).toBe(true)
    expect(result.riskCode).toBeUndefined()
  })

  it('rejects when emergency stopped', () => {
    rm.emergencyStop('test reason')
    const result = rm.validateTrade(10)
    expect(result.allowed).toBe(false)
    expect(result.riskCode).toBe('EMERGENCY_STOPPED')
    expect(result.reason).toContain('test reason')
  })

  it('rejects at consecutive failure limit', () => {
    // Record 5 failures (default limit)
    for (let i = 0; i < 5; i++) {
      rm.recordTradeResult(false)
    }
    const result = rm.validateTrade(10)
    expect(result.allowed).toBe(false)
    // Either CONSECUTIVE_FAILURES or EMERGENCY_STOPPED (emergency triggers at limit)
    expect(['CONSECUTIVE_FAILURES', 'EMERGENCY_STOPPED']).toContain(result.riskCode)
  })

  it('rejects at hourly trade limit', () => {
    // Fill up 20 trade timestamps (default limit)
    for (let i = 0; i < 20; i++) {
      rm.recordTradeAttempt()
    }
    const result = rm.validateTrade(10)
    expect(result.allowed).toBe(false)
    expect(result.riskCode).toBe('HOURLY_TRADE_LIMIT')
  })

  it('rejects when daily loss exceeded', () => {
    // Record losses totaling > $10 (default limit)
    rm.recordTradeResult(true, -6)
    rm.recordTradeResult(true, -5) // total = -$11
    const result = rm.validateTrade(10)
    expect(result.allowed).toBe(false)
    // Daily loss triggers emergency stop
    expect(['DAILY_LOSS_EXCEEDED', 'EMERGENCY_STOPPED']).toContain(result.riskCode)
  })

  it('rejects when insufficient balance', () => {
    mockWalletState.balance = 2
    mockWalletState.buyingPower = 2
    const result = rm.validateTrade(10)
    expect(result.allowed).toBe(false)
    expect(result.riskCode).toBe('INSUFFICIENT_BALANCE')
  })

  it('rejects when balance is below minimum', () => {
    mockWalletState.balance = 4 // below minBalanceForTrade (5)
    mockWalletState.buyingPower = 4
    const result = rm.validateTrade(3)
    expect(result.allowed).toBe(false)
    expect(result.riskCode).toBe('INSUFFICIENT_BALANCE')
  })

  it('bypasses all checks when disabled', () => {
    rm.setConfig({ enabled: false })
    rm.emergencyStop('should be ignored')

    // Even with emergency stop, disabled means allowed
    // Need fresh instance since emergencyStop latches
    const rm2 = new RiskManager({ enabled: false })
    mockWalletState.balance = 0 // zero balance
    mockWalletState.buyingPower = 0
    const result = rm2.validateTrade(1000)
    expect(result.allowed).toBe(true)
  })

  // ────────────────────────────────────────────
  // recordTradeResult
  // ────────────────────────────────────────────

  it('resets consecutive failures on success', () => {
    rm.recordTradeResult(false)
    rm.recordTradeResult(false)
    rm.recordTradeResult(false)
    expect(rm.getStatus().consecutiveFailures).toBe(3)

    rm.recordTradeResult(true, 5)
    expect(rm.getStatus().consecutiveFailures).toBe(0)
  })

  it('triggers emergency stop at failure limit', () => {
    for (let i = 0; i < 5; i++) {
      rm.recordTradeResult(false)
    }
    expect(rm.emergencyStopped).toBe(true)
  })

  it('tracks P&L from successful trades', () => {
    rm.recordTradeResult(true, 10)
    rm.recordTradeResult(true, -3)
    const status = rm.getStatus()
    expect(status.pnlLast24h).toBe(7)
  })

  // ────────────────────────────────────────────
  // structural vs transient failures
  // ────────────────────────────────────────────

  it('structural failures do NOT increment consecutiveFailures', () => {
    rm.recordTradeResult(false, 0, 'structural')
    rm.recordTradeResult(false, 0, 'structural')
    rm.recordTradeResult(false, 0, 'structural')
    expect(rm.getStatus().consecutiveFailures).toBe(0)
  })

  it('5 structural failures do NOT trigger emergency stop', () => {
    for (let i = 0; i < 10; i++) {
      rm.recordTradeResult(false, 0, 'structural')
    }
    expect(rm.emergencyStopped).toBe(false)
  })

  it('5 transient failures DO trigger emergency stop', () => {
    for (let i = 0; i < 5; i++) {
      rm.recordTradeResult(false, 0, 'transient')
    }
    expect(rm.emergencyStopped).toBe(true)
  })

  it('failures without reason default to transient behavior', () => {
    for (let i = 0; i < 5; i++) {
      rm.recordTradeResult(false)
    }
    expect(rm.emergencyStopped).toBe(true)
  })

  it('mixed structural + transient: only transient counts', () => {
    rm.recordTradeResult(false, 0, 'structural')
    rm.recordTradeResult(false, 0, 'structural')
    rm.recordTradeResult(false) // transient (no reason = default)
    rm.recordTradeResult(false, 0, 'structural')
    rm.recordTradeResult(false) // transient
    expect(rm.getStatus().consecutiveFailures).toBe(2)
    expect(rm.emergencyStopped).toBe(false)
  })

  // ────────────────────────────────────────────
  // recordTradeAttempt
  // ────────────────────────────────────────────

  it('tracks trade attempts for hourly limit', () => {
    rm.recordTradeAttempt()
    rm.recordTradeAttempt()
    rm.recordTradeAttempt()
    expect(rm.getStatus().tradesLastHour).toBe(3)
  })

  // ────────────────────────────────────────────
  // resetEmergencyStop
  // ────────────────────────────────────────────

  it('clears latch and failure counter', () => {
    rm.emergencyStop('test')
    expect(rm.emergencyStopped).toBe(true)

    rm.resetEmergencyStop()
    expect(rm.emergencyStopped).toBe(false)
    expect(rm.getStatus().consecutiveFailures).toBe(0)
  })

  it('allows trading again after reset', () => {
    rm.emergencyStop('test')
    expect(rm.validateTrade(10).allowed).toBe(false)

    rm.resetEmergencyStop()
    mockWalletState.balance = 100
    mockWalletState.buyingPower = 100
    expect(rm.validateTrade(10).allowed).toBe(true)
  })

  // ────────────────────────────────────────────
  // getStatus
  // ────────────────────────────────────────────

  it('returns correct status snapshot', () => {
    rm.recordTradeAttempt()
    rm.recordTradeResult(true, 5)
    rm.recordTradeResult(false)

    const status = rm.getStatus()
    expect(status.emergencyStopped).toBe(false)
    expect(status.tradesLastHour).toBe(1)
    expect(status.pnlLast24h).toBe(5)
    expect(status.consecutiveFailures).toBe(1)
    expect(status.config.dailyLossLimit).toBe(4)
  })

  // ────────────────────────────────────────────
  // setConfig
  // ────────────────────────────────────────────

  it('updates config dynamically', () => {
    rm.setConfig({ dailyLossLimit: 50, maxTradesPerHour: 100 })
    const status = rm.getStatus()
    expect(status.config.dailyLossLimit).toBe(50)
    expect(status.config.maxTradesPerHour).toBe(100)
  })

  // ────────────────────────────────────────────
  // initialize
  // ────────────────────────────────────────────

  it('subscribes to activity logger on initialize', async () => {
    const { activityLogger } = await import('../ActivityLogger')
    rm.initialize()
    expect(activityLogger.subscribe).toHaveBeenCalled()
  })

  // ────────────────────────────────────────────
  // Weekly loss limit
  // ────────────────────────────────────────────

  it('rejects when weekly loss exceeded', () => {
    // Set daily limit higher so weekly check fires first
    rm.setConfig({ dailyLossLimit: 100, weeklyLossLimit: 20 })

    // Record losses totaling > $20 (under daily $100 limit)
    rm.recordTradeResult(true, -8)
    rm.recordTradeResult(true, -7)
    rm.recordTradeResult(true, -6) // total = -$21

    const result = rm.validateTrade(5)
    expect(result.allowed).toBe(false)
    expect(['WEEKLY_LOSS_EXCEEDED', 'EMERGENCY_STOPPED']).toContain(result.riskCode)
  })

  it('allows trade within weekly loss limit', () => {
    // Set daily limit higher so weekly check doesn't interfere
    rm.setConfig({ dailyLossLimit: 100, weeklyLossLimit: 50 })

    // Record losses totaling $30 — under $50 weekly limit and $100 daily limit
    rm.recordTradeResult(true, -15)
    rm.recordTradeResult(true, -15)

    const result = rm.validateTrade(5)
    expect(result.allowed).toBe(true)
  })

  it('tracks pnlLast7d in status', () => {
    rm.recordTradeResult(true, 10)
    rm.recordTradeResult(true, -3)
    const status = rm.getStatus()
    expect(status.pnlLast7d).toBe(7)
  })

  // ────────────────────────────────────────────
  // Edge cases
  // ────────────────────────────────────────────

  it('emergency stop is idempotent', () => {
    rm.emergencyStop('first')
    rm.emergencyStop('second')
    expect(rm.getStatus().emergencyReason).toBe('first')
  })

  it('does not reject below failure limit', () => {
    // 4 failures is under the default limit of 5
    for (let i = 0; i < 4; i++) {
      rm.recordTradeResult(false)
    }
    mockWalletState.balance = 100
    mockWalletState.buyingPower = 100
    const result = rm.validateTrade(10)
    expect(result.allowed).toBe(true)
  })


  // ────────────────────────────────────────────
  // Penny Trader Mode
  // ────────────────────────────────────────────

  it('scales daily loss limit in penny mode (trips at $2.40 not $4)', () => {
    mockSettingsState.pennyTraderMode = true
    // Record $3 loss — exceeds penny limit ($4 * 0.6 = $2.40)
    rm.recordTradeResult(true, -3)
    const result = rm.validateTrade(1)
    expect(result.allowed).toBe(false)
    expect(result.riskCode).toBe('DAILY_LOSS_EXCEEDED')
    expect(result.reason).toContain('$2.4')
  })

  it('does NOT scale daily loss limit when penny mode is off', () => {
    mockSettingsState.pennyTraderMode = false
    // Same $2.50 loss — under normal $4 limit
    rm.recordTradeResult(true, -2.50)
    const result = rm.validateTrade(1)
    expect(result.allowed).toBe(true)
  })

  it('scales weekly loss limit in penny mode', () => {
    mockSettingsState.pennyTraderMode = true
    // Record $13 weekly loss — exceeds penny limit ($20 * 0.6 = $12)
    rm.recordTradeResult(true, -13)
    const result = rm.validateTrade(1)
    expect(result.allowed).toBe(false)
  })

  it('getStatus() returns scaled limits in penny mode', () => {
    mockSettingsState.pennyTraderMode = true
    const status = rm.getStatus()
    expect(status.config.dailyLossLimit).toBeCloseTo(2.4) // 4 * 0.6
    expect(status.config.weeklyLossLimit).toBe(12) // 20 * 0.6
  })

  it('getStatus() returns original limits when penny mode is off', () => {
    mockSettingsState.pennyTraderMode = false
    const status = rm.getStatus()
    expect(status.config.dailyLossLimit).toBe(4)
    expect(status.config.weeklyLossLimit).toBe(20)
  })

  // ==================================================
  // PORTFOLIO CORRELATION GATE
  // ==================================================

  describe('correlation-aware asset exposure', () => {
    it('allows trade when single strategy has low exposure', () => {
      rm.recordAssetExposure('BTC', 'btc', 10)
      const check = rm.checkAssetConcentration('BTC', 5)
      // 1 strategy on BTC → 60% cap → $15/$100 = 15% → allowed
      expect(check.allowed).toBe(true)
    })

    it('tightens cap to 45% when two strategies are on the same asset', () => {
      rm.recordAssetExposure('BTC', 'btc', 20)
      rm.recordAssetExposure('BTC', 'impulse', 20)
      // 2 strategies → 45% cap → ($40 + $6)/$100 = 46% → blocked
      const check = rm.checkAssetConcentration('BTC', 6)
      expect(check.allowed).toBe(false)
      expect(check.riskCode).toBe('CORRELATED_EXPOSURE')
      expect(check.reason).toContain('2 strategies')
    })

    it('tightens cap to 35% when three+ strategies pile on', () => {
      rm.recordAssetExposure('BTC', 'btc', 10)
      rm.recordAssetExposure('BTC', 'impulse', 10)
      rm.recordAssetExposure('BTC', 'liquidation', 10)
      // 3 strategies → 35% cap → ($30 + $6)/$100 = 36% → blocked
      const check = rm.checkAssetConcentration('BTC', 6)
      expect(check.allowed).toBe(false)
      expect(check.reason).toContain('3 strategies')
    })

    it('allows trade just under the dynamic cap', () => {
      rm.recordAssetExposure('BTC', 'btc', 10)
      rm.recordAssetExposure('BTC', 'impulse', 10)
      rm.recordAssetExposure('BTC', 'liquidation', 10)
      // 3 strategies → 35% cap → ($30 + $4)/$100 = 34% → allowed
      const check = rm.checkAssetConcentration('BTC', 4)
      expect(check.allowed).toBe(true)
    })

    it('reduces exposure when positions close', () => {
      rm.recordAssetExposure('BTC', 'btc', 20)
      rm.recordAssetExposure('BTC', 'impulse', 20)
      // 2 strategies → 45% cap → $40 + $6 = 46% → blocked
      expect(rm.checkAssetConcentration('BTC', 6).allowed).toBe(false)

      // Close impulse position → back to 1 strategy
      rm.reduceAssetExposure('BTC', 'impulse', 20)
      // 1 strategy → 60% cap → $20 + $6 = 26% → allowed
      expect(rm.checkAssetConcentration('BTC', 6).allowed).toBe(true)
    })

    it('tracks different assets independently', () => {
      rm.recordAssetExposure('BTC', 'btc', 30)
      rm.recordAssetExposure('BTC', 'impulse', 10)
      // BTC: 2 strategies → 45% cap → $40 + $5 = 45% → allowed (exactly at cap)
      expect(rm.checkAssetConcentration('BTC', 5).allowed).toBe(true)

      // ETH: 0 existing → 1 strategy → 60% cap → $10/$100 = 10% → allowed
      expect(rm.checkAssetConcentration('ETH', 10).allowed).toBe(true)
    })

    it('integrates into validateTrade when asset is provided', () => {
      rm.recordAssetExposure('BTC', 'btc', 20)
      rm.recordAssetExposure('BTC', 'impulse', 15)
      rm.recordAssetExposure('BTC', 'liquidation', 5)

      // 3 strategies → 35% cap → ($40 + $5)/$100 = 45% → blocked
      const result = rm.validateTrade(5, 'some-market', undefined, 'BTC', 'gabagool')
      expect(result.allowed).toBe(false)
      expect(result.riskCode).toBe('CORRELATED_EXPOSURE')
    })

    it('validateTrade passes when asset is not provided (backward compatible)', () => {
      // No asset → correlation check is skipped entirely
      const result = rm.validateTrade(5, 'some-market')
      expect(result.allowed).toBe(true)
    })

    it('blocks per-strategy concentration at 40%', () => {
      rm.recordAssetExposure('BTC', 'btc', 35)
      // Single strategy already at $35 → $35 + $6 = $41 = 41% > 40% per-strategy cap
      const result = rm.validateTrade(6, 'some-market', undefined, 'BTC', 'btc')
      expect(result.allowed).toBe(false)
      expect(result.riskCode).toBe('CORRELATED_EXPOSURE')
      expect(result.reason).toContain('btc')
      expect(result.reason).toContain('concentration')
    })
  })
})
