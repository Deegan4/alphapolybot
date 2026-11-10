/**
 * Signal Recorder — logs microstructure signals with the price move that
 * followed, so the entry threshold can be judged on evidence.
 *
 * Each sample is one (market, time) reading of the composite signal. Once
 * `SIGNAL_HORIZON_MS` has passed, the next reading for that market supplies
 * the exit mid. `thresholdReport` then answers: had we entered every sample
 * at or above a threshold (taker in, taker out, paying the spread and fees),
 * what would the average return have been?
 *
 * Samples are taken every scan, so consecutive ones overlap in time and are
 * not independent: treat the report as a rough guide, not a backtest.
 */

import { roundTripFeeFraction, PMUS_DEFAULT_TAKER_THETA } from './pmusFees'

/** How long after a signal the outcome is measured (ms) */
export const SIGNAL_HORIZON_MS = 5 * 60_000
/** Samples kept (oldest dropped first) */
export const MAX_SIGNAL_SAMPLES = 5000
/** Signal confidence a sample needs to count in the report (the strategy's own gate) */
export const REPORT_MIN_CONFIDENCE = 0.5

const STORAGE_KEY = 'apb:micro-signal-samples'

export interface SignalSample {
  slug: string
  /** When the signal was read (ms) */
  t: number
  /** Composite signal, −1..1 (positive = buy YES, negative = buy NO) */
  composite: number
  confidence: number
  /** YES mid and spread (dollars) when the signal was read */
  mid: number
  spread: number
  /** YES mid at the first reading after the horizon; unset until then */
  exitMid?: number
}

export interface ThresholdRow {
  threshold: number
  /** Resolved samples at or above the threshold */
  n: number
  /** Share with a positive return after spread and fees */
  winRate: number
  /** Average return on stake before fees (spread paid both ways), as a fraction */
  avgGross: number
  /** Average return on stake after spread and taker fees both ways */
  avgNet: number
}

/**
 * Return on stake for entering in the signal's direction and exiting at the
 * horizon. Buys at mid + half-spread, sells at exit mid − half-spread (the
 * spread is assumed unchanged). Null for unresolved or unusable samples.
 */
export function sampleReturn(s: SignalSample, theta = PMUS_DEFAULT_TAKER_THETA): { gross: number; net: number } | null {
  if (s.exitMid == null || s.composite === 0) return null
  const yes = s.composite > 0
  const half = Math.max(0, s.spread) / 2
  const entry = (yes ? s.mid : 1 - s.mid) + half
  const exit = (yes ? s.exitMid : 1 - s.exitMid) - half
  if (!(entry > 0 && entry < 1) || !(exit > 0 && exit < 1)) return null
  const gross = (exit - entry) / entry
  return { gross, net: gross - roundTripFeeFraction(entry, exit, theta) }
}

/** Per-threshold outcome of entering every qualifying resolved sample */
export function thresholdReport(
  samples: SignalSample[],
  thresholds: number[] = [0.1, 0.2, 0.3, 0.4, 0.5],
  theta = PMUS_DEFAULT_TAKER_THETA,
): ThresholdRow[] {
  const resolved = samples
    .filter(s => s.confidence >= REPORT_MIN_CONFIDENCE)
    .map(s => ({ strength: Math.abs(s.composite), r: sampleReturn(s, theta) }))
    .filter((x): x is { strength: number; r: { gross: number; net: number } } => x.r !== null)

  return thresholds.map(threshold => {
    const hits = resolved.filter(x => x.strength >= threshold)
    const n = hits.length
    if (n === 0) return { threshold, n: 0, winRate: 0, avgGross: 0, avgNet: 0 }
    return {
      threshold,
      n,
      winRate: hits.filter(x => x.r.net > 0).length / n,
      avgGross: hits.reduce((sum, x) => sum + x.r.gross, 0) / n,
      avgNet: hits.reduce((sum, x) => sum + x.r.net, 0) / n,
    }
  })
}

/** Exit rules of the strategy being simulated */
export interface ExitRules {
  /** Close when the mark is down this fraction of the entry price (e.g. 0.15) */
  stopLossPercent: number
  /** Close when the mark is up this fraction of the entry price (e.g. 0.20) */
  takeProfitPercent: number
  /** Close after this long regardless (ms) */
  maxHoldMs: number
  /** Do not re-enter the same market for this long after an exit (ms) */
  cooldownMs?: number
}

export interface SimulatedTrade {
  slug: string
  /** Entry and exit times (ms) */
  t: number
  exitT: number
  strength: number
  reason: 'stop_loss' | 'take_profit' | 'max_hold'
  gross: number
  net: number
}

/** A gap this long between readings means the price path is unknown: the trade is discarded */
export const MAX_PATH_GAP_MS = 3 * 60_000

/**
 * Replay the strategy's exits over the recorded readings. Per market, in time
 * order: enter at the first confident reading at or above `threshold` (buying
 * at the ask), then follow that market's later readings, marking at the bid,
 * until stop-loss, take-profit or the hold limit closes the trade. No new
 * entry in that market until the trade is closed and the cooldown has passed,
 * so trades do not overlap and can be counted as separate observations.
 * Trades still open at the end of the data, or crossing a gap in it, are left out.
 */
export function simulateTrades(
  samples: SignalSample[],
  threshold: number,
  rules: ExitRules,
  theta = PMUS_DEFAULT_TAKER_THETA,
): SimulatedTrade[] {
  const bySlug = new Map<string, SignalSample[]>()
  for (const s of samples) {
    if (!bySlug.has(s.slug)) bySlug.set(s.slug, [])
    bySlug.get(s.slug)!.push(s)
  }
  const trades: SimulatedTrade[] = []
  for (const [slug, list] of bySlug) {
    list.sort((a, b) => a.t - b.t)
    let freeAt = -Infinity
    for (let i = 0; i < list.length; i++) {
      const entry = list[i]
      const strength = Math.abs(entry.composite)
      if (entry.t < freeAt || strength < threshold || entry.confidence < REPORT_MIN_CONFIDENCE) continue
      const yes = entry.composite > 0
      const entryPx = (yes ? entry.mid : 1 - entry.mid) + Math.max(0, entry.spread) / 2
      if (!(entryPx > 0 && entryPx < 1)) continue

      let prevT = entry.t
      let settled = false
      for (let j = i + 1; j < list.length; j++) {
        const r = list[j]
        if (r.t - prevT > MAX_PATH_GAP_MS) { freeAt = r.t; settled = true; break } // path unknown: discard
        prevT = r.t
        const mark = (yes ? r.mid : 1 - r.mid) - Math.max(0, r.spread) / 2
        if (!(mark > 0 && mark < 1)) continue
        const pnl = (mark - entryPx) / entryPx
        const reason: SimulatedTrade['reason'] | null =
          pnl <= -rules.stopLossPercent ? 'stop_loss'
            : pnl >= rules.takeProfitPercent ? 'take_profit'
              : r.t - entry.t >= rules.maxHoldMs ? 'max_hold'
                : null
        if (!reason) continue
        trades.push({
          slug, t: entry.t, exitT: r.t, strength, reason,
          gross: pnl,
          net: pnl - roundTripFeeFraction(entryPx, mark, theta),
        })
        freeAt = r.t + (rules.cooldownMs ?? 0)
        settled = true
        break
      }
      // still open at the end of the data: block further entries in this market
      if (!settled) freeAt = Infinity
    }
  }
  return trades.sort((a, b) => a.t - b.t)
}

/** Per-threshold outcome of replaying the strategy's exits (non-overlapping trades) */
export function exitRuleReport(
  samples: SignalSample[],
  rules: ExitRules,
  thresholds: number[] = [0.1, 0.2, 0.3, 0.4, 0.5],
  theta = PMUS_DEFAULT_TAKER_THETA,
): ThresholdRow[] {
  return thresholds.map(threshold => {
    const trades = simulateTrades(samples, threshold, rules, theta)
    const n = trades.length
    if (n === 0) return { threshold, n: 0, winRate: 0, avgGross: 0, avgNet: 0 }
    return {
      threshold,
      n,
      winRate: trades.filter(t => t.net > 0).length / n,
      avgGross: trades.reduce((sum, t) => sum + t.gross, 0) / n,
      avgNet: trades.reduce((sum, t) => sum + t.net, 0) / n,
    }
  })
}

/** Simulated trades a threshold needs before it can be suggested */
export const MIN_TRADES_TO_SUGGEST = 30

/**
 * The threshold with the best average after-fee return among those with at
 * least `minTrades` simulated trades and a positive average. Null when none
 * qualifies: too little data, or nothing has been profitable.
 */
export function suggestThreshold(rows: ThresholdRow[], minTrades = MIN_TRADES_TO_SUGGEST): ThresholdRow | null {
  const ok = rows.filter(r => r.n >= minTrades && r.avgNet > 0)
  if (ok.length === 0) return null
  return ok.reduce((best, r) => (r.avgNet > best.avgNet ? r : best))
}

function summarise(threshold: number, trades: Array<{ gross: number; net: number }>): ThresholdRow {
  const n = trades.length
  if (n === 0) return { threshold, n: 0, winRate: 0, avgGross: 0, avgNet: 0 }
  return {
    threshold,
    n,
    winRate: trades.filter(t => t.net > 0).length / n,
    avgGross: trades.reduce((sum, t) => sum + t.gross, 0) / n,
    avgNet: trades.reduce((sum, t) => sum + t.net, 0) / n,
  }
}

/** Held-out trades a suggestion needs before it counts as confirmed */
export const MIN_HOLDOUT_TRADES = 10

export interface HoldoutResult {
  /** Best threshold on the earlier part of the data */
  train: ThresholdRow
  /** The same threshold on the later part, which played no role in choosing it */
  test: ThresholdRow
  /** Positive after fees on at least MIN_HOLDOUT_TRADES held-out trades */
  confirmed: boolean
}

/**
 * Choose the threshold on the first `trainShare` of the recorded period, then
 * score it on the rest. Picking the best of several thresholds on the same
 * data flatters the winner; the later part is a fair check because it was not
 * used for the choice. Null when no threshold qualifies on the earlier part.
 */
export function holdoutSuggestion(
  samples: SignalSample[],
  rules: ExitRules,
  thresholds: number[] = [0.1, 0.2, 0.3, 0.4, 0.5],
  theta = PMUS_DEFAULT_TAKER_THETA,
  trainShare = 2 / 3,
): HoldoutResult | null {
  if (samples.length === 0) return null
  const times = samples.map(s => s.t).sort((a, b) => a - b)
  const cutoff = times[Math.min(times.length - 1, Math.floor(times.length * trainShare))]
  const perThreshold = thresholds.map(threshold => {
    const trades = simulateTrades(samples, threshold, rules, theta)
    return {
      // a trade belongs to the earlier part only if it also closed there
      train: summarise(threshold, trades.filter(t => t.exitT < cutoff)),
      test: summarise(threshold, trades.filter(t => t.t >= cutoff)),
    }
  })
  const train = suggestThreshold(perThreshold.map(x => x.train))
  if (!train) return null
  const test = perThreshold.find(x => x.train.threshold === train.threshold)!.test
  return { train, test, confirmed: test.n >= MIN_HOLDOUT_TRADES && test.avgNet > 0 }
}

export interface ExitGridCell {
  stopLossPercent: number
  takeProfitPercent: number
  n: number
  avgNet: number
}

/**
 * Replay at one entry threshold across stop-loss × take-profit levels (hold
 * limit and cooldown unchanged). Rows are stop-losses, columns take-profits.
 */
export function exitGridReport(
  samples: SignalSample[],
  threshold: number,
  rules: ExitRules,
  stopLosses: number[] = [0.05, 0.10, 0.15, 0.20, 0.30],
  takeProfits: number[] = [0.10, 0.20, 0.30, 0.50],
  theta = PMUS_DEFAULT_TAKER_THETA,
): ExitGridCell[][] {
  return stopLosses.map(stopLossPercent =>
    takeProfits.map(takeProfitPercent => {
      const row = summarise(threshold, simulateTrades(samples, threshold, { ...rules, stopLossPercent, takeProfitPercent }, theta))
      return { stopLossPercent, takeProfitPercent, n: row.n, avgNet: row.avgNet }
    }),
  )
}

/** The fields of a logged trade the comparison needs (a subset of TradeRecord) */
export interface LoggedTrade {
  strategy: string
  success: boolean
  timestamp: number
  exitTimestamp?: number
  pnlPercent?: number
  dryRun?: boolean
}

/**
 * Closed Microstructure Momentum trades from the trade log since `sinceMs`,
 * summarised like a report row. `pnlPercent` is taken as logged (price move
 * on the position; fees are not subtracted there), so compare it with the
 * replay's before-fees column.
 */
export function realTradeSummary(records: LoggedTrade[], sinceMs: number): { n: number; winRate: number; avgPnl: number; dryRun: number } {
  const closed = records.filter(r =>
    r.strategy === 'micro' && r.success && r.exitTimestamp != null && r.timestamp >= sinceMs && typeof r.pnlPercent === 'number' && Number.isFinite(r.pnlPercent))
  const n = closed.length
  if (n === 0) return { n: 0, winRate: 0, avgPnl: 0, dryRun: 0 }
  return {
    n,
    winRate: closed.filter(r => r.pnlPercent! > 0).length / n,
    avgPnl: closed.reduce((sum, r) => sum + r.pnlPercent!, 0) / n,
    dryRun: closed.filter(r => r.dryRun).length,
  }
}

/** CSV of every sample (exit_mid empty until the 5-minute outcome is known) */
export function samplesToCsv(samples: SignalSample[]): string {
  const lines = ['time_iso,market_slug,composite_signal,confidence,yes_mid,spread,exit_mid_5m']
  for (const s of samples) {
    const slug = /[",\n]/.test(s.slug) ? `"${s.slug.replace(/"/g, '""')}"` : s.slug
    lines.push([new Date(s.t).toISOString(), slug, s.composite, s.confidence, s.mid, s.spread, s.exitMid ?? ''].join(','))
  }
  return lines.join('\n') + '\n'
}

export class SignalRecorder {
  private samples: SignalSample[] = []
  private lastPersist = 0
  private loaded = false

  constructor(private readonly persist = true) {}

  /**
   * Add a reading. Also resolves this market's earlier samples whose horizon
   * has passed, using this reading's mid as their exit.
   */
  record(sample: Omit<SignalSample, 'exitMid'>): void {
    this.load()
    if (!(sample.mid > 0 && sample.mid < 1) || !Number.isFinite(sample.composite)) return
    for (const s of this.samples) {
      if (s.exitMid == null && s.slug === sample.slug && sample.t - s.t >= SIGNAL_HORIZON_MS) {
        // A reading long after the horizon says little about the signal: drop it
        s.exitMid = sample.t - s.t <= SIGNAL_HORIZON_MS * 2 ? sample.mid : NaN
      }
    }
    this.samples = this.samples.filter(s => !Number.isNaN(s.exitMid))
    this.samples.push({ ...sample })
    if (this.samples.length > MAX_SIGNAL_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SIGNAL_SAMPLES)
    }
    this.save(sample.t)
  }

  getSamples(): SignalSample[] {
    this.load()
    return this.samples
  }

  /** Counts for display: all samples, and those with a measured outcome */
  getCounts(): { total: number; resolved: number } {
    this.load()
    return { total: this.samples.length, resolved: this.samples.filter(s => s.exitMid != null).length }
  }

  clear(): void {
    this.samples = []
    this.loaded = true
    try { if (this.persist) localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.persist) return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed)) {
        this.samples = parsed.filter((s): s is SignalSample =>
          !!s && typeof s.slug === 'string' && typeof s.t === 'number' && typeof s.composite === 'number' && typeof s.mid === 'number')
      }
    } catch { /* corrupt or unavailable storage: start empty */ }
  }

  /** Persist at most once a minute */
  private save(now: number): void {
    if (!this.persist || now - this.lastPersist < 60_000) return
    this.lastPersist = now
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.samples)) } catch { /* quota: keep in memory */ }
  }
}

export const signalRecorder = new SignalRecorder()
