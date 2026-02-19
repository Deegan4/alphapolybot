/**
 * PM-US market data tools — events, order books, search.
 * No auth required for these endpoints.
 */

import { z } from 'zod';
import { pmusClient } from '../clients/pmus.js';

// ─── Schemas ─────────────────────────────────────────────────

export const pmusInstrumentsSchema = {
  search: z.string().optional().describe('Filter events by keyword'),
  active: z.boolean().optional().default(true).describe('Only active events'),
  limit: z.number().optional().default(20).describe('Max events to return'),
  categories: z.array(z.string()).optional().describe('Filter by category slugs'),
};

export const pmusOrderBookSchema = {
  market_slug: z.string().describe('Market slug (e.g. "btc-above-100000-feb-28")'),
  bbo_only: z.boolean().optional().default(false).describe(
    'If true, return only best bid/offer instead of full book',
  ),
};

export const pmusSearchSchema = {
  query: z.string().describe('Search query for events/markets'),
  limit: z.number().optional().default(20).describe('Max results'),
};

// ─── Handlers ────────────────────────────────────────────────

export async function handlePmusInstruments(args: {
  search?: string;
  active?: boolean;
  limit?: number;
  categories?: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  const params: Record<string, unknown> = {
    active: args.active ?? true,
    limit: args.limit ?? 20,
  };
  if (args.categories?.length) params.categories = args.categories;

  // If search keyword provided, use search endpoint instead
  if (args.search) {
    const searchResult = await pmusClient.searchEvents(args.search, args.limit ?? 20);
    return {
      source: 'search',
      query: args.search,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      events: (searchResult.events || []).map((e: any) => ({
        slug: e.slug,
        title: e.title,
        description: e.description?.slice(0, 200),
        active: e.active,
        closed: e.closed,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        markets: (e.markets || []).map((m: any) => ({
          slug: m.slug,
          outcome: m.outcome,
          active: m.active,
        })),
      })),
    };
  }

  const result = await pmusClient.listEvents(params as Record<string, string>);
  return {
    source: 'list',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: (result.events || []).map((e: any) => ({
      slug: e.slug,
      title: e.title,
      description: e.description?.slice(0, 200),
      active: e.active,
      closed: e.closed,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      markets: (e.markets || []).map((m: any) => ({
        slug: m.slug,
        outcome: m.outcome,
        active: m.active,
      })),
    })),
  };
}

function amountToNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  if (val && typeof val === 'object' && 'amount' in val) {
    const obj = val as { amount: string; scale?: number };
    const raw = parseFloat(obj.amount || '0');
    const scale = obj.scale ?? 6;
    return raw / Math.pow(10, scale);
  }
  return 0;
}

export async function handlePmusOrderBook(args: {
  market_slug: string;
  bbo_only?: boolean;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  if (args.bbo_only) {
    const bbo = await pmusClient.getBBO(args.market_slug);
    return {
      market_slug: args.market_slug,
      type: 'bbo',
      best_bid: amountToNumber(bbo.bestBid),
      best_ask: amountToNumber(bbo.bestAsk),
      last_trade: amountToNumber(bbo.lastTradePx),
      spread: amountToNumber(bbo.bestAsk) - amountToNumber(bbo.bestBid),
    };
  }

  const book = await pmusClient.getOrderBook(args.market_slug);
  return {
    market_slug: book.marketSlug || args.market_slug,
    type: 'full',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bids: (book.bids || []).slice(0, 20).map((l: any) => ({
      price: amountToNumber(l.px),
      size: parseFloat(l.qty) || 0,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    asks: (book.offers || []).slice(0, 20).map((l: any) => ({
      price: amountToNumber(l.px),
      size: parseFloat(l.qty) || 0,
    })),
    stats: book.stats ? {
      last_trade: amountToNumber(book.stats.lastTradePx),
      shares_traded: parseFloat(book.stats.sharesTraded || '0'),
      open_interest: parseFloat(book.stats.openInterest || '0'),
    } : undefined,
  };
}

export async function handlePmusSearch(args: {
  query: string;
  limit?: number;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  const result = await pmusClient.searchEvents(args.query, args.limit ?? 20);
  return {
    query: args.query,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: (result.events || []).map((e: any) => ({
      slug: e.slug,
      title: e.title,
      description: e.description?.slice(0, 200),
      active: e.active,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      markets: (e.markets || []).map((m: any) => ({
        slug: m.slug,
        outcome: m.outcome,
        active: m.active,
      })),
    })),
  };
}
