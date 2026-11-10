/**
 * RealtimeService — Polymarket US Market WebSocket
 *
 * Uses the official SDK's MarketsWebSocket for real-time BBO/trade data.
 * Subscribes via MARKET_DATA_LITE for lightweight best-bid/ask streaming.
 *
 * Public interface preserved from CLOB version:
 *   connect(), disconnect(), subscribeMarket(), getPrice(),
 *   getAllPrices(), onPriceUpdate(), onConnectionChange(), isConnected()
 *
 * Key difference: subscriptions use market slugs, not token IDs.
 */

import {
  MarketsWebSocket,
  type MarketDataLite,
  type MarketData,
} from 'polymarket-us'
import type { PriceData, OrderBook } from '@/types'
import { polymarketUSClient, orderBookFromWire, type WireBook } from '@/services/api'

/** A pushed book older than this is not trusted for sizing (ms) */
export const LIVE_BOOK_MAX_AGE_MS = 5_000

/** Max markets per WebSocket subscription (docs: Markets WebSocket → Subscription Limits) */
export const WS_MAX_MARKETS_PER_SUBSCRIPTION = 100

/** Split slugs into subscription-sized chunks */
export function chunkSlugs(slugs: string[], size = WS_MAX_MARKETS_PER_SUBSCRIPTION): string[][] {
  const out: string[][] = []
  for (let i = 0; i < slugs.length; i += size) out.push(slugs.slice(i, i + size))
  return out
}

/** Connection summary for diagnostics (Settings → API) */
export interface FeedStatus {
  state: 'connected' | 'reconnecting' | 'offline' | 'idle'
  /** ms timestamp of the last message, 0 if none yet */
  lastMessageAt: number
  /** Markets subscribed for prices */
  subscriptions: number
  /** Markets with a full order book streamed, and how many of those are fresh */
  booksWatched: number
  booksFresh: number
}

type PriceUpdateCallback = (slug: string, price: PriceData) => void
type ConnectionCallback = (status: 'connected' | 'disconnected' | 'error') => void

export class RealtimeService {
  private ws: MarketsWebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 1000
  private reconnectTimeout: number | null = null
  private cleanupInterval: number | null = null
  private subscriptions = new Set<string>()
  /** Set by disconnect() so the resulting close does not schedule a reconnect */
  private closingIntentionally = false
  /** True after max reconnect attempts failed; cleared by a successful open */
  private gaveUp = false
  private everConnected = false
  /** Markets that also get the full order book (MARKET_DATA), not just BBO */
  private bookSubscriptions = new Set<string>()
  private books = new Map<string, { book: OrderBook; receivedAt: number }>()
  private prices = new Map<string, PriceData>()
  private lastMessageTime = 0
  private messageCount = 0
  private requestIdCounter = 0

  private priceCallbacks = new Set<PriceUpdateCallback>()
  private connectionCallbacks = new Set<ConnectionCallback>()

  /**
   * Connect to Polymarket US Markets WebSocket.
   * Idempotent — safe to call from multiple strategies.
   */
  async connect(): Promise<boolean> {
    if (this.ws?.isConnected) return true

    const wsOpts = polymarketUSClient.getWebSocketOptions()
    if (!wsOpts) {
      console.warn('[RealtimeService] Cannot connect — no credentials configured')
      return false
    }

    this.closingIntentionally = false
    return new Promise((resolve) => {
      try {
        this.ws = new MarketsWebSocket({
          keyId: wsOpts.keyId,
          secretKey: wsOpts.secretKey,
          baseUrl: wsOpts.baseUrl,
        })

        this.ws.on('open', () => {
          console.log('[RealtimeService] WebSocket connected')
          this.reconnectAttempts = 0
          this.gaveUp = false
          this.everConnected = true
          this.messageCount = 0
          this.startCleanupInterval()
          this.notifyConnectionCallbacks('connected')

          // Re-subscribe existing markets
          if (this.subscriptions.size > 0) {
            const slugs = Array.from(this.subscriptions)
            this.subscribeInChunks(slugs)
            console.log(`[RealtimeService] Subscribed to ${slugs.length} markets`)
          }
          if (this.bookSubscriptions.size > 0) {
            this.subscribeBooksInChunks(Array.from(this.bookSubscriptions))
          }

          resolve(true)
        })

        this.ws.on('marketDataLite', (data: MarketDataLite) => {
          this.handleMarketDataLite(data)
        })

        this.ws.on('marketData', (data: MarketData) => {
          this.handleMarketData(data)
        })

        this.ws.on('heartbeat', () => {
          this.lastMessageTime = Date.now()
        })

        this.ws.on('error', (err) => {
          console.error('[RealtimeService] WebSocket error:', err)
          this.notifyConnectionCallbacks('error')
          resolve(false)
        })

        this.ws.on('close', () => {
          console.log('[RealtimeService] WebSocket disconnected')
          this.notifyConnectionCallbacks('disconnected')
          if (this.closingIntentionally) return
          this.attemptReconnect()
        })

        this.ws.connect()
      } catch (error) {
        console.error('[RealtimeService] Failed to connect:', error)
        resolve(false)
      }
    })
  }

  disconnect(): void {
    this.closingIntentionally = true
    this.everConnected = false
    this.gaveUp = false
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    this.stopCleanupInterval()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.subscriptions.clear()
    this.prices.clear()
    this.bookSubscriptions.clear()
    this.books.clear()
  }

  /**
   * Also stream the full order book (top levels, sent whole on every change)
   * for these markets, so depth checks before an order can skip the REST
   * book fetch. Keep this to the few markets about to be traded.
   */
  watchBooks(slugs: string[]): void {
    const fresh = [...new Set(slugs)].filter(s => !this.bookSubscriptions.has(s))
    for (const s of fresh) this.bookSubscriptions.add(s)
    if (fresh.length > 0 && this.ws?.isConnected) this.subscribeBooksInChunks(fresh)
  }

  /** Stop using pushed books for these markets (e.g. after their window closed) */
  unwatchBooks(slugs: string[]): void {
    for (const s of slugs) {
      this.bookSubscriptions.delete(s)
      this.books.delete(s)
    }
  }

  /** Latest pushed order book if received within `maxAgeMs`, else null (use REST) */
  getBook(slug: string, maxAgeMs = LIVE_BOOK_MAX_AGE_MS): OrderBook | null {
    if (!this.ws?.isConnected) return null
    const entry = this.books.get(slug)
    if (!entry || Date.now() - entry.receivedAt > maxAgeMs) return null
    return entry.book
  }

  private subscribeBooksInChunks(slugs: string[]): void {
    for (const chunk of chunkSlugs(slugs)) {
      this.ws?.subscribeMarketData(this.nextRequestId(), chunk)
    }
  }

  /**
   * Subscribe to price updates for market slugs.
   */
  subscribeMarket(slugs: string | string[]): void {
    const ids = Array.isArray(slugs) ? slugs : [slugs]
    const newSlugs: string[] = []

    for (const slug of ids) {
      if (!this.subscriptions.has(slug)) {
        this.subscriptions.add(slug)
        newSlugs.push(slug)
      }
    }

    if (newSlugs.length > 0 && this.ws?.isConnected) {
      this.subscribeInChunks(newSlugs)
    }
  }

  /** The markets WebSocket accepts at most 100 markets per subscription */
  private subscribeInChunks(slugs: string[]): void {
    for (const chunk of chunkSlugs(slugs)) {
      this.ws?.subscribeMarketDataLite(this.nextRequestId(), chunk)
    }
  }

  unsubscribeMarket(slugs: string | string[]): void {
    const ids = Array.isArray(slugs) ? slugs : [slugs]
    for (const slug of ids) {
      this.subscriptions.delete(slug)
      this.prices.delete(slug)
    }
    this.unwatchBooks(ids)
    // SDK doesn't have a per-slug unsubscribe — tracked locally
  }

  getPrice(slug: string): PriceData | null {
    return this.prices.get(slug) || null
  }

  getAllPrices(): Map<string, PriceData> {
    return new Map(this.prices)
  }

  onPriceUpdate(callback: PriceUpdateCallback): () => void {
    this.priceCallbacks.add(callback)
    return () => this.priceCallbacks.delete(callback)
  }

  onConnectionChange(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.add(callback)
    return () => this.connectionCallbacks.delete(callback)
  }

  isConnected(): boolean {
    return this.ws?.isConnected ?? false
  }

  isStale(slug: string, maxAgeMs = 300_000): boolean {
    const priceData = this.prices.get(slug)
    if (!priceData) return true
    return Date.now() - priceData.timestamp.getTime() > maxAgeMs
  }

  getLastMessageTime(): number {
    return this.lastMessageTime
  }

  /** Whether reconnecting stopped after the maximum attempts */
  hasGivenUp(): boolean {
    return this.gaveUp && !this.isConnected()
  }

  /** Manual retry after giving up: start a fresh round of reconnect attempts */
  async retry(): Promise<boolean> {
    this.reconnectAttempts = 0
    this.gaveUp = false
    return this.connect()
  }

  getStatus(now = Date.now()): FeedStatus {
    let booksFresh = 0
    for (const slug of this.bookSubscriptions) {
      const entry = this.books.get(slug)
      if (entry && now - entry.receivedAt <= LIVE_BOOK_MAX_AGE_MS) booksFresh++
    }
    return {
      state: this.isConnected() ? 'connected' : this.hasGivenUp() ? 'offline' : this.everConnected ? 'reconnecting' : 'idle',
      lastMessageAt: this.lastMessageTime,
      subscriptions: this.subscriptions.size,
      booksWatched: this.bookSubscriptions.size,
      booksFresh: this.isConnected() ? booksFresh : 0,
    }
  }

  // ─── Private ────────────────────────────────────────────

  private nextRequestId(): string {
    return `mkt-${++this.requestIdCounter}-${Date.now()}`
  }

  private handleMarketDataLite(data: MarketDataLite): void {
    this.lastMessageTime = Date.now()
    this.messageCount++

    if (this.messageCount === 1) {
      console.log('[RealtimeService] First market data received — pipeline active')
    }

    const slug = data.marketDataLite.marketSlug
    const bid = parseFloat(data.marketDataLite.bestBid?.value || '0')
    const ask = parseFloat(data.marketDataLite.bestAsk?.value || '0')
    const last = parseFloat(data.marketDataLite.lastTradePx?.value || '0')

    if (bid <= 0 && ask <= 0) return

    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid || ask)
    const priceData: PriceData = {
      bid: bid || last,
      ask: ask || last,
      last: last || mid,
      mid,
      spread: ask > 0 && bid > 0 ? ask - bid : 0,
      timestamp: new Date(),
    }

    this.prices.set(slug, priceData)
    this.feedMicrostructureAnalyzer(slug, bid, ask)
    this.notifyPriceCallbacks(slug, priceData)
  }

  private handleMarketData(data: MarketData): void {
    this.lastMessageTime = Date.now()
    this.messageCount++

    const md = data.marketData
    const slug = md.marketSlug
    const bids = md.bids || []
    const offers = md.offers || []
    if (this.bookSubscriptions.has(slug)) {
      this.books.set(slug, { book: orderBookFromWire(md as WireBook), receivedAt: Date.now() })
    }

    const bestBid = bids.length > 0 ? parseFloat(bids[0].px.value) : 0
    const bestAsk = offers.length > 0 ? parseFloat(offers[0].px.value) : 0

    if (bestBid <= 0 && bestAsk <= 0) return

    const last = parseFloat(md.stats?.lastTradePx?.value || '0')
    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk)

    const priceData: PriceData = {
      bid: bestBid,
      ask: bestAsk,
      last: last || mid,
      mid,
      spread: bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0,
      timestamp: new Date(),
    }

    this.prices.set(slug, priceData)
    this.feedMicrostructureAnalyzer(slug, bestBid, bestAsk)
    this.notifyPriceCallbacks(slug, priceData)
  }

  /**
   * Feed bid/ask data to MicrostructureAnalyzer (best-effort, non-blocking).
   * Dynamic import cached after first resolution.
   */
  private microstructureModule: Promise<typeof import('@/services/trading/MicrostructureAnalyzer')> | null = null
  private microstructureImporting = false
  private feedMicrostructureAnalyzer(slug: string, bid: number, ask: number): void {
    if (bid <= 0 || ask <= 0 || bid === ask) return

    if (this.microstructureModule) {
      this.microstructureModule.then(m => {
        m.microstructureAnalyzer.recordSnapshot(slug, bid, 1, ask, 1)
      })
      return
    }

    if (this.microstructureImporting) return
    this.microstructureImporting = true

    this.microstructureModule = import('@/services/trading/MicrostructureAnalyzer')
    this.microstructureModule.then(m => {
      m.microstructureAnalyzer.recordSnapshot(slug, bid, 1, ask, 1)
    }).catch(() => {
      this.microstructureModule = null
      this.microstructureImporting = false
    })
  }

  private notifyPriceCallbacks(slug: string, price: PriceData): void {
    for (const callback of this.priceCallbacks) {
      try { callback(slug, price) } catch (e) { console.error('Price callback error:', e) }
    }
  }

  private notifyConnectionCallbacks(status: 'connected' | 'disconnected' | 'error'): void {
    for (const cb of this.connectionCallbacks) {
      try { cb(status) } catch (e) { console.error('Connection callback error:', e) }
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[RealtimeService] Max reconnect attempts reached')
      this.gaveUp = true
      return
    }
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++
    console.log(`[RealtimeService] Reconnecting in ${delay}ms (${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null
      this.connect()
    }, delay)
  }

  startCleanupInterval(): void {
    if (this.cleanupInterval) return
    const ONE_HOUR = 60 * 60 * 1000
    this.cleanupInterval = window.setInterval(() => {
      const cutoff = Date.now() - ONE_HOUR
      for (const [slug, priceData] of this.prices) {
        if (priceData.timestamp.getTime() < cutoff) {
          this.prices.delete(slug)
        }
      }
    }, 5 * 60 * 1000)
  }

  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

export const realtimeService = new RealtimeService()
