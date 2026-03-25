import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CryptoComClient } from '../CryptoComClient'
import type { CryptoComTicker, CryptoComOrderBook, CryptoComCandle, CryptoComTrade } from '../CryptoComClient'

// Mock axios to avoid real HTTP calls
vi.mock('axios', () => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    defaults: { headers: { common: {} } },
    interceptors: {
      response: { use: vi.fn() },
      request: { use: vi.fn() },
    },
  }
  return {
    default: {
      create: vi.fn(() => mockAxiosInstance),
    },
    __mockInstance: mockAxiosInstance,
  }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockAxios: any

beforeEach(async () => {
  const axios = await import('axios')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockAxios = (axios as any).__mockInstance
  vi.clearAllMocks()
})

describe('CryptoComClient', () => {
  let client: CryptoComClient

  beforeEach(() => {
    client = new CryptoComClient()
  })

  // ─── getTicker ─────────────────────────────────────────────

  describe('getTicker', () => {
    const rawTicker = {
      best_ask: '69694.01',
      best_ask_size: '0.11378',
      best_bid: '69694.00',
      best_bid_size: '0.13360',
      change: '-0.0193',
      high: '72060.16',
      instrument_name: 'BTC_USDT',
      last: '69701.00',
      low: '69086.01',
      timestamp: '2026-03-19T15:15:03.442Z',
      volume: '4752.1370',
      volume_value: '335725564.91',
    }

    it('parses ticker response with correct numeric types', async () => {
      mockAxios.get.mockResolvedValueOnce({ data: rawTicker })
      const ticker: CryptoComTicker = await client.getTicker('BTC')

      expect(ticker.instrument_name).toBe('BTC_USDT')
      expect(ticker.best_bid).toBe(69694.00)
      expect(ticker.best_ask).toBe(69694.01)
      expect(ticker.last).toBe(69701.00)
      expect(ticker.high).toBe(72060.16)
      expect(ticker.low).toBe(69086.01)
      expect(ticker.volume).toBeCloseTo(4752.137)
      expect(ticker.volumeUsd).toBeCloseTo(335725564.91)
      expect(ticker.change24hPct).toBe(-0.0193)
      expect(typeof ticker.timestamp).toBe('number')
    })

    it('maps symbol shorthand to instrument name', async () => {
      mockAxios.get.mockResolvedValueOnce({ data: rawTicker })
      await client.getTicker('BTC')

      expect(mockAxios.get).toHaveBeenCalledWith(
        '/get-ticker',
        expect.objectContaining({
          params: { instrument_name: 'BTC_USDT' },
        }),
      )
    })

    it('passes raw instrument name through', async () => {
      mockAxios.get.mockResolvedValueOnce({ data: { ...rawTicker, instrument_name: 'DOGE_USDT' } })
      await client.getTicker('DOGE_USDT')

      expect(mockAxios.get).toHaveBeenCalledWith(
        '/get-ticker',
        expect.objectContaining({
          params: { instrument_name: 'DOGE_USDT' },
        }),
      )
    })
  })

  // ─── getOrderBook ──────────────────────────────────────────

  describe('getOrderBook', () => {
    const rawBook = {
      asks: [
        { price: '69778.01', qty: '0.19309' },
        { price: '69779.41', qty: '0.00500' },
      ],
      bids: [
        { price: '69778.00', qty: '0.41733' },
        { price: '69777.81', qty: '0.09230' },
      ],
      depth: 5,
      instrument_name: 'BTC_USDT',
      timestamp: '2026-03-19T15:17:04Z',
    }

    it('parses order book with numeric prices and quantities', async () => {
      mockAxios.get.mockResolvedValueOnce({ data: rawBook })
      const book: CryptoComOrderBook = await client.getOrderBook('BTC', 5)

      expect(book.instrument_name).toBe('BTC_USDT')
      expect(book.asks).toHaveLength(2)
      expect(book.bids).toHaveLength(2)
      expect(book.asks[0].price).toBe(69778.01)
      expect(book.asks[0].qty).toBeCloseTo(0.19309)
      expect(book.bids[0].price).toBe(69778.00)
      expect(book.bids[0].qty).toBeCloseTo(0.41733)
      expect(typeof book.timestamp).toBe('number')
    })

    it('passes depth parameter', async () => {
      mockAxios.get.mockResolvedValueOnce({ data: rawBook })
      await client.getOrderBook('ETH', 20)

      expect(mockAxios.get).toHaveBeenCalledWith(
        '/get-book',
        expect.objectContaining({
          params: { instrument_name: 'ETH_USDT', depth: 20 },
        }),
      )
    })
  })

  // ─── getCandlesticks ───────────────────────────────────────

  describe('getCandlesticks', () => {
    const rawCandles = {
      data: [
        { o: '69500.00', h: '69800.00', l: '69400.00', c: '69700.00', v: '123.45', t: 1710850800000 },
        { o: '69700.00', h: '69900.00', l: '69600.00', c: '69850.00', v: '98.76', t: 1710854400000 },
      ],
    }

    it('parses candlestick data correctly', async () => {
      mockAxios.get.mockResolvedValueOnce({ data: rawCandles })
      const candles: CryptoComCandle[] = await client.getCandlesticks('BTC', '1h')

      expect(candles).toHaveLength(2)
      expect(candles[0].open).toBe(69500.00)
      expect(candles[0].high).toBe(69800.00)
      expect(candles[0].low).toBe(69400.00)
      expect(candles[0].close).toBe(69700.00)
      expect(candles[0].volume).toBeCloseTo(123.45)
      expect(candles[0].timestamp).toBe(1710850800000)
    })

    it('passes timeframe parameter', async () => {
      mockAxios.get.mockResolvedValueOnce({ data: rawCandles })
      await client.getCandlesticks('SOL', '15m')

      expect(mockAxios.get).toHaveBeenCalledWith(
        '/get-candlestick',
        expect.objectContaining({
          params: { instrument_name: 'SOL_USDT', timeframe: '15m' },
        }),
      )
    })
  })

  // ─── getTrades ─────────────────────────────────────────────

  describe('getTrades', () => {
    const rawTrades = {
      data: [
        { instrument_name: 'BTC_USDT', price: '69789.99', qty: '0.00191', side: 'sell', timestamp: '2026-03-19T15:17:06Z' },
        { instrument_name: 'BTC_USDT', price: '69790.50', qty: '0.04000', side: 'buy', timestamp: '2026-03-19T15:17:07Z' },
      ],
    }

    it('parses trade data correctly', async () => {
      mockAxios.get.mockResolvedValueOnce({ data: rawTrades })
      const trades: CryptoComTrade[] = await client.getTrades('BTC', 5)

      expect(trades).toHaveLength(2)
      expect(trades[0].price).toBe(69789.99)
      expect(trades[0].qty).toBeCloseTo(0.00191)
      expect(trades[0].side).toBe('sell')
      expect(trades[1].side).toBe('buy')
      expect(typeof trades[0].timestamp).toBe('number')
    })

    it('passes count parameter', async () => {
      mockAxios.get.mockResolvedValueOnce({ data: rawTrades })
      await client.getTrades('XRP', 50)

      expect(mockAxios.get).toHaveBeenCalledWith(
        '/get-trades',
        expect.objectContaining({
          params: { instrument_name: 'XRP_USDT', count: 50 },
        }),
      )
    })
  })

  // ─── getPrice (convenience) ────────────────────────────────

  describe('getPrice', () => {
    it('returns mid-price from bid/ask', async () => {
      mockAxios.get.mockResolvedValueOnce({
        data: {
          best_bid: '69694.00',
          best_ask: '69696.00',
          best_bid_size: '1',
          best_ask_size: '1',
          change: '0',
          high: '70000',
          instrument_name: 'BTC_USDT',
          last: '69695',
          low: '69000',
          timestamp: '2026-03-19T15:15:03.442Z',
          volume: '100',
          volume_value: '6969400',
        },
      })

      const price = await client.getPrice('BTC')
      expect(price).toBe(69695.00) // (69694 + 69696) / 2
    })
  })

  // ─── Symbol mapping ────────────────────────────────────────

  describe('symbol mapping', () => {
    it('maps all supported symbols', async () => {
      const dummyTicker = {
        best_ask: '100', best_ask_size: '1', best_bid: '99', best_bid_size: '1',
        change: '0', high: '101', instrument_name: '', last: '100', low: '98',
        timestamp: '2026-03-19T00:00:00Z', volume: '1000', volume_value: '100000',
      }

      for (const [symbol, instrument] of [['BTC', 'BTC_USDT'], ['ETH', 'ETH_USDT'], ['SOL', 'SOL_USDT'], ['XRP', 'XRP_USDT']]) {
        mockAxios.get.mockResolvedValueOnce({ data: { ...dummyTicker, instrument_name: instrument } })
        await client.getTicker(symbol)
        expect(mockAxios.get).toHaveBeenLastCalledWith(
          '/get-ticker',
          expect.objectContaining({ params: { instrument_name: instrument } }),
        )
      }
    })
  })
})
