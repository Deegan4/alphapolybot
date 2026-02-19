/**
 * API client for PolyBacktest — historical BTC Up/Down market data and snapshots.
 *
 * Provides access to resolved/active markets, time-series price snapshots, and
 * full orderbook depth for backtesting the BTC Up/Down strategy.
 *
 * Docs: https://docs.polybacktest.com
 * Auth: X-API-Key header (keys from https://polybacktest.com/dashboard)
 */
import { BaseApiClient } from './BaseApiClient'
import type {
  PolyBacktestMarket,
  PolyBacktestMarketType,
  PolyBacktestSnapshot,
  PolyBacktestMarketsResponse,
  PolyBacktestSnapshotsResponse,
  PolyBacktestHealthResponse,
} from '@/types'

export class PolyBacktestClient extends BaseApiClient {
  constructor() {
    const apiKey = import.meta.env.VITE_POLYBACKTEST_API_KEY || ''
    super(import.meta.env.VITE_POLYBACKTEST_API_URL || '/api/polybacktest', {
      maxRequestsPerMinute: 60,
      maxRetries: 3,
      retryDelay: 1000,
      timeout: 15000,
      headers: apiKey ? { 'X-API-Key': apiKey } : {},
    })
  }

  /** Set or update API key at runtime (e.g. from settingsStore). */
  setApiKey(key: string): void {
    if (key) {
      this.client.defaults.headers.common['X-API-Key'] = key
    } else {
      delete this.client.defaults.headers.common['X-API-Key']
    }
  }

  /** Check if the client has an API key configured. */
  hasApiKey(): boolean {
    return !!this.client.defaults.headers.common['X-API-Key']
  }

  // ==========================================
  // HEALTH
  // ==========================================

  /** Health check — no auth required. */
  async health(): Promise<PolyBacktestHealthResponse> {
    return this.get<PolyBacktestHealthResponse>('/health')
  }

  // ==========================================
  // MARKETS
  // ==========================================

  /** List markets with optional filtering and pagination. */
  async getMarkets(params?: {
    limit?: number           // 1-100, default 50
    offset?: number
    market_type?: PolyBacktestMarketType
    resolved?: boolean
  }): Promise<PolyBacktestMarketsResponse> {
    return this.get<PolyBacktestMarketsResponse>('/v1/markets', { params })
  }

  /** Get a single market by ID. Falls back to condition_id search if 404. */
  async getMarket(marketId: string): Promise<PolyBacktestMarket> {
    try {
      return await this.get<PolyBacktestMarket>(`/v1/markets/${marketId}`)
    } catch (err) {
      if ((err as { status?: number }).status === 404 && marketId.startsWith('0x')) {
        // Might be a Polymarket condition_id — search for it
        return this.findByConditionId(marketId)
      }
      throw err
    }
  }

  /** Search markets by Polymarket condition_id (paginated scan). */
  private async findByConditionId(conditionId: string): Promise<PolyBacktestMarket> {
    let offset = 0
    const limit = 100
    const normalizedId = conditionId.toLowerCase()
    for (;;) {
      const page = await this.getMarkets({ limit, offset })
      const match = page.markets.find(
        m => m.condition_id?.toLowerCase() === normalizedId
          || m.clob_token_up?.toLowerCase() === normalizedId
          || m.clob_token_down?.toLowerCase() === normalizedId
      )
      if (match) return match
      offset += page.markets.length
      if (offset >= page.total || page.markets.length === 0) break
    }
    throw Object.assign(new Error(`No market found for condition/token ID: ${conditionId}`), { status: 404 })
  }

  /** Get a single market by slug (e.g. "btc-updown-15m-1707926400"). */
  async getMarketBySlug(slug: string): Promise<PolyBacktestMarket> {
    return this.get<PolyBacktestMarket>(`/v1/markets/by-slug/${encodeURIComponent(slug)}`)
  }

  // ==========================================
  // SNAPSHOTS
  // ==========================================

  /** Get paginated snapshots for a market (oldest-first). */
  async getSnapshots(marketId: string, params?: {
    limit?: number           // 1-1000, default 100
    offset?: number
    include_orderbook?: boolean
    start_time?: string      // ISO8601
    end_time?: string        // ISO8601
  }): Promise<PolyBacktestSnapshotsResponse> {
    return this.get<PolyBacktestSnapshotsResponse>(
      `/v1/markets/${marketId}/snapshots`,
      { params },
    )
  }

  /** Get snapshot closest to a specific timestamp (±2s tolerance). */
  async getSnapshotAt(marketId: string, timestamp: string): Promise<PolyBacktestSnapshot | null> {
    try {
      const resp = await this.get<{ market: PolyBacktestMarket; snapshots: PolyBacktestSnapshot[] }>(
        `/v1/markets/${marketId}/snapshot-at/${encodeURIComponent(timestamp)}`,
      )
      return resp.snapshots?.[0] ?? null
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null
      throw err
    }
  }

  // ==========================================
  // CONVENIENCE
  // ==========================================

  /**
   * Fetch ALL snapshots for a market with auto-pagination.
   * Uses 1000-per-page to minimize round-trips.
   */
  async getAllSnapshots(
    marketId: string,
    includeOrderbook = false,
    onProgress?: (fetched: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<PolyBacktestSnapshot[]> {
    const allSnapshots: PolyBacktestSnapshot[] = []
    let offset = 0
    const limit = 1000

    // First request to get total count
    const first = await this.getSnapshots(marketId, {
      limit, offset, include_orderbook: includeOrderbook,
    })
    allSnapshots.push(...first.snapshots)
    const total = first.total
    offset += first.snapshots.length
    onProgress?.(allSnapshots.length, total)

    // Paginate remaining
    while (offset < total) {
      signal?.throwIfAborted()
      const page = await this.getSnapshots(marketId, {
        limit, offset, include_orderbook: includeOrderbook,
      })
      if (page.snapshots.length === 0) break
      allSnapshots.push(...page.snapshots)
      offset += page.snapshots.length
      onProgress?.(allSnapshots.length, total)
    }

    return allSnapshots
  }

  /**
   * Fetch all resolved markets of a given type.
   * Auto-paginates with 100-per-page.
   */
  async getResolvedMarkets(
    marketType: PolyBacktestMarketType,
    signal?: AbortSignal,
  ): Promise<PolyBacktestMarket[]> {
    const allMarkets: PolyBacktestMarket[] = []
    let offset = 0
    const limit = 100

    for (;;) {
      signal?.throwIfAborted()
      const page = await this.getMarkets({
        limit, offset, market_type: marketType, resolved: true,
      })
      allMarkets.push(...page.markets)
      offset += page.markets.length
      if (offset >= page.total || page.markets.length === 0) break
    }

    return allMarkets
  }
}

export const polyBacktestClient = new PolyBacktestClient()
