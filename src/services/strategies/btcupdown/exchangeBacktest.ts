/**
 * Replay of the Crypto Up/Down signal on data the exchange itself publishes
 * for finished windows (no third-party data key needed):
 *   - the reference price ("price to beat") and the settlement price,
 *   - minute-by-minute Up / Down display prices (≈ best asks),
 * combined with spot trade ticks for the signal's price inputs.
 *
 * Pure functions only: fetching lives in scripts/backtest-updown.ts.
 *
 * Known gaps versus live trading, all stated in the report:
 *   - order-flow factor is 0 (no historical order books),
 *   - market prices are one reading per minute, so an entry uses a price up to
 *     60s old,
 *   - spot ticks come from one venue while the exchange settles on an index,
 *   - no depth check: every entry is assumed to fill at the displayed ask.
 */

import { computeSignal, type SignalEngineConfig, type SignalInput } from './signalEngine'
import type { Market } from '@/types'

export interface PricePoint { timestamp: number; price: number }

export interface WindowData {
  slug: string
  asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'
  startMs: number
  endMs: number
  /** Exchange reference price for the window */
  priceToBeat: number
  /** True if the window settled Up */
  upWon: boolean
  /** Taker fee coefficient Θ (fee per share = Θ·p·(1−p)) */
  feeCoefficient: number
  /** Up / Down display prices, oldest first */
  marketPrices: Array<{ timestamp: number; up: number; down: number }>
}

export interface ReplayConfig {
  minConfidence: number
  minEntryPrice: number
  maxEntryPrice: number
  /** Seconds before the window ends after which no entry is made */
  minWindowRemainingSec: number
  minTimeIntoWindowMs: number
  scanIntervalMs: number
  regimeFilterEnabled: boolean
  rsiFilterEnabled: boolean
  /** Size of the rolling tick buffer the signal sees (live strategy: 300) */
  tickBufferSize: number
  /**
   * How the spot feed is compared with the exchange's reference price:
   *   'exchange' — spot vs the published price to beat, as-is. Wrong by the
   *                gap between the spot venue and the settlement index.
   *   'venue'    — spot vs the same venue's own price at the window start,
   *                which cancels that gap (only its drift in-window remains).
   */
  reference: 'exchange' | 'venue'
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  minConfidence: 0.55,
  minEntryPrice: 0.10,
  maxEntryPrice: 0.45,
  minWindowRemainingSec: 120,
  minTimeIntoWindowMs: 45_000,
  scanIntervalMs: 15_000,
  regimeFilterEnabled: true,
  rsiFilterEnabled: true,
  tickBufferSize: 300,
  reference: 'exchange',
}

export interface ReplayTrade {
  slug: string
  asset: string
  entryMs: number
  direction: 'up' | 'down'
  confidence: number
  entryPrice: number
  won: boolean
  /** Profit per share after the taker fee */
  pnlPerShare: number
  /** Profit per $1 staked after the taker fee */
  pnlPerDollar: number
}

/** A signal reading at one scan, whether or not it passed the gates */
export interface ReplayReading {
  slug: string
  entryMs: number
  direction: 'up' | 'down'
  confidence: number
  price: number
  won: boolean
}

const BASELINE_WINDOW_MS = 15 * 60 * 1000
const STUB_MARKET = {} as Market

/** Taker fee per share at price p */
export function takerFee(price: number, feeCoefficient: number): number {
  return feeCoefficient * price * (1 - price)
}

/** Profit per share of buying at `price` and holding to settlement */
export function settlePnlPerShare(price: number, won: boolean, feeCoefficient: number): number {
  return (won ? 1 - price : -price) - takerFee(price, feeCoefficient)
}

/** Index of the last element with timestamp <= t, or -1 (array sorted ascending) */
function lastAtOrBefore<T extends { timestamp: number }>(items: T[], t: number): number {
  let lo = 0, hi = items.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].timestamp <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

/**
 * Signal readings at every scan of one window (first scan to the entry cut-off).
 * `ticks` must be sorted ascending and should start a few minutes before the
 * window so the rolling buffer is warm, as it is live.
 */
export function readWindow(window: WindowData, ticks: PricePoint[], config: ReplayConfig): ReplayReading[] {
  const durationMs = window.endMs - window.startMs
  const timeScale = durationMs / BASELINE_WINDOW_MS
  const firstScan = window.startMs + config.minTimeIntoWindowMs * timeScale
  const lastScan = window.endMs - config.minWindowRemainingSec * 1000 * timeScale
  const engine: SignalEngineConfig = {
    regimeFilterEnabled: config.regimeFilterEnabled,
    rsiFilterEnabled: config.rsiFilterEnabled,
    baselineWindowMs: BASELINE_WINDOW_MS,
  }
  let reference = window.priceToBeat
  if (config.reference === 'venue') {
    const startIdx = lastAtOrBefore(ticks, window.startMs)
    // No venue reading near the window start: nothing to anchor to
    if (startIdx < 0 || window.startMs - ticks[startIdx].timestamp > 60_000) return []
    reference = ticks[startIdx].price
  }
  const readings: ReplayReading[] = []
  for (let t = firstScan; t <= lastScan; t += config.scanIntervalMs) {
    const tickIdx = lastAtOrBefore(ticks, t)
    const priceIdx = lastAtOrBefore(window.marketPrices, t)
    if (tickIdx < 0 || priceIdx < 0) continue
    const quote = window.marketPrices[priceIdx]
    if (!(quote.up > 0 && quote.up < 1 && quote.down > 0 && quote.down < 1)) continue
    const buffer = ticks.slice(Math.max(0, tickIdx + 1 - config.tickBufferSize), tickIdx + 1)
    const input: SignalInput = {
      asset: window.asset,
      currentPrice: ticks[tickIdx].price,
      windowOpenPrice: reference,
      upPrice: quote.up,
      downPrice: quote.down,
      timeIntoWindowMs: t - window.startMs,
      windowDurationMs: durationMs,
      recentPriceHistory: buffer,
      market: STUB_MARKET,
    }
    const signal = computeSignal(input, engine, 0)
    readings.push({
      slug: window.slug,
      entryMs: t,
      direction: signal.direction,
      confidence: signal.confidence,
      price: signal.direction === 'up' ? quote.up : quote.down,
      won: (signal.direction === 'up') === window.upWon,
    })
  }
  return readings
}

/** First reading that passes the entry gates becomes the window's one trade */
export function tradeFromReadings(
  readings: ReplayReading[], window: WindowData, config: Pick<ReplayConfig, 'minConfidence' | 'minEntryPrice' | 'maxEntryPrice'>,
): ReplayTrade | null {
  const hit = readings.find(r =>
    r.confidence >= config.minConfidence && r.price >= config.minEntryPrice && r.price <= config.maxEntryPrice)
  if (!hit) return null
  const pnlPerShare = settlePnlPerShare(hit.price, hit.won, window.feeCoefficient)
  return {
    slug: window.slug,
    asset: window.asset,
    entryMs: hit.entryMs,
    direction: hit.direction,
    confidence: hit.confidence,
    entryPrice: hit.price,
    won: hit.won,
    pnlPerShare,
    pnlPerDollar: pnlPerShare / hit.price,
  }
}

export interface ReplaySummary {
  windows: number
  trades: number
  wins: number
  winRate: number
  avgEntryPrice: number
  /** Win rate needed to break even at the average entry price, fee included */
  breakEvenWinRate: number
  /** Total profit staking $1 on every trade */
  pnlPerDollarStaked: number
  /** Average return per trade (profit / stake) */
  roi: number
  /** Half-width of a 95% interval on the win rate (normal approximation) */
  winRateMargin: number
}

export function summarize(trades: ReplayTrade[], windows: number, feeCoefficient: number): ReplaySummary {
  const n = trades.length
  if (n === 0) {
    return { windows, trades: 0, wins: 0, winRate: 0, avgEntryPrice: 0, breakEvenWinRate: 0, pnlPerDollarStaked: 0, roi: 0, winRateMargin: 0 }
  }
  const wins = trades.filter(t => t.won).length
  const winRate = wins / n
  const avgEntryPrice = trades.reduce((s, t) => s + t.entryPrice, 0) / n
  const pnl = trades.reduce((s, t) => s + t.pnlPerDollar, 0)
  return {
    windows,
    trades: n,
    wins,
    winRate,
    avgEntryPrice,
    breakEvenWinRate: avgEntryPrice + takerFee(avgEntryPrice, feeCoefficient),
    pnlPerDollarStaked: pnl,
    roi: pnl / n,
    winRateMargin: 1.96 * Math.sqrt(winRate * (1 - winRate) / n),
  }
}
