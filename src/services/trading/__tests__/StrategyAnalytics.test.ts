import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRecords } = vi.hoisted(() => ({
  mockRecords: vi.fn().mockReturnValue([]),
}))

vi.mock('../TradeLogger', () => ({
  tradeLogger: {
    getRecords: mockRecords,
  },
}))

// Mock EdgeTracker
vi.mock('../EdgeTracker', () => ({
  edgeTracker: {
    getStrategyEdge: vi.fn().mockReturnValue({
      winRate: 0.55,
      sampleSize: 30,
      isReliable: true,
      avgPnlUSD: 0.5,
      totalPnlUSD: 15,
    }),
    detectEdgeDecay: vi.fn().mockReturnValue({
      isDecaying: false,
      historicalWinRate: 0.55,
      recentWinRate: 0.53,
      sampleSize: 30,
      decayMagnitude: 0.02,
    }),
  },
}))

import { StrategyAnalytics } from '../StrategyAnalytics'
import type { TradeRecord } from '../TradeLogger'

function makeRecord(overrides: Partial<TradeRecord>): TradeRecord {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now() - 60_000,
    marketId: 'test-market',
    conditionId: 'cond-1',
    question: 'Test?',
    outcomes: ['Yes', 'No'],
    strategy: 'btc',
    side: 'BUY',
    outcome: 'Yes',
    marketPrice: 0.40,
    kellyFraction: 0.1,
    kellyBetSize: 5,
    actualBetSize: 5,
    orderType: 'FOK',
    success: true,
    ...overrides,
  } as TradeRecord
}

describe('StrategyAnalytics', () => {
  let analytics: StrategyAnalytics

  beforeEach(() => {
    vi.clearAllMocks()
    analytics = new StrategyAnalytics()
  })

  it('returns zero metrics when no trades exist', () => {
    mockRecords.mockReturnValue([])
    const metrics = analytics.getStrategyMetrics('btc')

    expect(metrics.totalTrades).toBe(0)
    expect(metrics.winRate).toBe(0)
    expect(metrics.profitFactor).toBe(0)
    expect(metrics.expectancyUSD).toBe(0)
    expect(metrics.sortinoRatio).toBeNull()
  })

  it('computes win rate and P&L correctly', () => {
    const now = Date.now()
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 2.0, exitTimestamp: now - 3000 }),
      makeRecord({ strategy: 'btc', pnlUSD: 3.0, exitTimestamp: now - 2000 }),
      makeRecord({ strategy: 'btc', pnlUSD: -1.5, exitTimestamp: now - 1000 }),
    ])

    const metrics = analytics.getStrategyMetrics('btc')

    expect(metrics.totalTrades).toBe(3)
    expect(metrics.wins).toBe(2)
    expect(metrics.losses).toBe(1)
    expect(metrics.winRate).toBeCloseTo(0.667, 2)
    expect(metrics.totalPnlUSD).toBeCloseTo(3.5)
    expect(metrics.avgWinUSD).toBeCloseTo(2.5)
    expect(metrics.avgLossUSD).toBeCloseTo(1.5)
  })

  it('computes profit factor (gross wins / gross losses)', () => {
    const now = Date.now()
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 10.0, exitTimestamp: now - 2000 }),
      makeRecord({ strategy: 'btc', pnlUSD: -5.0, exitTimestamp: now - 1000 }),
    ])

    const metrics = analytics.getStrategyMetrics('btc')
    expect(metrics.profitFactor).toBeCloseTo(2.0)
  })

  it('profit factor is Infinity when no losses', () => {
    const now = Date.now()
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 5.0, exitTimestamp: now }),
    ])

    const metrics = analytics.getStrategyMetrics('btc')
    expect(metrics.profitFactor).toBe(Infinity)
  })

  it('computes expectancy correctly', () => {
    const now = Date.now()
    // 2 wins at $3 avg, 1 loss at $2 → expectancy = 3*(2/3) - 2*(1/3) = 2 - 0.667 = 1.333
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 3.0, exitTimestamp: now - 3000 }),
      makeRecord({ strategy: 'btc', pnlUSD: 3.0, exitTimestamp: now - 2000 }),
      makeRecord({ strategy: 'btc', pnlUSD: -2.0, exitTimestamp: now - 1000 }),
    ])

    const metrics = analytics.getStrategyMetrics('btc')
    expect(metrics.expectancyUSD).toBeCloseTo(1.333, 2)
  })

  it('computes best/worst trade', () => {
    const now = Date.now()
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 5.0, exitTimestamp: now - 3000 }),
      makeRecord({ strategy: 'btc', pnlUSD: -3.0, exitTimestamp: now - 2000 }),
      makeRecord({ strategy: 'btc', pnlUSD: 1.0, exitTimestamp: now - 1000 }),
    ])

    const metrics = analytics.getStrategyMetrics('btc')
    expect(metrics.bestTradeUSD).toBe(5.0)
    expect(metrics.worstTradeUSD).toBe(-3.0)
  })

  it('computes max drawdown', () => {
    const now = Date.now()
    // Equity: 0 → 5 → 3 → 6 → 1 → max dd from peak 6 to 1 = 83.3%
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 5.0, exitTimestamp: now - 5000 }),
      makeRecord({ strategy: 'btc', pnlUSD: -2.0, exitTimestamp: now - 4000 }),
      makeRecord({ strategy: 'btc', pnlUSD: 3.0, exitTimestamp: now - 3000 }),
      makeRecord({ strategy: 'btc', pnlUSD: -5.0, exitTimestamp: now - 2000 }),
    ])

    const metrics = analytics.getStrategyMetrics('btc')
    expect(metrics.maxDrawdownPercent).toBeGreaterThan(0.5)
  })

  it('tracks open trades separately', () => {
    const now = Date.now()
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 2.0, exitTimestamp: now, success: true }),
      makeRecord({ strategy: 'btc', success: true }), // No exitTimestamp = open
    ])

    const metrics = analytics.getStrategyMetrics('btc')
    expect(metrics.totalTrades).toBe(1) // closed only
    expect(metrics.openTrades).toBe(1)
  })

  it('filters by strategy', () => {
    const now = Date.now()
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 5.0, exitTimestamp: now }),
      makeRecord({ strategy: 'llm', pnlUSD: -2.0, exitTimestamp: now }),
      makeRecord({ strategy: 'btc', pnlUSD: 3.0, exitTimestamp: now }),
    ])

    const btc = analytics.getStrategyMetrics('btc')
    expect(btc.totalTrades).toBe(2)
    expect(btc.totalPnlUSD).toBeCloseTo(8.0)

    const llm = analytics.getStrategyMetrics('llm')
    expect(llm.totalTrades).toBe(1)
    expect(llm.totalPnlUSD).toBeCloseTo(-2.0)
  })

  it('portfolio summary aggregates all strategies', () => {
    const now = Date.now()
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 5.0, exitTimestamp: now }),
      makeRecord({ strategy: 'llm', pnlUSD: -2.0, exitTimestamp: now }),
    ])

    const summary = analytics.getPortfolioSummary()
    expect(summary.totalTrades).toBe(2)
    expect(summary.totalPnlUSD).toBeCloseTo(3.0)
    expect(summary.bestStrategy).toBe('btc')
    expect(summary.worstStrategy).toBe('llm')
    expect(summary.strategies.length).toBe(2)
  })

  it('correlation matrix returns 1.0 for self-correlation', () => {
    const now = Date.now()
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 1.0, exitTimestamp: now - 86400000 }),
      makeRecord({ strategy: 'btc', pnlUSD: 2.0, exitTimestamp: now }),
    ])

    const summary = analytics.getPortfolioSummary()
    if (summary.correlationMatrix['btc']) {
      expect(summary.correlationMatrix['btc']['btc']).toBe(1.0)
    }
  })

  it('includes edge tracker data in metrics', () => {
    mockRecords.mockReturnValue([
      makeRecord({ strategy: 'btc', pnlUSD: 1.0, exitTimestamp: Date.now() }),
    ])

    const metrics = analytics.getStrategyMetrics('btc')
    expect(metrics.edge.winRate).toBe(0.55)
    expect(metrics.edge.isReliable).toBe(true)
    expect(metrics.edgeDecay.isDecaying).toBe(false)
  })

  it('computes Sortino ratio with sufficient data', () => {
    const now = Date.now()
    const records = []
    // 15 trades: 10 wins at $2, 5 losses at $-1
    for (let i = 0; i < 10; i++) {
      records.push(makeRecord({ strategy: 'btc', pnlUSD: 2.0, exitTimestamp: now - (15 - i) * 1000 }))
    }
    for (let i = 0; i < 5; i++) {
      records.push(makeRecord({ strategy: 'btc', pnlUSD: -1.0, exitTimestamp: now - (5 - i) * 1000 }))
    }
    mockRecords.mockReturnValue(records)

    const metrics = analytics.getStrategyMetrics('btc')
    expect(metrics.sortinoRatio).not.toBeNull()
    expect(metrics.sortinoRatio!).toBeGreaterThan(0)
    expect(metrics.sharpeRatio).not.toBeNull()
    // Sortino should be higher than Sharpe since we have asymmetric returns
    expect(metrics.sortinoRatio!).toBeGreaterThan(metrics.sharpeRatio!)
  })
})
