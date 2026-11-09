import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('polymarket-us', () => ({ MarketsWebSocket: class {}, PrivateWebSocket: class {} }))

import { RealtimeService, LIVE_BOOK_MAX_AGE_MS } from '../RealtimeService'
import { UserChannelService } from '../UserChannelService'
import { shouldPollOrdersRest, ORDER_POLL_FALLBACK_MS } from '@/services/trading/GtcOrderManager'

type Internals = {
  ws: { isConnected: boolean; subscribeMarketData: ReturnType<typeof vi.fn>; subscribeMarketDataLite: ReturnType<typeof vi.fn> } | null
  handleMarketData: (d: unknown) => void
}

const md = (slug: string) => ({
  requestId: 'r',
  subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA',
  marketData: {
    marketSlug: slug,
    bids: [{ px: { value: '0.55', currency: 'USD' }, qty: '10' }],
    offers: [{ px: { value: '0.57', currency: 'USD' }, qty: '4' }],
    state: 'MARKET_STATE_OPEN',
  },
})

describe('RealtimeService pushed order books', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the latest book for watched markets and expires it', () => {
    const svc = new RealtimeService()
    const internals = svc as unknown as Internals
    internals.ws = { isConnected: true, subscribeMarketData: vi.fn(), subscribeMarketDataLite: vi.fn() }

    svc.watchBooks(['a', 'a'])
    expect(internals.ws.subscribeMarketData).toHaveBeenCalledTimes(1)
    expect(internals.ws.subscribeMarketData.mock.calls[0][1]).toEqual(['a'])

    internals.handleMarketData(md('a'))
    internals.handleMarketData(md('unwatched'))
    expect(svc.getBook('a')).toMatchObject({ bids: [{ price: 0.55, size: 10 }], asks: [{ price: 0.57, size: 4 }] })
    expect(svc.getBook('unwatched')).toBeNull()

    vi.advanceTimersByTime(LIVE_BOOK_MAX_AGE_MS + 1)
    expect(svc.getBook('a')).toBeNull() // stale → caller uses REST

    internals.handleMarketData(md('a'))
    svc.unwatchBooks(['a'])
    expect(svc.getBook('a')).toBeNull()
  })

  it('returns no book while disconnected', () => {
    const svc = new RealtimeService()
    const internals = svc as unknown as Internals
    internals.ws = { isConnected: true, subscribeMarketData: vi.fn(), subscribeMarketDataLite: vi.fn() }
    svc.watchBooks(['a'])
    internals.handleMarketData(md('a'))
    internals.ws.isConnected = false
    expect(svc.getBook('a')).toBeNull()
  })
})

describe('shouldPollOrdersRest', () => {
  it('polls every tick without the feed, every fallback interval with it', () => {
    expect(shouldPollOrdersRest(false, 0, 1)).toBe(true)
    expect(shouldPollOrdersRest(true, 0, 60_000)).toBe(false)
    expect(shouldPollOrdersRest(true, 0, ORDER_POLL_FALLBACK_MS)).toBe(true)
  })
})

describe('UserChannelService give-up state', () => {
  it('reports giving up after max attempts and resets on retry', async () => {
    const svc = new UserChannelService()
    const internals = svc as unknown as { reconnectAttempts: number; maxReconnectAttempts: number; attemptReconnect: () => void }
    expect(svc.hasGivenUp()).toBe(false)
    internals.reconnectAttempts = internals.maxReconnectAttempts
    internals.attemptReconnect()
    expect(svc.hasGivenUp()).toBe(true)
    await svc.retry() // no credentials in tests → connect() returns false
    expect(svc.hasGivenUp()).toBe(false)
  })
})
