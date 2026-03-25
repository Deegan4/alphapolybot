/**
 * FreeDataAdapter — synthesize PolyBacktestMarket + PolyBacktestSnapshot data
 * from free APIs (Gamma, CLOB prices-history, Binance klines).
 *
 * Drop-in replacement for PolyBacktestClient when no paid API key is available.
 * The existing BacktestOrchestrator and per-strategy runners consume the same
 * PolyBacktestMarket / PolyBacktestSnapshot shapes — this adapter produces them.
 *
 * Trade-offs vs PolyBacktest API:
 *   - No orderbook depth (orderbook_up/orderbook_down = null)
 *   - Lower time resolution (~1min fidelity vs PolyBacktest's per-snapshot)
 *   - Gamma only returns ~100 closed markets per page (pagination required)
 *   - Binance klines have 1m minimum granularity
 */
import { gammaClient } from '../api/GammaClient'
import { clobClient } from '../api/CLOBClient'
import type {
  PolyBacktestMarket,
  PolyBacktestMarketType,
  PolyBacktestSnapshot,
  Market,
} from '@/types'

// ==========================================
// BINANCE KLINE FETCHER (free, no auth)
// ==========================================

interface BinanceKline {
  openTime: number
  close: number
}

const BINANCE_BASE = import.meta.env.DEV ? '/api/binance' : 'https://api.binance.com'

async function fetchBinanceKlines(
  symbol: string,
  intervalMinutes: number,
  startMs: number,
  endMs: number,
  signal?: AbortSignal,
): Promise<BinanceKline[]> {
  // Binance kline intervals: 1m, 3m, 5m, 15m, 1h
  const interval = intervalMinutes <= 1 ? '1m'
    : intervalMinutes <= 3 ? '3m'
    : intervalMinutes <= 5 ? '5m'
    : intervalMinutes <= 15 ? '15m'
    : '1h'

  const klines: BinanceKline[] = []
  let cursor = startMs

  // Binance returns max 1000 candles per request — paginate
  while (cursor < endMs) {
    signal?.throwIfAborted()
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`Binance klines ${res.status}: ${res.statusText}`)
    const data: unknown[][] = await res.json()
    if (data.length === 0) break

    for (const candle of data) {
      klines.push({
        openTime: candle[0] as number,
        close: parseFloat(candle[4] as string),
      })
    }

    // Move cursor past last candle
    cursor = (data[data.length - 1][0] as number) + 1
    if (data.length < 1000) break // No more data
  }

  return klines
}

// ==========================================
// MARKET TYPE HELPERS
// ==========================================

const WINDOW_DURATION_MS: Record<PolyBacktestMarketType, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1hr': 60 * 60 * 1000,
  '4hr': 4 * 60 * 60 * 1000,
  '24hr': 24 * 60 * 60 * 1000,
}

/** Slug prefix patterns for each market type. */
const SLUG_PATTERNS: Record<PolyBacktestMarketType, string[]> = {
  '5m': ['btc-updown-5m-', 'eth-updown-5m-', 'sol-updown-5m-'],
  '15m': ['btc-updown-15m-', 'eth-updown-15m-', 'sol-updown-15m-'],
  '1hr': ['bitcoin-up-or-down-', 'ethereum-up-or-down-'],
  '4hr': ['btc-updown-4h-', 'eth-updown-4h-'],
  '24hr': ['bitcoin-up-or-down-'],
}

// ==========================================
// FREE DATA ADAPTER
// ==========================================

export class FreeDataAdapter {
  /**
   * Discover resolved Crypto Up/Down markets via Gamma API (free).
   * Returns markets converted to PolyBacktestMarket shape.
   */
  async getResolvedMarkets(
    marketType: PolyBacktestMarketType,
    maxMarkets: number,
    signal?: AbortSignal,
  ): Promise<PolyBacktestMarket[]> {
    const slugPrefixes = SLUG_PATTERNS[marketType] || SLUG_PATTERNS['15m']
    const results: PolyBacktestMarket[] = []

    // Fetch closed markets from Gamma — paginate until we have enough
    let offset = 0
    const pageSize = 100

    while (results.length < maxMarkets) {
      signal?.throwIfAborted()

      let markets: Market[]
      try {
        markets = await gammaClient.getMarkets({
          active: false,
          closed: true,
          limit: pageSize,
          offset,
        })
      } catch {
        break // API error — return what we have
      }

      if (markets.length === 0) break

      for (const market of markets) {
        if (results.length >= maxMarkets) break

        // Match BTC up/down markets by slug pattern
        const matchesType = slugPrefixes.some(prefix =>
          market.slug?.toLowerCase().startsWith(prefix)
        )
        if (!matchesType) continue

        // Need exactly 2 outcomes with CLOB token IDs
        if (
          !market.clobTokenIds ||
          market.clobTokenIds.length < 2 ||
          market.outcomes.length < 2
        ) continue

        // Determine winner from outcome prices (resolved: winning = ~1.00)
        const winner = this.inferWinner(market)

        const converted = this.toPolyBacktestMarket(market, marketType, winner)
        if (converted) results.push(converted)
      }

      offset += pageSize
      // Safety: don't paginate forever
      if (offset > 2000) break
    }

    return results
  }

  /**
   * Fetch snapshots for a market using free APIs.
   * Combines CLOB price history (outcome prices) with Binance klines (BTC prices).
   */
  async getSnapshots(
    market: PolyBacktestMarket,
    signal?: AbortSignal,
  ): Promise<PolyBacktestSnapshot[]> {
    if (!market.clob_token_up || !market.clob_token_down) return []

    const startMs = new Date(market.start_time).getTime()
    const endMs = new Date(market.end_time).getTime()
    const windowMs = endMs - startMs

    // Choose fidelity: ~60 snapshots per market
    const fidelityMinutes = Math.max(1, Math.floor(windowMs / (60 * 60_000)))
    const fidelity = fidelityMinutes * 60 // seconds

    // Fetch all three data sources in parallel
    const [upPrices, downPrices, btcKlines] = await Promise.all([
      this.fetchClobPrices(market.clob_token_up, startMs, endMs, fidelity, signal),
      this.fetchClobPrices(market.clob_token_down, startMs, endMs, fidelity, signal),
      fetchBinanceKlines('BTCUSDT', fidelityMinutes, startMs, endMs, signal),
    ])

    if (upPrices.length === 0 || downPrices.length === 0) return []

    // Merge into snapshots: align by timestamp
    return this.mergeIntoSnapshots(market.market_id, upPrices, downPrices, btcKlines)
  }

  // ==========================================
  // PRIVATE HELPERS
  // ==========================================

  private inferWinner(market: Market): 'up' | 'down' | null {
    if (market.outcomePrices.length < 2) return null
    const p0 = market.outcomePrices[0]
    const p1 = market.outcomePrices[1]

    // Resolved markets have ~1.00 for winner, ~0.00 for loser
    if (p0 > 0.9) return this.isUpOutcome(market.outcomes[0]) ? 'up' : 'down'
    if (p1 > 0.9) return this.isUpOutcome(market.outcomes[1]) ? 'up' : 'down'
    return null // Not clearly resolved
  }

  private isUpOutcome(outcome: string): boolean {
    const lower = outcome.toLowerCase()
    return lower === 'up' || lower === 'yes' || lower.includes('up')
  }

  private toPolyBacktestMarket(
    market: Market,
    marketType: PolyBacktestMarketType,
    winner: 'up' | 'down' | null,
  ): PolyBacktestMarket | null {
    if (!market.clobTokenIds || market.clobTokenIds.length < 2) return null

    // Determine which token is Up vs Down
    const upIdx = market.outcomes.findIndex(o => this.isUpOutcome(o))
    const downIdx = upIdx === 0 ? 1 : 0

    const windowMs = WINDOW_DURATION_MS[marketType]
    const endMs = new Date(market.endDate).getTime()
    const startMs = endMs - windowMs

    return {
      market_id: market.id,
      event_id: market.eventSlug ?? market.slug,
      slug: market.slug,
      market_type: marketType,
      start_time: new Date(startMs).toISOString(),
      end_time: market.endDate,
      btc_price_start: null, // Filled in from Binance data later
      btc_price_end: null,
      condition_id: market.conditionId ?? null,
      clob_token_up: market.clobTokenIds[upIdx] ?? null,
      clob_token_down: market.clobTokenIds[downIdx] ?? null,
      winner,
      final_volume: market.volume ?? null,
      final_liquidity: market.liquidity ?? null,
      resolved_at: market.endDate ?? null,
      created_at: market.createdAt ?? null,
      updated_at: market.updatedAt ?? null,
    }
  }

  private async fetchClobPrices(
    tokenId: string,
    startMs: number,
    endMs: number,
    fidelity: number,
    signal?: AbortSignal,
  ): Promise<Array<{ t: number; p: number }>> {
    signal?.throwIfAborted()
    try {
      const history = await clobClient.getPricesHistory(tokenId, {
        interval: 'max',
        startTs: Math.floor(startMs / 1000),
        endTs: Math.floor(endMs / 1000),
        fidelity,
      })
      return history.map(pt => ({
        t: pt.t * 1000, // Convert to ms
        p: pt.p,
      }))
    } catch {
      return []
    }
  }

  private mergeIntoSnapshots(
    marketId: string,
    upPrices: Array<{ t: number; p: number }>,
    downPrices: Array<{ t: number; p: number }>,
    btcKlines: BinanceKline[],
  ): PolyBacktestSnapshot[] {
    // Build lookup maps for fast interpolation
    const downMap = new Map(downPrices.map(d => [d.t, d.p]))
    const btcMap = new Map(btcKlines.map(k => [k.openTime, k.close]))

    // Use up-prices as the timestamp backbone
    const snapshots: PolyBacktestSnapshot[] = []
    let snapshotIdx = 0

    for (const up of upPrices) {
      // Find closest down price
      const downPrice = downMap.get(up.t) ?? this.interpolate(downPrices, up.t)
      if (downPrice == null) continue

      // Find closest BTC price
      const btcPrice = btcMap.get(up.t) ?? this.interpolateBtc(btcKlines, up.t)
      if (btcPrice == null) continue

      snapshots.push({
        id: `free-${marketId}-${snapshotIdx++}`,
        time: new Date(up.t).toISOString(),
        market_id: marketId,
        btc_price: btcPrice,
        price_up: up.p,
        price_down: downPrice,
        orderbook_up: null,   // Not available from free APIs
        orderbook_down: null,
      })
    }

    return snapshots
  }

  /** Find nearest value by timestamp from a sorted array */
  private interpolate(
    data: Array<{ t: number; p: number }>,
    targetMs: number,
  ): number | null {
    if (data.length === 0) return null
    let best = data[0]
    let bestDist = Math.abs(data[0].t - targetMs)
    for (const d of data) {
      const dist = Math.abs(d.t - targetMs)
      if (dist < bestDist) {
        best = d
        bestDist = dist
      }
      // Data is roughly sorted — if we're moving away, break early
      if (d.t > targetMs && dist > bestDist) break
    }
    // Only interpolate within 5 minutes
    return bestDist < 5 * 60_000 ? best.p : null
  }

  private interpolateBtc(
    klines: BinanceKline[],
    targetMs: number,
  ): number | null {
    if (klines.length === 0) return null
    let best = klines[0]
    let bestDist = Math.abs(klines[0].openTime - targetMs)
    for (const k of klines) {
      const dist = Math.abs(k.openTime - targetMs)
      if (dist < bestDist) {
        best = k
        bestDist = dist
      }
      if (k.openTime > targetMs && dist > bestDist) break
    }
    return bestDist < 5 * 60_000 ? best.close : null
  }
}

export const freeDataAdapter = new FreeDataAdapter()
