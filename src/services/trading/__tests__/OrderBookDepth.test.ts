import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OrderBook } from '@/types/api'

const mockGetOrderBook = vi.fn()
vi.mock('@/services/api', async () => {
  const wire = await vi.importActual<typeof import('@/services/api/pmusWire')>('@/services/api/pmusWire')
  return {
    polymarketUSClient: { getOrderBook: (...a: unknown[]) => mockGetOrderBook(...a) },
    bookForOutcome: wire.bookForOutcome,
  }
})

import { OrderBookDepthAnalyzer } from '../OrderBookDepth'

// YES-quoted book: thin asks, deep bids
const book: OrderBook = {
  marketSlug: 'm',
  bids: [{ price: 0.40, size: 1000 }, { price: 0.39, size: 1000 }],
  asks: [{ price: 0.45, size: 2 }],
  lastUpdate: 0,
}

describe('OrderBookDepthAnalyzer outcome handling', () => {
  beforeEach(() => mockGetOrderBook.mockResolvedValue(book))

  it('YES buys walk the YES asks', async () => {
    const d = await new OrderBookDepthAnalyzer().checkBuyDepth('m', 50, 0.02)
    expect(d.bestPrice).toBe(0.45)
    expect(d.sufficient).toBe(false) // only $0.90 offered
  })

  it('NO buys walk the YES bids at 1 - price', async () => {
    const d = await new OrderBookDepthAnalyzer().checkBuyDepth('m', 50, 0.02, 'no')
    expect(d.bestPrice).toBe(0.6)
    expect(d.sufficient).toBe(true) // 1000 NO @ 0.60 offered
  })

  it('NO sells walk the YES asks at 1 - price', async () => {
    const d = await new OrderBookDepthAnalyzer().checkSellDepth('m', 1, 0.02, 'no')
    expect(d.bestPrice).toBe(0.55)
  })
})
