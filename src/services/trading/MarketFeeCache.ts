/**
 * MarketFeeCache — Per-token fee rate caching with window-duration viability gating.
 *
 * Polymarket's dynamic taker fees vary dramatically by market duration:
 * - Standard markets: ~0-100 bps
 * - 1hr crypto markets: ~150 bps at mid-price
 * - 15min crypto markets: 1000 bps (10%)
 * - 5min crypto markets: UNKNOWN — need to verify via /fee-rate?token_id=X
 *
 * This service:
 * 1. Queries and caches per-token fee rates from the CLOB API
 * 2. Classifies market duration from the question/slug
 * 3. Provides viability gates: "is this market tradeable at this fee level?"
 * 4. Alerts when a 5m market has unexpectedly high fees
 *
 * Used by strategies before placing orders to avoid fee-destroyed edge.
 * Wraps CLOBClient.getFeeRate() with higher-level duration awareness.
 */

export type MarketDuration = '5m' | '15m' | '1hr' | '4hr' | '24hr' | 'unknown'

export interface FeeRateInfo {
  tokenId: string
  feeRateBps: number
  feePercent: number
  duration: MarketDuration
  fetchedAt: number
  /** Whether this fee rate makes the market viable for the given strategy */
  isViable: boolean
  /** For taker orders: effective round-trip fee (entry + exit) */
  roundTripBps: number
}

export interface ViabilityResult {
  viable: boolean
  reason: string
  feeRateBps: number
  maxAcceptableBps: number
  duration: MarketDuration
}

/** Max acceptable taker fee by market duration (bps) */
const MAX_FEE_BY_DURATION: Record<MarketDuration, number> = {
  '5m': 200,     // If 5m fees are >200 bps, not worth it
  '15m': 200,    // 15m crypto = 1000 bps → always blocked for taker
  '1hr': 200,    // 1hr = ~156 bps at 50¢ → marginal
  '4hr': 200,    // 4hr = standard dynamic → usually viable
  '24hr': 200,   // Daily = standard dynamic → usually viable
  'unknown': 200,
}

/** Fee cache TTL: 5 minutes (fees don't change often) */
const CACHE_TTL_MS = 5 * 60 * 1000

export class MarketFeeCache {
  /** tokenId → cached fee info */
  private cache = new Map<string, FeeRateInfo>()
  /** slug/question → detected duration */
  private durationCache = new Map<string, MarketDuration>()

  // ─── Duration Detection ───────────────────────────────────

  /**
   * Detect market duration from slug or question text.
   * Polymarket crypto markets follow naming patterns:
   *   "will-btc-go-up-5m-1234", "will-eth-go-down-1hr-5678"
   */
  detectDuration(slugOrQuestion: string): MarketDuration {
    const cached = this.durationCache.get(slugOrQuestion)
    if (cached) return cached

    const text = slugOrQuestion.toLowerCase()

    let duration: MarketDuration = 'unknown'
    if (/\b5[\s-]?min(ute)?s?\b|[-_]5m[-_]/.test(text)) {
      duration = '5m'
    } else if (/\b15[\s-]?min(ute)?s?\b|[-_]15m[-_]/.test(text)) {
      duration = '15m'
    } else if (/\b(1[\s-]?h(ou)?r|60[\s-]?min(ute)?s?)\b|[-_]1hr[-_]/.test(text)) {
      duration = '1hr'
    } else if (/\b4[\s-]?h(ou)?r\b|[-_]4hr[-_]/.test(text)) {
      duration = '4hr'
    } else if (/\b(24[\s-]?h(ou)?r|daily|1[\s-]?day)\b|[-_]24hr[-_]/.test(text)) {
      duration = '24hr'
    }

    this.durationCache.set(slugOrQuestion, duration)
    return duration
  }

  // ─── Fee Lookup ───────────────────────────────────────────

  /**
   * Get fee rate for a token, querying CLOB API if not cached.
   * Returns cached value if fresh (within TTL).
   */
  async getFeeRate(tokenId: string, slugOrQuestion?: string): Promise<FeeRateInfo> {
    // Check cache freshness
    const cached = this.cache.get(tokenId)
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      return cached
    }

    // Query CLOB API
    let feeRateBps = 0
    try {
      const { clobClient } = await import('@/services/api/CLOBClient')
      feeRateBps = await clobClient.getFeeRateBps(tokenId)
    } catch (error) {
      console.warn(`[MarketFeeCache] Failed to fetch fee rate for ${tokenId.slice(0, 12)}…:`, error)
      // Fall back to model estimate if we know the duration
      if (slugOrQuestion) {
        const duration = this.detectDuration(slugOrQuestion)
        feeRateBps = this.modelEstimate(duration)
      }
    }

    const duration = slugOrQuestion ? this.detectDuration(slugOrQuestion) : 'unknown'
    const maxBps = MAX_FEE_BY_DURATION[duration]

    const info: FeeRateInfo = {
      tokenId,
      feeRateBps,
      feePercent: feeRateBps / 10_000,
      duration,
      fetchedAt: Date.now(),
      isViable: feeRateBps <= maxBps,
      roundTripBps: feeRateBps * 2, // entry + exit as taker
    }

    this.cache.set(tokenId, info)

    // Log warning for high-fee 5m markets
    if (duration === '5m' && feeRateBps > 200) {
      console.warn(
        `[MarketFeeCache] 5m market ${tokenId.slice(0, 12)}… has ${feeRateBps} bps fee — ` +
        `taker orders NOT viable (max ${maxBps} bps)`
      )
    }

    return info
  }

  /**
   * Check if a market is viable for taker orders at the given fee level.
   * For maker orders (0% fee), this always returns viable.
   */
  async checkViability(
    tokenId: string,
    slugOrQuestion: string,
    isMakerOrder: boolean,
    customMaxBps?: number,
  ): Promise<ViabilityResult> {
    if (isMakerOrder) {
      const duration = this.detectDuration(slugOrQuestion)
      return {
        viable: true,
        reason: 'Maker order — 0% fee',
        feeRateBps: 0,
        maxAcceptableBps: Infinity,
        duration,
      }
    }

    const info = await this.getFeeRate(tokenId, slugOrQuestion)
    const maxBps = customMaxBps ?? MAX_FEE_BY_DURATION[info.duration]

    return {
      viable: info.feeRateBps <= maxBps,
      reason: info.feeRateBps <= maxBps
        ? `Fee ${info.feeRateBps} bps ≤ max ${maxBps} bps`
        : `Fee ${info.feeRateBps} bps exceeds max ${maxBps} bps for ${info.duration} market`,
      feeRateBps: info.feeRateBps,
      maxAcceptableBps: maxBps,
      duration: info.duration,
    }
  }

  /**
   * Compute break-even confidence needed at a given fee level.
   * For resolution-hold: need modelProb > marketPrice / (1 - feePercent)
   */
  breakEvenConfidence(marketPrice: number, feeRateBps: number): number {
    const feePercent = feeRateBps / 10_000
    const denominator = 1 - feePercent
    if (denominator <= 0) return 1
    return Math.min(1, marketPrice / denominator)
  }

  /** Get cached fee rate (synchronous, returns null if not cached) */
  getCached(tokenId: string): FeeRateInfo | null {
    const cached = this.cache.get(tokenId)
    if (!cached) return null
    if ((Date.now() - cached.fetchedAt) > CACHE_TTL_MS) return null
    return cached
  }

  /** Clear all caches */
  clear(): void {
    this.cache.clear()
    this.durationCache.clear()
  }

  /** Get cache size */
  get cacheSize(): number {
    return this.cache.size
  }

  // ─── Internal ─────────────────────────────────────────────

  /** Model estimate when API is unavailable */
  private modelEstimate(duration: MarketDuration): number {
    switch (duration) {
      case '5m': return 1000   // Assume same as 15m until verified
      case '15m': return 1000  // Known: 10%
      case '1hr': return 156   // Known: dynamic, ~156 at 50¢
      case '4hr': return 156   // Known: dynamic
      case '24hr': return 100  // Standard flat
      default: return 100
    }
  }
}

// Singleton export
export const marketFeeCache = new MarketFeeCache()
