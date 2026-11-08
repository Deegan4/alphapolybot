/**
 * Maker-first fill-rate tracker.
 *
 * Maker-first entries trade fee savings (no taker fee at tier 1) against
 * missed trades (the resting order may expire unfilled). This records each
 * maker attempt's outcome so the trade-off can be judged from real data:
 * fill rate, time to fill, and taker fees avoided on the fills.
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

interface State {
  placed: number
  filled: number
  expired: number
  cancelled: number
  rejected: number
  totalFillMs: number
  feesSavedUSD: number
  filledNotionalUSD: number
  since: number
}

const STORAGE_KEY = 'alphapolybot:maker-fill-stats:v1'

const empty = (now: number): State => ({
  placed: 0, filled: 0, expired: 0, cancelled: 0, rejected: 0,
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

export class MakerFillTracker {
  private state: State
  private listeners = new Set<(s: MakerFillStats) => void>()

  constructor(
    private readonly storage: StorageLike | null = defaultStorage(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.state = this.load() ?? empty(this.now())
  }

  /** A post-only order is resting on the book */
  recordPlaced(): void {
    this.state.placed++
    this.commit()
  }

  /** The exchange refused the post-only order (the bot fell back to taker) */
  recordRejected(): void {
    this.state.rejected++
    this.commit()
  }

  /** A resting maker order reached a terminal state */
  recordResolved(
    outcome: Exclude<MakerOutcome, 'rejected'>,
    order: { placedAt: number; price: number; size: number; feeCoefficient?: number },
  ): void {
    if (outcome === 'filled') {
      this.state.filled++
      this.state.totalFillMs += Math.max(0, this.now() - order.placedAt)
      this.state.feesSavedUSD += takerFee(order.size, order.price, order.feeCoefficient ?? PMUS_DEFAULT_TAKER_THETA)
      this.state.filledNotionalUSD += order.size * order.price
    } else if (outcome === 'expired') {
      this.state.expired++
    } else {
      this.state.cancelled++
    }
    this.commit()
  }

  getStats(): MakerFillStats {
    const s = this.state
    const resolved = s.filled + s.expired + s.cancelled
    return {
      placed: s.placed,
      filled: s.filled,
      expired: s.expired,
      cancelled: s.cancelled,
      rejected: s.rejected,
      fillRate: resolved > 0 ? s.filled / resolved : null,
      avgTimeToFillMs: s.filled > 0 ? s.totalFillMs / s.filled : null,
      feesSavedUSD: Math.round(s.feesSavedUSD * 100) / 100,
      filledNotionalUSD: Math.round(s.filledNotionalUSD * 100) / 100,
      since: s.since,
    }
  }

  reset(): void {
    this.state = empty(this.now())
    this.commit()
  }

  onChange(cb: (s: MakerFillStats) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
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
    try {
      const raw = this.storage?.getItem(STORAGE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<State>
      const base = empty(this.now())
      for (const k of Object.keys(base) as (keyof State)[]) {
        const v = parsed[k]
        if (typeof v === 'number' && Number.isFinite(v)) base[k] = v
      }
      return base
    } catch {
      return null
    }
  }
}

export const makerFillTracker = new MakerFillTracker()
