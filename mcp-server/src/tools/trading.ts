/**
 * Trading tools — orders and positions on Polymarket US.
 * All write tools default to preview / require explicit confirmation.
 */

import { z } from 'zod';
import type { MarketBBO } from 'polymarket-us';
import { getAuthSdk, AUTH_HELP, errorMessage } from '../clients/polymarket-us.js';
import {
  buildCreateOrderParams,
  formatOrder,
  amountToNumber,
  unwrapMarketData,
  type FormattedOrder,
  type BuiltOrder,
} from '../utils/orders.js';

// ─── Schemas ─────────────────────────────────────────────────

export const getOpenOrdersSchema = {
  market_slugs: z.array(z.string()).optional().describe('Filter by market slugs (omit for all open orders)'),
};

export const cancelOrderSchema = {
  order_id: z.string().describe('Exchange-assigned order ID'),
  market_slug: z.string().describe('Market slug the order belongs to (required by the API)'),
};

export const cancelAllOrdersSchema = {
  confirm: z.boolean().describe('Must be true to confirm cancellation'),
  market_slugs: z.array(z.string()).optional().describe('Limit cancellation to these markets (omit for ALL)'),
};

export const placeOrderSchema = {
  market_slug: z.string().describe('Market slug to trade (from get_markets / get_market_detail)'),
  side: z.enum(['BUY', 'SELL']).describe('BUY or SELL'),
  outcome: z.enum(['yes', 'no']).describe('Outcome to trade. Prices below are in THIS outcome\'s terms.'),
  price: z.number().min(0.01).max(0.99).describe('Limit price for the chosen outcome (0.01-0.99, snapped to 1¢)'),
  quantity: z.number().positive().describe('Number of shares (each pays $1 if the outcome wins)'),
  tif: z.enum(['GTC', 'GTD', 'IOC', 'FOK']).optional().default('GTC').describe(
    'Time in force: GTC (default), GTD (needs good_till_time), IOC, FOK',
  ),
  good_till_time: z.string().optional().describe('ISO-8601 expiry, required for GTD'),
  post_only: z.boolean().optional().default(false).describe('Maker-only (GTC/GTD): reject if it would cross'),
  dry_run: z.boolean().optional().default(true).describe(
    'Preview only (true, DEFAULT) via the exchange preview endpoint, or execute live (false). ALWAYS preview first.',
  ),
};

export const getPositionsSchema = {
  market_slug: z.string().optional().describe('Filter to one market (omit for all open positions)'),
};

export const closePositionSchema = {
  market_slug: z.string().describe('Market whose position to close (sells all contracts held)'),
  confirm: z.boolean().describe('Must be true — this submits a live closing order'),
  slippage_bips: z.number().int().min(0).max(5000).optional().describe('Optional slippage tolerance in basis points'),
};

// ─── Open orders ─────────────────────────────────────────────

export async function handleGetOpenOrders(args: {
  market_slugs?: string[];
}): Promise<{ orders: FormattedOrder[]; count: number } | { error: string }> {
  const sdk = getAuthSdk();
  if (!sdk) return { error: AUTH_HELP };

  try {
    const { orders } = await sdk.orders.list(args.market_slugs?.length ? { slugs: args.market_slugs } : undefined);
    const formatted = orders.map(formatOrder);
    return { orders: formatted, count: formatted.length };
  } catch (error) {
    return { error: `Failed to fetch orders: ${errorMessage(error)}` };
  }
}

// ─── Cancel ──────────────────────────────────────────────────

export async function handleCancelOrder(args: {
  order_id: string;
  market_slug: string;
}): Promise<{ success: boolean; order_id: string; error?: string }> {
  const sdk = getAuthSdk();
  if (!sdk) return { success: false, order_id: args.order_id, error: AUTH_HELP };

  try {
    await sdk.orders.cancel(args.order_id, { marketSlug: args.market_slug });
    return { success: true, order_id: args.order_id };
  } catch (error) {
    return { success: false, order_id: args.order_id, error: errorMessage(error) };
  }
}

export async function handleCancelAllOrders(args: {
  confirm: boolean;
  market_slugs?: string[];
}): Promise<{ success: boolean; count: number; canceled_order_ids?: string[]; error?: string }> {
  if (!args.confirm) {
    return { success: false, count: 0, error: 'Must set confirm: true to cancel orders' };
  }
  const sdk = getAuthSdk();
  if (!sdk) return { success: false, count: 0, error: AUTH_HELP };

  try {
    const res = await sdk.orders.cancelAll(args.market_slugs?.length ? { slugs: args.market_slugs } : undefined);
    const ids = res.canceledOrderIds ?? [];
    return { success: true, count: ids.length, canceled_order_ids: ids };
  } catch (error) {
    return { success: false, count: 0, error: errorMessage(error) };
  }
}

// ─── Place order ─────────────────────────────────────────────

export interface PlaceOrderResult {
  dry_run: boolean;
  request: BuiltOrder['preview'];
  /** Exchange preview of the resulting order (dry run) */
  exchange_preview?: FormattedOrder;
  /** Live result */
  result?: {
    success: boolean;
    order_id?: string;
    filled_quantity?: number;
    avg_price?: number;
    executions?: Array<{ type: string; shares: number; price: number }>;
    error?: string;
  };
}

export async function handlePlaceOrder(args: {
  market_slug: string;
  side: 'BUY' | 'SELL';
  outcome: 'yes' | 'no';
  price: number;
  quantity: number;
  tif?: 'GTC' | 'GTD' | 'IOC' | 'FOK';
  good_till_time?: string;
  post_only?: boolean;
  dry_run?: boolean;
}): Promise<PlaceOrderResult | { error: string }> {
  const sdk = getAuthSdk();
  if (!sdk) return { error: AUTH_HELP };

  const dryRun = args.dry_run !== false; // default true

  let built: BuiltOrder;
  try {
    built = buildCreateOrderParams({
      marketSlug: args.market_slug,
      side: args.side,
      outcome: args.outcome,
      price: args.price,
      quantity: args.quantity,
      tif: args.tif ?? 'GTC',
      goodTillTime: args.good_till_time,
      postOnly: args.post_only,
    });
  } catch (error) {
    return { error: `Invalid order: ${errorMessage(error)}` };
  }

  if (dryRun) {
    try {
      const { order } = await sdk.orders.preview({ request: built.params });
      return { dry_run: true, request: built.preview, exchange_preview: formatOrder(order) };
    } catch (error) {
      // Preview endpoint failure shouldn't hide the local preview
      return {
        dry_run: true,
        request: built.preview,
        result: { success: false, error: `Exchange preview failed: ${errorMessage(error)}` },
      };
    }
  }

  try {
    const resp = await sdk.orders.create(built.params);
    const executions = (resp.executions ?? []).map(e => ({
      type: e.type.replace('EXECUTION_TYPE_', ''),
      shares: parseFloat(e.lastShares ?? '0') || 0,
      price: amountToNumber(e.lastPx),
    }));
    const filled = executions.reduce((s, e) => s + e.shares, 0);
    const notional = executions.reduce((s, e) => s + e.shares * e.price, 0);
    return {
      dry_run: false,
      request: built.preview,
      result: {
        success: true,
        order_id: resp.id,
        filled_quantity: filled,
        avg_price: filled > 0 ? Math.round((notional / filled) * 10000) / 10000 : undefined,
        executions,
      },
    };
  } catch (error) {
    return { dry_run: false, request: built.preview, result: { success: false, error: errorMessage(error) } };
  }
}

// ─── Positions ───────────────────────────────────────────────

export interface FormattedPosition {
  market_slug: string;
  title?: string;
  outcome: 'yes' | 'no';
  net_position: number;
  cost_usd: number;
  avg_entry_price: number | null;
  cash_value_usd: number | null;
  realized_pnl_usd: number;
  qty_available: number | null;
  updated_at?: string;
}

export async function handleGetPositions(args: {
  market_slug?: string;
}): Promise<{ positions: FormattedPosition[]; count: number } | { error: string }> {
  const sdk = getAuthSdk();
  if (!sdk) return { error: AUTH_HELP };

  try {
    // Follow nextCursor until eof (100 per page)
    type PosMap = Awaited<ReturnType<typeof sdk.portfolio.positions>>['positions'];
    const entries: Array<[string, PosMap[string]]> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const params: Record<string, unknown> = { limit: 100 };
      if (args.market_slug) params.market = args.market_slug;
      if (cursor) params.cursor = cursor;
      const res = (await sdk.portfolio.positions(params as never)) as { positions?: PosMap; nextCursor?: string; eof?: boolean };
      entries.push(...Object.entries(res.positions ?? {}));
      if (res.eof !== false || !res.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }

    const positions: FormattedPosition[] = [];
    for (const [slug, p] of entries) {
      // Decimal fields first: the integer ones are rounded and deprecated
      const w = p as typeof p & { netPositionDecimal?: string; qtyAvailableDecimal?: string | null };
      const net = parseFloat(w.netPositionDecimal ?? p.netPosition ?? '0') || 0;
      if (net === 0) continue;
      const cost = Math.abs(amountToNumber(p.cost));
      const cashValue = p.cashValue ? amountToNumber(p.cashValue) : null;
      const avail = w.qtyAvailableDecimal ?? p.qtyAvailable;
      positions.push({
        market_slug: slug,
        title: p.marketMetadata?.title,
        outcome: net > 0 ? 'yes' : 'no',
        net_position: Math.abs(net),
        cost_usd: cost,
        avg_entry_price: Math.round((cost / Math.abs(net)) * 10000) / 10000,
        // The docs describe cashValue as "Unrealized PnL"; reported as-is
        cash_value_usd: cashValue,
        realized_pnl_usd: amountToNumber(p.realized),
        qty_available: avail != null ? parseFloat(avail) : null,
        updated_at: p.updateTime,
      });
    }
    return { positions, count: positions.length };
  } catch (error) {
    return { error: `Failed to fetch positions: ${errorMessage(error)}` };
  }
}

export async function handleClosePosition(args: {
  market_slug: string;
  confirm: boolean;
  slippage_bips?: number;
}): Promise<{ success: boolean; order_id?: string; filled_quantity?: number; error?: string }> {
  if (!args.confirm) {
    return { success: false, error: 'Must set confirm: true to close a position (submits a live order)' };
  }
  const sdk = getAuthSdk();
  if (!sdk) return { success: false, error: AUTH_HELP };

  try {
    let slippageTolerance;
    if (args.slippage_bips !== undefined) {
      const bbo = unwrapMarketData<MarketBBO>(await sdk.markets.bbo(args.market_slug));
      const ref = bbo.bestBid ?? bbo.lastTradePx;
      if (ref) slippageTolerance = { currentPrice: ref, bips: args.slippage_bips };
    }
    const resp = await sdk.orders.closePosition({
      marketSlug: args.market_slug,
      manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_MANUAL',
      synchronousExecution: true,
      maxBlockTime: '5s',
      ...(slippageTolerance ? { slippageTolerance } : {}),
    });
    const filled = (resp.executions ?? []).reduce((s, e) => s + (parseFloat(e.lastShares ?? '0') || 0), 0);
    return { success: true, order_id: resp.id, filled_quantity: filled };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
}
