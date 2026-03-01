/**
 * Kelly Criterion position sizing for Polymarket binary markets.
 *
 * Pure math — no store or service dependencies.
 *
 * Core formula: f* = (bp - q) / b
 *   b = net odds (profit per unit bet if win)
 *   p = probability of winning
 *   q = 1 - p
 *
 * For Polymarket: b = (1 - price) / price, a = 1 (lose full bet).
 */
export class KellySizer {
  /**
   * Full Kelly fraction: f* = (b·p - q) / b
   * Returns 0 when there is no edge (negative Kelly clamped).
   */
  static fullKelly(p: number, b: number): number {
    if (b <= 0 || p <= 0 || p >= 1) return 0
    const q = 1 - p
    const f = (b * p - q) / b
    return Math.max(0, f)
  }

  /**
   * Polymarket-specific Kelly: converts market price to odds, computes Kelly.
   *   b = (1 - price) / price
   *   modelProb = estimated true probability of the outcome
   *
   * Returns 0 when model sees no edge (modelProb ≤ marketPrice).
   */
  static polymarketKelly(modelProb: number, marketPrice: number): number {
    if (marketPrice <= 0 || marketPrice >= 1) return 0
    const b = (1 - marketPrice) / marketPrice
    return KellySizer.fullKelly(modelProb, b)
  }

  /**
   * Polymarket Kelly with fee adjustment: accounts for taker fee reducing payouts.
   *
   * Standard Kelly assumes win pays (1-price)/price. With fees, the effective
   * payout is reduced: win pays (effectivePayout - price) / price where
   * effectivePayout = 1.0 - (feeRateBps / 10000).
   *
   * For crypto markets (1000 bps = 10% fee), buying at 0.40 only nets
   * (0.90 - 0.40) / 0.40 = 1.25x instead of 1.50x without fees.
   *
   * Returns 0 when model sees no edge after fees.
   */
  static polymarketKellyWithFee(modelProb: number, marketPrice: number, feeRateBps: number): number {
    if (marketPrice <= 0 || marketPrice >= 1) return 0
    const effectivePayout = 1.0 - feeRateBps / 10_000  // e.g. 0.90 for 1000 bps
    if (effectivePayout <= marketPrice) return 0  // No possible profit after fees
    const b = (effectivePayout - marketPrice) / marketPrice
    return KellySizer.fullKelly(modelProb, b)
  }

  /**
   * Arb Kelly: for guaranteed-profit arbitrage (p ≈ 1.0).
   *
   * Since "guaranteed" depends on execution (slippage, partial fills),
   * we treat the profit ratio as the effective odds with p=1 and cap
   * the result conservatively.
   *
   * @param guaranteedProfitRatio — e.g. 0.05 for 5% guaranteed profit
   * @param maxFraction — cap on Kelly output (default 0.20 = 20%)
   */
  static arbKelly(guaranteedProfitRatio: number, maxFraction = 0.20): number {
    if (guaranteedProfitRatio <= 0) return 0
    // With p=1, f* = 1.0 always. Scale by profit ratio instead:
    // Higher profit ratio → more confident → larger fraction, but capped.
    const f = Math.min(guaranteedProfitRatio * 2, maxFraction)
    return Math.max(0, f)
  }

  /**
   * Size a bet in dollars: fractional Kelly × bankroll, with floor and cap.
   *
   * @returns Dollar amount to bet (rounded to cents)
   */
  static sizeBet(params: {
    kellyFraction: number     // 0.25 = quarter Kelly
    bankroll: number          // USDC.e balance
    fullKelly: number         // f* from one of the above methods
    maxConcentration?: number // max % of bankroll per trade (default 0.20)
    minBet?: number           // dollar floor (default 1.00)
    highWaterMark?: number    // peak bankroll for drawdown-adjusted sizing
  }): number {
    const {
      kellyFraction,
      bankroll,
      fullKelly,
      maxConcentration = 0.20,
      minBet = 1.00,
      highWaterMark,
    } = params

    if (bankroll <= 0 || kellyFraction <= 0 || fullKelly <= 0) {
      return minBet
    }

    // Drawdown-adjusted Kelly: reduce sizing proportionally to drawdown from peak.
    // At 0% drawdown → full fraction. At 20% drawdown → ~60% fraction.
    // Formula: adjustedFraction = kellyFraction × (bankroll / highWaterMark)
    let effectiveFraction = kellyFraction
    if (highWaterMark && highWaterMark > 0 && bankroll < highWaterMark) {
      const drawdownRatio = bankroll / highWaterMark // e.g. 0.80 at 20% drawdown
      effectiveFraction = kellyFraction * drawdownRatio
    }

    // Fractional Kelly
    let size = fullKelly * effectiveFraction * bankroll

    // Concentration cap
    const cap = bankroll * maxConcentration
    size = Math.min(size, cap)

    // Floor
    size = Math.max(size, minBet)

    return Math.round(size * 100) / 100
  }

  /**
   * Compute high-water mark from current bankroll.
   * Callers should persist and update this value over time.
   */
  static updateHighWaterMark(current: number, previousHWM: number): number {
    return Math.max(current, previousHWM)
  }

  // ─────────────────────────────────────────────────────
  // Monte Carlo Kelly — confidence-adjusted position sizing
  // ─────────────────────────────────────────────────────

  /**
   * Bootstrap confidence interval for edge (mean return).
   *
   * Resamples the returns array N times, computes mean of each resample,
   * and returns [lower, upper] percentile bounds.
   *
   * @param returns   Per-trade P&L values (dollars or fractions)
   * @param confidence Confidence level (default 0.95 = 95% CI)
   * @param nResamples Number of bootstrap resamples (default 5000)
   * @param rng       Seeded random function for deterministic tests
   */
  static bootstrapEdgeCI(
    returns: number[],
    confidence = 0.95,
    nResamples = 5000,
    rng: () => number = Math.random,
  ): [number, number] {
    if (returns.length < 2) return [0, 0]

    const n = returns.length
    const means: number[] = new Array(nResamples)

    for (let i = 0; i < nResamples; i++) {
      let sum = 0
      for (let j = 0; j < n; j++) {
        sum += returns[Math.floor(rng() * n)]
      }
      means[i] = sum / n
    }

    means.sort((a, b) => a - b)
    const alpha = (1 - confidence) / 2
    const lowerIdx = Math.floor(alpha * nResamples)
    const upperIdx = Math.floor((1 - alpha) * nResamples)

    return [means[lowerIdx], means[upperIdx]]
  }

  /**
   * Monte Carlo Kelly: confidence-adjusted position sizing via bootstrap resampling.
   *
   * Instead of trusting a point-estimate win rate, this method:
   * 1. Computes raw Kelly from observed win rate
   * 2. Bootstraps the return distribution to estimate CV (coefficient of variation) of edge
   * 3. Adjusts Kelly by (1 - CV_edge) — higher uncertainty → smaller bet
   * 4. Simulates N wealth paths to measure 95th percentile max drawdown
   *
   * Formula: f_empirical = f_kelly × (1 - min(CV_edge, 1))
   *
   * Returns adjustedFraction=0 with insufficient data (<10 trades).
   */
  static monteCarloKelly(params: {
    returns: number[]       // Historical per-trade P&L (from TradeLogger)
    marketPrice: number     // Current market price (for Kelly odds computation)
    feeRateBps: number      // Taker fee in basis points
    nResamples?: number     // Bootstrap resamples (default 5000)
    nPaths?: number         // Drawdown simulation paths (default 1000)
    rng?: () => number      // Seeded random for deterministic tests
  }): MonteCarloKellyResult {
    const {
      returns,
      marketPrice,
      feeRateBps,
      nResamples = 5000,
      nPaths = 1000,
      rng = Math.random,
    } = params

    // Insufficient data fallback
    if (returns.length < 10) {
      return { adjustedFraction: 0, rawKelly: 0, cvEdge: 1, confidenceInterval: [0, 0], drawdown95: 1 }
    }

    // 1. Point-estimate Kelly from observed win rate
    const wins = returns.filter(r => r > 0).length
    const winRate = wins / returns.length
    const rawKelly = KellySizer.polymarketKellyWithFee(winRate, marketPrice, feeRateBps)

    if (rawKelly <= 0) {
      return { adjustedFraction: 0, rawKelly: 0, cvEdge: 1, confidenceInterval: [0, 0], drawdown95: 1 }
    }

    // 2. Bootstrap edge estimates to measure uncertainty
    const n = returns.length
    const edgeEstimates: number[] = new Array(nResamples)

    for (let i = 0; i < nResamples; i++) {
      let sumWins = 0
      for (let j = 0; j < n; j++) {
        if (returns[Math.floor(rng() * n)] > 0) sumWins++
      }
      edgeEstimates[i] = sumWins / n - marketPrice  // edge = p_estimated - cost
    }

    // 3. Coefficient of variation of edge
    const meanEdge = edgeEstimates.reduce((a, b) => a + b, 0) / nResamples
    let variance = 0
    for (let i = 0; i < nResamples; i++) {
      variance += (edgeEstimates[i] - meanEdge) ** 2
    }
    variance /= nResamples
    const stdEdge = Math.sqrt(variance)
    const cvEdge = meanEdge !== 0 ? Math.abs(stdEdge / meanEdge) : 1

    // 4. Adjusted fraction: shrink by uncertainty
    const adjustedFraction = Math.max(0, rawKelly * (1 - Math.min(cvEdge, 1)))

    // 5. Confidence interval on raw returns
    const ci = KellySizer.bootstrapEdgeCI(returns, 0.95, nResamples, rng)

    // 6. Drawdown simulation — N paths using adjusted Kelly sizing
    const maxDrawdowns: number[] = new Array(nPaths)
    for (let p = 0; p < nPaths; p++) {
      let wealth = 1.0
      let peak = 1.0
      let maxDD = 0
      for (let t = 0; t < n; t++) {
        const ret = returns[Math.floor(rng() * n)]
        // Normalize return by market price for Kelly bet fraction
        wealth *= (1 + adjustedFraction * (ret / marketPrice))
        if (wealth > peak) peak = wealth
        const dd = (peak - wealth) / peak
        if (dd > maxDD) maxDD = dd
      }
      maxDrawdowns[p] = maxDD
    }
    maxDrawdowns.sort((a, b) => a - b)
    const drawdown95 = maxDrawdowns[Math.floor(0.95 * nPaths)]

    return { adjustedFraction, rawKelly, cvEdge, confidenceInterval: ci, drawdown95 }
  }
}

export interface MonteCarloKellyResult {
  adjustedFraction: number       // f_kelly × (1 - CV_edge), the recommended sizing fraction
  rawKelly: number               // Point-estimate full Kelly (before confidence adjustment)
  cvEdge: number                 // Coefficient of variation of edge estimates (higher = less certain)
  confidenceInterval: [number, number]  // 95% CI on mean P&L
  drawdown95: number             // 95th percentile max drawdown across simulated paths
}
