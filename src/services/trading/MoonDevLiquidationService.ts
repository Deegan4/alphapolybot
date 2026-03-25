/**
 * MoonDevLiquidationService — Multi-exchange liquidation aggregation
 *
 * Polls Moon Dev's all_liquidations endpoint every 30s for BTC liquidation
 * events across exchanges. Maintains rolling 1m/5m/10m/15m windows of
 * long vs short liquidation volume. Computes cascade momentum (rate of
 * change in liquidation volume across time buckets).
 *
 * Singleton, non-blocking — errors are caught and logged, never thrown.
 */
import { activityLogger } from './ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'
import type { MoonDevLiquidation } from '@/services/api/MoonDevClient'

// ==========================================
// TYPES
// ==========================================

export interface LiquidationSummary {
  longVolume1m: number
  shortVolume1m: number
  longVolume5m: number
  shortVolume5m: number
  longVolume10m: number
  shortVolume10m: number
  dominantSide: 'long' | 'short' | 'balanced'
  cascadeMomentum: number
}

export interface MoonDevLiquidationMetrics {
  pollCount: number
  pollErrors: number
  lastPollTime: number
  totalEvents: number
}

// ==========================================
// CONSTANTS
// ==========================================

const POLL_INTERVAL_MS = 30_000
const BTC_SYMBOLS = /^(BTC|BTCUSDT|BTCUSD|XBTUSD|BTC-PERP|BTCUSDT\.P)$/i

// Rolling window durations in ms
const WINDOW_1M  =  1 * 60_000
const WINDOW_5M  =  5 * 60_000
const WINDOW_10M = 10 * 60_000
const WINDOW_15M = 15 * 60_000

// ==========================================
// INTERNAL TYPES
// ==========================================

interface TimestampedLiq {
  ts: number
  side: 'long' | 'short'
  value: number
}

// ==========================================
// SERVICE
// ==========================================

export class MoonDevLiquidationService {
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private running = false

  // Rolling buffer of BTC liquidation events (kept for up to 15m)
  private buffer: TimestampedLiq[] = []

  // Metrics
  private metrics: MoonDevLiquidationMetrics = {
    pollCount: 0,
    pollErrors: 0,
    lastPollTime: 0,
    totalEvents: 0,
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    await this.poll()
    this.pollInterval = setInterval(() => this.poll(), POLL_INTERVAL_MS)

    activityLogger.logSystem('MoonDevLiquidation started — polling all_liquidations every 30s')
  }

  stop(): void {
    this.running = false
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    this.buffer = []
    activityLogger.logSystem('MoonDevLiquidation stopped')
  }

  isRunning(): boolean {
    return this.running
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  getLiquidationSummary(): LiquidationSummary {
    const now = Date.now()
    this.pruneBuffer(now)

    const longVolume1m  = this.sumVolume(now, WINDOW_1M, 'long')
    const shortVolume1m = this.sumVolume(now, WINDOW_1M, 'short')
    const longVolume5m  = this.sumVolume(now, WINDOW_5M, 'long')
    const shortVolume5m = this.sumVolume(now, WINDOW_5M, 'short')
    const longVolume10m = this.sumVolume(now, WINDOW_10M, 'long')
    const shortVolume10m = this.sumVolume(now, WINDOW_10M, 'short')

    // Dominant side based on 5m window
    const total5m = longVolume5m + shortVolume5m
    let dominantSide: 'long' | 'short' | 'balanced' = 'balanced'
    if (total5m > 0) {
      const longRatio = longVolume5m / total5m
      if (longRatio > 0.6) dominantSide = 'long'
      else if (longRatio < 0.4) dominantSide = 'short'
    }

    // Cascade momentum: compare volume in last minute vs first minute of 5m window
    const cascadeMomentum = this.computeCascadeMomentum(now)

    return {
      longVolume1m,
      shortVolume1m,
      longVolume5m,
      shortVolume5m,
      longVolume10m,
      shortVolume10m,
      dominantSide,
      cascadeMomentum,
    }
  }

  getMetrics(): MoonDevLiquidationMetrics {
    return { ...this.metrics }
  }

  // ==========================================
  // POLLING
  // ==========================================

  private async poll(): Promise<void> {
    try {
      const apiKey = useSettingsStore.getState().moondevApiKey
      if (!apiKey) {
        console.debug('[MoonDevLiq] No moondevApiKey configured, skipping poll')
        return
      }

      const { moonDevClient } = await import('@/services/api/MoonDevClient')
      moonDevClient.setApiKey(apiKey)

      const resp = await moonDevClient.getAllLiquidations('10m')

      this.metrics.pollCount++
      this.metrics.lastPollTime = Date.now()

      // Filter to BTC and ingest into rolling buffer
      const btcLiqs = (resp.liquidations || []).filter(
        (l: MoonDevLiquidation) => BTC_SYMBOLS.test(l.symbol)
      )

      for (const liq of btcLiqs) {
        const ts = typeof liq.timestamp === 'string'
          ? new Date(liq.timestamp).getTime()
          : liq.timestamp
        const side = this.normalizeSide(liq.side)
        if (side && ts > 0 && liq.value > 0) {
          this.buffer.push({ ts, side, value: liq.value })
          this.metrics.totalEvents++
        }
      }

      this.pruneBuffer(Date.now())

    } catch (err) {
      this.metrics.pollErrors++
      console.debug('[MoonDevLiq] Poll failed:', err)
    }
  }

  // ==========================================
  // INTERNALS
  // ==========================================

  /** Normalize side strings from different exchanges */
  private normalizeSide(raw: string): 'long' | 'short' | null {
    const s = raw.toLowerCase()
    if (s === 'long' || s === 'buy') return 'long'
    if (s === 'short' || s === 'sell') return 'short'
    return null
  }

  /** Sum volume for a given window and side */
  private sumVolume(now: number, windowMs: number, side: 'long' | 'short'): number {
    const cutoff = now - windowMs
    let total = 0
    for (const entry of this.buffer) {
      if (entry.ts >= cutoff && entry.side === side) {
        total += entry.value
      }
    }
    return total
  }

  /** Prune events older than 15m */
  private pruneBuffer(now: number): void {
    const cutoff = now - WINDOW_15M
    this.buffer = this.buffer.filter(e => e.ts >= cutoff)
  }

  /**
   * Cascade momentum: split the 5m window into 5 one-minute buckets.
   * Compare the most recent minute's volume to the earliest minute's volume.
   * Returns ratio (e.g., 3.0 = latest minute has 3x the volume of the earliest).
   * Returns 0 if no data in earliest bucket, 1.0 if equal.
   */
  private computeCascadeMomentum(now: number): number {
    const bucketMs = 60_000
    const buckets: number[] = [0, 0, 0, 0, 0] // [oldest, ..., newest]

    for (const entry of this.buffer) {
      const age = now - entry.ts
      if (age > WINDOW_5M) continue
      const idx = Math.min(4, Math.floor((WINDOW_5M - age) / bucketMs))
      buckets[idx] += entry.value
    }

    const earliest = buckets[0]
    const latest = buckets[4]

    if (earliest <= 0) {
      // No volume in earliest bucket — if latest has volume, momentum is building from zero
      return latest > 0 ? latest / 1000 : 0 // normalize: $1K baseline
    }

    return latest / earliest
  }
}

// Singleton
export const moonDevLiquidationService = new MoonDevLiquidationService()
