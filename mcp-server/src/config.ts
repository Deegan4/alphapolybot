/**
 * Configuration loader for the MCP server.
 * Reads .env from the AlphaPolyBot project root (override with DOTENV_PATH).
 *
 * Polymarket US credentials come from the environment — the MCP server runs
 * outside the browser and cannot read the app's encrypted settings store.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (two levels up from dist/ or src/)
const envPath = process.env.DOTENV_PATH || resolve(__dirname, '..', '..', '.env');
dotenvConfig({ path: envPath });

export interface Config {
  /** Polymarket US API key ID (polymarket.us/developer). Null = read-only mode. */
  keyId: string | null;
  /** Base64 Ed25519 secret key — sensitive, never log or return in tool output */
  secretKey: string | null;

  /** Public market data */
  gatewayBaseUrl: string;
  /** Authenticated: orders, portfolio, account */
  apiBaseUrl: string;

  binanceBaseUrl: string;
  coingeckoBaseUrl: string;
}

/** First non-empty value among the given env var names */
function getEnv(keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim() !== '') return value.trim();
  }
  return fallback;
}

export function loadConfig(): Config {
  return {
    keyId: getEnv(['POLYMARKET_KEY_ID', 'PM_US_KEY_ID']) || null,
    secretKey: getEnv(['POLYMARKET_SECRET_KEY', 'PM_US_SECRET_KEY']) || null,

    gatewayBaseUrl: getEnv(['POLYMARKET_GATEWAY_URL', 'VITE_GATEWAY_URL'], 'https://gateway.polymarket.us'),
    apiBaseUrl: getEnv(['POLYMARKET_API_URL', 'VITE_API_URL'], 'https://api.polymarket.us'),

    binanceBaseUrl: getEnv(['BINANCE_API_URL', 'VITE_BINANCE_API_URL'], 'https://api.binance.com/api/v3'),
    coingeckoBaseUrl: getEnv(['COINGECKO_API_URL', 'VITE_COINGECKO_API_URL'], 'https://api.coingecko.com/api/v3'),
  };
}

/** Singleton config instance */
export const appConfig = loadConfig();
