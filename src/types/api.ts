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
  conditionId?: string
}

export interface OrderResult {
  success: boolean
  orderId?: string
  txHash?: string
  error?: string
  filledSize?: number
  avgPrice?: number
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

// LLM Prediction specific types
export interface LLMPredictionConfig {
  baseSize: number
  confidenceMultiplier: number
  maxPositionSize: number
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
}

// ==========================================
// API RESPONSE TYPES
// ==========================================

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
