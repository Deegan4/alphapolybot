/**
 * Stall detection for the Polymarket US WebSockets.
 *
 * A socket can stay "connected" while delivering nothing (half-open TCP,
 * stuck proxy). The server sends heartbeats, so silence much longer than the
 * observed heartbeat interval means the feed is dead and should be reopened.
 * The watchdog only arms once a heartbeat interval has been observed, so a
 * server that sends none can never trigger a reconnect loop.
 */

/** Never call a feed stalled before this much silence (ms) */
export const MIN_STALL_MS = 60_000
/** Silence, in heartbeat intervals, before the feed counts as stalled */
export const STALL_HEARTBEAT_MULTIPLE = 3
/** How often the services check for a stall (ms) */
export const WATCHDOG_INTERVAL_MS = 10_000

export function isFeedStalled(opts: {
  nowMs: number
  /** Last message or heartbeat (ms); 0 if none since connecting */
  lastActivityMs: number
  /** Observed gap between heartbeats (ms); null until two have arrived */
  heartbeatIntervalMs: number | null
}): boolean {
  if (opts.heartbeatIntervalMs == null || opts.lastActivityMs <= 0) return false
  const limit = Math.max(MIN_STALL_MS, opts.heartbeatIntervalMs * STALL_HEARTBEAT_MULTIPLE)
  return opts.nowMs - opts.lastActivityMs > limit
}

/** Tracks the gap between heartbeats (smallest seen, so one late beat does not loosen the limit) */
export class HeartbeatClock {
  private last = 0
  private interval: number | null = null

  beat(nowMs: number): void {
    if (this.last > 0) {
      const gap = nowMs - this.last
      if (gap > 0) this.interval = this.interval == null ? gap : Math.min(this.interval, gap)
    }
    this.last = nowMs
  }

  get intervalMs(): number | null {
    return this.interval
  }

  reset(): void {
    this.last = 0
    this.interval = null
  }
}
