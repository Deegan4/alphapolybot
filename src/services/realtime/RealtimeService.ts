import type { PriceData } from '@/types'

type PriceUpdateCallback = (tokenId: string, price: PriceData) => void
type ConnectionCallback = (status: 'connected' | 'disconnected' | 'error') => void

/**
 * Realtime Service
 * Handles WebSocket connections for real-time market data
 * Critical for dip arbitrage strategy (<1s latency requirement)
 */
export class RealtimeService {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 1000
  private pingInterval: number | null = null
  private reconnectTimeout: number | null = null
  private cleanupInterval: number | null = null
  private subscriptions = new Set<string>()
  private prices = new Map<string, PriceData>()
  /** Timestamp of most recent WebSocket message (any type) */
  private lastMessageTime = 0

  private priceCallbacks = new Set<PriceUpdateCallback>()
  private connectionCallbacks = new Set<ConnectionCallback>()

  private wsUrl = import.meta.env.VITE_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
  /** Counts total messages received — used to log first-message confirmation */
  private messageCount = 0

  /**
   * Connect to WebSocket.
   * Idempotent — safe to call from multiple strategies.
   * If already connected or connecting, returns immediately.
   */
  async connect(): Promise<boolean> {
    // Already connected — return immediately
    if (this.ws?.readyState === WebSocket.OPEN) {
      return true
    }
    // Already connecting — wait for it
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(check)
            resolve(true)
          } else if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) {
            clearInterval(check)
            resolve(false)
          }
        }, 100)
        // Timeout after 10s
        setTimeout(() => { clearInterval(check); resolve(false) }, 10_000)
      })
    }

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.wsUrl)

        this.ws.onopen = () => {
          console.log(`[RealtimeService] WebSocket connected to ${this.wsUrl}`)
          this.reconnectAttempts = 0
          this.messageCount = 0 // Reset so we log first-message confirmation on each reconnect
          this.startPingInterval()
          this.startCleanupInterval()
          this.notifyConnectionCallbacks('connected')
          
          // Send initial batch subscription (uses type: 'market' format on connect)
          if (this.subscriptions.size > 0) {
            const initMsg = JSON.stringify({
              assets_ids: Array.from(this.subscriptions),
              type: 'market',
            })
            this.ws?.send(initMsg)
            console.log(`[RealtimeService] Subscribed to ${this.subscriptions.size} tokens`)
          }
          
          resolve(true)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onclose = () => {
          console.log('WebSocket disconnected')
          this.stopPingInterval()
          this.notifyConnectionCallbacks('disconnected')
          this.attemptReconnect()
        }

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error)
          this.notifyConnectionCallbacks('error')
          resolve(false)
        }
      } catch (error) {
        console.error('Failed to connect WebSocket:', error)
        resolve(false)
      }
    })
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    // Cancel any pending reconnection attempt
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    this.stopPingInterval()
    this.stopCleanupInterval()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.subscriptions.clear()
    this.prices.clear()
  }

  /**
   * Subscribe to price updates for a token
   */
  subscribeMarket(tokenIds: string | string[]): void {
    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds]
    
    for (const tokenId of ids) {
      this.subscriptions.add(tokenId)
      this.subscribeToToken(tokenId)
    }
  }

  /**
   * Unsubscribe from a token
   */
  unsubscribeMarket(tokenIds: string | string[]): void {
    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds]
    
    for (const tokenId of ids) {
      this.subscriptions.delete(tokenId)
      this.unsubscribeFromToken(tokenId)
      this.prices.delete(tokenId)
    }
  }

  /**
   * Get current price for a token
   */
  getPrice(tokenId: string): PriceData | null {
    return this.prices.get(tokenId) || null
  }

  /**
   * Get all current prices
   */
  getAllPrices(): Map<string, PriceData> {
    return new Map(this.prices)
  }

  /**
   * Subscribe to price updates
   */
  onPriceUpdate(callback: PriceUpdateCallback): () => void {
    this.priceCallbacks.add(callback)
    return () => this.priceCallbacks.delete(callback)
  }

  /**
   * Subscribe to connection status changes
   */
  onConnectionChange(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.add(callback)
    return () => this.connectionCallbacks.delete(callback)
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * Check if a token's price data is stale (no update in maxAgeMs).
   * Returns true if no data exists OR if the data is older than the threshold.
   * Default: 5 minutes (300,000ms).
   */
  isStale(tokenId: string, maxAgeMs = 300_000): boolean {
    const priceData = this.prices.get(tokenId)
    if (!priceData) return true
    return Date.now() - priceData.timestamp.getTime() > maxAgeMs
  }

  /**
   * Timestamp of the most recent WebSocket message (any type).
   * Returns 0 if no messages received yet.
   */
  getLastMessageTime(): number {
    return this.lastMessageTime
  }

  /**
   * Start a periodic cleanup that prunes price entries older than 1 hour.
   * Prevents the prices Map from growing unboundedly when tokens are
   * unsubscribed but leftover entries remain.
   */
  startCleanupInterval(): void {
    if (this.cleanupInterval) return
    const ONE_HOUR = 60 * 60 * 1000
    this.cleanupInterval = window.setInterval(() => {
      const cutoff = Date.now() - ONE_HOUR
      for (const [tokenId, priceData] of this.prices) {
        if (priceData.timestamp.getTime() < cutoff) {
          this.prices.delete(tokenId)
        }
      }
    }, 5 * 60 * 1000) // Run every 5 minutes
  }

  /**
   * Stop the cleanup interval
   */
  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }

  // Private methods

  private subscribeToToken(tokenId: string): void {
    if (!this.isConnected()) return

    // Polymarket CLOB WebSocket: dynamic subscription after initial connect
    // uses { assets_ids: [...], operation: 'subscribe' }
    const message = JSON.stringify({
      assets_ids: [tokenId],
      operation: 'subscribe',
    })

    this.ws?.send(message)
  }

  private unsubscribeFromToken(tokenId: string): void {
    if (!this.isConnected()) return

    const message = JSON.stringify({
      assets_ids: [tokenId],
      operation: 'unsubscribe',
    })

    this.ws?.send(message)
  }

  private handleMessage(data: string): void {
    this.lastMessageTime = Date.now()
    this.messageCount++

    // Handle non-JSON responses (e.g., "INVALID OPERATION", "pong" plain text)
    if (!data.startsWith('{') && !data.startsWith('[')) {
      // Plain text response — not an error, just ignore silently
      // (Polymarket WS may respond with plain strings to certain messages)
      return
    }

    try {
      const message = JSON.parse(data)

      // Log first real data message to confirm the pipeline is active
      if (this.messageCount === 1) {
        console.log('[RealtimeService] First WebSocket message received — data pipeline active')
      }

      // Handle different message types (Polymarket uses event_type field)
      const eventType = message.event_type || message.type
      switch (eventType) {
        case 'price_change':
          this.handlePriceChangeEvent(message)
          break
        case 'book':
          this.handleBookEvent(message)
          break
        case 'last_trade_price':
        case 'trade':
          this.handleTradeUpdate(message)
          break
        case 'pong':
          // Ping response, connection is alive
          break
        default:
          // Unknown message type — log first 3 for debugging, then go silent
          if (this.messageCount <= 3) {
            console.log('[RealtimeService] WS message type:', eventType, Object.keys(message))
          }
      }
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error)
    }
  }

  /**
   * Handle Polymarket price_change events.
   * Format: { event_type: "price_change", market: "0x...", timestamp: "...",
   *   price_changes: [{ asset_id, price, size, side, best_bid, best_ask, hash }] }
   * Note: best_bid/best_ask are strings, need parseFloat.
   */
  private handlePriceChangeEvent(message: {
    market?: string
    timestamp?: string | number
    price_changes?: Array<{
      asset_id?: string
      price?: string | number
      best_bid?: string | number
      best_ask?: string | number
      size?: string | number
      side?: string
    }>
  }): void {
    const changes = message.price_changes
    if (!changes || changes.length === 0) return

    const ts = message.timestamp
      ? new Date(typeof message.timestamp === 'string' ? parseInt(message.timestamp as string) : (message.timestamp as number))
      : new Date()

    for (const change of changes) {
      const tokenId = change.asset_id
      if (!tokenId) continue

      const bid = parseFloat(String(change.best_bid || 0))
      const ask = parseFloat(String(change.best_ask || 0))
      const price = parseFloat(String(change.price || 0))
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : price

      const priceData: PriceData = {
        bid: bid || price,
        ask: ask || price,
        last: price || mid,
        mid,
        spread: ask > 0 && bid > 0 ? ask - bid : 0,
        timestamp: ts,
      }

      this.prices.set(tokenId, priceData)
      this.feedMicrostructureAnalyzer(tokenId, bid, ask)
      this.notifyPriceCallbacks(tokenId, priceData)
    }
  }

  /**
   * Handle Polymarket book events (full order book snapshot).
   * Format: { event_type: "book", asset_id: "...", market: "0x...",
   *   buys: [{price, size}...], sells: [{price, size}...], timestamp: "..." }
   */
  private handleBookEvent(message: {
    asset_id?: string
    market?: string
    buys?: Array<{ price: string | number; size: string | number }>
    sells?: Array<{ price: string | number; size: string | number }>
    timestamp?: string | number
  }): void {
    const tokenId = message.asset_id
    if (!tokenId) return

    // Best bid = highest buy price, best ask = lowest sell price
    const buys = message.buys || []
    const sells = message.sells || []
    const bestBid = buys.length > 0 ? parseFloat(String(buys[0].price)) : 0
    const bestAsk = sells.length > 0 ? parseFloat(String(sells[0].price)) : 0

    // Skip empty book events — no bids AND no asks means the book was cleared,
    // not that the price is 0. Emitting mid=0 causes PLM to false-trigger SL at -100%.
    if (bestBid <= 0 && bestAsk <= 0) return

    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk)

    const priceData: PriceData = {
      bid: bestBid,
      ask: bestAsk,
      last: mid,
      mid,
      spread: bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0,
      timestamp: new Date(typeof message.timestamp === 'string' ? parseInt(message.timestamp) : (message.timestamp || Date.now())),
    }

    this.prices.set(tokenId, priceData)
    this.feedMicrostructureAnalyzer(tokenId, bestBid, bestAsk)
    this.notifyPriceCallbacks(tokenId, priceData)
  }

  /**
   * Feed bid/ask data to MicrostructureAnalyzer (best-effort, non-blocking).
   */
  private feedMicrostructureAnalyzer(tokenId: string, bid: number, ask: number): void {
    try {
      import('@/services/trading/MicrostructureAnalyzer').then(m => {
        if (bid > 0 && ask > 0 && bid !== ask) {
          m.microstructureAnalyzer.recordSnapshot(tokenId, bid, 1, ask, 1)
        }
      }).catch(() => {})
    } catch {
      // Best effort — microstructure is advisory, never block price delivery
    }
  }

  private handleTradeUpdate(message: {
    asset_id?: string
    price?: number
    size?: number
    timestamp?: number
  }): void {
    const tokenId = message.asset_id
    if (!tokenId || !message.price) return

    const existing = this.prices.get(tokenId)
    if (existing) {
      const priceData: PriceData = {
        ...existing,
        last: message.price,
        timestamp: new Date(message.timestamp || Date.now()),
      }
      this.prices.set(tokenId, priceData)
      this.notifyPriceCallbacks(tokenId, priceData)
    }
  }

  private notifyPriceCallbacks(tokenId: string, price: PriceData): void {
    for (const callback of this.priceCallbacks) {
      try {
        callback(tokenId, price)
      } catch (error) {
        console.error('Price callback error:', error)
      }
    }
  }

  private notifyConnectionCallbacks(status: 'connected' | 'disconnected' | 'error'): void {
    for (const callback of this.connectionCallbacks) {
      try {
        callback(status)
      } catch (error) {
        console.error('Connection callback error:', error)
      }
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached')
      return
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null
      this.connect()
    }, delay)
  }

  private startPingInterval(): void {
    this.pingInterval = window.setInterval(() => {
      if (this.isConnected()) {
        this.ws?.send('ping')
      }
    }, 30000) // Ping every 30 seconds
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }
}

// Export singleton instance
export const realtimeService = new RealtimeService()
