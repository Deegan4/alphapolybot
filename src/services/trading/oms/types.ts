// ==========================================
// ORDER MANAGEMENT SYSTEM — TYPES
// Inspired by NautilusTrader, adapted for Polymarket CLOB
// ==========================================

/**
 * Formal order states with validated transitions.
 *
 * State machine:
 *   INITIALIZED → SUBMITTED → ACCEPTED → PARTIALLY_FILLED → FILLED
 *                                       → CANCELED
 *                                       → EXPIRED
 *                            → REJECTED
 *              → DENIED (pre-flight, never sent to exchange)
 *
 * FOK fast path: INITIALIZED → SUBMITTED → FILLED (no ACCEPTED intermediate)
 * GTD full path: INITIALIZED → SUBMITTED → ACCEPTED → PARTIALLY_FILLED* → FILLED
 */
export enum OrderState {
  /** Created locally, not yet submitted */
  INITIALIZED = 'INITIALIZED',
  /** Sent to CLOB API, awaiting acknowledgment */
  SUBMITTED = 'SUBMITTED',
  /** CLOB acknowledged — on book (GTC/GTD). For FOK this is transient. */
  ACCEPTED = 'ACCEPTED',
  /** Some shares filled, remainder still open (GTC/GTD only) */
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  /** Fully filled */
  FILLED = 'FILLED',
  /** Canceled by user, OCO counterpart, or emergency stop */
  CANCELED = 'CANCELED',
  /** GTD expired server-side */
  EXPIRED = 'EXPIRED',
  /** Exchange rejected (invalid signature, tick size, etc.) */
  REJECTED = 'REJECTED',
  /** Pre-flight rejection — risk check failed, insufficient balance */
  DENIED = 'DENIED',
}

export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set([
  OrderState.FILLED,
  OrderState.CANCELED,
  OrderState.EXPIRED,
  OrderState.REJECTED,
  OrderState.DENIED,
])

export const ACTIVE_STATES: ReadonlySet<OrderState> = new Set([
  OrderState.SUBMITTED,
  OrderState.ACCEPTED,
  OrderState.PARTIALLY_FILLED,
])

// ── Strategy & Intent ──

export type StrategyId =
  | 'llm'
  | 'dip'
  | 'fw'
  | 'btc'
  | 'dual-side'

export type OrderIntent =
  | 'entry'
  | 'exit-sl'
  | 'exit-tp'
  | 'exit-trailing'
  | 'exit-time'
  | 'exit-manual'
  | 'exit-emergency'
  | 'hedge-yes'
  | 'hedge-no'
  | 'gtd-fallback'

// ── Managed Order ──

export interface ManagedOrder {
  /** Unique internal ID (UUID, assigned at INITIALIZED) */
  id: string
  /** Exchange order ID (set after SUBMITTED, from CLOB response) */
  exchangeOrderId?: string

  // ── Identity ──
  strategyId: StrategyId
  marketSlug: string
  tokenId?: string
  outcome: 'yes' | 'no'
  side: 'BUY' | 'SELL'

  // ── Order parameters ──
  orderType: 'FOK' | 'GTC' | 'GTD'
  price: number
  size: number
  postOnly?: boolean
  gtdExpirationSec?: number

  // ── Fill tracking ──
  filledSize: number
  avgFillPrice: number
  remainingSize: number

  // ── State ──
  state: OrderState
  previousState?: OrderState

  // ── Timestamps (ms since epoch) ──
  createdAt: number
  submittedAt?: number
  acceptedAt?: number
  lastFillAt?: number
  completedAt?: number

  // ── Metadata ──
  intent: OrderIntent
  costBasis: number
  tags?: Record<string, string>

  // ── Contingency ──
  orderListId?: string
  contingencyType?: 'OCO'
  linkedOrderId?: string

  // ── Position handoff ──
  stopLossPercent?: number
  takeProfitPercent?: number
  maxHoldMs?: number
  takerFeeBps?: number

  // ── Error ──
  rejectReason?: string
}

/** Parameters for creating a new ManagedOrder */
export interface CreateOrderParams {
  strategyId: StrategyId
  marketSlug: string
  tokenId?: string
  outcome: 'yes' | 'no'
  side: 'BUY' | 'SELL'
  orderType: 'FOK' | 'GTC' | 'GTD'
  price: number
  size: number
  intent: OrderIntent
  postOnly?: boolean
  gtdExpirationSec?: number
  stopLossPercent?: number
  takeProfitPercent?: number
  maxHoldMs?: number
  takerFeeBps?: number
  tags?: Record<string, string>
}

// ── Order Events ──

interface BaseOrderEvent {
  orderId: string
  exchangeOrderId?: string
  timestamp: number
  strategyId: StrategyId
  marketSlug: string
}

export interface OrderInitializedEvent extends BaseOrderEvent {
  type: 'ORDER_INITIALIZED'
  order: ManagedOrder
}

export interface OrderDeniedEvent extends BaseOrderEvent {
  type: 'ORDER_DENIED'
  reason: string
}

export interface OrderSubmittedEvent extends BaseOrderEvent {
  type: 'ORDER_SUBMITTED'
  exchangeOrderId: string
}

export interface OrderAcceptedEvent extends BaseOrderEvent {
  type: 'ORDER_ACCEPTED'
}

export interface OrderRejectedEvent extends BaseOrderEvent {
  type: 'ORDER_REJECTED'
  reason: string
}

export interface OrderPartiallyFilledEvent extends BaseOrderEvent {
  type: 'ORDER_PARTIALLY_FILLED'
  fillSize: number
  fillPrice: number
  cumulativeFilledSize: number
  remainingSize: number
}

export interface OrderFilledEvent extends BaseOrderEvent {
  type: 'ORDER_FILLED'
  fillSize: number
  fillPrice: number
  totalFilledSize: number
  avgFillPrice: number
}

export interface OrderCanceledEvent extends BaseOrderEvent {
  type: 'ORDER_CANCELED'
  reason: string
}

export interface OrderExpiredEvent extends BaseOrderEvent {
  type: 'ORDER_EXPIRED'
}

export type OrderEvent =
  | OrderInitializedEvent
  | OrderDeniedEvent
  | OrderSubmittedEvent
  | OrderAcceptedEvent
  | OrderRejectedEvent
  | OrderPartiallyFilledEvent
  | OrderFilledEvent
  | OrderCanceledEvent
  | OrderExpiredEvent

export type OrderEventType = OrderEvent['type']

export type OrderEventCallback = (event: OrderEvent) => void
