/**
 * Pure helpers for Polymarket US orders and market data.
 * No I/O — unit tested in __tests__/orders.test.ts.
 *
 * Polymarket US model: an Event groups one Market per outcome (e.g. one per
 * candidate). Each Market has a slug and is traded via an *intent*:
 *   BUY_LONG / SELL_LONG  = buy / sell YES on that market
 *   BUY_SHORT / SELL_SHORT = buy / sell NO on that market
 * Prices are always quoted in YES terms, so a NO price p is sent as 1 - p.
 */

import type {
  Amount,
  CreateOrderParams,
  Event as USEvent,
  MarketBook,
  Order,
  OrderIntent,
  TimeInForce,
} from 'polymarket-us';

export type Side = 'BUY' | 'SELL';
export type Outcome = 'yes' | 'no';
export type Tif = 'GTC' | 'GTD' | 'IOC' | 'FOK';

/** Polymarket US price increment (prices are 2-decimal dollars) */
export const PRICE_TICK = 0.01;

// ─── Intent / price ──────────────────────────────────────────

export function resolveIntent(side: Side, outcome: Outcome): OrderIntent {
  if (side === 'BUY' && outcome === 'yes') return 'ORDER_INTENT_BUY_LONG';
  if (side === 'SELL' && outcome === 'yes') return 'ORDER_INTENT_SELL_LONG';
  if (side === 'BUY' && outcome === 'no') return 'ORDER_INTENT_BUY_SHORT';
  return 'ORDER_INTENT_SELL_SHORT';
}

/** Outcome implied by an intent (for displaying orders) */
export function outcomeOfIntent(intent: string): Outcome {
  return intent.endsWith('_SHORT') ? 'no' : 'yes';
}

export function sideOfIntent(intent: string): Side {
  return intent.includes('_SELL_') ? 'SELL' : 'BUY';
}

/** Convert an outcome-denominated price to the API's YES-side price */
export function toApiPrice(price: number, outcome: Outcome): number {
  return outcome === 'yes' ? price : 1 - price;
}

/** Snap to the 1¢ grid and clamp to (0, 1) exclusive */
export function snapPrice(price: number): number {
  const snapped = Math.round(price / PRICE_TICK) * PRICE_TICK;
  const clamped = Math.min(1 - PRICE_TICK, Math.max(PRICE_TICK, snapped));
  return Math.round(clamped * 100) / 100;
}

export function toTimeInForce(tif: Tif): TimeInForce {
  switch (tif) {
    case 'GTC': return 'TIME_IN_FORCE_GOOD_TILL_CANCEL';
    case 'GTD': return 'TIME_IN_FORCE_GOOD_TILL_DATE';
    case 'IOC': return 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL';
    case 'FOK': return 'TIME_IN_FORCE_FILL_OR_KILL';
  }
}

export function amountToNumber(a?: Amount | null): number {
  if (!a) return 0;
  const n = parseFloat(a.value);
  return Number.isFinite(n) ? n : 0;
}

// ─── Order construction ──────────────────────────────────────

export interface OrderRequestInput {
  marketSlug: string;
  side: Side;
  outcome: Outcome;
  /** Limit price in *outcome* terms (0.01–0.99) */
  price: number;
  /** Shares (decimals allowed on fractional-contract markets) */
  quantity: number;
  tif: Tif;
  /** ISO-8601, required for GTD */
  goodTillTime?: string;
  postOnly?: boolean;
}

export interface BuiltOrder {
  params: CreateOrderParams;
  preview: {
    market_slug: string;
    side: Side;
    outcome: Outcome;
    intent: OrderIntent;
    /** Price in outcome terms, after tick snapping */
    price: number;
    /** Price as sent to the API (YES terms) */
    api_price: number;
    quantity: number;
    tif: Tif;
    good_till_time?: string;
    post_only: boolean;
    /** USD paid (BUY) or received (SELL) if fully filled at the limit */
    estimated_notional_usd: number;
  };
}

export function buildCreateOrderParams(input: OrderRequestInput): BuiltOrder {
  if (!input.marketSlug || input.marketSlug.trim() === '') {
    throw new Error('market_slug is required');
  }
  if (!(input.price > 0 && input.price < 1)) {
    throw new Error(`price must be between 0 and 1 exclusive, got ${input.price}`);
  }
  if (!(input.quantity > 0) || !Number.isFinite(input.quantity)) {
    throw new Error(`quantity must be a positive number of shares, got ${input.quantity}`);
  }
  if (input.tif === 'GTD') {
    if (!input.goodTillTime) throw new Error('good_till_time (ISO-8601) is required for GTD orders');
    if (Number.isNaN(Date.parse(input.goodTillTime))) {
      throw new Error(`good_till_time is not a valid ISO-8601 timestamp: ${input.goodTillTime}`);
    }
    if (Date.parse(input.goodTillTime) <= Date.now()) {
      throw new Error('good_till_time must be in the future');
    }
  }
  if (input.postOnly && input.tif !== 'GTC' && input.tif !== 'GTD') {
    throw new Error('post_only is only valid for GTC and GTD orders');
  }

  const price = snapPrice(input.price);
  const apiPrice = snapPrice(toApiPrice(price, input.outcome));
  const intent = resolveIntent(input.side, input.outcome);

  const params: CreateOrderParams = {
    marketSlug: input.marketSlug,
    intent,
    type: 'ORDER_TYPE_LIMIT',
    price: { value: apiPrice.toFixed(2), currency: 'USD' },
    quantity: input.quantity,
    tif: toTimeInForce(input.tif),
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_MANUAL',
    synchronousExecution: true,
    maxBlockTime: '5s',
  };
  if (input.goodTillTime) params.goodTillTime = input.goodTillTime;
  if (input.postOnly) params.participateDontInitiate = true;

  return {
    params,
    preview: {
      market_slug: input.marketSlug,
      side: input.side,
      outcome: input.outcome,
      intent,
      price,
      api_price: apiPrice,
      quantity: input.quantity,
      tif: input.tif,
      good_till_time: input.goodTillTime,
      post_only: Boolean(input.postOnly),
      estimated_notional_usd: Math.round(price * input.quantity * 100) / 100,
    },
  };
}

// ─── Display formatting ──────────────────────────────────────

export interface FormattedOrder {
  id: string;
  market_slug: string;
  market_title?: string;
  side: Side;
  outcome: Outcome;
  intent: string;
  type: string;
  /** YES-side price as quoted by the API */
  price: number;
  quantity: number;
  filled: number;
  remaining: number;
  avg_price?: number;
  tif: string;
  good_till_time?: string;
  state: string;
  created_at?: string;
}

export function formatOrder(o: Order): FormattedOrder {
  return {
    id: o.id,
    market_slug: o.marketSlug,
    market_title: o.marketMetadata?.title,
    side: sideOfIntent(o.intent),
    outcome: outcomeOfIntent(o.intent),
    intent: o.intent,
    type: o.type.replace('ORDER_TYPE_', ''),
    price: amountToNumber(o.price),
    quantity: o.quantity,
    filled: o.cumQuantity,
    remaining: o.leavesQuantity,
    avg_price: o.avgPx ? amountToNumber(o.avgPx) : undefined,
    tif: o.tif.replace('TIME_IN_FORCE_', ''),
    good_till_time: o.goodTillTime,
    state: o.state.replace('ORDER_STATE_', ''),
    created_at: o.createTime ?? o.insertTime,
  };
}

// ─── Order book ──────────────────────────────────────────────

export interface BookLevel { price: number; size: number }

export interface BookSummary {
  state: string;
  best_bid: number | null;
  best_ask: number | null;
  mid: number | null;
  spread: number | null;
  spread_percent: number | null;
  /** USD notional on each side across the top `depthLevels` */
  bid_depth_usd: number;
  ask_depth_usd: number;
  bid_levels: number;
  ask_levels: number;
  bids: BookLevel[];
  asks: BookLevel[];
  last_trade_price: number | null;
  shares_traded: number | null;
  open_interest: number | null;
}

export function summarizeBook(book: MarketBook, depthLevels = 5): BookSummary {
  const toLevels = (levels: MarketBook['bids']): BookLevel[] =>
    (levels ?? [])
      .map(l => ({ price: amountToNumber(l.px), size: parseFloat(l.qty) || 0 }))
      .filter(l => l.price > 0 && l.size > 0);

  // Best-to-worst: bids descending, asks ascending (defensive — API already sorts)
  const bids = toLevels(book.bids).sort((a, b) => b.price - a.price);
  const asks = toLevels(book.offers).sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const notional = (levels: BookLevel[]) =>
    Math.round(levels.slice(0, depthLevels).reduce((s, l) => s + l.price * l.size, 0) * 100) / 100;

  const parseNum = (s?: string): number | null => {
    if (s === undefined) return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  };

  return {
    state: book.state.replace('MARKET_STATE_', ''),
    best_bid: bestBid,
    best_ask: bestAsk,
    mid: mid !== null ? Math.round(mid * 10000) / 10000 : null,
    spread: spread !== null ? Math.round(spread * 10000) / 10000 : null,
    spread_percent: spread !== null && mid ? Math.round((spread / mid) * 10000) / 10000 : null,
    bid_depth_usd: notional(bids),
    ask_depth_usd: notional(asks),
    bid_levels: bids.length,
    ask_levels: asks.length,
    bids: bids.slice(0, depthLevels),
    asks: asks.slice(0, depthLevels),
    last_trade_price: book.stats?.lastTradePx ? amountToNumber(book.stats.lastTradePx) : null,
    shares_traded: parseNum(book.stats?.sharesTraded),
    open_interest: parseNum(book.stats?.openInterest),
  };
}

// ─── Events → tradeable market rows ──────────────────────────

export interface MarketRow {
  market_slug: string;
  outcome: string;
  title: string;
  event_slug: string;
  event_title: string;
  active: boolean;
  closed: boolean;
  liquidity: number;
  volume: number;
  end_time?: string;
  tags?: string[];
  // Filled in when prices are requested
  best_bid?: number | null;
  best_ask?: number | null;
  mid?: number | null;
}

/** One row per tradeable market (slug), carrying its parent event */
export function flattenEvents(events: USEvent[]): MarketRow[] {
  const rows: MarketRow[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    for (const m of ev.markets ?? []) {
      if (!m.slug || seen.has(m.slug)) continue;
      seen.add(m.slug);
      rows.push({
        market_slug: m.slug,
        outcome: m.outcome || m.title,
        title: m.title,
        event_slug: ev.slug,
        event_title: ev.title,
        active: m.active,
        closed: m.closed,
        liquidity: m.liquidity ?? ev.liquidity ?? 0,
        volume: m.volume ?? ev.volume ?? 0,
        end_time: ev.endTime,
        tags: ev.tags?.map(t => t.label),
      });
    }
  }
  return rows;
}

export type MarketSort = 'volume' | 'liquidity' | 'end_time';

export function sortRows(rows: MarketRow[], sort: MarketSort): MarketRow[] {
  const copy = [...rows];
  switch (sort) {
    case 'volume': return copy.sort((a, b) => b.volume - a.volume);
    case 'liquidity': return copy.sort((a, b) => b.liquidity - a.liquidity);
    case 'end_time': return copy.sort((a, b) =>
      (a.end_time ? Date.parse(a.end_time) : Infinity) - (b.end_time ? Date.parse(b.end_time) : Infinity));
  }
}
