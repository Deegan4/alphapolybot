import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Market, OrderRequest } from '@/types/api'

const placeOrder = vi.fn()
const getPrice = vi.fn()
const trackOrder = vi.fn()
const getOrder = vi.fn()
const trackPosition = vi.fn()

vi.mock('@/services/api', async () => {
  const wire = await vi.importActual<typeof import('@/services/api/pmusWire')>('@/services/api/pmusWire')
  return {
    polymarketUSClient: {
      placeOrder: (r: OrderRequest) => placeOrder(r),
      getBalances: vi.fn().mockResolvedValue({ balance: 1000, buyingPower: 1000 }),
      getBestPrices: vi.fn().mockResolvedValue(null),
      getOrder: (id: string) => getOrder(id),
    },
    priceForOutcome: wire.priceForOutcome,
    reportedPriceForOutcome: wire.reportedPriceForOutcome,
    roundOrderQuantity: wire.roundOrderQuantity,
    isTransientLatencyReject: wire.isTransientLatencyReject,
    makerEntryPrice: wire.makerEntryPrice,
    takerAfterExpiryPlan: wire.takerAfterExpiryPlan,
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
vi.mock('../PositionLifecycleManager', () => ({ positionLifecycleManager: { trackPosition: (p: unknown) => trackPosition(p) } }))
vi.mock('../MakerFillTracker', () => ({ makerFillTracker: { recordTakerFallback: vi.fn(), recordRejected: vi.fn() } }))
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

describe('TradingService per-strategy maker-first', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPrice.mockReturnValue({ bid: 0.27, ask: 0.34, mid: 0.305, last: 0.3, spread: 0.07, timestamp: new Date() })
  })

  it('skips maker-first for disabled strategies only', async () => {
    placeOrder.mockResolvedValue({ success: true, orderId: 'x', filledSize: 16, avgPrice: 0.31 })
    const s = service(true)
    s.setConfig({ makerFirstDisabledStrategies: ['btc'] })
    expect(s.makerFirstAppliesTo('btc')).toBe(false)
    expect(s.makerFirstAppliesTo('micro')).toBe(true)
    expect(s.makerFirstAppliesTo(undefined)).toBe(true) // defaults to 'llm'

    await s.placeBet(market, 'yes', 5, { strategy: 'btc' })
    expect((placeOrder.mock.calls[0][0] as OrderRequest).postOnly).toBeUndefined()

    placeOrder.mockClear()
    placeOrder.mockResolvedValueOnce({ success: true, orderId: 'y', pending: true })
    await s.placeBet(market, 'yes', 5, { strategy: 'micro' })
    expect((placeOrder.mock.calls[0][0] as OrderRequest).postOnly).toBe(true)
  })

  it('is fully off when the master switch is off', () => {
    const s = service(false)
    expect(s.makerFirstAppliesTo('micro')).toBe(false)
  })
})

describe('TradingService.completeExpiredMakerEntry', () => {
  const expired = {
    orderId: 'mk1', marketSlug: 'mkt', outcome: 'yes' as const, question: 'Q', side: 'BUY' as const,
    price: 0.28, size: 17, costBasis: 4.76, strategy: 'micro' as const, stopLossPercent: 0.2,
    takeProfitPercent: 0.3, placedAt: 0, expiresAt: 0, status: 'expired' as const,
    entryKind: 'maker' as const, orderMinSize: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    getOrder.mockResolvedValue({ filledSize: 5 })
  })

  it('keeps the partial fill and takes the remainder when the ask is close', async () => {
    getPrice.mockReturnValue({ bid: 0.27, ask: 0.29, mid: 0.28, last: 0.28, spread: 0.02, timestamp: new Date() })
    placeOrder.mockResolvedValueOnce({ success: true, orderId: 't1', filledSize: 12, avgPrice: 0.29 })
    const r = await service(true).completeExpiredMakerEntry(expired)

    expect(trackPosition).toHaveBeenNthCalledWith(1, expect.objectContaining({ size: 5, entryPrice: 0.28 }))
    expect(placeOrder.mock.calls[0][0]).toMatchObject({ type: 'FOK', side: 'BUY', size: 12, outcome: 'yes' })
    expect(r).toMatchObject({ success: true, filledSize: 12 })
    expect(trackPosition).toHaveBeenNthCalledWith(2, expect.objectContaining({ size: 12, entryPrice: 0.29 }))
  })

  it('does not chase a price that ran away', async () => {
    getPrice.mockReturnValue({ bid: 0.30, ask: 0.35, mid: 0.325, last: 0.33, spread: 0.05, timestamp: new Date() })
    const r = await service(true).completeExpiredMakerEntry(expired)
    expect(r).toBeNull()
    expect(placeOrder).not.toHaveBeenCalled()
    expect(trackPosition).toHaveBeenCalledTimes(1) // partial fill still tracked
  })

  it('respects the fallback toggle', async () => {
    getPrice.mockReturnValue({ bid: 0.27, ask: 0.29, mid: 0.28, last: 0.28, spread: 0.02, timestamp: new Date() })
    const s = service(true)
    s.setConfig({ makerExpiryTakerFallback: false })
    expect(await s.completeExpiredMakerEntry(expired)).toBeNull()
    expect(placeOrder).not.toHaveBeenCalled()
  })
})
