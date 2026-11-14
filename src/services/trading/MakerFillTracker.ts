/**
 * Maker-first fill-rate tracker, overall and per strategy.
 *
 * Maker-first entries trade fee savings (no taker fee at tier 1) against
 * missed trades (the resting order may expire unfilled). This records each
 * maker attempt's outcome so the trade-off can be judged from real data:
 * fill rate, time to fill, and taker fees avoided on the fills. Short-window
 * strategies (BTC 5m/15m) and long-dated ones (LLM) behave very differently,
 * so every event is counted both in the total and in its strategy's bucket.
 *
 * Pure counting logic; persistence is best-effort localStorage (per browser).
 */

import { PMUS_DEFAULT_TAKER_THETA, takerFee } from './pmusFees'

export type MakerOutcome = 'filled' | 'expired' | 'cancelled' | 'rejected'

export interface MakerFillStats {
  /** Post-only orders that rested on the book */
  placed: number
  filled: number
  expired: number
  cancelled: number
  /** Post-only attempts the exchange refused (fell back to taker immediately) */
  rejected: number
  /** Expired maker entries completed as taker orders (filled / attempted) */
  takerFallbackFilled: number
  takerFallbackAttempted: number
  /** filled / (filled + expired + cancelled); null until an order resolves */
  fillRate: number | null
  /** Mean placement-to-fill time for filled orders (ms); null if none */
  avgTimeToFillMs: number | null
  /** Taker fees the filled orders would have paid (USD) */
  feesSavedUSD: number
  /** Notional of the filled orders (USD) */
  filledNotionalUSD: number
  since: number
}

interface Bucket {
  placed: number
  filled: number
  expired: number
  cancelled: number
  rejected: number
  takerFallbackFilled: number
  takerFallbackAttempted: number
  totalFillMs: number
  feesSavedUSD: number
  filledNotionalUSD: number
  since: number
}

interface State {
  total: Bucket
  byStrategy: Record<string, Bucket>
}

const STORAGE_KEY = 'alphapolybot:maker-fill-stats:v2'
const LEGACY_KEY = 'alphapolybot:maker-fill-stats:v1'
const UNKNOWN = 'other'

const emptyBucket = (now: number): Bucket => ({
  placed: 0, filled: 0, expired: 0, cancelled: 0, rejected: 0,
  takerFallbackFilled: 0, takerFallbackAttempted: 0,
  totalFillMs: 0, feesSavedUSD: 0, filledNotionalUSD: 0, since: now,
})

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function toStats(b: Bucket): MakerFillStats {
  const resolved = b.filled + b.expired + b.cancelled
  return {
    placed: b.placed,
    filled: b.filled,
    expired: b.expired,
    cancelled: b.cancelled,
    rejected: b.rejected,
    takerFallbackFilled: b.takerFallbackFilled,
    takerFallbackAttempted: b.takerFallbackAttempted,
    fillRate: resolved > 0 ? b.filled / resolved : null,
    avgTimeToFillMs: b.filled > 0 ? b.totalFillMs / b.filled : null,
    feesSavedUSD: Math.round(b.feesSavedUSD * 100) / 100,
    filledNotionalUSD: Math.round(b.filledNotionalUSD * 100) / 100,
    since: b.since,
  }
}

function parseBucket(raw: unknown, now: number): Bucket {
  const base = emptyBucket(now)
  if (!raw || typeof raw !== 'object') return base
  for (const k of Object.keys(base) as (keyof Bucket)[]) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === 'number' && Number.isFinite(v)) base[k] = v
  }
  return base
}

export class MakerFillTracker {
  private state: State
  private listeners = new Set<(s: MakerFillStats) => void>()

  constructor(
    private readonly storage: StorageLike | null = defaultStorage(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.state = this.load() ?? { total: emptyBucket(this.now()), byStrategy: {} }
  }

  /** A post-only order is resting on the book */
  recordPlaced(strategy?: string): void {
    this.apply(strategy, b => { b.placed++ })
  }

  /** The exchange refused the post-only order (the bot fell back to taker) */
  recordRejected(strategy?: string): void {
    this.apply(strategy, b => { b.rejected++ })
  }

  /** An expired maker entry was retried as a taker order */
  recordTakerFallback(success: boolean, strategy?: string): void {
    this.apply(strategy, b => {
      b.takerFallbackAttempted++
      if (success) b.takerFallbackFilled++
    })
  }

  /** A resting maker order reached a terminal state */
  recordResolved(
    outcome: Exclude<MakerOutcome, 'rejected'>,
    order: { placedAt: number; price: number; size: number; feeCoefficient?: number; strategy?: string },
  ): void {
    const fee = outcome === 'filled' ? takerFee(order.size, order.price, order.feeCoefficient ?? PMUS_DEFAULT_TAKER_THETA) : 0
    const fillMs = Math.max(0, this.now() - order.placedAt)
    this.apply(order.strategy, b => {
      if (outcome === 'filled') {
        b.filled++
        b.totalFillMs += fillMs
        b.feesSavedUSD += fee
        b.filledNotionalUSD += order.size * order.price
      } else if (outcome === 'expired') {
        b.expired++
      } else {
        b.cancelled++
      }
    })
  }

  /** Overall stats, or one strategy's (all zeros if it has none yet) */
  getStats(strategy?: string): MakerFillStats {
    if (strategy === undefined) return toStats(this.state.total)
    return toStats(this.state.byStrategy[strategy] ?? emptyBucket(this.state.total.since))
  }

  /** Per-strategy stats for every strategy with activity, most placements first */
  getStrategyStats(): Array<{ strategy: string; stats: MakerFillStats }> {
    return Object.entries(this.state.byStrategy)
      .map(([strategy, b]) => ({ strategy, stats: toStats(b) }))
      .filter(r => r.stats.placed + r.stats.rejected > 0)
      .sort((a, b) => (b.stats.placed + b.stats.rejected) - (a.stats.placed + a.stats.rejected))
  }

  reset(): void {
    this.state = { total: emptyBucket(this.now()), byStrategy: {} }
    this.commit()
  }

  onChange(cb: (s: MakerFillStats) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private apply(strategy: string | undefined, fn: (b: Bucket) => void): void {
    const key = strategy || UNKNOWN
    const bucket = this.state.byStrategy[key] ?? (this.state.byStrategy[key] = emptyBucket(this.now()))
    fn(this.state.total)
    fn(bucket)
    this.commit()
  }

  private commit(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      // storage full / blocked — stats stay in memory
    }
    const stats = this.getStats()
    for (const cb of this.listeners) cb(stats)
  }

  private load(): State | null {
    const now = this.now()
    try {
      const raw = this.storage?.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { total?: unknown; byStrategy?: Record<string, unknown> }
        const byStrategy: Record<string, Bucket> = {}
        for (const [k, v] of Object.entries(parsed.byStrategy ?? {})) byStrategy[k] = parseBucket(v, now)
        return { total: parseBucket(parsed.total, now), byStrategy }
      }
      // v1 stored only a total — keep it, with no per-strategy split
      const legacy = this.storage?.getItem(LEGACY_KEY)
      if (legacy) return { total: parseBucket(JSON.parse(legacy), now), byStrategy: {} }
    } catch {
      // corrupt — start fresh
    }
    return null
  }
}

export const makerFillTracker = new MakerFillTracker()
