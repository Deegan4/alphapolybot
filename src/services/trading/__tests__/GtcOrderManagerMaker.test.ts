import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PendingGtcOrder } from '@/types/api'

const getOpenOrders = vi.fn()
vi.mock('@/services/api', () => ({
  polymarketUSClient: {
    getOpenOrders: (...a: unknown[]) => getOpenOrders(...a),
    cancelOrder: vi.fn().mockResolvedValue(true),
    cancelAllOrders: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('../RiskManager', () => ({ riskManager: { recordTradeResult: vi.fn() } }))
vi.mock('../ActivityLogger', () => ({ activityLogger: { logInfo: vi.fn(), logTrade: vi.fn(), logWarning: vi.fn() } }))
vi.mock('../PositionLifecycleManager', () => ({ positionLifecycleManager: { trackPosition: vi.fn() } }))
vi.mock('@/services/storage', () => ({
  indexedDBService: { storeGtcOrder: vi.fn(), removeGtcOrder: vi.fn(), loadGtcOrders: vi.fn().mockResolvedValue([]) },
}))
const recordPlaced = vi.fn()
const recordResolved = vi.fn()
vi.mock('../MakerFillTracker', () => ({
  makerFillTracker: { recordPlaced: (...a: unknown[]) => recordPlaced(...a), recordResolved: (...a: unknown[]) => recordResolved(...a) },
}))

import { GtcOrderManager } from '../GtcOrderManager'

const order = (over: Partial<PendingGtcOrder>): PendingGtcOrder => ({
  orderId: 'o1', marketSlug: 'm', outcome: 'yes', question: 'Q', side: 'BUY', price: 0.4, size: 10,
  costBasis: 4, strategy: 'micro', stopLossPercent: 0.2, takeProfitPercent: 0.3,
  placedAt: Date.now(), expiresAt: Date.now() + 60_000, status: 'pending', ...over,
})

describe('GtcOrderManager maker-first accounting', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records placement and fill for maker orders only', async () => {
    const m = new GtcOrderManager()
    m.trackOrder(order({ orderId: 'maker', entryKind: 'maker' }))
    m.trackOrder(order({ orderId: 'fallback' }))
    expect(recordPlaced).toHaveBeenCalledTimes(1)
    expect(recordPlaced).toHaveBeenCalledWith('micro')

    // Both gone from the open-order list before expiry → treated as filled
    getOpenOrders.mockResolvedValue([])
    await (m as unknown as { pollOrders(): Promise<void> }).pollOrders()
    await vi.waitFor(() => expect(recordResolved).toHaveBeenCalledTimes(1))
    expect(recordResolved).toHaveBeenCalledWith('filled', expect.objectContaining({ orderId: 'maker' }))
  })

  it('records expiry and cancellation', async () => {
    const m = new GtcOrderManager()
    m.trackOrder(order({ orderId: 'exp', entryKind: 'maker', expiresAt: Date.now() - 1 }))
    getOpenOrders.mockResolvedValue([])
    await (m as unknown as { pollOrders(): Promise<void> }).pollOrders()
    expect(recordResolved).toHaveBeenCalledWith('expired', expect.objectContaining({ orderId: 'exp' }))

    m.trackOrder(order({ orderId: 'cx', entryKind: 'maker' }))
    await m.cancelAll()
    expect(recordResolved).toHaveBeenCalledWith('cancelled', expect.objectContaining({ orderId: 'cx' }))
  })
})
