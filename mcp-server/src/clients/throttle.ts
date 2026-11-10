/**
 * Client-side request throttle for the Polymarket US SDK.
 * (Same implementation as the app's src/services/api/requestThrottle.ts.)
 *
 * Polymarket US allows 25 requests/s per IP. Exceeding it draws HTTP 429 and,
 * on the public gateway, a Cloudflare 1015 ban lasting minutes that also
 * blocks the order-book reads trading depends on. Every SDK request goes
 * through `PolymarketUS#request`, so wrapping that one method throttles all
 * of them. Public (gateway) and authenticated (api) requests get separate
 * token buckets so market-data bursts never delay orders.
 */

export interface BucketConfig {
  /** Sustained requests per second */
  ratePerSec: number
  /** Requests allowed back-to-back before throttling kicks in */
  burst: number
  /** Pause after an HTTP 429 before sending anything else (ms). Doubles on
   *  each consecutive 429 (a Cloudflare ban outlasts short pauses), up to
   *  `maxCooldownMs`; resets after a successful request. */
  cooldownMs: number
  maxCooldownMs?: number
  /** Longest a request may wait in the queue before it is dropped instead of
   *  sent (ms). During a long 429 pause, queued reads go stale and queued
   *  orders were priced for a market that has moved — failing them fast is
   *  safer than firing them all when the pause ends. Cancels are never dropped. */
  maxQueueWaitMs?: number
}

/** Thrown instead of sending a request that waited longer than `maxQueueWaitMs` */
export class RequestDroppedError extends Error {
  readonly dropped = true
  constructor(waitedFor: string) {
    super(`Request dropped: rate-limit queue wait exceeded (${waitedFor})`)
    this.name = 'RequestDroppedError'
  }
}

/**
 * docs.polymarket.us/api-reference/rate-limits: 25 requests/s per source IP
 * (shared by every key on that IP); on 429 wait at least 1s, then back off
 * exponentially. Gateway + API together stay under 25/s. Bursts of ~30
 * requests in under two seconds drew Cloudflare 1015 bans in testing, so the
 * gateway (bulk market data) gets the smaller share. At 8/s the gateway still
 * returned occasional 429s during a 10-market scan (2026-11-10), so it runs at 5/s.
 */
export const GATEWAY_BUCKET: BucketConfig = { ratePerSec: 5, burst: 6, cooldownMs: 2_000, maxCooldownMs: 5 * 60_000, maxQueueWaitMs: 15_000 }
export const API_BUCKET: BucketConfig = { ratePerSec: 15, burst: 15, cooldownMs: 2_000, maxCooldownMs: 2 * 60_000, maxQueueWaitMs: 10_000 }

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> }

const realClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

export interface BucketMetrics {
  /** Requests sent in the last 10s, per second */
  perSecond10s: number
  /** Requests sent in the last 60s */
  last60s: number
  /** HTTP 429 responses since start */
  rateLimited: number
  /** Requests dropped after waiting too long in the queue, since start */
  dropped: number
  /** When requests are paused until (ms), 0 if not paused */
  pausedUntil: number
  /** Configured sustained rate */
  ratePerSec: number
}

/** Token bucket with a 429 cooldown. Calls to `acquire` resolve in FIFO order. */
export class TokenBucket {
  private tokens: number
  private last: number
  private blockedUntil = 0
  private strikes = 0
  private sent: number[] = []
  private rateLimitedCount = 0
  private droppedCount = 0
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly config: BucketConfig, private readonly clock: Clock = realClock) {
    this.tokens = config.burst
    this.last = clock.now()
  }

  /**
   * Wait until a request may be sent. Rejects with RequestDroppedError when
   * that would take longer than `maxWaitMs` (default: the bucket's
   * `maxQueueWaitMs`; pass Infinity to always wait).
   */
  acquire(maxWaitMs: number = this.config.maxQueueWaitMs ?? Infinity): Promise<void> {
    const deadline = this.clock.now() + maxWaitMs
    const turn = this.queue.then(() => this.take(deadline, maxWaitMs))
    this.queue = turn.catch(() => undefined)
    return turn
  }

  /** Record that a request was actually sent (for metrics) */
  noteSent(): void {
    const now = this.clock.now()
    this.sent.push(now)
    // keep only the last minute
    while (this.sent.length > 0 && this.sent[0] < now - 60_000) this.sent.shift()
  }

  /** Request rate and 429 counts for diagnostics */
  metrics(): BucketMetrics {
    const now = this.clock.now()
    const last60 = this.sent.filter(t => t >= now - 60_000).length
    const last10 = this.sent.filter(t => t >= now - 10_000).length
    return {
      perSecond10s: Math.round((last10 / 10) * 10) / 10,
      last60s: last60,
      rateLimited: this.rateLimitedCount,
      dropped: this.droppedCount,
      pausedUntil: this.blockedUntil > now ? this.blockedUntil : 0,
      ratePerSec: this.config.ratePerSec,
    }
  }

  /** Report a 429: hold every request until the (escalating) cooldown has passed */
  penalize(): void {
    const now = this.clock.now()
    this.rateLimitedCount++
    this.tokens = 0
    // Requests already in flight when the first 429 landed fail together:
    // count one strike per pause, not one per request
    if (now < this.blockedUntil) return
    const max = this.config.maxCooldownMs ?? this.config.cooldownMs
    const pause = Math.min(max, this.config.cooldownMs * 2 ** this.strikes)
    this.strikes++
    this.blockedUntil = now + pause
  }

  /** Report a successful request: the next 429 starts from the base cooldown */
  succeed(): void {
    this.strikes = 0
  }

  get pausedUntil(): number {
    return this.blockedUntil
  }

  private drop(maxWaitMs: number): never {
    this.droppedCount++
    throw new RequestDroppedError(`${Math.round(maxWaitMs / 1000)}s`)
  }

  private async take(deadline: number, maxWaitMs: number): Promise<void> {
    for (;;) {
      const now = this.clock.now()
      if (now < this.blockedUntil) {
        if (this.blockedUntil > deadline) this.drop(maxWaitMs)
        await this.clock.sleep(this.blockedUntil - now)
        continue
      }
      this.tokens = Math.min(this.config.burst, this.tokens + ((now - this.last) / 1000) * this.config.ratePerSec)
      this.last = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.config.ratePerSec) * 1000)
      if (now + waitMs > deadline) this.drop(maxWaitMs)
      await this.clock.sleep(waitMs)
    }
  }
}

/** Order cancels (single, all-open) — never dropped from the queue */
export function isCancelRequest(method: string, path: string): boolean {
  return method.toUpperCase() === 'DELETE' || /\/cancel$/.test(path)
}

type RequestFn = (method: string, path: string, options?: { authenticated?: boolean } & Record<string, unknown>) => Promise<unknown>

/**
 * Wrap an SDK instance's `request` so every call waits for its bucket and a
 * 429 pauses that bucket. A rate-limited GET is retried once after the pause.
 * Idempotent per instance.
 */
export function throttleSdk<T extends object>(
  sdk: T,
  buckets: { gateway: TokenBucket; api: TokenBucket } = sharedBuckets,
): T {
  const target = sdk as T & { request?: RequestFn; __throttled?: boolean }
  if (typeof target.request !== 'function' || target.__throttled) return sdk
  const original = target.request.bind(sdk) as RequestFn
  target.request = async (method, path, options = {}) => {
    const bucket = options.authenticated ? buckets.api : buckets.gateway
    const label = options.authenticated ? 'api' : 'gateway'
    // Cancels must go out however long the queue is: they reduce exposure
    const maxWait = isCancelRequest(method, path) ? Infinity : undefined
    // A rate-limited read is retried once after the pause. Reads are safe to
    // repeat; anything that changes state (orders, cancels) is never resent
    // here, because the first attempt may have been accepted.
    const attempts = method.toUpperCase() === 'GET' ? 2 : 1
    for (let attempt = 1; ; attempt++) {
      await bucket.acquire(maxWait)
      bucket.noteSent()
      try {
        const result = await original(method, path, options)
        bucket.succeed()
        return result
      } catch (err) {
        if ((err as { status?: number })?.status !== 429) throw err
        const wasPaused = Date.now() < bucket.pausedUntil
        bucket.penalize()
        if (!wasPaused) {
          console.warn(`[polymarket-us] HTTP 429 rate limit on ${label} — pausing requests for ${Math.round((bucket.pausedUntil - Date.now()) / 1000)}s`)
        }
        if (attempt >= attempts) throw err
      }
    }
  }
  target.__throttled = true
  return sdk
}

/** Process-wide buckets shared by every SDK instance (the limit is per IP) */
export const sharedBuckets = {
  gateway: new TokenBucket(GATEWAY_BUCKET),
  api: new TokenBucket(API_BUCKET),
}

/** Current request metrics for both buckets (shared process-wide) */
export function getRequestMetrics(): { gateway: BucketMetrics; api: BucketMetrics } {
  return { gateway: sharedBuckets.gateway.metrics(), api: sharedBuckets.api.metrics() }
}
