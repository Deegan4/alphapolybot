/**
 * BTC Up/Down Signal Recorder — logs each signal the strategy computes with
 * how the window then resolved, so the confidence threshold can be judged on
 * evidence.
 *
 * These markets are held to resolution, so the outcome is binary: did the
 * asset finish the window above its reference price? The exchange's own
 * settlement decides it when available. Until then (settlement can lag the
 * window end) a provisional result comes from the strategy's spot feed just
 * after the window ends, which can be wrong on a near-tie.
 */

import { takerCostPerContract, PMUS_DEFAULT_TAKER_THETA } from './pmusFees'

/** Samples kept (oldest dropped first) */
export const MAX_BTC_SAMPLES = 5000
/** A spot reading this long after the window end is too late to stand in for the settlement price (ms) */
export const RESOLVE_GRACE_MS = 90_000

/** Keep asking the exchange for a window's settlement this long after it ends (ms) */
export const EXCHANGE_SETTLE_WINDOW_MS = 20 * 60_000
/** Wait this long between settlement lookups for the same market (ms) */
export const EXCHANGE_RETRY_MS = 30_000
/** Windows a confidence level needs in the earlier data before it can be suggested */
export const MIN_WINDOWS_TO_SUGGEST = 30
/** Held-out windows a suggestion needs before it counts as confirmed */
export const MIN_HOLDOUT_WINDOWS = 10

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
  /** Market slug, and whether its YES side is the "Up" outcome (for exchange settlement) */
  slug?: string
  yesMeansUp?: boolean
  /** Whether the signalled direction won; unset until the window has ended */
  won?: boolean
  /** Where `won` came from: the exchange's settlement, or the bot's spot price (provisional) */
  source?: 'exchange' | 'spot'
  /** The spot-price verdict, kept when the exchange later settles, to measure how often they differ */
  spotWon?: boolean
}

export interface ConfidenceHoldout {
  /** Best confidence level on the earlier windows */
  train: ConfidenceRow
  /** The same level on the later windows, which played no role in choosing it */
  test: ConfidenceRow
  confirmed: boolean
}

/**
 * Choose the confidence level on the first `trainShare` of resolved windows
 * (by end time), then score it on the rest. Null when no level has enough
 * profitable windows in the earlier part.
 */
export function confidenceHoldout(
  samples: BtcSignalSample[],
  levels: number[] = [0.55, 0.6, 0.65, 0.7, 0.8],
  opts: { minPrice?: number; maxPrice?: number; theta?: number } = {},
  trainShare = 2 / 3,
): ConfidenceHoldout | null {
  const resolved = samples.filter(s => s.won != null)
  const ends = [...new Set(resolved.map(s => s.windowEndMs))].sort((a, b) => a - b)
  if (ends.length === 0) return null
  const cutoff = ends[Math.min(ends.length - 1, Math.floor(ends.length * trainShare))]
  const trainRows = confidenceReport(resolved.filter(s => s.windowEndMs < cutoff), levels, opts)
  const ok = trainRows.filter(r => r.n >= MIN_WINDOWS_TO_SUGGEST && r.avgNet > 0)
  if (ok.length === 0) return null
  const train = ok.reduce((best, r) => (r.avgNet > best.avgNet ? r : best))
  const [test] = confidenceReport(resolved.filter(s => s.windowEndMs >= cutoff), [train.minConfidence], opts)
  return { train, test, confirmed: test.n >= MIN_HOLDOUT_WINDOWS && test.avgNet > 0 }
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
  private lastExchangeTry = new Map<string, number>()

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
      // Samples the exchange can still settle are kept past the grace period
      const exchangeCanSettle = s.slug != null && s.yesMeansUp != null && now - s.windowEndMs <= EXCHANGE_SETTLE_WINDOW_MS
      if (now - s.windowEndMs > RESOLVE_GRACE_MS) return exchangeCanSettle
      if (spotPrice === s.refPrice) return exchangeCanSettle // tie: only the exchange can call it
      s.won = (spotPrice > s.refPrice) === (s.direction === 'up')
      s.spotWon = s.won
      s.source = 'spot'
      return true
    })
    this.save(now, true)
  }

  /**
   * Markets whose window has ended and that the exchange has not settled in
   * our records yet, oldest first, skipping any tried within EXCHANGE_RETRY_MS.
   * Marks the returned ones as tried.
   */
  marketsAwaitingExchange(now: number, limit = 3): Array<{ marketId: string; slug: string }> {
    this.load()
    const out = new Map<string, string>()
    for (const s of this.samples) {
      if (out.size >= limit) break
      if (!s.slug || s.yesMeansUp == null || s.source === 'exchange') continue
      if (s.windowEndMs > now || now - s.windowEndMs > EXCHANGE_SETTLE_WINDOW_MS) continue
      if (now - (this.lastExchangeTry.get(s.marketId) ?? -Infinity) < EXCHANGE_RETRY_MS) continue
      out.set(s.marketId, s.slug)
    }
    for (const id of out.keys()) this.lastExchangeTry.set(id, now)
    return [...out].map(([marketId, slug]) => ({ marketId, slug }))
  }

  /** Apply the exchange's settlement (YES price 1 or 0) to every sample of a market */
  settleFromExchange(marketId: string, yesSettlement: number, now: number): void {
    this.load()
    if (yesSettlement !== 0 && yesSettlement !== 1) return // not a clean binary result: leave as is
    for (const s of this.samples) {
      if (s.marketId !== marketId || s.yesMeansUp == null) continue
      const upWon = (yesSettlement === 1) === s.yesMeansUp
      s.won = upWon === (s.direction === 'up')
      s.source = 'exchange'
    }
    this.lastExchangeTry.delete(marketId)
    this.save(now, true)
  }

  /** Drop samples that never got a result and no longer can (call occasionally) */
  prune(now: number): void {
    this.load()
    this.samples = this.samples.filter(s => s.won != null || now - s.windowEndMs <= EXCHANGE_SETTLE_WINDOW_MS)
  }

  /**
   * How results were decided, counted per window: settled by the exchange,
   * provisional from spot, and windows where the two disagreed.
   */
  getSourceCounts(): { exchange: number; spot: number; disagreed: number } {
    this.load()
    const perWindow = new Map<string, BtcSignalSample>()
    for (const s of this.samples) if (s.won != null && !perWindow.has(s.marketId)) perWindow.set(s.marketId, s)
    let exchange = 0, spot = 0, disagreed = 0
    for (const s of perWindow.values()) {
      if (s.source === 'exchange') {
        exchange++
        if (s.spotWon != null && s.spotWon !== s.won) disagreed++
      } else {
        spot++
      }
    }
    return { exchange, spot, disagreed }
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
    this.lastExchangeTry.clear()
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
