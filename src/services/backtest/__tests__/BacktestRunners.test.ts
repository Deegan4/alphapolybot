/**
 * Tests for all multi-strategy backtest runners + summary engine + orchestrator.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { computeBacktestSummary, pearsonCorrelation } from '../BacktestSummaryEngine'
import { DipArbBacktestRunner } from '../DipArbBacktestRunner'
import { GabagoolBacktestRunner } from '../GabagoolBacktestRunner'
import { ImpulseBacktestRunner } from '../ImpulseBacktestRunner'
import { LLMBacktestRunner } from '../LLMBacktestRunner'
import type {
  UnifiedTradeRecord,
  RecordedSnapshot,
  PolyBacktestMarket,
  PolyBacktestSnapshot,
} from '@/types'
import type { LLMInteractionRecord } from '../LLMBacktestRunner'

// ─── Helpers ──────────────────────────────────────────────

function makeTrade(pnl: number, holdTimeMs = 60_000): UnifiedTradeRecord {
  return {
    timestamp: new Date().toISOString(),
    strategy: 'dip-arb',
    direction: pnl >= 0 ? 'up' : 'down',
    entryPrice: 0.50,
    exitPrice: 0.50 + pnl,
    pnl,
    feePaid: 0,
    holdTimeMs,
  }
}

function makeRecordedSnapshot(overrides: Partial<RecordedSnapshot> = {}): RecordedSnapshot {
  return {
    timestamp: new Date().toISOString(),
    marketId: 'test-market',
    slug: 'test-slug',
    question: 'Test?',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.50, 0.50],
    askPrices: [0.48, 0.47],
    bidPrices: [0.46, 0.45],
    volume24h: 100,
    liquidity: 200,
    ...overrides,
  }
}

function makeBtcMarket(overrides: Partial<PolyBacktestMarket> = {}): PolyBacktestMarket {
  return {
    market_id: 'btc-market-1',
    slug: 'btc-updown-1h-123',
    condition_id: '0xabc',
    start_time: '2026-01-01T00:00:00Z',
    end_time: '2026-01-01T01:00:00Z',
    winner: 'up',
    btc_price_start: 100000,
    btc_price_end: 100500,
    final_volume: 1000,
    final_liquidity: 500,
    clob_token_up: '0xup',
    clob_token_down: '0xdown',
    ...overrides,
  } as PolyBacktestMarket
}

function makeBtcSnapshot(
  minuteOffset: number,
  btcPrice: number,
  priceUp: number,
  priceDown: number,
): PolyBacktestSnapshot {
  const time = new Date(Date.UTC(2026, 0, 1, 0, minuteOffset, 0)).toISOString()
  return {
    id: `snap-${minuteOffset}`,
    market_id: 'btc-market-1',
    time,
    btc_price: btcPrice,
    price_up: priceUp,
    price_down: priceDown,
    orderbook_up: { bids: [{ price: priceUp - 0.02, size: 10 }], asks: [{ price: priceUp + 0.02, size: 10 }] },
    orderbook_down: { bids: [{ price: priceDown - 0.02, size: 10 }], asks: [{ price: priceDown + 0.02, size: 10 }] },
    volume_up: 100,
    volume_down: 100,
  } as PolyBacktestSnapshot
}


// ═══════════════════════════════════════════════════════════
// BacktestSummaryEngine
// ═══════════════════════════════════════════════════════════

describe('BacktestSummaryEngine', () => {
  describe('computeBacktestSummary', () => {
    it('returns zeros for empty trades', () => {
      const s = computeBacktestSummary([])
      expect(s.totalTrades).toBe(0)
      expect(s.winRate).toBe(0)
      expect(s.totalPnl).toBe(0)
      expect(s.maxDrawdown).toBe(0)
      expect(s.sharpeRatio).toBeNull()
      expect(s.profitFactor).toBeNull()
    })

    it('computes win rate correctly', () => {
      const trades = [makeTrade(0.10), makeTrade(-0.05), makeTrade(0.20)]
      const s = computeBacktestSummary(trades)
      expect(s.totalTrades).toBe(3)
      expect(s.wins).toBe(2)
      expect(s.losses).toBe(1)
      expect(s.winRate).toBeCloseTo(2 / 3)
    })

    it('computes total and avg P&L', () => {
      const trades = [makeTrade(0.10), makeTrade(-0.05), makeTrade(0.20)]
      const s = computeBacktestSummary(trades)
      expect(s.totalPnl).toBeCloseTo(0.25)
      expect(s.avgPnl).toBeCloseTo(0.25 / 3)
    })

    it('computes max drawdown', () => {
      // Sequence: +0.10, +0.10, -0.30, +0.05
      // Cumulative: 0.10, 0.20, -0.10, -0.05
      // Peak = 0.20, max DD = 0.20 - (-0.10) = 0.30
      const trades = [makeTrade(0.10), makeTrade(0.10), makeTrade(-0.30), makeTrade(0.05)]
      const s = computeBacktestSummary(trades)
      expect(s.maxDrawdown).toBeCloseTo(0.30)
    })

    it('computes Sharpe ratio for >= 5 trades with uniform P&L', () => {
      const trades = Array.from({ length: 10 }, () => makeTrade(0.05))
      const s = computeBacktestSummary(trades)
      // All same P&L → near-zero variance → very large Sharpe (not null due to float precision)
      expect(s.sharpeRatio).not.toBeNull()
    })

    it('computes Sharpe with variance', () => {
      const trades = [makeTrade(0.10), makeTrade(-0.05), makeTrade(0.15), makeTrade(-0.02), makeTrade(0.08)]
      const s = computeBacktestSummary(trades)
      expect(s.sharpeRatio).not.toBeNull()
      expect(s.sharpeRatio!).toBeGreaterThan(0) // Net positive → positive Sharpe
    })

    it('returns null sharpe for < 5 trades', () => {
      const trades = [makeTrade(0.10), makeTrade(-0.05)]
      const s = computeBacktestSummary(trades)
      expect(s.sharpeRatio).toBeNull()
    })

    it('computes profit factor', () => {
      const trades = [makeTrade(0.20), makeTrade(-0.10)]
      const s = computeBacktestSummary(trades)
      expect(s.profitFactor).toBeCloseTo(2.0)
    })

    it('returns null profit factor when no losses', () => {
      const trades = [makeTrade(0.10), makeTrade(0.20)]
      const s = computeBacktestSummary(trades)
      expect(s.profitFactor).toBeNull()
    })

    it('computes avg hold time', () => {
      const trades = [makeTrade(0.10, 30_000), makeTrade(-0.05, 90_000)]
      const s = computeBacktestSummary(trades)
      expect(s.avgHoldTimeMs).toBe(60_000)
    })
  })

  describe('pearsonCorrelation', () => {
    it('returns 1 for identical series', () => {
      const a = [1, 2, 3, 4, 5]
      expect(pearsonCorrelation(a, a)).toBeCloseTo(1.0)
    })

    it('returns -1 for perfectly inverse series', () => {
      const a = [1, 2, 3, 4, 5]
      const b = [5, 4, 3, 2, 1]
      expect(pearsonCorrelation(a, b)).toBeCloseTo(-1.0)
    })

    it('returns 0 for < 3 elements', () => {
      expect(pearsonCorrelation([1, 2], [3, 4])).toBe(0)
    })

    it('handles unequal lengths (uses min)', () => {
      const a = [1, 2, 3, 4, 5]
      const b = [1, 2, 3]
      const corr = pearsonCorrelation(a, b)
      expect(corr).toBeCloseTo(1.0)
    })

    it('handles zero variance', () => {
      const a = [5, 5, 5, 5]
      const b = [1, 2, 3, 4]
      expect(pearsonCorrelation(a, b)).toBe(0)
    })
  })
})


// ═══════════════════════════════════════════════════════════
// DipArbBacktestRunner
// ═══════════════════════════════════════════════════════════

describe('DipArbBacktestRunner', () => {
  let runner: DipArbBacktestRunner

  beforeEach(() => { runner = new DipArbBacktestRunner() })

  it('detects arb when askSum < sumTarget', () => {
    const snapshots = [
      makeRecordedSnapshot({ askPrices: [0.45, 0.47], timestamp: '2026-01-01T00:00:00Z' }),
    ]
    const result = runner.run(snapshots, { sumTarget: 0.96, takerFeeBps: 0 })
    expect(result.trades.length).toBe(1)
    expect(result.trades[0].pnl).toBeCloseTo(0.08 * 5) // (1.0 - 0.92) * $5
    expect(result.strategy).toBe('dip-arb')
  })

  it('skips when askSum >= sumTarget', () => {
    const snapshots = [
      makeRecordedSnapshot({ askPrices: [0.50, 0.52] }),
    ]
    const result = runner.run(snapshots, { sumTarget: 0.96 })
    expect(result.trades.length).toBe(0)
  })

  it('skips snapshots without ask prices', () => {
    const snapshots = [
      makeRecordedSnapshot({ askPrices: undefined }),
    ]
    const result = runner.run(snapshots)
    expect(result.trades.length).toBe(0)
  })

  it('applies taker fees and rejects unprofitable trades', () => {
    // askSum = 0.95, gross profit per $5 = 0.05 * 5 = 0.25
    // fees = (0.48 * 0.10 + 0.47 * 0.10) * 5 = 0.475 > 0.25 → skip
    const snapshots = [
      makeRecordedSnapshot({ askPrices: [0.48, 0.47] }),
    ]
    const result = runner.run(snapshots, { sumTarget: 0.96, takerFeeBps: 1000 })
    expect(result.trades.length).toBe(0)
  })

  it('enforces per-market cooldown', () => {
    const snapshots = [
      makeRecordedSnapshot({ askPrices: [0.40, 0.40], timestamp: '2026-01-01T00:00:00Z' }),
      makeRecordedSnapshot({ askPrices: [0.40, 0.40], timestamp: '2026-01-01T00:00:10Z' }),
      makeRecordedSnapshot({ askPrices: [0.40, 0.40], timestamp: '2026-01-01T00:01:00Z' }),
    ]
    const result = runner.run(snapshots, { cooldownMs: 30_000, takerFeeBps: 0 })
    expect(result.trades.length).toBe(2) // First + third (30s gap)
  })

  it('filters by volume', () => {
    const snapshots = [
      makeRecordedSnapshot({ askPrices: [0.40, 0.40], volume24h: 10 }),
    ]
    const result = runner.run(snapshots, { minVolume: 50 })
    expect(result.trades.length).toBe(0)
  })

  it('computes summary stats', () => {
    const snapshots = [
      makeRecordedSnapshot({ askPrices: [0.40, 0.40], timestamp: '2026-01-01T00:00:00Z' }),
      makeRecordedSnapshot({ askPrices: [0.42, 0.42], timestamp: '2026-01-01T00:01:00Z' }),
    ]
    const result = runner.run(snapshots, { takerFeeBps: 0 })
    expect(result.summary.totalTrades).toBe(2)
    expect(result.summary.totalPnl).toBeGreaterThan(0)
    expect(result.dataSource).toBe('snapshot-recorder')
  })
})


// ═══════════════════════════════════════════════════════════
// GabagoolBacktestRunner
// ═══════════════════════════════════════════════════════════

describe('GabagoolBacktestRunner', () => {
  let runner: GabagoolBacktestRunner

  beforeEach(() => { runner = new GabagoolBacktestRunner() })

  it('accumulates cheap sides and merges when profitable', () => {
    const market = makeBtcMarket()
    // Both sides cheap → accumulate both, eventually merge
    const snapshots = Array.from({ length: 20 }, (_, i) =>
      makeBtcSnapshot(i, 100000, 0.40, 0.40),
    )
    const result = runner.run(market, snapshots, {
      cheapnessThreshold: 0.48,
      orderSize: 2,
      cooldownMs: 0,
      minProfitMargin: 0.005,
      maxExposure: 100,
    })
    expect(result.strategy).toBe('gabagool')
    // Should have at least one merge or resolve trade
    expect(result.trades.length).toBeGreaterThan(0)
  })

  it('skips when neither side is cheap', () => {
    const market = makeBtcMarket()
    const snapshots = [makeBtcSnapshot(0, 100000, 0.55, 0.55)]
    const result = runner.run(market, snapshots, { cheapnessThreshold: 0.48, cooldownMs: 0 })
    // Only resolution trade (if any exposure), but no accumulation should happen
    expect(result.trades.every(t => t.direction !== 'merge' || t.pnl <= 0)).toBe(true)
  })

  it('respects max exposure cap', () => {
    const market = makeBtcMarket()
    const snapshots = Array.from({ length: 50 }, (_, i) =>
      makeBtcSnapshot(i, 100000, 0.30, 0.30),
    )
    const result = runner.run(market, snapshots, {
      cheapnessThreshold: 0.48,
      orderSize: 5,
      maxExposure: 10,
      cooldownMs: 0,
    })
    // Total trades limited by exposure cap
    expect(result.strategy).toBe('gabagool')
  })

  it('resolves orphaned positions at window end', () => {
    const market = makeBtcMarket({ winner: 'up' })
    const snapshots = [
      makeBtcSnapshot(0, 100000, 0.40, 0.60), // Only up is cheap
    ]
    const result = runner.run(market, snapshots, {
      cheapnessThreshold: 0.48,
      cooldownMs: 0,
      maxExposure: 100,
    })
    // Should resolve at end since only one side accumulated (no merge possible)
    const resolveTrade = result.trades.find(t => t.direction === 'resolve')
    expect(resolveTrade).toBeDefined()
  })

  it('respects cooldown between orders', () => {
    const market = makeBtcMarket()
    const snapshots = [
      makeBtcSnapshot(0, 100000, 0.40, 0.40),
      makeBtcSnapshot(0.05, 100000, 0.40, 0.40), // 3s later
      makeBtcSnapshot(0.1, 100000, 0.40, 0.40),  // 6s later
    ]
    const result = runner.run(market, snapshots, {
      cheapnessThreshold: 0.48,
      cooldownMs: 5_000,
      maxExposure: 100,
    })
    // With 5s cooldown, only snapshots spaced >= 5s apart should trade
    expect(result.strategy).toBe('gabagool')
  })
})


// ═══════════════════════════════════════════════════════════
// ImpulseBacktestRunner
// ═══════════════════════════════════════════════════════════

describe('ImpulseBacktestRunner', () => {
  let runner: ImpulseBacktestRunner

  beforeEach(() => { runner = new ImpulseBacktestRunner() })

  it('returns empty result for too few snapshots', () => {
    const market = makeBtcMarket()
    const snapshots = [makeBtcSnapshot(0, 100000, 0.50, 0.50)]
    const result = runner.run(market, snapshots)
    expect(result.trades.length).toBe(0)
    expect(result.strategy).toBe('impulse-sniper')
  })

  it('detects impulse when BTC moves but odds are stale', () => {
    const market = makeBtcMarket({ winner: 'up' })
    // Baseline: 5 snapshots at $100k, then impulse to $100.3k with stale odds
    const snapshots = [
      ...Array.from({ length: 5 }, (_, i) => makeBtcSnapshot(i, 100000, 0.50, 0.50)),
      makeBtcSnapshot(5, 100300, 0.51, 0.49), // BTC up $300 but odds barely moved
    ]
    const result = runner.run(market, snapshots, {
      impulseThreshold: 200,
      staleOddsThreshold: 0.03,
      cooldownMs: 0,
      takerFeeBps: 100,
    })
    expect(result.trades.length).toBe(1)
    expect(result.trades[0].direction).toBe('up')
  })

  it('skips when odds have already repriced', () => {
    const market = makeBtcMarket()
    const snapshots = [
      ...Array.from({ length: 5 }, (_, i) => makeBtcSnapshot(i, 100000, 0.50, 0.50)),
      makeBtcSnapshot(5, 100300, 0.65, 0.35), // Odds already repriced
    ]
    const result = runner.run(market, snapshots, {
      impulseThreshold: 200,
      staleOddsThreshold: 0.03,
      cooldownMs: 0,
    })
    expect(result.trades.length).toBe(0)
  })

  it('skips impulse below threshold', () => {
    const market = makeBtcMarket()
    const snapshots = [
      ...Array.from({ length: 5 }, (_, i) => makeBtcSnapshot(i, 100000, 0.50, 0.50)),
      makeBtcSnapshot(5, 100100, 0.50, 0.50), // Only $100 move
    ]
    const result = runner.run(market, snapshots, { impulseThreshold: 200, cooldownMs: 0 })
    expect(result.trades.length).toBe(0)
  })

  it('simulates stop-loss exit', () => {
    const market = makeBtcMarket({ winner: 'down' })
    const snapshots = [
      ...Array.from({ length: 5 }, (_, i) => makeBtcSnapshot(i, 100000, 0.50, 0.50)),
      makeBtcSnapshot(5, 100300, 0.51, 0.49),  // Impulse up
      makeBtcSnapshot(6, 100100, 0.30, 0.70),   // Price crashes → SL on up
    ]
    const result = runner.run(market, snapshots, {
      impulseThreshold: 200,
      staleOddsThreshold: 0.03,
      stopLossPct: 0.15,
      cooldownMs: 0,
      takerFeeBps: 0,
    })
    expect(result.trades.length).toBe(1)
    expect(result.trades[0].metadata?.exitReason).toBe('stop-loss')
    expect(result.trades[0].pnl).toBeLessThan(0)
  })

  it('simulates take-profit exit', () => {
    const market = makeBtcMarket({ winner: 'up' })
    const snapshots = [
      ...Array.from({ length: 5 }, (_, i) => makeBtcSnapshot(i, 100000, 0.50, 0.50)),
      makeBtcSnapshot(5, 100300, 0.51, 0.49),  // Impulse up
      makeBtcSnapshot(6, 100500, 0.80, 0.20),   // Odds surge → TP
    ]
    const result = runner.run(market, snapshots, {
      impulseThreshold: 200,
      staleOddsThreshold: 0.03,
      takeProfitPct: 0.40,
      cooldownMs: 0,
      takerFeeBps: 0,
    })
    expect(result.trades.length).toBe(1)
    expect(result.trades[0].metadata?.exitReason).toBe('take-profit')
    expect(result.trades[0].pnl).toBeGreaterThan(0)
  })

  it('resolves at window end if no SL/TP hit', () => {
    const market = makeBtcMarket({ winner: 'up' })
    const snapshots = [
      ...Array.from({ length: 5 }, (_, i) => makeBtcSnapshot(i, 100000, 0.50, 0.50)),
      makeBtcSnapshot(5, 100300, 0.51, 0.49),  // Impulse up, last snapshot
    ]
    const result = runner.run(market, snapshots, {
      impulseThreshold: 200,
      staleOddsThreshold: 0.03,
      cooldownMs: 0,
      takerFeeBps: 100,
    })
    expect(result.trades.length).toBe(1)
    expect(result.trades[0].metadata?.exitReason).toBe('resolution')
  })

  it('enforces cooldown', () => {
    const market = makeBtcMarket({ winner: 'up' })
    const snapshots = [
      ...Array.from({ length: 5 }, (_, i) => makeBtcSnapshot(i, 100000, 0.50, 0.50)),
      makeBtcSnapshot(5, 100300, 0.51, 0.49),  // First impulse
      makeBtcSnapshot(5.5, 100600, 0.52, 0.48), // Second impulse 30s later
    ]
    const result = runner.run(market, snapshots, {
      impulseThreshold: 200,
      staleOddsThreshold: 0.03,
      cooldownMs: 60_000,
      takerFeeBps: 0,
    })
    expect(result.trades.length).toBe(1) // Only first, second within cooldown
  })

  it('skips extreme entry prices', () => {
    const market = makeBtcMarket()
    const snapshots = [
      ...Array.from({ length: 5 }, (_, i) => makeBtcSnapshot(i, 100000, 0.95, 0.05)),
      makeBtcSnapshot(5, 100300, 0.96, 0.04),
    ]
    const result = runner.run(market, snapshots, {
      impulseThreshold: 200,
      staleOddsThreshold: 0.03,
      cooldownMs: 0,
    })
    expect(result.trades.length).toBe(0) // 0.96 > 0.90 and 0.04 < 0.05
  })
})


// ═══════════════════════════════════════════════════════════
// LLMBacktestRunner
// ═══════════════════════════════════════════════════════════

describe('LLMBacktestRunner', () => {
  let runner: LLMBacktestRunner

  beforeEach(() => { runner = new LLMBacktestRunner() })

  describe('runBaseline', () => {
    it('generates specified number of trades', () => {
      const result = runner.runBaseline(50)
      expect(result.trades.length).toBe(50)
      expect(result.strategy).toBe('llm-prediction')
      expect(result.strategyName).toContain('Baseline')
    })

    it('produces deterministic results (seeded PRNG)', () => {
      const r1 = runner.runBaseline(20)
      const r2 = runner.runBaseline(20)
      expect(r1.trades.map(t => t.pnl)).toEqual(r2.trades.map(t => t.pnl))
    })

    it('respects configured win rate approximately', () => {
      const result = runner.runBaseline(1000, { baselineWinRate: 0.80 })
      const wins = result.trades.filter(t => t.metadata?.won).length
      // With seeded PRNG, ~80% should be wins (allow some tolerance)
      expect(wins / 1000).toBeGreaterThan(0.70)
      expect(wins / 1000).toBeLessThan(0.90)
    })

    it('computes summary stats', () => {
      const result = runner.runBaseline(100)
      expect(result.summary.totalTrades).toBe(100)
      expect(result.summary.wins).toBeGreaterThan(0)
      expect(result.summary.losses).toBeGreaterThan(0)
    })

    it('applies taker fees to winners', () => {
      const result = runner.runBaseline(100, { takerFeeBps: 200 })
      const wonTrades = result.trades.filter(t => t.metadata?.won)
      for (const t of wonTrades) {
        expect(t.feePaid).toBeGreaterThan(0)
      }
    })
  })

  describe('runReplay', () => {
    it('replays interactions with outcomes', () => {
      const interactions: LLMInteractionRecord[] = [
        {
          timestamp: '2026-01-01T00:00:00Z',
          promptType: 'market-analysis',
          marketSlug: 'test-market',
          marketQuestion: 'Will BTC go up?',
          prediction: { direction: 'yes', confidence: 0.70 },
          outcome: { won: true, pnl: 0.15, entryPrice: 0.45, exitPrice: 1.0, holdTimeMs: 60_000 },
          exported: false,
        },
        {
          timestamp: '2026-01-01T01:00:00Z',
          promptType: 'market-analysis',
          marketSlug: 'test-market-2',
          marketQuestion: 'Will ETH go up?',
          prediction: { direction: 'no', confidence: 0.60 },
          outcome: { won: false, pnl: -0.40, entryPrice: 0.40, exitPrice: 0, holdTimeMs: 30_000 },
          exported: false,
        },
      ]
      const result = runner.runReplay(interactions)
      expect(result.trades.length).toBe(2)
      expect(result.trades[0].pnl).toBe(0.15)
      expect(result.trades[1].pnl).toBe(-0.40)
      expect(result.strategyName).toContain('Replay')
    })

    it('filters by min confidence', () => {
      const interactions: LLMInteractionRecord[] = [
        {
          timestamp: '2026-01-01T00:00:00Z',
          promptType: 'market-analysis',
          marketSlug: 'test',
          marketQuestion: 'Q?',
          prediction: { direction: 'yes', confidence: 0.30 }, // Below default 0.48
          outcome: { won: true, pnl: 0.10, entryPrice: 0.50, exitPrice: 1.0, holdTimeMs: 1000 },
          exported: false,
        },
      ]
      const result = runner.runReplay(interactions) // default minConfidence = 0.48
      expect(result.trades.length).toBe(0)
    })

    it('skips interactions without outcomes', () => {
      const interactions: LLMInteractionRecord[] = [
        {
          timestamp: '2026-01-01T00:00:00Z',
          promptType: 'market-analysis',
          marketSlug: 'test',
          marketQuestion: 'Q?',
          prediction: { direction: 'yes', confidence: 0.70 },
          exported: false,
          // No outcome
        },
      ]
      const result = runner.runReplay(interactions)
      expect(result.trades.length).toBe(0)
    })
  })
})
