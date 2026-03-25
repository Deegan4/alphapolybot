/**
 * CryptoComClient — Public market data from Crypto.com Exchange API
 *
 * No auth required for public endpoints. Rate limit: 100 req/s.
 * Provides ticker, order book, candlestick, and recent trades.
 * Used as a price fallback in PriceOracleService and as a cross-exchange
 * data source for strategies.
 *
 * API docs: https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html
 */
import { BaseApiClient } from './BaseApiClient'

// ==========================================
// RESPONSE TYPES
// ==========================================

export interface CryptoComTicker {
  instrument_name: string
  best_bid: number
  best_bid_size: number
  best_ask: number
  best_ask_size: number
  last: number
  high: number
  low: number
  volume: number         // base asset volume (e.g. BTC)
  volumeUsd: number      // quote volume (USDT)
  change24hPct: number   // decimal (e.g. -0.02 = -2%)
  timestamp: number      // epoch ms
}

export interface CryptoComOrderBookLevel {
  price: number
  qty: number
}

export interface CryptoComOrderBook {
  instrument_name: string
  bids: CryptoComOrderBookLevel[]
  asks: CryptoComOrderBookLevel[]
  depth: number
  timestamp: number
}

export interface CryptoComCandle {
  timestamp: number    // epoch ms (open time)
  open: number
  high: number
  low: number
  close: number
  volume: number       // base asset volume
}

export interface CryptoComTrade {
  instrument_name: string
  price: number
  qty: number
  side: 'buy' | 'sell'
  timestamp: number
}

// Crypto.com API raw response shapes
interface RawTickerResponse {
  best_ask: string
  best_ask_size: string
  best_bid: string
  best_bid_size: string
  change: string
  high: string
  instrument_name: string
  last: string
  low: string
  timestamp: string
  volume: string
  volume_value: string
}

interface RawBookResponse {
  asks: { price: string; qty: string }[]
  bids: { price: string; qty: string }[]
  depth: number
  instrument_name: string
  timestamp: string
}

interface RawCandleResponse {
  data: {
    o: string  // open
    h: string  // high
    l: string  // low
    c: string  // close
    v: string  // volume
    t: number  // timestamp (epoch ms)
  }[]
}

interface RawTradesResponse {
  data: {
    instrument_name: string
    price: string
    qty: string
    side: string
    timestamp: string
  }[]
}

// ==========================================
// INSTRUMENT MAPPING
// ==========================================

const SYMBOL_TO_INSTRUMENT: Record<string, string> = {
  BTC: 'BTC_USDT',
  ETH: 'ETH_USDT',
  SOL: 'SOL_USDT',
  XRP: 'XRP_USDT',
}

// Valid candlestick timeframes
export type CryptoComTimeframe =
  | '1m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '12h'
  | '1D' | '7D' | '14D' | '1M'

// ==========================================
// CLIENT
// ==========================================

export class CryptoComClient extends BaseApiClient {
  private _blockedUntil = 0  // Cloudflare circuit breaker

  constructor() {
    const baseURL = import.meta.env.VITE_CRYPTOCOM_API_URL
      || (import.meta.env.DEV ? '/api/cryptocom' : 'https://api.crypto.com/exchange/v1/public')

    super(baseURL, {
      maxRequestsPerMinute: 300,  // conservative vs 100/s actual limit
      maxRetries: 2,
      retryDelay: 500,
      timeout: 8000,
    })
  }

  private checkBlocked(): void {
    if (Date.now() < this._blockedUntil) {
      throw new Error('CryptoComClient: blocked by Cloudflare, backing off')
    }
  }

  /**
   * Get ticker for a symbol (BTC, ETH, SOL, XRP) or raw instrument name.
   */
  async getTicker(symbolOrInstrument: string): Promise<CryptoComTicker> {
    this.checkBlocked()
    const instrument = SYMBOL_TO_INSTRUMENT[symbolOrInstrument] || symbolOrInstrument
    try {
      const raw = await this.get<RawTickerResponse>(`/get-ticker`, {
        params: { instrument_name: instrument },
      })
      return this.parseTicker(raw)
    } catch (e: unknown) {
      if ((e as { status?: number }).status === 403) {
        this._blockedUntil = Date.now() + 5 * 60_000  // back off 5 min
        console.warn('[CryptoComClient] 403 Cloudflare block — disabling for 5 minutes')
      }
      throw e
    }
  }

  /**
   * Get tickers for all instruments (or filter by instrument name).
   */
  async getTickers(instrumentName?: string): Promise<CryptoComTicker[]> {
    const params: Record<string, string> = {}
    if (instrumentName) params.instrument_name = instrumentName
    const raw = await this.get<RawTickerResponse[] | RawTickerResponse>(`/get-tickers`, { params })
    const items = Array.isArray(raw) ? raw : [raw]
    return items.map(t => this.parseTicker(t))
  }

  /**
   * Get order book snapshot.
   * @param depth Number of levels (default 10, max 50)
   */
  async getOrderBook(symbolOrInstrument: string, depth = 10): Promise<CryptoComOrderBook> {
    const instrument = SYMBOL_TO_INSTRUMENT[symbolOrInstrument] || symbolOrInstrument
    const raw = await this.get<RawBookResponse>(`/get-book`, {
      params: { instrument_name: instrument, depth },
    })
    return {
      instrument_name: raw.instrument_name,
      bids: raw.bids.map(l => ({ price: parseFloat(l.price), qty: parseFloat(l.qty) })),
      asks: raw.asks.map(l => ({ price: parseFloat(l.price), qty: parseFloat(l.qty) })),
      depth: raw.depth,
      timestamp: new Date(raw.timestamp).getTime(),
    }
  }

  /**
   * Get recent candlesticks (up to 50).
   */
  async getCandlesticks(
    symbolOrInstrument: string,
    timeframe: CryptoComTimeframe = '1h',
  ): Promise<CryptoComCandle[]> {
    const instrument = SYMBOL_TO_INSTRUMENT[symbolOrInstrument] || symbolOrInstrument
    const raw = await this.get<RawCandleResponse>(`/get-candlestick`, {
      params: { instrument_name: instrument, timeframe },
    })
    return raw.data.map(c => ({
      timestamp: c.t,
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
    }))
  }

  /**
   * Get recent trades (default 10, max 150).
   */
  async getTrades(symbolOrInstrument: string, count = 10): Promise<CryptoComTrade[]> {
    const instrument = SYMBOL_TO_INSTRUMENT[symbolOrInstrument] || symbolOrInstrument
    const raw = await this.get<RawTradesResponse>(`/get-trades`, {
      params: { instrument_name: instrument, count },
    })
    return raw.data.map(t => ({
      instrument_name: t.instrument_name,
      price: parseFloat(t.price),
      qty: parseFloat(t.qty),
      side: t.side as 'buy' | 'sell',
      timestamp: new Date(t.timestamp).getTime(),
    }))
  }

  /**
   * Get current price for a symbol (convenience for PriceOracleService).
   * Returns mid-price from best bid/ask for accuracy.
   */
  async getPrice(symbol: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<number> {
    const ticker = await this.getTicker(symbol)
    // Mid-price is more accurate than last trade price
    return (ticker.best_bid + ticker.best_ask) / 2
  }

  /**
   * Get mark price for an instrument.
   */
  async getMarkPrice(symbolOrInstrument: string): Promise<number> {
    const instrument = SYMBOL_TO_INSTRUMENT[symbolOrInstrument] || symbolOrInstrument
    const raw = await this.get<{ mark_price: string }>(`/get-mark-price`, {
      params: { instrument_name: instrument },
    })
    return parseFloat(raw.mark_price)
  }

  /**
   * Get index price for an instrument.
   */
  async getIndexPrice(symbolOrInstrument: string): Promise<number> {
    const instrument = SYMBOL_TO_INSTRUMENT[symbolOrInstrument] || symbolOrInstrument
    const raw = await this.get<{ index_price: string }>(`/get-index-price`, {
      params: { instrument_name: instrument },
    })
    return parseFloat(raw.index_price)
  }

  // ==========================================
  // PRIVATE HELPERS
  // ==========================================

  private parseTicker(raw: RawTickerResponse): CryptoComTicker {
    return {
      instrument_name: raw.instrument_name,
      best_bid: parseFloat(raw.best_bid),
      best_bid_size: parseFloat(raw.best_bid_size),
      best_ask: parseFloat(raw.best_ask),
      best_ask_size: parseFloat(raw.best_ask_size),
      last: parseFloat(raw.last),
      high: parseFloat(raw.high),
      low: parseFloat(raw.low),
      volume: parseFloat(raw.volume),
      volumeUsd: parseFloat(raw.volume_value),
      change24hPct: parseFloat(raw.change),
      timestamp: new Date(raw.timestamp).getTime(),
    }
  }
}

export const cryptoComClient = new CryptoComClient()
