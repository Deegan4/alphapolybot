import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MarketFeeCache } from '../MarketFeeCache'

const mockGetFeeRateBps = vi.fn().mockResolvedValue(156)

// Mock CLOBClient — dynamic import in MarketFeeCache
vi.mock('@/services/api/CLOBClient', () => ({
  clobClient: {
    getFeeRateBps: mockGetFeeRateBps,
  },
}))

describe('MarketFeeCache', () => {
  let cache: MarketFeeCache

  beforeEach(() => {
    cache = new MarketFeeCache()
    mockGetFeeRateBps.mockClear()
    mockGetFeeRateBps.mockResolvedValue(156) // reset default
  })

  // ─── Duration Detection ───────────────────────────────────

  describe('detectDuration', () => {
    it('detects 5-minute markets', () => {
      expect(cache.detectDuration('will-btc-go-up-5m-1234')).toBe('5m')
      expect(cache.detectDuration('Will BTC go up in 5 minutes?')).toBe('5m')
      expect(cache.detectDuration('btc-5min-up')).toBe('5m')
    })

    it('detects 15-minute markets', () => {
      expect(cache.detectDuration('will-btc-go-up-15m-5678')).toBe('15m')
      expect(cache.detectDuration('Will BTC go up in 15 minutes?')).toBe('15m')
    })

    it('detects hourly markets', () => {
      expect(cache.detectDuration('will-btc-go-up-1hr-9012')).toBe('1hr')
      expect(cache.detectDuration('Will ETH go up in 1 hour?')).toBe('1hr')
      expect(cache.detectDuration('60 minute BTC prediction')).toBe('1hr')
    })

    it('detects 4-hour markets', () => {
      expect(cache.detectDuration('will-btc-go-up-4hr-3456')).toBe('4hr')
      expect(cache.detectDuration('4 hour window')).toBe('4hr')
    })

    it('detects daily markets', () => {
      expect(cache.detectDuration('will-btc-go-up-24hr-7890')).toBe('24hr')
      expect(cache.detectDuration('Daily BTC prediction')).toBe('24hr')
    })

    it('returns unknown for non-matching text', () => {
      expect(cache.detectDuration('will-trump-win')).toBe('unknown')
      expect(cache.detectDuration('presidential election 2026')).toBe('unknown')
    })

    it('caches duration results', () => {
      const slug = 'will-btc-go-up-5m-1234'
      cache.detectDuration(slug)
      cache.detectDuration(slug)
      expect(cache.detectDuration(slug)).toBe('5m')
    })
  })

  // ─── Fee Lookup ───────────────────────────────────────────

  describe('getFeeRate', () => {
    it('fetches and caches fee rate', async () => {
      const info = await cache.getFeeRate('token123', 'will-btc-go-up-1hr-1234')
      expect(info.feeRateBps).toBe(156)
      expect(info.feePercent).toBeCloseTo(0.0156)
      expect(info.duration).toBe('1hr')
      expect(info.isViable).toBe(true) // 156 ≤ 200
      expect(info.roundTripBps).toBe(312)
    })

    it('returns cached value on second call', async () => {
      await cache.getFeeRate('tokenCacheTest', 'will-btc-go-up-1hr-1234')
      await cache.getFeeRate('tokenCacheTest', 'will-btc-go-up-1hr-1234')

      expect(mockGetFeeRateBps).toHaveBeenCalledTimes(1) // only fetched once
    })

    it('marks high-fee markets as not viable', async () => {
      mockGetFeeRateBps.mockResolvedValueOnce(1000) // 10%

      const info = await cache.getFeeRate('token456', 'will-btc-go-up-15m-5678')
      expect(info.feeRateBps).toBe(1000)
      expect(info.isViable).toBe(false)
    })
  })

  // ─── Viability Check ──────────────────────────────────────

  describe('checkViability', () => {
    it('always viable for maker orders', async () => {
      const result = await cache.checkViability('token123', 'will-btc-go-up-15m-5678', true)
      expect(result.viable).toBe(true)
      expect(result.reason).toContain('Maker')
    })

    it('blocks taker orders on high-fee markets', async () => {
      mockGetFeeRateBps.mockResolvedValueOnce(1000)

      const result = await cache.checkViability('token789', 'will-btc-go-up-15m-5678', false)
      expect(result.viable).toBe(false)
      expect(result.reason).toContain('exceeds')
    })

    it('allows taker orders on low-fee markets', async () => {
      mockGetFeeRateBps.mockResolvedValueOnce(50)

      const result = await cache.checkViability('tokenlow', 'will-btc-go-up-1hr-1234', false)
      expect(result.viable).toBe(true)
    })

    it('respects custom max bps', async () => {
      mockGetFeeRateBps.mockResolvedValueOnce(150)

      const result = await cache.checkViability('tokencustom', 'will-btc-go-up-1hr-1234', false, 100)
      expect(result.viable).toBe(false) // 150 > custom max 100
    })
  })

  // ─── Break-Even Confidence ────────────────────────────────

  describe('breakEvenConfidence', () => {
    it('computes correct break-even for 0 fee', () => {
      expect(cache.breakEvenConfidence(0.40, 0)).toBeCloseTo(0.40)
    })

    it('computes higher break-even with fees', () => {
      const be = cache.breakEvenConfidence(0.40, 156)
      expect(be).toBeGreaterThan(0.40)
      expect(be).toBeCloseTo(0.4063, 3)
    })

    it('returns 1 for extreme fees', () => {
      expect(cache.breakEvenConfidence(0.50, 10000)).toBe(1)
    })
  })

  // ─── Cache Management ─────────────────────────────────────

  describe('cache management', () => {
    it('getCached returns null for unknown token', () => {
      expect(cache.getCached('nonexistent')).toBeNull()
    })

    it('clear removes all entries', async () => {
      await cache.getFeeRate('token1', 'test-1hr-slug')
      expect(cache.cacheSize).toBe(1)
      cache.clear()
      expect(cache.cacheSize).toBe(0)
    })
  })
})
