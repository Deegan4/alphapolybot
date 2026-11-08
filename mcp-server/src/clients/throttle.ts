/**
 * Client-side request throttle for the Polymarket US SDK.
 * (Same implementation as the app's src/services/api/requestThrottle.ts.)
 *
 * The public gateway sits behind a Cloudflare rate limit: ~30 requests in
 * under two seconds draws HTTP 429 (error 1015) and a temporary IP ban that
 * also blocks the order-book reads trading depends on. Every SDK request goes
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
}

export const GATEWAY_BUCKET: BucketConfig = { ratePerSec: 3, burst: 6, cooldownMs: 20_000, maxCooldownMs: 5 * 60_000 }
export const API_BUCKET: BucketConfig = { ratePerSec: 8, burst: 16, cooldownMs: 10_000, maxCooldownMs: 2 * 60_000 }

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> }

const realClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/** Token bucket with a 429 cooldown. Calls to `acquire` resolve in FIFO order. */
export class TokenBucket {
  private tokens: number
  private last: number
  private blockedUntil = 0
  private strikes = 0
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly config: BucketConfig, private readonly clock: Clock = realClock) {
    this.tokens = config.burst
    this.last = clock.now()
  }

  /** Wait until a request may be sent */
  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.take())
    this.queue = turn.catch(() => undefined)
    return turn
  }

  /** Report a 429: hold every request until the (escalating) cooldown has passed */
  penalize(): void {
    const now = this.clock.now()
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

  private async take(): Promise<void> {
    for (;;) {
      const now = this.clock.now()
      if (now < this.blockedUntil) {
        await this.clock.sleep(this.blockedUntil - now)
        continue
      }
      this.tokens = Math.min(this.config.burst, this.tokens + ((now - this.last) / 1000) * this.config.ratePerSec)
      this.last = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      await this.clock.sleep(Math.ceil(((1 - this.tokens) / this.config.ratePerSec) * 1000))
    }
  }
}

type RequestFn = (method: string, path: string, options?: { authenticated?: boolean } & Record<string, unknown>) => Promise<unknown>

/**
 * Wrap an SDK instance's `request` so every call waits for its bucket and a
 * 429 pauses that bucket. Idempotent per instance.
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
    await bucket.acquire()
    try {
      const result = await original(method, path, options)
      bucket.succeed()
      return result
    } catch (err) {
      if ((err as { status?: number })?.status === 429) bucket.penalize()
      throw err
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
