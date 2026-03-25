import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock ActivityLogger
vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: {
    logSystem: vi.fn(),
    logTrade: vi.fn(),
  },
}))

import { LiquidationHeatmapService } from '../LiquidationHeatmapService'
import type { HyperliquidMarketData, LiquidationCluster } from '../LiquidationHeatmapService'

// ─── Helpers ─────────────────────────────────

/** Build a mock Hyperliquid metaAndAssetCtxs response */
function mockHyperliquidResponse(coins: Array<{
  name: string
  markPx: number
  openInterest: number
  funding: number
  dayNtlVlm: number
}>) {
  const universe = coins.map(c => ({ name: c.name }))
  const ctxs = coins.map(c => ({
    markPx: String(c.markPx),
    openInterest: String(c.openInterest),
    funding: String(c.funding),
    dayNtlVlm: String(c.dayNtlVlm),
    oraclePx: String(c.markPx),
  }))
  return [{ universe }, ctxs]
}

function makeMarketData(overrides: Partial<HyperliquidMarketData> = {}): HyperliquidMarketData {
  return {
    coin: 'BTC',
    markPx: 95000,
    openInterest: 20000,    // ~$1.9B OI at $95K
    oiUSD: 95000 * 20000,
    funding: 0.0001,        // slightly long-biased
    dayVolume: 500_000_000,
    ...overrides,
  }
}

describe('LiquidationHeatmapService', () => {
  let service: LiquidationHeatmapService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new LiquidationHeatmapService()
  })

  afterEach(() => {
    service.stop()
  })

  // ─── buildLeverageClusters ─────────────────────────────────

  describe('buildLeverageClusters()', () => {
    it('produces clusters for each leverage band above fuel threshold', () => {
      // $500M OI — large enough that all bands exceed $1M min
      const clusters = service.buildLeverageClusters(95000, 500_000_000, 'long')

      expect(clusters.length).toBeGreaterThan(0)
      expect(clusters.length).toBeLessThanOrEqual(5) // max 5 leverage bands

      for (const c of clusters) {
        expect(c.side).toBe('long')
        expect(c.fuelUSD).toBeGreaterThanOrEqual(1_000_000)
        expect(c.avgDistancePct).toBeGreaterThan(0)
        expect(c.triggerPrice).toBeLessThan(95000) // longs liquidated below mark
      }
    })

    it('long clusters have trigger prices below mark price', () => {
      const clusters = service.buildLeverageClusters(100000, 100_000_000, 'long')
      for (const c of clusters) {
        expect(c.triggerPrice).toBeLessThan(100000)
      }
    })

    it('short clusters have trigger prices above mark price', () => {
      const clusters = service.buildLeverageClusters(100000, 100_000_000, 'short')
      for (const c of clusters) {
        expect(c.triggerPrice).toBeGreaterThan(100000)
      }
    })

    it('higher leverage = closer trigger price', () => {
      const clusters = service.buildLeverageClusters(95000, 500_000_000, 'long')
      // Sorted by distance ascending → first cluster is nearest (highest leverage)
      expect(clusters[0].avgLeverage).toBeGreaterThan(clusters[clusters.length - 1].avgLeverage)
    })

    it('filters out clusters below $1M fuel', () => {
      // $5M total OI → at 10% weight, lowest band = $500K < $1M threshold
      const clusters = service.buildLeverageClusters(95000, 5_000_000, 'long')
      for (const c of clusters) {
        expect(c.fuelUSD).toBeGreaterThanOrEqual(1_000_000)
      }
    })

    it('returns empty for very small OI', () => {
      // $2M → no band reaches $1M threshold
      const clusters = service.buildLeverageClusters(95000, 2_000_000, 'long')
      expect(clusters).toHaveLength(0)
    })

    it('computes synthetic position count (~$50K avg)', () => {
      const clusters = service.buildLeverageClusters(95000, 500_000_000, 'long')
      for (const c of clusters) {
        expect(c.positionCount).toBe(Math.round(c.fuelUSD / 50_000))
      }
    })

    it('sorts by distance ascending (nearest first)', () => {
      const clusters = service.buildLeverageClusters(95000, 500_000_000, 'long')
      for (let i = 1; i < clusters.length; i++) {
        expect(clusters[i].avgDistancePct).toBeGreaterThanOrEqual(clusters[i - 1].avgDistancePct)
      }
    })
  })

  // ─── computeRisk ─────────────────────────────────

  describe('computeRisk()', () => {
    const defaultData = makeMarketData()

    it('produces score between 0 and 1', () => {
      const clusters: LiquidationCluster[] = [{
        triggerPrice: 90000,
        fuelUSD: 50_000_000,
        positionCount: 1000,
        avgDistancePct: 3.0,
        avgLeverage: 20,
        side: 'long',
      }]

      const risk = service.computeRisk('BTC', 'down', clusters, 95000, defaultData)
      expect(risk.score).toBeGreaterThan(0)
      expect(risk.score).toBeLessThanOrEqual(1)
      expect(risk.direction).toBe('down')
    })

    it('higher fuel = higher score', () => {
      const makeClusters = (fuel: number): LiquidationCluster[] => [{
        triggerPrice: 90000,
        fuelUSD: fuel,
        positionCount: 10,
        avgDistancePct: 3.0,
        avgLeverage: 20,
        side: 'long',
      }]

      const lowFuel = service.computeRisk('BTC', 'down', makeClusters(10_000_000), 95000, defaultData)
      const highFuel = service.computeRisk('BTC', 'down', makeClusters(400_000_000), 95000, defaultData)

      expect(highFuel.score).toBeGreaterThan(lowFuel.score)
    })

    it('closer distance = higher score', () => {
      const makeClusters = (dist: number): LiquidationCluster[] => [{
        triggerPrice: 90000,
        fuelUSD: 50_000_000,
        positionCount: 10,
        avgDistancePct: dist,
        avgLeverage: 20,
        side: 'long',
      }]

      const close = service.computeRisk('BTC', 'down', makeClusters(1.0), 95000, defaultData)
      const far = service.computeRisk('BTC', 'down', makeClusters(15.0), 95000, defaultData)

      expect(close.score).toBeGreaterThan(far.score)
    })

    it('extreme funding = higher score', () => {
      const clusters: LiquidationCluster[] = [{
        triggerPrice: 90000,
        fuelUSD: 50_000_000,
        positionCount: 10,
        avgDistancePct: 3.0,
        avgLeverage: 20,
        side: 'long',
      }]

      const lowFunding = service.computeRisk('BTC', 'down', clusters, 95000,
        makeMarketData({ funding: 0.000001 }))
      const highFunding = service.computeRisk('BTC', 'down', clusters, 95000,
        makeMarketData({ funding: 0.001 }))

      expect(highFunding.score).toBeGreaterThan(lowFunding.score)
    })

    it('higher volume = higher score', () => {
      const clusters: LiquidationCluster[] = [{
        triggerPrice: 90000,
        fuelUSD: 50_000_000,
        positionCount: 10,
        avgDistancePct: 3.0,
        avgLeverage: 20,
        side: 'long',
      }]

      const lowVol = service.computeRisk('BTC', 'down', clusters, 95000,
        makeMarketData({ dayVolume: 100_000_000 }))
      const highVol = service.computeRisk('BTC', 'down', clusters, 95000,
        makeMarketData({ dayVolume: 900_000_000 }))

      expect(highVol.score).toBeGreaterThan(lowVol.score)
    })

    it('includes all clusters in result', () => {
      const clusters: LiquidationCluster[] = [
        { triggerPrice: 90000, fuelUSD: 50_000_000, positionCount: 100, avgDistancePct: 1.0, avgLeverage: 100, side: 'long' },
        { triggerPrice: 85000, fuelUSD: 80_000_000, positionCount: 200, avgDistancePct: 5.0, avgLeverage: 20, side: 'long' },
      ]

      const risk = service.computeRisk('BTC', 'down', clusters, 95000, defaultData)
      expect(risk.clusters).toHaveLength(2)
      expect(risk.fuelUSD).toBe(130_000_000)
      expect(risk.triggerPrice).toBe(90000) // nearest
      expect(risk.currentPrice).toBe(95000)
    })

    it('$500M+ fuel saturates fuel score at 1.0', () => {
      const clusters: LiquidationCluster[] = [{
        triggerPrice: 94000,
        fuelUSD: 800_000_000,
        positionCount: 16000,
        avgDistancePct: 1.0,
        avgLeverage: 50,
        side: 'long',
      }]

      const risk = service.computeRisk('BTC', 'down', clusters, 95000,
        makeMarketData({ funding: 0.01, dayVolume: 2_000_000_000 }))
      expect(risk.score).toBeGreaterThan(0.9)
    })
  })

  // ─── Polling + getCascadeRisk ─────────────────────────────────

  describe('polling and getCascadeRisk()', () => {
    it('returns null when no data polled', () => {
      expect(service.getCascadeRisk('BTC', 'down')).toBeNull()
      expect(service.getCascadeRisk('BTC', 'up')).toBeNull()
    })

    it('populates cascade risks after successful poll', async () => {
      const mockResponse = mockHyperliquidResponse([
        { name: 'BTC', markPx: 95000, openInterest: 20000, funding: 0.0003, dayNtlVlm: 800_000_000 },
        { name: 'ETH', markPx: 3500, openInterest: 500000, funding: -0.0002, dayNtlVlm: 400_000_000 },
      ])

      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response)

      await service.start()

      // BTC should have cascade risks (large OI)
      const btcDown = service.getCascadeRisk('BTC', 'down')
      const btcUp = service.getCascadeRisk('BTC', 'up')

      // At least one direction should have a risk
      const hasBtcRisk = btcDown !== null || btcUp !== null
      expect(hasBtcRisk).toBe(true)

      service.stop()
    })

    it('handles poll errors gracefully', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('network error'))

      await service.start()

      expect(service.isRunning()).toBe(true)
      expect(service.getMetrics().pollErrors).toBe(1)
      expect(service.getCascadeRisk('BTC', 'down')).toBeNull()

      service.stop()
    })

    it('handles non-OK response gracefully', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Response)

      await service.start()

      expect(service.isRunning()).toBe(true)
      expect(service.getMetrics().pollErrors).toBe(1)

      service.stop()
    })
  })

  // ─── fetchMetaAndAssetCtxs ─────────────────────────────────

  describe('fetchMetaAndAssetCtxs()', () => {
    it('parses Hyperliquid response into HyperliquidMarketData', async () => {
      const mockResponse = mockHyperliquidResponse([
        { name: 'BTC', markPx: 95000, openInterest: 20000, funding: 0.0001, dayNtlVlm: 500_000_000 },
        { name: 'ETH', markPx: 3500, openInterest: 800000, funding: -0.0002, dayNtlVlm: 200_000_000 },
      ])

      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response)

      const data = await service.fetchMetaAndAssetCtxs()

      expect(data).toHaveLength(2)
      expect(data[0].coin).toBe('BTC')
      expect(data[0].markPx).toBe(95000)
      expect(data[0].openInterest).toBe(20000)
      expect(data[0].oiUSD).toBe(95000 * 20000)
      expect(data[0].funding).toBe(0.0001)
      expect(data[0].dayVolume).toBe(500_000_000)

      expect(data[1].coin).toBe('ETH')
      expect(data[1].markPx).toBe(3500)
    })

    it('POSTs to correct endpoint with correct body', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [{ universe: [] }, []],
      } as Response)

      await service.fetchMetaAndAssetCtxs()

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.hyperliquid.xyz/info',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
        }),
      )
    })

    it('throws on non-OK response', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 429,
      } as Response)

      await expect(service.fetchMetaAndAssetCtxs()).rejects.toThrow('Hyperliquid API 429')
    })
  })

  // ─── Metrics ─────────────────────────────────

  describe('getMetrics()', () => {
    it('tracks poll count and timestamps', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockHyperliquidResponse([]),
      } as Response)

      await service.start()

      const metrics = service.getMetrics()
      expect(metrics.pollCount).toBe(1)
      expect(metrics.lastPollTime).toBeGreaterThan(0)
      expect(metrics.pollErrors).toBe(0)

      service.stop()
    })

    it('tracks fuel totals from OI data', async () => {
      const mockResponse = mockHyperliquidResponse([
        { name: 'BTC', markPx: 100000, openInterest: 20000, funding: 0.0001, dayNtlVlm: 500_000_000 },
      ])

      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response)

      await service.start()

      const metrics = service.getMetrics()
      // BTC OI = 20000 × $100K = $2B
      // With slight positive funding → longFraction > 0.5
      expect(metrics.totalLongFuel).toBeGreaterThan(0)
      expect(metrics.totalShortFuel).toBeGreaterThan(0)
      expect(metrics.totalLongFuel + metrics.totalShortFuel).toBeCloseTo(2_000_000_000, -6)

      service.stop()
    })

    it('returns a copy (not reference)', () => {
      const m1 = service.getMetrics()
      const m2 = service.getMetrics()
      expect(m1).not.toBe(m2)
      expect(m1).toEqual(m2)
    })
  })

  // ─── Lifecycle ─────────────────────────────────

  describe('lifecycle', () => {
    it('start is idempotent', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockHyperliquidResponse([]),
      } as Response)

      await service.start()
      await service.start() // second call = no-op

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(service.isRunning()).toBe(true)

      service.stop()
    })

    it('stop clears all state', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockHyperliquidResponse([
          { name: 'BTC', markPx: 95000, openInterest: 20000, funding: 0.0003, dayNtlVlm: 800_000_000 },
        ]),
      } as Response)

      await service.start()

      service.stop()

      expect(service.isRunning()).toBe(false)
      expect(service.getCascadeRisk('BTC', 'down')).toBeNull()
      expect(service.getCascadeRisk('BTC', 'up')).toBeNull()
      expect(service.getAllCascadeRisks()).toHaveLength(0)
      expect(service.getMarketData()).toHaveLength(0)
    })
  })

  // ─── getAllCascadeRisks + getMarketData ─────────────────────────────────

  describe('getAllCascadeRisks() + getMarketData()', () => {
    it('returns risks for tracked coins', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockHyperliquidResponse([
          { name: 'BTC', markPx: 95000, openInterest: 20000, funding: 0.0005, dayNtlVlm: 1_000_000_000 },
          { name: 'ETH', markPx: 3500, openInterest: 800000, funding: -0.0003, dayNtlVlm: 400_000_000 },
          { name: 'DOGE', markPx: 0.15, openInterest: 100000, funding: 0.0001, dayNtlVlm: 50_000_000 },
        ]),
      } as Response)

      await service.start()

      // BTC and ETH are tracked, DOGE is not
      const marketData = service.getMarketData()
      const coins = marketData.map(d => d.coin)
      expect(coins).toContain('BTC')
      expect(coins).toContain('ETH')
      expect(coins).not.toContain('DOGE')

      const allRisks = service.getAllCascadeRisks()
      expect(allRisks.length).toBeGreaterThan(0)

      service.stop()
    })
  })
})
