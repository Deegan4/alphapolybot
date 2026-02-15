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
  btcEnableXrp: boolean
  btcEnable5m: boolean          // Trade 5-minute windows
  btcEnable15m: boolean         // Trade 15-minute windows
  btcEnableHourly: boolean      // Trade hourly windows
  btcEnableDaily: boolean       // Trade daily windows
  btcEnable9pm: boolean         // Trade 9PM ET daily events
  btcTradeSize: number
  btcUseKellySizing: boolean
  btcMinConfidence: number
  btcMaxEntryPrice: number
  btcMinEntryPrice: number
  btcMinWindowRemaining: number
  btcStopLossPercent: number
  btcTakeProfitPercent: number
  btcMinTimeIntoWindowMs: number  // Min ms into window before trading
  btcRegimeFilterEnabled: boolean // Skip choppy markets
  btcRsiFilterEnabled: boolean    // RSI overbought/oversold filter
  btcUseLLMConfirmation: boolean  // LLM confirmation gate on hourly+ windows

  // Aggressive Mode (meta-toggle — relaxes conservative defaults)
  aggressiveMode: boolean

  // LLM Web Search (OpenRouter :online mode)
  llmWebSearchEnabled: boolean

  // Microstructure Momentum Strategy
  microMinCompositeSignal: number
  microMinSignalConfidence: number
  microMaxSpreadFraction: number
  microTradeSize: number
  microStopLossPercent: number
  microTakeProfitPercent: number

  // Follow & Copy Trader
  followedAddress: string
  copyTradeSize: number           // USD per copied trade
  copyMaxConcurrent: number       // Max simultaneous copied positions
  copyPollIntervalMs: number      // Polling frequency (ms)
  copyStopLossPercent: number     // SL for copied positions (0-1)
  copyTakeProfitPercent: number   // TP for copied positions (0-1)
  copyBuysOnly: boolean           // Only copy BUY trades

  // LLM Premium Model Tiering
  llmPremiumModel: string             // e.g. 'openai/gpt-4o' (empty = disabled)
  llmPremiumThreshold: number         // min qualityScore to use premium (default: 25)
  llmPremiumBudgetUSD: number         // daily budget for premium calls (default: $0.50)

  // Crypto LLM Mode
  cryptoLLMEnabled: boolean           // enable crypto-specific LLM scan loop
  cryptoModel: string                 // model for crypto analysis (empty = use default)
  cryptoScanIntervalMs: number        // scan interval for crypto markets (default: 30s)
  cryptoMinConfidence: number         // min confidence for crypto trades (default: 0.55)

  // Coinbase Spot — Mean Reversion Strategy
  coinbaseApiKey: string
  coinbaseSecret: string
  mrEnableBtc: boolean
  mrEnableEth: boolean
  mrEnableSol: boolean
  mrLookbackPeriod: number
  mrEntryZScore: number
  mrExitZScore: number
  mrTradeSize: number
  mrScanIntervalMs: number
  mrStopLossPercent: number
  mrTakeProfitPercent: number
  mrMaxHoldMs: number
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
  setBtcEnable5m: (enabled: boolean) => void
  setBtcEnable15m: (enabled: boolean) => void
  setBtcEnableHourly: (enabled: boolean) => void
  setBtcEnableDaily: (enabled: boolean) => void
  setBtcTradeSize: (size: number) => void
  setBtcUseKellySizing: (enabled: boolean) => void
  setBtcMinConfidence: (confidence: number) => void
  setBtcMaxEntryPrice: (price: number) => void
  setBtcMinEntryPrice: (price: number) => void
  setBtcMinWindowRemaining: (seconds: number) => void
  setBtcStopLossPercent: (percent: number) => void
  setBtcTakeProfitPercent: (percent: number) => void
  setBtcMinTimeIntoWindowMs: (ms: number) => void
  setBtcRegimeFilterEnabled: (enabled: boolean) => void
  setBtcRsiFilterEnabled: (enabled: boolean) => void
  setBtcUseLLMConfirmation: (enabled: boolean) => void
  setLlmWebSearchEnabled: (enabled: boolean) => void
  setMicroMinCompositeSignal: (value: number) => void
  setMicroMinSignalConfidence: (value: number) => void
  setMicroMaxSpreadFraction: (value: number) => void
  setMicroTradeSize: (size: number) => void
  setMicroStopLossPercent: (percent: number) => void
  setMicroTakeProfitPercent: (percent: number) => void
  setAggressiveMode: (enabled: boolean) => void
  setCoinbaseApiKey: (key: string) => void
  setCoinbaseSecret: (secret: string) => void
  setMrEnableBtc: (enabled: boolean) => void
  setMrEnableEth: (enabled: boolean) => void
  setMrEnableSol: (enabled: boolean) => void
  setMrLookbackPeriod: (period: number) => void
  setMrEntryZScore: (z: number) => void
  setMrExitZScore: (z: number) => void
  setMrTradeSize: (size: number) => void
  setMrScanIntervalMs: (ms: number) => void
  setMrStopLossPercent: (percent: number) => void
  setMrTakeProfitPercent: (percent: number) => void
  setMrMaxHoldMs: (ms: number) => void
  setFollowedAddress: (address: string) => void
  setCopyTradeSize: (size: number) => void
  setCopyMaxConcurrent: (max: number) => void
  setCopyPollIntervalMs: (ms: number) => void
  setCopyStopLossPercent: (percent: number) => void
  setCopyTakeProfitPercent: (percent: number) => void
  setCopyBuysOnly: (enabled: boolean) => void
  setLlmPremiumModel: (model: string) => void
  setLlmPremiumThreshold: (threshold: number) => void
  setLlmPremiumBudgetUSD: (budget: number) => void
  setCryptoLLMEnabled: (enabled: boolean) => void
  setCryptoModel: (model: string) => void
  setCryptoScanIntervalMs: (ms: number) => void
  setCryptoMinConfidence: (confidence: number) => void
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
  btcEnableBtc: false, // Disabled by default — enable when ready to trade
  btcEnableEth: false,
  btcEnableSol: false,
  btcEnableXrp: false,
  btcEnable5m: false,  // 5-min windows disabled — lower edge, higher fees, less liquidity
  btcEnable15m: true,  // 15-min windows enabled by default
  btcEnableHourly: false,  // Hourly windows (opt-in)
  btcEnableDaily: false,   // Daily windows (opt-in)
  btcEnable9pm: false,  // 9PM ET daily events (disabled by default — opt-in)
  btcTradeSize: 2.0,
  btcUseKellySizing: true,
  btcMinConfidence: 0.55,    // Higher confidence for selective entries on small bankroll
  btcMaxEntryPrice: 0.45,    // Tight range — with $16 bankroll, selectivity > volume
  btcMinEntryPrice: 0.10,    // Low floor — only reject extreme long-shots
  btcMinWindowRemaining: 120, // 2 min before resolution
  btcStopLossPercent: 0.95,  // Effectively disabled — hold to resolution
  btcTakeProfitPercent: 0.95, // Effectively disabled — hold to resolution
  btcMinTimeIntoWindowMs: 45_000, // 45s into 15m window (auto-scaled for 5m)
  btcRegimeFilterEnabled: true,   // Skip choppy/mean-reverting markets
  btcRsiFilterEnabled: true,      // Reduce confidence on overbought/oversold
  btcUseLLMConfirmation: false,   // LLM confirmation gate (opt-in)
  aggressiveMode: false,
  llmWebSearchEnabled: false,
  microMinCompositeSignal: 0.4,
  microMinSignalConfidence: 0.5,
  microMaxSpreadFraction: 0.08,
  microTradeSize: 2.0,
  microStopLossPercent: 0.15,
  microTakeProfitPercent: 0.20,
  followedAddress: '',
  copyTradeSize: 5,
  copyMaxConcurrent: 5,
  copyPollIntervalMs: 15_000,
  copyStopLossPercent: 0.30,
  copyTakeProfitPercent: 0.50,
  copyBuysOnly: true,
  llmPremiumModel: '',
  llmPremiumThreshold: 25,
  llmPremiumBudgetUSD: 0.50,
  cryptoLLMEnabled: false,
  cryptoModel: '',
  cryptoScanIntervalMs: 30_000,
  cryptoMinConfidence: 0.55,
  coinbaseApiKey: '',
  coinbaseSecret: '',
  mrEnableBtc: false,
  mrEnableEth: false,
  mrEnableSol: false,
  mrLookbackPeriod: 20,
  mrEntryZScore: 2.0,
  mrExitZScore: 0.5,
  mrTradeSize: 10.0,
  mrScanIntervalMs: 10_000,
  mrStopLossPercent: 0.03,
  mrTakeProfitPercent: 0.02,
  mrMaxHoldMs: 3_600_000,
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
      setBtcEnableXrp: (enabled: boolean) => {
        set({ btcEnableXrp: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enableXrp: enabled }))
      },
      setBtcEnable5m: (enabled: boolean) => {
        set({ btcEnable5m: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enable5m: enabled }))
      },
      setBtcEnable15m: (enabled: boolean) => {
        set({ btcEnable15m: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enable15m: enabled }))
      },
      setBtcEnableHourly: (enabled: boolean) => {
        set({ btcEnableHourly: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enableHourly: enabled }))
      },
      setBtcEnableDaily: (enabled: boolean) => {
        set({ btcEnableDaily: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enableDaily: enabled }))
      },
      setBtcEnable9pm: (enabled: boolean) => {
        set({ btcEnable9pm: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enable9pm: enabled }))
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
      setBtcMinEntryPrice: (price: number) => {
        set({ btcMinEntryPrice: price })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ minEntryPrice: price }))
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
      setBtcMinTimeIntoWindowMs: (ms: number) => {
        set({ btcMinTimeIntoWindowMs: ms })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ minTimeIntoWindowMs: ms }))
      },
      setBtcRegimeFilterEnabled: (enabled: boolean) => {
        set({ btcRegimeFilterEnabled: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ regimeFilterEnabled: enabled }))
      },
      setBtcRsiFilterEnabled: (enabled: boolean) => {
        set({ btcRsiFilterEnabled: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ rsiFilterEnabled: enabled }))
      },
      setBtcUseLLMConfirmation: (enabled: boolean) => {
        set({ btcUseLLMConfirmation: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ useLLMConfirmation: enabled }))
      },

      setLlmWebSearchEnabled: (enabled: boolean) => {
        set({ llmWebSearchEnabled: enabled })
        import('@/services/llm/OpenRouterService').then(m => m.openRouterService.setConfig({ webSearchEnabled: enabled }))
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

      setCoinbaseApiKey: (key: string) => {
        set({ coinbaseApiKey: key })
        import('@/services/api/CoinbaseClient').then(m => m.coinbaseClient.setCredentials(key, useSettingsStore.getState().coinbaseSecret))
      },
      setCoinbaseSecret: (secret: string) => {
        set({ coinbaseSecret: secret })
        import('@/services/api/CoinbaseClient').then(m => m.coinbaseClient.setCredentials(useSettingsStore.getState().coinbaseApiKey, secret))
      },
      setMrEnableBtc: (enabled: boolean) => {
        set({ mrEnableBtc: enabled })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ enableBtc: enabled }))
      },
      setMrEnableEth: (enabled: boolean) => {
        set({ mrEnableEth: enabled })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ enableEth: enabled }))
      },
      setMrEnableSol: (enabled: boolean) => {
        set({ mrEnableSol: enabled })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ enableSol: enabled }))
      },
      setMrLookbackPeriod: (period: number) => {
        set({ mrLookbackPeriod: period })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ lookbackPeriod: period }))
      },
      setMrEntryZScore: (z: number) => {
        set({ mrEntryZScore: z })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ entryZScore: z }))
      },
      setMrExitZScore: (z: number) => {
        set({ mrExitZScore: z })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ exitZScore: z }))
      },
      setMrTradeSize: (size: number) => {
        set({ mrTradeSize: size })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ tradeSize: size }))
      },
      setMrScanIntervalMs: (ms: number) => {
        set({ mrScanIntervalMs: ms })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ scanIntervalMs: ms }))
      },
      setMrStopLossPercent: (percent: number) => {
        set({ mrStopLossPercent: percent })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ stopLossPercent: percent }))
      },
      setMrTakeProfitPercent: (percent: number) => {
        set({ mrTakeProfitPercent: percent })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ takeProfitPercent: percent }))
      },
      setMrMaxHoldMs: (ms: number) => {
        set({ mrMaxHoldMs: ms })
        import('@/services/strategies/MeanReversionStrategy').then(m => m.meanReversionStrategy.setMrConfig({ maxHoldMs: ms }))
      },

      setFollowedAddress: (address: string) => {
        set({ followedAddress: address.toLowerCase().trim() })
      },

      setCopyTradeSize: (size: number) => set({ copyTradeSize: size }),
      setCopyMaxConcurrent: (max: number) => set({ copyMaxConcurrent: max }),
      setCopyPollIntervalMs: (ms: number) => set({ copyPollIntervalMs: ms }),
      setCopyStopLossPercent: (percent: number) => set({ copyStopLossPercent: percent }),
      setCopyTakeProfitPercent: (percent: number) => set({ copyTakeProfitPercent: percent }),
      setCopyBuysOnly: (enabled: boolean) => set({ copyBuysOnly: enabled }),

      setLlmPremiumModel: (model: string) => {
        set({ llmPremiumModel: model })
        import('@/services/llm/OpenRouterService').then(m => m.openRouterService.setConfig({ premiumModel: model || undefined }))
      },
      setLlmPremiumThreshold: (threshold: number) => {
        set({ llmPremiumThreshold: threshold })
        import('@/services/llm/OpenRouterService').then(m => m.openRouterService.setConfig({ premiumModelThreshold: threshold }))
      },
      setLlmPremiumBudgetUSD: (budget: number) => {
        set({ llmPremiumBudgetUSD: budget })
        import('@/services/llm/OpenRouterService').then(m => m.openRouterService.setConfig({ premiumBudgetUSD: budget }))
      },
      setCryptoLLMEnabled: (enabled: boolean) => {
        set({ cryptoLLMEnabled: enabled })
        import('@/services/strategies/LLMPredictionStrategy').then(m => m.llmPredictionStrategy.setLLMConfig?.({ cryptoLLMEnabled: enabled })).catch(() => {})
      },
      setCryptoModel: (model: string) => {
        set({ cryptoModel: model })
        import('@/services/strategies/LLMPredictionStrategy').then(m => m.llmPredictionStrategy.setLLMConfig?.({ cryptoModel: model || undefined })).catch(() => {})
      },
      setCryptoScanIntervalMs: (ms: number) => {
        set({ cryptoScanIntervalMs: ms })
        import('@/services/strategies/LLMPredictionStrategy').then(m => m.llmPredictionStrategy.setLLMConfig?.({ cryptoScanIntervalMs: ms })).catch(() => {})
      },
      setCryptoMinConfidence: (confidence: number) => {
        set({ cryptoMinConfidence: confidence })
        import('@/services/strategies/LLMPredictionStrategy').then(m => m.llmPredictionStrategy.setLLMConfig?.({ cryptoMinConfidence: confidence })).catch(() => {})
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
            btcEnableBtc: true,
            btcEnableEth: true,
            btcEnable5m: false,
            btcEnable15m: true,
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
          import('@/services/strategies/LLMPredictionStrategy').then(m => m.llmPredictionStrategy.setLLMConfig?.({
            excludedCategories: ['Crypto Price'],
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
            btcEnableBtc: DEFAULT_SETTINGS.btcEnableBtc,
            btcEnableEth: DEFAULT_SETTINGS.btcEnableEth,
            btcEnable5m: DEFAULT_SETTINGS.btcEnable5m,
            btcEnable15m: DEFAULT_SETTINGS.btcEnable15m,
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
      version: 25, // Bump when defaults change — triggers migrate()
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
        if (version < 9) {
          // v8→v9: Add LLM web search toggle (opt-in, default off)
          if (state.llmWebSearchEnabled === undefined) state.llmWebSearchEnabled = false
        }
        if (version < 10) {
          // v9→v10: BTC strategy slug-based discovery — relax timing for 15-min windows
          if (state.btcMinWindowRemaining === 300) state.btcMinWindowRemaining = 120
        }
        if (version < 11) {
          // v10→v11: Add 5-minute window support for BTC Up/Down strategy
          if (state.btcEnable5m === undefined) state.btcEnable5m = true
          if (state.btcEnable15m === undefined) state.btcEnable15m = true
        }
        if (version < 12) {
          // v11→v12: Lower BTC confidence threshold — 5-factor formula typically outputs 0.20-0.35,
          // so 0.40/0.55 threshold almost never fires. 0.30 allows moderate directional moves.
          if (state.btcMinConfidence === 0.55 || state.btcMinConfidence === 0.40) {
            state.btcMinConfidence = 0.30
          }
        }
        if (version < 13) {
          // v12→v13: Add Coinbase Spot / Mean Reversion strategy
          if (state.coinbaseApiKey === undefined) state.coinbaseApiKey = ''
          if (state.coinbaseSecret === undefined) state.coinbaseSecret = ''
          if (state.mrEnableBtc === undefined) state.mrEnableBtc = false
          if (state.mrEnableEth === undefined) state.mrEnableEth = false
          if (state.mrEnableSol === undefined) state.mrEnableSol = false
          if (state.mrLookbackPeriod === undefined) state.mrLookbackPeriod = 20
          if (state.mrEntryZScore === undefined) state.mrEntryZScore = 2.0
          if (state.mrExitZScore === undefined) state.mrExitZScore = 0.5
          if (state.mrTradeSize === undefined) state.mrTradeSize = 10.0
          if (state.mrScanIntervalMs === undefined) state.mrScanIntervalMs = 10_000
          if (state.mrStopLossPercent === undefined) state.mrStopLossPercent = 0.03
          if (state.mrTakeProfitPercent === undefined) state.mrTakeProfitPercent = 0.02
          if (state.mrMaxHoldMs === undefined) state.mrMaxHoldMs = 3_600_000
        }
        if (version < 14) {
          // v13→v14: BTC Up/Down overhaul — fee-aware parameters for 10% crypto fee
          // New signal filters
          if (state.btcMinTimeIntoWindowMs === undefined) state.btcMinTimeIntoWindowMs = 45_000
          if (state.btcRegimeFilterEnabled === undefined) state.btcRegimeFilterEnabled = true
          if (state.btcRsiFilterEnabled === undefined) state.btcRsiFilterEnabled = true
          // Retune existing params for resolution-hold strategy (only if still at old defaults)
          if (state.btcMinConfidence === 0.30) state.btcMinConfidence = 0.38
          if (state.btcMaxEntryPrice === 0.75) state.btcMaxEntryPrice = 0.45
          if (state.btcStopLossPercent === 0.25) state.btcStopLossPercent = 0.35
          if (state.btcTakeProfitPercent === 0.20) state.btcTakeProfitPercent = 0.70
        }
        if (version < 15) {
          // v14→v15: Add Follow Trader address field
          if (state.followedAddress === undefined) state.followedAddress = ''
        }
        if (version < 16) {
          // v15→v16: BTC strategy was unable to trade — maxEntryPrice 0.45 rejects all
          // near-balanced markets (outcomes ~50c). Raise to 0.55 and lower minConfidence
          // so the signal model can actually fire trades.
          if (state.btcMaxEntryPrice === 0.45) state.btcMaxEntryPrice = 0.55
          if (state.btcMinConfidence === 0.38) state.btcMinConfidence = 0.30
        }
        if (version < 17) {
          // v16→v17: 10% crypto taker fee makes low-confidence trades negative EV.
          // Raise minConfidence from 0.30 to 0.55 so only high-conviction signals trade.
          if (state.btcMinConfidence === 0.30) state.btcMinConfidence = 0.55
        }
        if (version < 18) {
          // v17→v18: Tighten entry price band for 10% crypto fee profitability.
          // Add minEntryPrice floor — extreme long-shots (<15¢) are deeply
          // negative EV. A 5¢ entry needs >5.6% true probability just to break even.
          if (state.btcMinEntryPrice === undefined) state.btcMinEntryPrice = 0.15
          // Lower maxEntryPrice from 0.55→0.45 — at 55¢ entry, need 61% accuracy
          // to break even (after 10% fee). At 45¢, only need 50%.
          if (state.btcMaxEntryPrice === 0.55) state.btcMaxEntryPrice = 0.45
        }
        if (version < 19) {
          // v18→v19: Multi-asset expansion — replicate Square-Guy's approach.
          // Widen entry range, increase throughput, hold-to-resolution.
          // New fields with defaults:
          if (state.btcEnableXrp === undefined) state.btcEnableXrp = false
          if (state.btcEnable9pm === undefined) state.btcEnable9pm = false
          // Widen entry prices: Square-Guy enters at 52-73c
          if (state.btcMaxEntryPrice === 0.45) state.btcMaxEntryPrice = 0.75
          if (state.btcMinEntryPrice === 0.15) state.btcMinEntryPrice = 0.10
          // Lower confidence threshold for wider price range
          if (state.btcMinConfidence === 0.55) state.btcMinConfidence = 0.40
          // Hold-to-resolution: effectively disable SL/TP
          if (state.btcStopLossPercent === 0.35) state.btcStopLossPercent = 0.95
          if (state.btcTakeProfitPercent === 0.70) state.btcTakeProfitPercent = 0.95
        }
        if (version < 20) {
          // v19→v20: Drop 5m markets — lower edge, higher fees, less liquidity.
          // Force disable for existing users who had it on.
          state.btcEnable5m = false
        }
        if (version < 21) {
          // v20→v21: Tighten BTC entry for small bankroll ($16).
          // At 75¢ entry + 10% fee, need ~78% accuracy to profit — unrealistic.
          // At 45¢ entry + 10% fee, only need ~50% — achievable with signal.
          // Raise confidence threshold back to 0.55 for selectivity.
          // Also force-disable 5m again (belt-and-suspenders — v20 may not re-fire).
          state.btcMaxEntryPrice = 0.45
          state.btcMinConfidence = 0.55
          state.btcEnable5m = false
        }
        if (version < 22) {
          // v21→v22: Add hourly and daily window duration toggles
          if (state.btcEnableHourly === undefined) state.btcEnableHourly = false
          if (state.btcEnableDaily === undefined) state.btcEnableDaily = false
        }
        if (version < 23) {
          // v22→v23: Add LLM confirmation gate for BTC Up/Down strategy
          if (state.btcUseLLMConfirmation === undefined) state.btcUseLLMConfirmation = false
        }
        if (version < 24) {
          // v23→v24: Add copy-trading settings
          if (state.copyTradeSize === undefined) state.copyTradeSize = 5
          if (state.copyMaxConcurrent === undefined) state.copyMaxConcurrent = 5
          if (state.copyPollIntervalMs === undefined) state.copyPollIntervalMs = 15_000
          if (state.copyStopLossPercent === undefined) state.copyStopLossPercent = 0.30
          if (state.copyTakeProfitPercent === undefined) state.copyTakeProfitPercent = 0.50
          if (state.copyBuysOnly === undefined) state.copyBuysOnly = true
        }
        if (version < 25) {
          // v24→v25: LLM premium model tiering + crypto LLM mode
          if (state.llmPremiumModel === undefined) state.llmPremiumModel = ''
          if (state.llmPremiumThreshold === undefined) state.llmPremiumThreshold = 25
          if (state.llmPremiumBudgetUSD === undefined) state.llmPremiumBudgetUSD = 0.50
          if (state.cryptoLLMEnabled === undefined) state.cryptoLLMEnabled = false
          if (state.cryptoModel === undefined) state.cryptoModel = ''
          if (state.cryptoScanIntervalMs === undefined) state.cryptoScanIntervalMs = 30_000
          if (state.cryptoMinConfidence === undefined) state.cryptoMinConfidence = 0.55
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
        btcEnableXrp: state.btcEnableXrp,
        btcEnable5m: state.btcEnable5m,
        btcEnable15m: state.btcEnable15m,
        btcEnableHourly: state.btcEnableHourly,
        btcEnableDaily: state.btcEnableDaily,
        btcEnable9pm: state.btcEnable9pm,
        btcTradeSize: state.btcTradeSize,
        btcUseKellySizing: state.btcUseKellySizing,
        btcMinConfidence: state.btcMinConfidence,
        btcMaxEntryPrice: state.btcMaxEntryPrice,
        btcMinEntryPrice: state.btcMinEntryPrice,
        btcMinWindowRemaining: state.btcMinWindowRemaining,
        btcStopLossPercent: state.btcStopLossPercent,
        btcTakeProfitPercent: state.btcTakeProfitPercent,
        btcMinTimeIntoWindowMs: state.btcMinTimeIntoWindowMs,
        btcRegimeFilterEnabled: state.btcRegimeFilterEnabled,
        btcRsiFilterEnabled: state.btcRsiFilterEnabled,
        btcUseLLMConfirmation: state.btcUseLLMConfirmation,
        aggressiveMode: state.aggressiveMode,
        llmWebSearchEnabled: state.llmWebSearchEnabled,
        microMinCompositeSignal: state.microMinCompositeSignal,
        microMinSignalConfidence: state.microMinSignalConfidence,
        microMaxSpreadFraction: state.microMaxSpreadFraction,
        microTradeSize: state.microTradeSize,
        microStopLossPercent: state.microStopLossPercent,
        microTakeProfitPercent: state.microTakeProfitPercent,
        followedAddress: state.followedAddress,
        copyTradeSize: state.copyTradeSize,
        copyMaxConcurrent: state.copyMaxConcurrent,
        copyPollIntervalMs: state.copyPollIntervalMs,
        copyStopLossPercent: state.copyStopLossPercent,
        copyTakeProfitPercent: state.copyTakeProfitPercent,
        copyBuysOnly: state.copyBuysOnly,
        llmPremiumModel: state.llmPremiumModel,
        llmPremiumThreshold: state.llmPremiumThreshold,
        llmPremiumBudgetUSD: state.llmPremiumBudgetUSD,
        cryptoLLMEnabled: state.cryptoLLMEnabled,
        cryptoModel: state.cryptoModel,
        cryptoScanIntervalMs: state.cryptoScanIntervalMs,
        cryptoMinConfidence: state.cryptoMinConfidence,
        coinbaseApiKey: state.coinbaseApiKey,
        coinbaseSecret: state.coinbaseSecret,
        mrEnableBtc: state.mrEnableBtc,
        mrEnableEth: state.mrEnableEth,
        mrEnableSol: state.mrEnableSol,
        mrLookbackPeriod: state.mrLookbackPeriod,
        mrEntryZScore: state.mrEntryZScore,
        mrExitZScore: state.mrExitZScore,
        mrTradeSize: state.mrTradeSize,
        mrScanIntervalMs: state.mrScanIntervalMs,
        mrStopLossPercent: state.mrStopLossPercent,
        mrTakeProfitPercent: state.mrTakeProfitPercent,
        mrMaxHoldMs: state.mrMaxHoldMs,
      }),
    }
  )
)
