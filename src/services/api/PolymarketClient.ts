/**
 * PolymarketClient — Unified facade for international Polymarket.
 *
 * Delegates:
 *   - Market data → GammaClient (getEvents, getMarkets, searchMarkets, etc.)
 *   - Trading → CLOBClient (placeOrder, cancelOrder, getOpenOrders, etc.)
 *   - Order book → CLOBClient (getOrderBook, getBestPrices, getSpread)
 *   - Balances → CLOBClient (getBalanceAllowance)
 *   - Credentials → CLOBClient (setWallet, deriveApiKey, validateCredentials)
 *
 * Maintains a slug→tokenId cache for bridging between Gamma's slug-based
 * identifiers and the CLOB's token-based identifiers.
 */

import type {
  Market,
  OrderRequest,
  OrderResult,
  OrderBook,
  Order,
  Position,
  PriceData,
  SpreadData,
  GammaEvent,
} from '@/types'
import { clobClient } from './CLOBClient'
import { gammaClient } from './GammaClient'
import { ethers } from 'ethers'

// ==========================================
// TOKEN RESOLVER — slug ↔ tokenId bridge
// ==========================================

interface TokenInfo {
  yesTokenId: string
  noTokenId: string
  negRisk: boolean
}

class TokenResolver {
  private cache = new Map<string, TokenInfo>()

  /** Populate cache from a Market object (call after any Gamma fetch) */
  register(market: Market): void {
    if (!market.slug || !market.clobTokenIds || market.clobTokenIds.length < 2) return
    this.cache.set(market.slug, {
      yesTokenId: market.clobTokenIds[0],
      noTokenId: market.clobTokenIds[1],
      negRisk: market.negRisk ?? false,
    })
  }

  /** Register multiple markets */
  registerAll(markets: Market[]): void {
    for (const m of markets) this.register(m)
  }

  /** Get tokenId for a slug + outcome. Returns null if not cached. */
  get(slug: string, outcome: 'yes' | 'no'): string | null {
    const info = this.cache.get(slug)
    if (!info) return null
    return outcome === 'yes' ? info.yesTokenId : info.noTokenId
  }

  /** Get full token info for a slug */
  getInfo(slug: string): TokenInfo | null {
    return this.cache.get(slug) ?? null
  }

  /** Resolve tokenId, fetching from Gamma if not cached */
  async resolve(slug: string, outcome: 'yes' | 'no'): Promise<string | null> {
    const cached = this.get(slug, outcome)
    if (cached) return cached

    // Fetch from Gamma to populate cache — try search, then slug lookup
    try {
      const markets = await gammaClient.searchMarkets(slug, 5)
      this.registerAll(markets)
      const result = this.get(slug, outcome)
      if (result) return result
    } catch {
      // search failed entirely — continue to slug fallback
    }

    // Fallback: direct slug-based lookup (doesn't require auth)
    try {
      const markets = await gammaClient.getMarketsBySlug(slug)
      this.registerAll(markets)
      return this.get(slug, outcome)
    } catch {
      return null
    }
  }

  /** Clear the cache */
  clear(): void {
    this.cache.clear()
  }
}

// ==========================================
// CLIENT
// ==========================================

export class PolymarketClient {
  readonly tokens = new TokenResolver()

  // ==========================================
  // CREDENTIAL MANAGEMENT
  // ==========================================

  /** Initialize from wallet (seed phrase or ethers Wallet) */
  async initFromWallet(wallet: ethers.HDNodeWallet | ethers.Wallet): Promise<{ valid: boolean; error?: string }> {
    clobClient.setWallet(wallet)

    // Compute and set proxy address
    const signerAddress = await wallet.getAddress()
    const proxyAddress = clobClient.computeProxyAddress(signerAddress)
    if (proxyAddress) {
      clobClient.setFunder(proxyAddress)
    }

    // Derive CLOB API key
    const creds = await clobClient.deriveApiKey()
    if (!creds) {
      return { valid: false, error: 'Failed to derive CLOB API credentials from wallet' }
    }

    // Validate
    return clobClient.validateCredentials()
  }

  hasCredentials(): boolean {
    return clobClient.hasCredentials()
  }

  getCredentials(): { key: string; secret: string; passphrase: string } | null {
    return clobClient.getCredentials()
  }

  async validateCredentials(): Promise<{ valid: boolean; error?: string }> {
    return clobClient.validateCredentials()
  }

  // ==========================================
  // MARKET DATA (via GammaClient)
  // ==========================================

  async getEvents(params?: {
    active?: boolean
    limit?: number
  }): Promise<GammaEvent[]> {
    return gammaClient.getEvents(params)
  }

  async getEventBySlug(slug: string): Promise<GammaEvent | null> {
    const event = await gammaClient.getEventBySlug(slug)
    // Register tokens from event markets
    if (event?.markets) {
      this.tokens.registerAll(event.markets)
    }
    return event
  }

  async getMarkets(params?: {
    active?: boolean
    closed?: boolean
    limit?: number
    offset?: number
    sort?: 'volume24hr' | 'createdAt' | 'liquidity' | 'volume'
  }): Promise<Market[]> {
    const markets = await gammaClient.getMarkets(params)
    this.tokens.registerAll(markets)
    return markets
  }

  async getActiveMarkets(maxAgeHours?: number): Promise<Market[]> {
    const markets = await gammaClient.getActiveMarkets(maxAgeHours)
    this.tokens.registerAll(markets)
    return markets
  }

  async getMarket(marketId: string): Promise<Market | null> {
    const market = await gammaClient.getMarket(marketId)
    if (market) this.tokens.register(market)
    return market
  }

  async searchMarkets(query: string, limit = 20): Promise<Market[]> {
    const markets = await gammaClient.searchMarkets(query, limit)
    this.tokens.registerAll(markets)
    return markets
  }

  async getBinaryMarkets(): Promise<Market[]> {
    const markets = await gammaClient.getBinaryMarkets()
    this.tokens.registerAll(markets)
    return markets
  }

  /** Search for a market by slug (best-effort match) */
  async getMarketBySlug(slug: string): Promise<Market | null> {
    let markets = await gammaClient.searchMarkets(slug, 5)
    if (markets.length === 0) {
      // Fallback: direct slug-based lookup (doesn't require auth)
      markets = await gammaClient.getMarketsBySlug(slug)
    }
    this.tokens.registerAll(markets)
    return markets.find(m => m.slug === slug) ?? markets[0] ?? null
  }

  // ==========================================
  // ORDER BOOK (via CLOBClient)
  // ==========================================

  /** Get order book by tokenId */
  async getOrderBook(tokenId: string): Promise<OrderBook | null> {
    return clobClient.getOrderBook(tokenId)
  }

  /** Get order book by slug + outcome (resolves tokenId) */
  async getOrderBookBySlug(slug: string, outcome: 'yes' | 'no' = 'yes'): Promise<OrderBook | null> {
    const tokenId = await this.tokens.resolve(slug, outcome)
    if (!tokenId) return null
    return clobClient.getOrderBook(tokenId)
  }

  /** Get best prices by tokenId */
  async getBestPrices(tokenId: string): Promise<PriceData | null> {
    const prices = await clobClient.getBestPrices(tokenId)
    if (!prices) return null
    return {
      bid: prices.bid,
      ask: prices.ask,
      last: (prices.bid + prices.ask) / 2,
      mid: (prices.bid + prices.ask) / 2,
      spread: prices.spread,
      timestamp: new Date(),
    }
  }

  /** Get best prices by slug + outcome (resolves tokenId) */
  async getBestPricesBySlug(slug: string, outcome: 'yes' | 'no' = 'yes'): Promise<PriceData | null> {
    const tokenId = await this.tokens.resolve(slug, outcome)
    if (!tokenId) return null
    return this.getBestPrices(tokenId)
  }

  /** Get spread by tokenId */
  async getSpread(tokenId: string): Promise<SpreadData | null> {
    return clobClient.getSpread(tokenId)
  }

  /** Batch spread fetch */
  async getSpreads(tokenIds: string[]): Promise<Map<string, SpreadData>> {
    return clobClient.getSpreads(tokenIds)
  }

  // ==========================================
  // TRADING (via CLOBClient)
  // ==========================================

  /**
   * Place an order. Accepts either tokenId directly or marketSlug + outcome.
   * If only slug is provided, resolves to tokenId via TokenResolver.
   */
  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    // Resolve tokenId if not provided
    if (!request.tokenId && request.marketSlug && request.outcome) {
      const tokenId = await this.tokens.resolve(request.marketSlug, request.outcome)
      if (!tokenId) {
        return { success: false, error: `Cannot resolve tokenId for ${request.marketSlug}/${request.outcome}` }
      }
      request = { ...request, tokenId }

      // Also resolve negRisk if not set
      if (request.negRisk === undefined) {
        const info = this.tokens.getInfo(request.marketSlug)
        if (info) request = { ...request, negRisk: info.negRisk }
      }
    }

    if (!request.tokenId) {
      return { success: false, error: 'tokenId is required — provide tokenId or marketSlug + outcome' }
    }

    return clobClient.placeOrder(request)
  }

  async placeFOKOrder(request: OrderRequest): Promise<OrderResult> {
    return this.placeOrder({ ...request, type: 'FOK' })
  }

  async placeGTCOrder(request: OrderRequest): Promise<OrderResult> {
    return this.placeOrder({ ...request, type: 'GTC' })
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return clobClient.cancelOrder(orderId)
  }

  async cancelAllOrders(tokenId?: string): Promise<boolean> {
    return clobClient.cancelAllOrders(tokenId)
  }

  /** Cancel all orders for a slug (resolves YES + NO token IDs) */
  async cancelAllOrdersBySlug(slug: string): Promise<boolean> {
    const info = this.tokens.getInfo(slug)
    if (!info) return false
    const r1 = await clobClient.cancelAllOrders(info.yesTokenId)
    const r2 = await clobClient.cancelAllOrders(info.noTokenId)
    return r1 || r2
  }

  /**
   * Close a position (no server-side endpoint on CLOB — sells at best bid).
   * This is a replacement for the US API's closePosition() convenience.
   */
  async closePosition(slug: string, outcome: 'yes' | 'no', shares: number, slippageBips = 200): Promise<OrderResult> {
    const tokenId = await this.tokens.resolve(slug, outcome)
    if (!tokenId) {
      return { success: false, error: `Cannot resolve tokenId for ${slug}/${outcome}` }
    }

    // Get best bid
    const prices = await clobClient.getBestPrices(tokenId)
    if (!prices || prices.bid <= 0) {
      return { success: false, error: 'Could not get market price for close' }
    }

    // Apply slippage tolerance (sell slightly below best bid)
    const slippageFraction = slippageBips / 10000
    const sellPrice = prices.bid * (1 - slippageFraction)

    return clobClient.placeOrder({
      tokenId,
      side: 'SELL',
      price: Math.max(0.01, sellPrice),
      size: shares,
      type: 'FOK',
    })
  }

  async getOpenOrders(tokenId?: string): Promise<Order[]> {
    return clobClient.getOpenOrders(tokenId)
  }

  async getOrder(orderId: string): Promise<Order | null> {
    return clobClient.getOrder(orderId)
  }

  // ==========================================
  // ACCOUNT (via CLOBClient)
  // ==========================================

  /** Get balance and buying power */
  async getBalances(): Promise<{ balance: number; buyingPower: number }> {
    const result = await clobClient.getBalanceAllowance()
    if (!result) {
      return { balance: 0, buyingPower: 0 }
    }
    return {
      balance: result.balance,
      // Use allowance as buying power if available, otherwise balance
      buyingPower: result.allowance ?? result.balance,
    }
  }

  /**
   * Get positions — uses PLM's IndexedDB as primary source.
   * CLOB API does not have a positions endpoint.
   * Returns empty array (PLM manages positions internally).
   */
  async getPositions(): Promise<Position[]> {
    // PLM tracks positions via IndexedDB — this is a no-op for the facade
    // Consumers that need positions should use PLM directly
    return []
  }

  /** Test the full order signing pipeline */
  async testOrderCycle(): Promise<{ success: boolean; error?: string; orderId?: string }> {
    return clobClient.testOrderCycle()
  }
}

// Singleton
export const polymarketClient = new PolymarketClient()
