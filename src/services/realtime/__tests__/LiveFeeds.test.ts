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

describe('RealtimeService give-up state and status', () => {
  it('reports offline after max attempts, with fresh-book counts while connected', () => {
    const svc = new RealtimeService()
    const internals = svc as unknown as Internals & { reconnectAttempts: number; maxReconnectAttempts: number; attemptReconnect: () => void }
    expect(svc.getStatus().state).toBe('idle')

    internals.ws = { isConnected: true, subscribeMarketData: vi.fn(), subscribeMarketDataLite: vi.fn() }
    svc.watchBooks(['a', 'b'])
    internals.handleMarketData(md('a'))
    expect(svc.getStatus()).toMatchObject({ state: 'connected', booksWatched: 2, booksFresh: 1 })

    internals.ws.isConnected = false
    internals.reconnectAttempts = internals.maxReconnectAttempts
    internals.attemptReconnect()
    expect(svc.hasGivenUp()).toBe(true)
    expect(svc.getStatus()).toMatchObject({ state: 'offline', booksFresh: 0 })
  })
})

describe('UserChannelService status', () => {
  it('is idle before connecting and offline after giving up', () => {
    const svc = new UserChannelService()
    expect(svc.getStatus()).toEqual({ state: 'idle', lastMessageAt: 0, hasBalance: false, stallReconnects: 0 })
    const internals = svc as unknown as { reconnectAttempts: number; maxReconnectAttempts: number; attemptReconnect: () => void }
    internals.reconnectAttempts = internals.maxReconnectAttempts
    internals.attemptReconnect()
    expect(svc.getStatus().state).toBe('offline')
  })
})

import { isFeedStalled, HeartbeatClock, MIN_STALL_MS } from '../feedWatchdog'
import { MicrostructureAnalyzer, takerDirection } from '@/services/trading/MicrostructureAnalyzer'
import { tradeFlowOpposes } from '@/services/strategies/MicrostructureMomentumStrategy'

describe('feed stall watchdog', () => {
  it('never fires before a heartbeat interval is known', () => {
    expect(isFeedStalled({ nowMs: 10 * 60_000, lastActivityMs: 1, heartbeatIntervalMs: null })).toBe(false)
  })

  it('fires after 3 heartbeat intervals of silence, with a 60s floor', () => {
    expect(isFeedStalled({ nowMs: MIN_STALL_MS, lastActivityMs: 1, heartbeatIntervalMs: 5_000 })).toBe(false)
    expect(isFeedStalled({ nowMs: MIN_STALL_MS + 2, lastActivityMs: 1, heartbeatIntervalMs: 5_000 })).toBe(true)
    expect(isFeedStalled({ nowMs: 80_000, lastActivityMs: 1, heartbeatIntervalMs: 30_000 })).toBe(false)
    expect(isFeedStalled({ nowMs: 90_002, lastActivityMs: 1, heartbeatIntervalMs: 30_000 })).toBe(true)
  })

  it('learns the heartbeat interval from the smallest gap', () => {
    const clock = new HeartbeatClock()
    expect(clock.intervalMs).toBeNull()
    clock.beat(1000)
    expect(clock.intervalMs).toBeNull()
    clock.beat(31_000)
    clock.beat(46_000)
    clock.beat(120_000)
    expect(clock.intervalMs).toBe(15_000)
    clock.reset()
    expect(clock.intervalMs).toBeNull()
  })

  it('RealtimeService reopens a silent connection', () => {
    vi.useFakeTimers()
    try {
      const svc = new RealtimeService()
      const close = vi.fn()
      const internals = svc as unknown as {
        ws: { isConnected: boolean; close: () => void }
        lastMessageTime: number
        heartbeats: HeartbeatClock
        startWatchdog: () => void
        stopWatchdog: () => void
      }
      internals.ws = { isConnected: true, close }
      internals.heartbeats.beat(Date.now())
      vi.advanceTimersByTime(5_000)
      internals.heartbeats.beat(Date.now())
      internals.lastMessageTime = Date.now()
      internals.startWatchdog()
      vi.advanceTimersByTime(50_000)
      expect(close).not.toHaveBeenCalled()
      vi.advanceTimersByTime(20_000)
      expect(close).toHaveBeenCalledTimes(1)
      expect(svc.getStatus().stallReconnects).toBe(1)
      internals.stopWatchdog()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MicrostructureAnalyzer real depth and trade flow', () => {
  it('measures imbalance from resting size, in both directions', () => {
    const a = new MicrostructureAnalyzer()
    for (let i = 0; i < 5; i++) a.recordDepth('bull', 0.50, 0.52, 900, 100)
    for (let i = 0; i < 5; i++) a.recordDepth('bear', 0.50, 0.52, 100, 900)
    expect(a.getSignal('bull')!.imbalance).toBeCloseTo(0.8, 3)
    expect(a.getSignal('bull')!.compositeSignal).toBeCloseTo(0.34, 3) // 0.8×0.4 + 0.02 (spread steady)
    expect(a.getSignal('bear')!.imbalance).toBeCloseTo(-0.8, 3)
    expect(a.getSignal('bear')!.compositeSignal).toBeCloseTo(-0.3, 3)
  })

  it('ignores snapshots without any size', () => {
    const a = new MicrostructureAnalyzer()
    for (let i = 0; i < 5; i++) a.recordDepth('x', 0.5, 0.52, 0, 0)
    expect(a.getSignal('x')).toBeNull()
  })

  it('maps the taker to a direction on the YES book', () => {
    expect(takerDirection({ intent: 'ORDER_INTENT_BUY_LONG' })).toBe(1)
    expect(takerDirection({ intent: 'ORDER_INTENT_SELL_SHORT' })).toBe(1)
    expect(takerDirection({ intent: 'ORDER_INTENT_SELL_LONG' })).toBe(-1)
    expect(takerDirection({ intent: 'ORDER_INTENT_BUY_SHORT', side: 'ORDER_SIDE_BUY' })).toBe(-1)
    expect(takerDirection({ side: 'ORDER_SIDE_SELL' })).toBe(-1)
    expect(takerDirection(undefined)).toBe(0)
  })

  it('reports net trade flow only with enough trades, and forgets old ones', () => {
    vi.useFakeTimers()
    try {
      const a = new MicrostructureAnalyzer()
      a.recordTrade('m', 1, 10)
      a.recordTrade('m', 1, 10)
      expect(a.getTradeFlow('m')).toBeNull()
      a.recordTrade('m', -1, 20)
      a.recordTrade('m', 1, 40)
      expect(a.getTradeFlow('m')).toBe(0.5) // (60 − 20) / 80
      vi.advanceTimersByTime(61_000)
      expect(a.getTradeFlow('m')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('vetoes an entry only when trades run against the book signal', () => {
    expect(tradeFlowOpposes(0.5, null)).toBe(false)
    expect(tradeFlowOpposes(0.5, 0.1)).toBe(false)
    expect(tradeFlowOpposes(0.5, -0.3)).toBe(true)
    expect(tradeFlowOpposes(-0.5, 0.4)).toBe(true)
    expect(tradeFlowOpposes(-0.5, -0.9)).toBe(false)
  })
})
