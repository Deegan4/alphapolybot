import { describe, it, expect } from 'vitest'
import { AvellanedaStoikovPricer, type ASQuoteParams } from '../AvellanedaStoikovPricer'

const AS = AvellanedaStoikovPricer

const baseParams: ASQuoteParams = {
  midPrice: 0.50,
  inventory: 0,
  sigma: 0.05,
  timeRemaining: 0.5,
  gamma: 0.1,
  kappa: 2.0,
}

// ─── Logit / Sigmoid ───────────────────────────────────────

describe('logit / sigmoid', () => {
  it('logit(0.5) = 0', () => {
    expect(AS.logit(0.5)).toBeCloseTo(0, 10)
  })

  it('sigmoid(0) = 0.5', () => {
    expect(AS.sigmoid(0)).toBeCloseTo(0.5, 10)
  })

  it('sigmoid(logit(p)) round-trips', () => {
    for (const p of [0.10, 0.25, 0.50, 0.75, 0.90]) {
      expect(AS.sigmoid(AS.logit(p))).toBeCloseTo(p, 6)
    }
  })

  it('extreme values are clamped', () => {
    // logit clamps to [0.001, 0.999]
    expect(AS.logit(0.0001)).toBeCloseTo(AS.logit(0.001), 5)
    expect(AS.logit(0.9999)).toBeCloseTo(AS.logit(0.999), 5)
    // sigmoid clamps at extremes
    expect(AS.sigmoid(100)).toBeCloseTo(0.999, 3)
    expect(AS.sigmoid(-100)).toBeCloseTo(0.001, 3)
  })
})

// ─── Reservation Price ─────────────────────────────────────

describe('computeReservationPrice()', () => {
  it('zero inventory => reservation = mid', () => {
    const r = AS.computeReservationPrice({ ...baseParams, inventory: 0 })
    expect(r).toBeCloseTo(0.50, 5)
  })

  it('long inventory (q=1) => reservation < mid', () => {
    const r = AS.computeReservationPrice({ ...baseParams, inventory: 1 })
    expect(r).toBeLessThan(0.50)
  })

  it('short inventory (q=-1) => reservation > mid', () => {
    const r = AS.computeReservationPrice({ ...baseParams, inventory: -1 })
    expect(r).toBeGreaterThan(0.50)
  })

  it('higher gamma => more aggressive inventory skew', () => {
    const lowGamma = AS.computeReservationPrice({ ...baseParams, inventory: 1, gamma: 0.05 })
    const highGamma = AS.computeReservationPrice({ ...baseParams, inventory: 1, gamma: 0.50 })
    // Both below mid, but high gamma pushes further down
    expect(highGamma).toBeLessThan(lowGamma)
  })

  it('zero time remaining => reservation = mid', () => {
    const r = AS.computeReservationPrice({ ...baseParams, inventory: 5, timeRemaining: 0 })
    expect(r).toBeCloseTo(0.50, 10)
  })

  it('zero sigma => reservation = mid', () => {
    const r = AS.computeReservationPrice({ ...baseParams, inventory: 5, sigma: 0 })
    expect(r).toBeCloseTo(0.50, 10)
  })

  it('higher sigma => more aggressive skew', () => {
    const lowVol = AS.computeReservationPrice({ ...baseParams, inventory: 1, sigma: 0.02 })
    const highVol = AS.computeReservationPrice({ ...baseParams, inventory: 1, sigma: 0.20 })
    expect(highVol).toBeLessThan(lowVol)
  })
})

// ─── Optimal Spread ────────────────────────────────────────

describe('computeOptimalSpread()', () => {
  it('higher sigma => wider spread', () => {
    // High kappa + gamma so arrival term doesn't dominate and hit 20c cap
    const p = { ...baseParams, gamma: 1.0, kappa: 100 }
    const lowVol = AS.computeOptimalSpread({ ...p, sigma: 0.02 })
    const highVol = AS.computeOptimalSpread({ ...p, sigma: 0.40 })
    expect(highVol).toBeGreaterThan(lowVol)
  })

  it('higher gamma => wider spread', () => {
    // High kappa so arrival term stays small; high sigma so timePart shows gamma effect
    const p = { ...baseParams, sigma: 0.30, kappa: 100 }
    const lowGamma = AS.computeOptimalSpread({ ...p, gamma: 0.10 })
    const highGamma = AS.computeOptimalSpread({ ...p, gamma: 1.0 })
    expect(highGamma).toBeGreaterThan(lowGamma)
  })

  it('higher kappa => tighter spread', () => {
    const lowKappa = AS.computeOptimalSpread({ ...baseParams, kappa: 0.5 })
    const highKappa = AS.computeOptimalSpread({ ...baseParams, kappa: 10.0 })
    expect(highKappa).toBeLessThan(lowKappa)
  })

  it('zero time remaining => fallback spread', () => {
    const spread = AS.computeOptimalSpread({ ...baseParams, timeRemaining: 0 })
    expect(spread).toBe(0.02)
  })

  it('spread is bounded between 0.5c and 20c', () => {
    // Very high vol + time
    const wide = AS.computeOptimalSpread({ ...baseParams, sigma: 1.0, gamma: 5.0, timeRemaining: 1.0 })
    expect(wide).toBeLessThanOrEqual(0.20)
    // Very low vol
    const narrow = AS.computeOptimalSpread({ ...baseParams, sigma: 0.001, gamma: 0.01, timeRemaining: 0.01 })
    expect(narrow).toBeGreaterThanOrEqual(0.005)
  })
})

// ─── computeQuotes ─────────────────────────────────────────

describe('computeQuotes()', () => {
  it('bid < ask always', () => {
    const quotes = AS.computeQuotes(baseParams)
    expect(quotes.bidPrice).toBeLessThan(quotes.askPrice)
  })

  it('quotes are clamped to [0.01, 0.99]', () => {
    // Extreme inventory pushing reservation to extremes
    const quotes = AS.computeQuotes({
      ...baseParams,
      midPrice: 0.95,
      inventory: -10,
      gamma: 5.0,
      sigma: 0.50,
    })
    expect(quotes.bidPrice).toBeGreaterThanOrEqual(0.01)
    expect(quotes.askPrice).toBeLessThanOrEqual(0.99)
  })

  it('quotes center around reservation price', () => {
    const quotes = AS.computeQuotes({ ...baseParams, inventory: 0 })
    const center = (quotes.bidPrice + quotes.askPrice) / 2
    expect(center).toBeCloseTo(quotes.reservationPrice, 2)
  })

  it('extreme inventory pushes quotes asymmetrically', () => {
    const neutral = AS.computeQuotes({ ...baseParams, inventory: 0 })
    const long = AS.computeQuotes({ ...baseParams, inventory: 3 })
    // Long inventory: reservation drops, so bid should be lower
    expect(long.bidPrice).toBeLessThan(neutral.bidPrice)
  })

  it('optimalSpread is positive and reasonable', () => {
    const quotes = AS.computeQuotes(baseParams)
    expect(quotes.optimalSpread).toBeGreaterThan(0)
    expect(quotes.optimalSpread).toBeLessThan(1.0)
  })
})

// ─── Volatility Estimation ─────────────────────────────────

describe('estimateVolatility()', () => {
  it('constant prices => sigma near floor', () => {
    const prices = Array(50).fill(100.0)
    const est = AS.estimateVolatility(prices, 1000, 900_000)
    expect(est.sigma).toBeCloseTo(0.001, 3) // Floor
    expect(est.isReliable).toBe(true) // 49 returns >= 20
  })

  it('insufficient data (< 2 prices) => unreliable', () => {
    const est = AS.estimateVolatility([100], 1000, 900_000)
    expect(est.sigma).toBe(0.01) // Default
    expect(est.isReliable).toBe(false)
  })

  it('empty prices => unreliable', () => {
    const est = AS.estimateVolatility([], 1000, 900_000)
    expect(est.sigma).toBe(0.01)
    expect(est.isReliable).toBe(false)
  })

  it('known volatility series matches expected', () => {
    // 1% moves each tick over 100 ticks
    const prices: number[] = [100]
    for (let i = 1; i < 100; i++) {
      prices.push(prices[i - 1] * (i % 2 === 0 ? 1.01 : 0.99))
    }
    const est = AS.estimateVolatility(prices, 1000, 100_000) // 100s window
    // σ_tick ≈ 0.01, sqrt(100) = 10, so σ_window ≈ 0.10
    expect(est.sigma).toBeGreaterThan(0.05)
    expect(est.sigma).toBeLessThan(0.20)
    expect(est.isReliable).toBe(true)
  })

  it('sampleSize counts valid log-returns', () => {
    const prices = [100, 101, 102, 103, 104]
    const est = AS.estimateVolatility(prices, 1000, 900_000)
    expect(est.sampleSize).toBe(4)
    expect(est.isReliable).toBe(false) // < 20
  })
})

// ─── Inventory Helpers ─────────────────────────────────────

describe('inventory helpers', () => {
  it('dualSideInventory: (true, false) => 1', () => {
    expect(AS.dualSideInventory(true, false)).toBe(1)
  })

  it('dualSideInventory: (false, true) => -1', () => {
    expect(AS.dualSideInventory(false, true)).toBe(-1)
  })

  it('dualSideInventory: (true, true) => 0', () => {
    expect(AS.dualSideInventory(true, true)).toBe(0)
  })

  it('dualSideInventory: (false, false) => 0', () => {
    expect(AS.dualSideInventory(false, false)).toBe(0)
  })

  it('gabagoolInventory: positive when heavy on YES', () => {
    expect(AS.gabagoolInventory(10, 5, 20)).toBeCloseTo(0.25, 10)
  })

  it('gabagoolInventory: negative when heavy on NO', () => {
    expect(AS.gabagoolInventory(5, 10, 20)).toBeCloseTo(-0.25, 10)
  })

  it('gabagoolInventory: zero target returns 0', () => {
    expect(AS.gabagoolInventory(10, 5, 0)).toBe(0)
  })

  it('gabagoolInventory: equal qty returns 0', () => {
    expect(AS.gabagoolInventory(10, 10, 20)).toBe(0)
  })
})
