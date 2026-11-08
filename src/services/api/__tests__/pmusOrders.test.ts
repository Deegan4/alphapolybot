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
