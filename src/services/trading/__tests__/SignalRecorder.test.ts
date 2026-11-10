import { describe, it, expect } from 'vitest'
import { SignalRecorder, sampleReturn, thresholdReport, SIGNAL_HORIZON_MS, type SignalSample } from '../SignalRecorder'

const base = { slug: 'm', confidence: 0.8, spread: 0.02 }

describe('sampleReturn', () => {
  it('pays the spread and fees on a YES entry', () => {
    const s: SignalSample = { ...base, t: 0, composite: 0.5, mid: 0.50, exitMid: 0.56 }
    const r = sampleReturn(s, 0)!
    // buy 0.51, sell 0.55 → +7.84%
    expect(r.gross).toBeCloseTo(0.04 / 0.51, 6)
    expect(r.net).toBeCloseTo(r.gross, 6) // theta 0
    expect(sampleReturn(s)!.net).toBeLessThan(r.gross) // default fees reduce it
  })

  it('prices a bearish signal as a NO entry', () => {
    const s: SignalSample = { ...base, t: 0, composite: -0.5, mid: 0.50, exitMid: 0.44 }
    // NO: buy 0.51, sell 0.55
    expect(sampleReturn(s, 0)!.gross).toBeCloseTo(0.04 / 0.51, 6)
  })

  it('is null until the outcome is known', () => {
    expect(sampleReturn({ ...base, t: 0, composite: 0.5, mid: 0.5 })).toBeNull()
  })
})

describe('SignalRecorder', () => {
  it('resolves a sample with the first reading after the horizon', () => {
    const rec = new SignalRecorder(false)
    rec.record({ ...base, t: 0, composite: 0.5, mid: 0.50 })
    rec.record({ ...base, t: 60_000, composite: 0.5, mid: 0.52 })
    expect(rec.getCounts()).toEqual({ total: 2, resolved: 0 })
    rec.record({ ...base, t: SIGNAL_HORIZON_MS + 1000, composite: 0.1, mid: 0.58 })
    const samples = rec.getSamples()
    expect(samples[0].exitMid).toBe(0.58)
    expect(samples[1].exitMid).toBeUndefined()
    // other markets are not affected
    rec.record({ ...base, slug: 'other', t: SIGNAL_HORIZON_MS * 3, composite: 0.2, mid: 0.3 })
    expect(rec.getSamples().find(s => s.t === 60_000)!.exitMid).toBeUndefined()
  })

  it('drops samples whose next reading comes far too late', () => {
    const rec = new SignalRecorder(false)
    rec.record({ ...base, t: 0, composite: 0.5, mid: 0.50 })
    rec.record({ ...base, t: SIGNAL_HORIZON_MS * 2 + 1, composite: 0.5, mid: 0.9 })
    expect(rec.getSamples().map(s => s.t)).toEqual([SIGNAL_HORIZON_MS * 2 + 1])
  })

  it('ignores unusable prices', () => {
    const rec = new SignalRecorder(false)
    rec.record({ ...base, t: 0, composite: 0.5, mid: 0 })
    rec.record({ ...base, t: 0, composite: NaN, mid: 0.5 })
    expect(rec.getCounts().total).toBe(0)
  })
})

describe('thresholdReport', () => {
  it('summarises resolved, confident samples at or above each threshold', () => {
    const samples: SignalSample[] = [
      { ...base, t: 0, composite: 0.45, mid: 0.50, exitMid: 0.60 },   // strong, wins
      { ...base, t: 1, composite: -0.25, mid: 0.50, exitMid: 0.55 },  // weaker NO, loses
      { ...base, t: 2, composite: 0.45, mid: 0.50, exitMid: 0.60, confidence: 0.2 }, // low confidence: excluded
      { ...base, t: 3, composite: 0.9, mid: 0.50 },                    // unresolved: excluded
    ]
    const [low, high] = thresholdReport(samples, [0.2, 0.4], 0)
    expect(low.n).toBe(2)
    expect(low.winRate).toBe(0.5)
    expect(high.n).toBe(1)
    expect(high.winRate).toBe(1)
    expect(high.avgNet).toBeCloseTo((0.59 - 0.51) / 0.51, 6)
    expect(thresholdReport([], [0.4])[0]).toEqual({ threshold: 0.4, n: 0, winRate: 0, avgGross: 0, avgNet: 0 })
  })
})

import { simulateTrades, exitRuleReport, suggestThreshold, samplesToCsv, MAX_PATH_GAP_MS } from '../SignalRecorder'

const rules = { stopLossPercent: 0.15, takeProfitPercent: 0.20, maxHoldMs: 30 * 60_000, cooldownMs: 60_000 }
/** Readings for one market every 20s: [composite, mid] */
const path = (points: Array<[number, number]>, slug = 'm', start = 0): SignalSample[] =>
  points.map(([composite, mid], i) => ({ slug, t: start + i * 20_000, composite, confidence: 0.8, mid, spread: 0.02 }))

describe('simulateTrades', () => {
  it('takes profit, then waits out the cooldown before re-entering', () => {
    // entry: buy 0.51. TP needs mark ≥ 0.612 → mid ≥ 0.622
    const samples = path([[0.5, 0.50], [0.5, 0.55], [0.5, 0.63], [0.5, 0.63], [0.5, 0.63], [0.5, 0.63], [0.5, 0.63]])
    const trades = simulateTrades(samples, 0.4, rules, 0)
    expect(trades[0]).toMatchObject({ t: 0, exitT: 40_000, reason: 'take_profit' })
    expect(trades[0].gross).toBeCloseTo((0.62 - 0.51) / 0.51, 6)
    // exit at 40s + 60s cooldown → next entry at 100s; it is still open at the end, so not counted
    expect(trades).toHaveLength(1)
  })

  it('stops out a NO entry when YES rallies', () => {
    // NO entry at 1−0.50+0.01 = 0.51; SL needs mark ≤ 0.4335 → YES mid ≥ 0.5765
    const trades = simulateTrades(path([[-0.5, 0.50], [0, 0.54], [0, 0.58]]), 0.4, rules, 0)
    expect(trades).toHaveLength(1)
    expect(trades[0].reason).toBe('stop_loss')
    expect(trades[0].net).toBeLessThan(-0.15)
  })

  it('closes at the hold limit and charges fees', () => {
    const flat: Array<[number, number]> = Array.from({ length: 92 }, () => [0.5, 0.50])
    const [trade] = simulateTrades(path(flat), 0.4, rules)
    expect(trade.reason).toBe('max_hold')
    expect(trade.exitT).toBe(30 * 60_000)
    expect(trade.gross).toBeCloseTo((0.49 - 0.51) / 0.51, 6) // the spread
    expect(trade.net).toBeLessThan(trade.gross)
  })

  it('leaves out weak or low-confidence signals, open trades and trades across a data gap', () => {
    expect(simulateTrades(path([[0.3, 0.5], [0.3, 0.7]]), 0.4, rules, 0)).toHaveLength(0)
    expect(simulateTrades(path([[0.5, 0.5], [0.5, 0.52]]), 0.4, rules, 0)).toHaveLength(0) // still open
    const lowConf = path([[0.5, 0.5], [0.5, 0.7]]).map(s => ({ ...s, confidence: 0.2 }))
    expect(simulateTrades(lowConf, 0.4, rules, 0)).toHaveLength(0)
    const gapped = path([[0.5, 0.5]]).concat(path([[0, 0.7]], 'm', MAX_PATH_GAP_MS + 1))
    expect(simulateTrades(gapped, 0.4, rules, 0)).toHaveLength(0)
  })

  it('keeps markets separate', () => {
    const samples = [...path([[0.5, 0.50], [0, 0.63]], 'a'), ...path([[0.5, 0.50], [0, 0.40]], 'b')]
    const trades = simulateTrades(samples, 0.4, rules, 0)
    expect(trades.map(t => [t.slug, t.reason]).sort()).toEqual([['a', 'take_profit'], ['b', 'stop_loss']])
  })
})

describe('exitRuleReport and suggestThreshold', () => {
  it('reports per threshold', () => {
    const samples = [...path([[0.5, 0.50], [0, 0.63]], 'a'), ...path([[0.25, 0.50], [0, 0.40]], 'b')]
    const [low, high] = exitRuleReport(samples, rules, [0.2, 0.4], 0)
    expect(low).toMatchObject({ n: 2, winRate: 0.5 })
    expect(high).toMatchObject({ n: 1, winRate: 1 })
  })

  it('suggests only a profitable threshold with enough trades', () => {
    const row = (threshold: number, n: number, avgNet: number) => ({ threshold, n, winRate: 0.5, avgGross: avgNet, avgNet })
    expect(suggestThreshold([row(0.2, 100, -0.01), row(0.4, 10, 0.05)])).toBeNull()
    expect(suggestThreshold([row(0.2, 100, 0.01), row(0.3, 40, 0.03), row(0.4, 10, 0.09)])?.threshold).toBe(0.3)
  })
})

describe('samplesToCsv', () => {
  it('writes a header and one row per sample', () => {
    const csv = samplesToCsv([
      { slug: 'm', t: 0, composite: 0.5, confidence: 0.8, mid: 0.5, spread: 0.02, exitMid: 0.56 },
      { slug: 'n', t: 1000, composite: -0.2, confidence: 0.6, mid: 0.3, spread: 0.01 },
    ])
    expect(csv.split('\n')).toEqual([
      'time_iso,market_slug,composite_signal,confidence,yes_mid,spread,exit_mid_5m',
      '1970-01-01T00:00:00.000Z,m,0.5,0.8,0.5,0.02,0.56',
      '1970-01-01T00:00:01.000Z,n,-0.2,0.6,0.3,0.01,',
      '',
    ])
  })
})

import { holdoutSuggestion, exitGridReport, realTradeSummary } from '../SignalRecorder'

/** `count` back-to-back trades for one market, each 3 readings: entry, drift, exit */
const run = (slug: string, start: number, count: number, composite: number, win: (k: number) => boolean): SignalSample[] => {
  const out: SignalSample[] = []
  for (let k = 0; k < count; k++) {
    const t0 = start + k * 9 * 20_000 // exit at +40s, 60s cooldown, next entry at +180s
    const mids = win(k) ? [0.50, 0.56, 0.63] : [0.50, 0.46, 0.41]
    mids.forEach((mid, i) => out.push({ slug, t: t0 + i * 20_000, composite: i === 0 ? composite : 0, confidence: 0.8, mid, spread: 0.02 }))
  }
  return out
}

describe('holdoutSuggestion', () => {
  it('confirms a threshold that also works on the later data', () => {
    const samples = run('a', 0, 90, 0.45, k => k % 5 !== 0) // 80% winners throughout
    const result = holdoutSuggestion(samples, rules, [0.4], 0)!
    expect(result.train.threshold).toBe(0.4)
    expect(result.train.n).toBeGreaterThanOrEqual(30)
    expect(result.test.n).toBeGreaterThanOrEqual(10)
    expect(result.train.n + result.test.n).toBeLessThanOrEqual(90)
    expect(result.confirmed).toBe(true)
  })

  it('does not confirm one that only worked early', () => {
    const samples = run('a', 0, 90, 0.45, k => k < 60) // wins early, loses late
    const result = holdoutSuggestion(samples, rules, [0.4], 0)!
    expect(result.train.avgNet).toBeGreaterThan(0)
    expect(result.test.avgNet).toBeLessThan(0)
    expect(result.confirmed).toBe(false)
  })

  it('is null without enough profitable early trades', () => {
    expect(holdoutSuggestion([], rules)).toBeNull()
    expect(holdoutSuggestion(run('a', 0, 12, 0.45, () => true), rules, [0.4], 0)).toBeNull()
    expect(holdoutSuggestion(run('a', 0, 90, 0.45, () => false), rules, [0.4], 0)).toBeNull()
  })
})

describe('exitGridReport', () => {
  it('replays each stop-loss and take-profit pair', () => {
    // entry 0.51; mark path 0.55, then 0.62 (+21.6%)
    const samples = path([[0.5, 0.50], [0, 0.56], [0, 0.63]])
    const grid = exitGridReport(samples, 0.4, rules, [0.15], [0.05, 0.20, 0.50], 0)
    expect(grid).toHaveLength(1)
    const [tp5, tp20, tp50] = grid[0]
    expect(tp5).toMatchObject({ stopLossPercent: 0.15, takeProfitPercent: 0.05, n: 1 })
    expect(tp5.avgNet).toBeCloseTo((0.55 - 0.51) / 0.51, 6) // exits at the first reading
    expect(tp20.avgNet).toBeCloseTo((0.62 - 0.51) / 0.51, 6)
    expect(tp50.n).toBe(0) // never reached: still open
  })
})

describe('realTradeSummary', () => {
  it('summarises closed momentum trades since the cutoff', () => {
    const rec = (over: object) => ({ strategy: 'micro', success: true, timestamp: 1000, exitTimestamp: 2000, pnlPercent: 0.1, ...over })
    const summary = realTradeSummary([
      rec({}),
      rec({ pnlPercent: -0.05, dryRun: true }),
      rec({ strategy: 'llm' }),            // other strategy
      rec({ timestamp: 10 }),              // before the cutoff
      rec({ exitTimestamp: undefined }),   // still open
      rec({ success: false }),
    ], 500)
    expect(summary).toEqual({ n: 2, winRate: 0.5, avgPnl: expect.closeTo(0.025, 6), dryRun: 1 })
    expect(realTradeSummary([], 0)).toEqual({ n: 0, winRate: 0, avgPnl: 0, dryRun: 0 })
  })
})
