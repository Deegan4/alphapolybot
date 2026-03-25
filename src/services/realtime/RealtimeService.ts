/**
 * RealtimeService — CLOB Market WebSocket
 *
 * Native WebSocket to wss://ws-subscriptions-clob.polymarket.com/ws/market
 * for real-time BBO/trade data. No SDK dependency.
 *
 * Protocol (two-phase):
 *   - Handshake (REQUIRED on every connect): { assets_ids: [], type: 'market' }
 *     Registers the connection as a market data consumer. Server drops connections
 *     that skip this handshake. Can include asset IDs to subscribe immediately.
 *   - Dynamic subscription: { assets_ids, operation: 'subscribe' }
 *   - Messages use event_type field, price_changes array, string prices
 *   - 30s ping keepalive
 *
 * Public interface:
 *   connect(), disconnect(), subscribeMarket(), getPrice(),
 *   getAllPrices(), onPriceUpdate(), onConnectionChange(), isConnected()
 */

import type { PriceData } from '@/types'

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const PING_INTERVAL_MS = 30_000

type PriceUpdateCallback = (id: string, price: PriceData) => void
type ConnectionCallback = (status: 'connected' | 'disconnected' | 'error') => void

export class RealtimeService {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 1000
  private reconnectTimeout: number | null = null
  private pingInterval: number | null = null
  private cleanupInterval: number | null = null
  private subscriptions = new Set<string>()     // token IDs
  private prices = new Map<string, PriceData>()  // keyed by token ID
  private lastMessageTime = 0
  private messageCount = 0
  private initialSubscribed = false

  private priceCallbacks = new Set<PriceUpdateCallback>()
  private connectionCallbacks = new Set<ConnectionCallback>()

  // Batching: collect new token IDs and send in one WS message per microtask
  private pendingDynamicIds: string[] = []
  private dynamicBatchScheduled = false

  /**
   * Connect to CLOB Market WebSocket.
   * Idempotent — safe to call from multiple strategies.
   */
  async connect(): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) return true

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(WS_URL)
        this.initialSubscribed = false

        this.ws.onopen = () => {
          console.log('[RealtimeService] WebSocket connected')
          this.reconnectAttempts = 0
          this.messageCount = 0
          this.startPingInterval()
          this.startCleanupInterval()
          this.notifyConnectionCallbacks('connected')

          // Phase 1: Always send handshake (registers connection as "market" type)
          // The CLOB WS requires this even with an empty assets list
          this.sendInitialSubscription(Array.from(this.subscriptions))
          this.initialSubscribed = true
          resolve(true)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onerror = (err) => {
          console.error('[RealtimeService] WebSocket error:', err)
          this.notifyConnectionCallbacks('error')
          resolve(false)
        }

        this.ws.onclose = () => {
          console.log('[RealtimeService] WebSocket disconnected')
          this.stopPingInterval()
          this.notifyConnectionCallbacks('disconnected')
          this.attemptReconnect()
        }
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
    this.stopPingInterval()
    this.stopCleanupInterval()
    if (this.ws) {
      this.ws.onclose = null  // prevent reconnect
      this.ws.close()
      this.ws = null
    }
    this.subscriptions.clear()
    this.prices.clear()
    this.initialSubscribed = false
  }

  /**
   * Subscribe to price updates for token IDs.
   * Accepts token IDs (CLOB native identifiers).
   */
  subscribeMarket(tokenIds: string | string[]): void {
    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds]
    const newIds: string[] = []

    for (const id of ids) {
      if (!this.subscriptions.has(id)) {
        this.subscriptions.add(id)
        newIds.push(id)
      }
    }

    if (newIds.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      if (this.initialSubscribed) {
        // Dynamic subscription — batched to coalesce rapid calls (e.g., DipArb scanning 700+ markets)
        this.scheduleDynamicSubscription(newIds)
      } else {
        // Still in initial phase — will be included in initial subscription
      }
    }
  }

  unsubscribeMarket(tokenIds: string | string[]): void {
    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds]
    for (const id of ids) {
      this.subscriptions.delete(id)
      this.prices.delete(id)
    }
    // CLOB WS doesn't have per-asset unsubscribe — tracked locally
  }

  getPrice(id: string): PriceData | null {
    return this.prices.get(id) || null
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
    return this.ws?.readyState === WebSocket.OPEN
  }

  isStale(id: string, maxAgeMs = 300_000): boolean {
    const priceData = this.prices.get(id)
    if (!priceData) return true
    return Date.now() - priceData.timestamp.getTime() > maxAgeMs
  }

  getLastMessageTime(): number {
    return this.lastMessageTime
  }

  // ─── Private: Protocol ─────────────────────────────────

  /** Phase 1: Initial subscription (sent on connect) */
  private sendInitialSubscription(assetIds: string[]): void {
    this.send({
      assets_ids: assetIds,
      type: 'market',
    })
    console.log(`[RealtimeService] Initial subscription: ${assetIds.length} assets`)
  }

  /** Phase 2: Dynamic subscription — batched via microtask to coalesce rapid calls */
  private scheduleDynamicSubscription(assetIds: string[]): void {
    this.pendingDynamicIds.push(...assetIds)

    if (!this.dynamicBatchScheduled) {
      this.dynamicBatchScheduled = true
      queueMicrotask(() => {
        const batch = this.pendingDynamicIds
        this.pendingDynamicIds = []
        this.dynamicBatchScheduled = false

        if (batch.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
          this.send({
            assets_ids: batch,
            operation: 'subscribe',
          })
          console.log(`[RealtimeService] Dynamic subscription: ${batch.length} assets (batched)`)
        }
      })
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private handleMessage(raw: string): void {
    this.lastMessageTime = Date.now()

    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }

    // CLOB sends arrays of events
    const events = Array.isArray(data) ? data : [data]

    for (const event of events) {
      if (!event || typeof event !== 'object') continue
      const evt = event as Record<string, unknown>

      if (evt.event_type === 'price_change') {
        this.handlePriceChange(evt)
      } else if (evt.event_type === 'last_trade_price') {
        this.handleLastTradePrice(evt)
      } else if (evt.event_type === 'book') {
        this.handleBookUpdate(evt)
      }
    }
  }

  private handlePriceChange(evt: Record<string, unknown>): void {
    this.messageCount++
    if (this.messageCount === 1) {
      console.log('[RealtimeService] First market data received — pipeline active')
    }

    const changes = evt.price_changes as Array<Record<string, string>> | undefined
    if (!changes || !Array.isArray(changes)) return

    for (const change of changes) {
      const assetId = change.asset_id
      if (!assetId) continue

      const bestBid = parseFloat(change.best_bid || '0')
      const bestAsk = parseFloat(change.best_ask || '0')

      if (bestBid <= 0 && bestAsk <= 0) continue

      const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk)
      const last = parseFloat(change.price || '0') || mid

      const priceData: PriceData = {
        bid: bestBid || last,
        ask: bestAsk || last,
        last,
        mid,
        spread: bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0,
        timestamp: new Date(),
      }

      this.prices.set(assetId, priceData)
      this.notifyPriceCallbacks(assetId, priceData)
    }
  }

  private handleBookUpdate(evt: Record<string, unknown>): void {
    const assetId = evt.asset_id as string
    if (!assetId) return

    // CLOB book events can carry full snapshots or deltas via 'changes' array
    // Format: { event_type: 'book', asset_id, bids: [...], asks: [...] }
    //    or:  { event_type: 'book', asset_id, changes: [{ price, side, size }] }
    import('@/services/trading/L2OrderBookTracker').then(({ l2OrderBookTracker }) => {
      if (!l2OrderBookTracker.isTracking(assetId)) return

      const bids = evt.bids as Array<{ price: string; size: string }> | undefined
      const asks = evt.asks as Array<{ price: string; size: string }> | undefined
      const changes = evt.changes as Array<{ price: string; side: string; size: string }> | undefined

      if (bids && asks) {
        // Full snapshot
        l2OrderBookTracker.applySnapshot(
          assetId,
          bids.map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
          asks.map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
        )
      } else if (changes && Array.isArray(changes)) {
        // Incremental delta
        l2OrderBookTracker.applyDelta(
          assetId,
          changes.map(c => ({
            price: parseFloat(c.price),
            side: (c.side === 'buy' || c.side === 'bid') ? 'bid' as const : 'ask' as const,
            size: parseFloat(c.size),
          })),
        )
      }
    }).catch(() => {})
  }

  private handleLastTradePrice(evt: Record<string, unknown>): void {
    this.messageCount++
    const assetId = evt.asset_id as string
    if (!assetId) return

    const price = parseFloat(evt.price as string || '0')
    if (price <= 0) return

    const existing = this.prices.get(assetId)
    if (existing) {
      existing.last = price
      existing.timestamp = new Date()
      this.notifyPriceCallbacks(assetId, existing)
    }
  }

  // ─── Private: Callbacks ────────────────────────────────

  private notifyPriceCallbacks(id: string, price: PriceData): void {
    for (const callback of this.priceCallbacks) {
      try { callback(id, price) } catch (e) { console.error('Price callback error:', e) }
    }
  }

  private notifyConnectionCallbacks(status: 'connected' | 'disconnected' | 'error'): void {
    for (const cb of this.connectionCallbacks) {
      try { cb(status) } catch (e) { console.error('Connection callback error:', e) }
    }
  }

  // ─── Private: Keepalive & Reconnect ────────────────────

  private startPingInterval(): void {
    this.stopPingInterval()
    this.lastMessageTime = Date.now()
    this.pingInterval = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('PING')

        // Force-reconnect if no data received in 2x ping interval (stale/dead connection)
        const silenceDuration = Date.now() - this.lastMessageTime
        if (this.lastMessageTime > 0 && silenceDuration > PING_INTERVAL_MS * 2) {
          console.warn(`[RealtimeService] No data for ${Math.round(silenceDuration / 1000)}s — force-reconnecting`)
          this.ws.close()  // triggers onclose → attemptReconnect
        }
      }
    }, PING_INTERVAL_MS)
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[RealtimeService] Max reconnect attempts reached — triggering emergency stop')
      import('@/services/trading/RiskManager').then(({ riskManager }) => {
        riskManager.emergencyStop('RealtimeService WebSocket died after max reconnect attempts')
      }).catch(() => {})
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
      for (const [id, priceData] of this.prices) {
        if (priceData.timestamp.getTime() < cutoff) {
          this.prices.delete(id)
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
