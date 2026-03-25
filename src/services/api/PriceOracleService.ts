/**
 * PriceOracleService - Fetches real-time crypto prices
 *
 * Binance primary (no auth, high rate limits), CoinGecko fallback.
 * 5-second cache to avoid redundant API calls during scan loops.
 */

export interface AssetPrice {
  symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'
  priceUSD: number
  timestamp: number
  source: 'binance' | 'coingecko' | 'rtds' | 'chainlink' | 'crypto.com'
}

const CACHE_TTL_MS = 5_000

const BINANCE_PAIRS: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
}

const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
}

export class PriceOracleService {
  private cache = new Map<string, AssetPrice>()

  async getPrice(symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<AssetPrice> {
    // 0. Chainlink on-chain feed (resolution-source, highest priority)
    try {
      const { chainlinkFeedService } = await import('@/services/trading/ChainlinkFeedService')
      const clPrice = chainlinkFeedService.getCachedPrice(symbol)
      if (clPrice && Date.now() - clPrice.updatedAt * 1000 < CACHE_TTL_MS) {
        return {
          symbol: symbol,
          priceUSD: clPrice.priceUSD,
          timestamp: clPrice.updatedAt * 1000,
          source: 'chainlink',
        }
      }
    } catch {
      // Chainlink not initialized — fall through
    }

    // 1. Try RTDS cached price (streaming, <5s old = fresh)
    try {
      const { rtdsService } = await import('@/services/realtime/RTDSService')
      const rtdsPrice = rtdsService.getCachedPrice(symbol)
      if (rtdsPrice && Date.now() - rtdsPrice.timestamp < CACHE_TTL_MS) {
        // Convert RTDSAssetPrice to AssetPrice shape
        return {
          symbol: rtdsPrice.symbol,
          priceUSD: rtdsPrice.priceUSD,
          timestamp: rtdsPrice.timestamp,
          source: 'rtds',
        }
      }
    } catch {
      // RTDS not available — fall through to HTTP sources
    }

    // 2. Binance WebSocket cache (streaming ~1s, highest-throughput source)
    try {
      const { binanceWSService } = await import('@/services/realtime/BinanceWSService')
      const wsPrice = binanceWSService.getCachedPrice(symbol)
      if (wsPrice && Date.now() - wsPrice.timestamp < CACHE_TTL_MS) {
        return {
          symbol,
          priceUSD: wsPrice.priceUSD,
          timestamp: wsPrice.timestamp,
          source: 'binance' as const,
        }
      }
    } catch {
      // BinanceWS not available — fall through
    }

    // 3. Local cache (existing behavior)
    const cached = this.cache.get(symbol)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached
    }

    // 4. Binance REST (HTTP fallback)
    try {
      const price = await this.fetchBinance(symbol)
      this.cache.set(symbol, price)
      return price
    } catch (err) {
      console.warn(`[PriceOracle] Binance failed for ${symbol}, trying Crypto.com`, err)
    }

    // 5. Crypto.com Exchange (second HTTP fallback)
    try {
      const price = await this.fetchCryptoCom(symbol)
      this.cache.set(symbol, price)
      return price
    } catch (err) {
      console.warn(`[PriceOracle] Crypto.com failed for ${symbol}, trying CoinGecko`, err)
    }

    // 6. CoinGecko (last resort)
    try {
      const price = await this.fetchCoinGecko(symbol)
      this.cache.set(symbol, price)
      return price
    } catch (err) {
      console.error(`[PriceOracle] All sources failed for ${symbol}`, err)
      throw new Error(`Failed to fetch ${symbol} price from all sources`)
    }
  }

  private async fetchBinance(symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<AssetPrice> {
    const pair = BINANCE_PAIRS[symbol]
    const binanceBase = import.meta.env.VITE_BINANCE_API_URL
      || (import.meta.env.DEV ? '/api/binance/api/v3' : 'https://api.binance.com/api/v3')
    const res = await fetch(
      `${binanceBase}/ticker/price?symbol=${pair}`,
      { signal: AbortSignal.timeout(5000) },
    )
    if (!res.ok) throw new Error(`Binance ${res.status}`)
    const data: { price: string } = await res.json()
    return { symbol, priceUSD: parseFloat(data.price), timestamp: Date.now(), source: 'binance' }
  }

  private async fetchCryptoCom(symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<AssetPrice> {
    const { cryptoComClient } = await import('./CryptoComClient')
    const priceUSD = await cryptoComClient.getPrice(symbol)
    return { symbol, priceUSD, timestamp: Date.now(), source: 'crypto.com' }
  }

  private async fetchCoinGecko(symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<AssetPrice> {
    const id = COINGECKO_IDS[symbol]
    const coingeckoBase = import.meta.env.VITE_COINGECKO_API_URL
      || (import.meta.env.DEV ? '/api/coingecko/api/v3' : 'https://api.coingecko.com/api/v3')
    const res = await fetch(
      `${coingeckoBase}/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(5000) },
    )
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`)
    const data: Record<string, { usd: number }> = await res.json()
    return { symbol, priceUSD: data[id].usd, timestamp: Date.now(), source: 'coingecko' }
  }

  clearCache(): void {
    this.cache.clear()
  }
}

export const priceOracleService = new PriceOracleService()
