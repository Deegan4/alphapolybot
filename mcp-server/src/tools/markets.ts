/**
 * Market data tools — public Polymarket US gateway, no credentials required.
 */

import { z } from 'zod';
import type { MarketBBO } from 'polymarket-us';
import { getPublicSdk, mapLimit, errorMessage } from '../clients/polymarket-us.js';
import {
  flattenEvents,
  sortRows,
  summarizeBook,
  amountToNumber,
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
    'Fetch best bid/ask per market (one request each — set false for large lists)',
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
    rows = sortRows(rows, args.sort ?? 'volume').slice(0, limit);

    if (args.include_prices !== false && rows.length > 0) {
      const bbos = await mapLimit(rows, 8, r => sdk.markets.bbo(r.market_slug));
      rows = rows.map((r, i) => withBbo(r, bbos[i]));
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
  note: string;
}

export async function handleGetMarketDetail(args: {
  market_slug?: string;
  event_slug?: string;
}): Promise<MarketDetail | { event_slug: string; title: string; markets: MarketRow[] } | { error: string }> {
  const sdk = getPublicSdk();

  if (!args.market_slug && !args.event_slug) {
    return { error: 'Provide market_slug or event_slug' };
  }

  try {
    if (args.event_slug && !args.market_slug) {
      const { event } = await sdk.events.retrieveBySlug(args.event_slug);
      let rows = flattenEvents([event]);
      const bbos = await mapLimit(rows, 8, r => sdk.markets.bbo(r.market_slug));
      rows = rows.map((r, i) => withBbo(r, bbos[i]));
      return { event_slug: event.slug, title: event.title, markets: rows };
    }

    const slug = args.market_slug!;
    const [{ market }, bookRes] = await Promise.all([
      sdk.markets.retrieveBySlug(slug),
      sdk.markets.book(slug).then(b => b, () => null),
    ]);

    return {
      market_slug: market.slug,
      title: market.title,
      outcome: market.outcome,
      description: market.description,
      event_slug: market.eventSlug,
      active: market.active,
      closed: market.closed,
      liquidity: market.liquidity ?? 0,
      volume: market.volume ?? 0,
      book: bookRes ? summarizeBook(bookRes) : null,
      price_tick: 0.01,
      note: 'Prices are YES-side. To trade NO, use outcome="no" in place_order and quote the NO price; the server converts it.',
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

function withBbo(row: MarketRow, bbo: MarketBBO | null): MarketRow {
  if (!bbo) return { ...row, best_bid: null, best_ask: null, mid: null };
  const bid = bbo.bestBid ? amountToNumber(bbo.bestBid) : null;
  const ask = bbo.bestAsk ? amountToNumber(bbo.bestAsk) : null;
  const mid = bid !== null && ask !== null ? Math.round(((bid + ask) / 2) * 10000) / 10000 : null;
  return { ...row, best_bid: bid, best_ask: ask, mid };
}
