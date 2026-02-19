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
  type MarketBook,
  type MarketBBO,
  type GetEventsResponse,
  type GetOpenOrdersResponse,
  type GetUserPositionsResponse,
  type GetActivitiesResponse,
  type GetAccountBalancesResponse,
  type CancelAllOrdersResponse,
  type SearchResponse,
  type Event as SDKEvent,
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
  USEvent,
  UserActivity,
  Order,
  USOrderIntent,
} from '@/types/api'

import { resolveIntent, toApiPrice } from '@/types/api'

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

/** Convert SDK Event + its markets into our Market[] */
export function normalizeEventToMarkets(event: SDKEvent): Market[] {
  if (!event.markets || event.markets.length === 0) return []

  // US API has one Market per outcome. Group by event to build our unified Market.
  // For binary events, there are typically 2 SDK markets: one for "Yes", one for "No".
  // We combine them into a single Market with outcomes array.
  const outcomeNames = event.markets.map(m => m.outcome || m.title)
  const outcomeSlugs = event.markets.map(m => m.slug)
  const outcomePrices: number[] = event.markets.map(() => 0) // populated by getMarkets() via BBO

  return [{
    id: String(event.id),
    slug: event.slug,
    question: event.title,
    description: event.description,
    outcomes: outcomeNames,
    active: event.active,
    closed: event.closed,
    endDate: event.endTime || '',
    createdAt: event.startTime || '',
    volume: event.volume || 0,
    liquidity: event.liquidity || 0,
    outcomePrices,
    outcomeSlugs,
    eventSlug: event.slug,
    tags: event.tags?.map(t => t.label),
  }]
}

// ==========================================
// CLIENT
// ==========================================

export class PolymarketUSClient {
  private sdk: PolymarketUS | null = null
  private _keyId: string | null = null
  private _secretKey: string | null = null

  // Default base URLs — proxy in dev, direct in prod
  // SDK uses `new URL('/v1/...', base)` which only keeps the origin from base.
  // In dev, Vite proxies /v1/* to gamma-api.polymarket.com directly.
  private gatewayBaseUrl = import.meta.env.VITE_GATEWAY_URL
    || (import.meta.env.DEV ? `${location.protocol}//${location.host}` : 'https://gateway.polymarket.us')
  private apiBaseUrl = import.meta.env.DEV
    ? `${location.protocol}//${location.host}`
    : 'https://gamma-api.polymarket.com';

  // Defensive guard for malformed/empty URLs
  private getValidApiBaseUrl(): string {
    const fallback = import.meta.env.DEV
      ? `${location.protocol}//${location.host}`
      : 'https://gamma-api.polymarket.com';
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
    this.sdk = new PolymarketUS({
      keyId,
      secretKey,
      gatewayBaseUrl: this.gatewayBaseUrl,
      apiBaseUrl: this.getValidApiBaseUrl(),
    })
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
      this.sdk = new PolymarketUS({
        gatewayBaseUrl: this.gatewayBaseUrl,
        apiBaseUrl: this.getValidApiBaseUrl(),
      })
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

  /** Get markets from events, normalized to our Market type.
   *  Fetches BBO prices in parallel to populate outcomePrices. */
  async getMarkets(params?: {
    active?: boolean
    closed?: boolean
    categories?: string[]
    liquidityMin?: number
    volumeMin?: number
    limit?: number
    offset?: number
  }): Promise<Market[]> {
    const events = await this.getEvents(params)
    const markets = events.flatMap(e => normalizeEventToMarkets(e as unknown as SDKEvent))

    // Fetch BBO prices for all outcome slugs in parallel (batch of concurrent requests).
    // Each market has outcomeSlugs[] matching its outcomes[]. BBO gives us mid-price per outcome.
    const sdk = this.getSDK()
    const bboPromises: Array<{ marketIdx: number; outcomeIdx: number; promise: Promise<MarketBBO> }> = []

    for (let mi = 0; mi < markets.length; mi++) {
      const m = markets[mi]
      if (!m.outcomeSlugs) continue
      for (let oi = 0; oi < m.outcomeSlugs.length; oi++) {
        bboPromises.push({
          marketIdx: mi,
          outcomeIdx: oi,
          promise: sdk.markets.bbo(m.outcomeSlugs[oi]),
        })
      }
    }

    // Settle all — failures just leave price at 0 (scanner will reject those markets gracefully)
    const settled = await Promise.allSettled(bboPromises.map(b => b.promise))
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]
      if (result.status === 'fulfilled') {
        const bbo = result.value
        const { marketIdx, outcomeIdx } = bboPromises[i]
        const bid = amountToNumber(bbo.bestBid)
        const ask = amountToNumber(bbo.bestAsk)
        const mid = (bid + ask) / 2
        // Use mid-price as the outcome price (consistent with old Gamma behavior)
        markets[marketIdx].outcomePrices[outcomeIdx] = mid || amountToNumber(bbo.lastTradePx)
      }
    }

    return markets
  }

  /** Get a single market detail by slug */
  async getMarketBySlug(slug: string): Promise<Market | null> {
    try {
      const sdk = this.getSDK()
      const resp = await sdk.markets.retrieveBySlug(slug)
      const m = resp.market
      return {
        id: String(m.id),
        slug: m.slug,
        question: m.title,
        description: m.description,
        outcomes: [m.outcome],
        active: m.active,
        closed: m.closed,
        endDate: '',
        createdAt: '',
        volume: m.volume || 0,
        liquidity: m.liquidity || 0,
        outcomePrices: [],
        eventSlug: m.eventSlug,
      }
    } catch {
      return null
    }
  }

  /** Search markets by query text */
  async searchMarkets(query: string, limit = 20): Promise<Market[]> {
    const sdk = this.getSDK()
    const resp: SearchResponse = await sdk.search.query({ query, limit })
    return resp.events.flatMap(normalizeEventToMarkets)
  }

  /** Get full order book for a market */
  async getOrderBook(slug: string): Promise<OrderBook | null> {
    try {
      const sdk = this.getSDK()
      const book: MarketBook = await sdk.markets.book(slug)
      return {
        marketSlug: book.marketSlug,
        bids: book.bids.map(l => ({
          price: amountToNumber(l.px),
          size: parseFloat(l.qty) || 0,
        })),
        asks: book.offers.map(l => ({
          price: amountToNumber(l.px),
          size: parseFloat(l.qty) || 0,
        })),
        lastUpdate: book.transactTime ? new Date(book.transactTime).getTime() : Date.now(),
        state: book.state,
        stats: book.stats ? {
          lastTradePx: amountToNumber(book.stats.lastTradePx),
          sharesTraded: parseFloat(book.stats.sharesTraded || '0'),
          openInterest: parseFloat(book.stats.openInterest || '0'),
          highPx: amountToNumber(book.stats.highPx),
          lowPx: amountToNumber(book.stats.lowPx),
        } : undefined,
      }
    } catch {
      return null
    }
  }

  /** Get best bid/ask for a market */
  async getBestPrices(slug: string): Promise<PriceData | null> {
    try {
      const sdk = this.getSDK()
      const bbo: MarketBBO = await sdk.markets.bbo(slug)
      const bid = amountToNumber(bbo.bestBid)
      const ask = amountToNumber(bbo.bestAsk)
      const last = amountToNumber(bbo.lastTradePx)
      const mid = (bid + ask) / 2
      return {
        bid,
        ask,
        last: last || mid,
        mid,
        spread: ask - bid,
        timestamp: new Date(),
      }
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

      const avgPrice = filledSize > 0 ? totalValue / filledSize : 0
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
    const bal = resp.balances?.[0]
    return {
      balance: bal?.currentBalance || 0,
      buyingPower: bal?.buyingPower || 0,
    }
  }

  /** Get positions, optionally filtered by market slug */
  async getPositions(marketSlug?: string): Promise<Position[]> {
    const sdk = this.getAuthSDK()
    const resp: GetUserPositionsResponse = await sdk.portfolio.positions(
      marketSlug ? { market: marketSlug } : undefined
    )

    const positions: Position[] = []
    for (const [slug, pos] of Object.entries(resp.positions)) {
      const netPos = parseFloat(pos.netPosition || '0')
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
