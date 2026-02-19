/**
 * PM-US trading tools — balances, positions, orders, trade execution.
 * All require PM_US_KEY_ID + PM_US_SECRET_KEY in .env.
 */

import { z } from 'zod';
import { pmusClient, resolveIntent, toApiPrice } from '../clients/pmus.js';

// ─── Schemas ─────────────────────────────────────────────────

export const pmusBalancesSchema = {};

export const pmusPositionsSchema = {
  market_slug: z.string().optional().describe('Filter positions by market slug'),
};

export const pmusOpenOrdersSchema = {
  market_slugs: z.array(z.string()).optional().describe('Filter by market slugs'),
};

export const pmusPlaceOrderSchema = {
  market_slug: z.string().describe('Market slug to trade on'),
  outcome: z.enum(['yes', 'no']).describe('Outcome to trade'),
  side: z.enum(['BUY', 'SELL']).describe('Buy or sell'),
  price: z.number().min(0.01).max(0.99).describe('Limit price (0.01-0.99)'),
  size: z.number().min(0.01).describe('Order size in shares'),
  type: z.enum(['LIMIT', 'MARKET']).optional().default('LIMIT').describe('Order type'),
  post_only: z.boolean().optional().default(false).describe('Post-only (maker) order'),
  dry_run: z.boolean().optional().default(true).describe(
    'Preview only — set to false after explicit user confirmation to execute',
  ),
};

export const pmusCancelOrderSchema = {
  order_id: z.string().describe('Order ID to cancel'),
  market_slug: z.string().describe('Market slug the order belongs to'),
};

export const pmusTradeStatsSchema = {
  limit: z.number().optional().default(20).describe('Max activities to return'),
};

// ─── Handlers ────────────────────────────────────────────────

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handlePmusBalances(_args: Record<string, never>): Promise<any> {
  const result = await pmusClient.getBalances();
  return {
    balance: amountToNumber(result.balance),
    buyingPower: amountToNumber(result.buyingPower),
    pendingBalance: amountToNumber(result.pendingBalance),
  };
}

export async function handlePmusPositions(args: {
  market_slug?: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  const params: Record<string, string> = {};
  if (args.market_slug) params.marketSlug = args.market_slug;

  const result = await pmusClient.getPositions(params);
  const positions = result.positions || result || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (Array.isArray(positions) ? positions : []).map((p: any) => ({
    market_slug: p.marketSlug,
    outcome: p.outcome,
    shares: amountToNumber(p.shares),
    avg_entry: amountToNumber(p.avgEntryPx),
    current_price: amountToNumber(p.currentPx),
    unrealized_pnl: amountToNumber(p.unrealizedPnl),
    realized_pnl: amountToNumber(p.realizedPnl),
  }));
}

export async function handlePmusOpenOrders(args: {
  market_slugs?: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  const params: Record<string, unknown> = {};
  if (args.market_slugs?.length) params.marketSlugs = args.market_slugs;

  const result = await pmusClient.getOpenOrders(params);
  const orders = result.orders || result || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (Array.isArray(orders) ? orders : []).map((o: any) => ({
    id: o.id,
    market_slug: o.marketSlug,
    intent: o.intent,
    price: amountToNumber(o.px),
    size: amountToNumber(o.qty),
    filled: amountToNumber(o.filledQty),
    status: o.status,
    type: o.type,
    created_at: o.createdAt,
  }));
}

export async function handlePmusPlaceOrder(args: {
  market_slug: string;
  outcome: 'yes' | 'no';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  type?: string;
  post_only?: boolean;
  dry_run?: boolean;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  const intent = resolveIntent(args.side, args.outcome);
  const apiPrice = toApiPrice(args.price, args.outcome);

  const orderParams = {
    marketSlug: args.market_slug,
    intent,
    price: apiPrice,
    size: args.size,
    type: args.type || 'LIMIT',
    postOnly: args.post_only ?? false,
  };

  // Dry run: preview only
  if (args.dry_run !== false) {
    try {
      const preview = await pmusClient.previewOrder(orderParams);
      return {
        dry_run: true,
        preview: {
          intent,
          market_slug: args.market_slug,
          outcome: args.outcome,
          side: args.side,
          display_price: args.price,
          api_price: apiPrice,
          size: args.size,
          type: args.type || 'LIMIT',
          post_only: args.post_only ?? false,
          estimated_cost: amountToNumber(preview?.estimatedCost),
          estimated_shares: amountToNumber(preview?.estimatedShares),
        },
        message: 'Set dry_run=false to execute this order.',
      };
    } catch (error) {
      // Preview may not be available — still return a computed preview
      return {
        dry_run: true,
        preview: {
          intent,
          market_slug: args.market_slug,
          outcome: args.outcome,
          side: args.side,
          display_price: args.price,
          api_price: apiPrice,
          size: args.size,
          type: args.type || 'LIMIT',
          post_only: args.post_only ?? false,
          estimated_cost: args.price * args.size,
        },
        message: 'Set dry_run=false to execute this order.',
        note: `Preview API unavailable (${error instanceof Error ? error.message : 'unknown'}), estimate shown.`,
      };
    }
  }

  // Live execution
  const result = await pmusClient.placeOrder(orderParams);
  return {
    dry_run: false,
    order: {
      id: result.id || result.orderId,
      intent,
      market_slug: args.market_slug,
      outcome: args.outcome,
      side: args.side,
      price: args.price,
      size: args.size,
      status: result.status || 'submitted',
    },
  };
}

export async function handlePmusCancelOrder(args: {
  order_id: string;
  market_slug: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    await pmusClient.cancelOrder(args.order_id, args.market_slug);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handlePmusTradeStats(args: {
  limit?: number;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any> {
  const result = await pmusClient.getActivities({ limit: args.limit ?? 20 });
  const activities = result.activities || result || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (Array.isArray(activities) ? activities : []).map((a: any) => ({
    type: a.type,
    market_slug: a.marketSlug,
    intent: a.intent,
    shares: amountToNumber(a.lastShares),
    price: amountToNumber(a.lastPx),
    time: a.transactTime,
    trade_id: a.tradeId,
  }));
}
