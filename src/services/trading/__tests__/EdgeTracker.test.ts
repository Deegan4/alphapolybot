import { describe, it, expect, beforeEach } from 'vitest'
import { EdgeTracker } from '../EdgeTracker'
import { TradeLogger, type TradeRecord } from '../TradeLogger'

/**
 * Helper: insert a closed trade record directly into a TradeLogger.
 * Bypasses logEntry/logExit for test simplicity.
 */
function insertClosedTrade(
  logger: TradeLogger,
  strategy: TradeRecord['strategy'],
  pnlUSD: number,
  overrides?: Partial<TradeRecord>,
): void {
  const id = logger.logEntry({
    marketId: overrides?.marketId ?? 'market-1',
    conditionId: 'cond-1',
    question: 'Test?',
    outcomes: ['Yes', 'No'],
    strategy,
    side: 'BUY',
    outcome: 'Yes',
    marketPrice: 0.5,
    kellyFraction: 0.1,
    kellyBetSize: 10,
    actualBetSize: 10,
    orderType: 'FOK',
    success: true,
    ...overrides,
  })
  logger.logExit(id, {
    exitPrice: pnlUSD > 0 ? 0.6 : 0.4,
    exitReason: 'take-profit',
    pnlUSD,
    pnlPercent: pnlUSD / 10,
  })
}

describe('EdgeTracker', () => {
  let logger: TradeLogger
  let tracker: EdgeTracker

  beforeEach(() => {
    // Fresh instances per test — no singleton pollution
    logger = new TradeLogger()
    tracker = new EdgeTracker()
    // Monkey-patch: make tracker read from our test logger
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(tracker as any).getClosedTrades = (strategy: string) =>
      logger.getRecords().filter(r => r.strategy === strategy && r.exitTimestamp != null)
    // Also patch getAllEdges to use our logger
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(tracker as any).getAllEdgesLogger = logger
    const origGetAllEdges = tracker.getAllEdges.bind(tracker)
    tracker.getAllEdges = () => {
      const allRecords = logger.getRecords()
      const strategies = new Set(allRecords.filter(r => r.exitTimestamp).map(r => r.strategy))
      const result: Record<string, ReturnType<EdgeTracker['getStrategyEdge']>> = {}
      for (const strat of strategies) {
        result[strat] = tracker.getStrategyEdge(strat)
      }
      return result
    }
    void origGetAllEdges // suppress unused
  })

  // ── getStrategyEdge() ────────────────────────────────────────

  describe('getStrategyEdge()', () => {
    it('returns zero edge for strategy with no trades', () => {
      const edge = tracker.getStrategyEdge('llm')
      expect(edge.winRate).toBe(0)
      expect(edge.sampleSize).toBe(0)
      expect(edge.isReliable).toBe(false)
      expect(edge.avgPnlUSD).toBe(0)
      expect(edge.totalPnlUSD).toBe(0)
    })

    it('computes win rate from closed trades only', () => {
      // 3 winning trades
      insertClosedTrade(logger, 'llm', 5)
      insertClosedTrade(logger, 'llm', 3)
      insertClosedTrade(logger, 'llm', 7)
      // 1 open trade (no exit) — should NOT count
      logger.logEntry({
        marketId: 'market-open',
        conditionId: 'cond-1',
        question: 'Open?',
        outcomes: ['Yes', 'No'],
        strategy: 'llm',
        side: 'BUY',
        outcome: 'Yes',
        marketPrice: 0.5,
        kellyFraction: 0.1,
        kellyBetSize: 10,
        actualBetSize: 10,
        orderType: 'FOK',
        success: true,
      })

      const edge = tracker.getStrategyEdge('llm')
      expect(edge.sampleSize).toBe(3)
      expect(edge.winRate).toBe(1.0) // 3/3 winners
    })

    it('counts wins and losses correctly', () => {
      insertClosedTrade(logger, 'btc', 10)   // win
      insertClosedTrade(logger, 'btc', -5)   // loss
      insertClosedTrade(logger, 'btc', 3)    // win
      insertClosedTrade(logger, 'btc', -2)   // loss
      insertClosedTrade(logger, 'btc', -1)   // loss

      const edge = tracker.getStrategyEdge('btc')
      expect(edge.sampleSize).toBe(5)
      expect(edge.winRate).toBeCloseTo(0.4, 6) // 2/5
      expect(edge.totalPnlUSD).toBe(5) // 10 - 5 + 3 - 2 - 1
      expect(edge.avgPnlUSD).toBe(1)   // 5/5
    })

    it('isReliable = false below 20 trades', () => {
      for (let i = 0; i < 19; i++) {
        insertClosedTrade(logger, 'micro', i % 2 === 0 ? 5 : -3)
      }
      expect(tracker.getStrategyEdge('micro').isReliable).toBe(false)
    })

    it('isReliable = true at exactly 20 trades', () => {
      for (let i = 0; i < 20; i++) {
        insertClosedTrade(logger, 'micro', i % 2 === 0 ? 5 : -3)
      }
      expect(tracker.getStrategyEdge('micro').isReliable).toBe(true)
    })

    it('separates strategies — llm trades do not pollute btc stats', () => {
      insertClosedTrade(logger, 'llm', 10)
      insertClosedTrade(logger, 'llm', 10)
      insertClosedTrade(logger, 'btc', -5)

      expect(tracker.getStrategyEdge('llm').sampleSize).toBe(2)
      expect(tracker.getStrategyEdge('llm').winRate).toBe(1.0)
      expect(tracker.getStrategyEdge('btc').sampleSize).toBe(1)
      expect(tracker.getStrategyEdge('btc').winRate).toBe(0)
    })

    it('handles zero P&L as a loss (not > 0)', () => {
      insertClosedTrade(logger, 'dip', 0) // breakeven = loss by our definition
      const edge = tracker.getStrategyEdge('dip')
      expect(edge.winRate).toBe(0) // 0 is not > 0
    })
  })

  // ── getAdaptiveModelProb() ───────────────────────────────────

  describe('getAdaptiveModelProb()', () => {
    it('returns baseProb unchanged when no trades exist', () => {
      expect(tracker.getAdaptiveModelProb('llm', 0.65)).toBe(0.65)
    })

    it('returns baseProb unchanged when sample is very small (1 trade)', () => {
      insertClosedTrade(logger, 'llm', 5)
      // weight = min(1, 1/40) = 0.025
      // result = 0.025 * 1.0 + 0.975 * 0.65 = 0.025 + 0.63375 = 0.65875
      const result = tracker.getAdaptiveModelProb('llm', 0.65)
      // With 1 sample, weight is very low — result is very close to base
      expect(result).toBeCloseTo(0.65875, 3)
    })

    it('blends 50/50 at MIN_RELIABLE (20 trades)', () => {
      // 20 trades, all winners → learned winRate = 1.0
      for (let i = 0; i < 20; i++) {
        insertClosedTrade(logger, 'llm', 5)
      }
      // weight = min(1, 20/40) = 0.5
      // result = 0.5 * 1.0 + 0.5 * 0.60 = 0.80
      expect(tracker.getAdaptiveModelProb('llm', 0.60)).toBeCloseTo(0.80, 6)
    })

    it('fully uses learned rate at 40+ trades', () => {
      // 40 trades: 30 wins, 10 losses → learned winRate = 0.75
      for (let i = 0; i < 30; i++) insertClosedTrade(logger, 'btc', 5)
      for (let i = 0; i < 10; i++) insertClosedTrade(logger, 'btc', -3)
      // weight = min(1, 40/40) = 1.0
      // result = 1.0 * 0.75 + 0.0 * baseProb = 0.75
      expect(tracker.getAdaptiveModelProb('btc', 0.55)).toBeCloseTo(0.75, 6)
    })

    it('caps weight at 1.0 even with 100 trades', () => {
      for (let i = 0; i < 60; i++) insertClosedTrade(logger, 'micro', 2)
      for (let i = 0; i < 40; i++) insertClosedTrade(logger, 'micro', -1)
      // weight = min(1, 100/40) = 1.0
      // learned = 60/100 = 0.6
      expect(tracker.getAdaptiveModelProb('micro', 0.9)).toBeCloseTo(0.6, 6)
    })

    it('gracefully handles losing strategy (winRate < 50%)', () => {
      // 5 wins, 15 losses → winRate = 0.25
      for (let i = 0; i < 5; i++) insertClosedTrade(logger, 'llm', 3)
      for (let i = 0; i < 15; i++) insertClosedTrade(logger, 'llm', -2)
      // weight = min(1, 20/40) = 0.5
      // result = 0.5 * 0.25 + 0.5 * 0.70 = 0.125 + 0.35 = 0.475
      expect(tracker.getAdaptiveModelProb('llm', 0.70)).toBeCloseTo(0.475, 3)
    })
  })

  // ── shouldTrade() ────────────────────────────────────────────

  describe('shouldTrade()', () => {
    it('allows trading when sample is too small (benefit of the doubt)', () => {
      insertClosedTrade(logger, 'llm', -5)
      insertClosedTrade(logger, 'llm', -5)
      // Only 2 trades, not reliable
      const result = tracker.shouldTrade('llm', 200)
      expect(result.allowed).toBe(true)
      expect(result.reason).toBeUndefined()
    })

    it('allows trading when win rate exceeds fee threshold', () => {
      // 15 wins, 5 losses → winRate = 0.75
      // Edge after 200bps fees: (2*0.75 - 1) - 0.02 = 0.48 > 0 ✓
      for (let i = 0; i < 15; i++) insertClosedTrade(logger, 'btc', 5)
      for (let i = 0; i < 5; i++) insertClosedTrade(logger, 'btc', -3)

      expect(tracker.shouldTrade('btc', 200).allowed).toBe(true)
    })

    it('blocks trading when win rate produces negative Kelly', () => {
      // 8 wins, 12 losses → winRate = 0.40
      // Edge after 200bps fees: (2*0.40 - 1) - 0.02 = -0.22 < 0 ✗
      for (let i = 0; i < 8; i++) insertClosedTrade(logger, 'llm', 3)
      for (let i = 0; i < 12; i++) insertClosedTrade(logger, 'llm', -2)

      const result = tracker.shouldTrade('llm', 200)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('blocked')
      expect(result.reason).toContain('negative Kelly')
    })

    it('blocks at exactly 50% win rate with any positive fees', () => {
      // 10 wins, 10 losses → winRate = 0.50
      // Edge after 100bps: (2*0.5 - 1) - 0.01 = -0.01 < 0
      for (let i = 0; i < 10; i++) insertClosedTrade(logger, 'dip', 5)
      for (let i = 0; i < 10; i++) insertClosedTrade(logger, 'dip', -5)

      expect(tracker.shouldTrade('dip', 100).allowed).toBe(false)
    })

    it('allows at 50% win rate with zero fees', () => {
      for (let i = 0; i < 10; i++) insertClosedTrade(logger, 'dip', 5)
      for (let i = 0; i < 10; i++) insertClosedTrade(logger, 'dip', -5)
      // Edge = (2*0.5 - 1) - 0 = 0 — NOT negative, so allowed
      expect(tracker.shouldTrade('dip', 0).allowed).toBe(true)
    })

    it('accounts for high fees on 15-min crypto markets (1000bps)', () => {
      // winRate = 0.60, feeRate = 10%
      // Edge: (2*0.60 - 1) - 0.10 = 0.10 > 0 ✓
      for (let i = 0; i < 12; i++) insertClosedTrade(logger, 'btc', 5)
      for (let i = 0; i < 8; i++) insertClosedTrade(logger, 'btc', -3)

      expect(tracker.shouldTrade('btc', 1000).allowed).toBe(true)
    })

    it('blocks even good win rate if fees are too high', () => {
      // winRate = 0.55, feeRate = 15% (1500bps)
      // Edge: (2*0.55 - 1) - 0.15 = -0.05 < 0 ✗
      for (let i = 0; i < 11; i++) insertClosedTrade(logger, 'micro', 2)
      for (let i = 0; i < 9; i++) insertClosedTrade(logger, 'micro', -2)

      expect(tracker.shouldTrade('micro', 1500).allowed).toBe(false)
    })

    it('allows trading for strategy with no trades', () => {
      expect(tracker.shouldTrade('fw', 200).allowed).toBe(true)
    })
  })

  // ── getAllEdges() ─────────────────────────────────────────────

  describe('getAllEdges()', () => {
    it('returns empty object when no trades exist', () => {
      expect(tracker.getAllEdges()).toEqual({})
    })

    it('returns edges for all strategies with closed trades', () => {
      insertClosedTrade(logger, 'llm', 5)
      insertClosedTrade(logger, 'btc', -3)
      insertClosedTrade(logger, 'micro', 2)

      const edges = tracker.getAllEdges()
      expect(Object.keys(edges).sort()).toEqual(['btc', 'llm', 'micro'])
      expect(edges['llm'].winRate).toBe(1.0)
      expect(edges['btc'].winRate).toBe(0)
      expect(edges['micro'].winRate).toBe(1.0)
    })

    it('does not include strategies with only open (unclosed) trades', () => {
      // Open trade for 'fw'
      logger.logEntry({
        marketId: 'market-fw',
        conditionId: 'cond-1',
        question: 'FW?',
        outcomes: ['Yes', 'No'],
        strategy: 'fw',
        side: 'BUY',
        outcome: 'Yes',
        marketPrice: 0.5,
        kellyFraction: 0.1,
        kellyBetSize: 10,
        actualBetSize: 10,
        orderType: 'FOK',
        success: true,
      })
      // Closed trade for 'llm'
      insertClosedTrade(logger, 'llm', 5)

      const edges = tracker.getAllEdges()
      expect(Object.keys(edges)).toEqual(['llm'])
    })
  })
})
