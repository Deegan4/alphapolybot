import { BaseApiClient } from './BaseApiClient'
import type { Market, GammaMarketsResponse, GammaEvent, GammaEventsResponse } from '@/types'

/**
 * Normalize a raw market object from the Gamma API.
 *
 * The /events endpoint returns market fields differently than /markets:
 *   - outcomes, outcomePrices, clobTokenIds come as JSON strings (e.g. '["Yes","No"]')
 *   - volume, liquidity, volume24hr come as strings (e.g. "225665.41")
 *
 * This function safely parses all of these into proper typed values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeMarket(raw: any): Market {
  // Parse JSON-string arrays: '["Yes","No"]' → ["Yes","No"]
  const parseJsonArray = (val: unknown): unknown[] => {
    if (Array.isArray(val)) return val
    if (typeof val === 'string') {
      try { const parsed = JSON.parse(val); return Array.isArray(parsed) ? parsed : [] }
      catch { return [] }
    }
    return []
  }

  const outcomes = parseJsonArray(raw.outcomes).map(String)
  const clobTokenIds = parseJsonArray(raw.clobTokenIds).map(String)
  const outcomePrices = parseJsonArray(raw.outcomePrices).map(
    (p: unknown) => typeof p === 'string' ? parseFloat(p) : Number(p)
  )

  return {
    ...raw,
    outcomes,
    clobTokenIds,
    outcomePrices,
    volume: typeof raw.volume === 'string' ? parseFloat(raw.volume) || 0 : (raw.volume ?? 0),
    volume24hr: raw.volume24hr != null
      ? (typeof raw.volume24hr === 'string' ? parseFloat(raw.volume24hr) || 0 : raw.volume24hr)
      : undefined,
    liquidity: typeof raw.liquidity === 'string' ? parseFloat(raw.liquidity) || 0 : (raw.liquidity ?? 0),
    // Preserve negRisk flag (Gamma API returns enableNegRisk or neg_risk or negRisk)
    negRisk: Boolean(raw.negRisk ?? raw.enableNegRisk ?? raw.neg_risk ?? false),
  }
}

/**
 * Gamma API Client
 * Handles market discovery, metadata, and search
 * Endpoint: https://gamma-api.polymarket.com
 */
export class GammaClient extends BaseApiClient {
  // Response caches — multiple strategies scan the same data every 15-60s.
  // Short TTLs deduplicate redundant API calls while keeping data fresh.
  private marketsCache: { key: string; data: Market[]; expiresAt: number } | null = null
  private eventSlugCache = new Map<string, { data: GammaEvent | null; expiresAt: number }>()
  private static MARKETS_CACHE_TTL_MS = 30_000
  private static EVENT_CACHE_TTL_MS = 15_000

  constructor() {
    super(import.meta.env.VITE_GAMMA_API_URL || (import.meta.env.DEV ? '/api/gamma' : 'https://gamma-api.polymarket.com'), {
      maxRequestsPerMinute: 100,
      maxRetries: 3,
      timeout: 15000,
    })
  }

  /**
   * Get active markets with filtering and pagination
   */
  async getMarkets(options: {
    active?: boolean
    closed?: boolean
    limit?: number
    offset?: number
    sort?: 'volume24hr' | 'createdAt' | 'liquidity' | 'volume'
    order?: 'asc' | 'desc'
    cursor?: string
  } = {}): Promise<Market[]> {
    const {
      active = true,
      closed = false,
      limit = 100,
      offset,
      cursor,
    } = options

    const params = new URLSearchParams()
    params.set('active', String(active))
    params.set('closed', String(closed))
    params.set('limit', String(Math.min(limit, 100)))

    if (offset != null && offset > 0) {
      params.set('offset', String(offset))
    }

    if (cursor) {
      params.set('next_cursor', cursor)
    }

    // Check TTL cache — multiple strategies scan the same market list every 15-60s
    const cacheKey = params.toString()
    if (this.marketsCache && this.marketsCache.key === cacheKey && Date.now() < this.marketsCache.expiresAt) {
      return this.marketsCache.data
    }

    try {
      const response = await this.get<Market[] | GammaMarketsResponse>(`/markets?${params.toString()}`)

      // Handle both array response and object response
      const markets = Array.isArray(response) ? response : (response.markets || [])
      const normalized = markets.map(normalizeMarket)

      // Cache the result
      this.marketsCache = {
        key: cacheKey,
        data: normalized,
        expiresAt: Date.now() + GammaClient.MARKETS_CACHE_TTL_MS,
      }

      return normalized
    } catch (error) {
      console.error('Failed to fetch markets:', error)
      throw error
    }
  }

  /**
   * Get a single market by ID
   */
  async getMarket(marketId: string): Promise<Market | null> {
    try {
      const response = await this.get<Market>(`/markets/${marketId}`)
      return normalizeMarket(response)
    } catch (error) {
      console.error(`Failed to fetch market ${marketId}:`, error)
      return null
    }
  }

  /**
   * Get market by condition ID
   */
  async getMarketByConditionId(conditionId: string): Promise<Market | null> {
    try {
      const markets = await this.getMarkets({ limit: 100 })
      return markets.find(m => m.conditionId === conditionId) || null
    } catch (error) {
      console.error(`Failed to fetch market by condition ${conditionId}:`, error)
      return null
    }
  }

  /** Track whether /search has returned 401/403 so we skip it on subsequent calls */
  private searchDisabled = false

  /**
   * Search markets by query.
   * Falls back to slug-based lookup via /markets if /search returns 401.
   * After a single auth failure, skips /search entirely to avoid log spam.
   */
  async searchMarkets(query: string, limit = 20): Promise<Market[]> {
    // If /search already failed with 401/403, go straight to slug fallback
    if (this.searchDisabled) {
      return this.getMarketsBySlug(query)
    }

    try {
      const response = await this.get<{ markets?: Market[] }>(`/search?q=${encodeURIComponent(query)}&limit=${limit}`)
      // Normalize raw API response — /search returns JSON-string fields just like /events
      return (response.markets || []).map(normalizeMarket)
    } catch (error) {
      // /search may require auth — fall back to slug-based lookup
      const status = (error as { status?: number }).status
      if (status === 401 || status === 403) {
        console.warn(`[GammaClient] /search returned ${status}, permanently falling back to /markets?slug=`)
        this.searchDisabled = true
        return this.getMarketsBySlug(query)
      }
      console.error('Failed to search markets:', error)
      return []
    }
  }

  /**
   * Look up markets by exact slug via the /markets endpoint.
   * This endpoint doesn't require auth, unlike /search.
   */
  async getMarketsBySlug(slug: string): Promise<Market[]> {
    try {
      const response = await this.get<Market[] | { markets?: Market[] }>(
        `/markets?slug=${encodeURIComponent(slug)}`
      )
      const markets = Array.isArray(response) ? response : (response.markets || [])
      return markets.map(normalizeMarket)
    } catch (error) {
      console.error(`[GammaClient] Failed to fetch market by slug ${slug}:`, error)
      return []
    }
  }

  /**
   * Get active markets for scanning by fetching from the /events endpoint.
   * The /markets endpoint only returns ~16 standalone markets, but /events
   * contains thousands of active markets nested inside event objects.
   * Markets are flattened, deduplicated, and normalized before returning.
   */
  async getActiveMarkets(maxAgeHours?: number): Promise<Market[]> {
    try {
      const params = new URLSearchParams()
      params.set('active', 'true')
      params.set('closed', 'false')
      params.set('limit', '100')

      const response = await this.get<GammaEventsResponse | GammaEvent[]>(
        `/events?${params.toString()}`
      )

      // Handle both { events: [...] } and bare array responses
      const events: GammaEvent[] = Array.isArray(response)
        ? response
        : (response.events || [])

      // Flatten nested markets from all events and normalize field types.
      // The /events endpoint returns outcomes, outcomePrices, clobTokenIds
      // as JSON strings and volume/liquidity as string numbers.
      const allMarkets: Market[] = []
      const seenIds = new Set<string>()

      for (const event of events) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Gamma API event shape is loosely typed
        const markets = (event as any).markets || []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Gamma API negRisk field varies
        const eventNegRisk = Boolean((event as any).enableNegRisk ?? (event as any).negRisk ?? false)
        for (const raw of markets) {
          if (seenIds.has(raw.id)) continue
          // Inject event-level negRisk if market doesn't have its own
          if (eventNegRisk && !raw.negRisk && !raw.enableNegRisk && !raw.neg_risk) {
            raw.negRisk = true
          }
          const m = normalizeMarket(raw)
          if (!m.active || m.closed) continue
          seenIds.add(m.id)
          allMarkets.push(m)
        }
      }

      if (maxAgeHours == null) {
        return allMarkets
      }

      const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000)
      return allMarkets.filter(m => new Date(m.createdAt) > cutoff)
    } catch (error) {
      console.error('Failed to fetch active markets from events:', error)
      return []
    }
  }

  /**
   * Get events (market groups) with their nested markets
   */
  async getEvents(options: {
    active?: boolean
    limit?: number
  } = {}): Promise<GammaEvent[]> {
    const { active = true, limit = 50 } = options

    try {
      const params = new URLSearchParams()
      params.set('active', String(active))
      params.set('limit', String(limit))

      const response = await this.get<GammaEventsResponse | GammaEvent[]>(
        `/events?${params.toString()}`
      )
      return Array.isArray(response) ? response : (response.events || [])
    } catch (error) {
      console.error('Failed to fetch events:', error)
      return []
    }
  }

  /**
   * Get a single event by its exact slug.
   * Used for BTC/ETH/SOL Up/Down 15-min market discovery where slugs
   * follow the pattern: {asset}-updown-15m-{windowStartUnix}
   */
  async getEventBySlug(slug: string): Promise<GammaEvent | null> {
    // Check cache — usePolymarketPrices + strategies both call this for the same slug
    const cached = this.eventSlugCache.get(slug)
    if (cached && Date.now() < cached.expiresAt) return cached.data

    try {
      const response = await this.get<GammaEventsResponse | GammaEvent[]>(
        `/events?slug=${encodeURIComponent(slug)}`
      )
      const events: GammaEvent[] = Array.isArray(response)
        ? response
        : (response.events || [])

      if (events.length === 0) return null

      const event = events[0]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawMarkets = (event as any).markets || []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Gamma API negRisk field varies
      const eventNegRisk = Boolean((event as any).enableNegRisk ?? (event as any).negRisk ?? false)

      // Normalize nested markets (same pattern as getActiveMarkets)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event.markets = rawMarkets.map((raw: any) => {
        if (eventNegRisk && !raw.negRisk && !raw.enableNegRisk && !raw.neg_risk) {
          raw.negRisk = true
        }
        return normalizeMarket(raw)
      })

      this.eventSlugCache.set(slug, { data: event, expiresAt: Date.now() + GammaClient.EVENT_CACHE_TTL_MS })
      return event
    } catch (error) {
      console.error(`[GammaClient] Failed to fetch event by slug ${slug}:`, error)
      return null
    }
  }

  /**
   * Get binary markets suitable for dip arbitrage.
   *
   * DipArb profits from price dips where YES+NO < $1, then merges for
   * guaranteed profit. This does NOT require short-dated markets — the
   * merge itself locks in profit regardless of resolution date.
   *
   * Filters: binary (2 outcomes), has CLOB token IDs, has price data.
   * Volume/liquidity filtering is left to the strategy layer.
   */
  async getBinaryMarkets(): Promise<Market[]> {
    try {
      const allMarkets = await this.getActiveMarkets()

      return allMarkets.filter(market => {
        // Must be binary (exactly 2 outcomes) for dip arb merge
        if (!market.outcomes || market.outcomes.length !== 2) return false
        if (!market.clobTokenIds || market.clobTokenIds.length !== 2) return false
        // Must have price data
        if (!market.outcomePrices || market.outcomePrices.length !== 2) return false
        return true
      })
    } catch (error) {
      console.error('Failed to fetch binary markets:', error)
      return []
    }
  }

  /**
   * @deprecated Use getBinaryMarkets() instead.
   */
  async getCryptoMarkets(): Promise<Market[]> {
    return this.getBinaryMarkets()
  }

  /**
   * @deprecated Use getBinaryMarkets() instead.
   */
  async getShortTermMarkets(): Promise<Market[]> {
    return this.getBinaryMarkets()
  }
}

// Export singleton instance
export const gammaClient = new GammaClient()
