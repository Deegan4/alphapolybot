/**
 * Balance tools — authenticated wallet & balance queries.
 */

import { z } from 'zod';
import { clobClient } from '../clients/clob.js';

// ─── Schema ──────────────────────────────────────────────────

export const getBalanceSchema = {
  refresh: z.boolean().optional().default(false).describe(
    'Force re-fetch (otherwise uses cached credentials)',
  ),
};

// ─── Handler ─────────────────────────────────────────────────

export interface BalanceResult {
  signerAddress: string;
  proxyAddress: string;
  signatureType: number;
  signatureTypeName: string;
  balance_usdc: number;
  allowance: string;
  authenticated: boolean;
}

export async function handleGetBalance(_args: {
  refresh?: boolean;
}): Promise<BalanceResult | { error: string }> {
  const ok = await clobClient.init();
  if (!ok) {
    return { error: 'Wallet not configured — set WALLET_SEED_PHRASE in .env or use secure runtime entry.' };
  }

  const info = clobClient.getWalletInfo();
  if (!info) {
    return { error: 'Wallet initialization failed' };
  }

  try {
    const { balance, allowance } = await clobClient.getBalance();

    const sigTypeNames: Record<number, string> = {
      0: 'EOA',
      1: 'POLY_PROXY',
      2: 'GNOSIS_SAFE',
    };

    return {
      signerAddress: info.signerAddress,
      proxyAddress: info.proxyAddress,
      signatureType: info.signatureType,
      signatureTypeName: sigTypeNames[info.signatureType] || 'UNKNOWN',
      balance_usdc: balance,
      allowance,
      authenticated: true,
    };
  } catch (error) {
    return {
      error: `Balance fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
