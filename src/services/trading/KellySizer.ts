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
}
