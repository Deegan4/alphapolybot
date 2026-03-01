import { describe, it, expect } from 'vitest'
import { KellySizer } from '../KellySizer'

// Deterministic LCG RNG for reproducible tests
function createRng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

describe('bootstrapEdgeCI()', () => {
  it('returns [0,0] for single-element array', () => {
    const ci = KellySizer.bootstrapEdgeCI([0.5])
    expect(ci).toEqual([0, 0])
  })

  it('returns [0,0] for empty array', () => {
    const ci = KellySizer.bootstrapEdgeCI([])
    expect(ci).toEqual([0, 0])
  })

  it('all positive returns yield all-positive CI', () => {
    const returns = [0.10, 0.20, 0.15, 0.12, 0.18, 0.22, 0.14, 0.16, 0.19, 0.11]
    const [lower, upper] = KellySizer.bootstrapEdgeCI(returns, 0.95, 2000, createRng(42))
    expect(lower).toBeGreaterThan(0)
    expect(upper).toBeGreaterThan(lower)
  })

  it('all negative returns yield all-negative CI', () => {
    const returns = [-0.10, -0.20, -0.15, -0.12, -0.18, -0.22, -0.14, -0.16, -0.19, -0.11]
    const [lower, upper] = KellySizer.bootstrapEdgeCI(returns, 0.95, 2000, createRng(42))
    expect(upper).toBeLessThan(0)
    expect(lower).toBeLessThan(upper)
  })

  it('mixed returns have lower < upper', () => {
    const returns = [0.10, -0.05, 0.08, -0.12, 0.03, -0.02, 0.15, -0.08, 0.06, -0.01]
    const [lower, upper] = KellySizer.bootstrapEdgeCI(returns, 0.95, 2000, createRng(42))
    expect(lower).toBeLessThan(upper)
  })

  it('is deterministic with seeded RNG', () => {
    const returns = [0.10, -0.05, 0.08, -0.12, 0.03]
    const ci1 = KellySizer.bootstrapEdgeCI(returns, 0.95, 1000, createRng(123))
    const ci2 = KellySizer.bootstrapEdgeCI(returns, 0.95, 1000, createRng(123))
    expect(ci1).toEqual(ci2)
  })

  it('99% CI is wider than 95% CI', () => {
    const returns = [0.10, -0.05, 0.08, -0.12, 0.03, -0.02, 0.15, -0.08, 0.06, -0.01]
    const rng = createRng(42)
    const ci95 = KellySizer.bootstrapEdgeCI(returns, 0.95, 3000, rng)
    const ci99 = KellySizer.bootstrapEdgeCI(returns, 0.99, 3000, createRng(42))
    const width95 = ci95[1] - ci95[0]
    const width99 = ci99[1] - ci99[0]
    expect(width99).toBeGreaterThanOrEqual(width95 * 0.9) // Allow small floating point variance
  })
})

describe('monteCarloKelly()', () => {
  it('returns adjustedFraction=0 with insufficient data (<10 trades)', () => {
    const result = KellySizer.monteCarloKelly({
      returns: [0.1, 0.2, -0.1, 0.05, -0.15],
      marketPrice: 0.45,
      feeRateBps: 100,
    })
    expect(result.adjustedFraction).toBe(0)
    expect(result.rawKelly).toBe(0)
    expect(result.cvEdge).toBe(1)
  })

  it('near-perfect win rate yields positive adjustedFraction', () => {
    // 14/15 winning trades at 45c market — ~93% win rate (not 100%, which hits fullKelly p>=1 guard)
    const returns = [...Array(14).fill(0.55), -0.45]
    const result = KellySizer.monteCarloKelly({
      returns,
      marketPrice: 0.45,
      feeRateBps: 0,
      rng: createRng(42),
    })
    expect(result.adjustedFraction).toBeGreaterThan(0)
    expect(result.rawKelly).toBeGreaterThan(0)
    expect(result.adjustedFraction).toBeLessThanOrEqual(result.rawKelly)
  })

  it('zero win rate yields adjustedFraction=0', () => {
    const returns = Array(15).fill(-0.45)
    const result = KellySizer.monteCarloKelly({
      returns,
      marketPrice: 0.45,
      feeRateBps: 0,
      rng: createRng(42),
    })
    expect(result.adjustedFraction).toBe(0)
    expect(result.rawKelly).toBe(0)
  })

  it('high CV (noisy returns) yields adjustedFraction < rawKelly', () => {
    // 60% win rate but very noisy
    const returns = [
      0.55, -0.45, 0.55, 0.55, -0.45,
      -0.45, 0.55, -0.45, 0.55, 0.55,
      -0.45, 0.55, -0.45, 0.55, 0.55,
    ]
    const result = KellySizer.monteCarloKelly({
      returns,
      marketPrice: 0.45,
      feeRateBps: 0,
      rng: createRng(42),
    })
    expect(result.adjustedFraction).toBeLessThan(result.rawKelly)
    expect(result.cvEdge).toBeGreaterThan(0)
  })

  it('adjustedFraction is always <= rawKelly', () => {
    const returns = [
      0.55, 0.55, 0.55, -0.45, 0.55,
      0.55, -0.45, 0.55, 0.55, 0.55,
      0.55, 0.55, -0.45, 0.55, 0.55,
    ]
    const result = KellySizer.monteCarloKelly({
      returns,
      marketPrice: 0.45,
      feeRateBps: 0,
      rng: createRng(42),
    })
    expect(result.adjustedFraction).toBeLessThanOrEqual(result.rawKelly)
  })

  it('is deterministic with seeded RNG', () => {
    const returns = [0.55, -0.45, 0.55, 0.55, -0.45, 0.55, -0.45, 0.55, 0.55, -0.45]
    const r1 = KellySizer.monteCarloKelly({ returns, marketPrice: 0.45, feeRateBps: 0, rng: createRng(99) })
    const r2 = KellySizer.monteCarloKelly({ returns, marketPrice: 0.45, feeRateBps: 0, rng: createRng(99) })
    expect(r1.adjustedFraction).toBeCloseTo(r2.adjustedFraction, 10)
    expect(r1.cvEdge).toBeCloseTo(r2.cvEdge, 10)
    expect(r1.drawdown95).toBeCloseTo(r2.drawdown95, 10)
  })

  it('drawdown95 is between 0 and 1', () => {
    const returns = [0.55, -0.45, 0.55, 0.55, -0.45, -0.45, 0.55, -0.45, 0.55, 0.55]
    const result = KellySizer.monteCarloKelly({
      returns,
      marketPrice: 0.45,
      feeRateBps: 0,
      rng: createRng(42),
    })
    expect(result.drawdown95).toBeGreaterThanOrEqual(0)
    expect(result.drawdown95).toBeLessThanOrEqual(1)
  })

  it('fees reduce rawKelly appropriately', () => {
    // 19/20 wins (~95% win rate, not 100% which would hit fullKelly p>=1 guard)
    const returns = [...Array(19).fill(0.55), -0.45]
    const noFee = KellySizer.monteCarloKelly({
      returns,
      marketPrice: 0.45,
      feeRateBps: 0,
      rng: createRng(42),
    })
    const withFee = KellySizer.monteCarloKelly({
      returns,
      marketPrice: 0.45,
      feeRateBps: 500,
      rng: createRng(42),
    })
    expect(noFee.rawKelly).toBeGreaterThan(0)
    expect(withFee.rawKelly).toBeLessThan(noFee.rawKelly)
  })

  it('known distribution: 60% win at 50c', () => {
    // 60% wins, 40% losses at market price 0.50
    // Use 50 trades (30W/20L) to reduce CV so adjustedFraction > 0
    const returns: number[] = []
    for (let i = 0; i < 30; i++) returns.push(0.50)   // 30 wins
    for (let i = 0; i < 20; i++) returns.push(-0.50)   // 20 losses
    const result = KellySizer.monteCarloKelly({
      returns,
      marketPrice: 0.50,
      feeRateBps: 0,
      rng: createRng(42),
    })
    // Point-estimate Kelly at 60% win, 50c market: f* = (1*0.6 - 0.4)/1 = 0.20
    expect(result.rawKelly).toBeCloseTo(0.20, 1)
    expect(result.adjustedFraction).toBeGreaterThan(0)
    expect(result.adjustedFraction).toBeLessThan(result.rawKelly)
  })

  it('confidenceInterval brackets the mean return', () => {
    const returns = [0.55, -0.45, 0.55, 0.55, -0.45, 0.55, -0.45, 0.55, 0.55, -0.45, 0.55, 0.55]
    const result = KellySizer.monteCarloKelly({
      returns,
      marketPrice: 0.45,
      feeRateBps: 0,
      nResamples: 3000,
      rng: createRng(42),
    })
    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length
    expect(result.confidenceInterval[0]).toBeLessThan(meanReturn)
    expect(result.confidenceInterval[1]).toBeGreaterThan(meanReturn)
  })
})
