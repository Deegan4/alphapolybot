import { describe, it, expect, vi } from 'vitest'
import type { Market } from '@/types'

// Stub side-effectful services so the pure helpers and class metadata can be imported.
vi.mock('@/services/api', () => ({ polymarketUSClient: {} }))
vi.mock('@/services/realtime', () => ({ realtimeService: {} }))
vi.mock('@/services/trading/TradingService', () => ({ tradingService: {} }))
vi.mock('@/services/trading/ActivityLogger', () => ({ activityLogger: {} }))
vi.mock('@/services/trading/TradeLogger', () => ({ tradeLogger: {} }))
vi.mock('@/services/trading/RejectionTracker', () => ({ rejectionTracker: {} }))
vi.mock('@/stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({}) } }))
vi.mock('@/stores/walletStore', () => ({ useWalletStore: { getState: () => ({}) } }))

import {
  evaluateTwoLegArb,
  sizeArbLegs,
  selectArbCandidates,
  syntheticLegMarket,
  DipArbStrategy,
} from '../DipArbStrategy'

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: 'ev1',
    slug: 'who-wins',
    question: 'Who wins?',
    outcomes: ['Alice', 'Bob'],
    outcomeSlugs: ['who-wins-alice', 'who-wins-bob'],
    outcomePrices: [0.5, 0.5],
    active: true,
    closed: false,
    endDate: '2026-12-31T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    volume: 5_000,
    volume24hr: 500,
    liquidity: 800,
    ...overrides,
  }
}

describe('evaluateTwoLegArb', () => {
  it('finds an arb when asks + premium sum below the target', () => {
    const arb = evaluateTwoLegArb(0.45, 0.47, 0.96, 0.01)
    expect(arb).not.toBeNull()
    expect(arb!.askSum).toBe(0.92)
    expect(arb!.legPriceA).toBe(0.46)
    expect(arb!.legPriceB).toBe(0.48)
    expect(arb!.costPerShare).toBe(0.94)
    expect(arb!.profitPerShare).toBe(0.06)
    expect(arb!.profitPercent).toBeCloseTo(0.06 / 0.94, 6)
  })

  it('rejects when raw asks already meet the target', () => {
    expect(evaluateTwoLegArb(0.50, 0.46, 0.96)).toBeNull()
    expect(evaluateTwoLegArb(0.60, 0.50, 0.96)).toBeNull()
  })

  it('rejects when the fill premium eats the edge', () => {
    // 0.47 + 0.48 = 0.95 < 0.96, but +1¢ each → 0.97
    expect(evaluateTwoLegArb(0.47, 0.48, 0.96, 0.01)).toBeNull()
    // with zero premium the same quote is an arb
    expect(evaluateTwoLegArb(0.47, 0.48, 0.96, 0)).not.toBeNull()
  })

  it('rejects degenerate quotes', () => {
    expect(evaluateTwoLegArb(0, 0.5, 0.96)).toBeNull()
    expect(evaluateTwoLegArb(0.5, 1, 0.96)).toBeNull()
    expect(evaluateTwoLegArb(NaN, 0.3, 0.96)).toBeNull()
  })

  it('caps leg prices at 99¢', () => {
    const arb = evaluateTwoLegArb(0.985, 0.005, 1.0, 0.01)
    expect(arb).toBeNull() // 0.99 + 0.02 → 1.01 ≥ target
  })
})

describe('sizeArbLegs', () => {
  const arb = evaluateTwoLegArb(0.45, 0.47, 0.96, 0.01)!

  it('buys the same share count on both legs and splits the budget by price', () => {
    const s = sizeArbLegs(10, arb)!
    expect(s.shares).toBe(10.63)
    expect(s.amountA).toBeCloseTo(10.63 * 0.46, 2)
    expect(s.amountB).toBeCloseTo(10.63 * 0.48, 2)
    expect(s.totalCost).toBeLessThanOrEqual(10)
    // Each share pays $1 at resolution → payoff exceeds cost by the locked profit
    expect(s.shares - s.totalCost).toBeCloseTo(s.shares * arb.profitPerShare, 1)
  })

  it('returns null when a leg would be below the minimum', () => {
    expect(sizeArbLegs(1.5, arb)).toBeNull()
    expect(sizeArbLegs(0, arb)).toBeNull()
  })
})

describe('selectArbCandidates', () => {
  it('keeps active two-outcome events with enough volume, thin books first', () => {
    const thin = market({ id: 'thin', liquidity: 100 })
    const deep = market({ id: 'deep', liquidity: 50_000 })
    const single = market({ id: 'single', outcomes: ['Yes'], outcomeSlugs: ['only'] })
    const multi = market({ id: 'multi', outcomes: ['A', 'B', 'C'], outcomeSlugs: ['a', 'b', 'c'] })
    const closed = market({ id: 'closed', closed: true })
    const quiet = market({ id: 'quiet', volume24hr: 1 })
    const picked = selectArbCandidates([deep, single, multi, closed, quiet, thin], 10, 50)
    expect(picked.map(m => m.id)).toEqual(['thin', 'deep'])
  })

  it('caps at batchSize', () => {
    const many = Array.from({ length: 5 }, (_, i) => market({ id: `m${i}` }))
    expect(selectArbCandidates(many, 3, 0)).toHaveLength(3)
  })
})

describe('syntheticLegMarket', () => {
  it('targets the outcome market slug with YES at the leg price', () => {
    const leg = syntheticLegMarket(market(), 1, 0.48)
    expect(leg.slug).toBe('who-wins-bob')
    expect(leg.question).toBe('Who wins? — Bob')
    expect(leg.outcomes).toEqual(['Yes', 'No'])
    expect(leg.outcomePrices).toEqual([0.48, 0.52])
    expect(leg.eventSlug).toBe('who-wins')
  })
})

describe('DipArbStrategy', () => {
  it('is live on Polymarket US with arbitrage metadata', () => {
    const s = new DipArbStrategy()
    expect(s.available).toBe(true)
    expect(s.strategyType).toBe('arbitrage')
    expect(s.getDipConfig().sumTarget).toBe(0.96)
    expect(s.getArbStats()).toEqual({ rounds: 0, completed: 0, failed: 0, totalProfit: 0 })
  })

  it('merges config and emits configUpdated', () => {
    const s = new DipArbStrategy({ cooldownMs: 1 })
    const handler = vi.fn()
    s.on('configUpdated', handler)
    s.setDipConfig({ sumTarget: 0.9 })
    expect(s.getDipConfig()).toMatchObject({ cooldownMs: 1, sumTarget: 0.9 })
    expect(handler).toHaveBeenCalled()
  })
})
