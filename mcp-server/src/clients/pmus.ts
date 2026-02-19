/**
 * Polymarket US client for the MCP server.
 * Uses the official `polymarket-us` SDK with Ed25519 auth.
 *
 * Unauthenticated mode: market data (events, order books, search).
 * Authenticated mode: balances, positions, orders, trading.
 */

import { PolymarketUS } from 'polymarket-us';
import { appConfig } from '../config.js';

// ─── Intent/Price Helpers (ported from src/types/api.ts) ──────

export type USOrderIntent =
  | 'ORDER_INTENT_BUY_LONG'
  | 'ORDER_INTENT_SELL_LONG'
  | 'ORDER_INTENT_BUY_SHORT'
  | 'ORDER_INTENT_SELL_SHORT';

export function resolveIntent(
  side: 'BUY' | 'SELL',
  outcome: 'yes' | 'no',
): USOrderIntent {
  if (side === 'BUY' && outcome === 'yes') return 'ORDER_INTENT_BUY_LONG';
  if (side === 'SELL' && outcome === 'yes') return 'ORDER_INTENT_SELL_LONG';
  if (side === 'BUY' && outcome === 'no') return 'ORDER_INTENT_BUY_SHORT';
  return 'ORDER_INTENT_SELL_SHORT';
}

export function toApiPrice(price: number, outcome: 'yes' | 'no'): number {
  return outcome === 'yes' ? price : 1.0 - price;
}

// ─── Client ─────────────────────────────────────────────────

export class PmusClient {
  private sdk: PolymarketUS | null = null;
  private _authenticated = false;

  /**
   * Get or create the SDK instance.
   * Creates unauthenticated if no credentials, authenticated otherwise.
   */
  getSDK(): PolymarketUS {
    if (this.sdk) return this.sdk;

    const hasAuth = appConfig.pmusKeyId && appConfig.pmusSecretKey;
    if (hasAuth) {
      this.sdk = new PolymarketUS({
        keyId: appConfig.pmusKeyId!,
        secretKey: appConfig.pmusSecretKey!,
      });
      this._authenticated = true;
      process.stderr.write(`[pmus] Authenticated SDK initialized (key: ${appConfig.pmusKeyId!.slice(0, 8)}…)\n`);
    } else {
      // Unauthenticated — market data only
      this.sdk = new PolymarketUS({
        keyId: '',
        secretKey: '',
      });
      this._authenticated = false;
      process.stderr.write('[pmus] Unauthenticated SDK initialized (market data only)\n');
    }
    return this.sdk;
  }

  /** Whether credentials are configured */
  get isAuthenticated(): boolean {
    return this._authenticated;
  }

  /** Ensure authenticated SDK is available */
  requireAuth(): PolymarketUS {
    const sdk = this.getSDK();
    if (!this._authenticated) {
      throw new Error(
        'PM-US credentials required. Set PM_US_KEY_ID and PM_US_SECRET_KEY in .env',
      );
    }
    return sdk;
  }

  // ─── Market Data (no auth required) ────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listEvents(params?: Record<string, any>): Promise<any> {
    const sdk = this.getSDK();
    return sdk.events.list(params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async searchEvents(query: string, limit = 20): Promise<any> {
    const sdk = this.getSDK();
    return sdk.search.query({ query, limit });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getOrderBook(marketSlug: string): Promise<any> {
    const sdk = this.getSDK();
    return sdk.markets.book(marketSlug);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getBBO(marketSlug: string): Promise<any> {
    const sdk = this.getSDK();
    return sdk.markets.bbo(marketSlug);
  }

  // ─── Authenticated Methods ─────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getBalances(): Promise<any> {
    const sdk = this.requireAuth();
    return sdk.account.balances();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getPositions(params?: Record<string, any>): Promise<any> {
    const sdk = this.requireAuth();
    return sdk.portfolio.positions(params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getOpenOrders(params?: Record<string, any>): Promise<any> {
    const sdk = this.requireAuth();
    return sdk.orders.list(params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async placeOrder(params: Record<string, any>): Promise<any> {
    const sdk = this.requireAuth();
    return sdk.orders.create(params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async previewOrder(params: Record<string, any>): Promise<any> {
    const sdk = this.requireAuth();
    return sdk.orders.preview(params);
  }

  async cancelOrder(orderId: string, marketSlug: string): Promise<void> {
    const sdk = this.requireAuth();
    await sdk.orders.cancel(orderId, { marketSlug });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getActivities(params?: Record<string, any>): Promise<any> {
    const sdk = this.requireAuth();
    return sdk.portfolio.activities(params);
  }
}

// ─── Singleton ──────────────────────────────────────────────

export const pmusClient = new PmusClient();
