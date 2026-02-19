/**
 * Market data tools — read-only, no auth required.
 */

import { z } from 'zod';
import { gammaClient, type Market } from '../clients/gamma.js';
import { HttpClient } from '../clients/http.js';
import { appConfig } from '../config.js';
import { ROUNDING_CONFIG } from '../utils/rounding.js';
import { formatCompact, formatPrice, truncate } from '../utils/format.js';

// CLOB client for order book queries (public, no auth)
const clobHttp = new HttpClient({
  baseUrl: appConfig.clobBaseUrl,
  maxRequestsPerMinute: 50,
  timeout: 15000,
  maxRetries: 2,
});

// ─── Tool Schemas ────────────────────────────────────────────

export const getMarketsSchema = {
  active: z.boolean().optional().default(true).describe('Filter for active markets'),
  limit: z.number().optional().default(50).describe('Max markets to return (max 100)'),
  sort: z.enum(['volume24hr', 'liquidity', 'createdAt']).optional().default('volume24hr').describe('Sort field'),
  search: z.string().optional().describe('Search query to filter markets by question text'),
};

export const getMarketDetailSchema = {
  market_id: z.string().optional().describe('Gamma market ID'),
  token_id: z.string().optional().describe('CLOB token ID (alternative to market_id)'),
};

// ─── Tool Handlers ───────────────────────────────────────────

export async function handleGetMarkets(args: {
  active?: boolean;
  limit?: number;
  sort?: string;
  search?: string;
}): Promise<{ markets: MarketRow[]; count: number }> {
  let markets: Market[];

  if (args.search) {
    markets = await gammaClient.searchMarkets(args.search, args.limit ?? 50);
  } else {
    markets = await gammaClient.getActiveMarkets();
  }

  // Sort
  if (args.sort === 'volume24hr') {
    markets.sort((a, b) => (b.volume24hr ?? 0) - (a.volume24hr ?? 0));
  } else if (args.sort === 'liquidity') {
    markets.sort((a, b) => b.liquidity - a.liquidity);
  } else if (args.sort === 'createdAt') {
    markets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // Limit
  const limited = markets.slice(0, Math.min(args.limit ?? 50, 100));

  return {
    markets: limited.map(marketToRow),
    count: limited.length,
  };
}

export async function handleGetMarketDetail(args: {
  market_id?: string;
  token_id?: string;
}): Promise<MarketDetail | { error: string }> {
  if (!args.market_id && !args.token_id) {
    return { error: 'Provide either market_id or token_id' };
  }

  let market: Market | null = null;

  if (args.market_id) {
    market = await gammaClient.getMarket(args.market_id);
  }

  if (!market && args.token_id) {
    // Search by token ID in active markets
    const all = await gammaClient.getActiveMarkets();
    market = all.find(m => m.clobTokenIds?.includes(args.token_id!)) ?? null;
  }

  if (!market) {
    return { error: `Market not found for ${args.market_id || args.token_id}` };
  }

  // Fetch order book for the first token
  let orderBook: OrderBookData | null = null;
  let tickSize = '0.01';
  let feeRateBps = 0;
  let negRisk = market.negRisk ?? false;

  if (market.clobTokenIds?.[0]) {
    const tokenId = market.clobTokenIds[0];

    // Fetch order book, tick size, neg risk, fee rate in parallel
    const [bookRes, tickRes, negRes, feeRes] = await Promise.allSettled([
      clobHttp.get<{ bids: Array<{price: string; size: string}>; asks: Array<{price: string; size: string}> }>(`/book?token_id=${tokenId}`),
      clobHttp.get<string | { minimum_tick_size?: string }>(`/tick-size?token_id=${tokenId}`),
      clobHttp.get<boolean | { neg_risk?: boolean }>(`/neg-risk?token_id=${tokenId}`),
      clobHttp.get<number | { base_fee?: number; fee_rate_bps?: number }>(`/fee-rate?token_id=${tokenId}`),
    ]);

    // Parse order book
    if (bookRes.status === 'fulfilled' && bookRes.value) {
      const book = bookRes.value;
      const bids = (book.bids || []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
      const asks = (book.asks || []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));
      const bestBid = bids[0]?.price ?? 0;
      const bestAsk = asks[0]?.price ?? 1;

      orderBook = {
        bestBid,
        bestAsk,
        spread: bestAsk - bestBid,
        spreadPercent: bestBid > 0 ? (bestAsk - bestBid) / bestBid : 0,
        bidDepth: bids.slice(0, 5).reduce((sum, b) => sum + b.price * b.size, 0),
        askDepth: asks.slice(0, 5).reduce((sum, a) => sum + a.price * a.size, 0),
        bidLevels: bids.length,
        askLevels: asks.length,
      };
    }

    // Parse tick size
    if (tickRes.status === 'fulfilled') {
      const val = tickRes.value;
      if (typeof val === 'string') {
        const cleaned = val.trim().replace(/^"|"$/g, '');
        if (ROUNDING_CONFIG[cleaned]) tickSize = cleaned;
      } else if (val && typeof val === 'object' && 'minimum_tick_size' in val) {
        const ts = String((val as { minimum_tick_size: string }).minimum_tick_size);
        if (ROUNDING_CONFIG[ts]) tickSize = ts;
      }
    }

    // Parse neg risk
    if (negRes.status === 'fulfilled') {
      const val = negRes.value;
      if (typeof val === 'boolean') negRisk = val;
      else if (val && typeof val === 'object' && 'neg_risk' in val) negRisk = Boolean((val as { neg_risk: boolean }).neg_risk);
    }

    // Parse fee rate
    if (feeRes.status === 'fulfilled') {
      const val = feeRes.value;
      if (typeof val === 'number') feeRateBps = val;
      else if (val && typeof val === 'object') {
        feeRateBps = (val as any).base_fee ?? (val as any).fee_rate_bps ?? 0;
      }
    }
  }

  return {
    id: market.id,
    question: market.question,
    description: market.description,
    outcomes: market.outcomes,
    clobTokenIds: market.clobTokenIds,
    conditionId: market.conditionId,
    prices: market.outcomePrices,
    volume: market.volume,
    volume24hr: market.volume24hr,
    liquidity: market.liquidity,
    category: market.category,
    endDate: market.endDate,
    negRisk,
    tickSize,
    feeRateBps,
    orderBook,
  };
}

// ─── Types ───────────────────────────────────────────────────

interface MarketRow {
  id: string;
  question: string;
  outcomes: string[];
  prices: number[];
  volume24hr: number | undefined;
  liquidity: number;
  category?: string;
  endDate: string;
  clobTokenIds: string[];
  negRisk: boolean;
}

interface OrderBookData {
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadPercent: number;
  bidDepth: number;
  askDepth: number;
  bidLevels: number;
  askLevels: number;
}

interface MarketDetail {
  id: string;
  question: string;
  description?: string;
  outcomes: string[];
  clobTokenIds: string[];
  conditionId: string;
  prices: number[];
  volume: number;
  volume24hr?: number;
  liquidity: number;
  category?: string;
  endDate: string;
  negRisk: boolean;
  tickSize: string;
  feeRateBps: number;
  orderBook: OrderBookData | null;
}

function marketToRow(m: Market): MarketRow {
  return {
    id: m.id,
    question: m.question,
    outcomes: m.outcomes,
    prices: m.outcomePrices,
    volume24hr: m.volume24hr,
    liquidity: m.liquidity,
    category: m.category,
    endDate: m.endDate,
    clobTokenIds: m.clobTokenIds,
    negRisk: m.negRisk ?? false,
  };
}
