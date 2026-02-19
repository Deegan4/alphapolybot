/**
 * Crypto price tools — fetches from Binance with CoinGecko fallback.
 */

import { z } from 'zod';
import { HttpClient } from '../clients/http.js';
import { appConfig } from '../config.js';

const binanceHttp = new HttpClient({
  baseUrl: appConfig.binanceBaseUrl,
  maxRequestsPerMinute: 120,
  timeout: 10000,
  maxRetries: 2,
});

const coingeckoHttp = new HttpClient({
  baseUrl: appConfig.coingeckoBaseUrl,
  maxRequestsPerMinute: 30,
  timeout: 10000,
  maxRetries: 2,
});

// Symbol mappings
const BINANCE_SYMBOLS: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
  MATIC: 'MATICUSDT',
};

const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
  MATIC: 'matic-network',
};

// ─── Schema ──────────────────────────────────────────────────

export const getCryptoPricesSchema = {
  symbols: z.array(z.string()).optional().default(['BTC', 'ETH', 'SOL']).describe(
    'Crypto symbols to fetch prices for (e.g. ["BTC", "ETH", "SOL"])',
  ),
};

// ─── Handler ─────────────────────────────────────────────────

export interface CryptoPrice {
  symbol: string;
  price: number;
  change24h: number | null;
  source: 'binance' | 'coingecko';
}

export async function handleGetCryptoPrices(args: {
  symbols?: string[];
}): Promise<{ prices: CryptoPrice[] }> {
  const symbols = (args.symbols ?? ['BTC', 'ETH', 'SOL']).map(s => s.toUpperCase());
  const results: CryptoPrice[] = [];

  // Try Binance first (faster, more reliable)
  const binanceResults = await fetchBinancePrices(symbols);
  const missing: string[] = [];

  for (const sym of symbols) {
    const binPrice = binanceResults.get(sym);
    if (binPrice) {
      results.push(binPrice);
    } else {
      missing.push(sym);
    }
  }

  // Fallback to CoinGecko for any missing
  if (missing.length > 0) {
    const geckoResults = await fetchCoinGeckoPrices(missing);
    for (const sym of missing) {
      const price = geckoResults.get(sym);
      if (price) results.push(price);
    }
  }

  return { prices: results };
}

async function fetchBinancePrices(symbols: string[]): Promise<Map<string, CryptoPrice>> {
  const result = new Map<string, CryptoPrice>();

  try {
    // Batch request for 24h ticker data
    const binanceSymbols = symbols
      .map(s => BINANCE_SYMBOLS[s])
      .filter(Boolean);

    if (binanceSymbols.length === 0) return result;

    const tickers = await binanceHttp.get<Array<{
      symbol: string;
      lastPrice: string;
      priceChangePercent: string;
    }>>('/ticker/24hr', {
      params: { symbols: JSON.stringify(binanceSymbols) },
    });

    for (const ticker of tickers) {
      // Reverse-map Binance symbol to our symbol
      const sym = Object.entries(BINANCE_SYMBOLS).find(([, v]) => v === ticker.symbol)?.[0];
      if (sym) {
        result.set(sym, {
          symbol: sym,
          price: parseFloat(ticker.lastPrice),
          change24h: parseFloat(ticker.priceChangePercent) / 100,
          source: 'binance',
        });
      }
    }
  } catch (error) {
    process.stderr.write(`[prices] Binance fetch failed: ${error}\n`);
  }

  return result;
}

async function fetchCoinGeckoPrices(symbols: string[]): Promise<Map<string, CryptoPrice>> {
  const result = new Map<string, CryptoPrice>();

  try {
    const ids = symbols
      .map(s => COINGECKO_IDS[s])
      .filter(Boolean)
      .join(',');

    if (!ids) return result;

    const data = await coingeckoHttp.get<Record<string, { usd: number; usd_24h_change?: number }>>(
      '/simple/price',
      { params: { ids, vs_currencies: 'usd', include_24hr_change: 'true' } },
    );

    for (const sym of symbols) {
      const id = COINGECKO_IDS[sym];
      if (id && data[id]) {
        result.set(sym, {
          symbol: sym,
          price: data[id].usd,
          change24h: data[id].usd_24h_change != null ? data[id].usd_24h_change! / 100 : null,
          source: 'coingecko',
        });
      }
    }
  } catch (error) {
    process.stderr.write(`[prices] CoinGecko fetch failed: ${error}\n`);
  }

  return result;
}
