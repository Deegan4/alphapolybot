import type {
  FWOptimizerConfig,
  FWOptimizationResult,
  MarketSnapshot,
  TradeVertex,
  TradeLeg,
} from './types'

// Numerical safety bounds
const EPS = 1e-10
const MIN_MU = 1e-8
const MAX_MU = 1 - 1e-8

/** Clamp a value to [lo, hi] */
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

/** Dot product of two arrays */
function dot(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

/** Element-wise subtraction: a - b */
function subtract(a: number[], b: number[]): number[] {
  return a.map((ai, i) => ai - b[i])
}

/**
 * FrankWolfeOptimizer — Implements Algorithm 2 (ProjectFW) and Algorithm 3 (InitFW)
 * from the Bregman Projection paper for prediction market arbitrage.
 *
 * Pure computational class with no service dependencies.
 * For binary markets (N=2), the IP solver enumerates all 4 vertices — O(1) per call.
 * For multi-outcome (N>2), uses greedy per-security assignment — O(N) per call.
 * Total runtime: sub-millisecond for typical market sizes.
 */
export class FrankWolfeOptimizer {
  private config: FWOptimizerConfig

  constructor(config: FWOptimizerConfig) {
    this.config = config
  }

  /**
   * Algorithm 2: ProjectFW — Main optimization loop.
   *
   * Given a market snapshot with prices theta[], finds the optimal trade bundle
   * that maximizes guaranteed profit = D(mu||theta) - g(mu).
   *
   * @returns Optimization result, or null if no profitable arbitrage exists
   */
  solve(snapshot: MarketSnapshot): FWOptimizationResult | null {
    const n = snapshot.prices.length
    if (n < 2) return null

    const theta = snapshot.prices.map(p => clamp(p, MIN_MU, MAX_MU))

    // NOTE: No coherence pre-filter on mid-prices. Gamma API always returns
    // prices summing to exactly 1.00. Real profitability comes from order book
    // ask prices (checked in muToTradeLegs). The optimizer runs on mid-prices
    // to find the optimal allocation, then muToTradeLegs uses actual ask prices.

    // Algorithm 3: InitFW — find interior point and initial vertex set
    const init = this.initFW(theta, snapshot)
    if (!init) return null

    const { u } = init
    let { activeSet } = init
    let epsilon = this.config.epsilon0
    let mu = [...u]
    let lastFwGap = Infinity

    for (let t = 0; t < this.config.maxIterations; t++) {
      // Contract active set: Z' = (1 - epsilon) * Z + epsilon * u
      const contractedVertices = this.contractActiveSet(activeSet, u, epsilon)

      // Minimize F(mu) over conv(contractedVertices)
      mu = this.minimizeOverConvexHull(contractedVertices, theta)

      // Compute gradient: theta_t = nabla R_bar(mu_t)
      // For Bernoulli: nabla R_bar(mu)_i = ln(mu_i / (1 - mu_i))
      const thetaT = mu.map(m => {
        const mc = clamp(m, MIN_MU, MAX_MU)
        return Math.log(mc / (1 - mc))
      })

      // Gradient of F: nabla F(mu) = theta_t - theta
      const gradient = subtract(thetaT, theta)

      // IP solver: find descent vertex z_t = argmin_{z in Z} gradient . z
      const zt = this.solveIP(gradient, n, snapshot.settled)

      // Add descent vertex to active set
      activeSet = [...contractedVertices, zt]

      // FW gap: g(mu) = gradient . (mu - z_t.mu)
      const fwGap = dot(gradient, subtract(mu, zt.mu))
      lastFwGap = fwGap

      // Objective: F(mu)
      const Fmu = this.computeObjective(mu, theta)
      const klDiv = this.klDivergence(mu, theta)

      // Check stopping conditions (Proposition 4.1 from paper)
      const gapCondition = fwGap <= (1 - this.config.alpha) * Fmu
      const convergenceCondition = Fmu <= this.config.epsilonD
      const terminated = false // No external interruption in browser context

      if (gapCondition || convergenceCondition || terminated) {
        const guaranteedProfit = klDiv - fwGap
        if (guaranteedProfit <= 0) return null

        return {
          mu,
          guaranteedProfit,
          fwGap,
          klDivergence: klDiv,
          iterations: t + 1,
          converged: true,
          tradeLegs: this.muToTradeLegs(mu, theta, snapshot),
        }
      }

      // Adapt contraction epsilon (Krishnan et al. 2015 rule)
      const gu = dot(subtract(thetaT, theta), subtract(mu, u))
      if (gu < 0 && fwGap / (-4 * gu) < epsilon) {
        epsilon = Math.min(fwGap / (-4 * gu), epsilon / 2)
      }
    }

    // Did not converge — check if current solution is still profitable
    const klDiv = this.klDivergence(mu, theta)
    const profit = klDiv - lastFwGap
    if (profit > 0) {
      return {
        mu,
        guaranteedProfit: profit,
        fwGap: lastFwGap,
        klDivergence: klDiv,
        iterations: this.config.maxIterations,
        converged: false,
        tradeLegs: this.muToTradeLegs(mu, theta, snapshot),
      }
    }

    return null
  }

  /**
   * Algorithm 3: InitFW — Initialization for ProjectFW.
   *
   * Finds an interior point u (strictly between 0 and 1 for all unsettled outcomes)
   * and an initial non-empty vertex set Z0.
   *
   * For each unsettled outcome i and each direction b in {0, 1}:
   *   - Find the vertex z that maximizes (2b-1) * z_i over all feasible vertices
   *   - If z_i == b, add z to Z0 (this direction is feasible)
   *   - Otherwise, outcome i is forced to value (1-b), extend partial outcome
   *
   * @returns Interior point u and initial active vertex set, or null if infeasible
   */
  initFW(
    theta: number[],
    snapshot: MarketSnapshot
  ): { u: number[]; activeSet: TradeVertex[] } | null {
    const n = theta.length
    const unsettled = snapshot.settled.map(s => !s)

    // For prediction markets, all vertices are {0,1}^n with the constraint
    // that exactly one outcome can be 1 (probability simplex vertices)
    // For binary: vertices are (1,0) and (0,1) plus the "no trade" vertex
    // For the full model: vertices are all unit vectors plus the zero vector

    // Generate all feasible vertices for the polytope
    const allVertices = this.generateVertices(n, unsettled)
    if (allVertices.length === 0) return null

    const z0: TradeVertex[] = []
    const covered = new Set<string>() // Track (i, z_i) pairs already covered

    // For each unsettled outcome i and each direction b ∈ {0, 1}
    for (let i = 0; i < n; i++) {
      if (!unsettled[i]) continue

      for (const b of [0, 1]) {
        const key = `${i},${b}`
        if (covered.has(key)) continue

        // Find z that maximizes (2b - 1) * z_i over all vertices
        const direction = 2 * b - 1 // +1 for b=1, -1 for b=0
        let bestVertex: TradeVertex | null = null
        let bestScore = -Infinity

        for (const v of allVertices) {
          const score = direction * v.mu[i]
          if (score > bestScore) {
            bestScore = score
            bestVertex = v
          }
        }

        if (!bestVertex) continue

        if (bestVertex.mu[i] === b) {
          // This direction is feasible — add vertex to Z0
          z0.push(bestVertex)
          // Mark all (j, bestVertex.mu[j]) as covered
          for (let j = 0; j < n; j++) {
            covered.add(`${j},${bestVertex.mu[j]}`)
          }
        }
        // If bestVertex.mu[i] != b, outcome i is forced — extend partial outcome
        // (For binary markets this means one direction is already determined)
      }
    }

    // If Z0 is empty, find the unique vertex compatible with the extended partial outcome
    if (z0.length === 0) {
      // Fall back to the vertex closest to the interior
      const midVertex: TradeVertex = {
        assignments: theta.map(t => (t >= 0.5 ? 1 : 0)),
        mu: theta.map(t => (t >= 0.5 ? 1 : 0)),
      }
      z0.push(midVertex)
    }

    // Interior point u = average of all Z0 vertices (strictly in (0,1) for unsettled)
    const u = new Array(n).fill(0)
    for (const v of z0) {
      for (let i = 0; i < n; i++) {
        u[i] += v.mu[i]
      }
    }
    for (let i = 0; i < n; i++) {
      u[i] /= z0.length
      // Ensure strict interiority for unsettled outcomes
      if (unsettled[i]) {
        u[i] = clamp(u[i], 0.1, 0.9)
      }
    }

    return { u, activeSet: z0 }
  }

  /**
   * Generate all feasible vertices of the trade polytope.
   *
   * For binary markets (n=2): 4 vertices — {(0,0), (0,1), (1,0), (1,1)}
   * These represent: no trade, buy NO only, buy YES only, buy both.
   *
   * For multi-outcome (n>2): 2^n vertices, but we only generate up to
   * a manageable limit (64 for n<=6, otherwise use greedy).
   */
  private generateVertices(n: number, unsettled: boolean[]): TradeVertex[] {
    // For small n (≤6), enumerate all 2^n vertices
    if (n <= 6) {
      const vertices: TradeVertex[] = []
      const total = 1 << n // 2^n
      for (let mask = 0; mask < total; mask++) {
        const assignments: number[] = []
        const mu: number[] = []
        for (let i = 0; i < n; i++) {
          const bit = (mask >> i) & 1
          assignments.push(unsettled[i] ? bit : 0)
          mu.push(unsettled[i] ? bit : 0)
        }
        vertices.push({ assignments, mu })
      }
      return vertices
    }

    // For large n, generate only the unit vectors + zero vector
    // (greedy IP solver handles the rest)
    const vertices: TradeVertex[] = []

    // Zero vector: don't buy anything
    vertices.push({
      assignments: new Array(n).fill(0),
      mu: new Array(n).fill(0),
    })

    // Unit vectors: buy exactly one outcome
    for (let i = 0; i < n; i++) {
      if (!unsettled[i]) continue
      const a = new Array(n).fill(0)
      a[i] = 1
      vertices.push({ assignments: [...a], mu: [...a] })
    }

    // All-ones vector: buy all outcomes
    const allOnes = unsettled.map(u => (u ? 1 : 0))
    vertices.push({ assignments: [...allOnes], mu: [...allOnes] })

    return vertices
  }

  /**
   * IP Solver: find descent vertex z = argmin_{z in Z} gradient . z
   *
   * For binary (n=2): enumerate all 4 vertices, pick minimum — O(1).
   * For multi-outcome: greedy per-outcome assignment — O(n).
   *   For each unsettled outcome i:
   *     if gradient[i] < 0 → assign 1 (buy this outcome)
   *     if gradient[i] >= 0 → assign 0 (don't buy)
   */
  solveIP(gradient: number[], n: number, settled: boolean[]): TradeVertex {
    const assignments: number[] = new Array(n).fill(0)
    const mu: number[] = new Array(n).fill(0)

    for (let i = 0; i < n; i++) {
      if (settled[i]) continue
      // Greedy: choose direction that minimizes gradient . z
      // If gradient[i] < 0, setting z_i = 1 reduces the dot product
      if (gradient[i] < 0) {
        assignments[i] = 1
        mu[i] = 1
      }
      // Otherwise leave at 0
    }

    return { assignments, mu }
  }

  /**
   * Contract the active set toward the interior point u.
   * Z' = (1 - epsilon) * Z + epsilon * u
   */
  private contractActiveSet(
    vertices: TradeVertex[],
    u: number[],
    epsilon: number
  ): TradeVertex[] {
    return vertices.map(v => ({
      assignments: v.assignments, // Keep original assignments for reference
      mu: v.mu.map((mi, i) => (1 - epsilon) * mi + epsilon * u[i]),
    }))
  }

  /**
   * Minimize F(mu) = R_bar(mu) - theta.mu + C(theta) over the convex hull
   * of the given vertices.
   *
   * For small vertex sets (≤10), use iterative projected gradient descent.
   * F is convex, so gradient descent converges.
   *
   * Gradient: nabla F(mu) = nabla R_bar(mu) - theta
   *   where nabla R_bar(mu)_i = ln(mu_i / (1 - mu_i))
   */
  minimizeOverConvexHull(vertices: TradeVertex[], theta: number[]): number[] {
    if (vertices.length === 0) {
      return theta.map(t => clamp(t, MIN_MU, MAX_MU))
    }

    if (vertices.length === 1) {
      return vertices[0].mu.map(m => clamp(m, MIN_MU, MAX_MU))
    }

    const n = theta.length
    const k = vertices.length

    // Start with uniform weights over vertices
    let weights = new Array(k).fill(1 / k)
    let mu = this.convexCombination(vertices, weights, n)

    // Gradient descent on weights with Bregman objective
    const stepSize = 0.1
    const innerIterations = 20

    for (let iter = 0; iter < innerIterations; iter++) {
      // Gradient of F with respect to mu
      const gradF = mu.map((m, i) => {
        const mc = clamp(m, MIN_MU, MAX_MU)
        return Math.log(mc / (1 - mc)) - theta[i]
      })

      // Gradient with respect to weights: dF/dw_j = gradF . v_j.mu
      const gradW = vertices.map(v => dot(gradF, v.mu))

      // Gradient step on weights
      let newWeights = weights.map((w, j) => w - stepSize * gradW[j])

      // Project onto simplex (weights >= 0, sum = 1)
      newWeights = this.projectOntoSimplex(newWeights)

      weights = newWeights
      mu = this.convexCombination(vertices, weights, n)
    }

    return mu.map(m => clamp(m, MIN_MU, MAX_MU))
  }

  /**
   * Compute convex combination: mu = sum(w_j * v_j.mu)
   */
  private convexCombination(
    vertices: TradeVertex[],
    weights: number[],
    n: number
  ): number[] {
    const result = new Array(n).fill(0)
    for (let j = 0; j < vertices.length; j++) {
      for (let i = 0; i < n; i++) {
        result[i] += weights[j] * vertices[j].mu[i]
      }
    }
    return result
  }

  /**
   * Project a vector onto the probability simplex (Duchi et al. 2008).
   * Ensures: all weights >= 0 and sum(weights) = 1.
   */
  private projectOntoSimplex(v: number[]): number[] {
    const n = v.length
    const sorted = [...v].sort((a, b) => b - a)
    let cumSum = 0
    let t = 0

    for (let i = 0; i < n; i++) {
      cumSum += sorted[i]
      const candidate = (cumSum - 1) / (i + 1)
      if (sorted[i] - candidate > 0) {
        t = candidate
      }
    }

    return v.map(vi => Math.max(vi - t, 0))
  }

  /**
   * KL divergence for Bernoulli variables:
   * D(mu || theta) = sum_i [mu_i * ln(mu_i / theta_i) + (1 - mu_i) * ln((1 - mu_i) / (1 - theta_i))]
   *
   * This measures how "wrong" the market prices theta are relative to the
   * optimal distribution mu. Higher divergence = more arbitrage profit available.
   */
  klDivergence(mu: number[], theta: number[]): number {
    let kl = 0
    for (let i = 0; i < mu.length; i++) {
      const m = clamp(mu[i], MIN_MU, MAX_MU)
      const t = clamp(theta[i], MIN_MU, MAX_MU)
      kl += m * Math.log(m / t) + (1 - m) * Math.log((1 - m) / (1 - t))
    }
    return Math.max(kl, 0)
  }

  /**
   * Compute the objective function:
   * F(mu) = R_bar(mu) - theta . mu + C(theta)
   *
   * Where:
   *   R_bar(mu) = sum_i [mu_i * ln(mu_i) + (1 - mu_i) * ln(1 - mu_i)]  (neg entropy)
   *   C(theta) = sum_i [ln(1 + exp(theta_i))]  (log-partition)
   *
   * For our use case with prices in [0,1] rather than log-odds:
   *   We work in probability space directly, so theta_i are prices.
   *   R_bar(mu) is the negative binary entropy.
   *   F(mu) = D(mu || theta) when theta are valid probabilities.
   */
  computeObjective(mu: number[], theta: number[]): number {
    // F(mu) = D(mu || theta) = KL divergence
    // This is because the Bregman divergence with R = negative entropy
    // equals the KL divergence.
    return this.klDivergence(mu, theta)
  }

  /**
   * Translate optimal mu into concrete trade legs.
   *
   * For spread arbitrage (sum(theta) < 1):
   *   Buy ALL outcomes — the profit comes from merging back to $1.
   *   The optimizer's mu tells us the optimal allocation ratio.
   *
   * For each outcome where mu[i] > theta[i]:
   *   Buy with proportion based on the divergence.
   */
  muToTradeLegs(
    mu: number[],
    theta: number[],
    snapshot: MarketSnapshot
  ): TradeLeg[] {
    const legs: TradeLeg[] = []

    // Use best ASK prices from order book when available — these are
    // the actual prices we'd pay to buy each outcome.
    const execPrices = theta.map((midPrice, i) => {
      const bestAsk = snapshot.depth?.[i]?.asks?.[0]?.price
      return bestAsk != null && bestAsk > 0 ? bestAsk : midPrice
    })

    const execSum = execPrices.reduce((s, p) => s + p, 0)

    if (execSum < 1.0) {
      // Spread arb: buy all unsettled outcomes at their ask prices.
      // Proportion based on each outcome's price (spend more on cheaper outcomes
      // to get more shares, maximizing merge quantity)
      const totalInverse = execPrices.reduce(
        (s, p, i) => s + (snapshot.settled[i] ? 0 : 1 / Math.max(p, EPS)),
        0
      )

      for (let i = 0; i < execPrices.length; i++) {
        if (snapshot.settled[i]) continue

        const proportion = 1 / Math.max(execPrices[i], EPS) / totalInverse

        legs.push({
          outcomeIndex: i,
          side: 'BUY',
          proportion,
          price: execPrices[i],
        })
      }
    }
    // Overpriced markets (ask sum >= 1): no buy-all-merge arb possible.
    // Selling overpriced outcomes requires separate logic (not yet supported).

    return legs
  }

  /**
   * Update optimizer configuration.
   */
  setConfig(config: Partial<FWOptimizerConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Get current configuration.
   */
  getConfig(): FWOptimizerConfig {
    return { ...this.config }
  }
}
