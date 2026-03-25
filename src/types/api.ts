// ==========================================
// POLYMARKET — MARKET & TRADING TYPES
// ==========================================

export interface Market {
  id: string
  slug: string
  question: string
  description?: string
  outcomes: string[]
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
  // CLOB identifiers
  clobTokenIds?: string[]    // per-outcome CLOB token IDs (hex)
  conditionId?: string       // market condition ID
  negRisk?: boolean          // NegRisk market flag
  // Legacy / compatibility
  eventSlug?: string
  bestBid?: number
  bestAsk?: number
  spread?: number
  orderPriceMinTickSize?: number
  orderMinSize?: number
}

export interface OrderBook {
  marketSlug?: string
  marketId?: string       // CLOB market/condition ID
  tokenId?: string        // CLOB token ID this book was fetched for
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
  marketSlug?: string
  tokenId?: string           // CLOB token ID
  side: 'BUY' | 'SELL'
  type: 'FOK' | 'GTC' | 'GTD' | 'IOC'
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
  marketSlug?: string
  tokenId?: string           // CLOB token ID (required for international CLOB)
  outcome?: 'yes' | 'no'
  side: 'BUY' | 'SELL'
  price: number
  size: number
  type?: 'FOK' | 'GTC' | 'GTD' | 'IOC' | 'FAK'
  negRisk?: boolean          // NegRisk flag for EIP-712 domain selection
  expiration?: string | number   // ISO8601 for GTD or Unix timestamp
  /** Post-only flag */
  postOnly?: boolean
  /** Deferred execution (CLOB) */
  deferExec?: boolean
  /** Internal: marks retry — prevents infinite loops */
  _retried?: boolean
}

export interface OrderResult {
  success: boolean
  orderId?: string
  txHash?: string       // CLOB transaction hash
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
  strategy: 'llm' | 'dip' | 'fw' | 'btc' | 'dual-side' | 'gabagool'
  stopLossPercent: number     // SL to apply when filled
  takeProfitPercent: number   // TP to apply when filled
  placedAt: number            // Date.now() at placement
  expiresAt: number           // Unix timestamp (ms) — matches goodTillTime
  status: 'pending' | 'filled' | 'cancelled' | 'expired'
  tokenId?: string            // CLOB token ID (passed to PLM on fill for WS subscribe)
  maxHoldMs?: number          // Max hold duration for PLM (passed on fill)
  takerFeeBps?: number        // Per-position taker fee for PLM
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
  provider: 'ollama'
  model: string
  temperature: number
  maxTokens: number
  secondaryModel?: string          // Different model for second opinion diversity
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

// Crypto Up/Down specific types
export interface BtcUpDownConfig {
  // Asset toggles
  enableBtc: boolean           // Trade Crypto Up/Down markets (default true)
  enableEth: boolean           // Trade ETH Up/Down markets (default false)
  enableSol: boolean           // Trade SOL Up/Down markets (default false)
  enableXrp: boolean           // Trade XRP Up/Down markets (default false)
  // Window duration toggles
  enable5m: boolean            // Trade 5-minute windows (default true)
  enable15m: boolean           // Trade 15-minute windows (default true)
  enableHourly: boolean        // Trade hourly windows (default true — primary focus)
  enable4h: boolean            // Trade 4-hour windows (default true — primary focus)
  enableDaily: boolean         // Trade daily windows (default false)
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
  // LLM signal fusion — independent LLM directional prediction fused with mechanical signal
  useLLMFusion: boolean        // Enable LLM fusion (takes priority over confirmation) (default false)
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
// GAMMA API TYPES (market discovery)
// ==========================================

export interface GammaEvent {
  id: string | number
  slug: string
  title: string
  description?: string
  startDate?: string
  endDate?: string
  active: boolean
  closed: boolean
  liquidity?: number
  volume?: number
  markets?: Market[]
  tags?: Array<{ id?: number; slug: string; label: string }>
  enableNegRisk?: boolean
  negRisk?: boolean
}

export interface GammaMarketsResponse {
  markets: Market[]
  next_cursor?: string
}

export interface GammaEventsResponse {
  events: GammaEvent[]
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
// PRICE HISTORY TYPES (CLOB /prices-history)
// ==========================================

export interface PriceHistoryOptions {
  interval: '1m' | '1h' | '6h' | '1d' | '1w' | 'max'
  startTs?: number    // Unix seconds
  endTs?: number      // Unix seconds
  fidelity?: number   // Seconds between data points
}

export interface PriceHistoryPoint {
  t: number   // Unix timestamp (seconds)
  p: number   // Price
}

export interface PriceHistoryResponse {
  history: PriceHistoryPoint[]
}

// ==========================================
// SPREAD TYPES
// ==========================================

export interface SpreadData {
  marketSlug?: string
  tokenId?: string
  bid: number
  ask: number
  spread: number
  timestamp: number
}

// ==========================================
// WEBSOCKET CHANNEL TYPES (CLOB)
// ==========================================

/** CLOB WebSocket market price change event */
export interface CLOBPriceChange {
  asset_id: string       // token ID
  price: string          // string decimal
  best_bid?: string
  best_ask?: string
  changes?: Array<{ price: string; side: string; size: string }>
}

/** CLOB WebSocket trade event (user channel) */
export interface CLOBTradeEvent {
  id: string
  asset_id: string
  maker_address?: string
  taker_address?: string
  side: string
  price: string
  size: string
  timestamp: string
  status: string
  trade_owner?: string
  type?: string
  /** Maker orders involved in this trade (for fill matching) */
  maker_orders?: Array<{ order_id: string; matched_amount?: string; asset_id?: string }>
  /** Market slug (if provided by server or resolved locally) */
  market_slug?: string
}

/** CLOB WebSocket order event (user channel) */
export interface CLOBOrderEvent {
  id: string
  asset_id: string
  side: string
  price: string
  original_size: string
  size_matched: string
  status: string
  maker_address?: string
  timestamp?: string
  /** Event type (e.g., 'CANCELLATION', 'PLACEMENT') */
  event_type?: string
  /** Order ID (may differ from id for some event shapes) */
  order_id?: string
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

export interface DualSideConfig {
  enabled: boolean
  tradeSize: number           // USD total for both legs combined
  biasRatio: number           // 0-1, fraction allocated to predicted winner
  makerOnly: boolean          // postOnly=true on GTC orders
  maxCombinedAsk: number      // reject if yesAsk + noAsk >= this
  requireBothLegs: boolean    // cancel filled leg if other doesn't fill
  limitPriceOffset: number    // cents below ask for maker status
  maxWaitForFillMs: number    // fill timeout before cancel
  minSignalConfidence: number // minimum signal.confidence to proceed
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

// ==========================================
// MULTI-STRATEGY BACKTEST TYPES
// ==========================================

export type BacktestStrategyType =
  | 'btc-updown'
  | 'dip-arb'
  | 'project-fw'
  | 'dual-side'
  | 'gabagool'
  | 'impulse-sniper'
  | 'llm-prediction'

/** Strategy-agnostic trade record for unified backtest results */
export interface UnifiedTradeRecord {
  timestamp: string
  strategy: BacktestStrategyType
  direction: string              // 'up'|'down' for BTC, 'yes'|'no' for DipArb, 'buy-all' for FW
  entryPrice: number             // total cost for multi-leg
  exitPrice: number              // payout or sell price
  pnl: number                    // net P&L after fees
  feePaid: number
  holdTimeMs: number
  metadata?: Record<string, unknown> // strategy-specific details
}

/** Result from backtesting a single strategy */
export interface StrategyBacktestResult {
  strategy: BacktestStrategyType
  strategyName: string
  trades: UnifiedTradeRecord[]
  summary: BacktestSummary
  dataSource: 'polybacktest' | 'snapshot-recorder' | 'synthetic'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>
}

/** Aggregated results from multi-strategy backtest run */
export interface MultiStrategyBacktestResult {
  strategies: StrategyBacktestResult[]
  combined: BacktestSummary
  correlationMatrix: Record<string, Record<string, number>>
  runTimestamp: string
}

/** Recorded market snapshot for offline backtesting (DipArb, ProjectFW) */
export interface RecordedSnapshot {
  timestamp: string
  marketId: string
  slug: string
  question: string
  outcomes: string[]
  outcomePrices: number[]           // mid-prices
  askPrices?: number[]              // best ask per outcome
  bidPrices?: number[]              // best bid per outcome
  volume24h?: number
  liquidity?: number
  clobTokenIds?: string[]
  conditionId?: string
  negRisk?: boolean
  resolved?: boolean
  winner?: string | null
}
