/**
 * Account tools — authenticated balance query.
 */

import { z } from 'zod';
import { getAuthSdk, AUTH_HELP, errorMessage } from '../clients/polymarket-us.js';

// ─── Schema ──────────────────────────────────────────────────

export const getBalanceSchema = {
  refresh: z.boolean().optional().default(false).describe('Ignored — balances are always fetched live'),
};

// ─── Handler ─────────────────────────────────────────────────

export interface BalanceResult {
  authenticated: true;
  currency: string;
  current_balance: number;
  buying_power: number;
  asset_notional?: number;
  asset_available?: number;
  open_orders_usd?: number;
  unsettled_funds?: number;
  pending_credit?: number;
  pending_withdrawals: number;
  last_updated?: string;
}

export async function handleGetBalance(_args: {
  refresh?: boolean;
}): Promise<BalanceResult | { error: string }> {
  const sdk = getAuthSdk();
  if (!sdk) return { error: AUTH_HELP };

  try {
    const { balances } = await sdk.account.balances();
    const b = balances.find(x => x.currency === 'USD') ?? balances[0];
    if (!b) return { error: 'No balances returned for this account' };

    return {
      authenticated: true,
      currency: b.currency,
      current_balance: b.currentBalance,
      buying_power: b.buyingPower,
      asset_notional: b.assetNotional,
      asset_available: b.assetAvailable,
      open_orders_usd: b.openOrders,
      unsettled_funds: b.unsettledFunds,
      pending_credit: b.pendingCredit,
      pending_withdrawals: b.pendingWithdrawals?.length ?? 0,
      last_updated: b.lastUpdated,
    };
  } catch (error) {
    return { error: `Balance fetch failed: ${errorMessage(error)}` };
  }
}
