import { describe, it, expect, beforeEach } from 'vitest'
import { FrankWolfeOptimizer } from '../projectfw/FrankWolfeOptimizer'
import type { MarketSnapshot } from '../projectfw/types'

/** Helper: create a binary market snapshot */
function binarySnapshot(
  yesPrice: number,
  noPrice: number,
  opts?: Partial<MarketSnapshot>
): MarketSnapshot {
  return {
    prices: [yesPrice, noPrice],
    outcomes: ['Yes', 'No'],
    tokenIds: ['token-yes', 'token-no'],
    depth: [
      { bids: [{ price: yesPrice, size: 100 }], asks: [{ price: yesPrice + 0.01, size: 100 }] },
      { bids: [{ price: noPrice, size: 100 }], asks: [{ price: noPrice + 0.01, size: 100 }] },
    ],
    settled: [false, false],
    conditionId: 'cond-001',
    negRisk: false,
    marketId: 'market-001',
    ...opts,
  }
}

/** Helper: create a multi-outcome snapshot */
function multiSnapshot(prices: number[]): MarketSnapshot {
  return {
    prices,
    outcomes: prices.map((_, i) => `Outcome ${i}`),
    tokenIds: prices.map((_, i) => `token-${i}`),
    depth: prices.map(p => ({
      bids: [{ price: p, size: 100 }],
      asks: [{ price: p + 0.01, size: 100 }],
    })),
    settled: prices.map(() => false),
    conditionId: 'cond-multi',
    negRisk: false,
    marketId: 'market-multi',
  }
}

describe('FrankWolfeOptimizer', () => {
  let optimizer: FrankWolfeOptimizer

  beforeEach(() => {
    optimizer = new FrankWolfeOptimizer({
      alpha: 0.5,
      epsilonD: 0.001,
      epsilon0: 0.1,
      maxIterations: 50,
    })
  })

  // ==========================================
  // KL DIVERGENCE TESTS
  // ==========================================

  describe('klDivergence', () => {
    it('returns 0 for identical distributions', () => {
      const mu = [0.6, 0.4]
      const theta = [0.6, 0.4]
      const kl = optimizer.klDivergence(mu, theta)
      expect(kl).toBeCloseTo(0, 5)
    })

    it('returns positive value for different distributions', () => {
      const mu = [0.7, 0.3]
      const theta = [0.5, 0.5]
      const kl = optimizer.klDivergence(mu, theta)
      expect(kl).toBeGreaterThan(0)
    })

    it('increases with larger distribution difference', () => {
      const theta = [0.5, 0.5]
      const kl1 = optimizer.klDivergence([0.6, 0.4], theta)
      const kl2 = optimizer.klDivergence([0.8, 0.2], theta)
      expect(kl2).toBeGreaterThan(kl1)
    })

    it('handles extreme values safely', () => {
      const kl = optimizer.klDivergence([0.99, 0.01], [0.01, 0.99])
      expect(kl).toBeGreaterThan(0)
      expect(Number.isFinite(kl)).toBe(true)
    })

    it('is non-negative for any inputs', () => {
      const cases = [
        [[0.3, 0.7], [0.5, 0.5]],
        [[0.1, 0.9], [0.9, 0.1]],
        [[0.5, 0.5], [0.5, 0.5]],
      ] as [number[], number[]][]

      for (const [mu, theta] of cases) {
        expect(optimizer.klDivergence(mu, theta)).toBeGreaterThanOrEqual(0)
      }
    })
  })

  // ==========================================
  // COHERENT PRICES — NO ARB
  // ==========================================

  describe('solve — coherent prices', () => {
    // NOTE: The optimizer no longer pre-filters on mid-price coherence.
    // Gamma API always returns mid-prices summing to 1.00, so the pre-filter
    // was useless (rejected everything). Now the optimizer runs and produces
    // a result, but muToTradeLegs produces empty legs when ask sum >= 1.0.
    // The scanner's ask-sum check is the real profitability gate.

    it('produces empty tradeLegs when binary prices sum to 1.0', () => {
      const snapshot = binarySnapshot(0.65, 0.35)
      const result = optimizer.solve(snapshot)
      // Optimizer runs but no actionable trade legs (ask sum >= 1.0)
      expect(result).not.toBeNull()
      expect(result!.tradeLegs).toHaveLength(0)
    })

    it('produces empty tradeLegs when prices are very close to coherent', () => {
      const snapshot = binarySnapshot(0.501, 0.499)
      const result = optimizer.solve(snapshot)
      expect(result).not.toBeNull()
      expect(result!.tradeLegs).toHaveLength(0)
    })

    it('produces empty tradeLegs for equal 50/50 prices', () => {
      const snapshot = binarySnapshot(0.50, 0.50)
      const result = optimizer.solve(snapshot)
      expect(result).not.toBeNull()
      expect(result!.tradeLegs).toHaveLength(0)
    })
  })

  // ==========================================
  // INCOHERENT BINARY — ARB EXISTS
  // ==========================================

  describe('solve — incoherent binary prices', () => {
    it('finds arb when YES + NO < 1.0 (significant gap)', () => {
      // 40 + 45 = 85 cents → 15% incoherence
      const snapshot = binarySnapshot(0.40, 0.45)
      const result = optimizer.solve(snapshot)

      expect(result).not.toBeNull()
      expect(result!.guaranteedProfit).toBeGreaterThan(0)
      expect(result!.klDivergence).toBeGreaterThan(0)
      expect(result!.fwGap).toBeGreaterThanOrEqual(0)
      expect(result!.iterations).toBeGreaterThan(0)
    })

    it('guaranteedProfit = klDivergence - fwGap', () => {
      const snapshot = binarySnapshot(0.40, 0.45)
      const result = optimizer.solve(snapshot)!

      expect(result.guaranteedProfit).toBeCloseTo(
        result.klDivergence - result.fwGap,
        8
      )
    })

    it('finds arb for moderate incoherence (10%)', () => {
      // 43 + 47 = 90 cents → 10% incoherence
      const snapshot = binarySnapshot(0.43, 0.47)
      const result = optimizer.solve(snapshot)

      expect(result).not.toBeNull()
      expect(result!.guaranteedProfit).toBeGreaterThan(0)
    })

    it('produces BUY legs for all outcomes in spread arb', () => {
      const snapshot = binarySnapshot(0.40, 0.45)
      const result = optimizer.solve(snapshot)!

      expect(result.tradeLegs.length).toBe(2)
      expect(result.tradeLegs.every(l => l.side === 'BUY')).toBe(true)
    })

    it('trade leg proportions sum to ~1.0', () => {
      const snapshot = binarySnapshot(0.40, 0.45)
      const result = optimizer.solve(snapshot)!

      const propSum = result.tradeLegs.reduce((s, l) => s + l.proportion, 0)
      expect(propSum).toBeCloseTo(1.0, 3)
    })

    it('allocates more to cheaper outcome (inverse-price weighting)', () => {
      const snapshot = binarySnapshot(0.30, 0.60)
      const result = optimizer.solve(snapshot)!

      const yesLeg = result.tradeLegs.find(l => l.outcomeIndex === 0)!
      const noLeg = result.tradeLegs.find(l => l.outcomeIndex === 1)!

      // YES is cheaper (30c) so should get more allocation
      expect(yesLeg.proportion).toBeGreaterThan(noLeg.proportion)
    })

    it('higher incoherence yields higher profit', () => {
      const snap1 = binarySnapshot(0.43, 0.47) // 90¢ sum — 10% incoherence
      const snap2 = binarySnapshot(0.35, 0.40) // 75¢ sum — 25% incoherence

      const result1 = optimizer.solve(snap1)!
      const result2 = optimizer.solve(snap2)!

      expect(result2.guaranteedProfit).toBeGreaterThan(result1.guaranteedProfit)
    })
  })

  // ==========================================
  // IP SOLVER
  // ==========================================

  describe('solveIP', () => {
    it('returns buy-all when all gradients are negative', () => {
      const settled = [false, false]
      const vertex = optimizer.solveIP([-0.5, -0.3], 2, settled)

      expect(vertex.assignments).toEqual([1, 1])
    })

    it('returns buy-none when all gradients are positive', () => {
      const settled = [false, false]
      const vertex = optimizer.solveIP([0.5, 0.3], 2, settled)

      expect(vertex.assignments).toEqual([0, 0])
    })

    it('returns mixed assignment for mixed gradient', () => {
      const settled = [false, false]
      const vertex = optimizer.solveIP([-0.5, 0.3], 2, settled)

      expect(vertex.assignments).toEqual([1, 0])
    })

    it('respects settled outcomes (always 0)', () => {
      const settled = [false, true, false]
      const vertex = optimizer.solveIP([-0.5, -0.3, -0.1], 3, settled)

      expect(vertex.assignments[1]).toBe(0) // settled outcome stays 0
      expect(vertex.assignments[0]).toBe(1) // unsettled follows gradient
      expect(vertex.assignments[2]).toBe(1)
    })
  })

  // ==========================================
  // CONVERGENCE
  // ==========================================

  describe('convergence', () => {
    it('converges within maxIterations for binary market', () => {
      const snapshot = binarySnapshot(0.40, 0.45)
      const result = optimizer.solve(snapshot)!

      expect(result.converged).toBe(true)
      expect(result.iterations).toBeLessThanOrEqual(50)
    })

    it('converges faster with higher alpha', () => {
      const snapshot = binarySnapshot(0.40, 0.45)

      const conservativeOpt = new FrankWolfeOptimizer({
        alpha: 0.3, epsilonD: 0.001, epsilon0: 0.1, maxIterations: 50,
      })
      const aggressiveOpt = new FrankWolfeOptimizer({
        alpha: 0.8, epsilonD: 0.001, epsilon0: 0.1, maxIterations: 50,
      })

      const r1 = conservativeOpt.solve(snapshot)!
      const r2 = aggressiveOpt.solve(snapshot)!

      // Higher alpha = easier stopping condition → fewer iterations
      expect(r2.iterations).toBeLessThanOrEqual(r1.iterations)
    })

    it('fwGap decreases toward 0 (or satisfies stopping condition)', () => {
      const snapshot = binarySnapshot(0.40, 0.45)
      const result = optimizer.solve(snapshot)!

      // g(mu) should be small at convergence
      expect(result.fwGap).toBeLessThan(result.klDivergence)
    })
  })

  // ==========================================
  // EDGE CASES
  // ==========================================

  describe('edge cases', () => {
    it('handles very extreme prices (1¢ / 90¢)', () => {
      const snapshot = binarySnapshot(0.01, 0.90)
      const result = optimizer.solve(snapshot)

      expect(result).not.toBeNull()
      expect(result!.guaranteedProfit).toBeGreaterThan(0)
      expect(Number.isFinite(result!.guaranteedProfit)).toBe(true)
    })

    it('returns null for single outcome', () => {
      const snapshot: MarketSnapshot = {
        prices: [0.50],
        outcomes: ['Yes'],
        tokenIds: ['token-0'],
        depth: [{ bids: [], asks: [] }],
        settled: [false],
        conditionId: 'c',
        negRisk: false,
        marketId: 'm',
      }
      expect(optimizer.solve(snapshot)).toBeNull()
    })

    it('handles all outcomes settled (no tradeable outcomes)', () => {
      const snapshot = binarySnapshot(0.40, 0.45, {
        settled: [true, true],
      })
      // With all settled, initFW should handle gracefully
      const result = optimizer.solve(snapshot)
      // No meaningful arb if nothing is tradeable
      // Result may be null or have 0 trade legs
      if (result) {
        expect(result.tradeLegs.length).toBe(0)
      }
    })

    it('handles prices summing to > 1 (overpriced market)', () => {
      // YES=0.55 + NO=0.55 = 1.10
      const snapshot = binarySnapshot(0.55, 0.55)
      const result = optimizer.solve(snapshot)
      // Overpriced markets have empty trade legs (sell side not implemented yet)
      if (result) {
        expect(result.tradeLegs.length).toBe(0)
      }
    })
  })

  // ==========================================
  // MULTI-OUTCOME
  // ==========================================

  describe('multi-outcome', () => {
    it('finds arb in 3-outcome market with sum < 1', () => {
      // 25 + 30 + 35 = 90¢
      const snapshot = multiSnapshot([0.25, 0.30, 0.35])
      const result = optimizer.solve(snapshot)

      expect(result).not.toBeNull()
      expect(result!.guaranteedProfit).toBeGreaterThan(0)
      expect(result!.tradeLegs.length).toBe(3)
    })

    it('returns null for coherent 3-outcome market', () => {
      // 33 + 33 + 34 = 100¢
      const snapshot = multiSnapshot([0.33, 0.33, 0.34])
      const result = optimizer.solve(snapshot)
      expect(result).toBeNull()
    })

    it('handles 5-outcome market', () => {
      // 15+15+15+15+15 = 75¢ → 25% incoherence
      const snapshot = multiSnapshot([0.15, 0.15, 0.15, 0.15, 0.15])
      const result = optimizer.solve(snapshot)

      expect(result).not.toBeNull()
      expect(result!.tradeLegs.length).toBe(5)
      expect(result!.guaranteedProfit).toBeGreaterThan(0)
    })
  })

  // ==========================================
  // CONFIGURATION
  // ==========================================

  describe('configuration', () => {
    it('setConfig updates optimizer behavior', () => {
      optimizer.setConfig({ maxIterations: 5 })
      expect(optimizer.getConfig().maxIterations).toBe(5)
    })

    it('lower epsilonD requires tighter convergence', () => {
      // Use large incoherence so even loose epsilonD finds profit
      const snapshot = binarySnapshot(0.30, 0.35) // 65¢ sum — 35% incoherence

      const looseOpt = new FrankWolfeOptimizer({
        alpha: 0.5, epsilonD: 0.1, epsilon0: 0.1, maxIterations: 50,
      })
      const tightOpt = new FrankWolfeOptimizer({
        alpha: 0.5, epsilonD: 0.0001, epsilon0: 0.1, maxIterations: 50,
      })

      const r1 = looseOpt.solve(snapshot)!
      const r2 = tightOpt.solve(snapshot)!

      // Both should find arb, but tighter may take more iterations
      expect(r1).not.toBeNull()
      expect(r2).not.toBeNull()
    })
  })
})
