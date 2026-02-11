import type { RTDSMessage, RTDSCryptoPricePayload } from '@/types'

/**
 * Re-export the AssetPrice shape so consumers don't need to import from PriceOracleService.
 * Mirrors the interface exactly.
 */
export interface RTDSAssetPrice {
  symbol: 'BTC' | 'ETH' | 'SOL'
  priceUSD: number
  timestamp: number
  source: 'rtds'
}

type CryptoPriceCallback = (price: RTDSAssetPrice) => void
type ConnectionCallback = (status: 'connected' | 'disconnected' | 'error') => void

/**
 * RTDSService — Real-Time Data Socket
 *
 * Streams crypto prices (BTC, ETH, SOL) from Polymarket's RTDS feed.
 * Replaces Binance/CoinGecko HTTP polling in PriceOracleService as the
 * primary price source. PriceOracleService becomes the fallback.
 *
 * Key differences from RealtimeService (market channel):
 * - Different WebSocket URL: wss://ws-live-data.polymarket.com
 * - 5-second ping interval (not 30s)
 * - Different subscription format: { action: 'subscribe', subscriptions: [...] }
 * - No authentication required (gamma_auth optional for user-specific data)
 */
export class RTDSService {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 1000
  private reconnectTimeout: number | null = null
  private pingInterval: number | null = null
  private messageCount = 0

  private prices = new Map<string, RTDSAssetPrice>()
  private priceCallbacks = new Set<CryptoPriceCallback>()
  private connectionCallbacks = new Set<ConnectionCallback>()

  private wsUrl = 'wss://ws-live-data.polymarket.com'

  /**
   * Connect to RTDS WebSocket.
   * Idempotent — safe to call multiple times.
   */
  async connect(): Promise<boolean> {
    // Already connected
    if (this.ws?.readyState === WebSocket.OPEN) {
      return true
    }

    // Already connecting — wait
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
          console.log(`[RTDS] Connected to ${this.wsUrl}`)
          this.reconnectAttempts = 0
          this.messageCount = 0
          this.startPingInterval()
          this.notifyConnectionCallbacks('connected')
          resolve(true)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onclose = () => {
          console.log('[RTDS] Disconnected')
          this.stopPingInterval()
          this.notifyConnectionCallbacks('disconnected')
          this.attemptReconnect()
        }

        this.ws.onerror = (error) => {
          console.error('[RTDS] WebSocket error:', error)
          this.notifyConnectionCallbacks('error')
          resolve(false)
        }
      } catch (error) {
        console.error('[RTDS] Failed to connect:', error)
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
    this.prices.clear()
  }

  /**
   * Subscribe to crypto price updates for given symbols.
   * Must be called after connect().
   */
  subscribeCryptoPrices(symbols: ('BTC' | 'ETH' | 'SOL')[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn('[RTDS] Cannot subscribe — not connected')
      return
    }

    const subscriptions = symbols.map(symbol => ({
      topic: 'crypto_prices',
      type: 'price_update',
      filters: symbol,
    }))

    this.ws.send(JSON.stringify({
      action: 'subscribe',
      subscriptions,
    }))

    console.log(`[RTDS] Subscribed to crypto prices: ${symbols.join(', ')}`)
  }

  /**
   * Unsubscribe from crypto price updates.
   */
  unsubscribeCryptoPrices(symbols: ('BTC' | 'ETH' | 'SOL')[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return

    const subscriptions = symbols.map(symbol => ({
      topic: 'crypto_prices',
      type: 'price_update',
      filters: symbol,
    }))

    this.ws.send(JSON.stringify({
      action: 'unsubscribe',
      subscriptions,
    }))
  }

  /**
   * Get cached latest price for a symbol.
   * Synchronous — returns null if no RTDS data available.
   */
  getCachedPrice(symbol: 'BTC' | 'ETH' | 'SOL'): RTDSAssetPrice | null {
    return this.prices.get(symbol) || null
  }

  /**
   * Subscribe to price update events.
   * Returns unsubscribe function.
   */
  onPriceUpdate(callback: CryptoPriceCallback): () => void {
    this.priceCallbacks.add(callback)
    return () => this.priceCallbacks.delete(callback)
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
      console.log('[RTDS] First message received — pipeline active')
    }

    try {
      const msg = JSON.parse(data) as RTDSMessage

      // Ignore pong keepalive
      if (msg.type === 'pong') return

      if (msg.topic === 'crypto_prices') {
        this.handleCryptoPriceUpdate(msg.payload as RTDSCryptoPricePayload)
      } else {
        console.debug('[RTDS] Unknown topic:', msg.topic)
      }
    } catch (error) {
      console.error('[RTDS] Failed to parse message:', error)
    }
  }

  private handleCryptoPriceUpdate(payload: RTDSCryptoPricePayload): void {
    if (!payload?.symbol || !payload?.price) return

    // Normalize symbol to our format
    const symbol = payload.symbol.toUpperCase() as 'BTC' | 'ETH' | 'SOL'
    if (!['BTC', 'ETH', 'SOL'].includes(symbol)) return

    const price: RTDSAssetPrice = {
      symbol,
      priceUSD: payload.price,
      timestamp: Date.now(),
      source: 'rtds',
    }

    this.prices.set(symbol, price)

    // Notify all callbacks
    for (const cb of this.priceCallbacks) {
      try { cb(price) } catch (e) { console.error('[RTDS] Price callback error:', e) }
    }
  }

  // ─── Keepalive & Reconnect ──────────────────────────────────

  private startPingInterval(): void {
    this.stopPingInterval()
    // RTDS requires 5-second pings (different from 30s for CLOB market WS)
    this.pingInterval = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, 5_000)
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[RTDS] Max reconnect attempts reached — giving up')
      return
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++

    console.log(`[RTDS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

    this.reconnectTimeout = window.setTimeout(() => {
      this.connect().then(connected => {
        if (connected) {
          // Re-subscribe to crypto prices on reconnect
          this.subscribeCryptoPrices(['BTC', 'ETH', 'SOL'])
        }
      })
    }, delay)
  }

  private notifyConnectionCallbacks(status: 'connected' | 'disconnected' | 'error'): void {
    for (const cb of this.connectionCallbacks) {
      try { cb(status) } catch (e) { console.error('[RTDS] Connection callback error:', e) }
    }
  }
}

// Singleton export
export const rtdsService = new RTDSService()
