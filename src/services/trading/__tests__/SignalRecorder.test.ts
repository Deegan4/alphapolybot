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
