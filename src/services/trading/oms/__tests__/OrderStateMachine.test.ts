import { describe, it, expect } from 'vitest'
import { validateTransition, transitionOrder, getValidTransitions } from '../OrderStateMachine'
import { OrderState, type ManagedOrder } from '../types'

// ==========================================
// Helper — minimal ManagedOrder for FSM tests
// ==========================================

function makeOrder(state: OrderState): ManagedOrder {
  return {
    id: 'test-001',
    strategyId: 'btc',
    marketSlug: 'btc-up-5m',
    outcome: 'yes',
    side: 'BUY',
    orderType: 'GTC',
    price: 0.45,
    size: 10,
    filledSize: 0,
    avgFillPrice: 0,
    remainingSize: 10,
    state,
    createdAt: Date.now(),
    intent: 'entry',
    costBasis: 4.5,
  }
}

// ==========================================
// VALID TRANSITIONS
// ==========================================

describe('OrderStateMachine — valid transitions', () => {
  // INITIALIZED
  it('INITIALIZED → SUBMITTED', () => {
    expect(validateTransition(OrderState.INITIALIZED, OrderState.SUBMITTED)).toBe(true)
  })

  it('INITIALIZED → DENIED', () => {
    expect(validateTransition(OrderState.INITIALIZED, OrderState.DENIED)).toBe(true)
  })

  // SUBMITTED
  it('SUBMITTED → ACCEPTED', () => {
    expect(validateTransition(OrderState.SUBMITTED, OrderState.ACCEPTED)).toBe(true)
  })

  it('SUBMITTED → FILLED (FOK fast path)', () => {
    expect(validateTransition(OrderState.SUBMITTED, OrderState.FILLED)).toBe(true)
  })

  it('SUBMITTED → REJECTED', () => {
    expect(validateTransition(OrderState.SUBMITTED, OrderState.REJECTED)).toBe(true)
  })

  it('SUBMITTED → CANCELED', () => {
    expect(validateTransition(OrderState.SUBMITTED, OrderState.CANCELED)).toBe(true)
  })

  // ACCEPTED
  it('ACCEPTED → PARTIALLY_FILLED', () => {
    expect(validateTransition(OrderState.ACCEPTED, OrderState.PARTIALLY_FILLED)).toBe(true)
  })

  it('ACCEPTED → FILLED', () => {
    expect(validateTransition(OrderState.ACCEPTED, OrderState.FILLED)).toBe(true)
  })

  it('ACCEPTED → CANCELED', () => {
    expect(validateTransition(OrderState.ACCEPTED, OrderState.CANCELED)).toBe(true)
  })

  it('ACCEPTED → EXPIRED', () => {
    expect(validateTransition(OrderState.ACCEPTED, OrderState.EXPIRED)).toBe(true)
  })

  // PARTIALLY_FILLED
  it('PARTIALLY_FILLED → PARTIALLY_FILLED (another fill)', () => {
    expect(validateTransition(OrderState.PARTIALLY_FILLED, OrderState.PARTIALLY_FILLED)).toBe(true)
  })

  it('PARTIALLY_FILLED → FILLED', () => {
    expect(validateTransition(OrderState.PARTIALLY_FILLED, OrderState.FILLED)).toBe(true)
  })

  it('PARTIALLY_FILLED → CANCELED', () => {
    expect(validateTransition(OrderState.PARTIALLY_FILLED, OrderState.CANCELED)).toBe(true)
  })

  it('PARTIALLY_FILLED → EXPIRED', () => {
    expect(validateTransition(OrderState.PARTIALLY_FILLED, OrderState.EXPIRED)).toBe(true)
  })
})

// ==========================================
// INVALID TRANSITIONS
// ==========================================

describe('OrderStateMachine — invalid transitions', () => {
  it('INITIALIZED cannot go to FILLED directly', () => {
    expect(validateTransition(OrderState.INITIALIZED, OrderState.FILLED)).toBe(false)
  })

  it('INITIALIZED cannot go to ACCEPTED directly', () => {
    expect(validateTransition(OrderState.INITIALIZED, OrderState.ACCEPTED)).toBe(false)
  })

  it('SUBMITTED cannot go to EXPIRED (must be ACCEPTED first)', () => {
    expect(validateTransition(OrderState.SUBMITTED, OrderState.EXPIRED)).toBe(false)
  })

  it('ACCEPTED cannot go to REJECTED', () => {
    expect(validateTransition(OrderState.ACCEPTED, OrderState.REJECTED)).toBe(false)
  })

  it('ACCEPTED cannot go back to SUBMITTED', () => {
    expect(validateTransition(OrderState.ACCEPTED, OrderState.SUBMITTED)).toBe(false)
  })

  it('PARTIALLY_FILLED cannot go to REJECTED', () => {
    expect(validateTransition(OrderState.PARTIALLY_FILLED, OrderState.REJECTED)).toBe(false)
  })
})

// ==========================================
// TERMINAL STATES — no outbound transitions
// ==========================================

describe('OrderStateMachine — terminal states', () => {
  const terminalStates = [
    OrderState.FILLED,
    OrderState.CANCELED,
    OrderState.EXPIRED,
    OrderState.REJECTED,
    OrderState.DENIED,
  ]

  const allStates = Object.values(OrderState)

  for (const terminal of terminalStates) {
    it(`${terminal} has no outbound transitions`, () => {
      const valid = getValidTransitions(terminal)
      expect(valid.size).toBe(0)
    })

    for (const target of allStates) {
      it(`${terminal} → ${target} is invalid`, () => {
        expect(validateTransition(terminal, target)).toBe(false)
      })
    }
  }
})

// ==========================================
// transitionOrder — pure function
// ==========================================

describe('transitionOrder — applies valid transitions', () => {
  it('returns new order with updated state and previousState', () => {
    const order = makeOrder(OrderState.INITIALIZED)
    const result = transitionOrder(order, OrderState.SUBMITTED)

    expect(result.state).toBe(OrderState.SUBMITTED)
    expect(result.previousState).toBe(OrderState.INITIALIZED)
    // Original unchanged (immutable)
    expect(order.state).toBe(OrderState.INITIALIZED)
  })

  it('throws on invalid transition', () => {
    const order = makeOrder(OrderState.FILLED)
    expect(() => transitionOrder(order, OrderState.CANCELED)).toThrow(
      'Invalid order state transition: FILLED → CANCELED'
    )
  })

  it('preserves all other order fields', () => {
    const order = makeOrder(OrderState.INITIALIZED)
    order.tags = { foo: 'bar' }
    const result = transitionOrder(order, OrderState.SUBMITTED)

    expect(result.id).toBe(order.id)
    expect(result.strategyId).toBe(order.strategyId)
    expect(result.price).toBe(order.price)
    expect(result.tags).toEqual({ foo: 'bar' })
  })
})

// ==========================================
// getValidTransitions
// ==========================================

describe('getValidTransitions', () => {
  it('INITIALIZED has 2 valid targets', () => {
    const valid = getValidTransitions(OrderState.INITIALIZED)
    expect(valid.size).toBe(2)
    expect(valid.has(OrderState.SUBMITTED)).toBe(true)
    expect(valid.has(OrderState.DENIED)).toBe(true)
  })

  it('SUBMITTED has 4 valid targets', () => {
    const valid = getValidTransitions(OrderState.SUBMITTED)
    expect(valid.size).toBe(4)
  })

  it('ACCEPTED has 4 valid targets', () => {
    const valid = getValidTransitions(OrderState.ACCEPTED)
    expect(valid.size).toBe(4)
  })

  it('PARTIALLY_FILLED has 4 valid targets (including self)', () => {
    const valid = getValidTransitions(OrderState.PARTIALLY_FILLED)
    expect(valid.size).toBe(4)
    expect(valid.has(OrderState.PARTIALLY_FILLED)).toBe(true)
  })
})
