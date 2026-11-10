import { describe, it, expect } from 'vitest'
import { BtcSignalRecorder, confidenceReport, resolutionReturn, RESOLVE_GRACE_MS, type BtcSignalSample } from '../BtcSignalRecorder'

const sample = (over: Partial<BtcSignalSample> = {}): Omit<BtcSignalSample, 'won'> => ({
  marketId: 'w1', asset: 'BTC', duration: '15m', t: 0, direction: 'up', confidence: 0.7,
  price: 0.5, refPrice: 100_000, windowEndMs: 900_000, ...over,
})

describe('resolutionReturn', () => {
  it('pays 1 on a win and loses the stake on a loss, after the entry fee', () => {
    expect(resolutionReturn(0.5, true, 0)).toBeCloseTo(1, 6)
    expect(resolutionReturn(0.5, false, 0)).toBe(-1)
    // θ 0.095 at 50¢: cost 0.52375
    expect(resolutionReturn(0.5, true)).toBeCloseTo((1 - 0.52375) / 0.52375, 6)
  })
})

describe('BtcSignalRecorder', () => {
  it('settles ended windows from the spot price, per asset', () => {
    const rec = new BtcSignalRecorder(false)
    rec.record(sample())
    rec.record(sample({ marketId: 'w2', direction: 'down', confidence: 0.6 }))
    rec.record(sample({ marketId: 'e1', asset: 'ETH', refPrice: 3000 }))
    expect(rec.assetsToResolve(899_999)).toEqual([])
    expect(rec.assetsToResolve(900_000).sort()).toEqual(['BTC', 'ETH'])

    rec.resolve('BTC', 100_500, 905_000)
    const [up, down, eth] = rec.getSamples()
    expect(up.won).toBe(true)
    expect(down.won).toBe(false)
    expect(eth.won).toBeUndefined()
    expect(rec.assetsToResolve(905_000)).toEqual(['ETH'])
  })

  it('drops windows it could not settle in time, and exact ties', () => {
    const rec = new BtcSignalRecorder(false)
    rec.record(sample())
    rec.resolve('BTC', 100_500, 900_000 + RESOLVE_GRACE_MS + 1)
    expect(rec.getCounts()).toEqual({ total: 0, resolved: 0 })
    rec.record(sample())
    rec.resolve('BTC', 100_000, 900_001)
    expect(rec.getCounts().total).toBe(0)
  })

  it('leaves windows that are still running alone', () => {
    const rec = new BtcSignalRecorder(false)
    rec.record(sample())
    rec.resolve('BTC', 100_500, 1000)
    expect(rec.getSamples()[0].won).toBeUndefined()
  })
})

describe('confidenceReport', () => {
  it('enters each window once, at its first qualifying signal', () => {
    const samples: BtcSignalSample[] = [
      { ...sample({ t: 1, confidence: 0.58, price: 0.40 }), won: true },
      { ...sample({ t: 2, confidence: 0.72, price: 0.60 }), won: true },  // same window, later and stronger
      { ...sample({ marketId: 'w2', t: 3, confidence: 0.66, price: 0.50 }), won: false },
      { ...sample({ marketId: 'w3', t: 4, confidence: 0.9, price: 0.5 }) }, // unresolved
    ]
    const [low, high] = confidenceReport(samples, [0.55, 0.7], { theta: 0 })
    expect(low).toMatchObject({ n: 2, winRate: 0.5 })
    expect(low.avgPrice).toBeCloseTo(0.45, 6)           // w1 entered at its first signal (40¢)
    expect(low.avgNet).toBeCloseTo((1.5 + -1) / 2, 6)   // +150% and −100%
    expect(high).toMatchObject({ n: 1, winRate: 1 })
    expect(high.avgPrice).toBeCloseTo(0.60, 6)
  })

  it('applies the entry-price limits', () => {
    const samples: BtcSignalSample[] = [{ ...sample({ price: 0.85 }), won: true }]
    expect(confidenceReport(samples, [0.55], { maxPrice: 0.8 })[0].n).toBe(0)
    expect(confidenceReport(samples, [0.55], { maxPrice: 0.9 })[0].n).toBe(1)
  })
})
