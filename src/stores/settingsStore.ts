import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AppSettingsState {
  // Trading Mode
  dryRun: boolean
  pennyTraderMode: boolean

  // API Keys (stored encrypted via secureStorage in production)
  openRouterApiKey: string

  // Polymarket CLOB API credentials (from Builder Codes)
  clobApiKey: string
  clobSecret: string
  clobPassphrase: string

  // Notifications
  enableNotifications: boolean
  enableSoundAlerts: boolean

  // Risk Management
  dailyLossLimit: number
  weeklyLossLimit: number
  maxTradesPerHour: number
  consecutiveFailureLimit: number
  minBalanceForTrade: number
  minMaticForGas: number
  riskManagementEnabled: boolean

  // GTD Fallback
  gtcFallbackEnabled: boolean
  gtcExpiryMinutes: number

  // Kelly Criterion position sizing
  kellyFraction: number // 0.0–1.0 (default 0.25 = quarter Kelly)

  // ProjectFW Arb (persisted across reloads)
  fwTradeSize: number
  fwMinProfitBps: number
  fwEnableCrossMarket: boolean
  fwCrossMarketBudgetUSD: number

  // BTC Up/Down Strategy
  btcEnableBtc: boolean
  btcEnableEth: boolean
  btcEnableSol: boolean
  btcTradeSize: number
  btcUseKellySizing: boolean
  btcMinConfidence: number
  btcMaxEntryPrice: number
  btcMinWindowRemaining: number
  btcStopLossPercent: number
  btcTakeProfitPercent: number

  // Aggressive Mode (meta-toggle — relaxes conservative defaults)
  aggressiveMode: boolean

  // Microstructure Momentum Strategy
  microMinCompositeSignal: number
  microMinSignalConfidence: number
  microMaxSpreadFraction: number
  microTradeSize: number
  microStopLossPercent: number
  microTakeProfitPercent: number
}

interface SettingsStore extends AppSettingsState {
  // Actions
  setDryRun: (enabled: boolean) => void
  setOpenRouterApiKey: (key: string) => void
  setClobApiKey: (key: string) => void
  setClobSecret: (secret: string) => void
  setClobPassphrase: (passphrase: string) => void
  setNotifications: (enabled: boolean) => void
  setSoundAlerts: (enabled: boolean) => void
  setDailyLossLimit: (limit: number) => void
  setWeeklyLossLimit: (limit: number) => void
  setMaxTradesPerHour: (limit: number) => void
  setConsecutiveFailureLimit: (limit: number) => void
  setMinBalanceForTrade: (amount: number) => void
  setMinMaticForGas: (amount: number) => void
  setRiskManagementEnabled: (enabled: boolean) => void
  setGtcFallbackEnabled: (enabled: boolean) => void
  setGtcExpiryMinutes: (minutes: number) => void
  setKellyFraction: (fraction: number) => void
  setFwTradeSize: (size: number) => void
  setFwMinProfitBps: (bps: number) => void
  setFwEnableCrossMarket: (enabled: boolean) => void
  setFwCrossMarketBudgetUSD: (budget: number) => void
  setPennyTraderMode: (enabled: boolean) => void
  setBtcEnableBtc: (enabled: boolean) => void
  setBtcEnableEth: (enabled: boolean) => void
  setBtcEnableSol: (enabled: boolean) => void
  setBtcTradeSize: (size: number) => void
  setBtcUseKellySizing: (enabled: boolean) => void
  setBtcMinConfidence: (confidence: number) => void
  setBtcMaxEntryPrice: (price: number) => void
  setBtcMinWindowRemaining: (seconds: number) => void
  setBtcStopLossPercent: (percent: number) => void
  setBtcTakeProfitPercent: (percent: number) => void
  setMicroMinCompositeSignal: (value: number) => void
  setMicroMinSignalConfidence: (value: number) => void
  setMicroMaxSpreadFraction: (value: number) => void
  setMicroTradeSize: (size: number) => void
  setMicroStopLossPercent: (percent: number) => void
  setMicroTakeProfitPercent: (percent: number) => void
  setAggressiveMode: (enabled: boolean) => void
  resetSettings: () => void
}

const DEFAULT_SETTINGS: AppSettingsState = {
  dryRun: true, // SAFE DEFAULT: Always start in dry run mode
  pennyTraderMode: true,
  openRouterApiKey: '',
  clobApiKey: '',
  clobSecret: '',
  clobPassphrase: '',
  enableNotifications: true,
  enableSoundAlerts: false,
  dailyLossLimit: 4,
  weeklyLossLimit: 20,
  maxTradesPerHour: 20,
  consecutiveFailureLimit: 5,
  minBalanceForTrade: 1.50,
  minMaticForGas: 0.01,
  riskManagementEnabled: true,
  gtcFallbackEnabled: true,
  gtcExpiryMinutes: 5,
  kellyFraction: 0.25,
  fwTradeSize: 3,
  fwMinProfitBps: 50,
  fwEnableCrossMarket: false,
  fwCrossMarketBudgetUSD: 0.50,
  btcEnableBtc: false, // Disabled by default — 5-factor formula rarely fires
  btcEnableEth: false,
  btcEnableSol: false,
  btcTradeSize: 2.0,
  btcUseKellySizing: true,
  btcMinConfidence: 0.40,
  btcMaxEntryPrice: 0.75,
  btcMinWindowRemaining: 300,
  btcStopLossPercent: 0.25,
  btcTakeProfitPercent: 0.20,
  aggressiveMode: false,
  microMinCompositeSignal: 0.4,
  microMinSignalConfidence: 0.5,
  microMaxSpreadFraction: 0.08,
  microTradeSize: 2.0,
  microStopLossPercent: 0.15,
  microTakeProfitPercent: 0.20,
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,

      setDryRun: (enabled: boolean) => {
        console.log(`[Settings] Dry run mode ${enabled ? 'ENABLED' : 'DISABLED'}`)
        set({ dryRun: enabled })
      },

      setOpenRouterApiKey: (key: string) => {
        set({ openRouterApiKey: key })
      },

      setClobApiKey: (key: string) => {
        set({ clobApiKey: key })
      },
      setClobSecret: (secret: string) => {
        set({ clobSecret: secret })
      },
      setClobPassphrase: (passphrase: string) => {
        set({ clobPassphrase: passphrase })
      },

      setNotifications: (enabled: boolean) => {
        set({ enableNotifications: enabled })
      },

      setSoundAlerts: (enabled: boolean) => {
        set({ enableSoundAlerts: enabled })
      },

      setDailyLossLimit: (limit: number) => {
        set({ dailyLossLimit: limit })
        import('@/services/trading/RiskManager').then(m => m.riskManager.setConfig({ dailyLossLimit: limit }))
      },

      setWeeklyLossLimit: (limit: number) => {
        set({ weeklyLossLimit: limit })
        import('@/services/trading/RiskManager').then(m => m.riskManager.setConfig({ weeklyLossLimit: limit }))
      },

      setMaxTradesPerHour: (limit: number) => {
        set({ maxTradesPerHour: limit })
        import('@/services/trading/RiskManager').then(m => m.riskManager.setConfig({ maxTradesPerHour: limit }))
      },

      setConsecutiveFailureLimit: (limit: number) => {
        set({ consecutiveFailureLimit: limit })
        import('@/services/trading/RiskManager').then(m => m.riskManager.setConfig({ consecutiveFailureLimit: limit }))
      },

      setMinBalanceForTrade: (amount: number) => {
        set({ minBalanceForTrade: amount })
        import('@/services/trading/RiskManager').then(m => m.riskManager.setConfig({ minBalanceForTrade: amount }))
      },

      setMinMaticForGas: (amount: number) => {
        set({ minMaticForGas: amount })
        import('@/services/trading/RiskManager').then(m => m.riskManager.setConfig({ minMaticForGas: amount }))
      },

      setRiskManagementEnabled: (enabled: boolean) => {
        set({ riskManagementEnabled: enabled })
        import('@/services/trading/RiskManager').then(m => m.riskManager.setConfig({ enabled }))
      },

      setGtcFallbackEnabled: (enabled: boolean) => {
        set({ gtcFallbackEnabled: enabled })
        import('@/services/trading/TradingService').then(m => m.tradingService.setConfig({ gtcFallbackEnabled: enabled }))
      },

      setGtcExpiryMinutes: (minutes: number) => {
        set({ gtcExpiryMinutes: minutes })
        import('@/services/trading/TradingService').then(m => m.tradingService.setConfig({ gtcExpiryMs: minutes * 60 * 1000 }))
      },

      setKellyFraction: (fraction: number) => {
        set({ kellyFraction: Math.max(0, Math.min(1, fraction)) })
      },

      setFwTradeSize: (size: number) => {
        set({ fwTradeSize: size })
        import('@/services/strategies/ProjectFWStrategy').then(m => m.projectFWStrategy.setFWConfig({ tradeSize: size }))
      },

      setFwMinProfitBps: (bps: number) => {
        set({ fwMinProfitBps: bps })
        import('@/services/strategies/ProjectFWStrategy').then(m => m.projectFWStrategy.setFWConfig({ minProfitBps: bps }))
      },

      setFwEnableCrossMarket: (enabled: boolean) => {
        set({ fwEnableCrossMarket: enabled })
        import('@/services/strategies/ProjectFWStrategy').then(m => m.projectFWStrategy.setFWConfig({ enableCrossMarket: enabled }))
      },

      setFwCrossMarketBudgetUSD: (budget: number) => {
        set({ fwCrossMarketBudgetUSD: budget })
        import('@/services/strategies/ProjectFWStrategy').then(m => m.projectFWStrategy.setFWConfig({ crossMarketBudgetUSD: budget }))
      },

      setPennyTraderMode: (enabled: boolean) => {
        console.log(`[Settings] Penny Trader Mode ${enabled ? 'ENABLED' : 'DISABLED'}`)
        set({ pennyTraderMode: enabled })
      },

      setBtcEnableBtc: (enabled: boolean) => {
        set({ btcEnableBtc: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enableBtc: enabled }))
      },
      setBtcEnableEth: (enabled: boolean) => {
        set({ btcEnableEth: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enableEth: enabled }))
      },
      setBtcEnableSol: (enabled: boolean) => {
        set({ btcEnableSol: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enableSol: enabled }))
      },
      setBtcTradeSize: (size: number) => {
        set({ btcTradeSize: size })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ tradeSize: size }))
      },
      setBtcUseKellySizing: (enabled: boolean) => {
        set({ btcUseKellySizing: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ useKellySizing: enabled }))
      },
      setBtcMinConfidence: (confidence: number) => {
        set({ btcMinConfidence: confidence })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ minConfidence: confidence }))
      },
      setBtcMaxEntryPrice: (price: number) => {
        set({ btcMaxEntryPrice: price })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ maxEntryPrice: price }))
      },
      setBtcMinWindowRemaining: (seconds: number) => {
        set({ btcMinWindowRemaining: seconds })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ minWindowRemaining: seconds }))
      },
      setBtcStopLossPercent: (percent: number) => {
        set({ btcStopLossPercent: percent })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ stopLossPercent: percent }))
      },
      setBtcTakeProfitPercent: (percent: number) => {
        set({ btcTakeProfitPercent: percent })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ takeProfitPercent: percent }))
      },

      setMicroMinCompositeSignal: (value: number) => {
        set({ microMinCompositeSignal: value })
        import('@/services/strategies/MicrostructureMomentumStrategy').then(m => m.microMomentumStrategy.setMicroConfig({ minCompositeSignal: value }))
      },
      setMicroMinSignalConfidence: (value: number) => {
        set({ microMinSignalConfidence: value })
        import('@/services/strategies/MicrostructureMomentumStrategy').then(m => m.microMomentumStrategy.setMicroConfig({ minSignalConfidence: value }))
      },
      setMicroMaxSpreadFraction: (value: number) => {
        set({ microMaxSpreadFraction: value })
        import('@/services/strategies/MicrostructureMomentumStrategy').then(m => m.microMomentumStrategy.setMicroConfig({ maxSpreadFraction: value }))
      },
      setMicroTradeSize: (size: number) => {
        set({ microTradeSize: size })
        import('@/services/strategies/MicrostructureMomentumStrategy').then(m => m.microMomentumStrategy.setMicroConfig({ tradeSize: size }))
      },
      setMicroStopLossPercent: (percent: number) => {
        set({ microStopLossPercent: percent })
        import('@/services/strategies/MicrostructureMomentumStrategy').then(m => m.microMomentumStrategy.setMicroConfig({ stopLossPercent: percent }))
      },
      setMicroTakeProfitPercent: (percent: number) => {
        set({ microTakeProfitPercent: percent })
        import('@/services/strategies/MicrostructureMomentumStrategy').then(m => m.microMomentumStrategy.setMicroConfig({ takeProfitPercent: percent }))
      },

      setAggressiveMode: (enabled: boolean) => {
        console.log(`[Settings] Aggressive mode ${enabled ? 'ENABLED' : 'DISABLED'}`)
        set({ aggressiveMode: enabled })

        if (enabled) {
          // Batch-apply aggressive overrides (does NOT touch dryRun — that's separate)
          set({
            pennyTraderMode: false,
            kellyFraction: 0.40,
            dailyLossLimit: 25,
            weeklyLossLimit: 100,
            maxTradesPerHour: 40,
            consecutiveFailureLimit: 8,
            microMinCompositeSignal: 0.30,
            fwMinProfitBps: 30,
          })
          // Push to singletons via dynamic imports (same pattern as individual setters)
          import('@/services/trading/RiskManager').then(m => m.riskManager.setConfig({
            dailyLossLimit: 25,
            weeklyLossLimit: 100,
            maxTradesPerHour: 40,
            consecutiveFailureLimit: 8,
          })).catch(() => {})
          import('@/services/strategies/ProjectFWStrategy').then(m => m.projectFWStrategy.setFWConfig({
            minProfitBps: 30,
          })).catch(() => {})
          import('@/services/strategies/MicrostructureMomentumStrategy').then(m => m.microMomentumStrategy.setMicroConfig({
            minCompositeSignal: 0.30,
          })).catch(() => {})
        } else {
          // Restore conservative defaults
          set({
            pennyTraderMode: DEFAULT_SETTINGS.pennyTraderMode,
            kellyFraction: DEFAULT_SETTINGS.kellyFraction,
            dailyLossLimit: DEFAULT_SETTINGS.dailyLossLimit,
            weeklyLossLimit: DEFAULT_SETTINGS.weeklyLossLimit,
            maxTradesPerHour: DEFAULT_SETTINGS.maxTradesPerHour,
            consecutiveFailureLimit: DEFAULT_SETTINGS.consecutiveFailureLimit,
            microMinCompositeSignal: DEFAULT_SETTINGS.microMinCompositeSignal,
            fwMinProfitBps: DEFAULT_SETTINGS.fwMinProfitBps,
          })
          import('@/services/trading/RiskManager').then(m => m.riskManager.setConfig({
            dailyLossLimit: DEFAULT_SETTINGS.dailyLossLimit,
            weeklyLossLimit: DEFAULT_SETTINGS.weeklyLossLimit,
            maxTradesPerHour: DEFAULT_SETTINGS.maxTradesPerHour,
            consecutiveFailureLimit: DEFAULT_SETTINGS.consecutiveFailureLimit,
          })).catch(() => {})
          import('@/services/strategies/ProjectFWStrategy').then(m => m.projectFWStrategy.setFWConfig({
            minProfitBps: DEFAULT_SETTINGS.fwMinProfitBps,
          })).catch(() => {})
          import('@/services/strategies/MicrostructureMomentumStrategy').then(m => m.microMomentumStrategy.setMicroConfig({
            minCompositeSignal: DEFAULT_SETTINGS.microMinCompositeSignal,
          })).catch(() => {})
        }
      },

      resetSettings: () => {
        set(DEFAULT_SETTINGS)
      },
    }),
    {
      name: 'alphapolybot-settings',
      version: 8, // Bump when defaults change — triggers migrate()
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>
        if (version < 1) {
          // v0→v1: Lower minBalanceForTrade from $1 to $0.50
          if (state.minBalanceForTrade === 1) {
            state.minBalanceForTrade = 0.50
          }
          if (state.gtcFallbackEnabled === undefined) {
            state.gtcFallbackEnabled = true
          }
          if (state.gtcExpiryMinutes === undefined) {
            state.gtcExpiryMinutes = 5
          }
        }
        if (version < 2) {
          // v1→v2: Add penny trader mode
          if (state.pennyTraderMode === undefined) {
            state.pennyTraderMode = false
          }
        }
        if (version < 3) {
          // v2→v3: Enable penny mode, tighten risk limits for small accounts
          state.pennyTraderMode = true
          state.dailyLossLimit = 4
          state.weeklyLossLimit = 20
          state.minBalanceForTrade = 1.5
        }
        if (version < 4) {
          // v3→v4: Add cross-market analysis defaults
          if (state.fwEnableCrossMarket === undefined) {
            state.fwEnableCrossMarket = false
          }
          if (state.fwCrossMarketBudgetUSD === undefined) {
            state.fwCrossMarketBudgetUSD = 0.50
          }
        }
        if (version < 5) {
          // v4→v5: Add Kelly Criterion position sizing
          if (state.kellyFraction === undefined) {
            state.kellyFraction = 0.25
          }
        }
        if (version < 6) {
          // v5→v6: Add BTC Up/Down strategy defaults
          if (state.btcEnableBtc === undefined) state.btcEnableBtc = true
          if (state.btcEnableEth === undefined) state.btcEnableEth = false
          if (state.btcEnableSol === undefined) state.btcEnableSol = false
          if (state.btcTradeSize === undefined) state.btcTradeSize = 2.0
          if (state.btcUseKellySizing === undefined) state.btcUseKellySizing = true
          if (state.btcMinConfidence === undefined) state.btcMinConfidence = 0.65
          if (state.btcMaxEntryPrice === undefined) state.btcMaxEntryPrice = 0.70
          if (state.btcMinWindowRemaining === undefined) state.btcMinWindowRemaining = 300
          if (state.btcStopLossPercent === undefined) state.btcStopLossPercent = 0.25
          if (state.btcTakeProfitPercent === undefined) state.btcTakeProfitPercent = 0.20
        }
        if (version < 7) {
          // v6→v7: Lower BTC thresholds for multi-factor signal, add Micro Momentum strategy
          if (state.btcMinConfidence === 0.65) state.btcMinConfidence = 0.55
          if (state.btcMaxEntryPrice === 0.70) state.btcMaxEntryPrice = 0.75
          if (state.microMinCompositeSignal === undefined) state.microMinCompositeSignal = 0.4
          if (state.microMinSignalConfidence === undefined) state.microMinSignalConfidence = 0.5
          if (state.microMaxSpreadFraction === undefined) state.microMaxSpreadFraction = 0.08
          if (state.microTradeSize === undefined) state.microTradeSize = 2.0
          if (state.microStopLossPercent === undefined) state.microStopLossPercent = 0.15
          if (state.microTakeProfitPercent === undefined) state.microTakeProfitPercent = 0.20
        }
        if (version < 8) {
          // v7→v8: Add aggressive mode, disable BTC by default
          if (state.aggressiveMode === undefined) state.aggressiveMode = false
          // BTC strategy rarely fires — disable for new and migrating users
          if (state.btcEnableBtc === true && state.btcMinConfidence === 0.55) {
            // Only flip users who never manually adjusted (still at v7 migration default)
            state.btcEnableBtc = false
          }
        }
        return state as AppSettingsState
      },
      partialize: (state) => ({
        dryRun: state.dryRun,
        openRouterApiKey: state.openRouterApiKey,
        clobApiKey: state.clobApiKey,
        clobSecret: state.clobSecret,
        clobPassphrase: state.clobPassphrase,
        enableNotifications: state.enableNotifications,
        enableSoundAlerts: state.enableSoundAlerts,
        dailyLossLimit: state.dailyLossLimit,
        weeklyLossLimit: state.weeklyLossLimit,
        maxTradesPerHour: state.maxTradesPerHour,
        consecutiveFailureLimit: state.consecutiveFailureLimit,
        minBalanceForTrade: state.minBalanceForTrade,
        minMaticForGas: state.minMaticForGas,
        riskManagementEnabled: state.riskManagementEnabled,
        gtcFallbackEnabled: state.gtcFallbackEnabled,
        gtcExpiryMinutes: state.gtcExpiryMinutes,
        kellyFraction: state.kellyFraction,
        fwTradeSize: state.fwTradeSize,
        fwMinProfitBps: state.fwMinProfitBps,
        fwEnableCrossMarket: state.fwEnableCrossMarket,
        fwCrossMarketBudgetUSD: state.fwCrossMarketBudgetUSD,
        pennyTraderMode: state.pennyTraderMode,
        btcEnableBtc: state.btcEnableBtc,
        btcEnableEth: state.btcEnableEth,
        btcEnableSol: state.btcEnableSol,
        btcTradeSize: state.btcTradeSize,
        btcUseKellySizing: state.btcUseKellySizing,
        btcMinConfidence: state.btcMinConfidence,
        btcMaxEntryPrice: state.btcMaxEntryPrice,
        btcMinWindowRemaining: state.btcMinWindowRemaining,
        btcStopLossPercent: state.btcStopLossPercent,
        btcTakeProfitPercent: state.btcTakeProfitPercent,
        aggressiveMode: state.aggressiveMode,
        microMinCompositeSignal: state.microMinCompositeSignal,
        microMinSignalConfidence: state.microMinSignalConfidence,
        microMaxSpreadFraction: state.microMaxSpreadFraction,
        microTradeSize: state.microTradeSize,
        microStopLossPercent: state.microStopLossPercent,
        microTakeProfitPercent: state.microTakeProfitPercent,
      }),
    }
  )
)
