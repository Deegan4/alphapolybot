/**
 * LLM Confidence Calibration Tracker
 *
 * Tracks prediction outcomes over time and builds a calibration curve.
 * When the LLM says "70% likely", this tells you the actual hit rate.
 *
 * The calibration correction is applied BEFORE Kelly sizing so that
 * position sizes reflect true edge, not overconfident LLM estimates.
 *
 * Buckets predictions into 10 bins (0-10%, 10-20%, ..., 90-100%)
 * and tracks the actual outcome rate in each bin.
 */

export interface CalibrationBucket {
  /** Lower bound of confidence range (inclusive) */
  lower: number
  /** Upper bound of confidence range (exclusive) */
  upper: number
  /** Number of predictions in this bucket */
  count: number
  /** Number of correct predictions */
  correct: number
  /** Actual hit rate (correct / count) */
  actualRate: number
  /** Average predicted confidence in this bucket */
  avgPredicted: number
}

export interface CalibrationResult {
  buckets: CalibrationBucket[]
  totalPredictions: number
  totalCorrect: number
  overallAccuracy: number
  /** Brier score (lower is better, 0 = perfect calibration) */
  brierScore: number
  /** Whether we have enough data to trust the calibration (>= 50 samples) */
  isReliable: boolean
}

interface PredictionRecord {
  marketId: string
  predictedProb: number       // LLM confidence (0-1)
  predictedOutcome: 'yes' | 'no'
  timestamp: number
  actualOutcome?: 'yes' | 'no'
  resolvedAt?: number
  category?: string           // Market category for per-category accuracy tracking
}

const NUM_BUCKETS = 10
const MIN_RELIABLE_SAMPLES = 50

export class CalibrationTracker {
  private predictions: PredictionRecord[] = []
  private maxPredictions = 2000

  /**
   * Record a prediction (called when LLM analyzes a market).
   */
  recordPrediction(marketId: string, predictedProb: number, predictedOutcome: 'yes' | 'no', category?: string): void {
    // Avoid duplicate predictions for the same market
    const existing = this.predictions.find(p => p.marketId === marketId && !p.actualOutcome)
    if (existing) return

    this.predictions.push({
      marketId,
      predictedProb,
      predictedOutcome,
      timestamp: Date.now(),
      category,
    })

    // Trim old predictions
    if (this.predictions.length > this.maxPredictions) {
      this.predictions = this.predictions.slice(-this.maxPredictions)
    }

    this.persist()
  }

  /**
   * Record the actual outcome of a market (called when market resolves).
   */
  recordOutcome(marketId: string, actualOutcome: 'yes' | 'no'): void {
    for (const pred of this.predictions) {
      if (pred.marketId === marketId && !pred.actualOutcome) {
        pred.actualOutcome = actualOutcome
        pred.resolvedAt = Date.now()
      }
    }
    this.persist()
  }

  /**
   * Get calibrated probability.
   *
   * If we have enough data, adjusts the LLM's confidence based on
   * observed hit rates. If not enough data, returns a conservative
   * shrinkage toward 50% (the maximum-entropy prior).
   *
   * @param rawConfidence - LLM's reported confidence (0-1)
   * @returns Calibrated probability (0-1)
   */
  calibrate(rawConfidence: number): number {
    const calibration = this.getCalibration()

    if (!calibration.isReliable) {
      // Not enough resolved data to calibrate.
      // With 0 resolved predictions, shrinkage would crush everything to 0.50
      // and permanently block all trades (chicken-and-egg: can't resolve without trading).
      // Only apply mild shrinkage once we have SOME resolved data to learn from.
      if (calibration.totalPredictions < 5) {
        return rawConfidence // Pass through — no data to calibrate against
      }
      const shrinkage = Math.max(0.1, 1 - calibration.totalPredictions / MIN_RELIABLE_SAMPLES)
      return rawConfidence * (1 - shrinkage) + 0.5 * shrinkage
    }

    // Find the bucket this confidence falls in
    const bucketIndex = Math.min(
      Math.floor(rawConfidence * NUM_BUCKETS),
      NUM_BUCKETS - 1,
    )
    const bucket = calibration.buckets[bucketIndex]

    // If bucket has enough samples, use its actual rate
    if (bucket.count >= 5) {
      return bucket.actualRate
    }

    // Sparse bucket — interpolate between neighbors
    return this.interpolate(rawConfidence, calibration.buckets)
  }

  /**
   * Compute the full calibration curve.
   */
  getCalibration(): CalibrationResult {
    const resolved = this.predictions.filter(p => p.actualOutcome != null)

    // Initialize buckets
    const buckets: CalibrationBucket[] = Array.from({ length: NUM_BUCKETS }, (_, i) => ({
      lower: i / NUM_BUCKETS,
      upper: (i + 1) / NUM_BUCKETS,
      count: 0,
      correct: 0,
      actualRate: 0.5, // Prior
      avgPredicted: (i + 0.5) / NUM_BUCKETS,
    }))

    let totalCorrect = 0
    let brierSum = 0

    for (const pred of resolved) {
      const isCorrect = pred.predictedOutcome === pred.actualOutcome
      if (isCorrect) totalCorrect++

      // Brier score: mean squared error of probability estimates
      const outcomeValue = pred.actualOutcome === pred.predictedOutcome ? 1 : 0
      brierSum += (pred.predictedProb - outcomeValue) ** 2

      // Bucket assignment
      const idx = Math.min(Math.floor(pred.predictedProb * NUM_BUCKETS), NUM_BUCKETS - 1)
      buckets[idx].count++
      if (isCorrect) buckets[idx].correct++
      buckets[idx].avgPredicted =
        (buckets[idx].avgPredicted * (buckets[idx].count - 1) + pred.predictedProb) / buckets[idx].count
    }

    // Compute actual rates
    for (const bucket of buckets) {
      if (bucket.count > 0) {
        bucket.actualRate = bucket.correct / bucket.count
      }
    }

    return {
      buckets,
      totalPredictions: resolved.length,
      totalCorrect,
      overallAccuracy: resolved.length > 0 ? totalCorrect / resolved.length : 0,
      brierScore: resolved.length > 0 ? brierSum / resolved.length : 1,
      isReliable: resolved.length >= MIN_RELIABLE_SAMPLES,
    }
  }

  /**
   * Get total number of recorded predictions (resolved + unresolved).
   * Used to decide whether enough data exists to trust calibration adjustments.
   */
  getTotalPredictions(): number {
    return this.predictions.length
  }

  /**
   * Get number of unresolved predictions (markets we're tracking).
   */
  get unresolvedCount(): number {
    return this.predictions.filter(p => !p.actualOutcome).length
  }

  /**
   * Get all predictions (for UI display).
   */
  getPredictions(): PredictionRecord[] {
    return [...this.predictions].sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * Hydrate from IndexedDB on startup.
   */
  async hydrate(): Promise<void> {
    try {
      const { indexedDBService } = await import('@/services/storage')
      const stored = await indexedDBService.loadCalibrationData?.() ?? []
      if (stored.length > 0) {
        const existingIds = new Set(this.predictions.map(p => p.marketId))
        const newFromStorage = stored.filter((p: PredictionRecord) => !existingIds.has(p.marketId))
        this.predictions = [...this.predictions, ...newFromStorage].slice(-this.maxPredictions)
        console.log(`[CalibrationTracker] Hydrated ${newFromStorage.length} prediction records`)
      }
    } catch {
      // Storage not available
    }
  }

  /**
   * Get accuracy for a specific market category.
   * Returns null if no resolved predictions exist for this category.
   */
  getCategoryAccuracy(category: string): { accuracy: number; sampleSize: number } | null {
    const resolved = this.predictions.filter(
      p => p.category === category && p.actualOutcome != null,
    )
    if (resolved.length === 0) return null

    const correct = resolved.filter(p => p.predictedOutcome === p.actualOutcome).length
    return {
      accuracy: correct / resolved.length,
      sampleSize: resolved.length,
    }
  }

  /**
   * Get top N categories by demonstrated accuracy.
   * Only includes categories with at least minSamples resolved predictions.
   */
  getBestCategories(minSamples: number = 10, topN: number = 5): Array<{
    category: string
    accuracy: number
    sampleSize: number
  }> {
    // Group resolved predictions by category
    const categoryMap = new Map<string, { correct: number; total: number }>()
    for (const pred of this.predictions) {
      if (!pred.actualOutcome || !pred.category) continue
      const entry = categoryMap.get(pred.category) ?? { correct: 0, total: 0 }
      entry.total++
      if (pred.predictedOutcome === pred.actualOutcome) entry.correct++
      categoryMap.set(pred.category, entry)
    }

    return Array.from(categoryMap.entries())
      .filter(([, stats]) => stats.total >= minSamples)
      .map(([category, stats]) => ({
        category,
        accuracy: stats.correct / stats.total,
        sampleSize: stats.total,
      }))
      .sort((a, b) => b.accuracy - a.accuracy)
      .slice(0, topN)
  }

  private interpolate(confidence: number, buckets: CalibrationBucket[]): number {
    // Linear interpolation between nearest populated buckets
    const idx = Math.min(Math.floor(confidence * NUM_BUCKETS), NUM_BUCKETS - 1)

    let lower: CalibrationBucket | null = null
    let upper: CalibrationBucket | null = null

    // Find nearest populated bucket below
    for (let i = idx; i >= 0; i--) {
      if (buckets[i].count >= 3) { lower = buckets[i]; break }
    }
    // Find nearest populated bucket above
    for (let i = idx; i < NUM_BUCKETS; i++) {
      if (buckets[i].count >= 3) { upper = buckets[i]; break }
    }

    if (lower && upper && lower !== upper) {
      const range = upper.avgPredicted - lower.avgPredicted
      const t = range > 0 ? (confidence - lower.avgPredicted) / range : 0.5
      return lower.actualRate + t * (upper.actualRate - lower.actualRate)
    }

    if (lower) return lower.actualRate
    if (upper) return upper.actualRate

    // No data at all — return conservative estimate
    return confidence * 0.7 + 0.5 * 0.3
  }

  private persist(): void {
    import('@/services/storage').then(({ indexedDBService }) => {
      indexedDBService.storeCalibrationData?.(this.predictions)
    }).catch(() => {})
  }
}

// Export singleton
export const calibrationTracker = new CalibrationTracker()
