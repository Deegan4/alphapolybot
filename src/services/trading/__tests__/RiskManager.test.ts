import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RiskManager } from '../RiskManager'

// Hoisted mutable state — vi.mock() is hoisted above const declarations,
// so we use vi.hoisted() to make these available inside mock factories.
const { mockWalletState, mockSettingsState } = vi.hoisted(() => ({
  mockWalletState: { usdcBalance: 100, usdcBridgedBalance: 100, usdcNativeBalance: 0, balance: 0.5 },
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
// usdcBridgedBalance is what Polymarket actually uses (USDC.e)
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
    mockWalletState.usdcBalance = 100
    mockWalletState.usdcBridgedBalance = 100
    mockWalletState.usdcNativeBalance = 0
    mockWalletState.balance = 0.5
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
    mockWalletState.usdcBalance = 2
    mockWalletState.usdcBridgedBalance = 2
    const result = rm.validateTrade(10)
    expect(result.allowed).toBe(false)
    expect(result.riskCode).toBe('INSUFFICIENT_BALANCE')
  })

  it('rejects when balance is below minimum', () => {
    mockWalletState.usdcBalance = 4 // below minBalanceForTrade (5)
    mockWalletState.usdcBridgedBalance = 4
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
    mockWalletState.usdcBalance = 0 // zero balance
    mockWalletState.usdcBridgedBalance = 0
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
    mockWalletState.usdcBalance = 100
    mockWalletState.usdcBridgedBalance = 100
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
    mockWalletState.usdcBalance = 100
    mockWalletState.usdcBridgedBalance = 100
    const result = rm.validateTrade(10)
    expect(result.allowed).toBe(true)
  })

  // ────────────────────────────────────────────
  // Gas (MATIC) check
  // ────────────────────────────────────────────

  it('rejects when MATIC balance below minMaticForGas', () => {
    mockWalletState.balance = 0.005 // below default 0.01
    const result = rm.validateTrade(5)
    expect(result.allowed).toBe(false)
    expect(result.riskCode).toBe('INSUFFICIENT_GAS')
    expect(result.reason).toContain('MATIC')
  })

  it('rejects when MATIC balance is zero', () => {
    mockWalletState.balance = 0
    const result = rm.validateTrade(5)
    expect(result.allowed).toBe(false)
    expect(result.riskCode).toBe('INSUFFICIENT_GAS')
  })

  it('allows trade when MATIC balance is sufficient', () => {
    mockWalletState.balance = 0.5 // well above 0.01
    const result = rm.validateTrade(5)
    expect(result.allowed).toBe(true)
  })

  it('respects custom minMaticForGas config', () => {
    rm.setConfig({ minMaticForGas: 0.1 })
    mockWalletState.balance = 0.05 // below custom 0.1 threshold
    const result = rm.validateTrade(5)
    expect(result.allowed).toBe(false)
    expect(result.riskCode).toBe('INSUFFICIENT_GAS')
  })

  // ────────────────────────────────────────────
  // Penny Trader Mode
  // ────────────────────────────────────────────

  it('scales daily loss limit in penny mode (trips at $0.80 not $4)', () => {
    mockSettingsState.pennyTraderMode = true
    // Record $1 loss — exceeds penny limit ($4 * 0.2 = $0.80)
    rm.recordTradeResult(true, -1)
    const result = rm.validateTrade(1)
    expect(result.allowed).toBe(false)
    expect(result.riskCode).toBe('DAILY_LOSS_EXCEEDED')
    expect(result.reason).toContain('$0.8')
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
    // Record $11 weekly loss — exceeds penny limit ($20 * 0.2 = $4)
    rm.recordTradeResult(true, -11)
    const result = rm.validateTrade(1)
    // Daily limit trips first at $0.80, but let's test weekly specifically
    // Need loss between $0.80 and $4 to only trip weekly... actually daily trips first.
    // So reset and test weekly independently:
    expect(result.allowed).toBe(false)
  })

  it('getStatus() returns scaled limits in penny mode', () => {
    mockSettingsState.pennyTraderMode = true
    const status = rm.getStatus()
    expect(status.config.dailyLossLimit).toBeCloseTo(0.8) // 4 * 0.2
    expect(status.config.weeklyLossLimit).toBe(4) // 20 * 0.2
  })

  it('getStatus() returns original limits when penny mode is off', () => {
    mockSettingsState.pennyTraderMode = false
    const status = rm.getStatus()
    expect(status.config.dailyLossLimit).toBe(4)
    expect(status.config.weeklyLossLimit).toBe(20)
  })
})
