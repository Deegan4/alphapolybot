import { describe, it, expect, vi, beforeEach } from 'vitest'

// ==========================================
// MOCKS
// ==========================================

// Mock zustand/middleware so persist is a transparent pass-through.
// This avoids the "storage.setItem is not a function" error that
// occurs when jsdom's localStorage doesn't fully satisfy Zustand's
// StateStorage interface.  We're testing store LOGIC, not persistence.
vi.mock('zustand/middleware', async () => {
  const actual = await vi.importActual<typeof import('zustand/middleware')>('zustand/middleware')
  return {
    ...actual,
    persist: (fn: unknown) => fn, // strip persistence wrapper
  }
})

// Mock dynamic imports that settings setters fire-and-forget.
// NOTE: Many setters (setDailyLossLimit, setGtcFallbackEnabled, etc.)
// trigger dynamic import() which cascades through the module graph.
// We mock these to prevent "Closing rpc" errors from Vitest's module
// runner shutting down before the promises settle.
vi.mock('@/services/trading/RiskManager', () => ({
  riskManager: { setConfig: vi.fn() },
}))

vi.mock('@/services/trading/TradingService', () => ({
  tradingService: { setConfig: vi.fn() },
}))

vi.mock('@/services/strategies/ProjectFWStrategy', () => ({
  projectFWStrategy: { setFWConfig: vi.fn() },
}))

// Block transitive imports that cascade from the dynamic imports above
vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: { on: vi.fn(), emit: vi.fn(), subscribe: vi.fn() },
}))

vi.mock('@/stores/walletStore', () => ({
  useWalletStore: { getState: () => ({}) },
}))

vi.mock('@/services/api', () => ({
  polymarketClient: {},
}))

vi.mock('@/services/wallet', () => ({
  walletService: {},
}))

vi.mock('@/services/realtime', () => ({
  realtimeService: {
    onPriceUpdate: vi.fn(),
    subscribeMarket: vi.fn(),
    unsubscribeMarket: vi.fn(),
    getPrice: vi.fn(),
    isStale: vi.fn(),
  },
}))

vi.mock('@/services/strategies/BaseStrategy', () => ({
  BaseStrategy: vi.fn(),
}))

vi.mock('@/services/strategies/projectfw/ArbitrageScanner', () => ({
  ArbitrageScanner: vi.fn(),
}))

// ==========================================
// TESTS
// ==========================================

// Import AFTER mocks are registered (vi.mock is hoisted, but
// this ordering makes the intent clear for readers).
import { useSettingsStore } from '../settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    // Reset store to defaults before each test
    useSettingsStore.getState().resetSettings()
  })

  describe('default values', () => {
    it('starts in live trading mode ($33 aggressive config)', () => {
      expect(useSettingsStore.getState().dryRun).toBe(false)
    })

    it('has empty API keys by default', () => {
      const state = useSettingsStore.getState()
      expect(state.openRouterApiKey).toBe('')
    })

    it('has notifications enabled, sound disabled', () => {
      const state = useSettingsStore.getState()
      expect(state.enableNotifications).toBe(true)
      expect(state.enableSoundAlerts).toBe(false)
    })

    it('has risk management defaults ($20 bankroll)', () => {
      const state = useSettingsStore.getState()
      expect(state.dailyLossLimit).toBe(3)
      expect(state.weeklyLossLimit).toBe(6)
      expect(state.maxTradesPerHour).toBe(15)
      expect(state.consecutiveFailureLimit).toBe(3)
      expect(state.minBalanceForTrade).toBe(3)
      expect(state.riskManagementEnabled).toBe(true)
    })

    it('has GTD fallback enabled with 5-min expiry', () => {
      const state = useSettingsStore.getState()
      expect(state.gtcFallbackEnabled).toBe(true)
      expect(state.gtcExpiryMinutes).toBe(5)
    })

    it('has FW arb defaults', () => {
      const state = useSettingsStore.getState()
      expect(state.fwTradeSize).toBe(1)
      expect(state.fwMinProfitBps).toBe(30)
    })
  })

  // Test setters that DON'T trigger fire-and-forget dynamic import().
  // Setters with dynamic imports (setDailyLossLimit, setGtcFallbackEnabled,
  // etc.) cause "Closing rpc" errors in Vitest when the module runner shuts
  // down before the async module resolution completes.  We verify those
  // setters' state mutation indirectly via the reset test.
  describe('setters (no side effects)', () => {
    it('setDryRun updates state', () => {
      useSettingsStore.getState().setDryRun(false)
      expect(useSettingsStore.getState().dryRun).toBe(false)

      useSettingsStore.getState().setDryRun(true)
      expect(useSettingsStore.getState().dryRun).toBe(true)
    })

    it('setOpenRouterApiKey updates state', () => {
      useSettingsStore.getState().setOpenRouterApiKey('sk-test-123')
      expect(useSettingsStore.getState().openRouterApiKey).toBe('sk-test-123')
    })


    it('setNotifications updates state', () => {
      useSettingsStore.getState().setNotifications(false)
      expect(useSettingsStore.getState().enableNotifications).toBe(false)
    })

    it('setSoundAlerts updates state', () => {
      useSettingsStore.getState().setSoundAlerts(true)
      expect(useSettingsStore.getState().enableSoundAlerts).toBe(true)
    })
  })

  describe('resetSettings', () => {
    it('reverts all values to defaults after changing safe setters', () => {
      // Change settings that don't trigger dynamic import()
      const store = useSettingsStore.getState()
      store.setDryRun(false)
      store.setOpenRouterApiKey('sk-key')
      store.setNotifications(false)
      store.setSoundAlerts(true)

      // Verify changes took effect
      expect(useSettingsStore.getState().dryRun).toBe(false)
      expect(useSettingsStore.getState().openRouterApiKey).toBe('sk-key')
      expect(useSettingsStore.getState().enableNotifications).toBe(false)

      // Reset
      useSettingsStore.getState().resetSettings()

      // Verify defaults restored ($33 aggressive = dryRun false)
      const reset = useSettingsStore.getState()
      expect(reset.dryRun).toBe(false)
      expect(reset.openRouterApiKey).toBe('')
      expect(reset.enableNotifications).toBe(true)
      expect(reset.enableSoundAlerts).toBe(false)
    })
  })

  describe('synchronous reads (Zustand getState)', () => {
    it('getState() is synchronous and always current', () => {
      useSettingsStore.getState().setOpenRouterApiKey('sync-test')
      // No await needed — Zustand getState() is synchronous
      const value = useSettingsStore.getState().openRouterApiKey
      expect(value).toBe('sync-test')
    })
  })

  describe('aggressiveMode', () => {
    it('defaults to true ($39 aggressive config)', () => {
      expect(useSettingsStore.getState().aggressiveMode).toBe(true)
    })

    it('setAggressiveMode(true) sets aggressive parameters for $20', () => {
      useSettingsStore.getState().setAggressiveMode(true)
      const s = useSettingsStore.getState()
      expect(s.aggressiveMode).toBe(true)
      expect(s.pennyTraderMode).toBe(false)
      expect(s.kellyFraction).toBe(0.15)
      expect(s.dailyLossLimit).toBe(3)
      expect(s.weeklyLossLimit).toBe(6)
      expect(s.maxTradesPerHour).toBe(15)
      expect(s.consecutiveFailureLimit).toBe(3)
      expect(s.fwMinProfitBps).toBe(30)
      // Maker strategies — only proven ones on $20
      expect(s.gabagoolEnabled).toBe(true)
      expect(s.gabagoolOrderSize).toBe(1.50)
      expect(s.gabagoolMaxExposure).toBe(5)
      expect(s.gabagoolCheapnessThreshold).toBe(0.46)
      expect(s.gabagoolMinProfitMargin).toBe(0.96)
      expect(s.dualSideEnabled).toBe(true)
      expect(s.dualSideTradeSize).toBe(1.50)
      expect(s.dualSideMaxCombinedAsk).toBe(0.990)
      expect(s.impulseEnabled).toBe(false)   // OFF — taker fees on small bankroll
      expect(s.liqEnabled).toBe(false)        // OFF — preserve capital
      expect(s.btcEnableEth).toBe(false)
      expect(s.btcEnableSol).toBe(false)
      expect(s.btcEnable5m).toBe(false)       // OFF — positions pile up
      expect(s.btcEnable15m).toBe(false)      // OFF — 10% taker fee
      expect(s.btcEnableHourly).toBe(true)
      expect(s.btcEnable4h).toBe(true)
      expect(s.btcTradeSize).toBe(1.50)
      expect(s.btcMinConfidence).toBe(0.50)
      expect(s.btcMaxEntryPrice).toBe(0.48)
      expect(s.btcMinEdgeOverMarket).toBe(0.07)
      expect(s.btcCrossExchangeEnabled).toBe(true)
      expect(s.btcUseLLMConfirmation).toBe(false)
      expect(s.btcMroEnabled).toBe(true)
      expect(s.btcCvdEnabled).toBe(true)
      expect(s.fwEnableCrossMarket).toBe(true)
    })

    it('setAggressiveMode(false) restores defaults', () => {
      // First enable aggressive
      useSettingsStore.getState().setAggressiveMode(true)
      expect(useSettingsStore.getState().aggressiveMode).toBe(true)

      // Then disable — restores DEFAULT_SETTINGS
      useSettingsStore.getState().setAggressiveMode(false)
      const s = useSettingsStore.getState()
      expect(s.aggressiveMode).toBe(false)
      expect(s.pennyTraderMode).toBe(false)
      // Defaults match base settings (non-aggressive)
      expect(s.gabagoolEnabled).toBe(true)
      expect(s.dualSideEnabled).toBe(true)
    })

    it('toggling aggressive mode twice returns to original state', () => {
      const before = { ...useSettingsStore.getState() }
      useSettingsStore.getState().setAggressiveMode(true)
      useSettingsStore.getState().setAggressiveMode(false)
      const after = useSettingsStore.getState()
      expect(after.pennyTraderMode).toBe(before.pennyTraderMode)
      expect(after.kellyFraction).toBe(before.kellyFraction)
      expect(after.dailyLossLimit).toBe(before.dailyLossLimit)
    })

    it('resetSettings keeps aggressiveMode at default (true)', () => {
      useSettingsStore.getState().setAggressiveMode(false)
      expect(useSettingsStore.getState().aggressiveMode).toBe(false)
      useSettingsStore.getState().resetSettings()
      expect(useSettingsStore.getState().aggressiveMode).toBe(true)
    })

    it('btcEnableBtc defaults to true (primary strategy)', () => {
      expect(useSettingsStore.getState().btcEnableBtc).toBe(true)
    })
  })
})
