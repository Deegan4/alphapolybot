/**
 * Avellaneda-Stoikov Reservation Pricing for Polymarket Binary Markets.
 *
 * Computes optimal market-maker quotes accounting for:
 * - Inventory risk (q: current position imbalance)
 * - Volatility (σ: realized vol of the underlying)
 * - Time horizon (T-t: normalized time remaining)
 * - Risk aversion (γ: how aggressively to skew quotes)
 * - Order arrival rate (κ: expected fills per unit time)
 *
 * For binary outcomes, prices are bounded [0.01, 0.99].
 * Uses logit transform to operate in unbounded space, then maps back.
 *
 * Reference: Avellaneda & Stoikov, "High-Frequency Trading in a Limit Order Book" (2008)
 *
 * Pure computation — no service dependencies, no side effects.
 */

export interface ASQuoteParams {
  midPrice: number         // Current mid-price of the outcome (0.01-0.99)
  inventory: number        // Position imbalance: positive = long, negative = short
  sigma: number            // Realized volatility (window-normalized)
  timeRemaining: number    // Normalized time remaining [0, 1] where 1 = full window
  gamma: number            // Risk aversion parameter (higher = more aggressive inventory skew)
  kappa: number            // Order arrival intensity (fills per unit time)
}

export interface ASQuotes {
  reservationPrice: number  // Inventory-adjusted fair value
  optimalSpread: number     // Total bid-ask spread width
  bidPrice: number          // Optimal bid quote (clamped to [0.01, 0.99])
  askPrice: number          // Optimal ask quote (clamped to [0.01, 0.99])
}

export interface VolatilityEstimate {
  sigma: number             // Realized volatility (window-normalized)
  sampleSize: number        // Number of log-returns used
  isReliable: boolean       // sampleSize >= minSamples
}

export class AvellanedaStoikovPricer {

  // ─── Logit Transform (bounded ↔ unbounded) ─────────────────

  /** Map price in (0,1) to unbounded real line: ln(p/(1-p)) */
  static logit(p: number): number {
    const clamped = Math.max(0.001, Math.min(0.999, p))
    return Math.log(clamped / (1 - clamped))
  }

  /** Map real number back to (0,1): 1/(1+exp(-x)) */
  static sigmoid(x: number): number {
    if (x > 20) return 0.999
    if (x < -20) return 0.001
    return 1 / (1 + Math.exp(-x))
  }

  // ─── Core Formulas ──────────────────────────────────────────

  /**
   * Reservation price: inventory-adjusted fair value.
   *
   * In logit (unbounded) space:
   *   r_logit = s_logit - q × γ × σ² × (T - t)
   *
   * Then mapped back to (0,1) via sigmoid.
   *
   * - Long inventory (q > 0) → reservation drops below mid (wants to sell)
   * - Short inventory (q < 0) → reservation rises above mid (wants to buy)
   * - Zero inventory → reservation = mid
   */
  static computeReservationPrice(params: ASQuoteParams): number {
    const { midPrice, inventory, sigma, timeRemaining, gamma } = params

    if (timeRemaining <= 0) return midPrice
    if (sigma <= 0) return midPrice

    // Work in logit space for bounded prices
    const sLogit = AvellanedaStoikovPricer.logit(midPrice)
    const rLogit = sLogit - inventory * gamma * sigma * sigma * timeRemaining

    return AvellanedaStoikovPricer.sigmoid(rLogit)
  }

  /**
   * Optimal spread: total bid-ask width around reservation price.
   *
   *   δ = γ × σ² × (T-t) + (2/γ) × ln(1 + γ/κ)
   *
   * Two components:
   * 1. Inventory risk compensation: scales with vol and time
   * 2. Liquidity provision profit: pure spread capture from order flow
   *
   * Higher vol or longer horizon → wider spread
   * Higher order arrival rate → tighter spread (more competition)
   * Higher risk aversion → wider spread
   */
  static computeOptimalSpread(params: ASQuoteParams): number {
    const { sigma, timeRemaining, gamma, kappa } = params

    // Fallback to conservative 2¢ spread if parameters are degenerate
    if (timeRemaining <= 0 || sigma <= 0 || gamma <= 0 || kappa <= 0) return 0.02

    const timePart = gamma * sigma * sigma * timeRemaining
    const arrivalPart = (2 / gamma) * Math.log(1 + gamma / kappa)

    // Floor at 0.5¢, cap at 20¢ (extreme but safe bounds for binary markets)
    return Math.max(0.005, Math.min(0.20, timePart + arrivalPart))
  }

  /**
   * Compute complete bid/ask quotes.
   *
   *   bid = reservationPrice - spread/2
   *   ask = reservationPrice + spread/2
   *
   * Both clamped to [0.01, 0.99] for Polymarket binary markets.
   */
  static computeQuotes(params: ASQuoteParams): ASQuotes {
    const reservationPrice = AvellanedaStoikovPricer.computeReservationPrice(params)
    const optimalSpread = AvellanedaStoikovPricer.computeOptimalSpread(params)

    const halfSpread = optimalSpread / 2
    const bidPrice = Math.max(0.01, Math.min(0.99, reservationPrice - halfSpread))
    const askPrice = Math.max(0.01, Math.min(0.99, reservationPrice + halfSpread))

    return { reservationPrice, optimalSpread, bidPrice, askPrice }
  }

  // ─── Volatility Estimation ──────────────────────────────────

  /**
   * Compute realized volatility from a price series.
   *
   * Uses log-returns and scales to window-normalized volatility.
   * For 1s BinanceWS ticks over a 15-min (900s) window:
   *   σ_window = σ_tick × √(windowDurationMs / intervalMs)
   *
   * @param prices          Chronological price observations
   * @param intervalMs      Time between observations (e.g., 1000 for 1s ticks)
   * @param windowDurationMs Total window duration (e.g., 900_000 for 15 min)
   * @param minSamples      Minimum observations for reliable estimate (default 20)
   */
  static estimateVolatility(
    prices: number[],
    intervalMs: number,
    windowDurationMs: number,
    minSamples = 20,
  ): VolatilityEstimate {
    if (prices.length < 2) {
      return { sigma: 0.01, sampleSize: prices.length, isReliable: false }
    }

    // Compute log-returns
    const logReturns: number[] = []
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > 0 && prices[i - 1] > 0) {
        logReturns.push(Math.log(prices[i] / prices[i - 1]))
      }
    }

    if (logReturns.length === 0) {
      return { sigma: 0.01, sampleSize: 0, isReliable: false }
    }

    // Standard deviation of log-returns
    const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length
    let variance = 0
    for (const r of logReturns) {
      variance += (r - mean) ** 2
    }
    variance /= logReturns.length

    const stdPerTick = Math.sqrt(variance)

    // Scale to window-normalized volatility
    const ticksPerWindow = windowDurationMs / intervalMs
    const sigma = stdPerTick * Math.sqrt(ticksPerWindow)

    return {
      sigma: Math.max(0.001, sigma), // Floor at 0.1% to prevent zero-spread
      sampleSize: logReturns.length,
      isReliable: logReturns.length >= minSamples,
    }
  }

  // ─── Inventory Mapping Helpers ──────────────────────────────

  /**
   * DualSide inventory: simple ternary {-1, 0, 1}.
   *
   * +1 = YES filled but not NO (long YES)
   * -1 = NO filled but not YES (long NO)
   *  0 = neither or both filled
   */
  static dualSideInventory(yesFilled: boolean, noFilled: boolean): number {
    if (yesFilled && !noFilled) return 1
    if (!yesFilled && noFilled) return -1
    return 0
  }

  /**
   * Gabagool inventory: continuous, normalized by target position.
   *
   *   q = (qtyYes - qtyNo) / targetQty
   *
   * Positive = heavy on YES, negative = heavy on NO.
   */
  static gabagoolInventory(qtyYes: number, qtyNo: number, targetQty: number): number {
    if (targetQty <= 0) return 0
    return (qtyYes - qtyNo) / targetQty
  }
}
