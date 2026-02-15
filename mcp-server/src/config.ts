/**
 * Configuration loader for the MCP server.
 * Reads .env from the AlphaPolyBot project root.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (two levels up from src/)
const envPath = process.env.DOTENV_PATH || resolve(__dirname, '..', '..', '.env');
dotenvConfig({ path: envPath });

export interface Config {
  // API endpoints (direct — no Vite proxy in Node.js)
  clobBaseUrl: string;
  gammaBaseUrl: string;
  binanceBaseUrl: string;
  coingeckoBaseUrl: string;

  // Polygon
  polygonRpcUrl: string;
  polygonRpcFallback: string;
  chainId: number;

  // Wallet (sensitive — never log or return in tool output)
  walletSeedPhrase: string | null;
  signatureTypeOverride: number | null;

  // Contracts
  exchangeAddress: string;
  ctfAddress: string;
  usdcAddress: string;
  negRiskCtfExchange: string;
  negRiskExchange: string;
}

function getEnv(key: string, fallback?: string): string {
  // Support both VITE_ prefixed (from .env) and unprefixed
  return process.env[key] || process.env[`VITE_${key}`] || fallback || '';
}

export function loadConfig(): Config {
  const sigTypeStr = getEnv('SIGNATURE_TYPE');
  let signatureTypeOverride: number | null = null;
  if (sigTypeStr !== '') {
    const parsed = parseInt(sigTypeStr, 10);
    if (parsed === 0 || parsed === 1 || parsed === 2) {
      signatureTypeOverride = parsed;
    }
  }

  return {
    // Direct URLs — browser app uses Vite proxy paths, we go direct
    clobBaseUrl: 'https://clob.polymarket.com',
    gammaBaseUrl: 'https://gamma-api.polymarket.com',
    binanceBaseUrl: getEnv('BINANCE_API_URL', 'https://api.binance.com/api/v3'),
    coingeckoBaseUrl: getEnv('COINGECKO_API_URL', 'https://api.coingecko.com/api/v3'),

    polygonRpcUrl: getEnv('POLYGON_RPC_URL', 'https://polygon-rpc.com'),
    polygonRpcFallback: getEnv('POLYGON_RPC_FALLBACK', 'https://rpc-mainnet.matic.network'),
    chainId: parseInt(getEnv('POLYMARKET_CHAIN_ID', '137'), 10),

    walletSeedPhrase: getEnv('WALLET_SEED_PHRASE') || null,
    signatureTypeOverride,

    exchangeAddress: getEnv('POLYMARKET_EXCHANGE_ADDRESS', '0x4bFB41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'),
    ctfAddress: getEnv('POLYMARKET_CTF_ADDRESS', '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'),
    usdcAddress: getEnv('USDC_ADDRESS', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'),
    negRiskCtfExchange: getEnv('NEG_RISK_CTF_EXCHANGE', '0xC5d563A36AE78145C45a50134d48A1215220f80a'),
    negRiskExchange: getEnv('NEG_RISK_EXCHANGE', '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'),
  };
}

/** Singleton config instance */
export const appConfig = loadConfig();
