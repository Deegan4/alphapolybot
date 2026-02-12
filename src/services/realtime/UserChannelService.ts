import type {
  UserChannelAuth,
  UserTradeMessage,
  UserOrderMessage,
  UserChannelMessage,
} from '@/types'

type TradeCallback = (msg: UserTradeMessage) => void
type OrderCallback = (msg: UserOrderMessage) => void
type ConnectionCallback = (status: 'connected' | 'disconnected' | 'error') => void

/**
 * UserChannelService
 *
 * Authenticated WebSocket connection to Polymarket CLOB user channel.
 * Receives push-based order fill, cancellation, and trade status events
 * instead of polling /data/order/{id} every 2 seconds.
 *
 * Separate from RealtimeService because:
 * - Different WebSocket URL (/ws/user vs /ws/market)
 * - Requires API key authentication
 * - Different message schema (trade/order events, not price updates)
 * - Different lifecycle (connect only when credentials exist)
 */
export class UserChannelService {
  private ws: WebSocket | null = null
  private auth: UserChannelAuth | null = null
  private subscribedMarkets = new Set<string>()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 1000
  private reconnectTimeout: number | null = null
  private pingInterval: number | null = null
  private messageCount = 0

  private tradeCallbacks = new Set<TradeCallback>()
  private orderCallbacks = new Set<OrderCallback>()
  private connectionCallbacks = new Set<ConnectionCallback>()

  private wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/user'

  /**
   * Set authentication credentials.
   * Called after CLOBClient.deriveApiKey() returns credentials.
   */
  setAuth(auth: UserChannelAuth): void {
    this.auth = auth
  }

  /**
   * Connect to the user channel WebSocket.
   * Requires auth credentials to be set first.
   * Idempotent — safe to call multiple times.
   */
  async connect(): Promise<boolean> {
    if (!this.auth) {
      console.warn('[UserChannel] Cannot connect — no auth credentials set')
      return false
    }

    // Already connected
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
        setTimeout(() => { clearInterval(check); resolve(false) }, 10_000)
      })
    }

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.wsUrl)

        this.ws.onopen = () => {
          console.log(`[UserChannel] Connected to ${this.wsUrl}`)
          this.reconnectAttempts = 0
          this.messageCount = 0
          this.startPingInterval()
          this.notifyConnectionCallbacks('connected')

          // Send auth handshake with optional market filter
          const initMsg: Record<string, unknown> = {
            type: 'user',
            auth: {
              apiKey: this.auth!.apiKey,
              secret: this.auth!.secret,
              passphrase: this.auth!.passphrase,
            },
          }
          if (this.subscribedMarkets.size > 0) {
            initMsg.markets = Array.from(this.subscribedMarkets)
          }
          this.ws?.send(JSON.stringify(initMsg))
          console.log(`[UserChannel] Auth sent, tracking ${this.subscribedMarkets.size} markets`)

          resolve(true)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onclose = () => {
          console.log('[UserChannel] Disconnected')
          this.stopPingInterval()
          this.notifyConnectionCallbacks('disconnected')
          this.attemptReconnect()
        }

        this.ws.onerror = (error) => {
          console.error('[UserChannel] WebSocket error:', error)
          this.notifyConnectionCallbacks('error')
          resolve(false)
        }
      } catch (error) {
        console.error('[UserChannel] Failed to connect:', error)
        resolve(false)
      }
    })
  }

  /**
   * Disconnect and clean up.
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    this.stopPingInterval()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.subscribedMarkets.clear()
  }

  /**
   * Subscribe to specific market condition IDs.
   * Can be called before or after connect.
   */
  subscribeMarkets(conditionIds: string[]): void {
    for (const id of conditionIds) {
      this.subscribedMarkets.add(id)
    }

    // If already connected, send dynamic subscription
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        markets: conditionIds,
        operation: 'subscribe',
      }))
    }
  }

  /**
   * Unsubscribe from specific market condition IDs.
   */
  unsubscribeMarkets(conditionIds: string[]): void {
    for (const id of conditionIds) {
      this.subscribedMarkets.delete(id)
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        markets: conditionIds,
        operation: 'unsubscribe',
      }))
    }
  }

  /**
   * Subscribe to trade events (fills, confirmations, failures).
   * Returns unsubscribe function.
   */
  onTrade(callback: TradeCallback): () => void {
    this.tradeCallbacks.add(callback)
    return () => this.tradeCallbacks.delete(callback)
  }

  /**
   * Subscribe to order events (placement, update, cancellation).
   * Returns unsubscribe function.
   */
  onOrder(callback: OrderCallback): () => void {
    this.orderCallbacks.add(callback)
    return () => this.orderCallbacks.delete(callback)
  }

  /**
   * Subscribe to connection status changes.
   * Returns unsubscribe function.
   */
  onConnectionChange(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.add(callback)
    return () => this.connectionCallbacks.delete(callback)
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  // ─── Internal Message Handling ────────────────────────────────

  private handleMessage(data: string): void {
    this.messageCount++
    if (this.messageCount === 1) {
      console.log('[UserChannel] First message received — pipeline active')
    }

    // Handle non-JSON responses (bare 'pong', 'PONG', 'INVALID OPERATION', etc.)
    // Same approach as RealtimeService: skip anything that isn't JSON-shaped
    if (!data.startsWith('{') && !data.startsWith('[')) {
      const upper = data.trim().toUpperCase()
      if (upper === 'PONG') return  // Normal keepalive response — silent
      if (upper === 'INVALID OPERATION') {
        console.error('[UserChannel] Server rejected operation — check auth credentials or subscription payload')
      } else if (data.trim().length > 0) {
        console.warn(`[UserChannel] Non-JSON message: "${data.trim().slice(0, 200)}"`)
      }
      return
    }

    try {
      const msg = JSON.parse(data) as Record<string, unknown>

      // Also ignore JSON-wrapped pong (in case server format varies)
      if (msg.type === 'pong' || msg.event_type === 'pong') return

      const eventType = (msg.event_type as string) || ''

      if (eventType === 'trade') {
        this.handleTradeEvent(msg as unknown as UserTradeMessage)
      } else if (
        eventType === 'PLACEMENT' ||
        eventType === 'UPDATE' ||
        eventType === 'CANCELLATION'
      ) {
        this.handleOrderEvent(msg as unknown as UserOrderMessage)
      } else {
        // Unknown event type — log for debugging
        console.debug('[UserChannel] Unknown event_type:', eventType, msg)
      }
    } catch (error) {
      // JSON.parse should never fail here (we already checked for '{' / '[' prefix)
      // but guard against malformed JSON just in case
      console.error('[UserChannel] Failed to parse JSON message:', error, `data="${data.slice(0, 200)}"`)
    }
  }

  private handleTradeEvent(msg: UserTradeMessage): void {
    console.log(
      `[UserChannel] Trade ${msg.status}: ${msg.side} ${msg.size} @ ${msg.price} ` +
      `(market: ${msg.market}, tx: ${msg.transaction_hash || 'pending'})`
    )
    for (const cb of this.tradeCallbacks) {
      try { cb(msg) } catch (e) { console.error('[UserChannel] Trade callback error:', e) }
    }
  }

  private handleOrderEvent(msg: UserOrderMessage): void {
    console.log(
      `[UserChannel] Order ${msg.event_type}: ${msg.order_id} ` +
      `${msg.side} ${msg.original_size} @ ${msg.price} (${msg.type})`
    )
    for (const cb of this.orderCallbacks) {
      try { cb(msg) } catch (e) { console.error('[UserChannel] Order callback error:', e) }
    }
  }

  // ─── Keepalive & Reconnect ──────────────────────────────────

  private startPingInterval(): void {
    this.stopPingInterval()
    this.pingInterval = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Polymarket CLOB WS expects bare 'ping' string, NOT JSON
        // (same as market channel in RealtimeService)
        this.ws.send('ping')
      }
    }, 30_000) // 30s keepalive, same as market channel
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[UserChannel] Max reconnect attempts reached — giving up')
      return
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++

    console.log(`[UserChannel] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    this.reconnectTimeout = window.setTimeout(() => {
      this.connect()
    }, delay)
  }

  private notifyConnectionCallbacks(status: 'connected' | 'disconnected' | 'error'): void {
    for (const cb of this.connectionCallbacks) {
      try { cb(status) } catch (e) { console.error('[UserChannel] Connection callback error:', e) }
    }
  }
}

// Singleton export
export const userChannelService = new UserChannelService()
