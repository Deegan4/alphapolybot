import type { Market } from '@/types'
import type { CoherenceResult, MarketDependency, MutexValidation } from './types'

/**
 * MutexValidator
 * Validates price coherence for markets classified as mutually exclusive.
 *
 * For binary mutex markets A and B (e.g., "Trump wins PA" ⊕ "Harris wins PA"):
 *   p(A_yes) + p(B_yes) should ≈ 1.0
 *   If > 1.0 → overpriced (sell opportunity)
 *   If < 1.0 → underpriced (buy opportunity)
 *
 * This acts as a second check on LLM classification — if the LLM says
 * "mutex" but prices don't confirm, we flag low confidence.
 */
export class MutexValidator {
  /** Tolerance for "coherent" prices. Default: 2% (2 cents on a $1 market) */
  private coherenceTolerance: number

  constructor(coherenceTolerance = 0.02) {
    this.coherenceTolerance = coherenceTolerance
  }

  /**
   * Check if two mutex binary markets have coherent combined prices.
   *
   * For mutex markets, the sum of YES prices should equal ~1.0
   * because exactly one of the two outcomes will resolve YES.
   */
  validateCoherence(
    marketA: Market,
    marketB: Market,
    _dependency: MarketDependency,
  ): CoherenceResult {
    // Use the first outcome price (YES) for each market
    const priceA = marketA.outcomePrices?.[0] ?? 0.5
    const priceB = marketB.outcomePrices?.[0] ?? 0.5

    const actualSum = priceA + priceB
    const expectedSum = 1.0
    const incoherence = Math.abs(actualSum - expectedSum)

    let signal: CoherenceResult['signal'] = 'coherent'
    if (actualSum > expectedSum + this.coherenceTolerance) {
      signal = 'overpriced'
    } else if (actualSum < expectedSum - this.coherenceTolerance) {
      signal = 'underpriced'
    }

    return {
      isCoherent: incoherence <= this.coherenceTolerance,
      expectedSum,
      actualSum,
      incoherence,
      signal,
    }
  }

  /**
   * Build a MutexValidation result for an arb opportunity.
   * If the opportunity's market has a mutex partner, validates coherence
   * and produces a human-readable summary.
   */
  buildValidation(
    market: Market,
    partner: Market,
    dependency: MarketDependency,
  ): MutexValidation {
    const coherence = this.validateCoherence(market, partner, dependency)

    const partnerLabel =
      partner.question.length > 60
        ? partner.question.slice(0, 57) + '...'
        : partner.question

    let reasoning: string
    if (coherence.isCoherent) {
      reasoning =
        `Mutex with "${partnerLabel}": combined YES sum ` +
        `${(coherence.actualSum * 100).toFixed(1)}¢ ≈ expected ` +
        `${(coherence.expectedSum * 100).toFixed(1)}¢ (coherent)`
    } else {
      reasoning =
        `Mutex with "${partnerLabel}": combined YES sum ` +
        `${(coherence.actualSum * 100).toFixed(1)}¢ vs expected ` +
        `${(coherence.expectedSum * 100).toFixed(1)}¢ — ` +
        `${coherence.signal} by ${(coherence.incoherence * 100).toFixed(1)}¢`
    }

    return {
      isValidated: true,
      mutexPartner: partner,
      combinedPriceSum: coherence.actualSum,
      incoherence: coherence.incoherence,
      reasoning,
    }
  }

  /**
   * Return a "not validated" result for markets without mutex partners.
   */
  static notValidated(): MutexValidation {
    return {
      isValidated: false,
      reasoning: 'No mutex partner found in dependency graph',
    }
  }

  setCoherenceTolerance(tolerance: number): void {
    this.coherenceTolerance = Math.max(0, tolerance)
  }
}
