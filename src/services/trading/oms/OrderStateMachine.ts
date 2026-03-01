import { OrderState, type ManagedOrder } from './types'

// ==========================================
// ORDER STATE MACHINE — Pure Validation
// ==========================================

/** Valid transitions: from-state → set of valid to-states */
const VALID_TRANSITIONS: Record<OrderState, ReadonlySet<OrderState>> = {
  [OrderState.INITIALIZED]: new Set([
    OrderState.SUBMITTED,
    OrderState.DENIED,
  ]),
  [OrderState.SUBMITTED]: new Set([
    OrderState.ACCEPTED,
    OrderState.FILLED,      // FOK immediate fill
    OrderState.REJECTED,
    OrderState.CANCELED,
  ]),
  [OrderState.ACCEPTED]: new Set([
    OrderState.PARTIALLY_FILLED,
    OrderState.FILLED,
    OrderState.CANCELED,
    OrderState.EXPIRED,
  ]),
  [OrderState.PARTIALLY_FILLED]: new Set([
    OrderState.PARTIALLY_FILLED,  // another partial fill
    OrderState.FILLED,
    OrderState.CANCELED,
    OrderState.EXPIRED,
  ]),
  // Terminal states — no outbound transitions
  [OrderState.FILLED]: new Set(),
  [OrderState.CANCELED]: new Set(),
  [OrderState.EXPIRED]: new Set(),
  [OrderState.REJECTED]: new Set(),
  [OrderState.DENIED]: new Set(),
}

/**
 * Check if a state transition is valid.
 * Pure function — no side effects.
 */
export function validateTransition(from: OrderState, to: OrderState): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false
}

/**
 * Apply a state transition, returning a new ManagedOrder with updated state.
 * Throws if the transition is invalid.
 * Pure function — caller is responsible for persisting the result.
 */
export function transitionOrder(order: ManagedOrder, to: OrderState): ManagedOrder {
  if (!validateTransition(order.state, to)) {
    throw new Error(
      `Invalid order state transition: ${order.state} → ${to} (order ${order.id})`
    )
  }
  return {
    ...order,
    previousState: order.state,
    state: to,
  }
}

/**
 * Get the set of valid target states from a given state.
 * Useful for UI display ("available actions").
 */
export function getValidTransitions(from: OrderState): ReadonlySet<OrderState> {
  return VALID_TRANSITIONS[from] ?? new Set()
}
