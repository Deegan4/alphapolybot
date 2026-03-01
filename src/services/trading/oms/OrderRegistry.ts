import {
  OrderState,
  TERMINAL_STATES,
  ACTIVE_STATES,
  type ManagedOrder,
  type CreateOrderParams,
  type OrderEvent,
  type OrderEventType,
  type OrderEventCallback,
  type OrderFilledEvent,
  type OrderPartiallyFilledEvent,
} from './types'
import { validateTransition } from './OrderStateMachine'

// ==========================================
// ORDER REGISTRY — Central Order Store
// ==========================================

let nextId = 0
function generateOrderId(): string {
  return `oms-${Date.now()}-${++nextId}`
}

/**
 * Central registry for all managed orders.
 *
 * Responsibilities:
 * 1. Store all ManagedOrders (in-memory, IndexedDB in Phase 6)
 * 2. Validate and apply state transitions via FSM
 * 3. Emit typed OrderEvents on every transition
 * 4. Query orders by strategy, market, state
 * 5. Track OCO contingency pairs
 * 6. Compute capital locked in active orders
 */
export class OrderRegistry {
  private orders = new Map<string, ManagedOrder>()
  private exchangeIdIndex = new Map<string, string>()
  private orderListGroups = new Map<string, Set<string>>()
  private eventCallbacks = new Set<OrderEventCallback>()
  private nextListId = 0

  // ── Order Creation ──

  createOrder(params: CreateOrderParams): ManagedOrder {
    const now = Date.now()
    const order: ManagedOrder = {
      id: generateOrderId(),
      strategyId: params.strategyId,
      marketSlug: params.marketSlug,
      tokenId: params.tokenId,
      outcome: params.outcome,
      side: params.side,
      orderType: params.orderType,
      price: params.price,
      size: params.size,
      intent: params.intent,
      postOnly: params.postOnly,
      gtdExpirationSec: params.gtdExpirationSec,
      stopLossPercent: params.stopLossPercent,
      takeProfitPercent: params.takeProfitPercent,
      maxHoldMs: params.maxHoldMs,
      takerFeeBps: params.takerFeeBps,
      tags: params.tags,
      // Fill tracking
      filledSize: 0,
      avgFillPrice: 0,
      remainingSize: params.size,
      // State
      state: OrderState.INITIALIZED,
      // Timestamps
      createdAt: now,
      // Cost
      costBasis: params.price * params.size,
    }

    this.orders.set(order.id, order)
    this.emitEvent({
      type: 'ORDER_INITIALIZED',
      orderId: order.id,
      timestamp: now,
      strategyId: order.strategyId,
      marketSlug: order.marketSlug,
      order: { ...order },
    })

    return order
  }

  // ── State Transitions ──

  markSubmitted(orderId: string, exchangeOrderId: string): void {
    const order = this.requireOrder(orderId)
    this.applyTransition(order, OrderState.SUBMITTED)
    order.exchangeOrderId = exchangeOrderId
    order.submittedAt = Date.now()
    this.exchangeIdIndex.set(exchangeOrderId, orderId)

    this.emitEvent({
      type: 'ORDER_SUBMITTED',
      orderId: order.id,
      exchangeOrderId,
      timestamp: order.submittedAt,
      strategyId: order.strategyId,
      marketSlug: order.marketSlug,
    })
  }

  markAccepted(orderId: string): void {
    const order = this.requireOrder(orderId)
    this.applyTransition(order, OrderState.ACCEPTED)
    order.acceptedAt = Date.now()

    this.emitEvent({
      type: 'ORDER_ACCEPTED',
      orderId: order.id,
      exchangeOrderId: order.exchangeOrderId,
      timestamp: order.acceptedAt,
      strategyId: order.strategyId,
      marketSlug: order.marketSlug,
    })
  }

  markPartiallyFilled(orderId: string, fillSize: number, fillPrice: number): void {
    const order = this.requireOrder(orderId)
    this.validateFill(order, fillSize)
    this.applyTransition(order, OrderState.PARTIALLY_FILLED)
    this.applyFill(order, fillSize, fillPrice)

    const event: OrderPartiallyFilledEvent = {
      type: 'ORDER_PARTIALLY_FILLED',
      orderId: order.id,
      exchangeOrderId: order.exchangeOrderId,
      timestamp: order.lastFillAt!,
      strategyId: order.strategyId,
      marketSlug: order.marketSlug,
      fillSize,
      fillPrice,
      cumulativeFilledSize: order.filledSize,
      remainingSize: order.remainingSize,
    }
    this.emitEvent(event)
  }

  markFilled(orderId: string, fillSize: number, fillPrice: number): void {
    const order = this.requireOrder(orderId)
    this.validateFill(order, fillSize)
    this.applyTransition(order, OrderState.FILLED)
    this.applyFill(order, fillSize, fillPrice)
    order.completedAt = order.lastFillAt

    const event: OrderFilledEvent = {
      type: 'ORDER_FILLED',
      orderId: order.id,
      exchangeOrderId: order.exchangeOrderId,
      timestamp: order.completedAt!,
      strategyId: order.strategyId,
      marketSlug: order.marketSlug,
      fillSize,
      fillPrice,
      totalFilledSize: order.filledSize,
      avgFillPrice: order.avgFillPrice,
    }
    this.emitEvent(event)
    this.processContingency(orderId)
  }

  markCanceled(orderId: string, reason: string): void {
    const order = this.requireOrder(orderId)
    this.applyTransition(order, OrderState.CANCELED)
    order.completedAt = Date.now()
    order.rejectReason = reason

    this.emitEvent({
      type: 'ORDER_CANCELED',
      orderId: order.id,
      exchangeOrderId: order.exchangeOrderId,
      timestamp: order.completedAt,
      strategyId: order.strategyId,
      marketSlug: order.marketSlug,
      reason,
    })
    this.processContingency(orderId)
  }

  markExpired(orderId: string): void {
    const order = this.requireOrder(orderId)
    this.applyTransition(order, OrderState.EXPIRED)
    order.completedAt = Date.now()

    this.emitEvent({
      type: 'ORDER_EXPIRED',
      orderId: order.id,
      exchangeOrderId: order.exchangeOrderId,
      timestamp: order.completedAt,
      strategyId: order.strategyId,
      marketSlug: order.marketSlug,
    })
    this.processContingency(orderId)
  }

  markRejected(orderId: string, reason: string): void {
    const order = this.requireOrder(orderId)
    this.applyTransition(order, OrderState.REJECTED)
    order.completedAt = Date.now()
    order.rejectReason = reason

    this.emitEvent({
      type: 'ORDER_REJECTED',
      orderId: order.id,
      exchangeOrderId: order.exchangeOrderId,
      timestamp: order.completedAt,
      strategyId: order.strategyId,
      marketSlug: order.marketSlug,
      reason,
    })
  }

  markDenied(orderId: string, reason: string): void {
    const order = this.requireOrder(orderId)
    this.applyTransition(order, OrderState.DENIED)
    order.completedAt = Date.now()
    order.rejectReason = reason

    this.emitEvent({
      type: 'ORDER_DENIED',
      orderId: order.id,
      timestamp: order.completedAt,
      strategyId: order.strategyId,
      marketSlug: order.marketSlug,
      reason,
    })
  }

  // ── OCO Contingency ──

  /**
   * Link two orders as OCO (One-Cancels-Other).
   * When one reaches a terminal state, the other is auto-canceled.
   * Returns the shared orderListId.
   */
  linkOCO(orderId1: string, orderId2: string, autoCancel = true): string {
    const order1 = this.requireOrder(orderId1)
    const order2 = this.requireOrder(orderId2)

    const listId = `oco-${Date.now()}-${++this.nextListId}`
    order1.orderListId = listId
    order1.contingencyType = 'OCO'
    order1.linkedOrderId = orderId2
    order2.orderListId = listId
    order2.contingencyType = 'OCO'
    order2.linkedOrderId = orderId1

    const group = new Set([orderId1, orderId2])
    this.orderListGroups.set(listId, group)

    // Store autoCancel preference on the group via a tag
    if (!autoCancel) {
      order1.tags = { ...order1.tags, _ocoAutoCancel: 'false' }
      order2.tags = { ...order2.tags, _ocoAutoCancel: 'false' }
    }

    return listId
  }

  private processContingency(orderId: string): void {
    const order = this.orders.get(orderId)
    if (!order?.orderListId || !order.linkedOrderId) return
    if (order.tags?._ocoAutoCancel === 'false') return

    const linkedOrder = this.orders.get(order.linkedOrderId)
    if (!linkedOrder || TERMINAL_STATES.has(linkedOrder.state)) return

    // Auto-cancel the linked order
    try {
      this.markCanceled(linkedOrder.id, `oco:${orderId}`)
    } catch {
      // Linked order may already be in a terminal state (race condition) — ignore
    }
  }

  // ── Queries ──

  getOrder(orderId: string): ManagedOrder | undefined {
    return this.orders.get(orderId)
  }

  getOrderByExchangeId(exchangeOrderId: string): ManagedOrder | undefined {
    const internalId = this.exchangeIdIndex.get(exchangeOrderId)
    return internalId ? this.orders.get(internalId) : undefined
  }

  getOrdersByStrategy(strategyId: string): ManagedOrder[] {
    const result: ManagedOrder[] = []
    for (const order of this.orders.values()) {
      if (order.strategyId === strategyId) result.push(order)
    }
    return result
  }

  getOrdersByMarket(marketSlug: string): ManagedOrder[] {
    const result: ManagedOrder[] = []
    for (const order of this.orders.values()) {
      if (order.marketSlug === marketSlug) result.push(order)
    }
    return result
  }

  getActiveOrders(): ManagedOrder[] {
    const result: ManagedOrder[] = []
    for (const order of this.orders.values()) {
      if (ACTIVE_STATES.has(order.state)) result.push(order)
    }
    return result
  }

  getOrdersByState(state: OrderState): ManagedOrder[] {
    const result: ManagedOrder[] = []
    for (const order of this.orders.values()) {
      if (order.state === state) result.push(order)
    }
    return result
  }

  getOrdersByListId(orderListId: string): ManagedOrder[] {
    const ids = this.orderListGroups.get(orderListId)
    if (!ids) return []
    const result: ManagedOrder[] = []
    for (const id of ids) {
      const order = this.orders.get(id)
      if (order) result.push(order)
    }
    return result
  }

  getAllOrders(): ManagedOrder[] {
    return [...this.orders.values()]
  }

  // ── Capital Tracking ──

  /** Capital locked in SUBMITTED orders (awaiting exchange ack) */
  getInFlightCapital(): number {
    let total = 0
    for (const order of this.orders.values()) {
      if (order.state === OrderState.SUBMITTED && order.side === 'BUY') {
        total += order.costBasis
      }
    }
    return total
  }

  /** Capital locked in ACCEPTED + PARTIALLY_FILLED orders (on book) */
  getReservedCapital(): number {
    let total = 0
    for (const order of this.orders.values()) {
      if (
        (order.state === OrderState.ACCEPTED || order.state === OrderState.PARTIALLY_FILLED)
        && order.side === 'BUY'
      ) {
        total += order.price * order.remainingSize
      }
    }
    return total
  }

  /** Total capital locked across all active BUY orders */
  getTotalLockedCapital(): number {
    return this.getInFlightCapital() + this.getReservedCapital()
  }

  // ── Events ──

  onEvent(callback: OrderEventCallback): () => void {
    this.eventCallbacks.add(callback)
    return () => { this.eventCallbacks.delete(callback) }
  }

  onEventType<T extends OrderEventType>(
    type: T,
    callback: (event: Extract<OrderEvent, { type: T }>) => void,
  ): () => void {
    const wrapper: OrderEventCallback = (event) => {
      if (event.type === type) {
        callback(event as Extract<OrderEvent, { type: T }>)
      }
    }
    this.eventCallbacks.add(wrapper)
    return () => { this.eventCallbacks.delete(wrapper) }
  }

  // ── Cleanup ──

  /** Remove terminal orders older than maxAge from memory */
  pruneTerminalOrders(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs
    let pruned = 0
    for (const [id, order] of this.orders) {
      if (TERMINAL_STATES.has(order.state) && (order.completedAt ?? order.createdAt) < cutoff) {
        this.orders.delete(id)
        if (order.exchangeOrderId) {
          this.exchangeIdIndex.delete(order.exchangeOrderId)
        }
        if (order.orderListId) {
          this.orderListGroups.get(order.orderListId)?.delete(id)
        }
        pruned++
      }
    }
    return pruned
  }

  /** Clear all orders (for testing) */
  reset(): void {
    this.orders.clear()
    this.exchangeIdIndex.clear()
    this.orderListGroups.clear()
    this.eventCallbacks.clear()
    this.nextListId = 0
  }

  // ── Internal Helpers ──

  private requireOrder(orderId: string): ManagedOrder {
    const order = this.orders.get(orderId)
    if (!order) {
      throw new Error(`Order not found: ${orderId}`)
    }
    return order
  }

  private applyTransition(order: ManagedOrder, to: OrderState): void {
    if (!validateTransition(order.state, to)) {
      throw new Error(
        `Invalid order state transition: ${order.state} → ${to} (order ${order.id})`
      )
    }
    order.previousState = order.state
    order.state = to
  }

  private validateFill(order: ManagedOrder, fillSize: number): void {
    if (fillSize <= 0) {
      throw new Error(`Fill size must be positive: ${fillSize} (order ${order.id})`)
    }
    if (order.filledSize + fillSize > order.size * 1.001) { // tiny tolerance for fp
      throw new Error(
        `Overfill detected: ${order.filledSize} + ${fillSize} > ${order.size} (order ${order.id})`
      )
    }
  }

  private applyFill(order: ManagedOrder, fillSize: number, fillPrice: number): void {
    const prevValue = order.avgFillPrice * order.filledSize
    order.filledSize += fillSize
    order.avgFillPrice = order.filledSize > 0
      ? (prevValue + fillPrice * fillSize) / order.filledSize
      : 0
    order.remainingSize = Math.max(0, order.size - order.filledSize)
    order.lastFillAt = Date.now()
  }

  private emitEvent(event: OrderEvent): void {
    for (const cb of this.eventCallbacks) {
      try {
        cb(event)
      } catch (err) {
        console.error('[OrderRegistry] Event callback error:', err)
      }
    }
  }
}

export const orderRegistry = new OrderRegistry()
