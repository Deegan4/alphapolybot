/**
 * MoonDevClient — API client for Moon Dev's Hyperliquid Data Layer
 *
 * Provides access to liquidation data, position snapshots near liquidation,
 * HLP sentiment, and order flow from api.moondev.com.
 *
 * Auth: X-API-Key header (free key from https://moondev.com)
 * Rate limit: 3,600 req/min
 * Data updates: every 30s
 */
import { BaseApiClient } from './BaseApiClient'

// ==========================================
// RESPONSE TYPES (matched to actual API docs)
// ==========================================

/** Individual position near liquidation */
export interface MoonDevPosition {
  address: string
  coin: string
  value: number           // position value in USD
  entry_price: number
  current_price: number
  liq_price: number       // liquidation price
  distance_pct: number    // % distance from current price to liquidation (ascending = closest first)
  leverage: number
  size: number            // position size in coin units
  pnl: number             // unrealized PnL in USD
}

/** GET /api/positions.json — top 50 longs + shorts sorted by distance_pct ascending */
export interface MoonDevPositionsResponse {
  updated_at: string
  total_positions: number
  total_longs: number
  total_shorts: number
  min_position_value: number
  price_source: string
  longs: MoonDevPosition[]
  shorts: MoonDevPosition[]
}

/** Position snapshot within 15% of liquidation */
export interface MoonDevPositionSnapshot {
  snapshot_time: number   // epoch ms
  user: string
  symbol: string
  side: 'long' | 'short'
  position_value: number
  entry_price: number
  liquidation_price: number
  current_price: number
  distance_pct: number    // % distance to liquidation
  leverage: number
}

/** GET /api/position_snapshots/symbol/{symbol} */
export interface MoonDevSnapshotsResponse {
  symbol: string
  snapshots: MoonDevPositionSnapshot[]
  count: number
}

/** GET /api/hlp/sentiment — per-coin HLP positioning with z-scores */
export interface MoonDevHLPSentimentResponse {
  timestamp: string
  net_delta: Record<string, {
    value: number         // net delta in USD
    z_score: number
    signal: string        // human-readable signal description
  }>
  overall_signal: string
  confidence: string      // 'high' | 'medium' | 'low'
}

/** Individual liquidation event from multi-exchange feed */
export interface MoonDevLiquidation {
  symbol: string
  side: string            // 'long'|'short'|'buy'|'sell'|'b'|'a'
  value: number           // USD value
  price: number
  timestamp: string | number
  exchange: string
}

/** GET /api/all_liquidations/{timeframe}.json — combined Hyperliquid+Binance+Bybit+OKX */
export interface MoonDevAllLiquidationsResponse {
  liquidations: MoonDevLiquidation[]
  count: number
}

/** GET /api/orderflow.json — order flow imbalance */
export interface MoonDevOrderFlowResponse {
  by_coin: Record<string, {
    buy_pressure: number   // 0-1
    cumulative_delta: number
  }>
}

/** GET /api/imbalance/{timeframe}.json — dollar imbalance by coin */
export interface MoonDevImbalanceResponse {
  by_coin: Record<string, {
    buy_volume_usd: number
    sell_volume_usd: number
    net_imbalance_usd: number
    imbalance_ratio: number  // -1 to 1
  }>
}

// ==========================================
// CLIENT
// ==========================================

export class MoonDevClient extends BaseApiClient {
  constructor() {
    super(import.meta.env.VITE_MOONDEV_API_URL || '/api/moondev', {
      maxRequestsPerMinute: 60, // conservative — API allows 3600
      maxRetries: 2,
      retryDelay: 1000,
      timeout: 15000,
    })
  }

  /** Set or update API key at runtime (from settingsStore). */
  setApiKey(key: string): void {
    if (key) {
      this.client.defaults.headers.common['X-API-Key'] = key
    } else {
      delete this.client.defaults.headers.common['X-API-Key']
    }
  }

  // ==================== POSITIONS NEAR LIQUIDATION ====================

  /** Top 50 longs + shorts sorted by distance_pct ascending (closest to liquidation first) */
  async getPositions(): Promise<MoonDevPositionsResponse> {
    return this.get<MoonDevPositionsResponse>('/api/positions.json')
  }

  /** Position snapshots within 15% of liquidation for a specific coin */
  async getPositionSnapshots(symbol = 'BTC'): Promise<MoonDevSnapshotsResponse> {
    return this.get<MoonDevSnapshotsResponse>(`/api/position_snapshots/symbol/${symbol}`)
  }

  // ==================== HLP SENTIMENT ====================

  /** HLP z-scores — retail positioning squeeze signals */
  async getHLPSentiment(): Promise<MoonDevHLPSentimentResponse> {
    return this.get<MoonDevHLPSentimentResponse>('/api/hlp/sentiment')
  }

  // ==================== MULTI-EXCHANGE LIQUIDATIONS ====================

  /** Combined liquidations from Hyperliquid, Binance, Bybit, OKX */
  async getAllLiquidations(timeframe = '10m'): Promise<MoonDevAllLiquidationsResponse> {
    return this.get<MoonDevAllLiquidationsResponse>(`/api/all_liquidations/${timeframe}.json`)
  }

  // ==================== ORDER FLOW ====================

  /** Order flow pressure and cumulative delta by coin */
  async getOrderFlow(): Promise<MoonDevOrderFlowResponse> {
    return this.get<MoonDevOrderFlowResponse>('/api/orderflow.json')
  }

  /** Dollar buy/sell imbalance by timeframe (5m, 15m, 1h, 4h, 24h) */
  async getImbalance(timeframe = '1h'): Promise<MoonDevImbalanceResponse> {
    return this.get<MoonDevImbalanceResponse>(`/api/imbalance/${timeframe}.json`)
  }

  // ==================== HEALTH ====================

  /** Health check (no auth required) */
  async health(): Promise<{ status: string }> {
    return this.get<{ status: string }>('/health')
  }
}

// Singleton
export const moonDevClient = new MoonDevClient()
