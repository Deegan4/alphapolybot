import { describe, it, expect, vi } from 'vitest'
import type { Market } from '@/types'

// The strategy module pulls in services with side effects; stub them so the
// pure helpers can be imported in isolation.
vi.mock('@/services/api', () => ({ polymarketUSClient: {} }))
vi.mock('@/services/realtime', () => ({ realtimeService: {} }))
vi.mock('@/services/trading/MicrostructureAnalyzer', () => ({ microstructureAnalyzer: {} }))
vi.mock('@/services/trading/TradingService', () => ({ tradingService: {} }))
vi.mock('@/services/trading/ActivityLogger', () => ({ activityLogger: {} }))
vi.mock('@/services/trading/TradeLogger', () => ({ tradeLogger: {} }))
vi.mock('@/services/trading/EdgeTracker', () => ({ edgeTracker: {} }))
vi.mock('@/services/trading/RejectionTracker', () => ({ rejectionTracker: {} }))
vi.mock('@/stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({}) } }))
vi.mock('@/stores/walletStore', () => ({ useWalletStore: { getState: () => ({}) } }))

import {
  selectEligibleMarkets,
  signalSlugFor,
  MICRO_MIN_LIQUIDITY,
  MICRO_MIN_VOLUME,
  MicrostructureMomentumStrategy,
} from '../MicrostructureMomentumStrategy'

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: 'm1',
    slug: 'will-x-happen',
    question: 'Will X happen?',
    outcomes: ['Yes', 'No'],
    outcomeSlugs: ['will-x-happen-yes', 'will-x-happen-no'],
    outcomePrices: [0.55, 0.45],
    active: true,
    closed: false,
    endDate: '2026-12-31T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    volume: 10_000,
    volume24hr: 1_000,
    liquidity: 5_000,
    ...overrides,
  }
}

describe('selectEligibleMarkets', () => {
  it('keeps active, binary, liquid markets with volume', () => {
    expect(selectEligibleMarkets([market()], 10)).toHaveLength(1)
  })

  it('drops closed or inactive markets', () => {
    expect(selectEligibleMarkets([market({ closed: true }), market({ active: false })], 10)).toHaveLength(0)
  })

  it('requires exactly two outcomes with per-outcome slugs (needed for the price feed)', () => {
    const multi = market({ outcomes: ['A', 'B', 'C'], outcomeSlugs: ['a', 'b', 'c'] })
    const noSlugs = market({ outcomeSlugs: undefined })
    expect(selectEligibleMarkets([multi, noSlugs], 10)).toHaveLength(0)
  })

  it('applies liquidity and volume floors, using total volume when 24h is absent', () => {
    const thin = market({ liquidity: MICRO_MIN_LIQUIDITY - 1 })
    const quiet = market({ volume24hr: MICRO_MIN_VOLUME - 1 })
    const fallback = market({ volume24hr: undefined, volume: MICRO_MIN_VOLUME })
    expect(selectEligibleMarkets([thin, quiet, fallback], 10)).toEqual([fallback])
  })

  it('sorts by volume descending and caps at batchSize', () => {
    const low = market({ id: 'low', volume24hr: 200 })
    const high = market({ id: 'high', volume24hr: 9_000 })
    const mid = market({ id: 'mid', volume24hr: 3_000 })
    expect(selectEligibleMarkets([low, high, mid], 2).map(m => m.id)).toEqual(['high', 'mid'])
  })
})

describe('signalSlugFor', () => {
  it('returns the YES outcome slug', () => {
    expect(signalSlugFor(market())).toBe('will-x-happen-yes')
  })
  it('is undefined without outcome slugs', () => {
    expect(signalSlugFor(market({ outcomeSlugs: undefined }))).toBeUndefined()
  })
})

describe('MicrostructureMomentumStrategy', () => {
  it('is available on Polymarket US with mechanical metadata', () => {
    const s = new MicrostructureMomentumStrategy()
    expect(s.available).toBe(true)
    expect(s.strategyType).toBe('mechanical')
    expect(s.getMicroConfig().marketBatchSize).toBeGreaterThan(0)
  })

  it('merges config updates and emits configUpdated', () => {
    const s = new MicrostructureMomentumStrategy()
    const handler = vi.fn()
    s.on('configUpdated', handler)
    s.setMicroConfig({ tradeSize: 7 })
    expect(s.getMicroConfig().tradeSize).toBe(7)
    expect(handler).toHaveBeenCalled()
  })
})
