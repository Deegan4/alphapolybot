/**
 * BTC Up/Down Signal Recorder — logs each signal the strategy computes with
 * how the window then resolved, so the confidence threshold can be judged on
 * evidence.
 *
 * These markets are held to resolution, so the outcome is binary: did the
 * asset finish the window above its reference price? It is read from the
 * strategy's own spot feed shortly after the window ends, which can differ
 * from the exchange's settlement source on a near-tie.
 */

import { takerCostPerContract, PMUS_DEFAULT_TAKER_THETA } from './pmusFees'

/** Samples kept (oldest dropped first) */
export const MAX_BTC_SAMPLES = 5000
/** A spot reading this long after the window end is too late to stand in for the settlement price (ms) */
export const RESOLVE_GRACE_MS = 90_000

const STORAGE_KEY = 'apb:btc-signal-samples'

export interface BtcSignalSample {
  /** Market window this signal was for */
  marketId: string
  asset: string
  duration: string
  /** When the signal was computed (ms) */
  t: number
  direction: 'up' | 'down'
  confidence: number
  /** Price of the outcome the signal points at, when computed */
  price: number
  /** Window reference price and end time */
  refPrice: number
  windowEndMs: number
  /** Whether the signalled direction won; unset until the window has ended */
  won?: boolean
}

export interface ConfidenceRow {
  minConfidence: number
  /** Resolved windows whose first signal at or above the confidence is counted */
  n: number
  winRate: number
  avgPrice: number
  /** Average return on stake held to resolution, after the entry taker fee */
  avgNet: number
}

/** Return on stake for buying at `price` as taker and holding to resolution */
export function resolutionReturn(price: number, won: boolean, theta = PMUS_DEFAULT_TAKER_THETA): number {
  const cost = takerCostPerContract(price, theta)
  return ((won ? 1 : 0) - cost) / cost
}

/**
 * Per confidence level: enter each window once, at its first signal at or
 * above that confidence (as the strategy does), and hold to resolution.
 * `maxPrice`/`minPrice` apply the strategy's entry-price limits.
 */
export function confidenceReport(
  samples: BtcSignalSample[],
  levels: number[] = [0.55, 0.6, 0.65, 0.7, 0.8],
  opts: { minPrice?: number; maxPrice?: number; theta?: number } = {},
): ConfidenceRow[] {
  const resolved = samples.filter(s => s.won != null).sort((a, b) => a.t - b.t)
  return levels.map(minConfidence => {
    const firstPerWindow = new Map<string, BtcSignalSample>()
    for (const s of resolved) {
      if (s.confidence < minConfidence || firstPerWindow.has(s.marketId)) continue
      if (!(s.price > 0 && s.price < 1)) continue
      if (opts.maxPrice != null && s.price > opts.maxPrice) continue
      if (opts.minPrice != null && s.price < opts.minPrice) continue
      firstPerWindow.set(s.marketId, s)
    }
    const entries = [...firstPerWindow.values()]
    const n = entries.length
    if (n === 0) return { minConfidence, n: 0, winRate: 0, avgPrice: 0, avgNet: 0 }
    return {
      minConfidence,
      n,
      winRate: entries.filter(s => s.won).length / n,
      avgPrice: entries.reduce((sum, s) => sum + s.price, 0) / n,
      avgNet: entries.reduce((sum, s) => sum + resolutionReturn(s.price, s.won!, opts.theta), 0) / n,
    }
  })
}

export class BtcSignalRecorder {
  private samples: BtcSignalSample[] = []
  private loaded = false
  private lastPersist = 0

  constructor(private readonly persist = true) {}

  record(sample: Omit<BtcSignalSample, 'won'>): void {
    this.load()
    if (!(sample.refPrice > 0) || !Number.isFinite(sample.confidence) || !Number.isFinite(sample.windowEndMs)) return
    this.samples.push({ ...sample })
    if (this.samples.length > MAX_BTC_SAMPLES) this.samples.splice(0, this.samples.length - MAX_BTC_SAMPLES)
    this.save(sample.t)
  }

  /** Assets with samples whose window has ended and still need an outcome */
  assetsToResolve(now: number): string[] {
    this.load()
    return [...new Set(this.samples.filter(s => s.won == null && s.windowEndMs <= now).map(s => s.asset))]
  }

  /**
   * Settle this asset's ended windows from a spot reading taken at `now`.
   * Windows that ended more than RESOLVE_GRACE_MS ago are dropped instead:
   * the price has moved on and would give the wrong winner.
   */
  resolve(asset: string, spotPrice: number, now: number): void {
    this.load()
    if (!(spotPrice > 0)) return
    this.samples = this.samples.filter(s => {
      if (s.asset !== asset || s.won != null || s.windowEndMs > now) return true
      if (now - s.windowEndMs > RESOLVE_GRACE_MS) return false
      if (spotPrice === s.refPrice) return false // tie: settlement rule unknown, leave it out
      s.won = (spotPrice > s.refPrice) === (s.direction === 'up')
      return true
    })
    this.save(now, true)
  }

  getSamples(): BtcSignalSample[] {
    this.load()
    return this.samples
  }

  getCounts(): { total: number; resolved: number } {
    this.load()
    return { total: this.samples.length, resolved: this.samples.filter(s => s.won != null).length }
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
        this.samples = parsed.filter((s): s is BtcSignalSample =>
          !!s && typeof s.marketId === 'string' && typeof s.t === 'number' && typeof s.confidence === 'number' && typeof s.windowEndMs === 'number')
      }
    } catch { /* corrupt or unavailable storage: start empty */ }
  }

  private save(now: number, force = false): void {
    if (!this.persist || (!force && now - this.lastPersist < 60_000)) return
    this.lastPersist = now
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.samples)) } catch { /* quota: keep in memory */ }
  }
}

export const btcSignalRecorder = new BtcSignalRecorder()
