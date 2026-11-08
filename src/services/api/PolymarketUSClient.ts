/**
 * PolymarketUSClient — Unified API client for Polymarket US.
 *
 * Wraps the official `polymarket-us` SDK to normalize responses
 * into our app's type system (Market, Position, Order, etc.).
 *
 * The SDK handles Ed25519 signing internally — no separate auth module needed.
 *
 * Usage:
 *   polymarketUSClient.setCredentials(keyId, secretKey)
 *   const markets = await polymarketUSClient.getMarkets()
 *   const result = await polymarketUSClient.placeOrder({ ... })
 */

import {
  PolymarketUS,
  type CreateOrderParams,
  type CreateOrderResponse,
  type ClosePositionResponse,
  type GetEventsResponse,
  type GetOpenOrdersResponse,
  type GetUserPositionsResponse,
  type GetActivitiesResponse,
  type GetAccountBalancesResponse,
  type CancelAllOrdersResponse,
  type SearchResponse,
  type Order as SDKOrder,
  type Amount,
} from 'polymarket-us'

import type {
  Market,
  OrderBook,
  OrderRequest,
  OrderResult,
  Position,
  PriceData,
  SpreadData,
  Trade,
  USEvent,
  UserActivity,
  Order,
  USOrderIntent,
} from '@/types/api'

import { resolveIntent, toApiPrice } from '@/types/api'
import {
  normalizeEventToMarkets,
  normalizeWireMarket,
  unwrapMarketData,
  statsFromBbo,
  rankForStats,
  priceDataFromBbo,
  orderBookFromWire,
  reportedPriceForOutcome,
  netPositionQty,
  qtyBought,
  usdBalance,
  type WirePositionQty,
  type WireEvent,
  type WireMarket,
  type WireBBO,
  type WireBook,
} from './pmusWire'
import { throttleSdk, sharedBuckets } from './requestThrottle'

// ==========================================
// HELPERS
// ==========================================

/** Parse SDK Amount to number */
function amountToNumber(a?: Amount | null): number {
  if (!a) return 0
  return parseFloat(a.value) || 0
}

/** Map SDK TIF strings to our short form */
function mapTIF(tif?: string): 'FOK' | 'GTC' | 'GTD' | 'IOC' {
  switch (tif) {
    case 'TIME_IN_FORCE_FILL_OR_KILL': return 'FOK'
    case 'TIME_IN_FORCE_GOOD_TILL_DATE': return 'GTD'
    case 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL': return 'IOC'
    default: return 'GTC'
  }
}

/** Map our short TIF to SDK enum */
function toSDKTIF(tif?: string): string {
  switch (tif) {
    case 'FOK': return 'TIME_IN_FORCE_FILL_OR_KILL'
    case 'GTD': return 'TIME_IN_FORCE_GOOD_TILL_DATE'
    case 'IOC': return 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL'
    default: return 'TIME_IN_FORCE_GOOD_TILL_CANCEL'
  }
}

/** Map SDK OrderState to our status */
function mapOrderStatus(state?: string): Order['status'] {
  switch (state) {
    case 'ORDER_STATE_NEW':
    case 'ORDER_STATE_PENDING_NEW':
    case 'ORDER_STATE_PENDING_RISK':
      return 'pending'
    case 'ORDER_STATE_PARTIALLY_FILLED':
      return 'open'
    case 'ORDER_STATE_FILLED':
      return 'filled'
    case 'ORDER_STATE_CANCELED':
    case 'ORDER_STATE_REPLACED':
      return 'cancelled'
    case 'ORDER_STATE_EXPIRED':
      return 'expired'
    case 'ORDER_STATE_REJECTED':
      return 'failed'
    default:
      return 'pending'
  }
}

/** Convert SDK Order to our Order type */
function normalizeOrder(o: SDKOrder): Order {
  return {
    id: o.id,
    marketSlug: o.marketSlug,
    side: o.side === 'ORDER_SIDE_BUY' ? 'BUY' : 'SELL',
    type: mapTIF(o.tif),
    intent: o.intent as USOrderIntent,
    price: amountToNumber(o.price),
    size: o.quantity,
    filledSize: o.cumQuantity,
    remainingSize: o.leavesQuantity,
    status: mapOrderStatus(o.state),
    createdAt: new Date(o.createTime || o.insertTime || Date.now()),
    updatedAt: o.insertTime ? new Date(o.insertTime) : undefined,
    avgPrice: amountToNumber(o.avgPx),
  }
}

// Event → Market normalization lives in ./pmusWire (pure, tested against live fixtures)
export { normalizeEventToMarkets }

// ==========================================
// CLIENT
// ==========================================

export class PolymarketUSClient {
  private sdk: PolymarketUS | null = null
  private _keyId: string | null = null
  private _secretKey: string | null = null

  // Default base URLs — same-origin in dev (Vite proxies /v1/*, see vite.config.ts),
  // direct to Polymarket US in prod. The SDK uses `new URL('/v1/...', base)`, which
  // only keeps the origin from base.
  //   gateway (public market data): https://gateway.polymarket.us
  //   api (authenticated: orders, portfolio, WebSocket): https://api.polymarket.us
  private gatewayBaseUrl = import.meta.env.VITE_GATEWAY_URL
    || (import.meta.env.DEV ? `${location.protocol}//${location.host}` : 'https://gateway.polymarket.us')
  private apiBaseUrl = import.meta.env.VITE_API_URL
    || (import.meta.env.DEV ? `${location.protocol}//${location.host}` : 'https://api.polymarket.us')

  // Defensive guard for malformed/empty URLs
  private getValidApiBaseUrl(): string {
    const fallback = import.meta.env.DEV
      ? `${location.protocol}//${location.host}`
      : 'https://api.polymarket.us'
    const url = this.apiBaseUrl;
    if (!url || typeof url !== 'string' || url.trim() === '') {
      console.error('[PolymarketUSClient] Invalid or missing API base URL. Using fallback.');
      return fallback;
    }
    try {
      new URL(url);
      return url;
    } catch (e) {
      console.error('[PolymarketUSClient] Malformed API base URL:', url, e);
      return fallback;
    }
  }

  // ==========================================
  // CREDENTIAL MANAGEMENT
  // ==========================================

  setCredentials(keyId: string, secretKey: string): void {
    this._keyId = keyId
    this._secretKey = secretKey
    this.sdk = throttleSdk(new PolymarketUS({
      keyId,
      secretKey,
      gatewayBaseUrl: this.gatewayBaseUrl,
      apiBaseUrl: this.getValidApiBaseUrl(),
    }))
  }

  hasCredentials(): boolean {
    return !!(this._keyId && this._secretKey)
  }

  getCredentials(): { keyId: string; secretKey: string } | null {
    if (!this._keyId || !this._secretKey) return null
    return { keyId: this._keyId, secretKey: this._secretKey }
  }

  /** Validate credentials by calling getBalances(). Returns {valid, error?} */
  async validateCredentials(): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.getBalances()
      return { valid: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { valid: false, error: message }
    }
  }

  /** Get or create SDK instance. Throws if no credentials set. */
  private getSDK(): PolymarketUS {
    if (!this.sdk) {
      // Allow unauthenticated reads (market data)
      this.sdk = throttleSdk(new PolymarketUS({
        gatewayBaseUrl: this.gatewayBaseUrl,
        apiBaseUrl: this.getValidApiBaseUrl(),
      }))
    }
    return this.sdk
  }

  /** Get SDK with credentials required. Throws if not set. */
  private getAuthSDK(): PolymarketUS {
    if (!this._keyId || !this._secretKey) {
      throw new Error('Polymarket US credentials not configured. Set them in Settings.')
    }
    return this.getSDK()
  }

  // ==========================================
  // MARKET DATA (public — no auth required)
  // ==========================================

  /** Get events with optional filters */
  async getEvents(params?: {
    active?: boolean
    closed?: boolean
    categories?: string[]
    liquidityMin?: number
    volumeMin?: number
    limit?: number
    offset?: number
  }): Promise<USEvent[]> {
    const sdk = this.getSDK()
    const resp: GetEventsResponse = await sdk.events.list(params)
    return resp.events as USEvent[]
  }

  /** Get event by slug */
  async getEventBySlug(slug: string): Promise<USEvent | null> {
    try {
      const sdk = this.getSDK()
      const resp = await sdk.events.retrieveBySlug(slug)
      return resp.event as USEvent
    } catch {
      return null
    }
  }

  /**
   * Markets from events, one binary Market per tradeable slug. Prices come
   * from the quotes inline in the event listing. With `withStats`, volume /
   * liquidity proxies are filled from BBOs (rate-limit aware, see attachStats)
   * — the gateway exposes them nowhere else.
   */
  async getMarkets(params?: {
    active?: boolean
    closed?: boolean
    categories?: string[]
    liquidityMin?: number
    volumeMin?: number
    limit?: number
    offset?: number
    withStats?: boolean
  }): Promise<Market[]> {
    const { withStats, ...query } = params ?? {}
    const events = await this.getEvents(query)
    const markets = events.flatMap(e => normalizeEventToMarkets(e as unknown as WireEvent))
    if (withStats) await this.attachStats(markets)
    return markets
  }

  private statsCache = new Map<string, { volume: number; liquidity: number; at: number }>()
  private statsBackoffUntil = 0
  private static readonly STATS_TTL_MS = 15 * 60 * 1000
  private static readonly STATS_BACKOFF_MS = 5 * 60 * 1000

  /**
   * Fill volume / liquidity from market BBOs. The gateway is behind a
   * Cloudflare rate limit (HTTP 429 / error 1015 bans the IP for minutes).
   * All SDK calls already pass through the shared throttle (requestThrottle),
   * and stats are the lowest-priority traffic, so this is frugal too: cached
   * values first, then at most `budget` uncached markets per call — tightest
   * spreads first (rankForStats). Coverage grows across refreshes. A 429
   * pauses stats lookups for 5 minutes. Failures leave 0.
   */
  async attachStats(markets: Market[], budget = 25, concurrency = 2): Promise<void> {
    const now = Date.now()
    const uncached: Market[] = []
    for (const m of markets) {
      const cached = this.statsCache.get(m.slug)
      if (cached && now - cached.at < PolymarketUSClient.STATS_TTL_MS) {
        m.volume = cached.volume
        m.liquidity = cached.liquidity
      } else {
        uncached.push(m)
      }
    }
    if (now < this.statsBackoffUntil || now < sharedBuckets.gateway.pausedUntil) return

    const todo = rankForStats(uncached).slice(0, budget)
    const sdk = this.getSDK()
    let next = 0
    const worker = async () => {
      while (next < todo.length && Date.now() >= this.statsBackoffUntil && Date.now() >= sharedBuckets.gateway.pausedUntil) {
        const m = todo[next++]
        try {
          const stats = statsFromBbo(unwrapMarketData<WireBBO>(await sdk.markets.bbo(m.slug)))
          m.volume = stats.volume
          m.liquidity = stats.liquidity
          this.statsCache.set(m.slug, { ...stats, at: Date.now() })
        } catch (err) {
          if ((err as { status?: number })?.status === 429) {
            this.statsBackoffUntil = Date.now() + PolymarketUSClient.STATS_BACKOFF_MS
            console.warn('[PolymarketUSClient] Gateway rate limit hit — pausing market stats lookups for 5 min')
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
  }

  /**
   * Single market by slug. Expired markets are no longer served by the
   * market endpoint, so fall back to the settlement endpoint and report the
   * market closed with outcomePrices [yesSettle, noSettle].
   */
  async getMarketBySlug(slug: string): Promise<Market | null> {
    const sdk = this.getSDK()
    try {
      const resp = await sdk.markets.retrieveBySlug(slug)
      return normalizeWireMarket(resp.market as unknown as WireMarket)
    } catch {
      // fall through to settlement
    }
    try {
      const st = (await sdk.markets.settlement(slug)) as unknown as { settlement?: number | string }
      const yes = Number(st.settlement)
      if (!Number.isFinite(yes)) return null
      return {
        id: slug,
        slug,
        question: slug,
        outcomes: ['Yes', 'No'],
        outcomeSlugs: [slug, slug],
        outcomePrices: [yes, 1 - yes],
        active: false,
        closed: true,
        endDate: '',
        createdAt: '',
        volume: 0,
        liquidity: 0,
      }
    } catch {
      return null
    }
  }

  /** Search markets by query text */
  async searchMarkets(query: string, limit = 20): Promise<Market[]> {
    const sdk = this.getSDK()
    const resp: SearchResponse = await sdk.search.query({ query, limit })
    return resp.events.flatMap(e => normalizeEventToMarkets(e as unknown as WireEvent))
  }

  /** Full YES-side order book (use bookForOutcome for NO terms) */
  async getOrderBook(slug: string): Promise<OrderBook | null> {
    try {
      const sdk = this.getSDK()
      return orderBookFromWire(unwrapMarketData<WireBook>(await sdk.markets.book(slug)))
    } catch {
      return null
    }
  }

  /** YES-side best bid/ask (use priceForOutcome for NO terms) */
  async getBestPrices(slug: string): Promise<PriceData | null> {
    try {
      const sdk = this.getSDK()
      const pd = priceDataFromBbo(unwrapMarketData<WireBBO>(await sdk.markets.bbo(slug)))
      return pd.bid > 0 || pd.ask > 0 || pd.last > 0 ? pd : null
    } catch {
      return null
    }
  }

  /** Get spread data for a market */
  async getSpread(slug: string): Promise<SpreadData | null> {
    const prices = await this.getBestPrices(slug)
    if (!prices) return null
    return {
      marketSlug: slug,
      bid: prices.bid,
      ask: prices.ask,
      spread: prices.spread,
      timestamp: prices.timestamp.getTime(),
    }
  }

  // ==========================================
  // TRADING (authenticated)
  // ==========================================

  /** Place an order. Maps our OrderRequest to SDK CreateOrderParams. */
  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    const sdk = this.getAuthSDK()
    const intent = resolveIntent(request.side, request.outcome)
    const apiPrice = toApiPrice(request.price, request.outcome)

    const params: CreateOrderParams = {
      marketSlug: request.marketSlug,
      intent,
      type: 'ORDER_TYPE_LIMIT',
      price: { value: apiPrice.toFixed(2), currency: 'USD' },
      quantity: request.size,
      tif: toSDKTIF(request.type) as any,
      manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
      synchronousExecution: true,
      maxBlockTime: '5s',
    }

    if (request.postOnly) {
      params.participateDontInitiate = true
    }

    if (request.expiration) {
      params.goodTillTime = request.expiration
    }

    try {
      const resp: CreateOrderResponse = await sdk.orders.create(params)
      const executions = resp.executions?.map(e => ({
        id: e.id,
        lastShares: e.lastShares,
        lastPx: amountToNumber(e.lastPx),
        type: e.type,
      }))

      // Calculate filled size from executions
      let filledSize = 0
      let totalValue = 0
      for (const e of resp.executions || []) {
        const shares = parseFloat(e.lastShares || '0')
        const px = amountToNumber(e.lastPx)
        filledSize += shares
        totalValue += shares * px
      }

      // Fills are reported YES-side; callers work in the order's outcome terms
      const avgPrice = filledSize > 0
        ? reportedPriceForOutcome(totalValue / filledSize, request.outcome, request.price)
        : 0
      const pending = request.type === 'GTC' || request.type === 'GTD'

      return {
        success: true,
        orderId: resp.id,
        filledSize: filledSize || undefined,
        avgPrice: avgPrice || undefined,
        pending: pending && filledSize === 0,
        executions,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Order failed'
      return { success: false, error: message }
    }
  }

  /** Place a Fill-Or-Kill order */
  async placeFOKOrder(request: Omit<OrderRequest, 'type'>): Promise<OrderResult> {
    return this.placeOrder({ ...request, type: 'FOK' })
  }

  /** Place a Good-Till-Cancel order */
  async placeGTCOrder(request: Omit<OrderRequest, 'type'>): Promise<OrderResult> {
    return this.placeOrder({ ...request, type: 'GTC' })
  }

  /** Cancel a specific order */
  async cancelOrder(orderId: string, marketSlug: string): Promise<boolean> {
    try {
      const sdk = this.getAuthSDK()
      await sdk.orders.cancel(orderId, { marketSlug })
      return true
    } catch {
      return false
    }
  }

  /** Cancel all open orders, optionally filtered by slugs */
  async cancelAllOrders(slugs?: string[]): Promise<string[]> {
    try {
      const sdk = this.getAuthSDK()
      const resp: CancelAllOrdersResponse = await sdk.orders.cancelAll(
        slugs ? { slugs } : undefined
      )
      return resp.canceledOrderIds
    } catch {
      return []
    }
  }

  /** Close an entire position on a market */
  async closePosition(slug: string, slippageBips?: number): Promise<OrderResult> {
    try {
      const sdk = this.getAuthSDK()
      const params: any = {
        marketSlug: slug,
        manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
        synchronousExecution: true,
        maxBlockTime: '5s',
      }
      if (slippageBips) {
        params.slippageTolerance = { bips: slippageBips }
      }
      const resp: ClosePositionResponse = await sdk.orders.closePosition(params)
      return {
        success: true,
        orderId: resp.id,
        executions: resp.executions?.map(e => ({
          id: e.id,
          lastShares: e.lastShares,
          lastPx: amountToNumber(e.lastPx),
          type: e.type,
        })),
      }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Close failed' }
    }
  }

  /** Get open orders */
  async getOpenOrders(slugs?: string[]): Promise<Order[]> {
    const sdk = this.getAuthSDK()
    const resp: GetOpenOrdersResponse = await sdk.orders.list(
      slugs ? { slugs } : undefined
    )
    return resp.orders.map(normalizeOrder)
  }

  /** Get a specific order by ID */
  async getOrder(orderId: string): Promise<Order | null> {
    try {
      const sdk = this.getAuthSDK()
      const resp = await sdk.orders.retrieve(orderId)
      return normalizeOrder(resp.order)
    } catch {
      return null
    }
  }

  // ==========================================
  // ACCOUNT & PORTFOLIO (authenticated)
  // ==========================================

  /** Get account balances */
  async getBalances(): Promise<{ balance: number; buyingPower: number }> {
    const sdk = this.getAuthSDK()
    const resp: GetAccountBalancesResponse = await sdk.account.balances()
    const bal = usdBalance(resp.balances)
    return {
      balance: bal?.currentBalance || 0,
      buyingPower: bal?.buyingPower || 0,
    }
  }

  /**
   * All position entries, following `nextCursor` until `eof` (100 per page).
   * Keyed by market slug.
   */
  private async fetchAllPositions(marketSlug?: string): Promise<Array<[string, GetUserPositionsResponse['positions'][string]]>> {
    const sdk = this.getAuthSDK()
    const out: Array<[string, GetUserPositionsResponse['positions'][string]]> = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const params: Record<string, unknown> = { limit: 100 }
      if (marketSlug) params.market = marketSlug
      if (cursor) params.cursor = cursor
      const resp = (await sdk.portfolio.positions(params as never)) as GetUserPositionsResponse & { nextCursor?: string; eof?: boolean }
      out.push(...Object.entries(resp.positions ?? {}))
      if (resp.eof !== false || !resp.nextCursor || resp.nextCursor === cursor) break
      cursor = resp.nextCursor
    }
    return out
  }

  /** Get positions, optionally filtered by market slug */
  async getPositions(marketSlug?: string): Promise<Position[]> {
    const entries = await this.fetchAllPositions(marketSlug)

    const positions: Position[] = []
    for (const [slug, pos] of entries) {
      // Decimal field first: the integer one is rounded (a 0.5 position reads 0 or 1)
      const netPos = netPositionQty(pos as WirePositionQty)
      if (netPos === 0) continue

      const cost = amountToNumber(pos.cost)
      const realized = amountToNumber(pos.realized)
      const entryPrice = netPos !== 0 ? Math.abs(cost) / Math.abs(netPos) : 0
      const currentPrice = amountToNumber(pos.cashValue) / Math.abs(netPos) || entryPrice
      const unrealized = (currentPrice - entryPrice) * netPos
      const unrealizedPct = entryPrice > 0 ? (unrealized / (entryPrice * Math.abs(netPos))) * 100 : 0

      positions.push({
        marketSlug: slug,
        marketQuestion: pos.marketMetadata?.title || slug,
        outcome: netPos > 0 ? 'yes' : 'no',
        size: Math.abs(netPos),
        entryPrice,
        currentPrice,
        cost: Math.abs(cost),
        realized,
        pnl: {
          dollar: unrealized,
          percent: unrealizedPct,
        },
        entryTime: pos.updateTime ? new Date(pos.updateTime) : new Date(),
        lastUpdate: pos.updateTime ? new Date(pos.updateTime) : new Date(),
      })
    }
    return positions
  }

  /**
   * Closed (fully exited or resolved) positions: net position is zero but the
   * account traded the market. Used by the Portfolio "Closed" tab.
   */
  async getClosedPositions(limit = 50): Promise<Position[]> {
    const entries = await this.fetchAllPositions()

    const closed: Position[] = []
    for (const [slug, pos] of entries) {
      const netPos = netPositionQty(pos as WirePositionQty)
      const bought = qtyBought(pos as WirePositionQty)
      if (netPos !== 0 || bought <= 0) continue

      const cost = Math.abs(amountToNumber(pos.cost))
      const realized = amountToNumber(pos.realized)
      const entryPrice = bought > 0 ? cost / bought : 0
      const when = pos.updateTime ? new Date(pos.updateTime) : new Date()

      closed.push({
        marketSlug: slug,
        marketQuestion: pos.marketMetadata?.title || slug,
        outcome: 'yes',          // side is not recoverable once flat; display only
        size: 0,
        entryPrice,
        currentPrice: 0,
        cost,
        realized,
        pnl: {
          dollar: realized,
          percent: cost > 0 ? (realized / cost) * 100 : 0,
        },
        entryTime: when,
        lastUpdate: when,
      })
    }
    return closed
      .sort((a, b) => b.lastUpdate.getTime() - a.lastUpdate.getTime())
      .slice(0, limit)
  }

  /** Recent account fills (all strategies / manual), newest first */
  async getRecentTrades(limit = 10): Promise<Trade[]> {
    const sdk = this.getAuthSDK()
    const resp: GetActivitiesResponse = await sdk.portfolio.activities({ limit: Math.max(limit * 2, limit) })

    const trades: Trade[] = []
    for (const a of resp.activities) {
      if (a.type !== 'ACTIVITY_TYPE_TRADE' || !a.trade) continue
      const t = a.trade
      trades.push({
        id: t.id,
        marketSlug: t.marketSlug,
        price: amountToNumber(t.price),
        size: parseFloat(t.qty || '0'),
        timestamp: new Date(t.createTime || t.updateTime || Date.now()),
        realizedPnl: t.realizedPnl ? amountToNumber(t.realizedPnl) : undefined,
      })
      if (trades.length >= limit) break
    }
    return trades
  }

  /** Get account activities */
  async getActivities(limit = 50): Promise<UserActivity[]> {
    const sdk = this.getAuthSDK()
    const resp: GetActivitiesResponse = await sdk.portfolio.activities({ limit })

    return resp.activities.map((a, i) => {
      let type: UserActivity['type'] = 'trade'
      if (a.type === 'ACTIVITY_TYPE_TRADE') type = 'trade'
      else if (a.type === 'ACTIVITY_TYPE_POSITION_RESOLUTION') type = 'resolution'
      else if (a.type === 'ACTIVITY_TYPE_ACCOUNT_DEPOSIT' || a.type === 'ACTIVITY_TYPE_ACCOUNT_ADVANCED_DEPOSIT') type = 'deposit'
      else if (a.type === 'ACTIVITY_TYPE_ACCOUNT_WITHDRAWAL') type = 'withdrawal'
      else if (a.type === 'ACTIVITY_TYPE_REFERRAL_BONUS') type = 'referral'
      else if (a.type === 'ACTIVITY_TYPE_TRANSFER') type = 'transfer'

      const trade = a.trade
      return {
        id: trade?.id || `activity-${i}`,
        type,
        amount: trade ? amountToNumber(trade.price) * parseFloat(trade.qty || '0') : 0,
        timestamp: trade?.createTime || trade?.updateTime || new Date().toISOString(),
        marketSlug: trade?.marketSlug,
      }
    })
  }

  // ==========================================
  // WEBSOCKET FACTORY
  // ==========================================

  /** Get WebSocket options for creating WS connections */
  getWebSocketOptions(): { keyId: string; secretKey: string; baseUrl: string } | null {
    if (!this._keyId || !this._secretKey) return null
    return {
      keyId: this._keyId,
      secretKey: this._secretKey,
      baseUrl: this.apiBaseUrl,
    }
  }
}

// Singleton
export const polymarketUSClient = new PolymarketUSClient()
