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
  private subscriptions = new Set<string>()
  private prices = new Map<string, PriceData>()
  
  private priceCallbacks = new Set<PriceUpdateCallback>()
  private connectionCallbacks = new Set<ConnectionCallback>()

  private wsUrl = import.meta.env.VITE_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws'

  /**
   * Connect to WebSocket
   */
  async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(this.wsUrl)

        this.ws.onopen = () => {
          console.log('WebSocket connected')
          this.reconnectAttempts = 0
          this.startPingInterval()
          this.notifyConnectionCallbacks('connected')
          
          // Resubscribe to previous subscriptions
          for (const tokenId of this.subscriptions) {
            this.subscribeToToken(tokenId)
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
    this.stopPingInterval()
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

  // Private methods

  private subscribeToToken(tokenId: string): void {
    if (!this.isConnected()) return

    const message = JSON.stringify({
      type: 'subscribe',
      channel: 'market',
      assets_ids: [tokenId],
    })

    this.ws?.send(message)
  }

  private unsubscribeFromToken(tokenId: string): void {
    if (!this.isConnected()) return

    const message = JSON.stringify({
      type: 'unsubscribe',
      channel: 'market',
      assets_ids: [tokenId],
    })

    this.ws?.send(message)
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data)

      // Handle different message types
      switch (message.type || message.event_type) {
        case 'price_change':
        case 'book':
          this.handlePriceUpdate(message)
          break
        case 'trade':
          this.handleTradeUpdate(message)
          break
        case 'pong':
          // Ping response, connection is alive
          break
        default:
          // Unknown message type, log for debugging
          if (import.meta.env.VITE_DEBUG_MODE === 'true') {
            console.log('Unknown WS message:', message)
          }
      }
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error)
    }
  }

  private handlePriceUpdate(message: {
    asset_id?: string
    market?: string
    price?: number
    best_bid?: number
    best_ask?: number
    timestamp?: number
  }): void {
    const tokenId = message.asset_id || message.market
    if (!tokenId) return

    const bid = message.best_bid || message.price || 0
    const ask = message.best_ask || message.price || 0
    const mid = (bid + ask) / 2

    const priceData: PriceData = {
      bid,
      ask,
      last: message.price || mid,
      mid,
      spread: ask - bid,
      timestamp: new Date(message.timestamp || Date.now()),
    }

    this.prices.set(tokenId, priceData)
    this.notifyPriceCallbacks(tokenId, priceData)
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

    setTimeout(() => {
      this.connect()
    }, delay)
  }

  private startPingInterval(): void {
    this.pingInterval = window.setInterval(() => {
      if (this.isConnected()) {
        this.ws?.send(JSON.stringify({ type: 'ping' }))
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
