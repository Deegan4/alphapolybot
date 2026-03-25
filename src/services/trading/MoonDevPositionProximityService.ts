/**
 * MoonDevPositionProximityService — Liquidation proximity from position snapshots
 *
 * Polls Moon Dev's position_snapshots endpoint every 60s for BTC positions
 * near their liquidation prices. Pre-computes fuel totals by side and distance
 * band (within 1% and 2%). Exposes asymmetry signal for strategies.
 *
 * Singleton, non-blocking — errors are caught and logged, never thrown.
 */
import { activityLogger } from './ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'
import type { MoonDevPositionSnapshot } from '@/services/api/MoonDevClient'

// ==========================================
// TYPES
// ==========================================

export interface NearLiquidationFuel {
  count: number
  totalValueUSD: number
  avgDistancePct: number
  within1PctUSD: number
  within2PctUSD: number
}

export interface ProximitySignal {
  longFuelUSD: number
  shortFuelUSD: number
  dominantRisk: 'long' | 'short'
  asymmetry: number
}

export interface PositionProximityMetrics {
  pollCount: number
  pollErrors: number
  lastPollTime: number
  positionsTracked: number
}

// ==========================================
// CONSTANTS
// ==========================================

const POLL_INTERVAL_MS = 60_000
const DEFAULT_MAX_DISTANCE_PCT = 2.0

// ==========================================
// SERVICE
// ==========================================

export class MoonDevPositionProximityService {
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private running = false

  // Cached snapshots filtered to within maxDistancePct
  private longPositions: MoonDevPositionSnapshot[] = []
  private shortPositions: MoonDevPositionSnapshot[] = []

  private maxDistancePct = DEFAULT_MAX_DISTANCE_PCT

  // Metrics
  private metrics: PositionProximityMetrics = {
    pollCount: 0,
    pollErrors: 0,
    lastPollTime: 0,
    positionsTracked: 0,
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    await this.poll()
    this.pollInterval = setInterval(() => this.poll(), POLL_INTERVAL_MS)

    activityLogger.logSystem('MoonDevPositionProximity started — polling position_snapshots every 60s')
  }

  stop(): void {
    this.running = false
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    this.longPositions = []
    this.shortPositions = []
    activityLogger.logSystem('MoonDevPositionProximity stopped')
  }

  isRunning(): boolean {
    return this.running
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  getNearLiquidationFuel(side: 'long' | 'short'): NearLiquidationFuel {
    const positions = side === 'long' ? this.longPositions : this.shortPositions

    if (positions.length === 0) {
      return { count: 0, totalValueUSD: 0, avgDistancePct: 0, within1PctUSD: 0, within2PctUSD: 0 }
    }

    let totalValue = 0
    let totalDistWeighted = 0
    let within1Pct = 0
    let within2Pct = 0

    for (const p of positions) {
      totalValue += p.position_value
      totalDistWeighted += p.distance_pct * p.position_value

      if (p.distance_pct <= 1.0) within1Pct += p.position_value
      if (p.distance_pct <= 2.0) within2Pct += p.position_value
    }

    return {
      count: positions.length,
      totalValueUSD: totalValue,
      avgDistancePct: totalValue > 0 ? totalDistWeighted / totalValue : 0,
      within1PctUSD: within1Pct,
      within2PctUSD: within2Pct,
    }
  }

  getProximitySignal(): ProximitySignal {
    const longFuel = this.getNearLiquidationFuel('long')
    const shortFuel = this.getNearLiquidationFuel('short')

    const longFuelUSD = longFuel.totalValueUSD
    const shortFuelUSD = shortFuel.totalValueUSD

    const maxVal = Math.max(longFuelUSD, shortFuelUSD)
    const minVal = Math.min(longFuelUSD, shortFuelUSD)

    return {
      longFuelUSD,
      shortFuelUSD,
      dominantRisk: longFuelUSD >= shortFuelUSD ? 'long' : 'short',
      asymmetry: minVal > 0 ? maxVal / minVal : (maxVal > 0 ? Infinity : 1),
    }
  }

  getMetrics(): PositionProximityMetrics {
    return { ...this.metrics }
  }

  // ==========================================
  // POLLING
  // ==========================================

  private async poll(): Promise<void> {
    try {
      const apiKey = useSettingsStore.getState().moondevApiKey
      if (!apiKey) {
        console.debug('[MoonDevProximity] No moondevApiKey configured, skipping poll')
        return
      }

      const { moonDevClient } = await import('@/services/api/MoonDevClient')
      moonDevClient.setApiKey(apiKey)

      const resp = await moonDevClient.getPositionSnapshots('BTC')

      this.metrics.pollCount++
      this.metrics.lastPollTime = Date.now()

      // Filter to positions within maxDistancePct of liquidation
      const snapshots = (resp.snapshots || []).filter(
        (s: MoonDevPositionSnapshot) => s.distance_pct <= this.maxDistancePct
      )

      this.longPositions = snapshots.filter((s: MoonDevPositionSnapshot) => s.side === 'long')
      this.shortPositions = snapshots.filter((s: MoonDevPositionSnapshot) => s.side === 'short')

      this.metrics.positionsTracked = this.longPositions.length + this.shortPositions.length

    } catch (err) {
      this.metrics.pollErrors++
      console.debug('[MoonDevProximity] Poll failed:', err)
    }
  }
}

// Singleton
export const moonDevPositionProximityService = new MoonDevPositionProximityService()
