import { describe, it, expect } from 'vitest'
import {
  roundOrderQuantity,
  netPositionQty,
  qtyBought,
  usdBalance,
  isTransientLatencyReject,
} from '../pmusWire'
import { chunkSlugs, WS_MAX_MARKETS_PER_SUBSCRIPTION } from '@/services/realtime/RealtimeService'

describe('roundOrderQuantity', () => {
  it('floors to whole contracts by default and for minimumTradeQty 1', () => {
    expect(roundOrderQuantity(14.7058)).toBe(14)
    expect(roundOrderQuantity(14.7058, 1)).toBe(14)
    expect(roundOrderQuantity(0.9, 1)).toBe(0)
  })

  it('keeps decimals on partial-contract markets', () => {
    expect(roundOrderQuantity(14.7058, 0.01)).toBe(14.7)
    expect(roundOrderQuantity(3.999, 0.01)).toBe(3.99)
    expect(roundOrderQuantity(3, 0.01)).toBe(3)
  })

  it('rejects non-positive input', () => {
    expect(roundOrderQuantity(0)).toBe(0)
    expect(roundOrderQuantity(-2, 1)).toBe(0)
    expect(roundOrderQuantity(NaN)).toBe(0)
  })
})

describe('portfolio parsing', () => {
  it('prefers the decimal position fields over the rounded integer ones', () => {
    expect(netPositionQty({ netPosition: '1', netPositionDecimal: '0.5000' })).toBe(0.5)
    expect(netPositionQty({ netPosition: '-3' })).toBe(-3)
    expect(netPositionQty({})).toBe(0)
    expect(qtyBought({ qtyBought: '2', qtyBoughtDecimal: '1.5000' })).toBe(1.5)
  })

  it('picks the USD balance entry', () => {
    expect(usdBalance([{ currency: 'EUR', v: 1 }, { currency: 'USD', v: 2 }])?.v).toBe(2)
    expect(usdBalance([{ currency: 'USDC', v: 3 }])?.v).toBe(3)
    expect(usdBalance([])).toBeUndefined()
  })
})

describe('isTransientLatencyReject', () => {
  it('matches both documented messages, case-insensitively', () => {
    expect(isTransientLatencyReject('Order Processing Max Delay Exceeded')).toBe(true)
    expect(isTransientLatencyReject('reject: global rate limit exceeded')).toBe(true)
    expect(isTransientLatencyReject('ORD_REJECT_REASON_NO_LIQUIDITY')).toBe(false)
    expect(isTransientLatencyReject(undefined)).toBe(false)
  })
})

describe('chunkSlugs', () => {
  it('splits subscriptions at the 100-market limit', () => {
    const slugs = Array.from({ length: 250 }, (_, i) => `m${i}`)
    const chunks = chunkSlugs(slugs)
    expect(WS_MAX_MARKETS_PER_SUBSCRIPTION).toBe(100)
    expect(chunks.map(c => c.length)).toEqual([100, 100, 50])
    expect(chunks.flat()).toEqual(slugs)
    expect(chunkSlugs([])).toEqual([])
  })
})

describe('makerEntryPrice', () => {
  it('improves the bid by one tick when the spread is wider than a tick', async () => {
    const { makerEntryPrice } = await import('../pmusWire')
    expect(makerEntryPrice(0.27, 0.34)).toBe(0.28)
    expect(makerEntryPrice(0.12, 0.14)).toBe(0.13)
  })

  it('joins the bid when the spread is one tick, and never reaches the ask', async () => {
    const { makerEntryPrice } = await import('../pmusWire')
    expect(makerEntryPrice(0.12, 0.13)).toBe(0.12)
    // sub-cent bid on a 0.001-tick market, sent on the 1¢ grid
    expect(makerEntryPrice(0.274, 0.34)).toBe(0.28)
    expect(makerEntryPrice(0.274, 0.28)).toBe(0.27)
  })

  it('refuses one-sided or crossed books', async () => {
    const { makerEntryPrice } = await import('../pmusWire')
    expect(makerEntryPrice(0, 0.5)).toBeNull()
    expect(makerEntryPrice(0.5, 0)).toBeNull()
    expect(makerEntryPrice(0.5, 0.5)).toBeNull()
    expect(makerEntryPrice(0.6, 0.5)).toBeNull()
  })
})

describe('takerAfterExpiryPlan', () => {
  it('takes the unfilled remainder when the ask is within the chase limit', async () => {
    const { takerAfterExpiryPlan } = await import('../pmusWire')
    expect(takerAfterExpiryPlan({ makerPrice: 0.28, size: 17, filled: 5, ask: 0.30, maxChase: 0.02 })).toEqual({ take: 12, price: 0.30 })
    expect(takerAfterExpiryPlan({ makerPrice: 0.28, size: 3.5, filled: 1.25, ask: 0.29, maxChase: 0.02, minimumTradeQty: 0.01 })).toEqual({ take: 2.25, price: 0.29 })
  })

  it('skips when the price ran away, the book is empty, or nothing is left', async () => {
    const { takerAfterExpiryPlan } = await import('../pmusWire')
    expect(takerAfterExpiryPlan({ makerPrice: 0.28, size: 17, filled: 0, ask: 0.31, maxChase: 0.02 })).toHaveProperty('skip')
    expect(takerAfterExpiryPlan({ makerPrice: 0.28, size: 17, filled: 0, ask: null, maxChase: 0.02 })).toHaveProperty('skip')
    expect(takerAfterExpiryPlan({ makerPrice: 0.28, size: 17, filled: 17, ask: 0.28, maxChase: 0.02 })).toHaveProperty('skip')
    expect(takerAfterExpiryPlan({ makerPrice: 0.28, size: 17, filled: 16.5, ask: 0.28, maxChase: 0.02 })).toHaveProperty('skip')
  })
})

describe('urgencyAdjustedChase', () => {
  it('keeps the base limit far from the window end and for unknown ends', async () => {
    const { urgencyAdjustedChase } = await import('../pmusWire')
    expect(urgencyAdjustedChase(0.02, 10 * 60_000)).toBe(0.02)
    expect(urgencyAdjustedChase(0.02, null)).toBe(0.02)
  })

  it('widens linearly toward the end, capped, and is zero once closed', async () => {
    const { urgencyAdjustedChase } = await import('../pmusWire')
    expect(urgencyAdjustedChase(0.02, 2.5 * 60_000)).toBeCloseTo(0.02 * 1.75, 10) // halfway: 1.75×
    expect(urgencyAdjustedChase(0.02, 1)).toBeCloseTo(0.05, 4)                    // ~2.5× = 0.05
    expect(urgencyAdjustedChase(0.04, 1)).toBe(0.05)                              // capped
    expect(urgencyAdjustedChase(0.02, 0)).toBe(0)
    expect(urgencyAdjustedChase(0.02, -5)).toBe(0)
  })
})

describe('makerOrderOutlivesWindow', () => {
  it('flags a resting order that would still be live after the window closes', async () => {
    const { makerOrderOutlivesWindow } = await import('../pmusWire')
    expect(makerOrderOutlivesWindow(0, 5 * 60_000, 4 * 60_000)).toBe(true)
    expect(makerOrderOutlivesWindow(0, 5 * 60_000, 10 * 60_000)).toBe(false)
    expect(makerOrderOutlivesWindow(0, 5 * 60_000, undefined)).toBe(false)
  })
})
