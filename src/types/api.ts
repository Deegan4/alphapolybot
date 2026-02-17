// ==========================================
// POLYMARKET US — MARKET & TRADING TYPES
// ==========================================

export interface Market {
  id: string            // numeric string (US API returns number, we normalize)
  slug: string           // primary identifier for US API (e.g. "btc-100k-2025")
  question: string       // mapped from title
  description?: string
  outcomes: string[]     // derived from event's markets (e.g. ['Yes', 'No'])
  active: boolean
  closed: boolean
  endDate: string
  createdAt: string
  updatedAt?: string
  volume: number
  volume24hr?: number
  liquidity: number
  outcomePrices: number[]
  groupItemTitle?: string
  resolutionSource?: string
  category?: string
  tags?: string[]
  // US-specific
  eventSlug?: string
  outcomeSlugs?: string[]   // per-outcome SDK market slugs (for BBO lookups)
  bestBid?: number
  bestAsk?: number
  spread?: number
  orderPriceMinTickSize?: number
  orderMinSize?: number
}

export interface OrderBook {
  marketSlug: string
  bids: OrderBookEntry[]
  asks: OrderBookEntry[]
  lastUpdate: number
  state?: string       // MARKET_STATE_OPEN etc.
  stats?: {
    lastTradePx?: number
    sharesTraded?: number
    openInterest?: number
    highPx?: number
    lowPx?: number
  }
}

export interface OrderBookEntry {
  price: number
  size: number
  timestamp?: number
}

export interface PriceData {
  bid: number
  ask: number
  last: number
  mid: number
  spread: number
  timestamp: Date
  volume24h?: number
}

export interface PriceUpdate {
  marketSlug: string
  outcome: 'yes' | 'no'
  price: number
  timestamp: number
}

export interface Order {
  id: string
  marketSlug: string
  side: 'BUY' | 'SELL'
  type: 'FOK' | 'GTC' | 'GTD' | 'IOC'
  intent: USOrderIntent
  price: number
  size: number
  filledSize?: number
  remainingSize?: number
  status: 'pending' | 'open' | 'filled' | 'cancelled' | 'expired' | 'failed'
  createdAt: Date
  updatedAt?: Date
  error?: string
  avgPrice?: number
}

export interface OrderRequest {
  marketSlug: string
  outcome: 'yes' | 'no'
  side: 'BUY' | 'SELL'
  price: number
  size: number
  type?: 'FOK' | 'GTC' | 'GTD' | 'IOC'
  expiration?: string   // ISO8601 for GTD goodTillTime
  /** Post-only flag — participateDontInitiate in US API */
  postOnly?: boolean
  /** Internal: marks retry — prevents infinite loops */
  _retried?: boolean
}

export interface OrderResult {
  success: boolean
  orderId?: string
  error?: string
  filledSize?: number
  avgPrice?: number
  pending?: boolean  // true if GTD order placed but not yet filled
  executions?: Array<{
    id: string
    lastShares?: string
    lastPx?: number
    type: string
  }>
}

/**
 * A GTD limit order that has been submitted but not yet filled.
 * Tracked by GtcOrderManager until fill, expiry, or cancellation.
 */
export interface PendingGtcOrder {
  orderId: string
  marketSlug: string
  outcome: 'yes' | 'no'
  question: string
  side: 'BUY' | 'SELL'
  price: number
  size: number
  costBasis: number           // USD locked
  strategy: 'llm' | 'dip' | 'fw' | 'btc' | 'micro' | 'meanrev' | 'copy'
  stopLossPercent: number     // SL to apply when filled
  takeProfitPercent: number   // TP to apply when filled
  placedAt: number            // Date.now() at placement
  expiresAt: number           // Unix timestamp (ms) — matches goodTillTime
  status: 'pending' | 'filled' | 'cancelled' | 'expired'
}

export interface Trade {
  id: string
  marketSlug: string
  side: 'BUY' | 'SELL'
  price: number
  size: number
  fee?: number
  timestamp: Date
}

// ==========================================
// POSITION TYPES
// ==========================================

export interface Position {
  marketSlug: string
  marketQuestion: string
  outcome: 'yes' | 'no'
  size: number              // net position shares
  entryPrice: number
  currentPrice: number
  cost: number              // total USD cost basis
  realized: number          // realized P&L
  pnl: {
    dollar: number
    percent: number
  }
  entryTime: Date
  lastUpdate: Date
  autoSellSettings?: AutoSellSettings
}

export interface AutoSellSettings {
  takeProfitPercent: number
  stopLossPercent: number
  oddsMovementThreshold: number
  maxHoldTimeHours?: number
}

export interface PortfolioSummary {
  totalValue: number
  totalPnl: number
  totalPnlPercent: number
  unrealizedPnl: number
  realizedPnl: number
  positionCount: number
  winRate?: number
}

// ==========================================
// LLM & ANALYSIS TYPES
// ==========================================

export interface PredictionResult {
  predictedOutcome: 'yes' | 'no'
  confidence: number // 0-1 scale
  reasoning: string
  sources: string[]
  analysisTime: number // milliseconds
}

export interface AnalysisRecord {
  id: string
  marketId: string
  marketQuestion: string
  prediction: PredictionResult
  timestamp: Date
  actualOutcome?: 'yes' | 'no'
  cost?: number
}

export interface LLMConfig {
  provider: 'openrouter' | 'openai' | 'anthropic'
  model: string
  temperature: number
  maxTokens: number
  webSearchEnabled: boolean
  // Premium model tiering
  premiumModel?: string            // e.g. 'openai/gpt-4o' — empty = disabled
  premiumModelThreshold?: number   // min qualityScore to use premium (default: 25)
  premiumBudgetUSD?: number        // daily budget for premium calls (default: $0.50)
}

// ==========================================
// STRATEGY TYPES
// ==========================================

export type StrategyType = 'mechanical' | 'ai' | 'arbitrage' | 'copy'
export type StrategyStatus = 'idle' | 'running' | 'paused' | 'error'

export interface StrategyStats {
  totalTrades: number
  winningTrades: number
  losingTrades: number
  totalPnl: number
  winRate: number
  avgTradeSize: number
  avgHoldTime: number
  bestTrade: number
  worstTrade: number
}

export interface StrategyConfig {
  enabled: boolean
  [key: string]: unknown
}

// Dip Arbitrage specific types
export interface DipArbConfig {
  shares: number
  sumTarget: number
  dipThreshold: number
  windowMinutes?: number
  slidingWindowMs: number
  leg2TimeoutSeconds?: number
  maxSlippage?: number
  executionCooldown?: number
  autoMerge?: boolean
  autoExecute?: boolean
  underlyings?: string[]
  duration?: string
  autoRotate?: boolean
  debug?: boolean
  // Additional fields used by strategy
  targetResolutionMinutes?: number
  minVolume?: number
  maxConcurrentTrades?: number
  cooldownMs?: number
  stopLossPercent?: number     // SL for fallback positions (default 0.20)
  takeProfitPercent?: number   // TP for fallback positions (default 0.10)
  marketRefreshMs?: number     // Market refresh interval in ms (default 60000)
  spreadScanEnabled?: boolean  // Enable periodic order book spread scan (default true)
  spreadScanIntervalMs?: number // Spread scan interval in ms (default 30000)
  spreadScanBatchSize?: number  // Max markets to check per spread scan (default 30)
}

export interface DipSignal {
  marketSlug: string
  outcome: 'yes' | 'no'
  currentPrice: number
  previousPrice: number
  dropPercent: number
  timestamp: Date
}

export interface ArbRound {
  marketSlug: string
  leg1Executed: boolean
  leg1Outcome?: 'yes' | 'no'
  leg1Price?: number
  leg1Timestamp?: number
  leg2Executed: boolean
  leg2Outcome?: 'yes' | 'no'
  leg2Price?: number
  leg2Timestamp?: number
  profit?: number
}

// ProjectFW Arbitrage specific types
export interface ProjectFWConfig {
  // Algorithm parameters
  alpha: number              // FW approximation ratio (0,1), default 0.5
  epsilonD: number           // Convergence threshold for F(mu), default 0.001
  epsilon0: number           // Initial contraction parameter, default 0.1
  maxIterations: number      // Max FW iterations per solve, default 50
  // Trading parameters
  tradeSize: number          // USDC per arb bundle, default 3
  minProfitBps: number       // Min guaranteed profit after fees in bps, default 50
  maxConcurrentArbs: number  // Max simultaneous arb bundles, default 2
  scanIntervalMs: number     // Periodic scan interval, default 15000
  cooldownMs: number         // Per-market cooldown, default 60000
  // Fee model
  takerFeeBps: number        // Polymarket taker fee in bps, default 200
  gasEstimateUSD: number     // Est. gas per transaction, default 0.01
  // Market filters
  minLiquidity: number       // Min market liquidity, default 5000
  minVolume24h: number       // Min 24h volume, default 1000
  maxSpreadBps: number       // Max bid-ask spread in bps, default 500
  // Multi-outcome
  enableMultiOutcome: boolean // Scan multi-market events, default false
  // Safety
  stopLossPercent: number    // SL for fallback positions, default 0.15
  takeProfitPercent: number  // TP for fallback positions, default 0.10
  // Cross-market analysis (validation-only MVP)
  enableCrossMarket: boolean       // Feature toggle, default false
  crossMarketBudgetUSD: number     // Daily LLM budget for dependency analysis, default 0.50
  mutexConfidenceThreshold: number // Min LLM confidence for mutex classification (0-1), default 0.75
  crossMarketCacheTTL: number      // Dependency graph cache TTL in ms, default 3600000 (1 hour)
  maxPairsPerLLMCall: number       // Batch size for dependency classification, default 10
  minEventLiquidity: number        // Min combined event liquidity to analyze, default 10000
}

export interface FWArbRound {
  id: string
  marketSlug: string
  eventSlug?: string         // For multi-outcome arbs
  timestamp: number
  legs: FWArbLeg[]
  totalCost: number
  guaranteedProfit: number   // D(mu||theta) - g(mu) minus fees
  fwGap: number              // g(mu) at convergence
  klDivergence: number       // D(mu||theta) measuring price incoherence
  status: 'pending' | 'partial' | 'complete' | 'failed'
}

export interface FWArbLeg {
  marketSlug: string
  outcome: 'yes' | 'no'
  side: 'BUY' | 'SELL'
  shares: number
  price: number
  orderId?: string
  executed: boolean
}

// BTC Up/Down specific types
export interface BtcUpDownConfig {
  // Asset toggles
  enableBtc: boolean           // Trade BTC Up/Down markets (default true)
  enableEth: boolean           // Trade ETH Up/Down markets (default false)
  enableSol: boolean           // Trade SOL Up/Down markets (default false)
  enableXrp: boolean           // Trade XRP Up/Down markets (default false)
  // Window duration toggles
  enable5m: boolean            // Trade 5-minute windows (default true)
  enable15m: boolean           // Trade 15-minute windows (default true)
  enableHourly: boolean        // Trade hourly windows (default false)
  enableDaily: boolean         // Trade daily windows (default false)
  enable9pm: boolean           // Trade 9PM ET daily events (default false)
  // Bet sizing
  tradeSize: number            // Fixed USDC per bet (default 2.0)
  useKellySizing: boolean      // Override tradeSize with Kelly (default true)
  // Entry filters
  minConfidence: number        // Min signal confidence 0-1 (default 0.38)
  maxEntryPrice: number        // Max price to buy an outcome (default 0.45 — cheap outcomes for resolution hold)
  minEntryPrice: number        // Min price to buy an outcome (default 0.15 — reject extreme long-shots where 10% fee kills EV)
  minWindowRemaining: number   // Min seconds left in 15m window to enter (default 120) — auto-scaled for 5m
  minTimeIntoWindowMs: number  // Min ms into window before trading (default 45000 for 15m, auto-scaled for 5m)
  // Signal filters
  regimeFilterEnabled: boolean // Skip choppy/mean-reverting markets (default true)
  rsiFilterEnabled: boolean    // Reduce confidence on overbought/oversold entries (default true)
  // Execution
  scanIntervalMs: number       // Scan frequency in ms (default 15000)
  maxConcurrentPositions: number // Max simultaneous positions (default 3)
  maxEntriesPerMarket: number  // Max entries per market/window (default 3 — scatter-bet)
  cooldownMs: number           // Per-market cooldown in ms (default 15000) — auto-scaled for 5m
  // Risk management — resolution-hold strategy: wide SL/TP, hold to binary payout
  stopLossPercent: number      // SL for positions (default 0.35 — catastrophic protection only)
  takeProfitPercent: number    // TP for positions (default 0.70 — only exit on strong pre-resolution moves)
  maxHoldMs: number            // Force exit before resolution (default 840000 = 14min) — auto-scaled for 5m
  // LLM confirmation
  useLLMConfirmation: boolean  // Use LLM to verify signals on hourly+ windows (default false)
}

export interface MicroMomentumConfig {
  minCompositeSignal: number    // |compositeSignal| threshold to trade (default 0.4)
  minSignalConfidence: number   // signalConfidence threshold (default 0.5)
  maxSpreadFraction: number     // Reject wide-spread markets (default 0.08)
  tradeSize: number             // USDC per trade (default 2.0, penny mode: $1)
  scanIntervalMs: number        // Check signals every N ms (default 20000)
  maxConcurrentPositions: number // Max simultaneous positions (default 3)
  cooldownMs: number            // Per-market cooldown ms (default 60000)
  stopLossPercent: number       // SL for positions (default 0.15)
  takeProfitPercent: number     // TP for positions (default 0.20)
  maxHoldMs: number             // Force exit after N ms (default 1800000 = 30min)
  marketBatchSize: number       // Markets to track per scan (default 40)
}

// LLM Prediction specific types
export interface LLMPredictionConfig {
  baseSize: number
  confidenceMultiplier: number
  maxPositionSize: number
  maxTradeSize: number // Hard dollar cap per trade (e.g., 3 = $3 max)
  minOdds: number
  maxOdds: number
  minLiquidity: number
  minVolume24h: number
  maxSpread: number
  maxCreatedHours: number
  orderType: 'FOK' | 'FAK' | 'GTC' | 'GTD'
  maxSlippage: number
  executionCooldown: number
  stopLossPercent: number
  takeProfitPercent: number
  maxOpenPositions: number
  maxCapitalExposure: number
  minConfidence: number
  excludedCategories: string[]
  gtcFallbackEnabled: boolean  // When FOK is killed, resubmit as GTD limit order
  gtcExpiryMinutes: number     // GTD orders auto-expire after this duration (server-enforced)
  // Crypto LLM mode (Phase 5)
  cryptoLLMEnabled?: boolean          // default: false
  cryptoModel?: string                // model for crypto analysis (can differ from main)
  cryptoScanIntervalMs?: number       // default: 30000 (faster for crypto)
  cryptoMinConfidence?: number        // default: 0.55 (slightly higher for volatile markets)
}

// ==========================================
// POLYMARKET US — API RESPONSE TYPES
// ==========================================

export interface USEvent {
  id: number
  slug: string
  title: string
  description?: string
  startTime?: string
  endTime?: string
  active: boolean
  closed: boolean
  archived?: boolean
  featured?: boolean
  liquidity?: number
  volume?: number
  markets?: USMarketDetail[]
  tags?: Array<{ id: number; slug: string; label: string }>
}

export interface USMarketDetail {
  id: number
  slug: string
  title: string
  outcome: string        // e.g. "Yes", "No"
  description?: string
  active: boolean
  closed: boolean
  liquidity?: number
  volume?: number
  eventSlug?: string
}

// ==========================================
// POLYMARKET US — ORDER INTENT TYPES
// ==========================================

export type USOrderIntent =
  | 'ORDER_INTENT_BUY_LONG'    // Buy YES
  | 'ORDER_INTENT_SELL_LONG'   // Sell YES
  | 'ORDER_INTENT_BUY_SHORT'   // Buy NO
  | 'ORDER_INTENT_SELL_SHORT'  // Sell NO

export type USOrderType = 'ORDER_TYPE_LIMIT' | 'ORDER_TYPE_MARKET'
export type USTimeInForce =
  | 'TIME_IN_FORCE_GOOD_TILL_CANCEL'
  | 'TIME_IN_FORCE_GOOD_TILL_DATE'
  | 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL'
  | 'TIME_IN_FORCE_FILL_OR_KILL'

/**
 * Maps (side, outcome) to a US API order intent.
 * US API price is always YES-side. For NO orders, API price = 1.0 - desired price.
 */
export function resolveIntent(side: 'BUY' | 'SELL', outcome: 'yes' | 'no'): USOrderIntent {
  if (side === 'BUY' && outcome === 'yes') return 'ORDER_INTENT_BUY_LONG'
  if (side === 'SELL' && outcome === 'yes') return 'ORDER_INTENT_SELL_LONG'
  if (side === 'BUY' && outcome === 'no') return 'ORDER_INTENT_BUY_SHORT'
  return 'ORDER_INTENT_SELL_SHORT'
}

/**
 * Convert a desired outcome price to the API YES-side price.
 * US API always quotes in YES terms.
 */
export function toApiPrice(price: number, outcome: 'yes' | 'no'): number {
  return outcome === 'yes' ? price : 1.0 - price
}

// ==========================================
// ACTIVITY & LOGGING TYPES
// ==========================================

export type ActivityType = 'scan' | 'analysis' | 'trade' | 'sell' | 'error' | 'info' | 'warning' | 'system'

export interface ActivityItem {
  id: string
  timestamp: Date
  type: ActivityType
  message: string
  data?: Record<string, unknown>
  marketId?: string
  orderId?: string
}

// ==========================================
// NOTIFICATION TYPES
// ==========================================

export type NotificationType = 'success' | 'error' | 'warning' | 'info' | 'trade'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  message: string
  timestamp: Date
  autoClose: boolean
  duration?: number
  action?: {
    label: string
    handler: () => void
  }
}

// ==========================================
// SETTINGS TYPES
// ==========================================

export interface AppSettings {
  riskManagement: RiskManagementSettings
  autoSell: AutoSellGlobalSettings
  scanning: ScanningSettings
  notifications: NotificationSettings
  ui: UISettings
  advanced: AdvancedSettings
}

export interface RiskManagementSettings {
  betSizePercent: number
  maxConcurrentPositions: number
  maxDailyLoss: number
  maxWeeklyLoss: number
  emergencyStopLoss: number
  positionSizeScaling: boolean
}

export interface AutoSellGlobalSettings {
  enabled: boolean
  lossThreshold: number
  profitThreshold: number
  oddsMovementThreshold: number
  maxHoldTime: number
  timeBasedExit: boolean
  trailingStopEnabled: boolean
  trailingStopDistance: number
}

export interface ScanningSettings {
  enabled: boolean
  scanIntervalSeconds: number
  minLiquidity: number
  maxMarketAge: number
  oddsTolerance: number
  excludedCategories: string[]
  requiredKeywords: string[]
  excludedKeywords: string[]
}

export interface NotificationSettings {
  tradeExecutions: boolean
  positionUpdates: boolean
  errorAlerts: boolean
  dailySummary: boolean
  soundEnabled: boolean
  desktopNotifications: boolean
}

export interface UISettings {
  theme: 'matrix' | 'dark' | 'light'
  refreshInterval: number
  compactMode: boolean
  showAnimations: boolean
}

export interface AdvancedSettings {
  debugMode: boolean
  experimentalFeatures: boolean
  customPrompts: boolean
  manualOrderPlacement: boolean
}

// ==========================================
// SPREAD TYPES
// ==========================================

export interface SpreadData {
  marketSlug: string
  bid: number
  ask: number
  spread: number
  timestamp: number
}

// ==========================================
// WEBSOCKET PRIVATE CHANNEL TYPES (US API)
// ==========================================

/** US WebSocket order execution event */
export interface USOrderExecution {
  id: string
  orderId: string
  marketSlug: string
  side: string
  intent: USOrderIntent
  lastShares?: string
  lastPx?: number
  type: string         // ExecutionType
  transactTime?: string
  tradeId?: string
  aggressor?: boolean
}

/** US WebSocket position update */
export interface USPositionUpdate {
  marketSlug: string
  netPosition: string
  cost: number
  realized: number
  cashValue?: number
}

// ==========================================
// RTDS (Real-Time Data Socket) TYPES
// ==========================================

export interface RTDSSubscription {
  topic: string
  type: string
  filters?: string
}

export interface RTDSMessage<T = unknown> {
  topic: string
  type: string
  timestamp: number
  payload: T
}

export interface RTDSCryptoPricePayload {
  symbol: string
  price: number
  change24h?: number
  volume24h?: number
}

// ==========================================
// MEAN REVERSION / COINBASE TYPES
// ==========================================

export interface MeanRevConfig {
  enableBtc: boolean
  enableEth: boolean
  enableSol: boolean
  lookbackPeriod: number        // Rolling window size (default 20)
  entryZScore: number           // Z-score threshold to enter (default 2.0)
  exitZScore: number            // Z-score threshold to exit (default 0.5)
  bollingerMultiplier: number   // StdDev multiplier for bands (default 2.0)
  tradeSize: number             // USD per trade (default 10.0)
  scanIntervalMs: number        // Signal check interval (default 10_000)
  maxConcurrentPositions: number // Per asset (default 1)
  cooldownMs: number            // Per-symbol cooldown (default 60_000)
  stopLossPercent: number       // Hard SL (default 0.03 = 3%)
  takeProfitPercent: number     // Hard TP (default 0.02 = 2%)
  maxHoldMs: number             // Force exit after N ms (default 3_600_000 = 1hr)
}

export interface SpotPosition {
  symbol: string
  side: 'LONG'
  entryPrice: number
  quantity: number
  costBasis: number       // USD spent
  entryTime: number
  orderId?: string
  currentPrice: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
}

export interface MeanRevSignal {
  symbol: string
  action: 'buy' | 'sell' | 'hold'
  zScore: number
  mean: number
  stdDev: number
  upperBand: number
  lowerBand: number
  currentPrice: number
  confidence: number      // 0-1 mapped from Z-score magnitude
  timestamp: number
}

export interface CoinbaseOrderResult {
  success: boolean
  orderId?: string
  productId?: string
  side?: 'BUY' | 'SELL'
  filledSize?: number
  filledValue?: number
  avgPrice?: number
  status?: string
  error?: string
}

export interface CoinbaseAccountBalance {
  currency: string
  available: number
  hold: number
  total: number
}

export interface CoinbaseCandle {
  start: number     // Unix timestamp
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// ==========================================
// PORTFOLIO ACTIVITY TYPES
// ==========================================

export interface UserActivity {
  id: string
  type: 'trade' | 'deposit' | 'withdrawal' | 'resolution' | 'referral' | 'transfer'
  amount: number
  timestamp: string
  marketSlug?: string
  side?: 'BUY' | 'SELL'
}

// ==========================================
// POLYBACKTEST API TYPES
// ==========================================

export type PolyBacktestMarketType = '5m' | '15m' | '1hr' | '4hr' | '24hr'

export interface PolyBacktestMarket {
  market_id: string
  event_id: string
  slug: string
  market_type: PolyBacktestMarketType
  start_time: string       // ISO8601
  end_time: string         // ISO8601
  btc_price_start: number | null
  btc_price_end: number | null
  condition_id: string | null
  clob_token_up: string | null
  clob_token_down: string | null
  winner: 'up' | 'down' | null
  final_volume: number | null
  final_liquidity: number | null
  resolved_at: string | null
  created_at: string | null
  updated_at: string | null
}

export interface PolyBacktestOrderBookLevel {
  price: number
  size: number
}

export interface PolyBacktestOrderBook {
  bids: PolyBacktestOrderBookLevel[]
  asks: PolyBacktestOrderBookLevel[]
}

export interface PolyBacktestSnapshot {
  id: string
  time: string             // ISO8601
  market_id: string
  btc_price: number
  price_up: number
  price_down: number
  orderbook_up: PolyBacktestOrderBook | null
  orderbook_down: PolyBacktestOrderBook | null
}

export interface PolyBacktestMarketsResponse {
  markets: PolyBacktestMarket[]
  total: number
  limit: number
  offset: number
}

export interface PolyBacktestSnapshotsResponse {
  market: PolyBacktestMarket
  snapshots: PolyBacktestSnapshot[]
  total: number
  limit: number
  offset: number
}

export interface PolyBacktestHealthResponse {
  status: string
  timestamp: string
}

// ==========================================
// BACKTEST RESULT TYPES
// ==========================================

export interface BacktestTradeRecord {
  snapshotTime: string
  direction: 'up' | 'down'
  confidence: number
  entryPrice: number          // outcome price paid
  btcPriceAtEntry: number
  resolved: boolean
  winner: 'up' | 'down' | null
  pnl: number                 // after fee
  holdTimeMs: number
}

export interface BacktestSummary {
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  avgPnl: number
  avgHoldTimeMs: number
  maxDrawdown: number
  sharpeRatio: number | null
  profitFactor: number | null
}

export interface BacktestResult {
  marketId: string
  slug: string
  marketType: PolyBacktestMarketType
  config: Partial<BtcUpDownConfig>
  trades: BacktestTradeRecord[]
  summary: BacktestSummary
}

export interface BacktestEnrichment {
  historicalWinRate: number
  avgSpread: number
  sampleSize: number
  timeOfDayWinRate: number | null
  dayOfWeekWinRate: number | null
}
