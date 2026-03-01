/**
 * UserChannelService — CLOB Private WebSocket
 *
 * Native WebSocket to wss://ws-subscriptions-clob.polymarket.com/ws/user
 * for authenticated push events: trade fills, order updates, balance changes.
 *
 * Protocol:
 *   - Auth: { type: 'user', auth: { apiKey, secret, passphrase } }
 *   - Trade events: { event_type: 'trade', asset_id, maker_orders, status, ... }
 *   - Order events: { event_type: 'order', order_id, asset_id, status, ... }
 *   - 30s ping keepalive
 *
 * Public interface:
 *   connect(), disconnect(), onTrade(), onOrder(),
 *   onConnectionChange(), isConnected()
 */

import type { CLOBTradeEvent, CLOBOrderEvent } from '@/types'

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user'
const PING_INTERVAL_MS = 30_000

type TradeCallback = (event: CLOBTradeEvent) => void
type OrderCallback = (event: CLOBOrderEvent) => void
type BalanceCallback = (balance: number, buyingPower: number) => void
type ConnectionCallback = (status: 'connected' | 'disconnected' | 'error') => void

export class UserChannelService {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 1000
  private reconnectTimeout: number | null = null
  private pingInterval: number | null = null
  private messageCount = 0
  private lastMessageTime = 0

  private tradeCallbacks = new Set<TradeCallback>()
  private orderCallbacks = new Set<OrderCallback>()
  private balanceCallbacks = new Set<BalanceCallback>()
  private connectionCallbacks = new Set<ConnectionCallback>()

  /**
   * Connect to CLOB Private WebSocket.
   * Requires CLOB API credentials (derived from wallet).
   * Idempotent — safe to call multiple times.
   */
  async connect(): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) return true

    // Get CLOB credentials dynamically
    const creds = await this.getCredentials()
    if (!creds) {
      console.warn('[UserChannel] Cannot connect — no CLOB credentials')
      return false
    }

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(WS_URL)

        this.ws.onopen = () => {
          console.log('[UserChannel] WebSocket connected, authenticating...')
          this.reconnectAttempts = 0
          this.messageCount = 0

          // Send auth handshake
          this.send({
            type: 'user',
            auth: {
              apiKey: creds.key,
              secret: creds.secret,
              passphrase: creds.passphrase,
            },
          })

          this.startPingInterval()
          this.notifyConnectionCallbacks('connected')
          console.log('[UserChannel] Authenticated — listening for trade/order events')
          resolve(true)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.ws.onerror = (err) => {
          console.error('[UserChannel] WebSocket error:', err)
          this.notifyConnectionCallbacks('error')
          resolve(false)
        }

        this.ws.onclose = () => {
          console.log('[UserChannel] WebSocket disconnected')
          this.stopPingInterval()
          this.notifyConnectionCallbacks('disconnected')
          this.attemptReconnect()
        }
      } catch (error) {
        console.error('[UserChannel] Failed to connect:', error)
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
    if (this.ws) {
      this.ws.onclose = null  // prevent reconnect
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Subscribe to trade events (fills).
   * CLOB user channel pushes all user trades — no per-market subscription needed.
   */
  onTrade(callback: TradeCallback): () => void {
    this.tradeCallbacks.add(callback)
    return () => this.tradeCallbacks.delete(callback)
  }

  /**
   * Subscribe to order events (fills, cancels, etc.).
   */
  onOrder(callback: OrderCallback): () => void {
    this.orderCallbacks.add(callback)
    return () => this.orderCallbacks.delete(callback)
  }

  /**
   * Subscribe to balance changes.
   */
  onBalance(callback: BalanceCallback): () => void {
    this.balanceCallbacks.add(callback)
    return () => this.balanceCallbacks.delete(callback)
  }

  onConnectionChange(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.add(callback)
    return () => this.connectionCallbacks.delete(callback)
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  // ─── Private: Message Handling ─────────────────────────

  private handleMessage(raw: string): void {
    this.lastMessageTime = Date.now()

    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }

    const events = Array.isArray(data) ? data : [data]

    for (const event of events) {
      if (!event || typeof event !== 'object') continue
      const evt = event as Record<string, unknown>

      this.messageCount++
      if (this.messageCount === 1) {
        console.log('[UserChannel] First message received — pipeline active')
      }

      const eventType = evt.event_type as string

      if (eventType === 'trade') {
        this.handleTradeEvent(evt)
      } else if (eventType === 'order') {
        this.handleOrderEvent(evt)
      } else if (eventType === 'balance') {
        this.handleBalanceEvent(evt)
      }
      // Ignore auth_success, heartbeat, etc.
    }
  }

  private handleTradeEvent(evt: Record<string, unknown>): void {
    const trade: CLOBTradeEvent = {
      id: (evt.id as string) || '',
      asset_id: (evt.asset_id as string) || '',
      maker_address: evt.maker_address as string | undefined,
      taker_address: evt.taker_address as string | undefined,
      side: (evt.side as string) || '',
      price: (evt.price as string) || '0',
      size: (evt.size as string) || '0',
      timestamp: (evt.timestamp as string) || new Date().toISOString(),
      status: (evt.status as string) || '',
      trade_owner: evt.trade_owner as string | undefined,
      type: evt.type as string | undefined,
      // Pass through extra fields consumers may access
      ...(evt.maker_orders ? { maker_orders: evt.maker_orders } : {}),
      ...(evt.market_slug ? { market_slug: evt.market_slug } : {}),
    }

    for (const cb of this.tradeCallbacks) {
      try { cb(trade as CLOBTradeEvent) } catch (e) { console.error('[UserChannel] Trade callback error:', e) }
    }
  }

  private handleOrderEvent(evt: Record<string, unknown>): void {
    const order: CLOBOrderEvent = {
      id: (evt.id as string) || '',
      asset_id: (evt.asset_id as string) || '',
      side: (evt.side as string) || '',
      price: (evt.price as string) || '0',
      original_size: (evt.original_size as string) || '0',
      size_matched: (evt.size_matched as string) || '0',
      status: (evt.status as string) || '',
      maker_address: evt.maker_address as string | undefined,
      timestamp: evt.timestamp as string | undefined,
      // Pass through extra fields consumers may access
      ...(evt.event_type ? { event_type: evt.event_type } : {}),
      ...(evt.order_id ? { order_id: evt.order_id } : {}),
    }

    for (const cb of this.orderCallbacks) {
      try { cb(order as CLOBOrderEvent) } catch (e) { console.error('[UserChannel] Order callback error:', e) }
    }
  }

  private handleBalanceEvent(evt: Record<string, unknown>): void {
    const balance = parseFloat((evt.balance as string) || '0')
    const buyingPower = parseFloat((evt.buying_power as string) || (evt.buyingPower as string) || '0')

    for (const cb of this.balanceCallbacks) {
      try { cb(balance, buyingPower) } catch (e) { console.error('[UserChannel] Balance callback error:', e) }
    }
  }

  // ─── Private: Auth & Credentials ───────────────────────

  private async getCredentials(): Promise<{ key: string; secret: string; passphrase: string } | null> {
    try {
      const { polymarketClient } = await import('@/services/api')
      return polymarketClient.getCredentials()
    } catch {
      return null
    }
  }

  // ─── Private: Callbacks ────────────────────────────────

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private notifyConnectionCallbacks(status: 'connected' | 'disconnected' | 'error'): void {
    for (const cb of this.connectionCallbacks) {
      try { cb(status) } catch (e) { console.error('[UserChannel] Connection callback error:', e) }
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
          console.warn(`[UserChannel] No data for ${Math.round(silenceDuration / 1000)}s — force-reconnecting`)
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
      console.error('[UserChannel] Max reconnect attempts reached — triggering emergency stop')
      import('@/services/trading/RiskManager').then(({ riskManager }) => {
        riskManager.emergencyStop('UserChannel WebSocket died after max reconnect attempts')
      }).catch(() => {})
      return
    }
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++
    console.log(`[UserChannel] Reconnecting in ${delay}ms (${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null
      this.connect()
    }, delay)
  }
}

export const userChannelService = new UserChannelService()
