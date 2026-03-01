import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OrderRegistry } from '../OrderRegistry'
import { OrderState, type CreateOrderParams, type OrderEvent, type ManagedOrder } from '../types'

// ==========================================
// HELPERS
// ==========================================

function defaultParams(overrides: Partial<CreateOrderParams> = {}): CreateOrderParams {
  return {
    strategyId: 'btc',
    marketSlug: 'btc-up-5m',
    outcome: 'yes',
    side: 'BUY',
    orderType: 'GTC',
    price: 0.45,
    size: 10,
    intent: 'entry',
    ...overrides,
  }
}

let registry: OrderRegistry

beforeEach(() => {
  registry = new OrderRegistry()
})

// ==========================================
// ORDER CREATION
// ==========================================

describe('OrderRegistry — createOrder', () => {
  it('assigns a unique ID and INITIALIZED state', () => {
    const order = registry.createOrder(defaultParams())
    expect(order.id).toBeTruthy()
    expect(order.state).toBe(OrderState.INITIALIZED)
  })

  it('sets correct timestamps', () => {
    const before = Date.now()
    const order = registry.createOrder(defaultParams())
    expect(order.createdAt).toBeGreaterThanOrEqual(before)
    expect(order.submittedAt).toBeUndefined()
    expect(order.completedAt).toBeUndefined()
  })

  it('initializes fill tracking at zero', () => {
    const order = registry.createOrder(defaultParams())
    expect(order.filledSize).toBe(0)
    expect(order.avgFillPrice).toBe(0)
    expect(order.remainingSize).toBe(10)
  })

  it('computes costBasis from price × size', () => {
    const order = registry.createOrder(defaultParams({ price: 0.30, size: 20 }))
    expect(order.costBasis).toBeCloseTo(6.0)
  })

  it('generates unique IDs for consecutive orders', () => {
    const o1 = registry.createOrder(defaultParams())
    const o2 = registry.createOrder(defaultParams())
    expect(o1.id).not.toBe(o2.id)
  })

  it('stores order retrievable by getOrder()', () => {
    const order = registry.createOrder(defaultParams())
    expect(registry.getOrder(order.id)).toBe(order)
  })

  it('emits ORDER_INITIALIZED event', () => {
    const events: OrderEvent[] = []
    registry.onEvent(e => events.push(e))
    const order = registry.createOrder(defaultParams())

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('ORDER_INITIALIZED')
    if (events[0].type === 'ORDER_INITIALIZED') {
      expect(events[0].order.id).toBe(order.id)
      expect(events[0].strategyId).toBe('btc')
    }
  })

  it('carries through optional params (SL/TP/tags)', () => {
    const order = registry.createOrder(defaultParams({
      stopLossPercent: 15,
      takeProfitPercent: 30,
      tags: { source: 'test' },
    }))
    expect(order.stopLossPercent).toBe(15)
    expect(order.takeProfitPercent).toBe(30)
    expect(order.tags).toEqual({ source: 'test' })
  })
})

// ==========================================
// STATE TRANSITIONS
// ==========================================

describe('OrderRegistry — state transitions', () => {
  it('markSubmitted: INITIALIZED → SUBMITTED with exchangeOrderId', () => {
    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-123')

    expect(order.state).toBe(OrderState.SUBMITTED)
    expect(order.exchangeOrderId).toBe('exch-123')
    expect(order.submittedAt).toBeDefined()
    expect(order.previousState).toBe(OrderState.INITIALIZED)
  })

  it('markAccepted: SUBMITTED → ACCEPTED', () => {
    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-123')
    registry.markAccepted(order.id)

    expect(order.state).toBe(OrderState.ACCEPTED)
    expect(order.acceptedAt).toBeDefined()
  })

  it('markFilled: SUBMITTED → FILLED (FOK fast path)', () => {
    const order = registry.createOrder(defaultParams({ orderType: 'FOK' }))
    registry.markSubmitted(order.id, 'exch-123')
    registry.markFilled(order.id, 10, 0.45)

    expect(order.state).toBe(OrderState.FILLED)
    expect(order.filledSize).toBe(10)
    expect(order.avgFillPrice).toBe(0.45)
    expect(order.remainingSize).toBe(0)
    expect(order.completedAt).toBeDefined()
  })

  it('markRejected: SUBMITTED → REJECTED with reason', () => {
    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-123')
    registry.markRejected(order.id, 'invalid signature')

    expect(order.state).toBe(OrderState.REJECTED)
    expect(order.rejectReason).toBe('invalid signature')
    expect(order.completedAt).toBeDefined()
  })

  it('markDenied: INITIALIZED → DENIED (pre-flight rejection)', () => {
    const order = registry.createOrder(defaultParams())
    registry.markDenied(order.id, 'daily loss limit exceeded')

    expect(order.state).toBe(OrderState.DENIED)
    expect(order.rejectReason).toBe('daily loss limit exceeded')
  })

  it('markCanceled: ACCEPTED → CANCELED', () => {
    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-123')
    registry.markAccepted(order.id)
    registry.markCanceled(order.id, 'emergency stop')

    expect(order.state).toBe(OrderState.CANCELED)
    expect(order.rejectReason).toBe('emergency stop')
  })

  it('markExpired: ACCEPTED → EXPIRED', () => {
    const order = registry.createOrder(defaultParams({ orderType: 'GTD' }))
    registry.markSubmitted(order.id, 'exch-123')
    registry.markAccepted(order.id)
    registry.markExpired(order.id)

    expect(order.state).toBe(OrderState.EXPIRED)
  })

  it('throws on invalid transition', () => {
    const order = registry.createOrder(defaultParams())
    expect(() => registry.markAccepted(order.id)).toThrow('Invalid order state transition')
  })

  it('throws on unknown order ID', () => {
    expect(() => registry.markSubmitted('nonexistent', 'exch')).toThrow('Order not found')
  })
})

// ==========================================
// PARTIAL FILLS & VWAP
// ==========================================

describe('OrderRegistry — partial fills', () => {
  it('tracks cumulative fill size and VWAP', () => {
    const order = registry.createOrder(defaultParams({ size: 100 }))
    registry.markSubmitted(order.id, 'exch-123')
    registry.markAccepted(order.id)

    // First partial: 40 shares at 0.45
    registry.markPartiallyFilled(order.id, 40, 0.45)
    expect(order.filledSize).toBe(40)
    expect(order.avgFillPrice).toBeCloseTo(0.45)
    expect(order.remainingSize).toBe(60)
    expect(order.state).toBe(OrderState.PARTIALLY_FILLED)

    // Second partial: 30 shares at 0.50
    registry.markPartiallyFilled(order.id, 30, 0.50)
    expect(order.filledSize).toBe(70)
    // VWAP: (40*0.45 + 30*0.50) / 70 = (18 + 15) / 70 ≈ 0.4714
    expect(order.avgFillPrice).toBeCloseTo(0.4714, 3)
    expect(order.remainingSize).toBe(30)

    // Final fill: 30 shares at 0.48
    registry.markFilled(order.id, 30, 0.48)
    expect(order.filledSize).toBe(100)
    // VWAP: (18 + 15 + 30*0.48) / 100 = (18 + 15 + 14.4) / 100 = 0.474
    expect(order.avgFillPrice).toBeCloseTo(0.474, 3)
    expect(order.remainingSize).toBe(0)
    expect(order.state).toBe(OrderState.FILLED)
  })

  it('rejects overfill', () => {
    const order = registry.createOrder(defaultParams({ size: 10 }))
    registry.markSubmitted(order.id, 'exch-123')
    registry.markAccepted(order.id)
    registry.markPartiallyFilled(order.id, 8, 0.45)

    expect(() => registry.markFilled(order.id, 3, 0.45)).toThrow('Overfill detected')
  })

  it('rejects zero fill size', () => {
    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-123')
    expect(() => registry.markFilled(order.id, 0, 0.45)).toThrow('Fill size must be positive')
  })

  it('rejects negative fill size', () => {
    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-123')
    expect(() => registry.markFilled(order.id, -5, 0.45)).toThrow('Fill size must be positive')
  })
})

// ==========================================
// EXCHANGE ID INDEX
// ==========================================

describe('OrderRegistry — exchange ID lookup', () => {
  it('indexes by exchange order ID after markSubmitted', () => {
    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-abc')

    const found = registry.getOrderByExchangeId('exch-abc')
    expect(found).toBe(order)
  })

  it('returns undefined for unknown exchange ID', () => {
    expect(registry.getOrderByExchangeId('nonexistent')).toBeUndefined()
  })
})

// ==========================================
// QUERIES
// ==========================================

describe('OrderRegistry — queries', () => {
  it('getOrdersByStrategy filters correctly', () => {
    registry.createOrder(defaultParams({ strategyId: 'btc' }))
    registry.createOrder(defaultParams({ strategyId: 'dip' }))
    registry.createOrder(defaultParams({ strategyId: 'btc' }))

    expect(registry.getOrdersByStrategy('btc')).toHaveLength(2)
    expect(registry.getOrdersByStrategy('dip')).toHaveLength(1)
    expect(registry.getOrdersByStrategy('llm')).toHaveLength(0)
  })

  it('getOrdersByMarket filters correctly', () => {
    registry.createOrder(defaultParams({ marketSlug: 'btc-up-5m' }))
    registry.createOrder(defaultParams({ marketSlug: 'eth-down-1h' }))

    expect(registry.getOrdersByMarket('btc-up-5m')).toHaveLength(1)
  })

  it('getActiveOrders returns only SUBMITTED/ACCEPTED/PARTIALLY_FILLED', () => {
    registry.createOrder(defaultParams()) // INITIALIZED
    const o2 = registry.createOrder(defaultParams())
    registry.markSubmitted(o2.id, 'exch-1')           // SUBMITTED
    const o3 = registry.createOrder(defaultParams())
    registry.markSubmitted(o3.id, 'exch-2')
    registry.markAccepted(o3.id)                       // ACCEPTED
    const o4 = registry.createOrder(defaultParams())
    registry.markDenied(o4.id, 'denied')               // DENIED

    const active = registry.getActiveOrders()
    expect(active).toHaveLength(2)
    expect(active.map(o => o.id)).toContain(o2.id)
    expect(active.map(o => o.id)).toContain(o3.id)
  })

  it('getOrdersByState returns matching orders', () => {
    registry.createOrder(defaultParams())
    registry.createOrder(defaultParams())
    const o3 = registry.createOrder(defaultParams())
    registry.markDenied(o3.id, 'denied')

    expect(registry.getOrdersByState(OrderState.INITIALIZED)).toHaveLength(2)
    expect(registry.getOrdersByState(OrderState.DENIED)).toHaveLength(1)
  })

  it('getAllOrders returns everything', () => {
    registry.createOrder(defaultParams())
    registry.createOrder(defaultParams())
    expect(registry.getAllOrders()).toHaveLength(2)
  })
})

// ==========================================
// CAPITAL TRACKING
// ==========================================

describe('OrderRegistry — capital tracking', () => {
  it('getInFlightCapital sums SUBMITTED BUY orders', () => {
    const o1 = registry.createOrder(defaultParams({ price: 0.50, size: 20 })) // cost: 10
    registry.markSubmitted(o1.id, 'exch-1')
    const o2 = registry.createOrder(defaultParams({ price: 0.30, size: 10 })) // cost: 3
    registry.markSubmitted(o2.id, 'exch-2')

    expect(registry.getInFlightCapital()).toBeCloseTo(13)
  })

  it('ignores SELL orders in capital calculations', () => {
    const o1 = registry.createOrder(defaultParams({ side: 'SELL', price: 0.50, size: 20 }))
    registry.markSubmitted(o1.id, 'exch-1')

    expect(registry.getInFlightCapital()).toBe(0)
  })

  it('getReservedCapital sums ACCEPTED + PARTIALLY_FILLED remaining', () => {
    const o1 = registry.createOrder(defaultParams({ price: 0.40, size: 100 }))
    registry.markSubmitted(o1.id, 'exch-1')
    registry.markAccepted(o1.id) // 100 remaining at 0.40 = $40

    const o2 = registry.createOrder(defaultParams({ price: 0.50, size: 50 }))
    registry.markSubmitted(o2.id, 'exch-2')
    registry.markAccepted(o2.id)
    registry.markPartiallyFilled(o2.id, 20, 0.50) // 30 remaining at 0.50 = $15

    expect(registry.getReservedCapital()).toBeCloseTo(55) // 40 + 15
  })

  it('getTotalLockedCapital = in-flight + reserved', () => {
    const o1 = registry.createOrder(defaultParams({ price: 0.50, size: 10 }))
    registry.markSubmitted(o1.id, 'exch-1') // in-flight: $5

    const o2 = registry.createOrder(defaultParams({ price: 0.40, size: 10 }))
    registry.markSubmitted(o2.id, 'exch-2')
    registry.markAccepted(o2.id) // reserved: $4

    expect(registry.getTotalLockedCapital()).toBeCloseTo(9) // 5 + 4
  })

  it('filled orders release capital', () => {
    const o1 = registry.createOrder(defaultParams({ price: 0.50, size: 10 }))
    registry.markSubmitted(o1.id, 'exch-1')
    expect(registry.getInFlightCapital()).toBeCloseTo(5)

    registry.markFilled(o1.id, 10, 0.50)
    expect(registry.getInFlightCapital()).toBe(0)
    expect(registry.getReservedCapital()).toBe(0)
  })
})

// ==========================================
// EVENTS
// ==========================================

describe('OrderRegistry — events', () => {
  it('emits events for each state transition', () => {
    const events: OrderEvent[] = []
    registry.onEvent(e => events.push(e))

    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-1')
    registry.markAccepted(order.id)
    registry.markFilled(order.id, 10, 0.45)

    const types = events.map(e => e.type)
    expect(types).toEqual([
      'ORDER_INITIALIZED',
      'ORDER_SUBMITTED',
      'ORDER_ACCEPTED',
      'ORDER_FILLED',
    ])
  })

  it('onEventType only fires for matching type', () => {
    const fills: OrderEvent[] = []
    registry.onEventType('ORDER_FILLED', e => fills.push(e))

    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-1')
    registry.markFilled(order.id, 10, 0.45)

    expect(fills).toHaveLength(1)
    expect(fills[0].type).toBe('ORDER_FILLED')
  })

  it('unsubscribe stops further events', () => {
    const events: OrderEvent[] = []
    const unsub = registry.onEvent(e => events.push(e))

    registry.createOrder(defaultParams())
    expect(events).toHaveLength(1)

    unsub()
    registry.createOrder(defaultParams())
    expect(events).toHaveLength(1) // no new events
  })

  it('event callback errors are caught and logged', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    registry.onEvent(() => { throw new Error('boom') })

    // Should not throw
    registry.createOrder(defaultParams())
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('ORDER_FILLED event contains correct fill data', () => {
    let fillEvent: OrderEvent | null = null
    registry.onEventType('ORDER_FILLED', e => { fillEvent = e })

    const order = registry.createOrder(defaultParams({ size: 10 }))
    registry.markSubmitted(order.id, 'exch-1')
    registry.markFilled(order.id, 10, 0.48)

    expect(fillEvent).not.toBeNull()
    if (fillEvent && fillEvent.type === 'ORDER_FILLED') {
      expect(fillEvent.fillSize).toBe(10)
      expect(fillEvent.fillPrice).toBe(0.48)
      expect(fillEvent.totalFilledSize).toBe(10)
      expect(fillEvent.avgFillPrice).toBe(0.48)
    }
  })
})

// ==========================================
// OCO CONTINGENCY
// ==========================================

describe('OrderRegistry — OCO pairs', () => {
  function createAcceptedOrder(slug: string, intent: 'hedge-yes' | 'hedge-no'): ManagedOrder {
    const order = registry.createOrder(defaultParams({ marketSlug: slug, intent }))
    registry.markSubmitted(order.id, `exch-${order.id}`)
    registry.markAccepted(order.id)
    return order
  }

  it('linkOCO sets shared orderListId and linkedOrderId', () => {
    const yes = createAcceptedOrder('btc-up', 'hedge-yes')
    const no = createAcceptedOrder('btc-up', 'hedge-no')

    const listId = registry.linkOCO(yes.id, no.id)

    expect(yes.orderListId).toBe(listId)
    expect(no.orderListId).toBe(listId)
    expect(yes.linkedOrderId).toBe(no.id)
    expect(no.linkedOrderId).toBe(yes.id)
    expect(yes.contingencyType).toBe('OCO')
  })

  it('filling one OCO leg auto-cancels the other', () => {
    const yes = createAcceptedOrder('btc-up', 'hedge-yes')
    const no = createAcceptedOrder('btc-up', 'hedge-no')
    registry.linkOCO(yes.id, no.id)

    registry.markFilled(yes.id, 10, 0.45)

    expect(yes.state).toBe(OrderState.FILLED)
    expect(no.state).toBe(OrderState.CANCELED)
    expect(no.rejectReason).toContain('oco')
  })

  it('canceling one OCO leg auto-cancels the other', () => {
    const yes = createAcceptedOrder('btc-up', 'hedge-yes')
    const no = createAcceptedOrder('btc-up', 'hedge-no')
    registry.linkOCO(yes.id, no.id)

    registry.markCanceled(yes.id, 'user')

    expect(no.state).toBe(OrderState.CANCELED)
  })

  it('expiring one OCO leg auto-cancels the other', () => {
    const yes = createAcceptedOrder('btc-up', 'hedge-yes')
    const no = createAcceptedOrder('btc-up', 'hedge-no')
    registry.linkOCO(yes.id, no.id)

    registry.markExpired(yes.id)

    expect(no.state).toBe(OrderState.CANCELED)
  })

  it('autoCancel=false prevents auto-cancel on fill', () => {
    const yes = createAcceptedOrder('btc-up', 'hedge-yes')
    const no = createAcceptedOrder('btc-up', 'hedge-no')
    registry.linkOCO(yes.id, no.id, false)

    registry.markFilled(yes.id, 10, 0.45)

    expect(yes.state).toBe(OrderState.FILLED)
    expect(no.state).toBe(OrderState.ACCEPTED) // NOT canceled
  })

  it('getOrdersByListId returns both orders', () => {
    const yes = createAcceptedOrder('btc-up', 'hedge-yes')
    const no = createAcceptedOrder('btc-up', 'hedge-no')
    const listId = registry.linkOCO(yes.id, no.id)

    const group = registry.getOrdersByListId(listId)
    expect(group).toHaveLength(2)
    expect(group.map(o => o.id)).toContain(yes.id)
    expect(group.map(o => o.id)).toContain(no.id)
  })

  it('OCO emits cancel event for the auto-canceled leg', () => {
    const events: OrderEvent[] = []
    registry.onEventType('ORDER_CANCELED', e => events.push(e))

    const yes = createAcceptedOrder('btc-up', 'hedge-yes')
    const no = createAcceptedOrder('btc-up', 'hedge-no')
    registry.linkOCO(yes.id, no.id)

    registry.markFilled(yes.id, 10, 0.45)

    // Should have one cancel event for the auto-canceled leg
    expect(events).toHaveLength(1)
    expect(events[0].orderId).toBe(no.id)
  })
})

// ==========================================
// PRUNE & CLEANUP
// ==========================================

describe('OrderRegistry — pruning', () => {
  it('removes terminal orders older than maxAge', () => {
    const order = registry.createOrder(defaultParams())
    registry.markDenied(order.id, 'denied')
    // Backdate completedAt
    order.completedAt = Date.now() - 2 * 60 * 60 * 1000 // 2 hours ago

    const pruned = registry.pruneTerminalOrders(60 * 60 * 1000) // 1 hour max
    expect(pruned).toBe(1)
    expect(registry.getOrder(order.id)).toBeUndefined()
  })

  it('keeps active orders regardless of age', () => {
    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-1')
    registry.markAccepted(order.id)

    const pruned = registry.pruneTerminalOrders(0) // prune everything terminal
    expect(pruned).toBe(0)
    expect(registry.getOrder(order.id)).toBeDefined()
  })

  it('keeps recent terminal orders', () => {
    const order = registry.createOrder(defaultParams())
    registry.markDenied(order.id, 'denied')
    // completedAt is just now — recent

    const pruned = registry.pruneTerminalOrders(60 * 60 * 1000)
    expect(pruned).toBe(0)
  })

  it('cleans up exchange ID index on prune', () => {
    const order = registry.createOrder(defaultParams())
    registry.markSubmitted(order.id, 'exch-prune')
    registry.markFilled(order.id, 10, 0.45)
    order.completedAt = Date.now() - 2 * 60 * 60 * 1000

    registry.pruneTerminalOrders(60 * 60 * 1000)
    expect(registry.getOrderByExchangeId('exch-prune')).toBeUndefined()
  })

  it('reset clears everything', () => {
    registry.createOrder(defaultParams())
    registry.createOrder(defaultParams())
    registry.reset()

    expect(registry.getAllOrders()).toHaveLength(0)
  })
})

// ==========================================
// FULL LIFECYCLE — GTD order
// ==========================================

describe('OrderRegistry — GTD full lifecycle', () => {
  it('INITIALIZED → SUBMITTED → ACCEPTED → PARTIALLY_FILLED → FILLED', () => {
    const events: string[] = []
    registry.onEvent(e => events.push(e.type))

    const order = registry.createOrder(defaultParams({ orderType: 'GTD', size: 100 }))
    registry.markSubmitted(order.id, 'exch-gtd')
    registry.markAccepted(order.id)
    registry.markPartiallyFilled(order.id, 60, 0.44)
    registry.markFilled(order.id, 40, 0.46)

    expect(order.state).toBe(OrderState.FILLED)
    expect(order.filledSize).toBe(100)
    expect(order.remainingSize).toBe(0)
    expect(events).toEqual([
      'ORDER_INITIALIZED',
      'ORDER_SUBMITTED',
      'ORDER_ACCEPTED',
      'ORDER_PARTIALLY_FILLED',
      'ORDER_FILLED',
    ])
  })
})
