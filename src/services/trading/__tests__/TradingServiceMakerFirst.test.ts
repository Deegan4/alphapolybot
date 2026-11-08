import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Market, OrderRequest } from '@/types/api'

const placeOrder = vi.fn()
const getPrice = vi.fn()
const trackOrder = vi.fn()

vi.mock('@/services/api', async () => {
  const wire = await vi.importActual<typeof import('@/services/api/pmusWire')>('@/services/api/pmusWire')
  return {
    polymarketUSClient: {
      placeOrder: (r: OrderRequest) => placeOrder(r),
      getBalances: vi.fn().mockResolvedValue({ balance: 1000, buyingPower: 1000 }),
      getBestPrices: vi.fn().mockResolvedValue(null),
      getOrder: vi.fn().mockResolvedValue(null),
    },
    priceForOutcome: wire.priceForOutcome,
    reportedPriceForOutcome: wire.reportedPriceForOutcome,
    roundOrderQuantity: wire.roundOrderQuantity,
    isTransientLatencyReject: wire.isTransientLatencyReject,
    makerEntryPrice: wire.makerEntryPrice,
  }
})
vi.mock('@/services/realtime', () => ({ realtimeService: { getPrice: (s: string) => getPrice(s) } }))
vi.mock('@/stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({}) } }))
vi.mock('../RiskManager', () => ({
  riskManager: {
    addCapitalReservationFn: vi.fn(),
    validateTrade: () => ({ allowed: true }),
    recordTradeAttempt: vi.fn(),
    recordTradeResult: vi.fn(),
    recordMarketExposure: vi.fn(),
  },
}))
vi.mock('../OrderBookDepth', () => ({
  orderBookDepth: { checkBuyDepth: vi.fn().mockResolvedValue({ sufficient: true, maxFillableUSD: 1000 }) },
}))
vi.mock('../TradeLogger', () => ({ tradeLogger: { logEntry: vi.fn() } }))
vi.mock('../RejectionTracker', () => ({ rejectionTracker: { record: vi.fn() } }))
vi.mock('../ActivityLogger', () => ({ activityLogger: { logWarning: vi.fn(), logInfo: vi.fn(), logError: vi.fn() } }))
vi.mock('../GtcOrderManager', () => ({ gtcOrderManager: { trackOrder: (o: unknown) => trackOrder(o) } }))

import { TradingService } from '../TradingService'
import { riskManager } from '../RiskManager'

const market: Market = {
  id: '1', slug: 'mkt', question: 'Q', outcomes: ['Yes', 'No'], outcomeSlugs: ['mkt', 'mkt'],
  outcomePrices: [0.30, 0.70], active: true, closed: false, endDate: '', createdAt: '',
  volume: 0, liquidity: 0, orderMinSize: 1,
}

function service(makerFirst: boolean) {
  const s = new TradingService()
  s.setConfig({ dryRun: false, makerFirst, executionCooldown: 0, maxRetries: 1 })
  return s
}

describe('TradingService maker-first entries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // YES book: bid 0.27 / ask 0.34
    getPrice.mockReturnValue({ bid: 0.27, ask: 0.34, mid: 0.305, last: 0.3, spread: 0.07, timestamp: new Date() })
  })

  it('rests a post-only GTD buy one tick inside the spread and tracks it', async () => {
    placeOrder.mockResolvedValueOnce({ success: true, orderId: 'o1', pending: true })
    const r = await service(true).placeBet(market, 'yes', 5, { strategy: 'micro' })

    expect(r).toMatchObject({ success: true, orderId: 'o1', pending: true })
    const sent = placeOrder.mock.calls[0][0] as OrderRequest
    expect(sent).toMatchObject({ marketSlug: 'mkt', outcome: 'yes', side: 'BUY', type: 'GTD', postOnly: true, price: 0.28, size: 17 })
    expect(sent.expiration).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await vi.waitFor(() => expect(trackOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1', strategy: 'micro', outcome: 'yes' })))
  })

  it('prices a NO entry from the inverted YES book', async () => {
    placeOrder.mockResolvedValueOnce({ success: true, orderId: 'o2', pending: true })
    await service(true).placeBet(market, 'no', 5)
    // NO book: bid 1 − 0.34 = 0.66, ask 1 − 0.27 = 0.73 → 0.67
    expect(placeOrder.mock.calls[0][0]).toMatchObject({ outcome: 'no', price: 0.67, postOnly: true })
  })

  it('falls back to the taker order when the post-only order is rejected', async () => {
    placeOrder
      .mockResolvedValueOnce({ success: false, error: 'participate dont initiate: would cross' })
      .mockResolvedValueOnce({ success: true, orderId: 'o3', filledSize: 16, avgPrice: 0.31 })
    const r = await service(true).placeBet(market, 'yes', 5)
    expect(r).toMatchObject({ success: true, orderId: 'o3' })
    expect(placeOrder).toHaveBeenCalledTimes(2)
    expect(placeOrder.mock.calls[1][0]).toMatchObject({ type: 'FOK' })
    expect(placeOrder.mock.calls[1][0].postOnly).toBeUndefined()
    // The rejected post-only attempt does not count toward the circuit breaker
    expect(riskManager.recordTradeResult).not.toHaveBeenCalledWith(false, expect.anything(), expect.anything())
  })

  it('is off by default and skipped when a strategy pins the order type', async () => {
    placeOrder.mockResolvedValue({ success: true, orderId: 'o4', filledSize: 16, avgPrice: 0.31 })
    await service(false).placeBet(market, 'yes', 5)
    await service(true).placeBet(market, 'yes', 5, { orderType: 'FOK' })
    for (const [req] of placeOrder.mock.calls) expect((req as OrderRequest).postOnly).toBeUndefined()
  })
})
