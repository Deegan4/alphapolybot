// ==========================================
// MARKET & TRADING TYPES
// ==========================================

export interface Market {
  id: string
  question: string
  description?: string
  outcomes: string[]
  clobTokenIds: string[]
  conditionId: string
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
  negRisk?: boolean
}

export interface OrderBook {
  marketId: string
  bids: OrderBookEntry[]
  asks: OrderBookEntry[]
  lastUpdate: number
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
  tokenId: string
  outcome: 'yes' | 'no'
  price: number
  timestamp: number
}

export interface Order {
  id: string
  tokenId: string
  marketId: string
  side: 'BUY' | 'SELL'
  type: 'FOK' | 'FAK' | 'GTC' | 'GTD'
  price: number
  size: number
  filledSize?: number
  remainingSize?: number
  status: 'pending' | 'open' | 'filled' | 'cancelled' | 'expired' | 'failed'
  createdAt: Date
  updatedAt?: Date
  txHash?: string
  error?: string
}

export interface OrderRequest {
  tokenId: string
  side: 'BUY' | 'SELL'
  price: number
  size: number
  type?: 'FOK' | 'FAK' | 'GTC' | 'GTD'
  expiration?: number  // Unix timestamp for GTD orders (0 = no expiry)
  conditionId?: string
  negRisk?: boolean
}

export interface OrderResult {
  success: boolean
  orderId?: string
  txHash?: string
  error?: string
  filledSize?: number
  avgPrice?: number
  pending?: boolean  // true if GTD order placed but not yet filled
}

/**
 * A GTD limit order that has been submitted but not yet filled.
 * Tracked by GtcOrderManager until fill, expiry, or cancellation.
 */
export interface PendingGtcOrder {
  orderId: string
  tokenId: string
  marketId: string
  conditionId: string
  outcome: 'yes' | 'no'
  question: string
  side: 'BUY' | 'SELL'
  price: number
  size: number
  costBasis: number           // USDC locked
  strategy: 'llm' | 'dip' | 'fw' | 'btc' | 'micro'
  negRisk?: boolean
  stopLossPercent: number     // SL to apply when filled
  takeProfitPercent: number   // TP to apply when filled
  placedAt: number            // Date.now() at placement
  expiresAt: number           // Unix timestamp (seconds) — matches EIP-712 expiration
  status: 'pending' | 'filled' | 'cancelled' | 'expired'
}

export interface Trade {
  id: string
  marketId: string
  tokenId: string
  side: 'BUY' | 'SELL'
  price: number
  size: number
  fee?: number
  timestamp: Date
  txHash: string
}

// ==========================================
// POSITION TYPES
// ==========================================

export interface Position {
  tokenId: string
  marketId: string
  conditionId: string
  marketQuestion: string
  outcome: string
  outcomeIndex: number
  size: number
  entryPrice: number
  currentPrice: number
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
}

// ==========================================
// STRATEGY TYPES
// ==========================================

export type StrategyType = 'mechanical' | 'ai' | 'arbitrage'
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
  tokenId: string
  currentPrice: number
  previousPrice: number
  dropPercent: number
  timestamp: Date
}

export interface ArbRound {
  marketId: string
  leg1Executed: boolean
  leg1TokenId?: string
  leg1Price?: number
  leg1Timestamp?: number
  leg2Executed: boolean
  leg2TokenId?: string
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
  marketId: string
  eventId?: string           // For multi-outcome arbs
  timestamp: number
  legs: FWArbLeg[]
  totalCost: number
  guaranteedProfit: number   // D(mu||theta) - g(mu) minus fees
  fwGap: number              // g(mu) at convergence
  klDivergence: number       // D(mu||theta) measuring price incoherence
  status: 'pending' | 'partial' | 'complete' | 'failed' | 'merged'
  mergeResult?: { success: boolean; txHash?: string; error?: string }
}

export interface FWArbLeg {
  tokenId: string
  outcome: string            // 'Yes' | 'No' (or market-specific)
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
  // Bet sizing
  tradeSize: number            // Fixed USDC per bet (default 2.0)
  useKellySizing: boolean      // Override tradeSize with Kelly (default true)
  // Entry filters
  minConfidence: number        // Min signal confidence 0-1 (default 0.65)
  maxEntryPrice: number        // Max price to buy an outcome (default 0.70)
  minWindowRemaining: number   // Min seconds left in window to enter (default 300)
  // Execution
  scanIntervalMs: number       // Scan frequency in ms (default 15000)
  maxConcurrentPositions: number // Max simultaneous positions (default 2)
  cooldownMs: number           // Per-market cooldown in ms (default 120000)
  // Risk management
  stopLossPercent: number      // SL for positions (default 0.25)
  takeProfitPercent: number    // TP for positions (default 0.20)
  maxHoldMs: number            // Force exit before resolution (default 840000 = 14min)
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
}

// ==========================================
// API RESPONSE TYPES
// ==========================================

export interface GammaEvent {
  id: string
  title: string
  slug?: string
  active: boolean
  closed: boolean
  markets: Market[]
}

export interface GammaEventsResponse {
  events?: GammaEvent[]
}

export interface GammaMarketsResponse {
  markets: Market[]
  nextCursor?: string
}

export interface GammaMarketResponse {
  market: Market
}

export interface CLOBOrderResponse {
  success: boolean
  orderId?: string
  txHash?: string
  error?: string
}

export interface DataPositionsResponse {
  positions: ApiPosition[]
}

export interface ApiPosition {
  asset: string
  conditionId: string
  title: string
  size: number
  avgPrice: number
  curPrice?: number
  cashPnl: number
  percentPnl: number
  outcomeIndex: number
  lastUpdated: string
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
// CLOB PRICE HISTORY TYPES
// ==========================================

export type PriceHistoryInterval = '1m' | '1h' | '6h' | '1d' | '1w' | 'max'

export interface PriceHistoryOptions {
  interval: PriceHistoryInterval
  startTs?: number   // Unix timestamp (seconds)
  endTs?: number     // Unix timestamp (seconds)
  fidelity?: number  // Data granularity in minutes
}

export interface PriceHistoryPoint {
  t: number  // Unix timestamp
  p: number  // Price
}

export interface PriceHistoryResponse {
  history: PriceHistoryPoint[]
}

// ==========================================
// CLOB SPREAD TYPES
// ==========================================

export interface SpreadData {
  tokenId: string
  bid: number
  ask: number
  spread: number
  timestamp: number
}

// ==========================================
// WEBSOCKET USER CHANNEL TYPES
// ==========================================

export interface UserChannelAuth {
  apiKey: string
  secret: string
  passphrase: string
}

export type UserTradeStatus = 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED'
export type UserOrderEventType = 'PLACEMENT' | 'UPDATE' | 'CANCELLATION'

export interface UserTradeMessage {
  event_type: 'trade'
  id: string
  status: UserTradeStatus
  asset_id: string
  market: string
  side: 'BUY' | 'SELL'
  size: string
  price: string
  fee: string
  timestamp: string
  maker_orders?: Array<{
    order_id: string
    asset_id: string
    matched_amount: string
    price: string
  }>
  transaction_hash?: string
}

export interface UserOrderMessage {
  event_type: UserOrderEventType
  order_id: string
  asset_id: string
  market: string
  side: 'BUY' | 'SELL'
  original_size: string
  size_matched: string
  price: string
  type: 'FOK' | 'FAK' | 'GTC' | 'GTD'
  timestamp: string
  associate_trades?: Array<{
    id: string
    size: string
    price: string
  }>
}

export type UserChannelMessage = UserTradeMessage | UserOrderMessage

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
// DATA API ENRICHMENT TYPES
// ==========================================

export interface UserActivity {
  id: string
  type: 'trade' | 'deposit' | 'withdrawal' | 'claim'
  amount: number
  timestamp: string
  market?: string
  side?: 'BUY' | 'SELL'
  asset_id?: string
}
