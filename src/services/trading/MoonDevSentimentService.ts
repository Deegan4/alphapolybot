/**
 * MoonDevSentimentService — HLP sentiment / z-score contrarian filter
 *
 * Polls Moon Dev's HLP sentiment endpoint every 5 minutes. Caches per-coin
 * z-scores. Provides contrarian signal interpretation:
 *   - HLP long (positive z-score) = retail is short = bullish for us
 *   - HLP short (negative z-score) = retail is long = bearish for us
 *
 * Used as a viability gate by strategies via shouldFilterTrade().
 *
 * Singleton, non-blocking — errors are caught and logged, never thrown.
 */
import { activityLogger } from './ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'

// ==========================================
// TYPES
// ==========================================

export interface SentimentSignal {
  zScore: number
  direction: 'bullish' | 'bearish' | 'neutral'
  isExtreme: boolean
  confidence: 'high' | 'medium' | 'low'
}

export interface MoonDevSentimentMetrics {
  pollCount: number
  pollErrors: number
  lastPollTime: number
  extremeCount: number
}

// ==========================================
// CONSTANTS
// ==========================================

const POLL_INTERVAL_MS = 300_000 // 5 minutes
const DEFAULT_MIN_Z_SCORE = 2.0

// ==========================================
// SERVICE
// ==========================================

export class MoonDevSentimentService {
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private running = false

  // Cached z-scores per coin (uppercase key)
  private zScores = new Map<string, number>()

  // Overall API confidence from last poll
  private overallConfidence: 'high' | 'medium' | 'low' = 'low'

  private minZScore = DEFAULT_MIN_Z_SCORE

  // Metrics
  private metrics: MoonDevSentimentMetrics = {
    pollCount: 0,
    pollErrors: 0,
    lastPollTime: 0,
    extremeCount: 0,
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    await this.poll()
    this.pollInterval = setInterval(() => this.poll(), POLL_INTERVAL_MS)

    activityLogger.logSystem('MoonDevSentiment started — polling HLP sentiment every 5m')
  }

  stop(): void {
    this.running = false
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    this.zScores.clear()
    activityLogger.logSystem('MoonDevSentiment stopped')
  }

  isRunning(): boolean {
    return this.running
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  getSentimentSignal(coin: string): SentimentSignal {
    const key = coin.toUpperCase()
    const zScore = this.zScores.get(key) ?? 0
    const absZ = Math.abs(zScore)

    // Direction: positive z = HLP long = retail short = bullish
    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral'
    if (zScore > this.minZScore) direction = 'bullish'
    else if (zScore < -this.minZScore) direction = 'bearish'

    const isExtreme = absZ > this.minZScore

    // Confidence tiers based on z-score magnitude
    let confidence: 'high' | 'medium' | 'low' = 'low'
    if (absZ > 3.0) confidence = 'high'
    else if (absZ > 2.0) confidence = 'medium'

    return { zScore, direction, isExtreme, confidence }
  }

  /**
   * Returns true if sentiment STRONGLY opposes the trade direction.
   * Used as a viability gate by strategies.
   *
   * Logic:
   *   - Trading UP but sentiment is extreme bearish (z < -minZScore) → filter (true)
   *   - Trading DOWN but sentiment is extreme bullish (z > +minZScore) → filter (true)
   *   - Otherwise → don't filter (false)
   */
  shouldFilterTrade(coin: string, direction: 'up' | 'down'): boolean {
    const signal = this.getSentimentSignal(coin)
    if (!signal.isExtreme) return false

    // Extreme bearish opposes an up trade
    if (direction === 'up' && signal.direction === 'bearish') return true
    // Extreme bullish opposes a down trade
    if (direction === 'down' && signal.direction === 'bullish') return true

    return false
  }

  getMetrics(): MoonDevSentimentMetrics {
    return { ...this.metrics }
  }

  // ==========================================
  // POLLING
  // ==========================================

  private async poll(): Promise<void> {
    try {
      const apiKey = useSettingsStore.getState().moondevApiKey
      if (!apiKey) {
        console.debug('[MoonDevSentiment] No moondevApiKey configured, skipping poll')
        return
      }

      const { moonDevClient } = await import('@/services/api/MoonDevClient')
      moonDevClient.setApiKey(apiKey)

      const resp = await moonDevClient.getHLPSentiment()

      this.metrics.pollCount++
      this.metrics.lastPollTime = Date.now()

      // Cache z-scores per coin
      this.zScores.clear()
      let extremeCount = 0

      if (resp.net_delta) {
        for (const [coin, data] of Object.entries(resp.net_delta)) {
          const z = data.z_score
          this.zScores.set(coin.toUpperCase(), z)
          if (Math.abs(z) > this.minZScore) extremeCount++
        }
      }

      this.metrics.extremeCount = extremeCount
      this.overallConfidence = (resp.confidence as 'high' | 'medium' | 'low') || 'low'

    } catch (err) {
      this.metrics.pollErrors++
      console.debug('[MoonDevSentiment] Poll failed:', err)
    }
  }
}

// Singleton
export const moonDevSentimentService = new MoonDevSentimentService()
