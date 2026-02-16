/**
 * Tests for the Bregman Projection paper's arbitrage profit formula:
 *
 *   π_i(t) = max(0, |y_i| − N_i · γ_i)
 *
 * Where |y_i| = |p_i(t) − k| (price deviation from bundle cost $1),
 * N_i = number of trade legs, γ_i = per-leg taker fee.
 *
 * Tests cover both paths:
 *   - UNDERPRICED: askSum < $1.00 → buy all, merge
 *   - OVERPRICED:  bidSum > $1.00 → Buy-a-Bundle, sell at bids
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ArbitrageScanner, type ScannerConfig } from '../projectfw/ArbitrageScanner'
import type { FWOptimizerConfig } from '../projectfw/types'

const DEFAULT_OPTIMIZER_CONFIG: FWOptimizerConfig = {
  alpha: 0.5,
  epsilonD: 0.001,
  epsilon0: 0.1,
  maxIterations: 50,
}

function makeScanner(overrides?: Partial<ScannerConfig>) {
  const config: ScannerConfig = {
    minLiquidity: 50,
    minVolume24h: 10,
    maxSpreadBps: 500,
    minProfitBps: 50,
    takerFeeBps: 100, // 1% per leg
    gasEstimateUSD: 0.01,
    enableMultiOutcome: false,
    tradeSize: 100,
    ...overrides,
  }
  return new ArbitrageScanner(DEFAULT_OPTIMIZER_CONFIG, config)
}

// ==========================================
// computeNetProfit — Paper formula for underpriced bundles
// π = max(0, priceDeviation * tradeSize - N·γ) - gas
// priceDeviation = (1 - askSum) for underpriced, (bidSum - 1) for overpriced
// NOT the optimizer's KL-based guaranteedProfit (which is in nats)
// ==========================================

describe('computeNetProfit — paper formula π_i(t)', () => {
  let scanner: ArbitrageScanner

  beforeEach(() => {
    scanner = makeScanner()
  })

  it('returns positive profit when deviation exceeds fees', () => {
    // priceDeviation = 0.05 (askSum = 0.95), tradeSize = $100
    // grossProfit = 0.05 * $100 = $5.00
    // perLegFee = (100/10000) * 100 = $1.00
    // 2 legs = $2.00 total fees
    // π = max(0, 5.00 - 2.00) - 0.01 = $2.99
    const profit = scanner.computeNetProfit(0.05, 2)
    expect(profit).toBeCloseTo(2.99, 2)
  })

  it('returns zero (minus gas) when deviation equals fees exactly', () => {
    // grossProfit = 0.02 * $100 = $2.00
    // 2 legs × $1.00 = $2.00 fees
    // π = max(0, 2.00 - 2.00) - 0.01 = -$0.01
    const profit = scanner.computeNetProfit(0.02, 2)
    expect(profit).toBeCloseTo(-0.01, 2)
  })

  it('hard-gates micro-incoherence to zero via max(0, ...)', () => {
    // grossProfit = 0.005 * $100 = $0.50
    // 2 legs × $1.00 = $2.00 fees >> $0.50 gross
    // OLD formula: 0.50 - 2.00 - 0.01 = -$1.51 (misleading negative)
    // NEW formula: max(0, 0.50 - 2.00) - 0.01 = max(0, -1.50) - 0.01 = -$0.01
    // The max(0, ...) clamps the fee-eaten portion to zero — only gas leaks through
    const profit = scanner.computeNetProfit(0.005, 2)
    expect(profit).toBe(-0.01) // Only gas cost, not a misleading -$1.51
  })

  it('scales linearly with priceDeviation', () => {
    const profit1 = scanner.computeNetProfit(0.10, 2) // askSum=0.90, 10% deviation
    const profit2 = scanner.computeNetProfit(0.20, 2) // askSum=0.80, 20% deviation

    // Double the deviation ≈ double the profit (fees are constant)
    expect(profit2).toBeGreaterThan(profit1)
    // profit1 = max(0, 10 - 2) - 0.01 = 7.99
    // profit2 = max(0, 20 - 2) - 0.01 = 17.99
    expect(profit1).toBeCloseTo(7.99, 2)
    expect(profit2).toBeCloseTo(17.99, 2)
  })

  it('more legs increase the fee threshold (paper: N_i·γ_i)', () => {
    // Same gross, 2 legs vs 5 legs
    const profit2 = scanner.computeNetProfit(0.05, 2) // 2 × $1 = $2 fees
    const profit5 = scanner.computeNetProfit(0.05, 5) // 5 × $1 = $5 fees

    // profit2 = max(0, 5 - 2) - 0.01 = 2.99
    // profit5 = max(0, 5 - 5) - 0.01 = -0.01
    expect(profit2).toBeCloseTo(2.99, 2)
    expect(profit5).toBeCloseTo(-0.01, 2)
  })

  it('works with different fee rates', () => {
    const lowFeeScanner = makeScanner({ takerFeeBps: 50 }) // 0.5%
    const highFeeScanner = makeScanner({ takerFeeBps: 200 }) // 2%

    // grossProfit = 0.05 * $100 = $5.00, 2 legs
    const lowProfit = lowFeeScanner.computeNetProfit(0.05, 2)  // 2 × $0.50 = $1.00
    const highProfit = highFeeScanner.computeNetProfit(0.05, 2) // 2 × $2.00 = $4.00

    expect(lowProfit).toBeCloseTo(3.99, 2)  // max(0, 5 - 1) - 0.01
    expect(highProfit).toBeCloseTo(0.99, 2)  // max(0, 5 - 4) - 0.01
  })

  it('works with different trade sizes', () => {
    const smallScanner = makeScanner({ tradeSize: 10 })
    const largeScanner = makeScanner({ tradeSize: 1000 })

    // Same ratio, 2 legs
    const smallProfit = smallScanner.computeNetProfit(0.05, 2)
    const largeProfit = largeScanner.computeNetProfit(0.05, 2)

    // small: max(0, 0.5 - 0.2) - 0.01 = 0.29
    // large: max(0, 50 - 20) - 0.01 = 29.99
    expect(smallProfit).toBeCloseTo(0.29, 2)
    expect(largeProfit).toBeCloseTo(29.99, 2)
  })
})

// ==========================================
// computeOverpricedProfit — Paper formula for overpriced bundles
// π = max(0, (bidSum - 1) * tradeSize - N·γ) - gas
// ==========================================

describe('computeOverpricedProfit — overpriced bundle path', () => {
  let scanner: ArbitrageScanner

  beforeEach(() => {
    scanner = makeScanner()
  })

  it('returns positive profit when bidSum sufficiently exceeds $1', () => {
    // bidSum = 1.05, tradeSize = 100
    // gross = 0.05 * 100 = $5.00
    // 2 legs × $1.00 = $2.00 fees
    // π = max(0, 5 - 2) - 0.01 = $2.99
    const profit = scanner.computeOverpricedProfit(1.05, 2)
    expect(profit).toBeCloseTo(2.99, 2)
  })

  it('returns zero (minus gas) when overpricing barely covers fees', () => {
    // bidSum = 1.02, 2 legs × $1.00 = $2.00 fees
    // gross = 0.02 * 100 = $2.00
    // π = max(0, 2 - 2) - 0.01 = -$0.01
    const profit = scanner.computeOverpricedProfit(1.02, 2)
    expect(profit).toBeCloseTo(-0.01, 2)
  })

  it('hard-gates small overpricing via max(0, ...)', () => {
    // bidSum = 1.005, gross = $0.50, 2 legs = $2.00 fees
    // π = max(0, 0.50 - 2.00) - 0.01 = -$0.01
    const profit = scanner.computeOverpricedProfit(1.005, 2)
    expect(profit).toBe(-0.01) // Only gas
  })

  it('is symmetric with underpriced path for same deviation', () => {
    // 5% underpriced: guaranteedProfit = 0.05 → gross = $5
    // 5% overpriced: bidSum = 1.05 → gross = $5
    // Same fees, same result
    const underpriced = scanner.computeNetProfit(0.05, 2)
    const overpriced = scanner.computeOverpricedProfit(1.05, 2)
    expect(underpriced).toBeCloseTo(overpriced, 2)
  })

  it('Buy-a-Bundle avoids double fee (paper: N·γ not 2N·γ)', () => {
    // Paper says short-sell-and-cover costs 2N·γ, but Buy-a-Bundle = N·γ
    // bidSum = 1.10, 2 legs
    // With Buy-a-Bundle (our impl): max(0, 10 - 2) - 0.01 = $7.99
    // If short-sell-and-cover: max(0, 10 - 4) - 0.01 = $5.99
    const profit = scanner.computeOverpricedProfit(1.10, 2)
    expect(profit).toBeCloseTo(7.99, 2) // N·γ, not 2N·γ
  })

  it('handles multi-outcome overpriced markets', () => {
    // 5-outcome market, bidSum = 1.08
    // gross = 0.08 * 100 = $8.00
    // 5 legs × $1.00 = $5.00 fees
    // π = max(0, 8 - 5) - 0.01 = $2.99
    const profit = scanner.computeOverpricedProfit(1.08, 5)
    expect(profit).toBeCloseTo(2.99, 2)
  })
})

// ==========================================
// Boundary conditions and edge cases
// ==========================================

describe('profit formula edge cases', () => {
  let scanner: ArbitrageScanner

  beforeEach(() => {
    scanner = makeScanner()
  })

  it('zero gas scanner produces max(0, ...) exactly', () => {
    const zeroGasScanner = makeScanner({ gasEstimateUSD: 0 })
    // gross = 0.05 * 100 = 5, fees = 2
    const profit = zeroGasScanner.computeNetProfit(0.05, 2)
    expect(profit).toBe(3) // max(0, 5 - 2) - 0 = exactly 3
  })

  it('zero incoherence produces exactly -gas', () => {
    const profit = scanner.computeNetProfit(0, 2)
    expect(profit).toBe(-0.01) // max(0, 0 - 2) - 0.01
  })

  it('single leg (theoretical) has lower fee threshold', () => {
    // 1 leg: fee = 1 × $1.00, gross needs > $1.00
    const profit1 = scanner.computeNetProfit(0.015, 1) // gross = $1.50, fee = $1.00
    const profit2 = scanner.computeNetProfit(0.015, 2) // gross = $1.50, fee = $2.00

    expect(profit1).toBeGreaterThan(0)  // max(0, 1.50 - 1.00) - 0.01 = 0.49
    expect(profit2).toBeLessThan(0)     // max(0, 1.50 - 2.00) - 0.01 = -0.01
  })

  it('overpriced bidSum exactly 1.0 yields only negative gas', () => {
    const profit = scanner.computeOverpricedProfit(1.0, 2)
    expect(profit).toBe(-0.01) // max(0, 0 - 2) - 0.01
  })

  it('high fee rate (10% crypto markets) makes most arbs unprofitable', () => {
    const cryptoScanner = makeScanner({ takerFeeBps: 1000 }) // 10%
    // gross = 0.05 * 100 = $5.00, 2 legs × $10.00 = $20 fees
    const profit = cryptoScanner.computeNetProfit(0.05, 2)
    expect(profit).toBe(-0.01) // Fees completely eat the profit
  })
})

// ==========================================
// computeVWAP — Volume-Weighted Average Price from order book depth
// ==========================================

describe('computeVWAP — depth-aware pricing', () => {
  it('single level fills entirely', () => {
    const levels = [{ price: 0.50, size: 200 }] // 200 shares × $0.50 = $100
    const result = ArbitrageScanner.computeVWAP(levels, 100) // tradeSize $100
    expect(result).not.toBeNull()
    expect(result!.vwap).toBeCloseTo(0.50, 4)
    expect(result!.fillableUSD).toBeCloseTo(100, 2)
    expect(result!.sufficient).toBe(true)
  })

  it('multi-level walks through progressively worse prices', () => {
    // Level 1: 50 shares × $0.50 = $25
    // Level 2: 100 shares × $0.55 = $55 → cumulative $80
    // Level 3: 200 shares × $0.60 = $120 → need only $20 more
    const levels = [
      { price: 0.50, size: 50 },
      { price: 0.55, size: 100 },
      { price: 0.60, size: 200 },
    ]
    const result = ArbitrageScanner.computeVWAP(levels, 100)
    expect(result).not.toBeNull()
    expect(result!.sufficient).toBe(true)
    expect(result!.fillableUSD).toBeCloseTo(100, 1)
    // VWAP should be between 0.50 and 0.60 (weighted toward cheaper levels)
    expect(result!.vwap).toBeGreaterThan(0.50)
    expect(result!.vwap).toBeLessThan(0.60)
  })

  it('insufficient depth marks as not sufficient when < 50% fill', () => {
    const levels = [{ price: 0.50, size: 10 }] // 10 shares × $0.50 = $5 (5% of $100)
    const result = ArbitrageScanner.computeVWAP(levels, 100)
    expect(result).not.toBeNull()
    expect(result!.sufficient).toBe(false)
    expect(result!.fillableUSD).toBeCloseTo(5, 2)
  })

  it('empty levels returns null', () => {
    expect(ArbitrageScanner.computeVWAP([], 100)).toBeNull()
  })

  it('null/undefined levels returns null', () => {
    expect(ArbitrageScanner.computeVWAP(null as any, 100)).toBeNull()
    expect(ArbitrageScanner.computeVWAP(undefined as any, 100)).toBeNull()
  })

  it('skips levels with zero or negative price/size', () => {
    const levels = [
      { price: 0, size: 100 },    // skip
      { price: 0.50, size: 0 },   // skip
      { price: 0.60, size: 200 }, // only valid level
    ]
    const result = ArbitrageScanner.computeVWAP(levels, 100)
    expect(result).not.toBeNull()
    expect(result!.vwap).toBeCloseTo(0.60, 4)
  })

  it('exactly 50% fill is sufficient', () => {
    const levels = [{ price: 0.50, size: 100 }] // $50 = exactly 50% of $100
    const result = ArbitrageScanner.computeVWAP(levels, 100)
    expect(result).not.toBeNull()
    expect(result!.sufficient).toBe(true)
    expect(result!.fillableUSD).toBeCloseTo(50, 2)
  })
})

// ==========================================
// Dynamic fee override — feeRateBps parameter
// ==========================================

describe('computeNetProfit with feeRateBps override', () => {
  let scanner: ArbitrageScanner

  beforeEach(() => {
    scanner = makeScanner({ takerFeeBps: 100 }) // config = 1%
  })

  it('override with crypto fee (1000 bps) eats profit', () => {
    // gross = 0.05 * 100 = $5.00
    // 2 legs × (1000/10000 * 100) = 2 × $10 = $20 fees
    // max(0, 5 - 20) - 0.01 = -$0.01
    const profit = scanner.computeNetProfit(0.05, 2, 1000)
    expect(profit).toBe(-0.01)
  })

  it('override with zero fee gives max profit', () => {
    // gross = 0.05 * 100 = $5.00, 0 fees
    // max(0, 5 - 0) - 0.01 = $4.99
    const profit = scanner.computeNetProfit(0.05, 2, 0)
    expect(profit).toBeCloseTo(4.99, 2)
  })

  it('undefined override falls back to config takerFeeBps', () => {
    // Should produce same result as without override
    const withOverride = scanner.computeNetProfit(0.05, 2, undefined)
    const withoutOverride = scanner.computeNetProfit(0.05, 2)
    expect(withOverride).toBe(withoutOverride)
  })
})

describe('computeOverpricedProfit with feeRateBps override', () => {
  let scanner: ArbitrageScanner

  beforeEach(() => {
    scanner = makeScanner({ takerFeeBps: 100 })
  })

  it('override with low fee increases profit', () => {
    // bidSum = 1.05, gross = $5.00, 2 legs × (50/10000 * 100) = 2 × $0.50 = $1
    // max(0, 5 - 1) - 0.01 = $3.99
    const profit = scanner.computeOverpricedProfit(1.05, 2, 50)
    expect(profit).toBeCloseTo(3.99, 2)
  })

  it('override with crypto fee kills overpriced arb', () => {
    // bidSum = 1.05, gross = $5.00, 2 legs × (1000/10000 * 100) = $20
    // max(0, 5 - 20) - 0.01 = -$0.01
    const profit = scanner.computeOverpricedProfit(1.05, 2, 1000)
    expect(profit).toBe(-0.01)
  })
})
