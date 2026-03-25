/**
 * LiquidationHeatmapService — Predictive liquidation cascade detection
 *
 * Uses Hyperliquid's FREE public API (no auth, no API key) to estimate
 * liquidation level clusters and cascade risk.
 *
 * Data sources (all free, all from api.hyperliquid.xyz/info):
 *   - metaAndAssetCtxs → openInterest + funding rate per coin
 *   - allMids → current mark prices
 *
 * The trick: we don't need individual whale positions. We model the AGGREGATE
 * open interest across leverage bands (5x, 10x, 20x, 50x, 100x) to estimate
 * where liquidation clusters exist. The funding rate tells us the long/short
 * imbalance, so we know which side has more fuel.
 *
 * This is the same approach used by Coinglass and Kingfisher heatmaps — they
 * model from aggregate data, not individual positions.
 *
 * Liquidation price formulas:
 *   Long liq  = entryPx × (1 - 1/leverage × (1 - maintenanceMarginRate))
 *   Short liq = entryPx × (1 + 1/leverage × (1 - maintenanceMarginRate))
 *
 * With entry ≈ markPx (most active OI entered recently), maintenance margin ≈ 0.5%:
 *   Long liq  ≈ markPx × (1 - 0.995/leverage)
 *   Short liq ≈ markPx × (1 + 0.995/leverage)
 */
import { activityLogger } from './ActivityLogger'

// ==========================================
// TYPES
// ==========================================

/** A cluster of estimated liquidations at a specific leverage band */
export interface LiquidationCluster {
  triggerPrice: number    // estimated liquidation price level
  fuelUSD: number         // estimated USD value at risk in this band
  positionCount: number   // synthetic — based on OI distribution model
  avgDistancePct: number  // % distance from current price to trigger
  avgLeverage: number     // leverage of this band
  side: 'long' | 'short'
}

/** Cascade risk assessment for a given asset + direction */
export interface CascadeRisk {
  score: number           // 0-1, higher = more likely cascade
  direction: 'up' | 'down'
  fuelUSD: number         // total fuel available for cascade
  triggerPrice: number    // nearest trigger price level
  currentPrice: number    // current market price
  distancePct: number     // % price move needed to trigger nearest cluster
  clusters: LiquidationCluster[]
  timestamp: number
}

/** Service health metrics */
export interface HeatmapMetrics {
  lastPollTime: number
  pollCount: number
  pollErrors: number
  totalLongFuel: number   // estimated USD in long positions at risk
  totalShortFuel: number  // estimated USD in short positions at risk
  clustersDetected: number
}

/** Raw market data from Hyperliquid */
export interface HyperliquidMarketData {
  coin: string
  markPx: number
  openInterest: number   // in coin units
  oiUSD: number          // OI × markPx
  funding: number        // funding rate (positive = longs pay)
  dayVolume: number
}

// ==========================================
// CONSTANTS
// ==========================================

const POLL_INTERVAL_MS = 30_000
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info'

// Leverage distribution model — what % of OI is at each leverage level.
// Based on Hyperliquid's typical user distribution (retail-heavy, high leverage).
// These weights are calibrated from public exchange data.
const LEVERAGE_BANDS = [
  { leverage: 5,   weight: 0.15 },  // 15% of OI at 5x
  { leverage: 10,  weight: 0.25 },  // 25% at 10x
  { leverage: 20,  weight: 0.30 },  // 30% at 20x (most popular)
  { leverage: 50,  weight: 0.20 },  // 20% at 50x
  { leverage: 100, weight: 0.10 },  // 10% at 100x (degen)
]

// Maintenance margin rate (Hyperliquid uses ~0.5% for BTC)
const MAINTENANCE_MARGIN_RATE = 0.005

// Only track coins with meaningful OI
const TRACKED_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE']

// Min fuel to consider a cluster meaningful
const MIN_CLUSTER_FUEL_USD = 1_000_000  // $1M — aggregate OI is large

// ==========================================
// SERVICE
// ==========================================

export class LiquidationHeatmapService {
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private running = false

  // Cached market data
  private marketData = new Map<string, HyperliquidMarketData>()

  // Pre-computed cascade risks
  private cascadeRisks = new Map<string, CascadeRisk>()

  // Metrics
  private metrics: HeatmapMetrics = {
    lastPollTime: 0,
    pollCount: 0,
    pollErrors: 0,
    totalLongFuel: 0,
    totalShortFuel: 0,
    clustersDetected: 0,
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    await this.poll()
    this.pollInterval = setInterval(() => this.poll(), POLL_INTERVAL_MS)

    activityLogger.logSystem('LiquidationHeatmap started — free Hyperliquid OI model (no API key needed)')
  }

  stop(): void {
    this.running = false
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    this.marketData.clear()
    this.cascadeRisks.clear()
    activityLogger.logSystem('LiquidationHeatmap stopped')
  }

  isRunning(): boolean {
    return this.running
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  getCascadeRisk(coin: string, direction: 'up' | 'down'): CascadeRisk | null {
    return this.cascadeRisks.get(`${coin.toUpperCase()}:${direction}`) ?? null
  }

  getAllCascadeRisks(): CascadeRisk[] {
    return Array.from(this.cascadeRisks.values())
  }

  getMetrics(): HeatmapMetrics {
    return { ...this.metrics }
  }

  getMarketData(): HyperliquidMarketData[] {
    return Array.from(this.marketData.values())
  }

  // ==========================================
  // POLLING — Hyperliquid free API
  // ==========================================

  private async poll(): Promise<void> {
    try {
      const data = await this.fetchMetaAndAssetCtxs()

      this.metrics.pollCount++
      this.metrics.lastPollTime = Date.now()

      // Store market data for tracked coins
      this.marketData.clear()
      for (const d of data) {
        if (TRACKED_COINS.includes(d.coin)) {
          this.marketData.set(d.coin, d)
        }
      }

      // Recompute risks
      this.recomputeAllRisks()

    } catch (err) {
      this.metrics.pollErrors++
      console.debug('[LiqHeatmap] Poll failed:', err)
    }
  }

  /** Fetch metaAndAssetCtxs from Hyperliquid (free, no auth) */
  async fetchMetaAndAssetCtxs(): Promise<HyperliquidMarketData[]> {
    const response = await fetch(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    })

    if (!response.ok) throw new Error(`Hyperliquid API ${response.status}`)

    const raw = await response.json() as [
      { universe: Array<{ name: string }> },
      Array<{ markPx: string; openInterest: string; funding: string; dayNtlVlm: string; oraclePx: string }>,
    ]

    const meta = raw[0].universe
    const ctxs = raw[1]

    return meta.map((m, i) => {
      const markPx = parseFloat(ctxs[i].markPx)
      const oi = parseFloat(ctxs[i].openInterest)
      return {
        coin: m.name,
        markPx,
        openInterest: oi,
        oiUSD: oi * markPx,
        funding: parseFloat(ctxs[i].funding),
        dayVolume: parseFloat(ctxs[i].dayNtlVlm),
      }
    })
  }

  // ==========================================
  // RISK COMPUTATION
  // ==========================================

  private recomputeAllRisks(): void {
    this.cascadeRisks.clear()
    let totalClusters = 0
    let totalLongFuel = 0
    let totalShortFuel = 0

    for (const [coin, data] of this.marketData) {
      // Estimate long/short split from funding rate
      // Positive funding = longs pay shorts = more longs than shorts
      // longFraction ranges from 0.4 to 0.7 based on funding intensity
      const fundingIntensity = Math.tanh(Math.abs(data.funding) * 100_000) // normalize to ~0-1
      const longFraction = data.funding > 0
        ? 0.5 + fundingIntensity * 0.2  // more longs: 0.5-0.7
        : 0.5 - fundingIntensity * 0.2  // more shorts: 0.3-0.5

      const longOiUSD = data.oiUSD * longFraction
      const shortOiUSD = data.oiUSD * (1 - longFraction)

      totalLongFuel += longOiUSD
      totalShortFuel += shortOiUSD

      // Build clusters for longs (downward cascade risk)
      const longClusters = this.buildLeverageClusters(data.markPx, longOiUSD, 'long')
      totalClusters += longClusters.length
      if (longClusters.length > 0) {
        const risk = this.computeRisk(coin, 'down', longClusters, data.markPx, data)
        if (risk.score > 0) {
          this.cascadeRisks.set(`${coin}:down`, risk)
        }
      }

      // Build clusters for shorts (upward cascade risk)
      const shortClusters = this.buildLeverageClusters(data.markPx, shortOiUSD, 'short')
      totalClusters += shortClusters.length
      if (shortClusters.length > 0) {
        const risk = this.computeRisk(coin, 'up', shortClusters, data.markPx, data)
        if (risk.score > 0) {
          this.cascadeRisks.set(`${coin}:up`, risk)
        }
      }
    }

    this.metrics.totalLongFuel = totalLongFuel
    this.metrics.totalShortFuel = totalShortFuel
    this.metrics.clustersDetected = totalClusters
  }

  /**
   * Build liquidation clusters by modeling OI across leverage bands.
   *
   * For each leverage band, compute:
   * - The liquidation price at that leverage
   * - The % of OI estimated at that leverage (from distribution model)
   * - Distance from current price
   */
  buildLeverageClusters(
    markPx: number,
    sideOiUSD: number,
    side: 'long' | 'short',
  ): LiquidationCluster[] {
    const clusters: LiquidationCluster[] = []

    for (const band of LEVERAGE_BANDS) {
      const fuelUSD = sideOiUSD * band.weight

      if (fuelUSD < MIN_CLUSTER_FUEL_USD) continue

      // Compute estimated liq price at this leverage
      // Long: liq = mark × (1 - (1 - mmr) / leverage)
      // Short: liq = mark × (1 + (1 - mmr) / leverage)
      const marginFactor = (1 - MAINTENANCE_MARGIN_RATE) / band.leverage
      const triggerPrice = side === 'long'
        ? markPx * (1 - marginFactor)
        : markPx * (1 + marginFactor)

      const distancePct = Math.abs(triggerPrice - markPx) / markPx * 100

      clusters.push({
        triggerPrice,
        fuelUSD,
        positionCount: Math.round(fuelUSD / 50_000), // synthetic: assume ~$50K avg position
        avgDistancePct: distancePct,
        avgLeverage: band.leverage,
        side,
      })
    }

    // Sort by distance ascending (nearest trigger first)
    return clusters.sort((a, b) => a.avgDistancePct - b.avgDistancePct)
  }

  /**
   * Compute cascade risk score.
   *
   * Formula:
   *   fuelScore     = clamp(totalFuel / $500M, 0, 1)      — aggregate OI is much larger
   *   distScore     = 1 - clamp(nearestDist / 20%, 0, 1)  — closer = higher risk
   *   fundingScore  = clamp(|funding| × 100K, 0, 1)       — extreme funding = crowded trade
   *   volumeScore   = clamp(dayVolume / $1B, 0, 1)        — high volume = volatile conditions
   *
   *   score = fuelScore × 0.30 + distScore × 0.30 + fundingScore × 0.25 + volumeScore × 0.15
   */
  computeRisk(
    coin: string,
    direction: 'up' | 'down',
    clusters: LiquidationCluster[],
    markPx: number,
    data: HyperliquidMarketData,
  ): CascadeRisk {
    const nearestCluster = clusters[0]
    const totalFuel = clusters.reduce((sum, c) => sum + c.fuelUSD, 0)

    const fuelScore = Math.min(totalFuel / 500_000_000, 1)
    const distScore = 1 - Math.min(nearestCluster.avgDistancePct / 20, 1)
    const fundingScore = Math.min(Math.abs(data.funding) * 100_000, 1)
    const volumeScore = Math.min(data.dayVolume / 1_000_000_000, 1)

    const score = fuelScore * 0.30 + distScore * 0.30 + fundingScore * 0.25 + volumeScore * 0.15

    return {
      score,
      direction,
      fuelUSD: totalFuel,
      triggerPrice: nearestCluster.triggerPrice,
      currentPrice: markPx,
      distancePct: nearestCluster.avgDistancePct,
      clusters,
      timestamp: Date.now(),
    }
  }
}

// Singleton
export const liquidationHeatmapService = new LiquidationHeatmapService()
