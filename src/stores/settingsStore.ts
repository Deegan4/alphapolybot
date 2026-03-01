import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WalletEntry } from '@/types'

export interface AppSettingsState {
  // Trading Mode
  dryRun: boolean
  pennyTraderMode: boolean

  // API Keys (stored encrypted via secureStorage in production)
  openRouterApiKey: string

  // LLM Provider selection — 'openrouter' (default) or 'ollama' (local)
  llmProvider: 'openrouter' | 'ollama'
  ollamaBaseUrl: string   // e.g. http://localhost:11434/v1
  ollamaModel: string     // e.g. deepseek-r1:latest, llama3.1

  // Wallet seed phrase is in .env (VITE_WALLET_SEED_PHRASE), not stored here

  // Notifications
  enableNotifications: boolean
  enableSoundAlerts: boolean

  // Risk Management
  dailyLossLimit: number
  weeklyLossLimit: number
  maxTradesPerHour: number
  consecutiveFailureLimit: number
  minBalanceForTrade: number
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
  btcEnable4h: boolean          // Trade 4-hour windows
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
  btcLLMModel: string             // Model for BTC LLM confirmation (empty = default)
  btcMinEdgeOverMarket: number    // Min signal confidence above market price to trade (0.10 = 10%)
  btcUseLLMFusion: boolean        // LLM signal fusion (independent directional prediction)
  btcLLMFusionWeight: number      // LLM weight in fusion (0-1, default 0.30 = 70% mechanical / 30% LLM)
  btcLLMFusionPreFilter: number   // Min mechanical confidence to call LLM (cost control)
  btcEarlyExitEnabled: boolean    // Sell for profit before resolution instead of holding to binary payout
  btcEarlyExitTPPercent: number   // Net profit target for early exit (0.15 = 15%)

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

  // PolyBacktest — Historical BTC Up/Down Data
  polyBacktestApiKey: string

  // Alerting — Telegram & Discord
  telegramBotToken: string
  telegramChatId: string
  discordWebhookUrl: string
  alertOnTrade: boolean
  alertOnError: boolean

  // Multi-Wallet Registry
  wallets: WalletEntry[]
  activeWalletId: string

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

  // Dual-Side Hedge Strategy
  dualSideEnabled: boolean
  dualSideTradeSize: number
  dualSideBiasRatio: number
  dualSideMakerOnly: boolean
  dualSideMaxCombinedAsk: number
  dualSideRequireBothLegs: boolean

  // BTC Maker Mode (avoid taker fees by placing GTC+postOnly limit orders)
  btcFiveMinMakerMode: boolean
  btcFifteenMinMakerMode: boolean
  btcHourlyMakerMode: boolean
  btcFourHourMakerMode: boolean

  // Order Mode — GTD-first reduces taker fees by filling as maker
  llmOrderMode: 'GTD' | 'FOK'    // LLM strategy: GTD (maker, 0% fee) or FOK (taker, up to 1.56%)
  microOrderMode: 'GTD' | 'FOK'  // Micro strategy: GTD (60s expiry) or FOK (immediate fill)

  // Gabagool Accumulator Strategy — direction-agnostic merge arb
  gabagoolEnabled: boolean
  gabagoolMaxExposure: number       // max $ per window
  gabagoolOrderSize: number         // $ per individual order
  gabagoolCheapnessThreshold: number // max ask price to buy a side
  gabagoolMaxImbalance: number      // max qty imbalance before prioritizing lagging side
  gabagoolMinProfitMargin: number   // target max pair cost (< 1.00)
  gabagoolCooldownMs: number        // ms between orders

  // Impulse Sniper Strategy — latency arb on stale Polymarket odds after BTC impulse moves
  impulseEnabled: boolean
  impulseThreshold: number          // min BTC USD move to trigger (default 200)
  impulseConfirmationMs: number     // snapback check window in ms (default 1000)
  impulseSnapbackPct: number        // max retrace fraction before abort (default 0.50)
  impulseTradeSize: number          // USD per trade (default 5)
  impulseCooldownMs: number         // ms between trades (default 10000)
  impulsePreferredDuration: '15m' | '1h' | '4h'  // preferred market duration (default '1h')
  impulseOrderMode: 'fok' | 'gtd'  // order type (default 'fok')
  impulseMaxAskPrice: number        // don't buy above this (default 0.65)
  impulseAggressiveMode: boolean    // lower threshold to 100pts (default false)
  impulseLookbackSeconds: number    // how far back to compare (default 3)
  impulseAssets: ('BTC' | 'ETH' | 'SOL' | 'XRP')[] // which assets to monitor (default ['BTC'])
  impulseThresholdETH: number       // min ETH USD move to trigger (default 15)
  impulseThresholdSOL: number       // min SOL USD move to trigger (default 1.5)
  impulseThresholdXRP: number       // min XRP USD move to trigger (default 0.05)
  impulseStopLossPct: number        // SL for impulse positions (0-1, default 0.20)
  impulseTakeProfitPct: number      // TP for impulse positions (0-1, default 0.50)
  impulseVpinFilter: boolean        // skip trades when VPIN > toxicity threshold (default false)

  // VPIN Toxicity Detection — pause quoting when informed flow detected
  vpinToxicityThreshold: number     // VPIN level to trigger quoting pause (0-1, default 0.7)

  // Monte Carlo Kelly — confidence-adjusted position sizing
  btcUseMonteCarloKelly: boolean    // Use MC Kelly instead of point-estimate (requires 30+ trades)

  // Avellaneda-Stoikov Reservation Pricing — dynamic quote pricing
  useAvellanedaStoikov: boolean     // Toggle AS pricer (off = static offsets)
  asRiskAversion: number            // γ — inventory skew aggressiveness (higher = wider spread)
  asOrderArrivalRate: number        // κ — expected fills per minute (higher = tighter spread)
}

interface SettingsStore extends AppSettingsState {
  // Actions
  setDryRun: (enabled: boolean) => void
  setOpenRouterApiKey: (key: string) => void
  setLlmProvider: (provider: 'openrouter' | 'ollama') => void
  setOllamaBaseUrl: (url: string) => void
  setOllamaModel: (model: string) => void
  setNotifications: (enabled: boolean) => void
  setSoundAlerts: (enabled: boolean) => void
  setDailyLossLimit: (limit: number) => void
  setWeeklyLossLimit: (limit: number) => void
  setMaxTradesPerHour: (limit: number) => void
  setConsecutiveFailureLimit: (limit: number) => void
  setMinBalanceForTrade: (amount: number) => void
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
  setBtcEnable4h: (enabled: boolean) => void
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
  setBtcLLMModel: (model: string) => void
  setBtcMinEdgeOverMarket: (edge: number) => void
  setBtcUseLLMFusion: (enabled: boolean) => void
  setBtcLLMFusionWeight: (weight: number) => void
  setBtcLLMFusionPreFilter: (threshold: number) => void
  setBtcEarlyExitEnabled: (enabled: boolean) => void
  setBtcEarlyExitTPPercent: (percent: number) => void
  setLlmWebSearchEnabled: (enabled: boolean) => void
  setMicroMinCompositeSignal: (value: number) => void
  setMicroMinSignalConfidence: (value: number) => void
  setMicroMaxSpreadFraction: (value: number) => void
  setMicroTradeSize: (size: number) => void
  setMicroStopLossPercent: (percent: number) => void
  setMicroTakeProfitPercent: (percent: number) => void
  setAggressiveMode: (enabled: boolean) => void
  setPolyBacktestApiKey: (key: string) => void
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
  setTelegramBotToken: (token: string) => void
  setTelegramChatId: (chatId: string) => void
  setDiscordWebhookUrl: (url: string) => void
  setAlertOnTrade: (enabled: boolean) => void
  setAlertOnError: (enabled: boolean) => void
  addWallet: (wallet: WalletEntry) => void
  removeWallet: (walletId: string) => void
  setActiveWallet: (walletId: string) => void
  renameWallet: (walletId: string, label: string) => void
  setDualSideEnabled: (enabled: boolean) => void
  setDualSideTradeSize: (size: number) => void
  setDualSideBiasRatio: (ratio: number) => void
  setDualSideMakerOnly: (enabled: boolean) => void
  setDualSideMaxCombinedAsk: (max: number) => void
  setDualSideRequireBothLegs: (enabled: boolean) => void
  setBtcFiveMinMakerMode: (enabled: boolean) => void
  setBtcFifteenMinMakerMode: (enabled: boolean) => void
  setBtcHourlyMakerMode: (enabled: boolean) => void
  setBtcFourHourMakerMode: (enabled: boolean) => void
  setLlmOrderMode: (mode: 'GTD' | 'FOK') => void
  setMicroOrderMode: (mode: 'GTD' | 'FOK') => void
  setGabagoolEnabled: (enabled: boolean) => void
  setGabagoolMaxExposure: (amount: number) => void
  setGabagoolOrderSize: (amount: number) => void
  setGabagoolCheapnessThreshold: (threshold: number) => void
  setGabagoolMaxImbalance: (ratio: number) => void
  setGabagoolMinProfitMargin: (margin: number) => void
  setGabagoolCooldownMs: (ms: number) => void
  setVpinToxicityThreshold: (threshold: number) => void
  setBtcUseMonteCarloKelly: (enabled: boolean) => void
  setUseAvellanedaStoikov: (enabled: boolean) => void
  setAsRiskAversion: (gamma: number) => void
  setAsOrderArrivalRate: (kappa: number) => void
  resetSettings: () => void
}

const DEFAULT_SETTINGS: AppSettingsState = {
  dryRun: true, // SAFE DEFAULT: Always start in dry run mode
  pennyTraderMode: false,  // $14 bankroll → use Kelly sizing for proportional bets
  openRouterApiKey: '',
  llmProvider: 'ollama',
  ollamaBaseUrl: '/api/ollama/v1',
  ollamaModel: 'polytrader',
  enableNotifications: true,
  enableSoundAlerts: false,
  dailyLossLimit: 2,       // $2/day = 14% of $14 bankroll — 7 days runway
  weeklyLossLimit: 7,      // $7/week = 50% max weekly drawdown
  maxTradesPerHour: 12,    // Fewer trades = less overtrading risk
  consecutiveFailureLimit: 3, // Trip fast on small bankroll — preserve capital
  minBalanceForTrade: 1,   // $1 CLOB minimum
  riskManagementEnabled: true,
  gtcFallbackEnabled: true,
  gtcExpiryMinutes: 5,
  kellyFraction: 0.20,     // Conservative — reduces ruin risk on $14 bankroll
  fwTradeSize: 1,           // $1 minimum — FW is taker (fees eat edge at small size)
  fwMinProfitBps: 30,
  fwEnableCrossMarket: false,
  fwCrossMarketBudgetUSD: 0.25,
  btcEnableBtc: true, // BTC Up/Down primary strategy
  btcEnableEth: false,
  btcEnableSol: true,  // SOL has highest intra-window volatility → strongest directional signals
  btcEnableXrp: false,
  btcEnable5m: false,      // 5-min windows disabled — lower edge, higher fees, less liquidity
  btcEnable15m: true,      // 15-min windows ON — maker mode (0% fee) makes these profitable
  btcEnableHourly: true,   // Hourly windows — primary focus
  btcEnable4h: true,       // 4-hour windows — primary focus
  btcEnableDaily: false,   // Daily windows (opt-in)
  btcEnable9pm: false,  // 9PM ET daily events (disabled by default — opt-in)
  btcTradeSize: 1.50,        // $1.50 per trade = 10.7% of $14 bankroll
  btcUseKellySizing: true,
  btcMinConfidence: 0.38,    // Signal engine outputs 0.20–0.45 on calm markets. 0.38 lets top signals through.
  btcMaxEntryPrice: 0.65,    // Allow outcomes up to 65c — covers typical balanced-market spreads.
  btcMinEntryPrice: 0.10,    // Low floor — only reject extreme long-shots
  btcMinWindowRemaining: 120, // 2 min before resolution
  btcStopLossPercent: 0.95,  // Effectively disabled — hold to resolution
  btcTakeProfitPercent: 0.95, // Effectively disabled — hold to resolution
  btcMinTimeIntoWindowMs: 30_000, // 30s into window — enough for initial signal, don't waste half the window
  btcRegimeFilterEnabled: true,   // Skip choppy/mean-reverting markets
  btcRsiFilterEnabled: true,      // Reduce confidence on overbought/oversold
  btcUseLLMConfirmation: false,   // LLM confirmation gate (opt-in)
  btcLLMModel: 'deepseek/deepseek-r1',
  btcMinEdgeOverMarket: 0.02,    // Need 2% edge above market price to trade (maker = 0% fee)
  btcUseLLMFusion: false,        // LLM fusion (opt-in, takes priority over confirmation)
  btcLLMFusionWeight: 0.30,      // 70% mechanical / 30% LLM
  btcLLMFusionPreFilter: 0.30,   // Skip LLM call if mechanical confidence < 30%
  btcEarlyExitEnabled: false,    // Off by default — resolution-hold is the base strategy
  btcEarlyExitTPPercent: 0.15,   // 15% net profit target for early exit
  aggressiveMode: false,
  llmWebSearchEnabled: false,
  microMinCompositeSignal: 0.4,
  microMinSignalConfidence: 0.5,
  microMaxSpreadFraction: 0.08,
  microTradeSize: 1.0,
  microStopLossPercent: 0.15,
  microTakeProfitPercent: 0.20,
  followedAddress: '',
  copyTradeSize: 1,
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
  polyBacktestApiKey: '',
  telegramBotToken: '',
  telegramChatId: '',
  discordWebhookUrl: '',
  alertOnTrade: true,
  alertOnError: true,
  wallets: [],
  activeWalletId: '',
  coinbaseApiKey: '',
  coinbaseSecret: '',
  mrEnableBtc: false,
  mrEnableEth: false,
  mrEnableSol: false,
  mrLookbackPeriod: 20,
  mrEntryZScore: 2.0,
  mrExitZScore: 0.5,
  mrTradeSize: 2.0,
  mrScanIntervalMs: 10_000,
  mrStopLossPercent: 0.03,
  mrTakeProfitPercent: 0.02,
  mrMaxHoldMs: 3_600_000,
  dualSideEnabled: false,
  dualSideTradeSize: 1,      // $1 per leg — dual-side needs both YES+NO
  dualSideBiasRatio: 0.50,
  dualSideMakerOnly: true,
  dualSideMaxCombinedAsk: 0.995,
  dualSideRequireBothLegs: true,
  btcFiveMinMakerMode: true,     // 5m maker mode ON by default — eliminates dynamic taker fees (up to 1.56%)
  btcFifteenMinMakerMode: true,  // 15m maker mode ON by default — eliminates dynamic taker fees
  btcHourlyMakerMode: true,      // Hourly maker mode ON — 0% fees via GTC+postOnly
  btcFourHourMakerMode: true,    // 4hr maker mode ON — 0% fees via GTC+postOnly
  llmOrderMode: 'GTD',           // GTD-first: fill as maker (0% fees). FOK = legacy taker mode.
  microOrderMode: 'GTD',         // GTD-first with 60s expiry matching signal decay.
  gabagoolEnabled: false,
  gabagoolMaxExposure: 3,        // $3 max per 15-min window (30% of $10 bankroll)
  gabagoolOrderSize: 1,          // $1 per individual maker order (CLOB minimum)
  gabagoolCheapnessThreshold: 0.48, // buy when ask < 48c
  gabagoolMaxImbalance: 0.20,    // 20% qty imbalance cap
  gabagoolMinProfitMargin: 0.98, // target pair cost < 98c
  gabagoolCooldownMs: 3000,      // 3s between orders
  impulseEnabled: false,
  impulseThreshold: 200,         // $200 BTC move to trigger
  impulseConfirmationMs: 1000,   // 1s snapback check
  impulseSnapbackPct: 0.50,      // abort if 50%+ retrace
  impulseTradeSize: 5,           // $5 per impulse trade
  impulseCooldownMs: 10_000,     // 10s between trades
  impulsePreferredDuration: '1h' as const, // 1h = sweet spot (manageable fees)
  impulseOrderMode: 'fok' as const,        // FOK for instant fill
  impulseMaxAskPrice: 0.65,      // skip if outcome already > 65c
  impulseAggressiveMode: false,  // aggressive = 100pt threshold
  impulseLookbackSeconds: 3,     // compare to 3s ago
  impulseAssets: ['BTC'] as ('BTC' | 'ETH' | 'SOL' | 'XRP')[],
  impulseThresholdETH: 15,       // $15 ETH move
  impulseThresholdSOL: 1.5,      // $1.50 SOL move
  impulseThresholdXRP: 0.05,     // $0.05 XRP move
  impulseStopLossPct: 0.20,      // 20% SL (tight for latency arb)
  impulseTakeProfitPct: 0.50,    // 50% TP
  impulseVpinFilter: false,      // VPIN filter off by default (needs trade data to populate)
  vpinToxicityThreshold: 0.7,    // VPIN > 0.7 = toxic flow, pause quoting
  btcUseMonteCarloKelly: false,  // Opt-in: needs 30+ closed BTC trades for bootstrap
  useAvellanedaStoikov: false,   // Opt-in: dynamic reservation pricing (off = static 1¢ offsets)
  asRiskAversion: 0.1,           // γ: inventory skew aggressiveness
  asOrderArrivalRate: 2.0,       // κ: expected fills per minute
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

      setLlmProvider: (provider: 'openrouter' | 'ollama') => {
        set({ llmProvider: provider })
      },

      setOllamaBaseUrl: (url: string) => {
        set({ ollamaBaseUrl: url })
      },

      setOllamaModel: (model: string) => {
        set({ ollamaModel: model })
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
      setBtcEnable4h: (enabled: boolean) => {
        set({ btcEnable4h: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enable4h: enabled }))
      },
      setBtcEnableDaily: (enabled: boolean) => {
        set({ btcEnableDaily: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ enableDaily: enabled }))
      },
      /** @deprecated 9PM markets removed — setter is a no-op for backward compat */
      setBtcEnable9pm: (_enabled: boolean) => {},
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
      setBtcLLMModel: (model: string) => {
        set({ btcLLMModel: model })
      },
      setBtcMinEdgeOverMarket: (edge: number) => {
        set({ btcMinEdgeOverMarket: edge })
      },
      setBtcUseLLMFusion: (enabled: boolean) => {
        set({ btcUseLLMFusion: enabled })
        import('@/services/strategies/BtcUpDownStrategy').then(m => m.btcUpDownStrategy.setBtcConfig({ useLLMFusion: enabled }))
      },
      setBtcLLMFusionWeight: (weight: number) => {
        set({ btcLLMFusionWeight: weight })
      },
      setBtcLLMFusionPreFilter: (threshold: number) => {
        set({ btcLLMFusionPreFilter: threshold })
      },
      setBtcEarlyExitEnabled: (enabled: boolean) => {
        set({ btcEarlyExitEnabled: enabled })
      },
      setBtcEarlyExitTPPercent: (percent: number) => {
        set({ btcEarlyExitTPPercent: percent })
      },

      setLlmWebSearchEnabled: (enabled: boolean) => {
        set({ llmWebSearchEnabled: enabled })
        import('@/services/llm/OpenRouterService').then(m => m.openRouterService.setConfig({ webSearchEnabled: enabled }))
      },

      setMicroMinCompositeSignal: (value: number) => set({ microMinCompositeSignal: value }),
      setMicroMinSignalConfidence: (value: number) => set({ microMinSignalConfidence: value }),
      setMicroMaxSpreadFraction: (value: number) => set({ microMaxSpreadFraction: value }),
      setMicroTradeSize: (size: number) => set({ microTradeSize: size }),
      setMicroStopLossPercent: (percent: number) => set({ microStopLossPercent: percent }),
      setMicroTakeProfitPercent: (percent: number) => set({ microTakeProfitPercent: percent }),

      setPolyBacktestApiKey: (key: string) => {
        set({ polyBacktestApiKey: key })
        import('@/services/api/PolyBacktestClient').then(m => m.polyBacktestClient.setApiKey(key))
      },
      setCoinbaseApiKey: (key: string) => set({ coinbaseApiKey: key }),
      setCoinbaseSecret: (secret: string) => set({ coinbaseSecret: secret }),
      setMrEnableBtc: (enabled: boolean) => set({ mrEnableBtc: enabled }),
      setMrEnableEth: (enabled: boolean) => set({ mrEnableEth: enabled }),
      setMrEnableSol: (enabled: boolean) => set({ mrEnableSol: enabled }),
      setMrLookbackPeriod: (period: number) => set({ mrLookbackPeriod: period }),
      setMrEntryZScore: (z: number) => set({ mrEntryZScore: z }),
      setMrExitZScore: (z: number) => set({ mrExitZScore: z }),
      setMrTradeSize: (size: number) => set({ mrTradeSize: size }),
      setMrScanIntervalMs: (ms: number) => set({ mrScanIntervalMs: ms }),
      setMrStopLossPercent: (percent: number) => set({ mrStopLossPercent: percent }),
      setMrTakeProfitPercent: (percent: number) => set({ mrTakeProfitPercent: percent }),
      setMrMaxHoldMs: (ms: number) => set({ mrMaxHoldMs: ms }),

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

      setTelegramBotToken: (token: string) => set({ telegramBotToken: token }),
      setTelegramChatId: (chatId: string) => set({ telegramChatId: chatId }),
      setDiscordWebhookUrl: (url: string) => set({ discordWebhookUrl: url }),
      setAlertOnTrade: (enabled: boolean) => set({ alertOnTrade: enabled }),
      setAlertOnError: (enabled: boolean) => set({ alertOnError: enabled }),

      addWallet: (wallet: WalletEntry) => {
        set((state) => ({
          wallets: [...state.wallets, wallet],
          // Auto-activate if it's the first wallet
          activeWalletId: state.wallets.length === 0 ? wallet.id : state.activeWalletId,
        }))
      },

      removeWallet: (walletId: string) => {
        set((state) => {
          const remaining = state.wallets.filter(w => w.id !== walletId)
          // If removing the active wallet, switch to next available or clear
          const activeStillExists = remaining.some(w => w.id === state.activeWalletId)
          return {
            wallets: remaining,
            activeWalletId: activeStillExists ? state.activeWalletId : (remaining[0]?.id ?? ''),
          }
        })
        // Clean up secret key from secureStorage (fire-and-forget)
        import('@/utils/secureStorage').then(m => m.secureStorage.remove(`wallet-secret-${walletId}`)).catch(() => {})
      },

      setActiveWallet: (walletId: string) => {
        set({ activeWalletId: walletId })
      },

      renameWallet: (walletId: string, label: string) => {
        set((state) => ({
          wallets: state.wallets.map(w => w.id === walletId ? { ...w, label } : w),
        }))
      },

      setDualSideEnabled: (enabled: boolean) => set({ dualSideEnabled: enabled }),
      setDualSideTradeSize: (size: number) => set({ dualSideTradeSize: size }),
      setDualSideBiasRatio: (ratio: number) => set({ dualSideBiasRatio: ratio }),
      setDualSideMakerOnly: (enabled: boolean) => set({ dualSideMakerOnly: enabled }),
      setDualSideMaxCombinedAsk: (max: number) => set({ dualSideMaxCombinedAsk: max }),
      setDualSideRequireBothLegs: (enabled: boolean) => set({ dualSideRequireBothLegs: enabled }),
      setBtcFiveMinMakerMode: (enabled: boolean) => set({ btcFiveMinMakerMode: enabled }),
      setBtcFifteenMinMakerMode: (enabled: boolean) => set({ btcFifteenMinMakerMode: enabled }),
      setBtcHourlyMakerMode: (enabled: boolean) => set({ btcHourlyMakerMode: enabled }),
      setBtcFourHourMakerMode: (enabled: boolean) => set({ btcFourHourMakerMode: enabled }),
      setLlmOrderMode: (mode: 'GTD' | 'FOK') => set({ llmOrderMode: mode }),
      setMicroOrderMode: (mode: 'GTD' | 'FOK') => set({ microOrderMode: mode }),
      setGabagoolEnabled: (enabled: boolean) => set({ gabagoolEnabled: enabled }),
      setGabagoolMaxExposure: (amount: number) => set({ gabagoolMaxExposure: amount }),
      setGabagoolOrderSize: (amount: number) => set({ gabagoolOrderSize: amount }),
      setGabagoolCheapnessThreshold: (threshold: number) => set({ gabagoolCheapnessThreshold: threshold }),
      setGabagoolMaxImbalance: (ratio: number) => set({ gabagoolMaxImbalance: ratio }),
      setGabagoolMinProfitMargin: (margin: number) => set({ gabagoolMinProfitMargin: margin }),
      setGabagoolCooldownMs: (ms: number) => set({ gabagoolCooldownMs: ms }),
      setImpulseEnabled: (enabled: boolean) => set({ impulseEnabled: enabled }),
      setImpulseThreshold: (t: number) => set({ impulseThreshold: t }),
      setImpulseConfirmationMs: (ms: number) => set({ impulseConfirmationMs: ms }),
      setImpulseSnapbackPct: (pct: number) => set({ impulseSnapbackPct: pct }),
      setImpulseTradeSize: (size: number) => set({ impulseTradeSize: size }),
      setImpulseCooldownMs: (ms: number) => set({ impulseCooldownMs: ms }),
      setImpulsePreferredDuration: (d: '15m' | '1h' | '4h') => set({ impulsePreferredDuration: d }),
      setImpulseOrderMode: (m: 'fok' | 'gtd') => set({ impulseOrderMode: m }),
      setImpulseMaxAskPrice: (p: number) => set({ impulseMaxAskPrice: p }),
      setImpulseAggressiveMode: (enabled: boolean) => set({ impulseAggressiveMode: enabled }),
      setImpulseLookbackSeconds: (s: number) => set({ impulseLookbackSeconds: s }),
      setImpulseAssets: (assets: ('BTC' | 'ETH' | 'SOL' | 'XRP')[]) => set({ impulseAssets: assets }),
      setImpulseThresholdETH: (t: number) => set({ impulseThresholdETH: t }),
      setImpulseThresholdSOL: (t: number) => set({ impulseThresholdSOL: t }),
      setImpulseThresholdXRP: (t: number) => set({ impulseThresholdXRP: t }),
      setImpulseStopLossPct: (pct: number) => set({ impulseStopLossPct: pct }),
      setImpulseTakeProfitPct: (pct: number) => set({ impulseTakeProfitPct: pct }),
      setImpulseVpinFilter: (enabled: boolean) => set({ impulseVpinFilter: enabled }),
      setVpinToxicityThreshold: (threshold: number) => set({ vpinToxicityThreshold: threshold }),
      setBtcUseMonteCarloKelly: (enabled: boolean) => set({ btcUseMonteCarloKelly: enabled }),
      setUseAvellanedaStoikov: (enabled: boolean) => set({ useAvellanedaStoikov: enabled }),
      setAsRiskAversion: (gamma: number) => set({ asRiskAversion: gamma }),
      setAsOrderArrivalRate: (kappa: number) => set({ asOrderArrivalRate: kappa }),

      setAggressiveMode: (enabled: boolean) => {
        console.log(`[Settings] Aggressive mode ${enabled ? 'ENABLED' : 'DISABLED'}`)
        set({ aggressiveMode: enabled })

        if (enabled) {
          // Batch-apply aggressive overrides (does NOT touch dryRun — that's separate)
          set({
            pennyTraderMode: false,
            kellyFraction: 0.40,
            dailyLossLimit: 5,
            weeklyLossLimit: 10,
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
            dailyLossLimit: 5,
            weeklyLossLimit: 10,
            maxTradesPerHour: 40,
            consecutiveFailureLimit: 8,
          })).catch(() => {})
          import('@/services/strategies/ProjectFWStrategy').then(m => m.projectFWStrategy.setFWConfig({
            minProfitBps: 30,
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
        }
      },

      resetSettings: () => {
        set(DEFAULT_SETTINGS)
      },
    }),
    {
      name: 'alphapolybot-settings',
      version: 52, // v52: Impulse Sniper v2 — multi-asset, SL/TP, VPIN filter
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
        if (version < 27) {
          // v26→v27: Add PolyBacktest API key for historical market data.
          if (state.polyBacktestApiKey === undefined) state.polyBacktestApiKey = ''
        }
        if (version < 28) {
          // v27→v28: Add BTC LLM model setting (DeepSeek R1 default).
          if (state.btcLLMModel === undefined) state.btcLLMModel = 'deepseek/deepseek-r1'
        }
        if (version < 29) {
          // v28→v29: Clean up old CLOB credential fields
          delete state.clobApiKey
          delete state.clobSecret
          delete state.clobPassphrase
          delete state.minMaticForGas
        }
        if (version < 31) {
          // v30→v31: Multi-wallet registry
          if (state.wallets === undefined) state.wallets = []
          if (state.activeWalletId === undefined) state.activeWalletId = ''
        }
        if (version < 33) {
          // v32→v33: Remove US credentials (switched to international CLOB)
          delete state.pmUsKeyId
          delete state.pmUsSecretKey
        }
        if (version < 34) {
          // v33→v34: Add dual-side hedge strategy + BTC 5m maker mode
          if (state.dualSideEnabled === undefined) state.dualSideEnabled = false
          if (state.dualSideTradeSize === undefined) state.dualSideTradeSize = 2.0
          if (state.dualSideBiasRatio === undefined) state.dualSideBiasRatio = 0.70
          if (state.dualSideMakerOnly === undefined) state.dualSideMakerOnly = true
          if (state.dualSideMaxCombinedAsk === undefined) state.dualSideMaxCombinedAsk = 0.995
          if (state.dualSideRequireBothLegs === undefined) state.dualSideRequireBothLegs = true
          if (state.btcFiveMinMakerMode === undefined) state.btcFiveMinMakerMode = false
          if (state.btcFifteenMinMakerMode === undefined) state.btcFifteenMinMakerMode = true
        }
        if (version < 26) {
          // v25→v26: Align FW arb + risk limits for $10-25 wallet balance.
          // fwTradeSize 3→5 (CLOB minimum is 5 shares — orders below this get rejected).
          // fwMinProfitBps 50→30 (lower threshold catches more thin-edge arbs at small size).
          // dailyLossLimit 4→3, weeklyLossLimit 20→10, minBalanceForTrade 1.5→1.0
          // (tighten loss limits relative to bankroll, allow trading closer to zero).
          // kellyFraction 0.25→0.15 (quarter Kelly too aggressive at $15).
          if (state.fwTradeSize === 3) state.fwTradeSize = 5
          if (state.fwMinProfitBps === 50) state.fwMinProfitBps = 30
          if (state.fwCrossMarketBudgetUSD === 0.50) state.fwCrossMarketBudgetUSD = 0.25
          if (state.dailyLossLimit === 4) state.dailyLossLimit = 3
          if (state.weeklyLossLimit === 20) state.weeklyLossLimit = 10
          if (state.minBalanceForTrade === 1.50) state.minBalanceForTrade = 1.00
          if (state.kellyFraction === 0.25) state.kellyFraction = 0.15
        }
        if (version < 35) {
          // v34→v35: Tighten all parameters for $10 bankroll.
          // Risk: dailyLossLimit 3→2, weeklyLossLimit 10→5, kellyFraction 0.15→0.10
          // Sizes: btcTradeSize 2→1, microTradeSize 2→1, copyTradeSize 5→1,
          //        mrTradeSize 10→2, fwTradeSize 5→2, dualSideTradeSize 2→1
          // Gates: btcMinConfidence 0.55→0.60, btcMaxEntryPrice 0.45→0.40
          if (state.dailyLossLimit === 3) state.dailyLossLimit = 2
          if (state.weeklyLossLimit === 10) state.weeklyLossLimit = 5
          if (state.kellyFraction === 0.15) state.kellyFraction = 0.10
          if (state.btcTradeSize === 2.0) state.btcTradeSize = 1.0
          if (state.microTradeSize === 2.0) state.microTradeSize = 1.0
          if (state.copyTradeSize === 5) state.copyTradeSize = 1
          if ((state.mrTradeSize as number) === 10.0) state.mrTradeSize = 2.0
          if (state.fwTradeSize === 5) state.fwTradeSize = 2
          if (state.dualSideTradeSize === 2.0) state.dualSideTradeSize = 1.0
          if (state.btcMinConfidence === 0.55) state.btcMinConfidence = 0.60
          if (state.btcMaxEntryPrice === 0.45) state.btcMaxEntryPrice = 0.40
        }
        if (version < 36) {
          // v35→v36: Bump kellyFraction 0.10→0.25 (quarter-Kelly).
          // Previous 0.10 on $10 bankroll = $0.10–0.50 bets, below $1 CLOB minimum.
          // 0.25 still hits minBet floor on $10 but is correct when bankroll grows.
          if (state.kellyFraction === 0.10) state.kellyFraction = 0.25
          // Enable BTC asset for the primary $10 strategy
          if (!state.btcEnableBtc) state.btcEnableBtc = true
        }
        if (version < 37) {
          // v36→v37: Raise btcMaxEntryPrice 0.40→0.55.
          // 0.40 (and prior 0.42/0.45) rejected ALL trades because BTC Up/Down
          // outcomes are typically priced near 50c. At 55c with maker mode (0 fee),
          // break-even = 55% vs minConfidence 65% → 10% edge. With taker (10%),
          // break-even = 60.5% vs 65% → 4.5% edge. Both are profitable.
          if (state.btcMaxEntryPrice <= 0.45) state.btcMaxEntryPrice = 0.55
          // Also lower minConfidence slightly (0.65→0.60) to match taker break-even
          // at 55c entry: 60.5% BE means 0.60 conf still has marginal edge, and
          // maker mode (0 fee, BE=55%) has 5% edge at 60% confidence.
          if (state.btcMinConfidence === 0.65) state.btcMinConfidence = 0.60
        }
        if (version < 38) {
          // v37→v38: Lower gates so the bot actually trades.
          // Signal engine outputs 0.20–0.45 on calm markets; 0.60 blocked everything.
          // maxEntryPrice 0.55 was too tight — outcomes near 50c with spread → 52–55c ask.
          // minTimeIntoWindowMs 60s wasted first minute of 15m window.
          if (state.btcMinConfidence === 0.60) state.btcMinConfidence = 0.38
          if (state.btcMaxEntryPrice === 0.55) state.btcMaxEntryPrice = 0.65
          if (state.btcMinTimeIntoWindowMs === 60_000) state.btcMinTimeIntoWindowMs = 30_000
        }
        if (version < 39) {
          // v38→v39: GTD-first order mode for LLM + Micro strategies.
          // Fills as maker (0% fees) instead of taker (up to 1.56%).
          if (state.llmOrderMode === undefined) state.llmOrderMode = 'GTD'
          if (state.microOrderMode === undefined) state.microOrderMode = 'GTD'
        }
        if (version < 40) {
          // v39→v40: Gabagool Accumulator strategy defaults.
          if (state.gabagoolEnabled === undefined) state.gabagoolEnabled = false
          if (state.gabagoolMaxExposure === undefined) state.gabagoolMaxExposure = 10
          if (state.gabagoolOrderSize === undefined) state.gabagoolOrderSize = 1
          if (state.gabagoolCheapnessThreshold === undefined) state.gabagoolCheapnessThreshold = 0.48
          if (state.gabagoolMaxImbalance === undefined) state.gabagoolMaxImbalance = 0.20
          if (state.gabagoolMinProfitMargin === undefined) state.gabagoolMinProfitMargin = 0.98
          if (state.gabagoolCooldownMs === undefined) state.gabagoolCooldownMs = 3000
        }
        if (version < 41) {
          // v40→v41: BTC calibration + edge-over-market gate
          if (state.btcMinEdgeOverMarket === undefined) state.btcMinEdgeOverMarket = 0.10
        }
        if (version < 42) {
          // v41→v42: VPIN toxicity + Monte Carlo Kelly + Avellaneda-Stoikov pricer
          if (state.vpinToxicityThreshold === undefined) state.vpinToxicityThreshold = 0.7
          if (state.btcUseMonteCarloKelly === undefined) state.btcUseMonteCarloKelly = false
          if (state.useAvellanedaStoikov === undefined) state.useAvellanedaStoikov = false
          if (state.asRiskAversion === undefined) state.asRiskAversion = 0.1
          if (state.asOrderArrivalRate === undefined) state.asOrderArrivalRate = 2.0
        }
        if (version < 43) {
          // v42→v43: Local Ollama LLM provider support
          if (state.llmProvider === undefined) state.llmProvider = 'openrouter'
          if (state.ollamaBaseUrl === undefined) state.ollamaBaseUrl = 'http://localhost:11434/v1'
          if (state.ollamaModel === undefined) state.ollamaModel = 'deepseek-r1:latest'
        }
        if (version < 44) {
          // v43→v44: Switch to local AI Toolkit (VS Code) — no more OpenRouter
          state.llmProvider = 'ollama'
          state.ollamaBaseUrl = '/api/ollama/v1'
          state.ollamaModel = 'polytrader'
        }
        if (version < 45) {
          // v44→v45: 10% edge was impossibly high — signal engine confidence rarely exceeds 50%
          if (state.btcMinEdgeOverMarket === 0.10) state.btcMinEdgeOverMarket = 0.02
        }
        if (version < 46) {
          // v45→v46: LLM signal fusion for BTC Up/Down
          if (state.btcUseLLMFusion === undefined) state.btcUseLLMFusion = false
          if (state.btcLLMFusionWeight === undefined) state.btcLLMFusionWeight = 0.30
          if (state.btcLLMFusionPreFilter === undefined) state.btcLLMFusionPreFilter = 0.30
        }
        if (version < 47) {
          // v46→v47: $10 bankroll tuning — all sizes to $1 CLOB minimum,
          // tighten risk limits, reduce max exposure.
          if (state.btcTradeSize > 1) state.btcTradeSize = 1
          if (state.fwTradeSize > 1) state.fwTradeSize = 1
          if (state.dualSideTradeSize > 1) state.dualSideTradeSize = 1
          if (state.gabagoolMaxExposure > 3) state.gabagoolMaxExposure = 3
          if (state.maxTradesPerHour > 15) state.maxTradesPerHour = 15
          if (state.consecutiveFailureLimit > 3) state.consecutiveFailureLimit = 3
        }
        if (version < 48) {
          // v47→v48: Switch to custom polytrader Modelfile (Qwen3 Coder 30B + trading system prompt)
          state.ollamaModel = 'polytrader'
        }
        if (version < 49) {
          // v48→v49: Shift BTC Up/Down focus to 1hr + 4hr markets
          if (state.btcEnable4h === undefined) state.btcEnable4h = true
          if (state.btcHourlyMakerMode === undefined) state.btcHourlyMakerMode = true
          if (state.btcFourHourMakerMode === undefined) state.btcFourHourMakerMode = true
          state.btcEnable15m = false
          state.btcEnableHourly = true
        }
        if (version < 50) {
          // v49→v50: BTC Up/Down early exit mode (opt-in, off by default)
          if (state.btcEarlyExitEnabled === undefined) state.btcEarlyExitEnabled = false
          if (state.btcEarlyExitTPPercent === undefined) state.btcEarlyExitTPPercent = 0.15
        }
        if (version < 51) {
          // v50→v51: Impulse Sniper strategy — latency arb on stale odds
          if (state.impulseEnabled === undefined) state.impulseEnabled = false
          if (state.impulseThreshold === undefined) state.impulseThreshold = 200
          if (state.impulseConfirmationMs === undefined) state.impulseConfirmationMs = 1000
          if (state.impulseSnapbackPct === undefined) state.impulseSnapbackPct = 0.50
          if (state.impulseTradeSize === undefined) state.impulseTradeSize = 5
          if (state.impulseCooldownMs === undefined) state.impulseCooldownMs = 10_000
          if (state.impulsePreferredDuration === undefined) state.impulsePreferredDuration = '1h'
          if (state.impulseOrderMode === undefined) state.impulseOrderMode = 'fok'
          if (state.impulseMaxAskPrice === undefined) state.impulseMaxAskPrice = 0.65
          if (state.impulseAggressiveMode === undefined) state.impulseAggressiveMode = false
          if (state.impulseLookbackSeconds === undefined) state.impulseLookbackSeconds = 3
        }
        if (version < 52) {
          // v51→v52: Impulse Sniper v2 — multi-asset, SL/TP, VPIN filter
          if (state.impulseAssets === undefined) state.impulseAssets = ['BTC']
          if (state.impulseThresholdETH === undefined) state.impulseThresholdETH = 15
          if (state.impulseThresholdSOL === undefined) state.impulseThresholdSOL = 1.5
          if (state.impulseThresholdXRP === undefined) state.impulseThresholdXRP = 0.05
          if (state.impulseStopLossPct === undefined) state.impulseStopLossPct = 0.20
          if (state.impulseTakeProfitPct === undefined) state.impulseTakeProfitPct = 0.50
          if (state.impulseVpinFilter === undefined) state.impulseVpinFilter = false
        }
        return state as AppSettingsState
      },
      partialize: (state) => ({
        dryRun: state.dryRun,
        openRouterApiKey: state.openRouterApiKey,
        enableNotifications: state.enableNotifications,
        enableSoundAlerts: state.enableSoundAlerts,
        dailyLossLimit: state.dailyLossLimit,
        weeklyLossLimit: state.weeklyLossLimit,
        maxTradesPerHour: state.maxTradesPerHour,
        consecutiveFailureLimit: state.consecutiveFailureLimit,
        minBalanceForTrade: state.minBalanceForTrade,
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
        btcEnable4h: state.btcEnable4h,
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
        btcLLMModel: state.btcLLMModel,
        btcMinEdgeOverMarket: state.btcMinEdgeOverMarket,
        btcUseLLMFusion: state.btcUseLLMFusion,
        btcLLMFusionWeight: state.btcLLMFusionWeight,
        btcLLMFusionPreFilter: state.btcLLMFusionPreFilter,
        btcEarlyExitEnabled: state.btcEarlyExitEnabled,
        btcEarlyExitTPPercent: state.btcEarlyExitTPPercent,
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
        polyBacktestApiKey: state.polyBacktestApiKey,
        wallets: state.wallets,
        activeWalletId: state.activeWalletId,
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
        dualSideEnabled: state.dualSideEnabled,
        dualSideTradeSize: state.dualSideTradeSize,
        dualSideBiasRatio: state.dualSideBiasRatio,
        dualSideMakerOnly: state.dualSideMakerOnly,
        dualSideMaxCombinedAsk: state.dualSideMaxCombinedAsk,
        dualSideRequireBothLegs: state.dualSideRequireBothLegs,
        btcFiveMinMakerMode: state.btcFiveMinMakerMode,
        btcFifteenMinMakerMode: state.btcFifteenMinMakerMode,
        btcHourlyMakerMode: state.btcHourlyMakerMode,
        btcFourHourMakerMode: state.btcFourHourMakerMode,
        llmOrderMode: state.llmOrderMode,
        microOrderMode: state.microOrderMode,
        gabagoolEnabled: state.gabagoolEnabled,
        gabagoolMaxExposure: state.gabagoolMaxExposure,
        gabagoolOrderSize: state.gabagoolOrderSize,
        gabagoolCheapnessThreshold: state.gabagoolCheapnessThreshold,
        gabagoolMaxImbalance: state.gabagoolMaxImbalance,
        gabagoolMinProfitMargin: state.gabagoolMinProfitMargin,
        gabagoolCooldownMs: state.gabagoolCooldownMs,
        impulseEnabled: state.impulseEnabled,
        impulseThreshold: state.impulseThreshold,
        impulseConfirmationMs: state.impulseConfirmationMs,
        impulseSnapbackPct: state.impulseSnapbackPct,
        impulseTradeSize: state.impulseTradeSize,
        impulseCooldownMs: state.impulseCooldownMs,
        impulsePreferredDuration: state.impulsePreferredDuration,
        impulseOrderMode: state.impulseOrderMode,
        impulseMaxAskPrice: state.impulseMaxAskPrice,
        impulseAggressiveMode: state.impulseAggressiveMode,
        impulseLookbackSeconds: state.impulseLookbackSeconds,
        impulseAssets: state.impulseAssets,
        impulseThresholdETH: state.impulseThresholdETH,
        impulseThresholdSOL: state.impulseThresholdSOL,
        impulseThresholdXRP: state.impulseThresholdXRP,
        impulseStopLossPct: state.impulseStopLossPct,
        impulseTakeProfitPct: state.impulseTakeProfitPct,
        impulseVpinFilter: state.impulseVpinFilter,
        vpinToxicityThreshold: state.vpinToxicityThreshold,
        btcUseMonteCarloKelly: state.btcUseMonteCarloKelly,
        useAvellanedaStoikov: state.useAvellanedaStoikov,
        asRiskAversion: state.asRiskAversion,
        asOrderArrivalRate: state.asOrderArrivalRate,
        llmProvider: state.llmProvider,
        ollamaBaseUrl: state.ollamaBaseUrl,
        ollamaModel: state.ollamaModel,
      }),
    }
  )
)
