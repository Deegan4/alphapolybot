import { describe, it, expect } from 'vitest'
import { TokenBucket, throttleSdk } from '../requestThrottle'

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
    const fake: FakeSdk = { request: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }) } }
    const sdk = throttleSdk(fake, b)
    await expect(sdk.request('GET', '/v1/markets/x/bbo', {})).rejects.toThrow('rate limited')
    expect(b.gateway.pausedUntil).toBe(5000)
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
