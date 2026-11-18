/**
 * Polymarket US trading fees — pure helpers.
 *
 * docs.polymarket.us/fees: taker fee = Θ × C × p × (1 − p), where C is the
 * number of contracts, p the trade price and Θ the taker coefficient. Tier 1
 * (under $10k trailing 30-day taker volume) is Θ = 0.095, which is also the
 * `feeCoefficient` every market listing carries. The fee is symmetric, so a
 * NO trade at q costs the same as a YES trade at 1 − q. Makers pay nothing
 * at tier 1, and settlement at resolution carries no trading fee.
 *
 * As a share of the money paid for the position (C × p), the taker fee is
 * Θ × (1 − p): about 4.75% at 50¢ and 9% at 5¢. The old flat-bps model
 * (0.1%) understated it by more than an order of magnitude.
 */

/** Tier 1 taker coefficient; markets publish theirs as `feeCoefficient` */
export const PMUS_DEFAULT_TAKER_THETA = 0.095

const clampPrice = (p: number) => Math.min(0.99, Math.max(0.01, p))

/** Taker fee in dollars for `contracts` traded at `price` (outcome terms) */
export function takerFee(contracts: number, price: number, theta = PMUS_DEFAULT_TAKER_THETA): number {
  if (!(contracts > 0)) return 0
  const p = clampPrice(price)
  return theta * contracts * p * (1 - p)
}

/** Taker fee as a fraction of notional paid (C × p): Θ × (1 − p) */
export function takerFeeFraction(price: number, theta = PMUS_DEFAULT_TAKER_THETA): number {
  return theta * (1 - clampPrice(price))
}

/** All-in cost of one contract bought as taker: p + Θ·p·(1 − p) */
export function takerCostPerContract(price: number, theta = PMUS_DEFAULT_TAKER_THETA): number {
  const p = clampPrice(price)
  return p + theta * p * (1 - p)
}

/**
 * Round-trip taker fees (buy at `entry`, sell at `exit`), as a fraction of the
 * entry notional, so it can be subtracted from a P&L percentage:
 *   Θ(1 − entry) + Θ · exit(1 − exit) / entry
 */
export function roundTripFeeFraction(entry: number, exit: number, theta = PMUS_DEFAULT_TAKER_THETA): number {
  const e = clampPrice(entry)
  const x = clampPrice(exit)
  return theta * (1 - e) + (theta * x * (1 - x)) / e
}
