/**
 * BTC Calibration Service
 *
 * Tracks actual win rate vs predicted confidence for Crypto Up/Down trades.
 * Buckets closed trades by their entry `modelProbability` and computes
 * actual hit rate per bucket. When enough data accumulates (≥10 per bucket),
 * the calibrated value replaces raw signal confidence for edge checks and
 * Kelly sizing — so the bot learns from its own results.
 *
 * Recomputes lazily every 30 minutes from TradeLogger in-memory records.
 */

import { tradeLogger, type TradeRecord } from './TradeLogger'

// ── Bucket config ──────────────────────────────────────────
const BUCKET_WIDTH = 0.10
const BUCKET_STARTS = [0.30, 0.40, 0.50, 0.60, 0.70] // 5 buckets: 30-40%, 40-50%, …, 70%+
const MIN_SAMPLES = 10
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 min

interface CalibrationBucket {
  rangeStart: number
  rangeEnd: number
  wins: number
  total: number
  actualWinRate: number // wins / total (NaN if total === 0)
}

export class BtcCalibrationService {
  private buckets: CalibrationBucket[] = []
  private lastComputeTs = 0

  /**
   * Calibrate a raw signal confidence to the historically observed win rate.
   * Returns the raw value if insufficient data for the relevant bucket.
   */
  calibrate(rawConfidence: number): number {
    this.ensureFresh()

    const bucket = this.findBucket(rawConfidence)
    if (bucket && bucket.total >= MIN_SAMPLES) {
      return bucket.actualWinRate
    }

    // Try linear interpolation between nearest populated neighbors
    const interpolated = this.interpolate(rawConfidence)
    if (interpolated !== null) return interpolated

    // Not enough data — pass through
    return rawConfidence
  }

  /** Summary for diagnostics / dashboard */
  getBuckets(): CalibrationBucket[] {
    this.ensureFresh()
    return [...this.buckets]
  }

  /** Total resolved BTC trades used for calibration */
  get totalSamples(): number {
    this.ensureFresh()
    return this.buckets.reduce((sum, b) => sum + b.total, 0)
  }

  // ── Internal ──────────────────────────────────────────────

  private ensureFresh(): void {
    if (Date.now() - this.lastComputeTs < CACHE_TTL_MS && this.buckets.length > 0) return
    this.recompute()
  }

  private recompute(): void {
    const records = tradeLogger.getRecords().filter(
      (r: TradeRecord) => r.strategy === 'btc' && r.exitTimestamp != null && r.modelProbability != null,
    )

    // Initialize empty buckets
    this.buckets = BUCKET_STARTS.map((start, i) => ({
      rangeStart: start,
      rangeEnd: i < BUCKET_STARTS.length - 1 ? start + BUCKET_WIDTH : 1.0,
      wins: 0,
      total: 0,
      actualWinRate: NaN,
    }))

    for (const r of records) {
      const bucket = this.findBucket(r.modelProbability!)
      if (!bucket) continue
      bucket.total++
      if ((r.pnlUSD ?? 0) > 0) bucket.wins++
    }

    for (const b of this.buckets) {
      b.actualWinRate = b.total > 0 ? b.wins / b.total : NaN
    }

    this.lastComputeTs = Date.now()

    if (records.length > 0) {
      const populated = this.buckets.filter(b => b.total >= MIN_SAMPLES)
      console.log(
        `[BtcCalibration] Recomputed from ${records.length} trades — ` +
        `${populated.length}/${this.buckets.length} buckets active`,
      )
    }
  }

  private findBucket(confidence: number): CalibrationBucket | null {
    for (const b of this.buckets) {
      if (confidence >= b.rangeStart && confidence < b.rangeEnd) return b
    }
    // Clamp: below first bucket → first, above last → last
    if (confidence < BUCKET_STARTS[0]) return this.buckets[0]
    return this.buckets[this.buckets.length - 1]
  }

  private interpolate(confidence: number): number | null {
    // Find nearest populated neighbors (below and above)
    let below: CalibrationBucket | null = null
    let above: CalibrationBucket | null = null

    for (const b of this.buckets) {
      if (b.total < MIN_SAMPLES) continue
      const mid = (b.rangeStart + b.rangeEnd) / 2
      if (mid <= confidence) below = b
      if (mid > confidence && !above) above = b
    }

    if (below && above) {
      const belowMid = (below.rangeStart + below.rangeEnd) / 2
      const aboveMid = (above.rangeStart + above.rangeEnd) / 2
      const t = (confidence - belowMid) / (aboveMid - belowMid)
      return below.actualWinRate + t * (above.actualWinRate - below.actualWinRate)
    }

    // Only one neighbor — use it directly (closest populated bucket)
    if (below) return below.actualWinRate
    if (above) return above.actualWinRate

    return null // No populated buckets at all
  }
}

export const btcCalibrationService = new BtcCalibrationService()
