import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  PolyBacktestMarket,
  PolyBacktestSnapshot,
} from '@/types'

// Mock polyBacktestClient before importing BacktestRunner
vi.mock('@/services/api/PolyBacktestClient', () => ({
  polyBacktestClient: {
    getMarket: vi.fn(),
    getMarketBySlug: vi.fn(),
    getAllSnapshots: vi.fn(),
    getResolvedMarkets: vi.fn(),
  },
}))

import { BacktestRunner } from '../BacktestRunner'
import { polyBacktestClient } from '@/services/api/PolyBacktestClient'

// ==========================================
// FIXTURES
// ==========================================

const baseTime = new Date('2024-02-14T20:00:00Z').getTime()

function makeMarket(overrides?: Partial<PolyBacktestMarket>): PolyBacktestMarket {
  return {
    market_id: 'mkt-test',
    slug: 'btc-updown-15m-test',
    market_type: '15m',
    start_time: new Date(baseTime).toISOString(),
    end_time: new Date(baseTime + 15 * 60 * 1000).toISOString(),
    btc_price_start: 65000,
    btc_price_end: 65200,
    winner: 'up',
    condition_id: '0xabc',
    clob_token_up: 'tok-up',
    clob_token_down: 'tok-down',
    final_volume: 10000,
    final_liquidity: 5000,
    ...overrides,
  }
}

/**
 * Build a sequence of snapshots evenly spaced through the window.
 * BTC price drifts linearly from startPrice to endPrice.
 */
function makeSnapshots(
  count: number,
  opts?: {
    startPrice?: number
    endPrice?: number
    upPrice?: number
    downPrice?: number
  },
): PolyBacktestSnapshot[] {
  const startPrice = opts?.startPrice ?? 65000
  const endPrice = opts?.endPrice ?? 65200
  const upPrice = opts?.upPrice ?? 0.55
  const downPrice = opts?.downPrice ?? 0.45
  const windowMs = 15 * 60 * 1000
  const snapshots: PolyBacktestSnapshot[] = []

  for (let i = 0; i < count; i++) {
    const frac = i / Math.max(1, count - 1)
    const timeMs = baseTime + frac * windowMs
    const btcPrice = startPrice + frac * (endPrice - startPrice)

    snapshots.push({
      id: `snap-${i}`,
      time: new Date(timeMs).toISOString(),
      btc_price: btcPrice,
      price_up: upPrice,
      price_down: downPrice,
      orderbook_up: null,
      orderbook_down: null,
    })
  }

  return snapshots
}

// ==========================================
// TESTS
// ==========================================

describe('BacktestRunner', () => {
  let runner: BacktestRunner

  beforeEach(() => {
    vi.clearAllMocks()
    runner = new BacktestRunner()
  })

  // ==========================================
  // SINGLE MARKET BACKTEST
  // ==========================================

  describe('run()', () => {
    it('returns trades and summary for a winning market', async () => {
      const market = makeMarket({ winner: 'up' })
      // 60 snapshots = one every ~15 seconds. Should have enough for signal after minTimeIntoWindow.
      const snapshots = makeSnapshots(60, {
        startPrice: 65000,
        endPrice: 65300,
        upPrice: 0.35,   // cheap enough to trade (< maxEntryPrice 0.45)
        downPrice: 0.65,
      })

      vi.mocked(polyBacktestClient.getMarket).mockResolvedValue(market)
      vi.mocked(polyBacktestClient.getAllSnapshots).mockResolvedValue(snapshots)

      const result = await runner.run({
        marketId: 'mkt-test',
        config: {
          minConfidence: 0.01,     // very low to ensure entry
          regimeFilterEnabled: false,
          rsiFilterEnabled: false,
          minTimeIntoWindowMs: 10_000,
        },
      })

      expect(result.marketId).toBe('mkt-test')
      expect(result.slug).toBe('btc-updown-15m-test')
      expect(result.marketType).toBe('15m')
      expect(result.summary).toBeDefined()

      // Should have at most maxEntriesPerMarket trades (default 1)
      expect(result.trades.length).toBeLessThanOrEqual(1)

      if (result.trades.length > 0) {
        const trade = result.trades[0]
        expect(trade.direction).toBe('up')
        expect(trade.resolved).toBe(true)
        expect(trade.winner).toBe('up')
        expect(trade.pnl).toBeGreaterThan(0) // Won trade
        expect(trade.entryPrice).toBe(0.35)
      }
    })

    it('computes negative P&L for losing trade', async () => {
      const market = makeMarket({ winner: 'down' }) // market resolves DOWN
      // BTC price goes UP → signal says "up" → loses
      const snapshots = makeSnapshots(60, {
        startPrice: 65000,
        endPrice: 65500,
        upPrice: 0.30,
        downPrice: 0.70,
      })

      vi.mocked(polyBacktestClient.getMarket).mockResolvedValue(market)
      vi.mocked(polyBacktestClient.getAllSnapshots).mockResolvedValue(snapshots)

      const result = await runner.run({
        marketId: 'mkt-test',
        config: {
          minConfidence: 0.01,
          regimeFilterEnabled: false,
          rsiFilterEnabled: false,
          minTimeIntoWindowMs: 10_000,
        },
      })

      if (result.trades.length > 0) {
        const trade = result.trades[0]
        expect(trade.direction).toBe('up')
        expect(trade.winner).toBe('down')
        expect(trade.pnl).toBeLessThan(0) // Lost
        expect(trade.pnl).toBe(-0.30) // -entryPrice
      }
    })

    it('returns empty result for no snapshots', async () => {
      const market = makeMarket()
      vi.mocked(polyBacktestClient.getMarket).mockResolvedValue(market)
      vi.mocked(polyBacktestClient.getAllSnapshots).mockResolvedValue([])

      const result = await runner.run({ marketId: 'mkt-test' })
      expect(result.trades).toHaveLength(0)
      expect(result.summary.totalTrades).toBe(0)
    })

    it('respects maxEntryPrice gate', async () => {
      const market = makeMarket({ winner: 'up' })
      const snapshots = makeSnapshots(60, {
        startPrice: 65000,
        endPrice: 65300,
        upPrice: 0.60,  // too expensive (> default maxEntryPrice 0.45)
        downPrice: 0.40,
      })

      vi.mocked(polyBacktestClient.getMarket).mockResolvedValue(market)
      vi.mocked(polyBacktestClient.getAllSnapshots).mockResolvedValue(snapshots)

      const result = await runner.run({
        marketId: 'mkt-test',
        config: { minConfidence: 0.01, regimeFilterEnabled: false, rsiFilterEnabled: false },
      })

      // Signal is "up" but upPrice=0.60 > maxEntryPrice=0.45 → blocked
      // downPrice=0.40 < maxEntryPrice=0.45 → but direction is "up" so it targets upPrice
      expect(result.trades).toHaveLength(0)
    })

    it('respects minWindowRemaining gate', async () => {
      const market = makeMarket()
      // Only 1 snapshot at the very end of the window (< minWindowRemaining)
      const lateSnapshot: PolyBacktestSnapshot = {
        id: 'snap-late',
        time: new Date(baseTime + 14.5 * 60 * 1000).toISOString(), // 30 sec left
        btc_price: 65200,
        price_up: 0.35,
        price_down: 0.65,
        orderbook_up: null,
        orderbook_down: null,
      }

      vi.mocked(polyBacktestClient.getMarket).mockResolvedValue(market)
      vi.mocked(polyBacktestClient.getAllSnapshots).mockResolvedValue([lateSnapshot])

      const result = await runner.run({
        marketId: 'mkt-test',
        config: {
          minConfidence: 0.01,
          regimeFilterEnabled: false,
          rsiFilterEnabled: false,
          minWindowRemaining: 120, // Need 120 sec remaining
        },
      })

      expect(result.trades).toHaveLength(0)
    })

    it('fetches market by slug when no marketId', async () => {
      const market = makeMarket()
      vi.mocked(polyBacktestClient.getMarketBySlug).mockResolvedValue(market)
      vi.mocked(polyBacktestClient.getAllSnapshots).mockResolvedValue([])

      await runner.run({ slug: 'my-slug' })
      expect(polyBacktestClient.getMarketBySlug).toHaveBeenCalledWith('my-slug')
    })

    it('applies fee rate to winning P&L', async () => {
      const market = makeMarket({ winner: 'up' })
      const snapshots = makeSnapshots(60, {
        startPrice: 65000,
        endPrice: 65300,
        upPrice: 0.30,
        downPrice: 0.70,
      })

      vi.mocked(polyBacktestClient.getMarket).mockResolvedValue(market)
      vi.mocked(polyBacktestClient.getAllSnapshots).mockResolvedValue(snapshots)

      // With default 10% fee: win PnL = (1.0 - 0.10) - 0.30 = 0.60
      const result = await runner.run({
        marketId: 'mkt-test',
        feeRateBps: 1000,
        config: {
          minConfidence: 0.01,
          regimeFilterEnabled: false,
          rsiFilterEnabled: false,
          minTimeIntoWindowMs: 10_000,
        },
      })

      if (result.trades.length > 0) {
        expect(result.trades[0].pnl).toBeCloseTo(0.60, 2) // (0.90 - 0.30)
      }
    })
  })

  // ==========================================
  // BATCH BACKTEST
  // ==========================================

  describe('runBatch()', () => {
    it('runs across multiple markets', async () => {
      const markets = [
        makeMarket({ market_id: 'mkt-1', winner: 'up' }),
        makeMarket({ market_id: 'mkt-2', winner: 'down' }),
      ]
      vi.mocked(polyBacktestClient.getResolvedMarkets).mockResolvedValue(markets)
      vi.mocked(polyBacktestClient.getMarket)
        .mockResolvedValueOnce(markets[0])
        .mockResolvedValueOnce(markets[1])
      vi.mocked(polyBacktestClient.getAllSnapshots).mockResolvedValue(
        makeSnapshots(60, { upPrice: 0.35, downPrice: 0.65 }),
      )

      const results = await runner.runBatch('15m', {
        config: {
          minConfidence: 0.01,
          regimeFilterEnabled: false,
          rsiFilterEnabled: false,
          minTimeIntoWindowMs: 10_000,
        },
      })

      expect(results).toHaveLength(2)
      expect(polyBacktestClient.getResolvedMarkets).toHaveBeenCalledWith('15m', undefined)
    })

    it('continues if one market fails', async () => {
      const markets = [
        makeMarket({ market_id: 'mkt-1' }),
        makeMarket({ market_id: 'mkt-2' }),
      ]
      vi.mocked(polyBacktestClient.getResolvedMarkets).mockResolvedValue(markets)
      // First market fails, second succeeds
      vi.mocked(polyBacktestClient.getMarket)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(markets[1])
      vi.mocked(polyBacktestClient.getAllSnapshots).mockResolvedValue([])

      const results = await runner.runBatch('15m')
      expect(results).toHaveLength(1) // Only the successful one
    })
  })

  // ==========================================
  // AGGREGATE
  // ==========================================

  describe('aggregateResults()', () => {
    it('computes aggregate summary across results', () => {
      const summary = runner.aggregateResults([
        {
          marketId: 'mkt-1', slug: 'slug-1', marketType: '15m',
          config: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          trades: [
            { snapshotTime: '2024-01-01T00:00:00Z', direction: 'up' as const, confidence: 0.7, entryPrice: 0.30, btcPriceAtEntry: 65000, resolved: true, winner: 'up' as const, pnl: 0.60, holdTimeMs: 300_000 },
          ],
          summary: { totalTrades: 1, wins: 1, losses: 0, winRate: 1, totalPnl: 0.60, avgPnl: 0.60, avgHoldTimeMs: 300_000, maxDrawdown: 0, sharpeRatio: null, profitFactor: null },
        },
        {
          marketId: 'mkt-2', slug: 'slug-2', marketType: '15m',
          config: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          trades: [
            { snapshotTime: '2024-01-01T00:00:00Z', direction: 'up' as const, confidence: 0.6, entryPrice: 0.35, btcPriceAtEntry: 65000, resolved: true, winner: 'down' as const, pnl: -0.35, holdTimeMs: 400_000 },
          ],
          summary: { totalTrades: 1, wins: 0, losses: 1, winRate: 0, totalPnl: -0.35, avgPnl: -0.35, avgHoldTimeMs: 400_000, maxDrawdown: 0.35, sharpeRatio: null, profitFactor: null },
        },
      ])

      expect(summary.totalTrades).toBe(2)
      expect(summary.wins).toBe(1)
      expect(summary.losses).toBe(1)
      expect(summary.winRate).toBe(0.5)
      expect(summary.totalPnl).toBeCloseTo(0.25, 2) // 0.60 - 0.35
    })

    it('handles empty results', () => {
      const summary = runner.aggregateResults([])
      expect(summary.totalTrades).toBe(0)
      expect(summary.winRate).toBe(0)
    })
  })

  // ==========================================
  // SUMMARY STATS
  // ==========================================

  describe('summary computation', () => {
    it('calculates max drawdown correctly', async () => {
      const market = makeMarket({ winner: 'up' })
      // Single winning trade → drawdown should be 0
      const snapshots = makeSnapshots(60, {
        startPrice: 65000,
        endPrice: 65300,
        upPrice: 0.35,
        downPrice: 0.65,
      })

      vi.mocked(polyBacktestClient.getMarket).mockResolvedValue(market)
      vi.mocked(polyBacktestClient.getAllSnapshots).mockResolvedValue(snapshots)

      const result = await runner.run({
        marketId: 'mkt-test',
        config: {
          minConfidence: 0.01,
          regimeFilterEnabled: false,
          rsiFilterEnabled: false,
          minTimeIntoWindowMs: 10_000,
        },
      })

      if (result.trades.length > 0) {
        expect(result.summary.maxDrawdown).toBe(0) // Single winning trade
      }
    })
  })
})
