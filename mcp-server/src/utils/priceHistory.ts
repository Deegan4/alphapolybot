/**
 * Pure helpers for GET /v1/price-history (public gateway).
 * See docs.polymarket.us/api-reference/price-history/get-price-history.
 */

/** Documented fixed profiles → required fidelity (minutes) */
export const INTERVAL_FIDELITY = {
  INTERVAL_1H: 1,
  INTERVAL_6H: 1,
  INTERVAL_1D: 5,
  INTERVAL_1W: 180,
  INTERVAL_1M: 180,
  INTERVAL_ALL: 180,
  INTERVAL_LIVE: 1,
} as const;

export type FixedInterval = keyof typeof INTERVAL_FIDELITY;
export const FIXED_INTERVALS = Object.keys(INTERVAL_FIDELITY) as FixedInterval[];

const MAX_CUSTOM_RANGE_SEC = 24 * 60 * 60;

export interface PriceHistoryArgs {
  market_slug: string;
  interval?: FixedInterval;
  /** ISO-8601 or Unix seconds; requires end_time; incompatible with interval */
  start_time?: string | number;
  end_time?: string | number;
}

/** Accepts ISO-8601 or Unix seconds (or ms, which is normalized) */
export function toUnixSeconds(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('timestamp is not a finite number');
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const asNumber = Number(value);
  if (value.trim() !== '' && Number.isFinite(asNumber)) return toUnixSeconds(asNumber);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp: ${value}`);
  return Math.floor(ms / 1000);
}

/**
 * Build the query for the price-history endpoint. Either a fixed interval
 * (default INTERVAL_1D) or a custom range of ≤ 24h with fidelity 1.
 */
export function buildPriceHistoryQuery(args: PriceHistoryArgs): Record<string, string | number> {
  if (!args.market_slug || args.market_slug.trim() === '') throw new Error('market_slug is required');

  const hasStart = args.start_time !== undefined;
  const hasEnd = args.end_time !== undefined;

  if (hasStart || hasEnd) {
    if (args.interval) throw new Error('interval cannot be combined with start_time/end_time');
    if (!hasStart || !hasEnd) throw new Error('start_time and end_time must both be provided');
    const start = toUnixSeconds(args.start_time!);
    const end = toUnixSeconds(args.end_time!);
    if (end <= start) throw new Error('end_time must be after start_time');
    if (end - start > MAX_CUSTOM_RANGE_SEC) throw new Error('custom ranges are limited to 24 hours; use a fixed interval for longer history');
    return {
      symbol: args.market_slug,
      'timestamp.startTimestamp': start,
      'timestamp.endTimestamp': end,
      fidelity: 1,
    };
  }

  const interval = args.interval ?? 'INTERVAL_1D';
  if (!(interval in INTERVAL_FIDELITY)) throw new Error(`unknown interval ${interval}; expected one of ${FIXED_INTERVALS.join(', ')}`);
  return { symbol: args.market_slug, fixedInterval: interval, fidelity: INTERVAL_FIDELITY[interval] };
}

// ─── Response normalization ──────────────────────────────────

export interface RawPriceHistoryPoint {
  timestamp: number;   // Unix seconds
  longPrice: number;   // YES display price (≈ best ask)
  shortPrice: number;  // NO display price (≈ 1 - best bid)
}

export interface RawPriceHistoryResponse {
  history?: RawPriceHistoryPoint[];
}

export interface PricePoint {
  time: string;
  yes: number;
  no: number;
  /** yes + no - 1: the bid-ask spread preserved in the display prices */
  implied_spread: number;
}

export interface PriceHistorySummary {
  points: number;
  returned: number;
  from?: string;
  to?: string;
  yes_first?: number;
  yes_last?: number;
  yes_change?: number;
  yes_min?: number;
  yes_max?: number;
}

export function normalizePriceHistory(
  resp: RawPriceHistoryResponse,
  maxPoints = 500,
): { summary: PriceHistorySummary; points: PricePoint[] } {
  const raw = (resp.history ?? [])
    .filter(p => Number.isFinite(p.timestamp) && Number.isFinite(p.longPrice) && Number.isFinite(p.shortPrice))
    .sort((a, b) => a.timestamp - b.timestamp);

  const all: PricePoint[] = raw.map(p => ({
    time: new Date(p.timestamp * 1000).toISOString(),
    yes: round4(p.longPrice),
    no: round4(p.shortPrice),
    implied_spread: round4(p.longPrice + p.shortPrice - 1),
  }));

  // Evenly down-sample long series, always keeping the first and last point
  let points = all;
  if (all.length > maxPoints && maxPoints >= 2) {
    const step = (all.length - 1) / (maxPoints - 1);
    points = Array.from({ length: maxPoints }, (_, i) => all[Math.round(i * step)]);
  }

  const summary: PriceHistorySummary = { points: all.length, returned: points.length };
  if (all.length > 0) {
    const yes = all.map(p => p.yes);
    summary.from = all[0].time;
    summary.to = all[all.length - 1].time;
    summary.yes_first = yes[0];
    summary.yes_last = yes[yes.length - 1];
    summary.yes_change = round4(yes[yes.length - 1] - yes[0]);
    summary.yes_min = Math.min(...yes);
    summary.yes_max = Math.max(...yes);
  }
  return { summary, points };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
