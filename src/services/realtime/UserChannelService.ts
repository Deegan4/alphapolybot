/**
 * UserChannelService — Polymarket US Private WebSocket
 *
 * Uses the SDK's PrivateWebSocket for authenticated push events:
 *   - Order executions (fills, cancels, rejects)
 *   - Position updates
 *   - Account balance changes
 *
 * Public interface preserved from CLOB version:
 *   connect(), disconnect(), onTrade(), onOrder(),
 *   onConnectionChange(), isConnected()
 */

import {
  PrivateWebSocket,
  type OrderUpdate,
  type OrderSnapshot,
  type PositionUpdate,
  type PositionSnapshot,
  type AccountBalanceUpdate,
  type AccountBalanceSnapshot,
} from 'polymarket-us'
import type { USOrderExecution, USPositionUpdate } from '@/types'
import { polymarketUSClient } from '@/services/api'

/** Mapped from SDK OrderUpdate execution data */
type TradeCallback = (exec: USOrderExecution) => void
/** Mapped from SDK OrderUpdate (order state changes) */
type OrderCallback = (exec: USOrderExecution) => void
type PositionCallback = (update: USPositionUpdate) => void
type BalanceCallback = (balance: number, buyingPower: number) => void
type ConnectionCallback = (status: 'connected' | 'disconnected' | 'error') => void

export class UserChannelService {
  private ws: PrivateWebSocket | null = null
  private subscribedSlugs = new Set<string>()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectDelay = 1000
  private reconnectTimeout: number | null = null
  private requestIdCounter = 0
  private messageCount = 0
  /** Set by disconnect() so the resulting close does not schedule a reconnect */
  private closingIntentionally = false
  /** True after max reconnect attempts failed; cleared by a successful open */
  private gaveUp = false
  /** Latest pushed balance; null until the first snapshot or after the socket closes */
  private latestBalance: { balance: number; buyingPower: number; at: number } | null = null

  private tradeCallbacks = new Set<TradeCallback>()
  private orderCallbacks = new Set<OrderCallback>()
  private positionCallbacks = new Set<PositionCallback>()
  private balanceCallbacks = new Set<BalanceCallback>()
  private connectionCallbacks = new Set<ConnectionCallback>()

  /**
   * Connect to Polymarket US Private WebSocket.
   * Requires credentials to be set on polymarketUSClient.
   * Idempotent — safe to call multiple times.
   */
  async connect(): Promise<boolean> {
    if (this.ws?.isConnected) return true
    this.closingIntentionally = false

    const wsOpts = polymarketUSClient.getWebSocketOptions()
    if (!wsOpts) {
      console.warn('[UserChannel] Cannot connect — no credentials configured')
      return false
    }

    return new Promise((resolve) => {
      try {
        this.ws = new PrivateWebSocket({
          keyId: wsOpts.keyId,
          secretKey: wsOpts.secretKey,
          baseUrl: wsOpts.baseUrl,
        })

        this.ws.on('open', () => {
          console.log('[UserChannel] Private WebSocket connected')
          this.reconnectAttempts = 0
          this.gaveUp = false
          this.messageCount = 0
          this.notifyConnectionCallbacks('connected')

          // Subscribe to all three private channels
          const reqId = this.nextRequestId()
          this.ws!.subscribeOrders(reqId, this.subscribedSlugs.size > 0 ? Array.from(this.subscribedSlugs) : undefined)

          const reqId2 = this.nextRequestId()
          this.ws!.subscribePositions(reqId2, this.subscribedSlugs.size > 0 ? Array.from(this.subscribedSlugs) : undefined)

          const reqId3 = this.nextRequestId()
          this.ws!.subscribeAccountBalance(reqId3)

          console.log(`[UserChannel] Subscribed to orders, positions, balance`)
          resolve(true)
        })

        // ─── Order Events ──────────────────────────────────
        this.ws.on('orderSnapshot', (data: OrderSnapshot) => {
          this.messageCount++
          if (this.messageCount === 1) {
            console.log('[UserChannel] First message received — pipeline active')
          }
          const orders = data.orderSubscriptionSnapshot.orders || []
          console.log(`[UserChannel] Order snapshot: ${orders.length} open orders`)
        })

        this.ws.on('orderUpdate', (data: OrderUpdate) => {
          this.messageCount++
          const exec = data.orderSubscriptionUpdate.execution
          const mapped = this.mapExecution(exec)

          // Trade callbacks get fill executions
          if (exec.type === 'EXECUTION_TYPE_FILL' || exec.type === 'EXECUTION_TYPE_PARTIAL_FILL') {
            for (const cb of this.tradeCallbacks) {
              try { cb(mapped) } catch (e) { console.error('[UserChannel] Trade callback error:', e) }
            }
          }

          // Order callbacks get all execution types
          for (const cb of this.orderCallbacks) {
            try { cb(mapped) } catch (e) { console.error('[UserChannel] Order callback error:', e) }
          }
        })

        // ─── Position Events ───────────────────────────────
        this.ws.on('positionSnapshot', (data: PositionSnapshot) => {
          this.messageCount++
          const positions = data.positionSubscriptionSnapshot.positions || {}
          console.log(`[UserChannel] Position snapshot: ${Object.keys(positions).length} positions`)
        })

        this.ws.on('positionUpdate', (data: PositionUpdate) => {
          this.messageCount++
          const update = data.positionSubscriptionUpdate
          const mapped: USPositionUpdate = {
            marketSlug: update.marketSlug,
            netPosition: update.position.netPosition?.toString() || '0',
            cost: parseFloat(update.position.cost?.toString() || '0'),
            realized: parseFloat(update.position.realized?.toString() || '0'),
          }

          for (const cb of this.positionCallbacks) {
            try { cb(mapped) } catch (e) { console.error('[UserChannel] Position callback error:', e) }
          }
        })

        // ─── Balance Events ────────────────────────────────
        this.ws.on('accountBalanceSnapshot', (data: AccountBalanceSnapshot) => {
          this.messageCount++
          const snap = data.accountBalanceSubscriptionSnapshot
          console.log(`[UserChannel] Balance snapshot: $${snap.balance} (buying power: $${snap.buyingPower})`)
          this.notifyBalanceCallbacks(snap.balance, snap.buyingPower)
        })

        this.ws.on('accountBalanceUpdate', (data: AccountBalanceUpdate) => {
          this.messageCount++
          const update = data.accountBalanceSubscriptionUpdate
          this.notifyBalanceCallbacks(update.balance, update.buyingPower)
        })

        this.ws.on('heartbeat', () => {
          // SDK handles keepalive internally
        })

        this.ws.on('error', (err) => {
          console.error('[UserChannel] WebSocket error:', err)
          this.notifyConnectionCallbacks('error')
          resolve(false)
        })

        this.ws.on('close', () => {
          console.log('[UserChannel] WebSocket disconnected')
          // Balance pushes stop with the socket: callers fall back to REST
          this.latestBalance = null
          this.notifyConnectionCallbacks('disconnected')
          if (this.closingIntentionally) return
          this.attemptReconnect()
        })

        this.ws.connect()
      } catch (error) {
        console.error('[UserChannel] Failed to connect:', error)
        resolve(false)
      }
    })
  }

  disconnect(): void {
    this.closingIntentionally = true
    this.latestBalance = null
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.subscribedSlugs.clear()
  }

  /**
   * Subscribe to specific market slugs.
   * Can be called before or after connect.
   */
  subscribeMarkets(slugs: string[]): void {
    for (const slug of slugs) {
      this.subscribedSlugs.add(slug)
    }
    // If connected, new subscriptions take effect on next reconnect
    // (SDK doesn't support incremental private subscriptions mid-session)
  }

  unsubscribeMarkets(slugs: string[]): void {
    for (const slug of slugs) {
      this.subscribedSlugs.delete(slug)
    }
  }

  /**
   * Subscribe to trade events (fills).
   * Returns unsubscribe function.
   */
  onTrade(callback: TradeCallback): () => void {
    this.tradeCallbacks.add(callback)
    return () => this.tradeCallbacks.delete(callback)
  }

  /**
   * Subscribe to all order execution events (fills, cancels, rejects, etc.).
   * Returns unsubscribe function.
   */
  onOrder(callback: OrderCallback): () => void {
    this.orderCallbacks.add(callback)
    return () => this.orderCallbacks.delete(callback)
  }

  /**
   * Subscribe to position updates.
   * Returns unsubscribe function.
   */
  onPosition(callback: PositionCallback): () => void {
    this.positionCallbacks.add(callback)
    return () => this.positionCallbacks.delete(callback)
  }

  /**
   * Subscribe to balance changes.
   * Returns unsubscribe function.
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
    return this.ws?.isConnected ?? false
  }

  /** Whether reconnecting stopped after the maximum attempts (REST fallback only) */
  hasGivenUp(): boolean {
    return this.gaveUp && !this.isConnected()
  }

  /** Manual retry after giving up: start a fresh round of reconnect attempts */
  async retry(): Promise<boolean> {
    this.reconnectAttempts = 0
    this.gaveUp = false
    return this.connect()
  }

  /**
   * Balance and buying power pushed by the private feed (snapshot on
   * subscribe, then an update on every change). Null when the socket is down
   * or has not sent a snapshot yet, so callers know to use REST instead.
   */
  getLatestBalance(): { balance: number; buyingPower: number; at: number } | null {
    return this.isConnected() ? this.latestBalance : null
  }

  // ─── Private ────────────────────────────────────────────

  private nextRequestId(): string {
    return `priv-${++this.requestIdCounter}-${Date.now()}`
  }

  private mapExecution(exec: {
    id: string
    order: { id: string; marketSlug: string; side: string; intent: string; quantity?: number; cumQuantity?: number; leavesQuantity?: number; state?: string }
    lastShares?: string
    lastPx?: { value: string }
    type: string
    transactTime?: string
    tradeId?: string
    aggressor?: boolean
  }): USOrderExecution {
    return {
      id: exec.id,
      orderId: exec.order.id,
      marketSlug: exec.order.marketSlug,
      side: exec.order.side,
      intent: exec.order.intent as USOrderExecution['intent'],
      lastShares: exec.lastShares,
      lastPx: exec.lastPx ? parseFloat(exec.lastPx.value) : undefined,
      type: exec.type,
      transactTime: exec.transactTime,
      tradeId: exec.tradeId,
      aggressor: exec.aggressor,
      orderQuantity: exec.order.quantity,
      cumQuantity: exec.order.cumQuantity,
      leavesQuantity: exec.order.leavesQuantity,
      orderState: exec.order.state,
    }
  }

  private notifyBalanceCallbacks(balance: number, buyingPower: number): void {
    if (Number.isFinite(balance) && Number.isFinite(buyingPower)) {
      this.latestBalance = { balance, buyingPower, at: Date.now() }
    }
    for (const cb of this.balanceCallbacks) {
      try { cb(balance, buyingPower) } catch (e) { console.error('[UserChannel] Balance callback error:', e) }
    }
  }

  private notifyConnectionCallbacks(status: 'connected' | 'disconnected' | 'error'): void {
    for (const cb of this.connectionCallbacks) {
      try { cb(status) } catch (e) { console.error('[UserChannel] Connection callback error:', e) }
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[UserChannel] Max reconnect attempts reached')
      this.gaveUp = true
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
