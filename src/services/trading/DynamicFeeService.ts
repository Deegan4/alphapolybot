/**
 * Dynamic Fee Service — models Polymarket's dynamic taker fee curve
 * and provides fee-aware trade viability calculations.
 *
 * Polymarket introduced dynamic taker fees on crypto prediction markets
 * in January 2026: fee scales by distance from 50/50 odds, peaking at
 * ~3.15% (315 bps) on 50¢ contracts and tapering toward the edges.
 *
 * This service:
 * 1. Models the fee curve for pre-trade filtering (before API call)
 * 2. Computes net expected value after fees for any trade
 * 3. Gates trades that are fee-negative
 * 4. Provides dual-side EV calculations for hedged entries
 *
 * Pure computation — no service dependencies, no side effects.
 */

import { KellySizer } from './KellySizer'

// ==========================================
// TYPES
// ==========================================

export interface FeeEstimate {
  feeRateBps: number        // Fee in basis points
  feePercent: number         // feeRateBps / 10000
  source: 'api' | 'model'   // Whether from CLOB API or local model
  isDynamic: boolean         // True if fee varies by price level
}

export interface TradeEV {
  grossEV: number            // Expected value before fees (per $1 bet)
  netEV: number              // Expected value after fees (per $1 bet)
  feeImpact: number          // Dollar cost of fees per $1 bet
  feeAdjustedEdge: number    // Net edge as fraction of cost
  isViable: boolean          // netEV > 0
  breakEvenProb: number      // Min win probability needed for +EV after fees
}

export interface DualSideEV {
  netEV: number              // Net P&L per $1 total outlay
  isViable: boolean          // netEV > 0
  breakEvenWinProb: number   // Min win probability needed for +EV
  totalOutlay: number        // Combined cost of both legs
  totalFees: number          // Combined fees on both legs
}

// ==========================================
// FEE CURVE MODEL
// ==========================================

/**
 * Polymarket dynamic fee curve for crypto prediction markets.
 *
 * The fee is highest near 50/50 odds (price=0.50) and tapers toward the
 * edges. Modeled as quadratic: fee = baseFee + peakSurcharge * (1 - 4*(p-0.5)^2)
 *
 * Calibrated against observed fee rates:
 * - At price 0.50: ~315 bps (3.15%)
 * - At price 0.30 or 0.70: ~235 bps (~2.35%)
 * - At price 0.10 or 0.90: ~75 bps (~0.75%)
 *
 * The baseFee accounts for the minimum fee at extreme prices.
 * The peakSurcharge adds the variable component near 50/50.
 */
const DYNAMIC_FEE_BASE_BPS = 50       // ~0.5% minimum fee at edges
const DYNAMIC_FEE_PEAK_SURCHARGE = 265 // Additional bps at price=0.50 (total ~315 at center)

/**
 * Standard (non-crypto) market fee — flat rate, no dynamic scaling.
 */
const STANDARD_MARKET_FEE_BPS = 100    // 1% flat on standard markets

/**
 * Legacy flat crypto fee (pre-Jan 2026). Used as fallback if dynamic
 * model seems miscalibrated vs API response.
 */
const LEGACY_CRYPTO_FEE_BPS = 1000     // 10% flat on old crypto markets

// ==========================================
// DYNAMIC FEE SERVICE
// ==========================================

export class DynamicFeeService {

  /**
   * Estimate the dynamic taker fee for a crypto market at a given price level.
   *
   * For crypto markets: uses the quadratic fee curve.
   * For standard markets: returns the flat standard rate.
   * For non-prediction contexts: returns 0.
   *
   * This is a LOCAL MODEL — use getActualFee() when you have a tokenId
   * and can query the CLOB API.
   */
  estimateDynamicFee(marketPrice: number, isCryptoMarket: boolean): FeeEstimate {
    if (!isCryptoMarket) {
      return {
        feeRateBps: STANDARD_MARKET_FEE_BPS,
        feePercent: STANDARD_MARKET_FEE_BPS / 10_000,
        source: 'model',
        isDynamic: false,
      }
    }

    // Clamp price to valid range
    const p = Math.max(0.01, Math.min(0.99, marketPrice))

    // Quadratic curve: peak at 0.50, tapering to baseFee at edges
    // 1 - 4*(p - 0.5)^2 = 1 at p=0.5, 0 at p=0.0 and p=1.0
    const distanceFactor = 1 - 4 * (p - 0.5) ** 2
    const feeBps = Math.round(DYNAMIC_FEE_BASE_BPS + DYNAMIC_FEE_PEAK_SURCHARGE * distanceFactor)

    return {
      feeRateBps: feeBps,
      feePercent: feeBps / 10_000,
      source: 'model',
      isDynamic: true,
    }
  }

  /**
   * Compute the full expected value of a trade accounting for dynamic fees.
   *
   * For resolution-hold trades (BTC Up/Down):
   *   Win pays $1.00 minus sell-side fee. Cost is marketPrice + buy-side fee.
   *   grossEV = modelProb * effectivePayout - marketPrice
   *   netEV   = modelProb * (1 - feePercent) - marketPrice * (1 + feePercent)
   *
   * For intermediate-exit trades (non-resolution):
   *   Both entry and exit incur fees.
   *   netEV = modelProb * exitPrice * (1 - feePercent) - marketPrice * (1 + feePercent)
   *
   * Resolution-hold simplification: winner gets $1.00, fee is on the $1.00 payout.
   * The buy-side fee is baked into the order (feeRateBps in EIP-712 signature).
   * Polymarket actually deducts the fee from the payout, so effective win = 1.0 - fee.
   */
  computeTradeEV(params: {
    modelProb: number
    marketPrice: number
    tradeSize: number
    feeRateBps: number
    isResolutionHold: boolean
  }): TradeEV {
    const { modelProb, marketPrice, tradeSize, feeRateBps, isResolutionHold } = params
    const feePercent = feeRateBps / 10_000

    if (modelProb <= 0 || modelProb >= 1 || marketPrice <= 0 || marketPrice >= 1) {
      return { grossEV: 0, netEV: 0, feeImpact: 0, feeAdjustedEdge: 0, isViable: false, breakEvenProb: 1 }
    }

    // Gross EV (no fees): modelProb * $1.00 - marketPrice
    const grossEV = modelProb - marketPrice

    let netEV: number
    let feeImpact: number

    if (isResolutionHold) {
      // Resolution hold: fee is on the payout side only.
      // You pay marketPrice to enter (fee included in signed order).
      // If you win, you receive (1.0 - feePercent).
      // If you lose, you receive $0.
      const effectivePayout = 1.0 - feePercent
      netEV = modelProb * effectivePayout - marketPrice
      feeImpact = modelProb * feePercent
    } else {
      // Intermediate exit: fee on both buy and sell.
      // Buy cost: marketPrice (fee embedded). Sell revenue: exitPrice * (1 - feePercent).
      // Approximation: expected exit price ≈ modelProb (fair value).
      netEV = modelProb * (1 - feePercent) - marketPrice
      feeImpact = modelProb * feePercent
    }

    const feeAdjustedEdge = marketPrice > 0 ? netEV / marketPrice : 0

    // Break-even probability: solve modelProb * (1 - feePercent) = marketPrice
    const breakEvenProb = Math.min(1, marketPrice / (1 - feePercent))

    return {
      grossEV,
      netEV,
      feeImpact,
      feeAdjustedEdge,
      isViable: netEV > 0,
      breakEvenProb,
    }
  }

  /**
   * Compute net P&L of a dual-side hedge: buying both YES and NO.
   *
   * The core insight: if you buy both sides before the oracle adjusts,
   * the winning side resolves at $1.00 and the loser at $0.00.
   *
   * Net P&L = $1.00 - yesPrice - noPrice - yesFee - noFee
   *
   * With maker orders (0% fee):
   *   Net = 1.00 - yesPrice - noPrice
   *   Profitable when combined < $1.00
   *
   * With taker orders (e.g., 3.15% each):
   *   Net = 1.00 - yesPrice - noPrice - 2 * fee
   *   Almost never profitable
   *
   * With directional bias (winProbability > 0.5):
   *   Weight allocation toward predicted winner improves EV.
   *   But for pure dual-side, we don't need winProbability —
   *   the profit is locked in regardless of which side wins.
   */
  computeDualSideEV(params: {
    yesPrice: number
    noPrice: number
    yesFeeRateBps: number
    noFeeRateBps: number
    winProbability: number
  }): DualSideEV {
    const { yesPrice, noPrice, yesFeeRateBps, noFeeRateBps, winProbability } = params

    const yesFeePercent = yesFeeRateBps / 10_000
    const noFeePercent = noFeeRateBps / 10_000

    // Total outlay: sum of both sides
    const totalOutlay = yesPrice + noPrice

    // Fee on the winning side's payout (the payout is $1.00, fee reduces it)
    // For dual-side, exactly one side wins. The fee on the loser is $0 (no payout).
    // We pay fee on entry for both sides, and fee on payout for the winner.
    //
    // Polymarket fee model: fee is on the PAYOUT, not the entry.
    // So: entry cost = yesPrice + noPrice (no extra entry fee)
    //     payout = 1.00 - fee on the winning side
    //
    // Which side wins? We don't know for certain, but fee may differ per side.
    // Expected payout = winProb * (1 - yesFeePercent) + (1 - winProb) * (1 - noFeePercent)
    // Where winProb = probability that YES wins (our signal direction alignment)
    const expectedPayout = winProbability * (1 - yesFeePercent) + (1 - winProbability) * (1 - noFeePercent)
    const totalFees = winProbability * yesFeePercent + (1 - winProbability) * noFeePercent

    const netEV = expectedPayout - totalOutlay

    // Break-even: when is dual-side +EV regardless of direction?
    // Best case (maker, 0% fee): 1.00 - totalOutlay > 0 → totalOutlay < 1.00
    // With fees: 1.00 - maxFee - totalOutlay > 0
    // Break-even win prob: solve for p where expected payout = totalOutlay
    // p * (1 - yesFee) + (1 - p) * (1 - noFee) = totalOutlay
    // p * (noFee - yesFee) + (1 - noFee) = totalOutlay
    // p = (totalOutlay - 1 + noFee) / (noFee - yesFee)  — only meaningful if fees differ
    // If fees are equal: 1 - fee = totalOutlay → fee = 1 - totalOutlay → breakEvenWinProb = 0.5 (any)
    let breakEvenWinProb: number
    if (Math.abs(yesFeePercent - noFeePercent) < 0.0001) {
      // Fees equal: viable iff totalOutlay < 1 - feePercent
      breakEvenWinProb = netEV > 0 ? 0 : 1 // Either always viable or never
    } else {
      breakEvenWinProb = Math.max(0, Math.min(1, (totalOutlay - 1 + noFeePercent) / (noFeePercent - yesFeePercent)))
    }

    return {
      netEV,
      isViable: netEV > 0,
      breakEvenWinProb,
      totalOutlay,
      totalFees,
    }
  }

  /**
   * Kelly fraction with dynamic fee adjustment.
   *
   * Wraps KellySizer.polymarketKellyWithFee — the fee-adjusted Kelly accounts
   * for reduced payout due to taker fees.
   */
  feeAdjustedKelly(modelProb: number, marketPrice: number, feeRateBps: number): number {
    return KellySizer.polymarketKellyWithFee(modelProb, marketPrice, feeRateBps)
  }

  /**
   * Gate: should this trade execute?
   *
   * Returns true if the trade has positive expected value after fees,
   * with an optional minimum net edge requirement.
   */
  isTradeViable(ev: TradeEV, minNetEdge = 0): boolean {
    return ev.isViable && ev.feeAdjustedEdge >= minNetEdge
  }
}

// ==========================================
// SINGLETON EXPORT
// ==========================================

export const dynamicFeeService = new DynamicFeeService()
