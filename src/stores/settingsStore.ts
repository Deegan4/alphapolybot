import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WalletEntry } from '@/types'

export interface AppSettingsState {
  // Trading Mode
  dryRun: boolean
  pennyTraderMode: boolean
  paperBalance: number  // Starting balance for dry-run paper trading (tracked, decreases/increases with trades)

  // API Keys (stored encrypted via secureStorage in production)
  openRouterApiKey: string

  // LLM Provider — Ollama only (local inference)
  llmProvider: 'openrouter' | 'ollama'  // kept for backward compat, always 'ollama'
  ollamaBaseUrl: string   // e.g. http://localhost:11434/v1
  ollamaModel: string     // e.g. plutus, deepseek-r1:latest
  ollamaSecondaryModel: string  // Different model for second opinion (signal fusion)

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
  maxAssetExposure: number // 0.0–1.0: override correlation-aware per-asset cap (0 = use dynamic caps)

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

  // Crypto Up/Down Strategy
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
  btcMroEnabled: boolean          // MRO oscillator factor in signal engine (volume-weighted reversal detection)
  btcCvdEnabled: boolean          // CVD divergence factor in signal engine (tick-level buying/selling pressure)
  btcCrossExchangeEnabled: boolean  // Cross-exchange price confirmation via Crypto.com (skip trades on divergence)
  btcCrossExchangeMaxDivergencePct: number // Max % price divergence between Binance and Crypto.com (0.15 = 0.15%)

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

  // PolyBacktest — Historical Crypto Up/Down Data
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
  gabagoolDurations: Array<'15m' | '1h' | '4h'>  // which window durations to scan
  gabagoolDepthAwareSizing: boolean  // scale order size to book depth
  gabagoolAdaptiveCheapness: boolean // widen threshold when ask sum < $0.95
  gabagoolFillRateFeedback: boolean  // adjust limit offset based on fill latency
  gabagoolSpreadMinWidth: number     // min bid-ask spread to place orders (0 = disabled)

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

  // Liquidation Momentum Strategy — Hyperliquid liquidation cascades → Polymarket 5m binaries
  liqEnabled: boolean
  liqMinThresholdUSD: number        // min liquidation volume to trigger ($)
  liqMaxThresholdUSD: number        // max — above this, cascade too chaotic ($)
  liqWindowMs: number               // rolling accumulation window (ms)
  liqCooldownMs: number             // ms between trades
  liqTradeSize: number              // USD per trade
  liqMaxAskPrice: number            // don't buy above this
  liqOrderExpiryMs: number          // GTD order expiry (ms)
  liqStopLossPct: number            // SL for positions (0-1)
  liqTakeProfitPct: number          // TP for positions (0-1)
  liqPreferredDuration: '5m' | '15m'  // preferred market window

  // Liquidation Heatmap — predictive cascade detection via Moon Dev API
  moondevApiKey: string               // API key from moondev.com
  relayerApiKey: string               // Polymarket relayer API key (gasless merges)
  liqHeatmapEnabled: boolean          // toggle heatmap polling
  liqHeatmapMinScore: number          // min cascade risk score to trigger pre-positioning (0-1)
  liqHeatmapTradeSize: number         // USD per predictive trade
  liqHeatmapMaxDistancePct: number    // max % distance from trigger price to trade (filter)

  // Moon Dev Data Layer — multi-exchange liquidation, position proximity, HLP sentiment
  moondevMultiExchangeLiqEnabled: boolean  // aggregate liqs from Binance+Bybit+OKX+Hyperliquid
  moondevProximityEnabled: boolean         // track whale positions near liquidation
  moondevSentimentEnabled: boolean         // HLP z-score contrarian filter
  moondevSentimentMinZScore: number        // min |z-score| to consider extreme (default 2.0)
  moondevProximityMaxDistancePct: number   // max distance % for proximity tracking (default 2.0)
  // ─── Microstructure Services ─────────────────────────
  l2DepthEnabled: boolean                  // L2 orderbook depth tracking via CLOB WS
  orderFlowImbalanceEnabled: boolean       // Binance aggTrade order flow imbalance
  orderFlowWindowMs: number                // Rolling window for OFI computation (default 60000)
  feeGateEnabled: boolean                  // Per-token fee verification before trading

  // ─── Hyperliquid Hedge (delta hedging for unpaired exposure) ───
  hyperliquidHedgeEnabled: boolean         // toggle HL hedging for unpaired positions
  hyperliquidMaxHedgeUSD: number           // max single hedge size ($)
  hyperliquidHedgeCooldownMs: number       // ms between hedge opens

  // ─── Weather Market Adapter ────────────────────────
  weatherScanEnabled: boolean              // toggle weather market scanning
  weatherMinLiquidity: number              // min $ liquidity to consider a market
  weatherScanIntervalMs: number            // scan frequency (ms)
  weatherLocations: string[]               // NWS grid point city codes
}

interface SettingsStore extends AppSettingsState {
  // Actions
  setDryRun: (enabled: boolean) => void
  setOpenRouterApiKey: (key: string) => void
  setLlmProvider: (provider: 'openrouter' | 'ollama') => void
  setOllamaBaseUrl: (url: string) => void
  setOllamaModel: (model: string) => void
  setOllamaSecondaryModel: (model: string) => void
  setNotifications: (enabled: boolean) => void
  setSoundAlerts: (enabled: boolean) => void
  setDailyLossLimit: (limit: number) => void
  setWeeklyLossLimit: (limit: number) => void
  setMaxTradesPerHour: (limit: number) => void
  setConsecutiveFailureLimit: (limit: number) => void
  setMinBalanceForTrade: (amount: number) => void
  setMaxAssetExposure: (cap: number) => void
  setRiskManagementEnabled: (enabled: boolean) => void
  setGtcFallbackEnabled: (enabled: boolean) => void
  setGtcExpiryMinutes: (minutes: number) => void
  setKellyFraction: (fraction: number) => void
  setFwTradeSize: (size: number) => void
  setFwMinProfitBps: (bps: number) => void
  setFwEnableCrossMarket: (enabled: boolean) => void
  setFwCrossMarketBudgetUSD: (budget: number) => void
  setPennyTraderMode: (enabled: boolean) => void
  setPaperBalance: (amount: number) => void
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
  setBtcMroEnabled: (enabled: boolean) => void
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
  setGabagoolDurations: (durations: Array<'15m' | '1h' | '4h'>) => void
  setGabagoolDepthAwareSizing: (enabled: boolean) => void
  setGabagoolAdaptiveCheapness: (enabled: boolean) => void
  setGabagoolFillRateFeedback: (enabled: boolean) => void
  setGabagoolSpreadMinWidth: (width: number) => void
  setImpulseEnabled: (enabled: boolean) => void
  setImpulseThreshold: (t: number) => void
  setImpulseConfirmationMs: (ms: number) => void
  setImpulseSnapbackPct: (pct: number) => void
  setImpulseTradeSize: (size: number) => void
  setImpulseCooldownMs: (ms: number) => void
  setImpulsePreferredDuration: (d: '15m' | '1h' | '4h') => void
  setImpulseOrderMode: (m: 'fok' | 'gtd') => void
  setImpulseMaxAskPrice: (p: number) => void
  setImpulseAggressiveMode: (enabled: boolean) => void
  setImpulseLookbackSeconds: (s: number) => void
  setImpulseAssets: (assets: ('BTC' | 'ETH' | 'SOL' | 'XRP')[]) => void
  setImpulseThresholdETH: (t: number) => void
  setImpulseThresholdSOL: (t: number) => void
  setImpulseThresholdXRP: (t: number) => void
  setImpulseStopLossPct: (pct: number) => void
  setImpulseTakeProfitPct: (pct: number) => void
  setImpulseVpinFilter: (enabled: boolean) => void
  setVpinToxicityThreshold: (threshold: number) => void
  setBtcUseMonteCarloKelly: (enabled: boolean) => void
  setUseAvellanedaStoikov: (enabled: boolean) => void
  setAsRiskAversion: (gamma: number) => void
  setAsOrderArrivalRate: (kappa: number) => void
  setLiqEnabled: (enabled: boolean) => void
  setLiqMinThresholdUSD: (usd: number) => void
  setLiqMaxThresholdUSD: (usd: number) => void
  setLiqWindowMs: (ms: number) => void
  setLiqCooldownMs: (ms: number) => void
  setLiqTradeSize: (size: number) => void
  setLiqMaxAskPrice: (price: number) => void
  setLiqOrderExpiryMs: (ms: number) => void
  setLiqStopLossPct: (pct: number) => void
  setLiqTakeProfitPct: (pct: number) => void
  setLiqPreferredDuration: (d: '5m' | '15m') => void
  setMoondevApiKey: (key: string) => void
  setRelayerApiKey: (key: string) => void
  setLiqHeatmapEnabled: (enabled: boolean) => void
  setLiqHeatmapMinScore: (score: number) => void
  setLiqHeatmapTradeSize: (size: number) => void
  setLiqHeatmapMaxDistancePct: (pct: number) => void
  setBtcCvdEnabled: (enabled: boolean) => void
  setBtcCrossExchangeEnabled: (enabled: boolean) => void
  setBtcCrossExchangeMaxDivergencePct: (pct: number) => void
  setMoondevMultiExchangeLiqEnabled: (enabled: boolean) => void
  setMoondevProximityEnabled: (enabled: boolean) => void
  setMoondevSentimentEnabled: (enabled: boolean) => void
  setMoondevSentimentMinZScore: (z: number) => void
  setMoondevProximityMaxDistancePct: (pct: number) => void
  // Microstructure services
  setL2DepthEnabled: (enabled: boolean) => void
  setOrderFlowImbalanceEnabled: (enabled: boolean) => void
  setOrderFlowWindowMs: (ms: number) => void
  setFeeGateEnabled: (enabled: boolean) => void
  // Hyperliquid Hedge
  setHyperliquidHedgeEnabled: (enabled: boolean) => void
  setHyperliquidMaxHedgeUSD: (usd: number) => void
  setHyperliquidHedgeCooldownMs: (ms: number) => void
  // Weather Market Adapter
  setWeatherScanEnabled: (enabled: boolean) => void
  setWeatherMinLiquidity: (min: number) => void
  setWeatherScanIntervalMs: (ms: number) => void
  setWeatherLocations: (locations: string[]) => void
  resetSettings: () => void
}

const DEFAULT_SETTINGS: AppSettingsState = {
  dryRun: false, // Live trading — $20 bankroll config (v66)
  pennyTraderMode: false,  // Kelly sizing for proportional bets on $20 bankroll
  paperBalance: 1_000,     // $1,000 starting paper balance for dry-run
  openRouterApiKey: '',
  llmProvider: 'ollama',
  ollamaBaseUrl: '/api/ollama/v1',
  ollamaModel: 'plutus',
  ollamaSecondaryModel: '',
  enableNotifications: true,
  enableSoundAlerts: false,
  dailyLossLimit: 3,       // $3/day — 15% of $20, ~6.6 losing days of runway
  weeklyLossLimit: 6,      // $6/week — 30% of $20, survive 3 bad weeks
  maxTradesPerHour: 15,    // Fewer trades = less variance on $20
  consecutiveFailureLimit: 3, // Tight circuit breaker
  minBalanceForTrade: 3,   // $3 floor — 15% of $20, stop before bankroll too thin
  riskManagementEnabled: true,
  maxAssetExposure: 0,         // 0 = use dynamic correlation-aware caps (60%/45%/35%). Set 0.01–1.0 to override.
  gtcFallbackEnabled: true,
  gtcExpiryMinutes: 5,
  kellyFraction: 0.15,     // 15% Kelly — conservative on $20 bankroll
  fwTradeSize: 1,           // $1 minimum — FW is taker (fees eat edge, keep small)
  fwMinProfitBps: 30,
  fwEnableCrossMarket: false,
  fwCrossMarketBudgetUSD: 0.25,
  btcEnableBtc: true, // Crypto Up/Down primary strategy — strongest signal + liquidity
  btcEnableEth: false,  // Disabled — weaker signal, dilutes capital
  btcEnableSol: false,  // Disabled — thin liquidity, weak signal
  btcEnableXrp: false,
  btcEnable5m: false,      // 5m OFF — signal is noise, snipe formula was broken, 0% win rate
  btcEnable15m: false,     // 15m OFF — too noisy for directional signal
  btcEnableHourly: true,   // Hourly = best edge/fee ratio with maker mode
  btcEnable4h: true,       // 4hr ON — longer hold but higher payout asymmetry
  btcEnableDaily: false,   // Daily windows (opt-in)
  btcEnable9pm: false,  // 9PM ET daily events (disabled by default — opt-in)
  btcTradeSize: 1.50,        // $1.50 per trade = 7.5% of $20 bankroll
  btcUseKellySizing: true,
  btcMinConfidence: 0.50,    // Higher conviction only — fewer trades, better hit rate
  btcMaxEntryPrice: 0.48,    // Buy below 48c — better payout asymmetry on resolution
  btcMinEntryPrice: 0.10,    // Low floor — only reject extreme long-shots
  btcMinWindowRemaining: 120, // 2 min before resolution
  btcStopLossPercent: 0.95,  // Effectively disabled — hold to resolution
  btcTakeProfitPercent: 0.95, // Effectively disabled — hold to resolution
  btcMinTimeIntoWindowMs: 30_000, // 30s into window — enough for initial signal, don't waste half the window
  btcRegimeFilterEnabled: true,   // Skip choppy/mean-reverting markets
  btcRsiFilterEnabled: true,      // Reduce confidence on overbought/oversold
  btcUseLLMConfirmation: false,   // Off by default — pure mechanical speed (enable if Ollama running)
  btcLLMModel: 'plutus',
  btcMinEdgeOverMarket: 0.07,    // Need 7% edge above market price to trade (wider safety margin on $20)
  btcUseLLMFusion: false,        // LLM fusion (opt-in, takes priority over confirmation)
  btcLLMFusionWeight: 0.30,      // 70% mechanical / 30% LLM
  btcLLMFusionPreFilter: 0.30,   // Skip LLM call if mechanical confidence < 30%
  btcEarlyExitEnabled: true,     // Early exit — take profit mid-window instead of holding to resolution
  btcEarlyExitTPPercent: 0.15,   // 15% net profit target for early exit
  btcMroEnabled: true,           // MRO oscillator — volume edge from BinanceWS
  btcCvdEnabled: true,           // CVD divergence — free signal from tick data, improves BTC signal quality
  btcCrossExchangeEnabled: true,  // Cross-exchange price confirmation via Crypto.com
  btcCrossExchangeMaxDivergencePct: 0.15, // Skip trade if Binance vs Crypto.com diverge >0.15%
  aggressiveMode: true,  // Aggressive — maker-only strategies on $20 bankroll
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
  dualSideEnabled: true,     // ON — maker-only, 0% fees + rebates
  dualSideTradeSize: 1.50,   // $1.50 per leg — dual-side YES+NO ($3 total = 15% of $20)
  dualSideBiasRatio: 0.50,
  dualSideMakerOnly: true,
  dualSideMaxCombinedAsk: 0.990,  // Tighter — YES+NO ask sum must be < 99c for guaranteed profit
  dualSideRequireBothLegs: true,
  btcFiveMinMakerMode: true,     // 5m maker mode ON by default — eliminates dynamic taker fees (up to 1.56%)
  btcFifteenMinMakerMode: true,  // 15m maker mode ON by default — eliminates dynamic taker fees
  btcHourlyMakerMode: true,      // Hourly maker mode ON — 0% fees via GTC+postOnly
  btcFourHourMakerMode: true,    // 4hr maker mode ON — 0% fees via GTC+postOnly
  llmOrderMode: 'GTD',           // GTD-first: fill as maker (0% fees). FOK = legacy taker mode.
  microOrderMode: 'GTD',         // GTD-first with 60s expiry matching signal decay.
  gabagoolEnabled: true,           // ON — guaranteed merge profit, 0% maker fees
  gabagoolMaxExposure: 5,        // $5 max per window (25% of $20)
  gabagoolOrderSize: 1.50,       // $1.50 per individual maker order
  gabagoolCheapnessThreshold: 0.46, // buy when ask < 46c (wider margin for guaranteed profit)
  gabagoolMaxImbalance: 0.20,    // 20% qty imbalance cap
  gabagoolMinProfitMargin: 0.96, // target pair cost < 96c (4% profit margin instead of 2%)
  gabagoolCooldownMs: 3000,      // 3s between orders
  gabagoolDurations: ['1h', '4h'] as Array<'15m' | '1h' | '4h'>,  // Added 4h for more merge opportunities
  gabagoolDepthAwareSizing: false,
  gabagoolAdaptiveCheapness: true,
  gabagoolFillRateFeedback: false,
  gabagoolSpreadMinWidth: 0.02,   // 2c min spread for maker fills
  impulseEnabled: false,          // OFF — FOK taker fees eat edge on $20 bankroll
  impulseThreshold: 150,         // $150 BTC move to trigger (more aggressive)
  impulseConfirmationMs: 1000,   // 1s snapback check
  impulseSnapbackPct: 0.50,      // abort if 50%+ retrace
  impulseTradeSize: 1.50,        // $1.50 per impulse trade (scaled for $20)
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
  liqEnabled: false,              // OFF — less validated, preserve capital on $20
  liqMinThresholdUSD: 25_000,    // $25K min liquidation volume to trigger
  liqMaxThresholdUSD: 100_000,   // $100K max — above this, too chaotic
  liqWindowMs: 60_000,           // 60s rolling window
  liqCooldownMs: 120_000,        // 2 min between trades
  liqTradeSize: 1.50,            // $1.50 per trade (scaled for $20)
  liqMaxAskPrice: 0.55,          // don't buy above 55c
  liqOrderExpiryMs: 45_000,      // 45s GTD expiry
  liqStopLossPct: 0.30,          // 30% SL
  liqTakeProfitPct: 0.60,        // 60% TP
  liqPreferredDuration: '5m' as const,
  moondevApiKey: '',
  relayerApiKey: '',
  liqHeatmapEnabled: false,          // opt-in: predictive cascade detection via Moon Dev API
  liqHeatmapMinScore: 0.5,           // min cascade risk score to trigger pre-positioning (0-1)
  liqHeatmapTradeSize: 1,            // $1 per predictive trade
  liqHeatmapMaxDistancePct: 5,       // only trade when trigger price within 5% of current price

  // Moon Dev Data Layer services (all off by default — require API key)
  moondevMultiExchangeLiqEnabled: false,
  moondevProximityEnabled: false,
  moondevSentimentEnabled: false,
  moondevSentimentMinZScore: 2.0,       // |z-score| threshold for extreme signal
  moondevProximityMaxDistancePct: 2.0,  // track positions within 2% of liquidation
  // Microstructure services
  l2DepthEnabled: false,
  orderFlowImbalanceEnabled: false,
  orderFlowWindowMs: 60_000,
  feeGateEnabled: true,               // always verify fees by default

  // Hyperliquid Hedge — delta hedging for unpaired exposure
  hyperliquidHedgeEnabled: false,      // OFF by default — opt-in after validating HL connection
  hyperliquidMaxHedgeUSD: 10,          // $10 max hedge — conservative for $20 bankroll
  hyperliquidHedgeCooldownMs: 5000,    // 5s between hedges

  // Weather Market Adapter — non-crypto market scanning
  weatherScanEnabled: false,           // OFF by default — opt-in for weather markets
  weatherMinLiquidity: 500,            // $500 min liquidity
  weatherScanIntervalMs: 60_000,       // 60s scan interval (weather markets are slow)
  weatherLocations: ['NYC', 'LAX', 'CHI'],
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
        import('@/utils/secureStorage').then(m => m.secureStorage.set('openrouter_api_key', key, { encrypt: true })).catch(() => {})
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

      setOllamaSecondaryModel: (model: string) => {
        set({ ollamaSecondaryModel: model })
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

      setMaxAssetExposure: (cap: number) => {
        set({ maxAssetExposure: cap })
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

      setPaperBalance: (amount: number) => {
        set({ paperBalance: Math.max(0, amount) })
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

      setBtcMroEnabled: (enabled: boolean) => {
        set({ btcMroEnabled: enabled })
      },

      setLlmWebSearchEnabled: (enabled: boolean) => {
        set({ llmWebSearchEnabled: enabled })
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
        import('@/utils/secureStorage').then(m => m.secureStorage.set('polybacktest_api_key', key, { encrypt: true })).catch(() => {})
      },
      setCoinbaseApiKey: (key: string) => {
        set({ coinbaseApiKey: key })
        import('@/utils/secureStorage').then(m => m.secureStorage.set('coinbase_api_key', key, { encrypt: true })).catch(() => {})
      },
      setCoinbaseSecret: (secret: string) => {
        set({ coinbaseSecret: secret })
        import('@/utils/secureStorage').then(m => m.secureStorage.set('coinbase_secret', secret, { encrypt: true })).catch(() => {})
      },
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
      },
      setLlmPremiumThreshold: (threshold: number) => {
        set({ llmPremiumThreshold: threshold })
      },
      setLlmPremiumBudgetUSD: (budget: number) => {
        set({ llmPremiumBudgetUSD: budget })
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

      setTelegramBotToken: (token: string) => {
        set({ telegramBotToken: token })
        import('@/utils/secureStorage').then(m => m.secureStorage.set('telegram_bot_token', token, { encrypt: true })).catch(() => {})
      },
      setTelegramChatId: (chatId: string) => set({ telegramChatId: chatId }),
      setDiscordWebhookUrl: (url: string) => {
        set({ discordWebhookUrl: url })
        import('@/utils/secureStorage').then(m => m.secureStorage.set('discord_webhook_url', url, { encrypt: true })).catch(() => {})
      },
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
      setGabagoolDurations: (durations: Array<'15m' | '1h' | '4h'>) => set({ gabagoolDurations: durations }),
      setGabagoolDepthAwareSizing: (enabled: boolean) => set({ gabagoolDepthAwareSizing: enabled }),
      setGabagoolAdaptiveCheapness: (enabled: boolean) => set({ gabagoolAdaptiveCheapness: enabled }),
      setGabagoolFillRateFeedback: (enabled: boolean) => set({ gabagoolFillRateFeedback: enabled }),
      setGabagoolSpreadMinWidth: (width: number) => set({ gabagoolSpreadMinWidth: width }),
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
      setLiqEnabled: (enabled: boolean) => set({ liqEnabled: enabled }),
      setLiqMinThresholdUSD: (usd: number) => set({ liqMinThresholdUSD: usd }),
      setLiqMaxThresholdUSD: (usd: number) => set({ liqMaxThresholdUSD: usd }),
      setLiqWindowMs: (ms: number) => set({ liqWindowMs: ms }),
      setLiqCooldownMs: (ms: number) => set({ liqCooldownMs: ms }),
      setLiqTradeSize: (size: number) => set({ liqTradeSize: size }),
      setLiqMaxAskPrice: (price: number) => set({ liqMaxAskPrice: price }),
      setLiqOrderExpiryMs: (ms: number) => set({ liqOrderExpiryMs: ms }),
      setLiqStopLossPct: (pct: number) => set({ liqStopLossPct: pct }),
      setLiqTakeProfitPct: (pct: number) => set({ liqTakeProfitPct: pct }),
      setLiqPreferredDuration: (d: '5m' | '15m') => set({ liqPreferredDuration: d }),
      setMoondevApiKey: (key: string) => {
        set({ moondevApiKey: key })
        import('@/services/api/MoonDevClient').then(({ moonDevClient }) => moonDevClient.setApiKey(key)).catch(() => {})
      },
      setRelayerApiKey: (key: string) => set({ relayerApiKey: key }),
      setLiqHeatmapEnabled: (enabled: boolean) => set({ liqHeatmapEnabled: enabled }),
      setLiqHeatmapMinScore: (score: number) => set({ liqHeatmapMinScore: score }),
      setLiqHeatmapTradeSize: (size: number) => set({ liqHeatmapTradeSize: size }),
      setLiqHeatmapMaxDistancePct: (pct: number) => set({ liqHeatmapMaxDistancePct: pct }),
      setBtcCvdEnabled: (enabled: boolean) => set({ btcCvdEnabled: enabled }),
      setBtcCrossExchangeEnabled: (enabled: boolean) => set({ btcCrossExchangeEnabled: enabled }),
      setBtcCrossExchangeMaxDivergencePct: (pct: number) => set({ btcCrossExchangeMaxDivergencePct: pct }),
      setMoondevMultiExchangeLiqEnabled: (enabled: boolean) => set({ moondevMultiExchangeLiqEnabled: enabled }),
      setMoondevProximityEnabled: (enabled: boolean) => set({ moondevProximityEnabled: enabled }),
      setMoondevSentimentEnabled: (enabled: boolean) => set({ moondevSentimentEnabled: enabled }),
      setMoondevSentimentMinZScore: (z: number) => set({ moondevSentimentMinZScore: z }),
      setMoondevProximityMaxDistancePct: (pct: number) => set({ moondevProximityMaxDistancePct: pct }),
      // Microstructure services
      setL2DepthEnabled: (enabled: boolean) => set({ l2DepthEnabled: enabled }),
      setOrderFlowImbalanceEnabled: (enabled: boolean) => set({ orderFlowImbalanceEnabled: enabled }),
      setOrderFlowWindowMs: (ms: number) => set({ orderFlowWindowMs: ms }),
      setFeeGateEnabled: (enabled: boolean) => set({ feeGateEnabled: enabled }),
      // Hyperliquid Hedge
      setHyperliquidHedgeEnabled: (enabled: boolean) => set({ hyperliquidHedgeEnabled: enabled }),
      setHyperliquidMaxHedgeUSD: (usd: number) => set({ hyperliquidMaxHedgeUSD: usd }),
      setHyperliquidHedgeCooldownMs: (ms: number) => set({ hyperliquidHedgeCooldownMs: ms }),
      // Weather Market Adapter
      setWeatherScanEnabled: (enabled: boolean) => set({ weatherScanEnabled: enabled }),
      setWeatherMinLiquidity: (min: number) => set({ weatherMinLiquidity: min }),
      setWeatherScanIntervalMs: (ms: number) => set({ weatherScanIntervalMs: ms }),
      setWeatherLocations: (locations: string[]) => set({ weatherLocations: locations }),

      setAggressiveMode: (enabled: boolean) => {
        console.log(`[Settings] Aggressive mode ${enabled ? 'ENABLED' : 'DISABLED'}`)
        set({ aggressiveMode: enabled })

        if (enabled) {
          // ── $20 BANKROLL — MAKER-ONLY FOCUS ────────────────────────
          // Only 3 strategies ON — all maker (0% fees):
          // Gabagool (guaranteed merge profit), BTC Up/Down (8-factor signal),
          // Dual-Side Hedge (hedged positions). Everything else OFF.

          const riskConfig = {
            dailyLossLimit: 3,         // $3/day — 15% of $20, ~6.6 losing days of runway
            weeklyLossLimit: 6,        // $6/week — 30% of $20
            maxTradesPerHour: 15,      // fewer trades = less variance
            consecutiveFailureLimit: 3, // tight circuit breaker
          }

          set({
            pennyTraderMode: false,

            // Risk limits — tuned for $20 bankroll
            kellyFraction: 0.15,       // 15% Kelly — conservative at $20
            ...riskConfig,
            maxAssetExposure: 0,       // 0 = dynamic correlation-aware caps (60%/45%/35%)

            // ── Crypto Up/Down (primary edge — maker 0% fee) ──
            btcEnableBtc: true,
            btcEnableEth: false,       // BTC-only — altcoin signals dilute capital
            btcEnableSol: false,       // SOL markets less liquid
            btcEnable5m: false,        // 5m OFF — too fast, positions pile up before loss limit triggers
            btcEnable15m: false,       // 15m OFF — noisy signal, 10% taker fee on 15m crypto markets
            btcEnableHourly: true,     // best edge/fee ratio with maker mode
            btcEnable4h: true,         // longer hold, higher payout asymmetry
            btcTradeSize: 1.50,        // $1.50/trade = 7.5% of $20
            btcMinConfidence: 0.50,    // higher conviction only
            btcMaxEntryPrice: 0.48,    // tighter — buy below 48c for better payout asymmetry
            btcMinEdgeOverMarket: 0.07, // 7% edge required (wider safety margin)
            btcEarlyExitEnabled: true,
            btcEarlyExitTPPercent: 0.15, // take profit at 15%
            btcMroEnabled: true,       // MRO oscillator for volume edge
            btcCvdEnabled: true,       // CVD divergence for tick-level pressure
            btcCrossExchangeEnabled: true, // Crypto.com price confirmation
            btcUseLLMConfirmation: false, // skip LLM — pure mechanical speed
            btcUseLLMFusion: false,

            // ── MAKER STRATEGIES on $20 — smallest viable sizes ──
            gabagoolEnabled: true,     // guaranteed merge profit — keep ON
            gabagoolMaxExposure: 5,    // $5 max per window (25% of $20)
            gabagoolOrderSize: 1.50,   // $1.50 per order
            gabagoolCheapnessThreshold: 0.46, // tighter: buy below 46c
            gabagoolMinProfitMargin: 0.96, // 4% profit margin
            gabagoolDurations: ['1h', '4h'] as Array<'15m' | '1h' | '4h'>,
            dualSideEnabled: true,     // maker-only + rebates — keep ON
            dualSideTradeSize: 1.50,   // $1.50 per leg ($3 total = 15% of bankroll)
            dualSideMaxCombinedAsk: 0.990, // tighter guaranteed-profit gate
            impulseEnabled: false,     // OFF — FOK taker pays fees, not viable on $20
            impulseTradeSize: 1.50,
            liqEnabled: false,         // OFF — less validated, preserve capital
            liqTradeSize: 1.50,

            // ── ProjectFW (taker arb — only on wide spreads) ──
            fwMinProfitBps: 30,
            fwEnableCrossMarket: true,
          })

          // Push to singletons via dynamic imports — MUST match store values above (bug fix: desync)
          import('@/services/trading/RiskManager').then(m => m.riskManager.setConfig(riskConfig)).catch(() => {})
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
            fwMinProfitBps: DEFAULT_SETTINGS.fwMinProfitBps,
            fwEnableCrossMarket: DEFAULT_SETTINGS.fwEnableCrossMarket,
            btcEnableBtc: DEFAULT_SETTINGS.btcEnableBtc,
            btcEnableEth: DEFAULT_SETTINGS.btcEnableEth,
            btcEnableSol: DEFAULT_SETTINGS.btcEnableSol,
            btcEnable5m: DEFAULT_SETTINGS.btcEnable5m,
            btcEnable15m: DEFAULT_SETTINGS.btcEnable15m,
            btcEnableHourly: DEFAULT_SETTINGS.btcEnableHourly,
            btcEnable4h: DEFAULT_SETTINGS.btcEnable4h,
            btcTradeSize: DEFAULT_SETTINGS.btcTradeSize,
            btcMinConfidence: DEFAULT_SETTINGS.btcMinConfidence,
            btcMaxEntryPrice: DEFAULT_SETTINGS.btcMaxEntryPrice,
            btcMinEdgeOverMarket: DEFAULT_SETTINGS.btcMinEdgeOverMarket,
            btcEarlyExitEnabled: DEFAULT_SETTINGS.btcEarlyExitEnabled,
            btcEarlyExitTPPercent: DEFAULT_SETTINGS.btcEarlyExitTPPercent,
            btcMroEnabled: DEFAULT_SETTINGS.btcMroEnabled,
            gabagoolEnabled: DEFAULT_SETTINGS.gabagoolEnabled,
            gabagoolMaxExposure: DEFAULT_SETTINGS.gabagoolMaxExposure,
            gabagoolCheapnessThreshold: DEFAULT_SETTINGS.gabagoolCheapnessThreshold,
            gabagoolMinProfitMargin: DEFAULT_SETTINGS.gabagoolMinProfitMargin,
            gabagoolCooldownMs: DEFAULT_SETTINGS.gabagoolCooldownMs,
            dualSideEnabled: DEFAULT_SETTINGS.dualSideEnabled,
            dualSideTradeSize: DEFAULT_SETTINGS.dualSideTradeSize,
            dualSideMaxCombinedAsk: DEFAULT_SETTINGS.dualSideMaxCombinedAsk,
            impulseEnabled: DEFAULT_SETTINGS.impulseEnabled,
            impulseAssets: DEFAULT_SETTINGS.impulseAssets,
            impulseAggressiveMode: DEFAULT_SETTINGS.impulseAggressiveMode,
            impulseTradeSize: DEFAULT_SETTINGS.impulseTradeSize,
            impulseVpinFilter: DEFAULT_SETTINGS.impulseVpinFilter,
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
      version: 67, // v67: HL hedge, weather adapter, copy trading wiring, per-category fees
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
          // v5→v6: Add Crypto Up/Down strategy defaults
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
          // v10→v11: Add 5-minute window support for Crypto Up/Down strategy
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
          // v13→v14: Crypto Up/Down overhaul — fee-aware parameters for 10% crypto fee
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
          // v22→v23: Add LLM confirmation gate for Crypto Up/Down strategy
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
          if (state.btcLLMModel === undefined) state.btcLLMModel = 'polytrader'
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
          // 0.40 (and prior 0.42/0.45) rejected ALL trades because Crypto Up/Down
          // outcomes are typically priced near 50c. At 55c with maker mode (0 fee),
          // break-even = 55% vs minConfidence 65% → 10% edge. With taker (10%),
          // break-even = 60.5% vs 65% → 4.5% edge. Both are profitable.
          if (Number(state.btcMaxEntryPrice) <= 0.45) state.btcMaxEntryPrice = 0.55
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
          // v45→v46: LLM signal fusion for Crypto Up/Down
          if (state.btcUseLLMFusion === undefined) state.btcUseLLMFusion = false
          if (state.btcLLMFusionWeight === undefined) state.btcLLMFusionWeight = 0.30
          if (state.btcLLMFusionPreFilter === undefined) state.btcLLMFusionPreFilter = 0.30
        }
        if (version < 47) {
          // v46→v47: $10 bankroll tuning — all sizes to $1 CLOB minimum,
          // tighten risk limits, reduce max exposure.
          if (Number(state.btcTradeSize) > 1) state.btcTradeSize = 1
          if (Number(state.fwTradeSize) > 1) state.fwTradeSize = 1
          if (Number(state.dualSideTradeSize) > 1) state.dualSideTradeSize = 1
          if (Number(state.gabagoolMaxExposure) > 3) state.gabagoolMaxExposure = 3
          if (Number(state.maxTradesPerHour) > 15) state.maxTradesPerHour = 15
          if (Number(state.consecutiveFailureLimit) > 3) state.consecutiveFailureLimit = 3
        }
        if (version < 48) {
          // v47→v48: Switch to custom polytrader Modelfile (Qwen3 Coder 30B + trading system prompt)
          state.ollamaModel = 'polytrader'
        }
        if (version < 49) {
          // v48→v49: Shift Crypto Up/Down focus to 1hr + 4hr markets
          if (state.btcEnable4h === undefined) state.btcEnable4h = true
          if (state.btcHourlyMakerMode === undefined) state.btcHourlyMakerMode = true
          if (state.btcFourHourMakerMode === undefined) state.btcFourHourMakerMode = true
          state.btcEnable15m = false
          state.btcEnableHourly = true
        }
        if (version < 50) {
          // v49→v50: Crypto Up/Down early exit mode (opt-in, off by default)
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
        if (version < 54) {
          // v53→v54: MRO oscillator factor for BTC signal engine
          if (state.btcMroEnabled === undefined) state.btcMroEnabled = false
        }
        if (version < 55) {
          // v54→v55: Remove OpenRouter, Ollama-only LLM provider
          state.llmProvider = 'ollama'
          if (state.ollamaSecondaryModel === undefined) state.ollamaSecondaryModel = ''
        }
        if (version < 56) {
          // v55→v56: Gabagool v2 — multi-duration, depth sizing, adaptive cheapness, fill feedback, spread gate
          if (state.gabagoolDurations === undefined) state.gabagoolDurations = ['1h']
          if (state.gabagoolDepthAwareSizing === undefined) state.gabagoolDepthAwareSizing = false
          if (state.gabagoolAdaptiveCheapness === undefined) state.gabagoolAdaptiveCheapness = true
          if (state.gabagoolFillRateFeedback === undefined) state.gabagoolFillRateFeedback = false
          if (state.gabagoolSpreadMinWidth === undefined) state.gabagoolSpreadMinWidth = 0.02
        }
        if (version < 57) {
          // v56→v57: Fix btcLLMModel — was OpenRouter-style 'deepseek/deepseek-r1', now Ollama name
          if (state.btcLLMModel === 'deepseek/deepseek-r1') state.btcLLMModel = 'polytrader'
        }
        if (version < 58) {
          // v57→v58: Liquidation Momentum strategy
          if (state.liqEnabled === undefined) state.liqEnabled = false
          if (state.liqMinThresholdUSD === undefined) state.liqMinThresholdUSD = 25_000
          if (state.liqMaxThresholdUSD === undefined) state.liqMaxThresholdUSD = 100_000
          if (state.liqWindowMs === undefined) state.liqWindowMs = 60_000
          if (state.liqCooldownMs === undefined) state.liqCooldownMs = 120_000
          if (state.liqTradeSize === undefined) state.liqTradeSize = 1
          if (state.liqMaxAskPrice === undefined) state.liqMaxAskPrice = 0.55
          if (state.liqOrderExpiryMs === undefined) state.liqOrderExpiryMs = 45_000
          if (state.liqStopLossPct === undefined) state.liqStopLossPct = 0.30
          if (state.liqTakeProfitPct === undefined) state.liqTakeProfitPct = 0.60
          if (state.liqPreferredDuration === undefined) state.liqPreferredDuration = '5m'
        }
        if (version < 59) {
          // v58→v59: Liquidation Heatmap (Moon Dev API)
          if (state.moondevApiKey === undefined) state.moondevApiKey = ''
          if (state.relayerApiKey === undefined) state.relayerApiKey = ''
          if (state.liqHeatmapEnabled === undefined) state.liqHeatmapEnabled = false
          if (state.liqHeatmapMinScore === undefined) state.liqHeatmapMinScore = 0.5
          if (state.liqHeatmapTradeSize === undefined) state.liqHeatmapTradeSize = 1
          if (state.liqHeatmapMaxDistancePct === undefined) state.liqHeatmapMaxDistancePct = 5
        }
        if (version < 60) {
          // v59→v60: $33 aggressive bankroll config — maximize opportunity surface
          // Risk management
          state.dryRun = false
          state.dailyLossLimit = 5
          state.weeklyLossLimit = 15
          state.maxTradesPerHour = 40
          state.consecutiveFailureLimit = 5
          state.minBalanceForTrade = 3
          state.kellyFraction = 0.25
          state.aggressiveMode = true
          // Crypto Up/Down — multi-timeframe, bigger sizing
          state.btcEnableBtc = true
          state.btcEnableEth = false      // concentrate on BTC — altcoin signals too weak
          state.btcEnable5m = true        // 5m = fastest compounding, maker mode = 0% fee
          state.btcEnable15m = true
          state.btcEnableHourly = true
          state.btcEnable4h = true
          state.btcTradeSize = 3
          state.btcMinConfidence = 0.38
          state.btcMaxEntryPrice = 0.55
          // Dual-Side Hedge — maker-only
          state.dualSideEnabled = true
          state.dualSideTradeSize = 2
          // Gabagool — guaranteed merge profit
          state.gabagoolEnabled = true
          state.gabagoolMaxExposure = 8
          state.gabagoolOrderSize = 2
          // Impulse Sniper — latency arb
          state.impulseEnabled = true
          state.impulseThreshold = 150
          state.impulseTradeSize = 2.50
          // Liquidation Momentum — novel signal
          state.liqEnabled = true
          state.liqTradeSize = 2
        }
        if (version < 61) {
          // v60→v61: Moon Dev data integration — CVD, multi-exchange liqs, proximity, sentiment
          if (state.btcCvdEnabled === undefined) state.btcCvdEnabled = false
          if (state.moondevMultiExchangeLiqEnabled === undefined) state.moondevMultiExchangeLiqEnabled = false
          if (state.moondevProximityEnabled === undefined) state.moondevProximityEnabled = false
          if (state.moondevSentimentEnabled === undefined) state.moondevSentimentEnabled = false
          if (state.moondevSentimentMinZScore === undefined) state.moondevSentimentMinZScore = 2.0
          if (state.moondevProximityMaxDistancePct === undefined) state.moondevProximityMaxDistancePct = 2.0
        }
        if (version < 62) {
          // v61→v62: $39 bankroll sizing + disable LLM + BTC-only focus
          state.dailyLossLimit = 6
          state.weeklyLossLimit = 18
          state.minBalanceForTrade = 4
          state.btcTradeSize = 3.50
          state.dualSideTradeSize = 2.50
          state.gabagoolMaxExposure = 10
          state.gabagoolOrderSize = 2.50
          state.impulseTradeSize = 3.00
          state.liqTradeSize = 2.50
          state.btcUseLLMConfirmation = false  // no Ollama dependency — pure mechanical speed
          state.btcUseLLMFusion = false
          state.btcEnableEth = false  // BTC-only — altcoins dilute $39 capital
          state.btcEnableSol = false
          state.btcEnableXrp = false
        }
        if (version < 63) {
          // v62→v63: paper trading balance for dry-run mode
          if (state.paperBalance === undefined) state.paperBalance = 1_000
          // Microstructure services
          if (state.l2DepthEnabled === undefined) state.l2DepthEnabled = false
          if (state.orderFlowImbalanceEnabled === undefined) state.orderFlowImbalanceEnabled = false
          if (state.orderFlowWindowMs === undefined) state.orderFlowWindowMs = 60_000
          if (state.feeGateEnabled === undefined) state.feeGateEnabled = true
        }
        if (version < 64) {
          // v63→v64: Harden BTC Up/Down after 0% win rate on 5m windows.
          // Snipe confidence formula was broken (inflated to 70%+ on noise).
          // Force disable 5m/15m, tighten confidence + entry price gates.
          state.btcEnable5m = false
          state.btcEnable15m = false
          state.btcMinConfidence = 0.55
          state.btcMaxEntryPrice = 0.45
          // Also force BTC-only — portfolio shows ETH/XRP losses
          state.btcEnableEth = false
          state.btcEnableSol = false
          state.btcEnableXrp = false
        }
        if (version < 65) {
          // v64→v65: $29 bankroll hardening after $10 loss.
          // Tighter risk limits, smaller trade sizes, disable unvalidated strategies.
          state.dailyLossLimit = 4
          state.weeklyLossLimit = 10
          state.maxTradesPerHour = 20
          state.consecutiveFailureLimit = 3
          state.kellyFraction = 0.20
          state.btcTradeSize = 2.50
          state.btcMinConfidence = 0.45
          state.btcMaxEntryPrice = 0.50
          state.btcMinEdgeOverMarket = 0.05
          state.gabagoolOrderSize = 2.00
          state.gabagoolMaxExposure = 7
          state.dualSideTradeSize = 2.00
          state.impulseEnabled = false   // OFF — taker fees eat edge on small bankroll
          state.liqEnabled = false       // OFF — preserve capital
        }
        if (version < 66) {
          // v65→v66: $20 bankroll — tighter limits, smaller sizes, cross-exchange confirmation
          state.dailyLossLimit = 3
          state.weeklyLossLimit = 6
          state.maxTradesPerHour = 15
          state.kellyFraction = 0.15
          state.minBalanceForTrade = 3
          state.btcTradeSize = 1.50
          state.btcMinConfidence = 0.50
          state.btcMaxEntryPrice = 0.48
          state.btcMinEdgeOverMarket = 0.07
          state.btcCvdEnabled = true
          state.btcEnable4h = true
          state.btcEnable5m = false
          state.btcEnable15m = false
          state.btcEnableEth = false
          state.btcEnableSol = false
          state.btcEnableXrp = false
          state.gabagoolOrderSize = 1.50
          state.gabagoolMaxExposure = 5
          state.gabagoolCheapnessThreshold = 0.46
          state.gabagoolMinProfitMargin = 0.96
          state.gabagoolDurations = ['1h', '4h']
          state.dualSideTradeSize = 1.50
          state.dualSideMaxCombinedAsk = 0.990
          state.impulseEnabled = false
          state.impulseTradeSize = 1.50
          state.liqEnabled = false
          state.liqTradeSize = 1.50
          // New cross-exchange confirmation fields
          if (state.btcCrossExchangeEnabled === undefined) state.btcCrossExchangeEnabled = true
          if (state.btcCrossExchangeMaxDivergencePct === undefined) state.btcCrossExchangeMaxDivergencePct = 0.15
        }
        if (version < 67) {
          // v66→v67: Hyperliquid hedge, weather adapter, copy trading wiring
          if (state.hyperliquidHedgeEnabled === undefined) state.hyperliquidHedgeEnabled = false
          if (state.hyperliquidMaxHedgeUSD === undefined) state.hyperliquidMaxHedgeUSD = 10
          if (state.hyperliquidHedgeCooldownMs === undefined) state.hyperliquidHedgeCooldownMs = 5000
          if (state.weatherScanEnabled === undefined) state.weatherScanEnabled = false
          if (state.weatherMinLiquidity === undefined) state.weatherMinLiquidity = 500
          if (state.weatherScanIntervalMs === undefined) state.weatherScanIntervalMs = 60_000
          if (state.weatherLocations === undefined) state.weatherLocations = ['NYC', 'LAX', 'CHI']
        }
        return state as unknown as AppSettingsState
      },
      partialize: (state) => ({
        dryRun: state.dryRun,
        paperBalance: state.paperBalance,
        // openRouterApiKey: REMOVED — secrets must not persist in plain-text localStorage
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
        btcMroEnabled: state.btcMroEnabled,
        btcCvdEnabled: state.btcCvdEnabled,
        btcCrossExchangeEnabled: state.btcCrossExchangeEnabled,
        btcCrossExchangeMaxDivergencePct: state.btcCrossExchangeMaxDivergencePct,
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
        // polyBacktestApiKey: REMOVED — secrets must not persist in plain-text localStorage
        wallets: state.wallets,
        activeWalletId: state.activeWalletId,
        // coinbaseApiKey, coinbaseSecret: REMOVED — secrets must not persist in plain-text localStorage
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
        gabagoolDurations: state.gabagoolDurations,
        gabagoolDepthAwareSizing: state.gabagoolDepthAwareSizing,
        gabagoolAdaptiveCheapness: state.gabagoolAdaptiveCheapness,
        gabagoolFillRateFeedback: state.gabagoolFillRateFeedback,
        gabagoolSpreadMinWidth: state.gabagoolSpreadMinWidth,
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
        ollamaSecondaryModel: state.ollamaSecondaryModel,
        liqEnabled: state.liqEnabled,
        liqMinThresholdUSD: state.liqMinThresholdUSD,
        liqMaxThresholdUSD: state.liqMaxThresholdUSD,
        liqWindowMs: state.liqWindowMs,
        liqCooldownMs: state.liqCooldownMs,
        liqTradeSize: state.liqTradeSize,
        liqMaxAskPrice: state.liqMaxAskPrice,
        liqOrderExpiryMs: state.liqOrderExpiryMs,
        liqStopLossPct: state.liqStopLossPct,
        liqTakeProfitPct: state.liqTakeProfitPct,
        liqPreferredDuration: state.liqPreferredDuration,
        // moondevApiKey: NOT persisted — secrets must not persist in plain-text localStorage
        // relayerApiKey: NOT persisted — secrets must not persist in plain-text localStorage
        liqHeatmapEnabled: state.liqHeatmapEnabled,
        liqHeatmapMinScore: state.liqHeatmapMinScore,
        liqHeatmapTradeSize: state.liqHeatmapTradeSize,
        liqHeatmapMaxDistancePct: state.liqHeatmapMaxDistancePct,
        moondevMultiExchangeLiqEnabled: state.moondevMultiExchangeLiqEnabled,
        moondevProximityEnabled: state.moondevProximityEnabled,
        moondevSentimentEnabled: state.moondevSentimentEnabled,
        moondevSentimentMinZScore: state.moondevSentimentMinZScore,
        moondevProximityMaxDistancePct: state.moondevProximityMaxDistancePct,
        // Microstructure services
        l2DepthEnabled: state.l2DepthEnabled,
        orderFlowImbalanceEnabled: state.orderFlowImbalanceEnabled,
        orderFlowWindowMs: state.orderFlowWindowMs,
        feeGateEnabled: state.feeGateEnabled,
      }),
    }
  )
)
