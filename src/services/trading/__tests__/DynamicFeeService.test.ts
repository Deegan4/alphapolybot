import { describe, it, expect } from 'vitest'
import { DynamicFeeService } from '../DynamicFeeService'

const svc = new DynamicFeeService()

// ==========================================
// FEE CURVE MODEL
// ==========================================

describe('DynamicFeeService — fee curve model', () => {
  it('peaks near 315 bps at price 0.50 for crypto markets', () => {
    const est = svc.estimateDynamicFee(0.50, true)
    expect(est.feeRateBps).toBe(315) // 50 base + 265 surcharge * 1.0
    expect(est.isDynamic).toBe(true)
    expect(est.source).toBe('model')
  })

  it('tapers toward base fee at extreme prices', () => {
    const atTen = svc.estimateDynamicFee(0.10, true)
    const atNinety = svc.estimateDynamicFee(0.90, true)
    // At p=0.10: distanceFactor = 1 - 4*(0.1-0.5)^2 = 1 - 0.64 = 0.36
    expect(atTen.feeRateBps).toBe(Math.round(50 + 265 * 0.36)) // ~145 bps
    expect(atNinety.feeRateBps).toBe(atTen.feeRateBps) // symmetric
  })

  it('is symmetric around 0.50', () => {
    const at30 = svc.estimateDynamicFee(0.30, true)
    const at70 = svc.estimateDynamicFee(0.70, true)
    expect(at30.feeRateBps).toBe(at70.feeRateBps)
  })

  it('decreases monotonically from 0.50 toward edges', () => {
    const at50 = svc.estimateDynamicFee(0.50, true).feeRateBps
    const at40 = svc.estimateDynamicFee(0.40, true).feeRateBps
    const at30 = svc.estimateDynamicFee(0.30, true).feeRateBps
    const at20 = svc.estimateDynamicFee(0.20, true).feeRateBps
    const at10 = svc.estimateDynamicFee(0.10, true).feeRateBps
    expect(at50).toBeGreaterThan(at40)
    expect(at40).toBeGreaterThan(at30)
    expect(at30).toBeGreaterThan(at20)
    expect(at20).toBeGreaterThan(at10)
  })

  it('returns flat 100 bps for standard (non-crypto) markets', () => {
    const est = svc.estimateDynamicFee(0.50, false)
    expect(est.feeRateBps).toBe(100)
    expect(est.isDynamic).toBe(false)
  })

  it('handles edge case prices gracefully', () => {
    const atZero = svc.estimateDynamicFee(0.001, true)
    const atOne = svc.estimateDynamicFee(0.999, true)
    expect(atZero.feeRateBps).toBeGreaterThan(0)
    expect(atOne.feeRateBps).toBeGreaterThan(0)
    expect(atZero.feeRateBps).toBeLessThan(315)
  })

  it('feePercent is consistent with feeRateBps', () => {
    const est = svc.estimateDynamicFee(0.40, true)
    expect(est.feePercent).toBeCloseTo(est.feeRateBps / 10_000, 6)
  })
})

// ==========================================
// TRADE EV COMPUTATION
// ==========================================

describe('DynamicFeeService — computeTradeEV', () => {
  it('positive EV when modelProb greatly exceeds marketPrice + fees', () => {
    const ev = svc.computeTradeEV({
      modelProb: 0.80,
      marketPrice: 0.40,
      tradeSize: 10,
      feeRateBps: 315,   // ~3.15% dynamic fee at 50/50
      isResolutionHold: true,
    })
    // netEV = 0.80 * (1 - 0.0315) - 0.40 = 0.80 * 0.9685 - 0.40 = 0.7748 - 0.40 = 0.3748
    expect(ev.netEV).toBeGreaterThan(0.35)
    expect(ev.isViable).toBe(true)
    expect(ev.grossEV).toBeCloseTo(0.40, 2) // 0.80 - 0.40
  })

  it('negative EV when fee eats the edge', () => {
    const ev = svc.computeTradeEV({
      modelProb: 0.42,
      marketPrice: 0.40,
      tradeSize: 10,
      feeRateBps: 1000,   // old 10% flat fee
      isResolutionHold: true,
    })
    // netEV = 0.42 * (1 - 0.10) - 0.40 = 0.42 * 0.90 - 0.40 = 0.378 - 0.40 = -0.022
    expect(ev.netEV).toBeLessThan(0)
    expect(ev.isViable).toBe(false)
  })

  it('same trade becomes viable with lower dynamic fee', () => {
    const ev = svc.computeTradeEV({
      modelProb: 0.42,
      marketPrice: 0.40,
      tradeSize: 10,
      feeRateBps: 50,     // low fee at edge prices
      isResolutionHold: true,
    })
    // netEV = 0.42 * (1 - 0.005) - 0.40 = 0.42 * 0.995 - 0.40 = 0.4179 - 0.40 = 0.0179
    expect(ev.netEV).toBeGreaterThan(0)
    expect(ev.isViable).toBe(true)
  })

  it('breakEvenProb is correct', () => {
    const ev = svc.computeTradeEV({
      modelProb: 0.50,
      marketPrice: 0.40,
      tradeSize: 10,
      feeRateBps: 315,
      isResolutionHold: true,
    })
    // breakEvenProb = 0.40 / (1 - 0.0315) = 0.40 / 0.9685 ≈ 0.413
    expect(ev.breakEvenProb).toBeCloseTo(0.413, 2)
  })

  it('returns zero EV for invalid inputs', () => {
    const ev = svc.computeTradeEV({
      modelProb: 0,
      marketPrice: 0.40,
      tradeSize: 10,
      feeRateBps: 315,
      isResolutionHold: true,
    })
    expect(ev.netEV).toBe(0)
    expect(ev.isViable).toBe(false)
    expect(ev.breakEvenProb).toBe(1)
  })

  it('feeAdjustedEdge is netEV / marketPrice', () => {
    const ev = svc.computeTradeEV({
      modelProb: 0.70,
      marketPrice: 0.30,
      tradeSize: 10,
      feeRateBps: 200,
      isResolutionHold: true,
    })
    expect(ev.feeAdjustedEdge).toBeCloseTo(ev.netEV / 0.30, 6)
  })
})

// ==========================================
// DUAL-SIDE EV
// ==========================================

describe('DynamicFeeService — computeDualSideEV', () => {
  it('profitable with maker orders (0% fee) when combined < $1.00', () => {
    const ev = svc.computeDualSideEV({
      yesPrice: 0.49,
      noPrice: 0.49,
      yesFeeRateBps: 0,   // maker
      noFeeRateBps: 0,     // maker
      winProbability: 0.60,
    })
    // Payout: 0.60 * 1.00 + 0.40 * 1.00 = 1.00 (no fee)
    // Outlay: 0.49 + 0.49 = 0.98
    // Net: 1.00 - 0.98 = 0.02
    expect(ev.netEV).toBeCloseTo(0.02, 4)
    expect(ev.isViable).toBe(true)
    expect(ev.totalOutlay).toBeCloseTo(0.98, 4)
    expect(ev.totalFees).toBeCloseTo(0, 4)
  })

  it('unprofitable with taker fees (10%) even when combined < $1.00', () => {
    const ev = svc.computeDualSideEV({
      yesPrice: 0.49,
      noPrice: 0.49,
      yesFeeRateBps: 1000,  // 10% taker
      noFeeRateBps: 1000,
      winProbability: 0.60,
    })
    // Payout: 0.60 * 0.90 + 0.40 * 0.90 = 0.90 (10% fee on winner's payout)
    // Outlay: 0.98
    // Net: 0.90 - 0.98 = -0.08
    expect(ev.netEV).toBeLessThan(0)
    expect(ev.isViable).toBe(false)
  })

  it('unprofitable with dynamic fee (~3.15%) at 50/50', () => {
    const ev = svc.computeDualSideEV({
      yesPrice: 0.50,
      noPrice: 0.48,
      yesFeeRateBps: 315,
      noFeeRateBps: 315,
      winProbability: 0.60,
    })
    // Payout: 0.60 * (1-0.0315) + 0.40 * (1-0.0315) = 1.0 * 0.9685 = 0.9685
    // Outlay: 0.98
    // Net: 0.9685 - 0.98 = -0.0115
    expect(ev.netEV).toBeLessThan(0)
    expect(ev.isViable).toBe(false)
  })

  it('winProbability does not matter when fees are equal (symmetric)', () => {
    const ev1 = svc.computeDualSideEV({
      yesPrice: 0.49, noPrice: 0.49,
      yesFeeRateBps: 0, noFeeRateBps: 0,
      winProbability: 0.90,
    })
    const ev2 = svc.computeDualSideEV({
      yesPrice: 0.49, noPrice: 0.49,
      yesFeeRateBps: 0, noFeeRateBps: 0,
      winProbability: 0.10,
    })
    // With equal fees and 0% fee, EV is independent of win probability
    expect(ev1.netEV).toBeCloseTo(ev2.netEV, 6)
  })

  it('barely profitable when combined = 0.995 with 0% maker fee', () => {
    const ev = svc.computeDualSideEV({
      yesPrice: 0.50,
      noPrice: 0.495,
      yesFeeRateBps: 0,
      noFeeRateBps: 0,
      winProbability: 0.50,
    })
    // Outlay: 0.995, Payout: 1.00
    // Net: 0.005 ($0.50 per $100)
    expect(ev.netEV).toBeCloseTo(0.005, 4)
    expect(ev.isViable).toBe(true)
  })

  it('unprofitable when combined >= $1.00 even with 0% fee', () => {
    const ev = svc.computeDualSideEV({
      yesPrice: 0.51,
      noPrice: 0.50,
      yesFeeRateBps: 0,
      noFeeRateBps: 0,
      winProbability: 0.50,
    })
    expect(ev.netEV).toBeLessThan(0)
    expect(ev.isViable).toBe(false)
  })
})

// ==========================================
// KELLY WITH FEES
// ==========================================

describe('DynamicFeeService — feeAdjustedKelly', () => {
  it('returns positive fraction when edge exceeds fee', () => {
    const f = svc.feeAdjustedKelly(0.70, 0.40, 315)
    expect(f).toBeGreaterThan(0)
  })

  it('returns 0 when fee kills edge', () => {
    // modelProb barely above marketPrice, fee kills it
    const f = svc.feeAdjustedKelly(0.42, 0.40, 1000)
    // effectivePayout = 0.90, 0.90 < 0.40 is false, b = (0.90-0.40)/0.40 = 1.25
    // Kelly = (1.25 * 0.42 - 0.58) / 1.25 = (0.525 - 0.58) / 1.25 = -0.044
    // Clamped to 0
    expect(f).toBe(0)
  })

  it('returns higher fraction with lower fees', () => {
    const fHighFee = svc.feeAdjustedKelly(0.60, 0.40, 315)
    const fLowFee = svc.feeAdjustedKelly(0.60, 0.40, 50)
    expect(fLowFee).toBeGreaterThan(fHighFee)
  })

  it('returns 0 for zero or negative probability', () => {
    expect(svc.feeAdjustedKelly(0, 0.40, 315)).toBe(0)
    expect(svc.feeAdjustedKelly(-0.5, 0.40, 315)).toBe(0)
  })
})

// ==========================================
// VIABILITY GATE
// ==========================================

describe('DynamicFeeService — isTradeViable', () => {
  it('returns true for positive EV trades', () => {
    const ev = svc.computeTradeEV({
      modelProb: 0.70, marketPrice: 0.40, tradeSize: 10,
      feeRateBps: 315, isResolutionHold: true,
    })
    expect(svc.isTradeViable(ev)).toBe(true)
  })

  it('respects minimum net edge requirement', () => {
    const ev = svc.computeTradeEV({
      modelProb: 0.45, marketPrice: 0.40, tradeSize: 10,
      feeRateBps: 100, isResolutionHold: true,
    })
    // Small positive edge
    expect(ev.isViable).toBe(true)
    // But may not meet 5% minimum edge
    if (ev.feeAdjustedEdge < 0.05) {
      expect(svc.isTradeViable(ev, 0.05)).toBe(false)
    }
  })

  it('returns false for negative EV trades', () => {
    const ev = svc.computeTradeEV({
      modelProb: 0.42, marketPrice: 0.40, tradeSize: 10,
      feeRateBps: 1000, isResolutionHold: true,
    })
    expect(svc.isTradeViable(ev)).toBe(false)
  })
})
