/**
 * HyperliquidWSService — Real-time liquidation event streaming via Hyperliquid WebSocket
 *
 * Subscribes to BTC trades on Hyperliquid and filters for liquidation events.
 * Emits structured LiquidationEvent objects with side (long/short), USD size, and price.
 *
 * Free, no API key required. Public trade feed.
 *
 * Side mapping:
 *   Hyperliquid side 'B' (sell) = a long was force-closed → side: 'long'
 *   Hyperliquid side 'A' (buy)  = a short was force-closed → side: 'short'
 */

export interface LiquidationEvent {
  coin: string
  side: 'long' | 'short'
  sizeUSD: number
  price: number
  timestamp: number
}

type LiquidationCallback = (event: LiquidationEvent) => void
type ConnectionCallback = (status: 'connected' | 'disconnected' | 'error') => void

/** Raw Hyperliquid trade message within the channel payload */
interface HyperliquidTrade {
  coin: string
  side: 'A' | 'B'
  px: string
  sz: string
  time: number
  liquidation?: boolean
  tid: number
}

// In dev, route through Vite's WebSocket proxy to avoid browser Origin-header rejections.
// In production (Netlify etc.), connect directly to Hyperliquid.
const HYPERLIQUID_WS_URL = import.meta.env.VITE_HYPERLIQUID_WS_URL
  || (import.meta.env.DEV
    ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/hyperliquid`
    : 'wss://api.hyperliquid.xyz/ws')

export class HyperliquidWSService {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 1000
  private reconnectTimeout: number | null = null
  private stableResetTimeout: number | null = null
  private stalenessInterval: number | null = null
  private lastConnectTime = 0
  private lastMessageTime = 0

  private liqCallbacks = new Set<LiquidationCallback>()
  private connectionCallbacks = new Set<ConnectionCallback>()

  /**
   * Connect to Hyperliquid WebSocket and subscribe to BTC trades.
   * Idempotent — safe to call multiple times.
   */
  async connect(): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) return true

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
        this.ws = new WebSocket(HYPERLIQUID_WS_URL)

        this.ws.onopen = () => {
          console.log('[HyperliquidWS] Connected — subscribing to BTC trades')
          this.lastConnectTime = Date.now()
          this.lastMessageTime = Date.now()

          // Subscribe to BTC trades
          this.ws!.send(JSON.stringify({
            method: 'subscribe',
            subscription: { type: 'trades', coin: 'BTC' },
          }))

          // Only reset attempts after connection stays up for 5s
          if (this.stableResetTimeout) clearTimeout(this.stableResetTimeout)
          this.stableResetTimeout = window.setTimeout(() => {
            this.reconnectAttempts = 0
          }, 5_000)

          this.startStalenessCheck()
          this.notifyConnection('connected')
          resolve(true)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onclose = () => {
          if (this.stableResetTimeout) {
            clearTimeout(this.stableResetTimeout)
            this.stableResetTimeout = null
          }
          const uptime = Date.now() - this.lastConnectTime
          if (uptime < 3_000) {
            console.log(`[HyperliquidWS] Disconnected after ${uptime}ms (unstable)`)
          } else {
            console.log('[HyperliquidWS] Disconnected')
          }
          this.notifyConnection('disconnected')
          this.attemptReconnect()
        }

        this.ws.onerror = (error) => {
          console.error('[HyperliquidWS] WebSocket error:', error)
          this.notifyConnection('error')
          resolve(false)
        }
      } catch (error) {
        console.error('[HyperliquidWS] Failed to connect:', error)
        resolve(false)
      }
    })
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.stableResetTimeout) {
      clearTimeout(this.stableResetTimeout)
      this.stableResetTimeout = null
    }
    this.stopStalenessCheck()
    if (this.ws) {
      this.ws.onclose = null // Prevent reconnect on intentional close
      this.ws.close()
      this.ws = null
    }
  }

  /** Subscribe to liquidation events. Returns unsubscribe function. */
  onLiquidation(callback: LiquidationCallback): () => void {
    this.liqCallbacks.add(callback)
    return () => this.liqCallbacks.delete(callback)
  }

  /** Subscribe to connection status changes. Returns unsubscribe function. */
  onConnectionChange(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.add(callback)
    return () => this.connectionCallbacks.delete(callback)
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  // ─── Internal ────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    this.lastMessageTime = Date.now()
    try {
      const msg = JSON.parse(raw)

      // Subscription confirmation
      if (msg.channel === 'subscriptionResponse') return

      // Trade channel messages: { channel: 'trades', data: [{ ... }] }
      if (msg.channel !== 'trades' || !Array.isArray(msg.data)) return

      for (const trade of msg.data as HyperliquidTrade[]) {
        if (!trade.liquidation) continue

        const price = parseFloat(trade.px)
        const size = parseFloat(trade.sz)
        if (price <= 0 || size <= 0) continue

        // Side mapping:
        // Hyperliquid 'B' (sell taker) = exchange sold a long's collateral → long liquidated
        // Hyperliquid 'A' (buy taker) = exchange bought to close a short → short liquidated
        const liqEvent: LiquidationEvent = {
          coin: trade.coin,
          side: trade.side === 'B' ? 'long' : 'short',
          sizeUSD: size * price,
          price,
          timestamp: trade.time || Date.now(),
        }

        for (const cb of this.liqCallbacks) {
          try { cb(liqEvent) } catch (e) { console.error('[HyperliquidWS] Callback error:', e) }
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  /** Hyperliquid trades arrive frequently. If no data for 30s, connection is dead. */
  private startStalenessCheck(): void {
    this.stopStalenessCheck()
    this.stalenessInterval = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && this.lastMessageTime > 0) {
        const silenceDuration = Date.now() - this.lastMessageTime
        if (silenceDuration > 30_000) {
          console.warn(`[HyperliquidWS] No data for ${Math.round(silenceDuration / 1000)}s — force-reconnecting`)
          this.ws.close()
        }
      }
    }, 10_000)
  }

  private stopStalenessCheck(): void {
    if (this.stalenessInterval) {
      clearInterval(this.stalenessInterval)
      this.stalenessInterval = null
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[HyperliquidWS] Max reconnect attempts reached')
      // Don't trigger emergency stop — this is an auxiliary data source, not critical like BinanceWS
      return
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++

    console.log(`[HyperliquidWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    this.reconnectTimeout = window.setTimeout(() => {
      this.connect()
    }, delay)
  }

  private notifyConnection(status: 'connected' | 'disconnected' | 'error'): void {
    for (const cb of this.connectionCallbacks) {
      try { cb(status) } catch (e) { console.error('[HyperliquidWS] Connection callback error:', e) }
    }
  }
}

// Singleton export
export const hyperliquidWSService = new HyperliquidWSService()
