import { describe, it, expect } from 'vitest'
import { TokenBucket, throttleSdk, isCancelRequest, RequestDroppedError } from '../requestThrottle'

type FakeSdk = { request: (method: string, path: string, options?: { authenticated?: boolean }) => Promise<unknown> }

/** Deterministic clock: sleep advances virtual time immediately */
function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps,
    advance: (ms: number) => { t += ms },
  }
}

describe('TokenBucket', () => {
  it('allows the burst immediately, then paces at the sustained rate', async () => {
    const clock = fakeClock()
    const bucket = new TokenBucket({ ratePerSec: 4, burst: 3, cooldownMs: 1000 }, clock)
    for (let i = 0; i < 3; i++) await bucket.acquire()
    expect(clock.now()).toBe(0)
    await bucket.acquire()
    expect(clock.now()).toBe(250) // 1 token / (4 per s)
    await bucket.acquire()
    expect(clock.now()).toBe(500)
  })

  it('refills over idle time up to the burst size', async () => {
    const clock = fakeClock()
    const bucket = new TokenBucket({ ratePerSec: 2, burst: 2, cooldownMs: 1000 }, clock)
    await bucket.acquire()
    await bucket.acquire()
    clock.advance(10_000)
    await bucket.acquire()
    await bucket.acquire()
    expect(clock.now()).toBe(10_000) // refilled to 2, not 20
    await bucket.acquire()
    expect(clock.now()).toBe(10_500)
  })

  it('holds every request for the cooldown after a 429', async () => {
    const clock = fakeClock()
    const bucket = new TokenBucket({ ratePerSec: 10, burst: 10, cooldownMs: 20_000 }, clock)
    bucket.penalize()
    expect(bucket.pausedUntil).toBe(20_000)
    await bucket.acquire()
    expect(clock.now()).toBeGreaterThanOrEqual(20_000)
  })
})

describe('throttleSdk', () => {
  const buckets = () => {
    const clock = fakeClock()
    return {
      clock,
      gateway: new TokenBucket({ ratePerSec: 1, burst: 1, cooldownMs: 5000 }, clock),
      api: new TokenBucket({ ratePerSec: 1, burst: 1, cooldownMs: 5000 }, clock),
    }
  }

  it('routes public and authenticated requests to separate buckets', async () => {
    const b = buckets()
    const calls: string[] = []
    const fake: FakeSdk = { request: async (_m, p) => { calls.push(p); return p } }
    const sdk = throttleSdk(fake, b)
    await sdk.request('GET', '/v1/markets', {})
    await sdk.request('POST', '/v1/orders', { authenticated: true })
    expect(b.clock.now()).toBe(0) // one token each — no waiting
    await sdk.request('GET', '/v1/events', {})
    expect(b.clock.now()).toBe(1000) // gateway bucket had to refill
    expect(calls).toEqual(['/v1/markets', '/v1/orders', '/v1/events'])
  })

  it('penalizes the bucket on HTTP 429 and rethrows', async () => {
    const b = buckets()
    let calls = 0
    const fake: FakeSdk = { request: async () => { calls++; throw Object.assign(new Error('rate limited'), { status: 429 }) } }
    const sdk = throttleSdk(fake, b)
    await expect(sdk.request('GET', '/v1/markets/x/bbo', {})).rejects.toThrow('rate limited')
    expect(calls).toBe(2) // a read is retried once after the pause, then gives up
    expect(b.gateway.pausedUntil).toBeGreaterThanOrEqual(5000)
    expect(b.api.pausedUntil).toBe(0)
  })

  it('is idempotent', () => {
    const b = buckets()
    const sdk: FakeSdk = { request: async () => 1 }
    const once = throttleSdk(sdk, b).request
    expect(throttleSdk(sdk, b).request).toBe(once)
  })
})

describe('TokenBucket 429 escalation', () => {
  it('doubles the pause on consecutive 429s, caps it, and resets on success', () => {
    const clock = fakeClock()
    const bucket = new TokenBucket({ ratePerSec: 1, burst: 1, cooldownMs: 1000, maxCooldownMs: 3000 }, clock)
    bucket.penalize()
    expect(bucket.pausedUntil).toBe(1000)
    bucket.penalize() // same wave (still paused) — no extra strike
    expect(bucket.pausedUntil).toBe(1000)
    clock.advance(1000)
    bucket.penalize()
    expect(bucket.pausedUntil).toBe(1000 + 2000)
    clock.advance(2000)
    bucket.penalize()
    expect(bucket.pausedUntil).toBe(3000 + 3000) // capped at maxCooldownMs
    bucket.succeed()
    clock.advance(3000)
    bucket.penalize()
    expect(bucket.pausedUntil).toBe(6000 + 1000)
  })
})

describe('TokenBucket metrics', () => {
  it('counts sent requests over 10s / 60s windows and 429s', async () => {
    const clock = fakeClock()
    const bucket = new TokenBucket({ ratePerSec: 100, burst: 100, cooldownMs: 1000 }, clock)
    for (let i = 0; i < 20; i++) bucket.noteSent()
    clock.advance(30_000)
    for (let i = 0; i < 5; i++) bucket.noteSent()
    let m = bucket.metrics()
    expect(m.last60s).toBe(25)
    expect(m.perSecond10s).toBe(0.5)
    expect(m.ratePerSec).toBe(100)
    expect(m.pausedUntil).toBe(0)

    bucket.penalize()
    m = bucket.metrics()
    expect(m.rateLimited).toBe(1)
    expect(m.pausedUntil).toBe(31_000)

    clock.advance(61_000)
    expect(bucket.metrics().last60s).toBe(0)
  })

  it('throttleSdk records each sent request', async () => {
    const clock = fakeClock()
    const b = { gateway: new TokenBucket({ ratePerSec: 10, burst: 10, cooldownMs: 1000 }, clock), api: new TokenBucket({ ratePerSec: 10, burst: 10, cooldownMs: 1000 }, clock) }
    const fake: FakeSdk = { request: async () => 1 }
    const sdk = throttleSdk(fake, b)
    await sdk.request('GET', '/a', {})
    await sdk.request('GET', '/b', { authenticated: true })
    expect(b.gateway.metrics().last60s).toBe(1)
    expect(b.api.metrics().last60s).toBe(1)
  })
})

describe('dropping stale queued requests', () => {
  it('drops a request that would wait past maxQueueWaitMs during a pause', async () => {
    const clock = fakeClock()
    const bucket = new TokenBucket({ ratePerSec: 10, burst: 10, cooldownMs: 30_000, maxQueueWaitMs: 5_000 }, clock)
    bucket.penalize()
    await expect(bucket.acquire()).rejects.toBeInstanceOf(RequestDroppedError)
    expect(clock.now()).toBe(0) // failed fast, did not sleep through the pause
    expect(bucket.metrics().dropped).toBe(1)
    // an explicit Infinity still waits it out
    await bucket.acquire(Infinity)
    expect(clock.now()).toBe(30_000)
  })

  it('waits normally when the pause ends inside the deadline', async () => {
    const clock = fakeClock()
    const bucket = new TokenBucket({ ratePerSec: 10, burst: 10, cooldownMs: 2_000, maxQueueWaitMs: 5_000 }, clock)
    bucket.penalize()
    await bucket.acquire()
    expect(clock.now()).toBe(2_000)
    expect(bucket.metrics().dropped).toBe(0)
  })

  it('drops when pacing alone would exceed the deadline, and later requests still flow', async () => {
    const clock = fakeClock()
    const bucket = new TokenBucket({ ratePerSec: 1, burst: 1, cooldownMs: 1000, maxQueueWaitMs: 500 }, clock)
    await bucket.acquire()
    await expect(bucket.acquire()).rejects.toBeInstanceOf(RequestDroppedError)
    clock.advance(1000)
    await bucket.acquire()
  })

  it('never drops cancels', async () => {
    expect(isCancelRequest('POST', '/v1/order/abc/cancel')).toBe(true)
    expect(isCancelRequest('POST', '/v1/orders/open/cancel')).toBe(true)
    expect(isCancelRequest('DELETE', '/v1/anything')).toBe(true)
    expect(isCancelRequest('POST', '/v1/orders')).toBe(false)
    expect(isCancelRequest('GET', '/v1/markets/cancel-culture/bbo')).toBe(false)

    const clock = fakeClock()
    const b = {
      gateway: new TokenBucket({ ratePerSec: 10, burst: 10, cooldownMs: 1000 }, clock),
      api: new TokenBucket({ ratePerSec: 10, burst: 10, cooldownMs: 20_000, maxQueueWaitMs: 1_000 }, clock),
    }
    const fake: FakeSdk = { request: async (_m, p) => p }
    const sdk = throttleSdk(fake, b)
    b.api.penalize()
    await expect(sdk.request('POST', '/v1/orders', { authenticated: true })).rejects.toBeInstanceOf(RequestDroppedError)
    await expect(sdk.request('POST', '/v1/order/x/cancel', { authenticated: true })).resolves.toBe('/v1/order/x/cancel')
    expect(clock.now()).toBe(20_000)
  })
})

describe('429 retry', () => {
  const setup = () => {
    const clock = fakeClock()
    return {
      clock,
      gateway: new TokenBucket({ ratePerSec: 10, burst: 10, cooldownMs: 2000 }, clock),
      api: new TokenBucket({ ratePerSec: 10, burst: 10, cooldownMs: 2000 }, clock),
    }
  }

  it('retries a rate-limited read once, after the pause', async () => {
    const b = setup()
    let calls = 0
    const fake: FakeSdk = {
      request: async () => {
        if (++calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 })
        return 'book'
      },
    }
    await expect(throttleSdk(fake, b).request('GET', '/v1/markets/x/book', {})).resolves.toBe('book')
    expect(calls).toBe(2)
    expect(b.clock.now()).toBeGreaterThanOrEqual(2000)
    expect(b.gateway.metrics().rateLimited).toBe(1)
  })

  it('never resends an order or a cancel', async () => {
    const b = setup()
    let calls = 0
    const fake: FakeSdk = { request: async () => { calls++; throw Object.assign(new Error('rate limited'), { status: 429 }) } }
    const sdk = throttleSdk(fake, b)
    await expect(sdk.request('POST', '/v1/orders', { authenticated: true })).rejects.toThrow('rate limited')
    await expect(sdk.request('POST', '/v1/order/x/cancel', { authenticated: true })).rejects.toThrow('rate limited')
    expect(calls).toBe(2) // one attempt each
  })

  it('does not retry other errors', async () => {
    const b = setup()
    let calls = 0
    const fake: FakeSdk = { request: async () => { calls++; throw Object.assign(new Error('not found'), { status: 404 }) } }
    await expect(throttleSdk(fake, b).request('GET', '/v1/market/slug/x', {})).rejects.toThrow('not found')
    expect(calls).toBe(1)
  })
})
