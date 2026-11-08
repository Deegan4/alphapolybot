/**
 * Polymarket US SDK access for the MCP server.
 *
 * Two lazily-created clients:
 *   - public: market data from the gateway (no credentials needed)
 *   - auth:   orders / portfolio / account (API key ID + Ed25519 secret)
 *
 * The SDK signs requests itself (X-PM-Access-Key / X-PM-Timestamp /
 * X-PM-Signature), so there is no wallet, seed phrase or HMAC code here.
 */

import { PolymarketUS, APIError } from 'polymarket-us';
import { appConfig } from '../config.js';

export const AUTH_HELP =
  'Polymarket US API credentials not configured — set POLYMARKET_KEY_ID and ' +
  'POLYMARKET_SECRET_KEY in .env (create a key at polymarket.us/developer).';

let publicSdk: PolymarketUS | null = null;
let authSdk: PolymarketUS | null = null;

/** Unauthenticated client for public market data */
export function getPublicSdk(): PolymarketUS {
  if (!publicSdk) {
    publicSdk = new PolymarketUS({
      gatewayBaseUrl: appConfig.gatewayBaseUrl,
      apiBaseUrl: appConfig.apiBaseUrl,
    });
  }
  return publicSdk;
}

export function hasCredentials(): boolean {
  return Boolean(appConfig.keyId && appConfig.secretKey);
}

/** Authenticated client, or null when credentials are missing */
export function getAuthSdk(): PolymarketUS | null {
  if (!hasCredentials()) return null;
  if (!authSdk) {
    authSdk = new PolymarketUS({
      keyId: appConfig.keyId!,
      secretKey: appConfig.secretKey!,
      gatewayBaseUrl: appConfig.gatewayBaseUrl,
      apiBaseUrl: appConfig.apiBaseUrl,
    });
    process.stderr.write(`[polymarket-us] Authenticated as key ${appConfig.keyId!.slice(0, 8)}…\n`);
  }
  return authSdk;
}

/** Human-readable error text for tool output (never includes secrets) */
export function errorMessage(error: unknown): string {
  if (error instanceof APIError) {
    const status = (error as { status?: number }).status;
    return status ? `${error.name} (HTTP ${status}): ${error.message}` : `${error.name}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Run `fn` over `items` with bounded concurrency; failures become null */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch {
        results[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
