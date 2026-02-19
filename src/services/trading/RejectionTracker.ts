/**
 * RejectionTracker — Lightweight in-memory singleton that aggregates trade
 * rejection counts across all strategies and TradingService.
 *
 * Design: Zero imports from strategies/stores/services (leaf-node in the
 * dependency graph). Strategies write to it; UI reads from it.
 * Same pub/sub pattern as ActivityLogger.
 */

// ──────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────

export type RejectionCategory =
  | 'confidence'
  | 'calibration'
  | 'microstructure'
  | 'risk'
  | 'balance'
  | 'approval'
  | 'gas'
  | 'liquidity'
  | 'cooldown'
  | 'position_limit'
  | 'market_filter'
  | 'order_too_small'
  | 'dry_run'

export interface RejectionEvent {
  category: RejectionCategory
  strategy: string   // 'llm' | 'btc' | 'dip' | 'fw' | 'micro' | 'system'
  reason: string
  timestamp: number
}

export interface RejectionSummary {
  /** Per-category counts in the rolling window */
  counts: Partial<Record<RejectionCategory, number>>
  /** Highest-count category (null if no rejections) */
  topBlocker: { category: RejectionCategory; count: number } | null
  /** Total rejections in window */
  total: number
}

type Callback = (event: RejectionEvent) => void

// ──────────────────────────────────────────────
// SINGLETON
// ──────────────────────────────────────────────

const WINDOW_MS = 60 * 60 * 1000  // 1-hour rolling window
const MAX_EVENTS = 500             // cap to prevent unbounded growth

class RejectionTrackerImpl {
  private events: RejectionEvent[] = []
  private callbacks = new Set<Callback>()

  /** Record a trade rejection */
  record(category: RejectionCategory, strategy: string, reason: string): void {
    const event: RejectionEvent = {
      category,
      strategy,
      reason,
      timestamp: Date.now(),
    }
    this.events.push(event)

    // Prune old events + cap size
    if (this.events.length > MAX_EVENTS) {
      this.prune()
    }

    // Notify subscribers
    for (const cb of this.callbacks) {
      try { cb(event) } catch { /* subscriber error — ignore */ }
    }
  }

  /** Get summary of rejections in the rolling window */
  getSummary(): RejectionSummary {
    const cutoff = Date.now() - WINDOW_MS
    const recent = this.events.filter(e => e.timestamp > cutoff)

    const counts: Partial<Record<RejectionCategory, number>> = {}
    for (const e of recent) {
      counts[e.category] = (counts[e.category] || 0) + 1
    }

    let topBlocker: RejectionSummary['topBlocker'] = null
    for (const [cat, count] of Object.entries(counts)) {
      if (!topBlocker || count > topBlocker.count) {
        topBlocker = { category: cat as RejectionCategory, count }
      }
    }

    return { counts, topBlocker, total: recent.length }
  }

  /** Subscribe to rejection events. Returns unsubscribe function. */
  onChange(cb: Callback): () => void {
    this.callbacks.add(cb)
    return () => this.callbacks.delete(cb)
  }

  /** Remove events older than the rolling window */
  private prune(): void {
    const cutoff = Date.now() - WINDOW_MS
    this.events = this.events.filter(e => e.timestamp > cutoff)
  }

  /** Reset all state (useful for tests) */
  reset(): void {
    this.events = []
  }
}

export const rejectionTracker = new RejectionTrackerImpl()
