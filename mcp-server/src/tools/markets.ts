/**
 * Market data tools — public Polymarket US gateway, no credentials required.
 */

import { z } from 'zod';
import type { MarketBBO, MarketBook } from 'polymarket-us';
import { getPublicSdk, mapLimit, errorMessage } from '../clients/polymarket-us.js';
import {
  flattenEvents,
  sortRows,
  summarizeBook,
  amountToNumber,
  unwrapMarketData,
  statsFromBbo,
  type WireMarketExtras,
  type MarketRow,
  type MarketSort,
  type BookSummary,
} from '../utils/orders.js';
import {
  buildPriceHistoryQuery,
  normalizePriceHistory,
  FIXED_INTERVALS,
  type FixedInterval,
  type RawPriceHistoryResponse,
  type PricePoint,
  type PriceHistorySummary,
} from '../utils/priceHistory.js';

// ─── Tool Schemas ────────────────────────────────────────────

export const getMarketsSchema = {
  search: z.string().optional().describe('Keyword search across event titles (omit to browse)'),
  status: z.enum(['active', 'closed', 'upcoming']).optional().default('active').describe('Market status filter'),
  limit: z.number().int().min(1).max(100).optional().default(25).describe('Max markets to return (1-100)'),
  sort: z.enum(['volume', 'liquidity', 'end_time']).optional().default('volume').describe('Sort order'),
  include_prices: z.boolean().optional().default(true).describe(
    'Fetch BBOs (up to 30 tightest-spread markets) for volume / liquidity — needed to sort by them. Quotes from the listing are always included.',
  ),
};

export const getMarketDetailSchema = {
  market_slug: z.string().optional().describe('Market slug (the tradeable unit, e.g. "chiefs-super-bowl")'),
  event_slug: z.string().optional().describe('Event slug — returns every market in the event with prices'),
};

export const getPriceHistorySchema = {
  market_slug: z.string().describe('Market slug'),
  interval: z.enum(FIXED_INTERVALS as [FixedInterval, ...FixedInterval[]]).optional().describe(
    'Fixed window (default INTERVAL_1D). 1H/6H ≈ 1-min points, 1D = 5-min, 1W/1M/ALL = 3-hour, LIVE = from 15 min before the event starts. Do not combine with start_time/end_time.',
  ),
  start_time: z.union([z.string(), z.number()]).optional().describe('Custom range start (ISO-8601 or Unix seconds); requires end_time; range ≤ 24h'),
  end_time: z.union([z.string(), z.number()]).optional().describe('Custom range end (ISO-8601 or Unix seconds)'),
  max_points: z.number().int().min(2).max(2000).optional().default(300).describe('Down-sample to at most this many points (default 300)'),
};

// ─── Handlers ────────────────────────────────────────────────

/**
 * Upper bound on per-market BBO lookups in one get_markets call. The gateway
 * is behind a Cloudflare rate limit (429 / error 1015 bans the IP for
 * minutes), so keep this small; tightest-spread markets are looked up first.
 */
const MAX_STATS_LOOKUPS = 30;
const LOOKUP_CONCURRENCY = 2;
/** Volume / liquidity move slowly: reuse a market's stats for this long */
const STATS_TTL_MS = 15 * 60 * 1000;

const statsCache = new Map<string, { volume: number; liquidity: number; at: number }>();

/** For tests */
export function clearStatsCache(): void {
  statsCache.clear();
}

/**
 * Fill volume / liquidity on rows. Bid/ask already come inline with the event
 * listing, so a BBO call is only needed for the stats, and only when they are
 * not cached. Rows with cached stats keep their (fresher) inline quotes; at
 * most `maxLookups` uncached rows are fetched, tightest spread first.
 */
async function withStats(rows: MarketRow[], maxLookups: number): Promise<MarketRow[]> {
  const sdk = getPublicSdk();
  const now = Date.now();
  const fresh = (slug: string) => {
    const c = statsCache.get(slug);
    return c && now - c.at < STATS_TTL_MS ? c : null;
  };
  const todo = rows
    .filter(r => relSpread(r) < Infinity && !fresh(r.market_slug))
    .sort((a, b) => relSpread(a) - relSpread(b))
    .slice(0, Math.max(0, maxLookups));
  const bbos = await mapLimit(todo, LOOKUP_CONCURRENCY, r => sdk.markets.bbo(r.market_slug));
  const fetched = new Map<string, MarketRow>();
  todo.forEach((r, i) => {
    const raw = bbos[i];
    if (!raw) return;
    const row = withBbo(r, raw);
    statsCache.set(r.market_slug, { volume: row.volume, liquidity: row.liquidity, at: Date.now() });
    fetched.set(r.market_slug, row);
  });
  return rows.map(r => {
    const got = fetched.get(r.market_slug);
    if (got) return got;
    const c = fresh(r.market_slug);
    return c ? { ...r, volume: c.volume, liquidity: c.liquidity } : r;
  });
}

const relSpread = (r: MarketRow) =>
  r.best_bid != null && r.best_ask != null && r.mid ? (r.best_ask - r.best_bid) / r.mid : Infinity;

export async function handleGetMarkets(args: {
  search?: string;
  status?: 'active' | 'closed' | 'upcoming';
  limit?: number;
  sort?: MarketSort;
  include_prices?: boolean;
}): Promise<{ markets: MarketRow[]; count: number } | { error: string }> {
  const sdk = getPublicSdk();
  const limit = Math.min(args.limit ?? 25, 100);
  const status = args.status ?? 'active';

  try {
    let events;
    if (args.search) {
      const res = await sdk.search.query({ query: args.search, limit: 100, status });
      events = res.events;
    } else {
      const res = await sdk.events.list({
        active: status === 'active' || status === 'upcoming',
        closed: status === 'closed',
        limit: 100,
      });
      events = res.events;
    }

    let rows = flattenEvents(events);
    if (status === 'active') rows = rows.filter(r => r.active && !r.closed);

    // Volume / liquidity exist only on BBOs, so fetch them before sorting by
    // those (two-sided markets first, capped) — otherwise every row is 0.
    const needStats = args.include_prices !== false && (args.sort ?? 'volume') !== 'end_time';
    if (needStats) {
      // Look up about twice as many markets as were asked for (to rank them), capped
      rows = await withStats(rows, Math.min(MAX_STATS_LOOKUPS, Math.max(10, limit * 2)));
    }

    rows = sortRows(rows, args.sort ?? 'volume').slice(0, limit);

    // Sorted by end time: quotes are already inline, so only the returned
    // rows need stats, and cached ones cost nothing
    if (args.include_prices !== false && !needStats && rows.length > 0) {
      rows = await withStats(rows, Math.min(MAX_STATS_LOOKUPS, rows.length));
    }

    return { markets: rows, count: rows.length };
  } catch (error) {
    return { error: `Failed to fetch markets: ${errorMessage(error)}` };
  }
}

export interface MarketDetail {
  market_slug: string;
  title: string;
  outcome: string;
  description?: string;
  event_slug?: string;
  active: boolean;
  closed: boolean;
  liquidity: number;
  volume: number;
  /** Price is YES-terms; NO price = 1 - YES */
  book: BookSummary | null;
  price_tick: number;
  min_quantity?: number;
  fee_coefficient?: number;
  note: string;
}

export async function handleGetMarketDetail(args: {
  market_slug?: string;
  event_slug?: string;
}): Promise<MarketDetail | { event_slug: string; title: string; markets: MarketRow[]; note: string } | { error: string }> {
  const sdk = getPublicSdk();

  if (!args.market_slug && !args.event_slug) {
    return { error: 'Provide market_slug or event_slug' };
  }

  try {
    if (args.event_slug && !args.market_slug) {
      const { event } = await sdk.events.retrieveBySlug(args.event_slug);
      // Quotes are inline; BBO stats only for the tightest markets (rate limit)
      let rows = flattenEvents([event]);
      rows = await withStats(rows, MAX_STATS_LOOKUPS);
      return {
        event_slug: event.slug,
        title: event.title,
        markets: rows,
        note: 'Each market is its own YES/NO book. The markets of an event are NOT guaranteed to be mutually exclusive or exhaustive (some are nested, e.g. "before December" / "before January"), so buying YES on all of them is not a riskless arbitrage.',
      };
    }

    const slug = args.market_slug!;
    const [{ market: base }, bookRes, bboRes] = await Promise.all([
      sdk.markets.retrieveBySlug(slug),
      sdk.markets.book(slug).then(b => unwrapMarketData<MarketBook>(b), () => null),
      sdk.markets.bbo(slug).then(b => unwrapMarketData<MarketBBO>(b), () => null),
    ]);
    const market = base as typeof base & WireMarketExtras;
    const stats = bboRes ? statsFromBbo(bboRes) : null;

    return {
      market_slug: market.slug,
      title: market.title || market.question || market.slug,
      outcome: market.outcome || market.title || market.slug,
      description: market.description,
      event_slug: market.eventSlug,
      active: market.active,
      closed: market.closed,
      liquidity: market.liquidity ?? stats?.liquidity ?? 0,
      volume: market.volume ?? stats?.volume ?? 0,
      book: bookRes ? summarizeBook(bookRes) : null,
      price_tick: market.orderPriceMinTickSize ?? 0.01,
      min_quantity: market.minimumTradeQty,
      fee_coefficient: market.feeCoefficient,
      note: 'One binary book: YES is the outcome named above, NO its negation; prices are YES-side. To trade NO, use outcome="no" in place_order and quote the NO price; the server converts it. Liquidity/volume are USD proxies from open interest and shares traded.',
    };
  } catch (error) {
    return { error: `Market lookup failed for ${args.market_slug ?? args.event_slug}: ${errorMessage(error)}` };
  }
}

export async function handleGetPriceHistory(args: {
  market_slug: string;
  interval?: FixedInterval;
  start_time?: string | number;
  end_time?: string | number;
  max_points?: number;
}): Promise<
  | { market_slug: string; query: Record<string, string | number>; summary: PriceHistorySummary; points: PricePoint[]; note: string }
  | { error: string }
> {
  let query: Record<string, string | number>;
  try {
    query = buildPriceHistoryQuery(args);
  } catch (error) {
    return { error: `Invalid request: ${errorMessage(error)}` };
  }

  try {
    const sdk = getPublicSdk();
    const resp = await sdk.get<RawPriceHistoryResponse>('/v1/price-history', { query });
    const { summary, points } = normalizePriceHistory(resp, args.max_points ?? 300);
    return {
      market_slug: args.market_slug,
      query,
      summary,
      points,
      note: 'yes ≈ best ask, no ≈ 1 - best bid (display prices, not trades); yes + no can exceed 1 by the spread. Empty history = unknown slug or no stored observations.',
    };
  } catch (error) {
    return { error: `Price history failed for ${args.market_slug}: ${errorMessage(error)}` };
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function withBbo(row: MarketRow, raw: MarketBBO | null): MarketRow {
  if (!raw) return row;
  const bbo = unwrapMarketData<MarketBBO>(raw);
  const bid = bbo.bestBid ? amountToNumber(bbo.bestBid) : null;
  const ask = bbo.bestAsk ? amountToNumber(bbo.bestAsk) : null;
  const mid = bid !== null && ask !== null ? Math.round(((bid + ask) / 2) * 10000) / 10000 : null;
  const { volume, liquidity } = statsFromBbo(bbo);
  return { ...row, best_bid: bid, best_ask: ask, mid, volume, liquidity };
}
