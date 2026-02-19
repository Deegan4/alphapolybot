/**
 * Trading tools — open orders, place/cancel orders.
 * Phase 2: Read-only (get_open_orders).
 * Phase 3: place_order, cancel_order, cancel_all_orders.
 */

import { z } from 'zod';
import { clobClient, type OpenOrder } from '../clients/clob.js';
import type { OrderPreview } from '../auth/order-signer.js';

// ─── Schemas ─────────────────────────────────────────────────

export const getOpenOrdersSchema = {
  token_id: z.string().optional().describe(
    'Filter by CLOB token ID (optional — omit for all open orders)',
  ),
};

export const cancelOrderSchema = {
  order_id: z.string().describe('Order ID to cancel'),
};

export const cancelAllOrdersSchema = {
  confirm: z.boolean().describe('Must be true to confirm cancellation of ALL open orders'),
};

export const placeOrderSchema = {
  token_id: z.string().describe('CLOB token ID of the outcome to trade'),
  side: z.enum(['BUY', 'SELL']).describe('BUY or SELL'),
  price: z.number().min(0.001).max(0.999).describe('Limit price (0.001-0.999)'),
  size: z.number().min(0.01).describe('Number of outcome shares'),
  tick_size: z.string().describe('Tick size for this token (query get_market_detail first)'),
  fee_rate_bps: z.number().describe('Fee rate in bps for this token (query get_market_detail first)'),
  neg_risk: z.boolean().describe('Whether this token uses NegRisk exchange (query get_market_detail first)'),
  order_type: z.enum(['GTC', 'GTD', 'FOK', 'FAK']).optional().default('GTC').describe(
    'Order type: GTC (good til cancel, default), GTD (good til date), FOK (fill or kill), FAK (fill and kill)',
  ),
  dry_run: z.boolean().optional().default(true).describe(
    'Preview only (true, DEFAULT) or execute live (false). ALWAYS preview first!',
  ),
};

// ─── Handlers ────────────────────────────────────────────────

export interface FormattedOrder {
  id: string;
  token_id: string;
  side: string;
  price: string;
  original_size: string;
  filled: string;
  status: string;
  type: string;
  created_at: string;
}

export async function handleGetOpenOrders(args: {
  token_id?: string;
}): Promise<{ orders: FormattedOrder[]; count: number } | { error: string }> {
  const ok = await clobClient.init();
  if (!ok) {
    return { error: 'Wallet not configured — set VITE_WALLET_SEED_PHRASE in .env' };
  }

  try {
    const orders = await clobClient.getOpenOrders(args.token_id);

    const formatted: FormattedOrder[] = orders.map((o: OpenOrder) => ({
      id: o.id,
      token_id: o.asset_id,
      side: o.side,
      price: o.price,
      original_size: o.original_size,
      filled: o.size_matched,
      status: o.status,
      type: o.type,
      created_at: o.created_at,
    }));

    return { orders: formatted, count: formatted.length };
  } catch (error) {
    return {
      error: `Failed to fetch orders: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function handleCancelOrder(args: {
  order_id: string;
}): Promise<{ success: boolean; order_id: string; error?: string }> {
  const ok = await clobClient.init();
  if (!ok) {
    return { success: false, order_id: args.order_id, error: 'Wallet not configured' };
  }

  const result = await clobClient.cancelOrder(args.order_id);
  return { ...result, order_id: args.order_id };
}

export async function handleCancelAllOrders(args: {
  confirm: boolean;
}): Promise<{ success: boolean; count: number; error?: string }> {
  if (!args.confirm) {
    return { success: false, count: 0, error: 'Must set confirm: true to cancel all orders' };
  }

  const ok = await clobClient.init();
  if (!ok) {
    return { success: false, count: 0, error: 'Wallet not configured' };
  }

  return clobClient.cancelAllOrders();
}

// ─── Phase 3: Place Order ─────────────────────────────────────

export async function handlePlaceOrder(args: {
  token_id: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  tick_size: string;
  fee_rate_bps: number;
  neg_risk: boolean;
  order_type?: string;
  dry_run?: boolean;
}): Promise<{
  preview: OrderPreview;
  dry_run: boolean;
  result?: { success: boolean; orderId?: string; txHash?: string; error?: string };
} | { error: string }> {
  const ok = await clobClient.init();
  if (!ok) {
    return { error: 'Wallet not configured — set VITE_WALLET_SEED_PHRASE in .env' };
  }

  const dryRun = args.dry_run !== false; // default true

  try {
    const { preview, result } = await clobClient.placeOrder({
      tokenId: args.token_id,
      side: args.side,
      price: args.price,
      size: args.size,
      tickSize: args.tick_size,
      feeRateBps: args.fee_rate_bps,
      negRisk: args.neg_risk,
      type: (args.order_type as 'GTC' | 'GTD' | 'FOK' | 'FAK') || 'GTC',
    }, dryRun);

    return { preview, dry_run: dryRun, result };
  } catch (error) {
    return {
      error: `Order failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
