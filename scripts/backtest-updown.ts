/**
 * Backtest the Crypto Up/Down signal on finished windows, using only free
 * public data: Polymarket US (reference price, settlement, minute prices) and
 * Binance.US spot trades. No keys needed, nothing is traded.
 *
 * Usage:
 *   npm run backtest                         # BTC, 15m windows, last 24 hours
 *   npm run backtest -- --asset ETH --hours 48
 *   npm run backtest -- --asset BTC,ETH,SOL --hours 72 --out results.json
 */
import { writeFileSync } from 'node:fs'
import {
  DEFAULT_REPLAY_CONFIG, readWindow, tradeFromReadings, summarize, settlePnlPerShare,
  type WindowData, type PricePoint, type ReplayReading, type ReplayTrade,
} from '../src/services/strategies/btcupdown/exchangeBacktest'

const GATEWAY = 'https://gateway.polymarket.us'
const BINANCE = 'https://api.binance.us'
/** Spot pair suffix: USD tracks the (USD) settlement index more closely than USDT */
const QUOTE = 'USD'
const WINDOW_MS = 15 * 60_000
const DEFAULT_FEE = 0.095
type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let lastCall = 0
/** GET JSON, spaced ~4/s, backing off on 429 / transient errors */
async function getJson<T>(url: string, gapMs = 260): Promise<T | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCall + gapMs - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (res.status === 404) return null
      if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue }
      if (!res.ok) return null
      return await res.json() as T
    } catch {
      await sleep(1000 * (attempt + 1))
    }
  }
  return null
}

function slugTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}z`
}

interface RawEvent {
  markets?: Array<{
    slug: string
    feeCoefficient?: number | string | null
    outcomePrices?: string[] | string | null
    assetPriceTerms?: { priceToBeat?: { value?: string } | null; settlementPrice?: { value?: string } | null } | null
  }>
}

async function loadWindow(asset: Asset, startMs: number): Promise<{ window: WindowData; disagreed: boolean } | null> {
  const eventSlug = `${asset.toLowerCase()}-updown-15m-${slugTime(startMs)}`
  const data = await getJson<{ event?: RawEvent } & RawEvent>(`${GATEWAY}/v1/events/slug/${eventSlug}`)
  const market = (data?.event ?? data)?.markets?.[0]
  const terms = market?.assetPriceTerms
  const priceToBeat = Number(terms?.priceToBeat?.value)
  const settlement = Number(terms?.settlementPrice?.value)
  if (!market || !(priceToBeat > 0) || !(settlement > 0)) return null
  const upWon = settlement >= priceToBeat

  // Cross-check against the paid-out outcome (YES = Up)
  let disagreed = false
  const raw = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) as string[] : market.outcomePrices
  if (Array.isArray(raw) && raw.length === 2 && (Number(raw[0]) === 1 || Number(raw[0]) === 0)) {
    disagreed = (Number(raw[0]) === 1) !== upWon
  }

  const s = Math.floor(startMs / 1000)
  const history = await getJson<{ history?: Array<{ timestamp: number; longPrice: number; shortPrice: number }> }>(
    `${GATEWAY}/v1/price-history?symbol=${market.slug}&timestamp.startTimestamp=${s}&timestamp.endTimestamp=${s + 900}&fidelity=1`)
  const marketPrices = (history?.history ?? [])
    .map(p => ({ timestamp: p.timestamp * 1000, up: Number(p.longPrice), down: Number(p.shortPrice) }))
    .sort((a, b) => a.timestamp - b.timestamp)
  if (marketPrices.length < 5) return null

  return {
    disagreed,
    window: {
      slug: market.slug,
      asset,
      startMs,
      endMs: startMs + WINDOW_MS,
      priceToBeat,
      // If the two sources disagree, trust what was actually paid out
      upWon: disagreed ? !upWon : upWon,
      feeCoefficient: Number(market.feeCoefficient) > 0 ? Number(market.feeCoefficient) : DEFAULT_FEE,
      marketPrices,
    },
  }
}

/** Spot trades for [fromMs, toMs), one reading per second at most */
async function loadTicks(asset: Asset, fromMs: number, toMs: number): Promise<PricePoint[]> {
  const ticks: PricePoint[] = []
  for (let start = fromMs; start < toMs; start += WINDOW_MS) {
    let cursor = start
    const end = Math.min(start + WINDOW_MS, toMs)
    // A busy 15 minutes can exceed the 1000-trade page: keep paging forward
    for (let page = 0; page < 20 && cursor < end; page++) {
      const trades = await getJson<Array<{ p: string; T: number }>>(
        `${BINANCE}/api/v3/aggTrades?symbol=${asset}${QUOTE}&startTime=${cursor}&endTime=${end - 1}&limit=1000`, 120)
      if (!trades || trades.length === 0) break
      for (const t of trades) {
        const second = Math.floor(t.T / 1000) * 1000
        const last = ticks[ticks.length - 1]
        if (last && last.timestamp === second) last.price = Number(t.p)
        else ticks.push({ timestamp: second, price: Number(t.p) })
      }
      if (trades.length < 1000) break
      cursor = trades[trades.length - 1].T + 1
    }
  }
  return ticks
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const usd = (x: number) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`

async function main() {
  const assets = arg('asset', 'BTC').toUpperCase().split(',') as Asset[]
  const hours = Number(arg('hours', '24'))
  const out = arg('out', '')
  const lastStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS - 2 * WINDOW_MS // settled windows only
  const count = Math.round(hours * 4)
  const config = DEFAULT_REPLAY_CONFIG

  const windows: WindowData[] = []
  let readings: ReplayReading[][] = []
  const readingsByReference: Record<'exchange' | 'venue', ReplayReading[][]> = { exchange: [], venue: [] }
  const gaps: number[] = []
  let missing = 0, disagreements = 0

  for (const asset of assets) {
    const firstStart = lastStart - (count - 1) * WINDOW_MS
    process.stderr.write(`${asset}: loading spot trades for ${hours}h...\n`)
    const ticks = await loadTicks(asset, firstStart - 10 * 60_000, lastStart + WINDOW_MS)
    process.stderr.write(`${asset}: ${ticks.length} spot readings; loading ${count} windows...\n`)
    for (let i = 0; i < count; i++) {
      const loaded = await loadWindow(asset, firstStart + i * WINDOW_MS)
      if (!loaded) { missing++; continue }
      if (loaded.disagreed) disagreements++
      windows.push(loaded.window)
      readingsByReference.exchange.push(readWindow(loaded.window, ticks, { ...config, reference: 'exchange' }))
      readingsByReference.venue.push(readWindow(loaded.window, ticks, { ...config, reference: 'venue' }))
      const atStart = ticks.filter(t => t.timestamp <= loaded.window.startMs).pop()
      if (atStart && loaded.window.startMs - atStart.timestamp <= 60_000) {
        gaps.push((atStart.price - loaded.window.priceToBeat) / loaded.window.priceToBeat)
      }
      if ((i + 1) % 24 === 0) process.stderr.write(`${asset}: ${i + 1}/${count}\n`)
    }
  }

  const fee = windows[0]?.feeCoefficient ?? DEFAULT_FEE
  const directionRight = (rs: ReplayReading[][]) => {
    const all = rs.flat()
    return all.filter(r => r.won).length / Math.max(1, all.length)
  }
  const referenceArg = arg('reference', 'venue') as 'exchange' | 'venue'
  readings = readingsByReference[referenceArg]
  const avgGap = gaps.reduce((s, g) => s + g, 0) / Math.max(1, gaps.length)
  const avgAbsGap = gaps.reduce((s, g) => s + Math.abs(g), 0) / Math.max(1, gaps.length)
  const tradesAt = (minConfidence: number, maxEntryPrice = config.maxEntryPrice, minEntryPrice = config.minEntryPrice): ReplayTrade[] =>
    windows.map((w, i) => tradeFromReadings(readings[i], w, { minConfidence, minEntryPrice, maxEntryPrice }))
      .filter((t): t is ReplayTrade => t !== null)

  const live = tradesAt(config.minConfidence)
  const summary = summarize(live, windows.length, fee)
  const allReadings = readings.flat()
  const maxConfidence = allReadings.reduce((m, r) => Math.max(m, r.confidence), 0)
  const upShare = windows.filter(w => w.upWon).length / Math.max(1, windows.length)

  const lines: string[] = []
  lines.push(`Crypto Up/Down backtest: ${assets.join(', ')} · 15-minute windows · last ${hours}h`)
  lines.push(`Windows with data: ${windows.length} (${missing} missing) · settled Up: ${pct(upShare)} · strongest signal seen: ${pct(maxConfidence)}`)
  lines.push(`Spot feed (Binance.US ${QUOTE}) vs the exchange's reference price at window start: ${(avgGap * 100).toFixed(3)}% on average, ${(avgAbsGap * 100).toFixed(3)}% typical size`)
  lines.push(`Signal direction right — measuring spot against the exchange's reference: ${pct(directionRight(readingsByReference.exchange))}; against the feed's own window-start price: ${pct(directionRight(readingsByReference.venue))}`)
  lines.push(`Everything below uses: ${referenceArg === 'venue' ? "the feed's own window-start price" : "the exchange's reference price"} (--reference ${referenceArg})`)
  if (disagreements > 0) lines.push(`Note: ${disagreements} window(s) where settlement price and paid outcome disagreed (paid outcome used).`)
  lines.push('')
  lines.push(`With the bot's current settings (confidence ≥ ${pct(config.minConfidence)}, entry price ${config.minEntryPrice}–${config.maxEntryPrice}):`)
  if (summary.trades === 0) {
    lines.push('  No trades: the signal never passed the entry gates.')
  } else {
    lines.push(`  Trades: ${summary.trades} of ${summary.windows} windows · wins: ${summary.wins} (${pct(summary.winRate)} ± ${pct(summary.winRateMargin)})`)
    lines.push(`  Average entry price: ${summary.avgEntryPrice.toFixed(3)} · win rate needed to break even after fees: ${pct(summary.breakEvenWinRate)}`)
    lines.push(`  Result staking $1 per trade: ${usd(summary.pnlPerDollarStaked)} (${pct(summary.roi)} per trade)`)
  }

  lines.push('')
  lines.push('If the confidence threshold were different (same price limits):')
  lines.push('  threshold  trades  win rate   avg price  break-even  $1/trade result')
  const sweep = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7].map(threshold => {
    const s = summarize(tradesAt(threshold), windows.length, fee)
    lines.push(`  ${pct(threshold).padStart(8)}  ${String(s.trades).padStart(6)}  ${(s.trades ? pct(s.winRate) : '--').padStart(8)}   ${(s.trades ? s.avgEntryPrice.toFixed(3) : '--').padStart(9)}  ${(s.trades ? pct(s.breakEvenWinRate) : '--').padStart(10)}  ${(s.trades ? usd(s.pnlPerDollarStaked) : '--').padStart(10)}`)
    return { threshold, ...s }
  })

  // Is the signal's direction any better than the market's own price?
  lines.push('')
  lines.push('Does the signal beat the market price? (every scan, any price, by confidence)')
  lines.push('  confidence   readings  direction right  avg price paid  edge after fees')
  const buckets = [[0, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 1.01]].map(([lo, hi]) => {
    const rs = allReadings.filter(r => r.confidence >= lo && r.confidence < hi)
    const n = rs.length
    const right = rs.filter(r => r.won).length / Math.max(1, n)
    const price = rs.reduce((s, r) => s + r.price, 0) / Math.max(1, n)
    const edge = rs.reduce((s, r) => s + settlePnlPerShare(r.price, r.won, fee), 0) / Math.max(1, n)
    lines.push(`  ${`${pct(lo)}–${pct(Math.min(hi, 1))}`.padEnd(12)} ${String(n).padStart(8)}  ${(n ? pct(right) : '--').padStart(15)}  ${(n ? price.toFixed(3) : '--').padStart(14)}  ${(n ? `${(edge * 100).toFixed(1)}¢/share` : '--').padStart(15)}`)
    return { lo, hi, readings: n, directionRight: right, avgPrice: price, edgePerShare: edge }
  })

  lines.push('')
  lines.push('Limits: order-flow factor not replayed (no historical order books); market prices are one reading per')
  lines.push('minute; spot ticks are Binance.US while the exchange settles on an index; fills assumed at the shown ask.')
  console.log(lines.join('\n'))

  if (out) {
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), assets, hours, config, reference: referenceArg, spotGap: { average: avgGap, typical: avgAbsGap }, directionRight: { exchange: directionRight(readingsByReference.exchange), venue: directionRight(readingsByReference.venue) }, summary, sweep, buckets, trades: live }, null, 2))
    process.stderr.write(`Saved ${out}\n`)
  }
}

main().catch(error => { console.error(error); process.exit(1) })
