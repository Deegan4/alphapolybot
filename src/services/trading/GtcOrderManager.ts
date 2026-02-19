import type { PendingGtcOrder } from '@/types'
import { polymarketUSClient } from '@/services/api'
import { riskManager } from './RiskManager'
import { activityLogger } from './ActivityLogger'

type OrderChangeCallback = (orders: PendingGtcOrder[]) => void

/**
 * GTC Order Manager
 *
 * Tracks pending GTD (Good-Til-Date) limit orders that were submitted as
 * fallback when FOK orders were killed due to liquidity. Polls the PM US
 * API for fill status and hands off to PLM on fill.
 *
 * Lifecycle: initialize() once from App.tsx, destroy() on teardown.
 */
export class GtcOrderManager {
  private orders = new Map<string, PendingGtcOrder>()
  private pollInterval: number | null = null
  private initialized = false
  private callbacks = new Set<OrderChangeCallback>()

  // Config — poll interval increased to 60s because user channel push handles real-time fills
  private pollIntervalMs = 60_000
  private userChannelUnsubs: (() => void)[] = []

  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    // Register capital reservation with RiskManager (avoids circular dep)
    riskManager.setCapitalReservationFn(() => this.getReservedCapital())

    // Hydrate from IndexedDB
    this.hydrateFromStorage()

    // Subscribe to user channel for real-time fill/cancel notifications
    this.subscribeToUserChannel()

    // Start safety-net polling (60s — user channel handles the fast path)
    this.pollInterval = window.setInterval(
      () => this.pollOrders(),
      this.pollIntervalMs,
    )

    console.log('[GtcOrderManager] Initialized — user channel + 60s safety-net polling')
  }

  destroy(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    // Unsubscribe from user channel
    for (const unsub of this.userChannelUnsubs) unsub()
    this.userChannelUnsubs = []
    this.initialized = false
  }

  /**
   * Subscribe to user channel for real-time order fill and cancellation events.
   * Uses dynamic import to avoid circular deps.
   */
  private subscribeToUserChannel(): void {
    import('@/services/realtime').then(({ userChannelService }) => {
      if (!userChannelService.isConnected()) {
        console.log('[GtcOrderManager] User channel not connected — relying on polling')
        return
      }

      // Listen for trade fills
      const unsubTrade = userChannelService.onTrade((msg) => {
        if (msg.status !== 'CONFIRMED') return
        // Check if any of our tracked orders were filled
        for (const makerOrder of msg.maker_orders || []) {
          const pending = this.orders.get(makerOrder.order_id)
          if (pending && pending.status === 'pending') {
            console.log(`[GtcOrderManager] Order ${makerOrder.order_id} filled via user channel`)
            this.handleFill(pending)
          }
        }
      })

      // Listen for order cancellations
      const unsubOrder = userChannelService.onOrder((msg) => {
        if (msg.event_type !== 'CANCELLATION') return
        const pending = this.orders.get(msg.order_id)
        if (pending && pending.status === 'pending') {
          console.log(`[GtcOrderManager] Order ${msg.order_id} cancelled via user channel`)
          pending.status = 'cancelled'
          this.removeOrder(msg.order_id)
        }
      })

      this.userChannelUnsubs.push(unsubTrade, unsubOrder)
      console.log('[GtcOrderManager] Subscribed to user channel for real-time fill/cancel events')
    }).catch(() => {
      console.log('[GtcOrderManager] User channel not available — relying on polling')
    })
  }

  /**
   * Track a new pending GTD order
   * Called by TradingService after successful GTD order placement
   */
  trackOrder(order: PendingGtcOrder): void {
    this.orders.set(order.orderId, order)

    activityLogger.logInfo(
      `GTD order pending: ${order.question.substring(0, 40)}...`,
      {
        orderId: order.orderId,
        marketSlug: order.marketSlug,
        price: order.price,
        size: order.size,
        expiresAt: order.expiresAt,
        strategy: order.strategy,
      },
    )

    this.persistToStorage(order)
    this.notifyCallbacks()
    console.log(`[GtcOrderManager] Tracking ${this.orders.size} pending order(s)`)
  }

  /**
   * Poll PM US API for order status — batch via single getOpenOrders() call
   */
  private async pollOrders(): Promise<void> {
    if (this.orders.size === 0) return

    try {
      // Collect slugs for efficient batch query
      const slugs = [...new Set([...this.orders.values()].map(o => o.marketSlug))]
      const openOrders = await polymarketUSClient.getOpenOrders(slugs)
      const openOrderIds = new Set(openOrders.map(o => o.id))

      for (const [orderId, pending] of this.orders) {
        if (pending.status !== 'pending') continue

        if (openOrderIds.has(orderId)) {
          // Order is still open — check if partially filled
          const apiOrder = openOrders.find(o => o.id === orderId)
          if (apiOrder?.filledSize && apiOrder.filledSize >= pending.size) {
            // Fully filled
            await this.handleFill(pending)
          }
          // Otherwise still waiting — nothing to do
        } else {
          // Order is no longer open — it either filled or expired/cancelled
          const nowSec = Math.floor(Date.now() / 1000)
          if (pending.expiresAt > 0 && nowSec >= pending.expiresAt) {
            this.handleExpiry(pending)
          } else {
            // Disappeared before expiry — assume filled (exchange filled + removed)
            await this.handleFill(pending)
          }
        }
      }
    } catch (error) {
      // Poll failures are non-critical — will retry next interval
      console.warn('[GtcOrderManager] Poll failed:', error)
    }
  }

  /**
   * Handle a GTD order that has been filled
   */
  private async handleFill(order: PendingGtcOrder): Promise<void> {
    order.status = 'filled'

    activityLogger.logTrade(
      `GTD FILLED: ${order.outcome.toUpperCase()} $${order.costBasis.toFixed(2)}`,
      {
        orderId: order.orderId,
        marketSlug: order.marketSlug,
        strategy: order.strategy,
      },
    )

    // Record successful trade with RiskManager
    riskManager.recordTradeResult(true)

    // Hand off to PLM for stop-loss / take-profit tracking
    try {
      const { positionLifecycleManager } = await import('./PositionLifecycleManager')
      positionLifecycleManager.trackPosition({
        marketSlug: order.marketSlug,
        outcome: order.outcome,
        question: order.question,
        entryPrice: order.price,
        size: order.size,
        costBasis: order.costBasis,
        entryTime: Date.now(),
        stopLossPercent: order.stopLossPercent,
        takeProfitPercent: order.takeProfitPercent,
        strategy: order.strategy,
        takerFeeBps: 10, // Flat 10bps on PM US
      })
    } catch (err) {
      console.warn('[GtcOrderManager] Failed to hand off to PLM:', err)
    }

    this.removeOrder(order.orderId)
  }

  /**
   * Handle a GTD order that expired (server-side)
   */
  private handleExpiry(order: PendingGtcOrder): void {
    order.status = 'expired'

    activityLogger.logInfo(
      `GTD expired: ${order.question.substring(0, 40)}...`,
      { orderId: order.orderId, strategy: order.strategy },
    )

    this.removeOrder(order.orderId)
  }

  /**
   * Cancel all pending orders for a specific strategy
   * Called when a strategy is stopped
   */
  async cancelAllForStrategy(strategy: 'llm' | 'dip' | 'fw' | 'btc' | 'micro' | 'meanrev' | 'copy'): Promise<number> {
    let cancelled = 0

    for (const [orderId, order] of this.orders) {
      if (order.strategy !== strategy || order.status !== 'pending') continue

      try {
        await polymarketUSClient.cancelOrder(orderId, order.marketSlug)
      } catch {
        // Best-effort — the GTD will expire server-side anyway
      }

      order.status = 'cancelled'
      this.removeOrder(orderId)
      cancelled++
    }

    if (cancelled > 0) {
      console.log(`[GtcOrderManager] Cancelled ${cancelled} pending order(s) for ${strategy}`)
    }
    return cancelled
  }

  /**
   * Cancel ALL pending orders (emergency stop)
   */
  async cancelAll(): Promise<number> {
    // Batch cancel via API if we have slugs
    const slugs = [...new Set([...this.orders.values()].filter(o => o.status === 'pending').map(o => o.marketSlug))]
    if (slugs.length > 0) {
      try {
        await polymarketUSClient.cancelAllOrders(slugs)
      } catch {
        // Best-effort
      }
    }

    let cancelled = 0
    for (const [orderId, order] of this.orders) {
      if (order.status !== 'pending') continue
      order.status = 'cancelled'
      this.removeOrder(orderId)
      cancelled++
    }

    return cancelled
  }

  /**
   * Total USD locked in pending GTD orders (synchronous for RiskManager)
   */
  getReservedCapital(): number {
    let total = 0
    for (const order of this.orders.values()) {
      if (order.status === 'pending') {
        total += order.costBasis
      }
    }
    return total
  }

  /**
   * Get all pending orders (for UI display)
   */
  getPendingOrders(): PendingGtcOrder[] {
    return Array.from(this.orders.values()).filter(o => o.status === 'pending')
  }

  /**
   * Subscribe to order changes
   */
  onChange(callback: OrderChangeCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  // ==========================================
  // PRIVATE — Persistence & notifications
  // ==========================================

  private removeOrder(orderId: string): void {
    this.orders.delete(orderId)

    import('@/services/storage').then(({ indexedDBService }) => {
      indexedDBService.removeGtcOrder(orderId)
    }).catch(() => {})

    this.notifyCallbacks()
  }

  private persistToStorage(order: PendingGtcOrder): void {
    import('@/services/storage').then(({ indexedDBService }) => {
      indexedDBService.storeGtcOrder(order)
    }).catch(() => {})
  }

  private hydrateFromStorage(): void {
    import('@/services/storage').then(async ({ indexedDBService }) => {
      // Ensure IndexedDB is fully initialized (v2 upgrade complete) before querying
      await indexedDBService.initialize()
      const stored = await indexedDBService.loadGtcOrders()
      if (stored.length === 0) return

      for (const order of stored) {
        if (order.status === 'pending' && !this.orders.has(order.orderId)) {
          this.orders.set(order.orderId, order)
        }
      }

      if (this.orders.size > 0) {
        this.notifyCallbacks()
        console.log(`[GtcOrderManager] Hydrated ${this.orders.size} pending order(s) from storage`)
        // Immediately poll to check if any filled while page was closed
        this.pollOrders()
      }
    }).catch(err => {
      console.warn('[GtcOrderManager] Failed to hydrate from storage:', err)
    })
  }

  private notifyCallbacks(): void {
    const orders = this.getPendingOrders()
    for (const callback of this.callbacks) {
      try {
        callback(orders)
      } catch (error) {
        console.error('[GtcOrderManager] Callback error:', error)
      }
    }
  }
}

// Export singleton instance
export const gtcOrderManager = new GtcOrderManager()
