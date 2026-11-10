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
