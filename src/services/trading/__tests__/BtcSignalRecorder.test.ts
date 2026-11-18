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

import { confidenceHoldout, EXCHANGE_RETRY_MS, EXCHANGE_SETTLE_WINDOW_MS } from '../BtcSignalRecorder'

describe('exchange settlement', () => {
  const withSlug = (over: Partial<BtcSignalSample> = {}) => sample({ slug: 'btc-updown-15m-x', yesMeansUp: true, ...over })

  it('overrides the provisional spot result and counts disagreements', () => {
    const rec = new BtcSignalRecorder(false)
    rec.record(withSlug())                                  // signalled UP
    rec.record(withSlug({ t: 5, direction: 'down' }))
    rec.resolve('BTC', 100_010, 901_000)                    // spot says up won
    expect(rec.getSamples().map(s => [s.won, s.source])).toEqual([[true, 'spot'], [false, 'spot']])
    expect(rec.getSourceCounts()).toEqual({ exchange: 0, spot: 1, disagreed: 0 })

    rec.settleFromExchange('w1', 0, 960_000)                // exchange: YES (= Up) lost
    expect(rec.getSamples().map(s => [s.won, s.source])).toEqual([[false, 'exchange'], [true, 'exchange']])
    expect(rec.getSourceCounts()).toEqual({ exchange: 1, spot: 0, disagreed: 1 })
  })

  it('respects which side YES is, and ignores a non-binary settlement', () => {
    const rec = new BtcSignalRecorder(false)
    rec.record(withSlug({ yesMeansUp: false }))             // YES = Down; signalled UP
    rec.settleFromExchange('w1', 0.5, 901_000)
    expect(rec.getSamples()[0].won).toBeUndefined()
    rec.settleFromExchange('w1', 0, 901_000)                // YES (Down) lost → Up won
    expect(rec.getSamples()[0].won).toBe(true)
  })

  it('lists ended, unsettled markets, with a retry delay and a deadline', () => {
    const rec = new BtcSignalRecorder(false)
    rec.record(withSlug())
    rec.record(sample({ marketId: 'noslug' }))              // cannot be settled by the exchange
    expect(rec.marketsAwaitingExchange(899_000)).toEqual([])
    expect(rec.marketsAwaitingExchange(900_000)).toEqual([{ marketId: 'w1', slug: 'btc-updown-15m-x' }])
    expect(rec.marketsAwaitingExchange(900_000 + EXCHANGE_RETRY_MS - 1)).toEqual([])
    expect(rec.marketsAwaitingExchange(900_000 + EXCHANGE_RETRY_MS)).toHaveLength(1)
    expect(rec.marketsAwaitingExchange(900_000 + EXCHANGE_SETTLE_WINDOW_MS + 1)).toEqual([])
    rec.settleFromExchange('w1', 1, 950_000)
    expect(rec.marketsAwaitingExchange(950_000 + EXCHANGE_RETRY_MS)).toEqual([])
  })

  it('keeps a tie or a late window for the exchange, and prunes it after the deadline', () => {
    const rec = new BtcSignalRecorder(false)
    rec.record(withSlug())
    rec.resolve('BTC', 100_000, 901_000)                    // exact tie
    expect(rec.getCounts()).toEqual({ total: 1, resolved: 0 })
    rec.prune(900_000 + EXCHANGE_SETTLE_WINDOW_MS + 1)
    expect(rec.getCounts().total).toBe(0)
  })
})

describe('confidenceHoldout', () => {
  const windows = (count: number, won: (k: number) => boolean): BtcSignalSample[] =>
    Array.from({ length: count }, (_, k) => ({ ...sample({ marketId: `w${k}`, t: k * 1000, windowEndMs: k * 1000 + 500, confidence: 0.7 }), won: won(k) }))

  it('confirms a level that also wins on later windows', () => {
    const result = confidenceHoldout(windows(90, k => k % 4 !== 0), [0.6], { theta: 0 })!
    expect(result.train).toMatchObject({ minConfidence: 0.6, n: 60 })
    expect(result.test.n).toBe(30)
    expect(result.confirmed).toBe(true)
  })

  it('does not confirm a level that only won early', () => {
    const result = confidenceHoldout(windows(90, k => k < 60), [0.6], { theta: 0 })!
    expect(result.train.avgNet).toBeGreaterThan(0)
    expect(result.test.avgNet).toBeLessThan(0)
    expect(result.confirmed).toBe(false)
  })

  it('is null without enough profitable early windows', () => {
    expect(confidenceHoldout([])).toBeNull()
    expect(confidenceHoldout(windows(20, () => true), [0.6])).toBeNull()
    expect(confidenceHoldout(windows(90, () => false), [0.6])).toBeNull()
  })
})
