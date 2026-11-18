import { describe, it, expect } from 'vitest'
import {
  PMUS_DEFAULT_TAKER_THETA,
  takerFee,
  takerFeeFraction,
  takerCostPerContract,
  roundTripFeeFraction,
} from '../pmusFees'
import { KellySizer } from '../KellySizer'

describe('Polymarket US taker fee (docs.polymarket.us/fees)', () => {
  it('matches the documented examples at Θ = 0.0695', () => {
    // Example 1: buy 1,000 at $0.10 → $6.26; Example 2: 1,000 at $0.65 → $15.81
    expect(takerFee(1000, 0.10, 0.0695)).toBeCloseTo(6.255, 3)
    expect(takerFee(1000, 0.65, 0.0695)).toBeCloseTo(15.81, 2)
    // Table: 100-lot at $0.50 → $1.74
    expect(takerFee(100, 0.5, 0.0695)).toBeCloseTo(1.7375, 4)
  })

  it('defaults to the tier-1 coefficient and is symmetric in p', () => {
    expect(PMUS_DEFAULT_TAKER_THETA).toBe(0.095)
    expect(takerFee(100, 0.3)).toBeCloseTo(takerFee(100, 0.7), 10)
    expect(takerFee(0, 0.5)).toBe(0)
  })

  it('expresses the fee as a share of notional: Θ(1 − p)', () => {
    expect(takerFeeFraction(0.5)).toBeCloseTo(0.0475, 10)
    expect(takerFeeFraction(0.05)).toBeCloseTo(0.09025, 10)
    expect(takerCostPerContract(0.5)).toBeCloseTo(0.5 + 0.095 * 0.25, 10)
  })

  it('round trip adds entry and exit fees relative to entry notional', () => {
    // buy 0.40, sell 0.60: 0.095·0.6 + 0.095·0.6·0.4/0.4
    expect(roundTripFeeFraction(0.40, 0.60)).toBeCloseTo(0.057 + 0.057, 10)
  })
})

describe('KellySizer.pmusKelly', () => {
  it('is smaller than fee-free Kelly and zero when fees eat the edge', () => {
    const noFee = KellySizer.polymarketKelly(0.55, 0.50)
    const withFee = KellySizer.pmusKelly(0.55, 0.50)
    expect(withFee).toBeGreaterThan(0)
    expect(withFee).toBeLessThan(noFee)
    // 2% edge at 50¢ is less than the 2.4¢ fee per contract
    expect(KellySizer.pmusKelly(0.52, 0.50)).toBe(0)
  })

  it('honors a market-specific coefficient', () => {
    expect(KellySizer.pmusKelly(0.6, 0.5, 0)).toBeCloseTo(KellySizer.polymarketKelly(0.6, 0.5), 10)
    expect(KellySizer.pmusKelly(0.6, 0.5, 0.2)).toBeLessThan(KellySizer.pmusKelly(0.6, 0.5, 0.095))
  })
})
