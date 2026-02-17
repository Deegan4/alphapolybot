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
  type WebSocketOptions,
} from 'polymarket-us'
import type { PriceData } from '@/types'
import { polymarketUSClient } from '@/services/api'

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
          this.messageCount = 0
          this.startCleanupInterval()
          this.notifyConnectionCallbacks('connected')

          // Re-subscribe existing markets
          if (this.subscriptions.size > 0) {
            const slugs = Array.from(this.subscriptions)
            const reqId = this.nextRequestId()
            this.ws!.subscribeMarketDataLite(reqId, slugs)
            console.log(`[RealtimeService] Subscribed to ${slugs.length} markets`)
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
      const reqId = this.nextRequestId()
      this.ws.subscribeMarketDataLite(reqId, newSlugs)
    }
  }

  unsubscribeMarket(slugs: string | string[]): void {
    const ids = Array.isArray(slugs) ? slugs : [slugs]
    for (const slug of ids) {
      this.subscriptions.delete(slug)
      this.prices.delete(slug)
    }
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
  private microstructureModule: typeof import('@/services/trading/MicrostructureAnalyzer') | null = null
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
