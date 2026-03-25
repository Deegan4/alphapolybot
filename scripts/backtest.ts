#!/usr/bin/env npx tsx
/**
 * CLI Backtest Runner — run multi-strategy backtests headlessly.
 *
 * Uses free APIs (Gamma + CLOB prices-history + Binance klines) to fetch
 * resolved Crypto Up/Down markets and run strategy simulations.
 *
 * Strategies available in CLI mode:
 *   - btc-updown     (8-factor signal, resolution-hold)
 *   - dual-side      (70/30 maker-only YES+NO)
 *   - gabagool       (merge arb accumulator)
 *   - impulse-sniper (latency arb on BTC impulses)
 *   - llm-prediction (Monte Carlo baseline)
 *
 * DipArb and ProjectFW require browser IndexedDB snapshots — not available in CLI.
 *
 * Usage:
 *   npx tsx scripts/backtest.ts
 *   npx tsx scripts/backtest.ts --strategies btc-updown,gabagool
 *   npx tsx scripts/backtest.ts --market-type 1hr --max-markets 20
 *   npx tsx scripts/backtest.ts --output results.json
 *   npx tsx scripts/backtest.ts --help
 */

/* eslint-disable no-console */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── Types (inline to avoid import.meta.env issues) ──────────

type MarketType = '5m' | '15m' | '1hr' | '4hr' | '24hr'

interface GammaMarket {
  id: string
  slug: string
  outcomes: string[]
  outcomePrices: number[]
  clobTokenIds?: string[]
  volume?: number
  liquidity?: number
  endDate: string
  createdAt?: string
  updatedAt?: string
  eventSlug?: string
  conditionId?: string
}

interface PricePoint { t: number; p: number }
interface BinanceKline { openTime: number; close: number }

interface Snapshot {
  id: string
  time: string
  market_id: string
  btc_price: number
  price_up: number
  price_down: number
  orderbook_up: null
  orderbook_down: null
}

interface MarketInfo {
  market_id: string
  event_id: string
  slug: string
  market_type: MarketType
  start_time: string
  end_time: string
  btc_price_start: number | null
  btc_price_end: number | null
  condition_id: string | null
  clob_token_up: string | null
  clob_token_down: string | null
  winner: 'up' | 'down' | null
  final_volume: number | null
  final_liquidity: number | null
  resolved_at: string | null
  created_at: string | null
  updated_at: string | null
}

interface Trade {
  timestamp: string
  strategy: string
  direction: string
  entryPrice: number
  exitPrice: number
  pnl: number
  feePaid: number
  holdTimeMs: number
  metadata?: Record<string, unknown>
}

interface Summary {
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  avgPnl: number
  avgHoldTimeMs: number
  maxDrawdown: number
  sharpeRatio: number | null
  profitFactor: number | null
}

interface StrategyResult {
  strategy: string
  strategyName: string
  trades: Trade[]
  summary: Summary
  dataSource: string
}

// ─── CLI Argument Parsing ────────────────────────────────

interface CLIArgs {
  strategies: string[]
  marketType: MarketType
  maxMarkets: number
  output: string | null
  help: boolean
  verbose: boolean
}

const ALL_CLI_STRATEGIES = ['btc-updown', 'dual-side', 'gabagool', 'impulse-sniper', 'llm-prediction']

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2)
  const result: CLIArgs = {
    strategies: [...ALL_CLI_STRATEGIES],
    marketType: '1hr',
    maxMarkets: 10,
    output: null,
    help: false,
    verbose: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case '--help': case '-h':
        result.help = true
        break
      case '--strategies': case '-s':
        result.strategies = next.split(',').map(s => s.trim())
        i++
        break
      case '--market-type': case '-m':
        result.marketType = next as MarketType
        i++
        break
      case '--max-markets': case '-n':
        result.maxMarkets = parseInt(next, 10)
        i++
        break
      case '--output': case '-o':
        result.output = next
        i++
        break
      case '--verbose': case '-v':
        result.verbose = true
        break
      default:
        console.error(`Unknown argument: ${arg}`)
        process.exit(1)
    }
  }

  // Validate strategies
  for (const s of result.strategies) {
    if (!ALL_CLI_STRATEGIES.includes(s)) {
      console.error(`Unknown strategy: ${s}`)
      console.error(`Available: ${ALL_CLI_STRATEGIES.join(', ')}`)
      process.exit(1)
    }
  }

  // Validate market type
  const validTypes: MarketType[] = ['5m', '15m', '1hr', '4hr', '24hr']
  if (!validTypes.includes(result.marketType)) {
    console.error(`Invalid market type: ${result.marketType}`)
    console.error(`Available: ${validTypes.join(', ')}`)
    process.exit(1)
  }

  return result
}

function printHelp(): void {
  console.log(`
AlphaPolyBot CLI Backtest Runner

Usage:
  npx tsx scripts/backtest.ts [options]

Options:
  -s, --strategies <list>   Comma-separated strategies (default: all)
  -m, --market-type <type>  Market window: 5m, 15m, 1hr, 4hr, 24hr (default: 1hr)
  -n, --max-markets <num>   Max markets to backtest (default: 10)
  -o, --output <file>       Write JSON results to file
  -v, --verbose             Show per-market progress
  -h, --help                Show this help

Strategies:
  btc-updown       8-factor signal, resolution-hold
  dual-side        70/30 biased YES+NO maker orders
  gabagool         Merge arb accumulator (guaranteed profit)
  impulse-sniper   Latency arb on BTC impulses
  llm-prediction   Monte Carlo baseline (no real LLM)

Examples:
  npx tsx scripts/backtest.ts
  npx tsx scripts/backtest.ts -s btc-updown,gabagool -m 1hr -n 20
  npx tsx scripts/backtest.ts -m 4hr -n 5 -o results.json
  npx tsx scripts/backtest.ts -s llm-prediction
`)
}

// ─── API Clients (direct URLs, no Vite proxy) ───────────

const GAMMA_BASE = 'https://gamma-api.polymarket.com'
const CLOB_BASE = 'https://clob.polymarket.com'
// Try Binance US first (avoids 451 geo-restriction), fall back to .com
let BINANCE_BASE = 'https://api.binance.us'

async function fetchJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`)
  return res.json() as Promise<T>
}

// ─── Data Fetching ───────────────────────────────────────

const SLUG_PATTERNS: Record<MarketType, string[]> = {
  '5m': ['btc-updown-5m-', 'eth-updown-5m-', 'sol-updown-5m-'],
  '15m': ['btc-updown-15m-', 'eth-updown-15m-', 'sol-updown-15m-'],
  '1hr': ['bitcoin-up-or-down-', 'ethereum-up-or-down-'],
  '4hr': ['btc-updown-4h-', 'eth-updown-4h-'],
  '24hr': ['bitcoin-up-or-down-'],
}

const WINDOW_DURATION_MS: Record<MarketType, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1hr': 60 * 60_000,
  '4hr': 4 * 60 * 60_000,
  '24hr': 24 * 60 * 60_000,
}

function isUpOutcome(outcome: string): boolean {
  const lower = outcome.toLowerCase()
  return lower === 'up' || lower === 'yes' || lower.includes('up')
}

/** Parse Gamma API fields (returned as JSON strings) */
function parseJsonArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String)
  if (typeof val === 'string') {
    try { const parsed = JSON.parse(val); return Array.isArray(parsed) ? parsed.map(String) : [] }
    catch { return [] }
  }
  return []
}

function parseNumArray(val: unknown): number[] {
  const arr = parseJsonArray(val)
  return arr.map(s => parseFloat(s) || 0)
}

/** Binary search for the Gamma offset where markets have endDate near targetDate */
async function findOffsetByDate(targetDate: Date, verbose: boolean): Promise<number> {
  const targetMs = targetDate.getTime()

  // Step 1: Find total market count (upper bound)
  let lo = 0, hi = 600_000
  const topProbe = await fetchJSON<GammaMarket[]>(`${GAMMA_BASE}/markets?closed=true&limit=1&offset=${hi}`)
  if (topProbe.length === 0) {
    // Shrink hi to find actual end
    let boundLo = 0, boundHi = hi
    while (boundHi > boundLo + 1000) {
      const mid = Math.floor((boundLo + boundHi) / 2)
      const p = await fetchJSON<GammaMarket[]>(`${GAMMA_BASE}/markets?closed=true&limit=1&offset=${mid}`)
      if (p.length === 0) boundHi = mid
      else boundLo = mid
    }
    hi = boundHi
    if (verbose) console.log(`  Total closed markets: ~${hi}`)
  }

  // Step 2: Binary search by endDate within [0, hi]
  lo = 0
  for (let iter = 0; iter < 25; iter++) {
    const mid = Math.floor((lo + hi) / 2)
    const page = await fetchJSON<GammaMarket[]>(`${GAMMA_BASE}/markets?closed=true&limit=1&offset=${mid}`)
    if (page.length === 0) { hi = mid; continue }

    const endMs = new Date(page[0].endDate).getTime()
    if (verbose && iter < 6) {
      console.log(`  Binary search: offset ${mid} → ${page[0].endDate?.slice(0, 10)}`)
    }

    if (endMs < targetMs) lo = mid
    else hi = mid

    if (hi - lo < 500) break
  }

  // Back up to ensure we don't miss markets
  return Math.max(0, lo - 2000)
}

/** Extract matching markets from a Gamma API page */
function extractMarkets(
  rawMarkets: GammaMarket[],
  slugPrefixes: string[],
  marketType: MarketType,
): MarketInfo[] {
  const results: MarketInfo[] = []

  for (const raw of rawMarkets) {
    const slug = raw.slug || ''
    const outcomes = parseJsonArray(raw.outcomes as unknown)
    const clobTokenIds = parseJsonArray(raw.clobTokenIds as unknown)
    const outcomePrices = parseNumArray(raw.outcomePrices as unknown)

    if (!slug || clobTokenIds.length < 2 || outcomes.length < 2) continue

    const matchesType = slugPrefixes.some(p => slug.toLowerCase().startsWith(p))
    if (!matchesType) continue

    // Infer winner from resolved prices
    let winner: 'up' | 'down' | null = null
    if (outcomePrices.length >= 2) {
      if (outcomePrices[0] > 0.9) winner = isUpOutcome(outcomes[0]) ? 'up' : 'down'
      else if (outcomePrices[1] > 0.9) winner = isUpOutcome(outcomes[1]) ? 'up' : 'down'
    }

    const upIdx = outcomes.findIndex(o => isUpOutcome(o))
    const downIdx = upIdx === 0 ? 1 : 0
    const windowMs = WINDOW_DURATION_MS[marketType]
    const endMs = new Date(raw.endDate).getTime()

    results.push({
      market_id: raw.id,
      event_id: raw.eventSlug ?? slug,
      slug,
      market_type: marketType,
      start_time: new Date(endMs - windowMs).toISOString(),
      end_time: raw.endDate,
      btc_price_start: null,
      btc_price_end: null,
      condition_id: raw.conditionId ?? null,
      clob_token_up: clobTokenIds[upIdx] ?? null,
      clob_token_down: clobTokenIds[downIdx] ?? null,
      winner,
      final_volume: typeof raw.volume === 'string' ? parseFloat(raw.volume) : (raw.volume ?? null),
      final_liquidity: typeof raw.liquidity === 'string' ? parseFloat(raw.liquidity as string) : (raw.liquidity ?? null),
      resolved_at: raw.endDate ?? null,
      created_at: raw.createdAt ?? null,
      updated_at: raw.updatedAt ?? null,
    })
  }

  return results
}

async function discoverMarkets(
  marketType: MarketType,
  maxMarkets: number,
  verbose: boolean,
): Promise<MarketInfo[]> {
  const slugPrefixes = SLUG_PATTERNS[marketType]
  const results: MarketInfo[] = []

  // BTC up/down markets started ~late 2025. Gamma API returns oldest-first, no text search.
  // Strategy: binary search to a target date, then stride-sample every 5000 offsets
  // to find pages with matches, then scan those pages densely.
  const daysBack = 14 // Recent markets have better CLOB price data retention
  const targetDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
  if (verbose) console.log(`  Finding offset for markets after ${targetDate.toISOString().slice(0, 10)}...`)
  const startOffset = await findOffsetByDate(targetDate, verbose)
  if (verbose) console.log(`  Starting scan at offset ${startOffset}`)

  // Phase 1: Sample every 5000 offsets to find regions with BTC markets
  const stride = 5000
  const hitOffsets: number[] = []
  const endOffset = startOffset + 200_000

  process.stdout.write('  Scanning for markets')
  for (let probe = startOffset; probe < endOffset; probe += stride) {
    const url = `${GAMMA_BASE}/markets?closed=true&limit=100&offset=${probe}`
    let page: GammaMarket[]
    try {
      page = await fetchJSON<GammaMarket[]>(url)
    } catch { continue }
    if (page.length === 0) break

    const found = extractMarkets(page, slugPrefixes, marketType)
    if (found.length > 0) {
      hitOffsets.push(probe)
      results.push(...found)
      if (verbose) console.log(`\n    offset ${probe}: ${found.length} matches (${found[0].slug.slice(0, 40)})`)
      else process.stdout.write('.')
    }

    if (results.length >= maxMarkets) break
  }
  if (!verbose) console.log()

  if (results.length >= maxMarkets) return results.slice(0, maxMarkets)

  // Phase 2: Dense scan around hit offsets (fill in gaps)
  if (hitOffsets.length > 0 && results.length < maxMarkets) {
    if (verbose) console.log(`  Dense scanning around ${hitOffsets.length} hit regions...`)
    for (const hitOffset of hitOffsets) {
      if (results.length >= maxMarkets) break

      // Scan +/- 2500 around each hit in 100-market pages
      for (let off = hitOffset - 2500; off < hitOffset + 2500; off += 100) {
        if (off < 0 || off === hitOffset) continue // Skip the page we already fetched
        if (results.length >= maxMarkets) break

        const url = `${GAMMA_BASE}/markets?closed=true&limit=100&offset=${off}`
        let page: GammaMarket[]
        try { page = await fetchJSON<GammaMarket[]>(url) } catch { continue }
        if (page.length === 0) continue

        const found = extractMarkets(page, slugPrefixes, marketType)
        // Deduplicate by market_id
        for (const m of found) {
          if (!results.some(r => r.market_id === m.market_id)) {
            results.push(m)
          }
        }
      }
    }
  }

  return results.slice(0, maxMarkets)
}

async function fetchClobPrices(
  tokenId: string,
  startMs: number,
  endMs: number,
  fidelity: number,
): Promise<PricePoint[]> {
  try {
    const params = new URLSearchParams({
      market: tokenId,
      interval: 'max',
      startTs: String(Math.floor(startMs / 1000)),
      endTs: String(Math.floor(endMs / 1000)),
      fidelity: String(fidelity),
    })
    const url = `${CLOB_BASE}/prices-history?${params}`
    const data = await fetchJSON<{ history: Array<{ t: number; p: number }> }>(url)
    return (data.history || []).map(pt => ({ t: pt.t * 1000, p: pt.p }))
  } catch {
    return []
  }
}

async function fetchBinanceKlines(
  intervalMinutes: number,
  startMs: number,
  endMs: number,
): Promise<BinanceKline[]> {
  const interval = intervalMinutes <= 1 ? '1m'
    : intervalMinutes <= 3 ? '3m'
    : intervalMinutes <= 5 ? '5m'
    : intervalMinutes <= 15 ? '15m'
    : '1h'

  const klines: BinanceKline[] = []
  let cursor = startMs

  while (cursor < endMs) {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`
    let data: unknown[][]
    try {
      data = await fetchJSON(url)
    } catch (err) {
      // If Binance US fails, try .com; if .com fails (451 geo), try US
      if (BINANCE_BASE === 'https://api.binance.us') {
        BINANCE_BASE = 'https://api.binance.com'
      } else {
        BINANCE_BASE = 'https://api.binance.us'
      }
      try {
        data = await fetchJSON(`${BINANCE_BASE}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`)
      } catch {
        console.error(`  Binance klines unavailable: ${(err as Error).message}`)
        return klines
      }
    }
    if (data.length === 0) break

    for (const candle of data) {
      klines.push({ openTime: candle[0] as number, close: parseFloat(candle[4] as string) })
    }

    cursor = (data[data.length - 1][0] as number) + 1
    if (data.length < 1000) break
  }

  return klines
}

function interpolate(data: PricePoint[], targetMs: number): number | null {
  if (data.length === 0) return null
  let best = data[0]
  let bestDist = Math.abs(data[0].t - targetMs)
  for (const d of data) {
    const dist = Math.abs(d.t - targetMs)
    if (dist < bestDist) { best = d; bestDist = dist }
    if (d.t > targetMs && dist > bestDist) break
  }
  return bestDist < 5 * 60_000 ? best.p : null
}

function interpolateBtc(klines: BinanceKline[], targetMs: number): number | null {
  if (klines.length === 0) return null
  let best = klines[0]
  let bestDist = Math.abs(klines[0].openTime - targetMs)
  for (const k of klines) {
    const dist = Math.abs(k.openTime - targetMs)
    if (dist < bestDist) { best = k; bestDist = dist }
    if (k.openTime > targetMs && dist > bestDist) break
  }
  return bestDist < 5 * 60_000 ? best.close : null
}

async function fetchSnapshots(market: MarketInfo): Promise<Snapshot[]> {
  if (!market.clob_token_up || !market.clob_token_down) return []

  const endMs = new Date(market.end_time).getTime()
  // Use a wider window for data fetching — markets trade for hours/days before resolution.
  // The signal engine needs enough snapshots for lookback, so fetch up to 6 hours of data.
  const windowMs = WINDOW_DURATION_MS[market.market_type]
  const dataWindowMs = Math.max(windowMs * 6, 6 * 60 * 60_000) // At least 6 hours
  const startMs = endMs - dataWindowMs
  // Use fidelity=60 (1 minute) for maximum resolution — higher values reduce data points
  const fidelity = 60

  const [upPrices, downPrices, btcKlines] = await Promise.all([
    fetchClobPrices(market.clob_token_up, startMs, endMs, fidelity),
    fetchClobPrices(market.clob_token_down, startMs, endMs, fidelity),
    fetchBinanceKlines(1, startMs, endMs),
  ])

  if (upPrices.length === 0 || downPrices.length === 0) return []

  const downMap = new Map(downPrices.map(d => [d.t, d.p]))
  const btcMap = new Map(btcKlines.map(k => [k.openTime, k.close]))

  const snapshots: Snapshot[] = []
  let idx = 0

  for (const up of upPrices) {
    const downPrice = downMap.get(up.t) ?? interpolate(downPrices, up.t)
    if (downPrice == null) continue
    const btcPrice = btcMap.get(up.t) ?? interpolateBtc(btcKlines, up.t)
    if (btcPrice == null) continue

    snapshots.push({
      id: `cli-${market.market_id}-${idx++}`,
      time: new Date(up.t).toISOString(),
      market_id: market.market_id,
      btc_price: btcPrice,
      price_up: up.p,
      price_down: downPrice,
      orderbook_up: null,
      orderbook_down: null,
    })
  }

  return snapshots
}

// ─── Signal Engine (simplified 8-factor) ─────────────────

interface Signal {
  confidence: number
  direction: 'up' | 'down'
  factors: Record<string, number>
}

function computeSignal(snapshots: Snapshot[], idx: number): Signal {
  const snap = snapshots[idx]
  const btcPrice = snap.btc_price

  // Factor 1: Momentum (price move over lookback)
  const lookback = Math.min(5, idx)
  const prevBtc = lookback > 0 ? snapshots[idx - lookback].btc_price : btcPrice
  const priceDelta = btcPrice - prevBtc
  const momentumPct = prevBtc > 0 ? priceDelta / prevBtc : 0
  const momentum = Math.min(1, Math.abs(momentumPct) * 50)

  // Factor 2: Velocity (acceleration)
  let velocity = 0
  if (idx >= 2) {
    const prev1 = snapshots[idx - 1].btc_price
    const prev2 = snapshots[idx - 2].btc_price
    const v1 = btcPrice - prev1
    const v2 = prev1 - prev2
    velocity = v1 > v2 ? Math.min(1, (v1 - v2) / (Math.abs(v2) + 1) * 0.5) : 0
  }

  // Factor 3: Value bet (how cheap is the outcome)
  const directionFromMomentum = momentumPct >= 0 ? 'up' : 'down'
  const outcomePrice = directionFromMomentum === 'up' ? snap.price_up : snap.price_down
  const valueBet = outcomePrice < 0.55 ? (0.55 - outcomePrice) * 5 : 0

  // Factor 4: Time decay (higher confidence later in window)
  const totalSnapshots = snapshots.length
  const progressFraction = totalSnapshots > 1 ? idx / (totalSnapshots - 1) : 0
  const timeDecay = Math.min(1, progressFraction * 1.5)

  // Factor 5: Spread (price incoherence)
  const askSum = snap.price_up + snap.price_down
  const spreadSignal = askSum < 0.98 ? (0.98 - askSum) * 10 : 0

  // Weighted composite (simplified from 8 factors)
  const weights = { momentum: 0.25, velocity: 0.15, valueBet: 0.25, timeDecay: 0.15, spread: 0.20 }
  const raw =
    momentum * weights.momentum +
    velocity * weights.velocity +
    valueBet * weights.valueBet +
    timeDecay * weights.timeDecay +
    spreadSignal * weights.spread

  const confidence = Math.min(0.95, Math.max(0.05, raw))

  return {
    confidence,
    direction: directionFromMomentum as 'up' | 'down',
    factors: { momentum, velocity, valueBet, timeDecay, spread: spreadSignal },
  }
}

// ─── Strategy Runners ────────────────────────────────────

// --- BTC Up/Down ---
// Matches live v66 config: tighter gates, edge requirement, early-window ramp
function runBtcUpDown(market: MarketInfo, snapshots: Snapshot[]): Trade[] {
  const trades: Trade[] = []
  // Simplified 5-factor engine outputs lower confidence than live 8-factor.
  // Calibrate backtest gates to be proportionally selective:
  // live engine peaks ~0.70+, simplified peaks ~0.55-0.60.
  const minConfidence = 0.42       // ~top 30% of simplified engine outputs
  const maxEntryPrice = 0.48       // live v66 setting
  const minEdgeOverMarket = 0.05   // 5% edge (lower than live 7% to compensate for weaker signal)
  const minTimeIntoWindowPct = 0.05 // skip first 5% of window (early noise)
  let cooldownUntil = 0

  const windowStartMs = new Date(market.start_time).getTime()
  const windowEndMs = new Date(market.end_time).getTime()
  const windowDurationMs = windowEndMs - windowStartMs

  for (let i = 5; i < snapshots.length; i++) {
    const snap = snapshots[i]
    const snapTime = new Date(snap.time).getTime()
    if (snapTime < cooldownUntil) continue

    // Early window filter: skip the initial noise period
    const timeIntoPct = (snapTime - windowStartMs) / windowDurationMs
    if (timeIntoPct < minTimeIntoWindowPct) continue

    const signal = computeSignal(snapshots, i)
    if (signal.confidence < minConfidence) continue

    const entryPrice = signal.direction === 'up' ? snap.price_up : snap.price_down
    if (entryPrice > maxEntryPrice) continue

    // Edge gate: confidence must exceed entry price + edge margin
    if (signal.confidence <= entryPrice + minEdgeOverMarket) continue

    // Resolution hold — P&L depends on winner
    const won = market.winner === signal.direction
    const payout = won ? 1.0 : 0.0
    const pnl = payout - entryPrice // 0% maker fee

    trades.push({
      timestamp: snap.time,
      strategy: 'btc-updown',
      direction: signal.direction,
      entryPrice,
      exitPrice: payout,
      pnl,
      feePaid: 0,
      holdTimeMs: windowEndMs - snapTime,
      metadata: { confidence: signal.confidence, btcPrice: snap.btc_price, edge: signal.confidence - entryPrice },
    })

    cooldownUntil = snapTime + 60_000
  }

  return trades
}

// --- Dual-Side Hedge ---
// Matches live v66: tighter maxCombinedAsk, $1.50/leg, higher confidence
function runDualSide(market: MarketInfo, snapshots: Snapshot[]): Trade[] {
  const trades: Trade[] = []
  const minConfidence = 0.38       // calibrated for simplified 5-factor engine
  const tradeSize = 1.50           // live v66 $1.50/leg = $3.00 total
  const biasRatio = 0.70
  let cooldownUntil = 0

  for (let i = 5; i < snapshots.length; i++) {
    const snap = snapshots[i]
    const snapTime = new Date(snap.time).getTime()
    if (snapTime < cooldownUntil) continue

    const signal = computeSignal(snapshots, i)
    if (signal.confidence < minConfidence) continue

    const askSum = snap.price_up + snap.price_down
    if (askSum > 0.990) continue // live v66: tighter guaranteed-profit gate

    // 70/30 bias toward signal direction
    const favSide = signal.direction
    const favPrice = favSide === 'up' ? snap.price_up : snap.price_down
    const unfavPrice = favSide === 'up' ? snap.price_down : snap.price_up

    const favQty = (tradeSize * biasRatio) / favPrice
    const unfavQty = (tradeSize * (1 - biasRatio)) / unfavPrice
    const totalCost = tradeSize

    // Merge profit from min(qtyUp, qtyDown) pairs
    const mergeableQty = Math.min(favQty, unfavQty)
    const mergePayout = mergeableQty * 1.0
    // Leftover resolved at market outcome
    const leftoverQty = Math.abs(favQty - unfavQty)
    const leftoverWon = market.winner === favSide
    const leftoverPayout = leftoverWon ? leftoverQty * 1.0 : 0

    const pnl = (mergePayout + leftoverPayout) - totalCost

    trades.push({
      timestamp: snap.time,
      strategy: 'dual-side',
      direction: `${favSide}-biased`,
      entryPrice: totalCost,
      exitPrice: mergePayout + leftoverPayout,
      pnl,
      feePaid: 0,
      holdTimeMs: new Date(market.end_time).getTime() - snapTime,
    })

    cooldownUntil = snapTime + 30_000
  }

  return trades
}

// --- Gabagool Accumulator ---
// Matches live GabagoolStrategy: imbalance cap, accumulation cutoff, resolution fees
function runGabagool(market: MarketInfo, snapshots: Snapshot[]): Trade[] {
  const trades: Trade[] = []
  const cheapThreshold = 0.46       // live v66 setting
  const orderSize = 1.50            // live v66 setting
  const maxExposure = 5             // live v66 $5 per window
  const maxImbalanceRatio = 0.20    // 20% qty imbalance cap (live setting)
  const minProfitMargin = 0.96      // pair cost < 96c (live v66: 4% profit target)
  const cooldownMs = 3_000
  const is15m = market.market_type === '15m'
  // Accumulation cutoff: stop buying with < 5min (1h) or < 1min (15m) remaining
  const cutoffMs = is15m ? 60_000 : 300_000
  const resolutionFeeRate = is15m ? 0.10 : 0.0  // 15m crypto = 10% fee on resolution

  let qtyUp = 0, qtyDown = 0, costUp = 0, costDown = 0
  let cooldownUntil = 0
  const windowEndMs = new Date(market.end_time).getTime()

  for (const snap of snapshots) {
    const snapTime = new Date(snap.time).getTime()
    if (snapTime < cooldownUntil) continue

    // Accumulation cutoff: stop buying near window end
    if (windowEndMs - snapTime < cutoffMs) break

    const totalCost = costUp + costDown
    if (totalCost >= maxExposure) continue

    // Determine which side to buy (respecting imbalance cap)
    const side = selectGabagoolSide(qtyUp, qtyDown, snap.price_up, snap.price_down, cheapThreshold, maxImbalanceRatio)
    if (!side) continue

    const price = side === 'up' ? snap.price_up : snap.price_down
    const qty = orderSize / price

    if (side === 'up') {
      qtyUp += qty
      costUp += orderSize
    } else {
      qtyDown += qty
      costDown += orderSize
    }
    cooldownUntil = snapTime + cooldownMs

    // Check merge opportunity: pair cost must be below threshold
    const mergeableQty = Math.min(qtyUp, qtyDown)
    if (mergeableQty > 0) {
      // Per-share pair cost = (costUp/qtyUp + costDown/qtyDown)
      const avgCostUp = qtyUp > 0 ? costUp / qtyUp : 0
      const avgCostDown = qtyDown > 0 ? costDown / qtyDown : 0
      const pairCost = avgCostUp + avgCostDown
      if (pairCost <= minProfitMargin) {
        const mergeValue = mergeableQty * 1.0
        const mergeTotalCost = mergeableQty * pairCost
        const pnl = mergeValue - mergeTotalCost

        trades.push({
          timestamp: snap.time,
          strategy: 'gabagool',
          direction: 'merge',
          entryPrice: mergeTotalCost,
          exitPrice: mergeValue,
          pnl,
          feePaid: 0,
          holdTimeMs: snapTime - new Date(snapshots[0].time).getTime(),
          metadata: { pairCost, qtyUp, qtyDown, merged: mergeableQty },
        })

        // Subtract merged quantity proportionally
        qtyUp -= mergeableQty
        qtyDown -= mergeableQty
        costUp = qtyUp > 0 ? costUp * (qtyUp / (qtyUp + mergeableQty)) : 0
        costDown = qtyDown > 0 ? costDown * (qtyDown / (qtyDown + mergeableQty)) : 0
      }
    }
  }

  // End-of-window: resolve orphaned positions (with fee on 15m markets)
  if (qtyUp > 0 || qtyDown > 0) {
    const totalCost = costUp + costDown
    const wonUp = market.winner === 'up'
    const winningQty = wonUp ? qtyUp : qtyDown
    const payout = winningQty * (1.0 - resolutionFeeRate)
    const pnl = payout - totalCost
    const fee = winningQty * resolutionFeeRate
    if (totalCost > 0) {
      trades.push({
        timestamp: market.end_time,
        strategy: 'gabagool',
        direction: 'resolve-orphan',
        entryPrice: totalCost,
        exitPrice: payout,
        pnl,
        feePaid: fee,
        holdTimeMs: 0,
        metadata: { winner: market.winner, orphanedUp: qtyUp, orphanedDown: qtyDown },
      })
    }
  }

  return trades
}

function selectGabagoolSide(
  qtyUp: number, qtyDown: number,
  priceUp: number, priceDown: number,
  cheapThreshold: number, maxImbalanceRatio: number,
): 'up' | 'down' | null {
  const upCheap = priceUp <= cheapThreshold
  const downCheap = priceDown <= cheapThreshold
  if (!upCheap && !downCheap) return null

  // Imbalance check: if one side is >maxImbalanceRatio ahead, only buy the lagging side
  const totalQty = qtyUp + qtyDown
  if (totalQty > 0) {
    const upRatio = qtyUp / totalQty
    const downRatio = qtyDown / totalQty
    if (upRatio > 0.5 + maxImbalanceRatio / 2) {
      return downCheap ? 'down' : null  // Up is too heavy, only buy down
    }
    if (downRatio > 0.5 + maxImbalanceRatio / 2) {
      return upCheap ? 'up' : null      // Down is too heavy, only buy up
    }
  }

  // Both cheap → buy cheaper
  if (upCheap && downCheap) return priceUp <= priceDown ? 'up' : 'down'

  // Only one side cheap — only buy if ask sum < 1.00 (other side is at least
  // plausibly fillable for merge). Without this, we build one-sided exposure
  // that resolves as a 50/50 directional bet — not what Gabagool is for.
  const askSum = priceUp + priceDown
  if (askSum >= 1.00) return null  // No merge arb edge at these prices
  return upCheap ? 'up' : 'down'
}

// --- Impulse Sniper ---
function runImpulseSniper(market: MarketInfo, snapshots: Snapshot[]): Trade[] {
  const trades: Trade[] = []
  const impulseThreshold = 200 // $200 BTC move
  const staleThreshold = 0.03
  const takerFeeBps = 100 // 1h markets
  const lookback = 5
  let cooldownUntil = 0

  for (let i = lookback; i < snapshots.length; i++) {
    const snap = snapshots[i]
    const snapTime = new Date(snap.time).getTime()
    if (snapTime < cooldownUntil) continue

    const baseSnap = snapshots[i - lookback]
    const btcMove = Math.abs(snap.btc_price - baseSnap.btc_price)
    if (btcMove < impulseThreshold) continue

    // Check if odds are stale
    const upMove = Math.abs(snap.price_up - baseSnap.price_up)
    const downMove = Math.abs(snap.price_down - baseSnap.price_down)
    if (upMove > staleThreshold || downMove > staleThreshold) continue // Already repriced

    // Trade in impulse direction
    const direction = snap.btc_price > baseSnap.btc_price ? 'up' : 'down'
    const entryPrice = direction === 'up' ? snap.price_up : snap.price_down
    const fee = entryPrice * (takerFeeBps / 10_000)

    const won = market.winner === direction
    const payout = won ? 1.0 : 0.0
    const pnl = payout - entryPrice - fee

    trades.push({
      timestamp: snap.time,
      strategy: 'impulse-sniper',
      direction,
      entryPrice,
      exitPrice: payout,
      pnl,
      feePaid: fee,
      holdTimeMs: new Date(market.end_time).getTime() - snapTime,
      metadata: { btcMove, oddsMove: Math.max(upMove, downMove) },
    })

    cooldownUntil = snapTime + 30_000
  }

  return trades
}

// --- LLM Prediction (Monte Carlo baseline) ---
function runLLMBaseline(numTrades: number = 200): Trade[] {
  const trades: Trade[] = []
  const winRate = 0.52
  const tradeSize = 1.0
  const avgEntry = 0.50
  // Seeded PRNG (Mulberry32)
  let seed = 42
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const now = Date.now()
  for (let i = 0; i < numTrades; i++) {
    const won = rand() < winRate
    const payout = won ? tradeSize : 0
    const pnl = payout - (tradeSize * avgEntry)
    trades.push({
      timestamp: new Date(now - (numTrades - i) * 3600_000).toISOString(),
      strategy: 'llm-prediction',
      direction: rand() > 0.5 ? 'up' : 'down',
      entryPrice: tradeSize * avgEntry,
      exitPrice: payout,
      pnl,
      feePaid: 0,
      holdTimeMs: 3600_000,
    })
  }

  return trades
}

// ─── Summary Engine ──────────────────────────────────────

function computeSummary(trades: Trade[]): Summary {
  if (trades.length === 0) {
    return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0, avgHoldTimeMs: 0, maxDrawdown: 0, sharpeRatio: null, profitFactor: null }
  }

  const wins = trades.filter(t => t.pnl > 0).length
  const losses = trades.filter(t => t.pnl < 0).length
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
  const avgPnl = totalPnl / trades.length
  const avgHoldTimeMs = trades.reduce((s, t) => s + t.holdTimeMs, 0) / trades.length

  let peak = 0, maxDrawdown = 0, cumPnl = 0
  for (const t of trades) {
    cumPnl += t.pnl
    if (cumPnl > peak) peak = cumPnl
    const dd = peak - cumPnl
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  let sharpeRatio: number | null = null
  if (trades.length >= 5) {
    const pnls = trades.map(t => t.pnl)
    const mean = pnls.reduce((s, p) => s + p, 0) / pnls.length
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length
    const stdDev = Math.sqrt(variance)
    if (stdDev > 0) sharpeRatio = (mean / stdDev) * Math.sqrt(35_000)
  }

  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0))
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null

  return { totalTrades: trades.length, wins, losses, winRate: wins / trades.length, totalPnl, avgPnl, avgHoldTimeMs, maxDrawdown, sharpeRatio, profitFactor }
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n
  let cov = 0, varA = 0, varB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB
    cov += da * db; varA += da * da; varB += db * db
  }
  const denom = Math.sqrt(varA * varB)
  return denom > 0 ? cov / denom : 0
}

// ─── Display ─────────────────────────────────────────────

function formatDollars(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}$${n.toFixed(2)}`
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function printResults(results: StrategyResult[], combined: Summary, correlationMatrix: Record<string, Record<string, number>>): void {
  console.log('\n' + '='.repeat(80))
  console.log('  BACKTEST RESULTS')
  console.log('='.repeat(80))

  // Per-strategy table
  const header = ['Strategy', 'Trades', 'Win Rate', 'Total P&L', 'Avg P&L', 'Max DD', 'Sharpe', 'PF']
  const colWidths = [20, 8, 10, 12, 10, 10, 8, 8]

  console.log('\n' + header.map((h, i) => h.padEnd(colWidths[i])).join(''))
  console.log('-'.repeat(colWidths.reduce((a, b) => a + b, 0)))

  for (const r of results) {
    const s = r.summary
    const row = [
      r.strategyName.slice(0, 19),
      String(s.totalTrades),
      s.totalTrades > 0 ? formatPct(s.winRate) : '-',
      s.totalTrades > 0 ? formatDollars(s.totalPnl) : '-',
      s.totalTrades > 0 ? formatDollars(s.avgPnl) : '-',
      s.totalTrades > 0 ? formatDollars(s.maxDrawdown) : '-',
      s.sharpeRatio != null ? s.sharpeRatio.toFixed(2) : '-',
      s.profitFactor != null ? s.profitFactor.toFixed(2) : '-',
    ]
    console.log(row.map((v, i) => v.padEnd(colWidths[i])).join(''))
  }

  // Combined
  console.log('-'.repeat(colWidths.reduce((a, b) => a + b, 0)))
  const c = combined
  const combinedRow = [
    'COMBINED',
    String(c.totalTrades),
    c.totalTrades > 0 ? formatPct(c.winRate) : '-',
    c.totalTrades > 0 ? formatDollars(c.totalPnl) : '-',
    c.totalTrades > 0 ? formatDollars(c.avgPnl) : '-',
    c.totalTrades > 0 ? formatDollars(c.maxDrawdown) : '-',
    c.sharpeRatio != null ? c.sharpeRatio.toFixed(2) : '-',
    c.profitFactor != null ? c.profitFactor.toFixed(2) : '-',
  ]
  console.log(combinedRow.map((v, i) => v.padEnd(colWidths[i])).join(''))

  // Correlation matrix
  if (results.length > 1) {
    console.log('\n  CORRELATION MATRIX')
    console.log('-'.repeat(40))
    const names = results.map(r => r.strategy)
    const shortNames = results.map(r => r.strategy.slice(0, 8))
    console.log('          ' + shortNames.map(n => n.padEnd(10)).join(''))
    for (let i = 0; i < names.length; i++) {
      const row = shortNames[i].padEnd(10) + names.map((_, j) => {
        const val = correlationMatrix[names[i]]?.[names[j]] ?? 0
        return val.toFixed(2).padEnd(10)
      }).join('')
      console.log(row)
    }
  }

  console.log('\n' + '='.repeat(80) + '\n')
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs()
  if (args.help) { printHelp(); return }

  console.log(`\nAlphaPolyBot CLI Backtest`)
  console.log(`  Strategies: ${args.strategies.join(', ')}`)
  console.log(`  Market type: ${args.marketType}`)
  console.log(`  Max markets: ${args.maxMarkets}`)
  console.log()

  const strategyResults: StrategyResult[] = []
  const btcStrategies = args.strategies.filter(s => s !== 'llm-prediction')

  // ── Fetch market data & run BTC strategies ──
  if (btcStrategies.length > 0) {
    console.log('Discovering resolved markets...')
    const markets = await discoverMarkets(args.marketType, args.maxMarkets, args.verbose)
    console.log(`  Found ${markets.length} resolved ${args.marketType} markets\n`)

    if (markets.length === 0) {
      console.error('No resolved markets found. Try a different --market-type or increase --max-markets.')
      process.exit(1)
    }

    // Accumulate trades per strategy
    const tradesByStrategy: Record<string, Trade[]> = {}
    for (const s of btcStrategies) tradesByStrategy[s] = []

    for (let i = 0; i < markets.length; i++) {
      const market = markets[i]
      const label = `[${i + 1}/${markets.length}] ${market.slug.slice(0, 40)}`
      if (args.verbose) console.log(`  ${label}`)
      else process.stdout.write(`\r  Processing market ${i + 1}/${markets.length}...`)

      const snapshots = await fetchSnapshots(market)
      if (snapshots.length === 0) {
        if (args.verbose) console.log(`    -> 0 snapshots, skipping`)
        continue
      }
      if (args.verbose) console.log(`    -> ${snapshots.length} snapshots`)

      if (btcStrategies.includes('btc-updown'))
        tradesByStrategy['btc-updown'].push(...runBtcUpDown(market, snapshots))
      if (btcStrategies.includes('dual-side'))
        tradesByStrategy['dual-side'].push(...runDualSide(market, snapshots))
      if (btcStrategies.includes('gabagool'))
        tradesByStrategy['gabagool'].push(...runGabagool(market, snapshots))
      if (btcStrategies.includes('impulse-sniper'))
        tradesByStrategy['impulse-sniper'].push(...runImpulseSniper(market, snapshots))
    }

    if (!args.verbose) console.log() // Clear the \r line

    const nameMap: Record<string, string> = {
      'btc-updown': 'Crypto Up/Down',
      'dual-side': 'Dual-Side Hedge',
      'gabagool': 'Gabagool Accum.',
      'impulse-sniper': 'Impulse Sniper',
    }

    for (const s of btcStrategies) {
      strategyResults.push({
        strategy: s,
        strategyName: nameMap[s] || s,
        trades: tradesByStrategy[s],
        summary: computeSummary(tradesByStrategy[s]),
        dataSource: 'free-api',
      })
    }
  }

  // ── LLM baseline ──
  if (args.strategies.includes('llm-prediction')) {
    const llmTrades = runLLMBaseline(200)
    strategyResults.push({
      strategy: 'llm-prediction',
      strategyName: 'LLM Baseline',
      trades: llmTrades,
      summary: computeSummary(llmTrades),
      dataSource: 'monte-carlo',
    })
  }

  // ── Correlation matrix ──
  const correlationMatrix: Record<string, Record<string, number>> = {}
  for (const a of strategyResults) {
    correlationMatrix[a.strategy] = {}
    for (const b of strategyResults) {
      if (a.strategy === b.strategy) {
        correlationMatrix[a.strategy][b.strategy] = 1.0
      } else {
        correlationMatrix[a.strategy][b.strategy] = pearsonCorrelation(
          a.trades.map(t => t.pnl),
          b.trades.map(t => t.pnl),
        )
      }
    }
  }

  // ── Combined summary ──
  const allTrades = strategyResults.flatMap(r => r.trades)
  allTrades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  const combined = computeSummary(allTrades)

  // ── Display ──
  printResults(strategyResults, combined, correlationMatrix)

  // ── Write JSON ──
  if (args.output) {
    const outputPath = resolve(process.cwd(), args.output)
    const jsonResult = {
      strategies: strategyResults,
      combined,
      correlationMatrix,
      runTimestamp: new Date().toISOString(),
      config: {
        strategies: args.strategies,
        marketType: args.marketType,
        maxMarkets: args.maxMarkets,
      },
    }
    writeFileSync(outputPath, JSON.stringify(jsonResult, null, 2))
    console.log(`Results written to ${outputPath}`)
  }
}

main().catch(err => {
  console.error('Backtest failed:', err)
  process.exit(1)
})
