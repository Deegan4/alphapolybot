/**
 * HistoricalEnrichment — cache-backed historical statistics from PolyBacktest.
 *
 * Provides win rates (overall, by time-of-day, by day-of-week) and average
 * spreads from resolved markets. Used by the live BTC Up/Down strategy to
 * make small, conservative confidence adjustments based on historical patterns.
 */
import { polyBacktestClient } from '@/services/api/PolyBacktestClient'
import type {
  BacktestEnrichment,
  PolyBacktestMarket,
  PolyBacktestMarketType,
} from '@/types'

interface CacheEntry {
  data: BacktestEnrichment
  expiresAt: number
}

const CACHE_TTL = 30 * 60 * 1000 // 30 minutes

export class HistoricalEnrichment {
  private cache = new Map<string, CacheEntry>()

  /**
   * Get historical enrichment data for a market type + optional time pattern.
   * Results are cached for 30 minutes.
   */
  async getEnrichment(
    marketType: PolyBacktestMarketType,
    hour?: number,
    dayOfWeek?: number,
  ): Promise<BacktestEnrichment> {
    const cacheKey = `${marketType}_${hour ?? 'x'}_${dayOfWeek ?? 'x'}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    const enrichment = await this.compute(marketType, hour, dayOfWeek)
    this.cache.set(cacheKey, { data: enrichment, expiresAt: Date.now() + CACHE_TTL })
    return enrichment
  }

  /** Clear all cached data. */
  clearCache(): void {
    this.cache.clear()
  }

  private async compute(
    marketType: PolyBacktestMarketType,
    hour?: number,
    dayOfWeek?: number,
  ): Promise<BacktestEnrichment> {
    try {
      const markets = await polyBacktestClient.getResolvedMarkets(marketType)

      if (markets.length === 0) {
        return this.emptyEnrichment()
      }

      // Overall win rate (outcome = "up" won)
      const winRate = this.computeWinRate(markets)

      // Time-of-day win rate
      const todMarkets = hour !== undefined
        ? markets.filter(m => new Date(m.start_time).getUTCHours() === hour)
        : []
      const timeOfDayWinRate = todMarkets.length >= 5
        ? this.computeWinRate(todMarkets)
        : null

      // Day-of-week win rate
      const dowMarkets = dayOfWeek !== undefined
        ? markets.filter(m => new Date(m.start_time).getUTCDay() === dayOfWeek)
        : []
      const dayOfWeekWinRate = dowMarkets.length >= 5
        ? this.computeWinRate(dowMarkets)
        : null

      // Average spread from a sample of recent markets
      const avgSpread = await this.computeAvgSpread(markets.slice(0, 20))

      return {
        historicalWinRate: winRate,
        avgSpread,
        sampleSize: markets.length,
        timeOfDayWinRate,
        dayOfWeekWinRate,
      }
    } catch (err) {
      console.warn('[HistoricalEnrichment] Failed to compute enrichment:', err)
      return this.emptyEnrichment()
    }
  }

  /**
   * Win rate = fraction of markets where "up" won.
   * For BTC Up/Down, the "correct" direction depends on BTC price movement,
   * but we track the base rate of "up" outcomes to detect biases.
   */
  private computeWinRate(markets: PolyBacktestMarket[]): number {
    const resolved = markets.filter(m => m.winner !== null)
    if (resolved.length === 0) return 0.5
    const upWins = resolved.filter(m => m.winner === 'up').length
    return upWins / resolved.length
  }

  /**
   * Compute average bid-ask spread from snapshot orderbooks.
   * Samples the midpoint snapshot from a subset of markets.
   */
  private async computeAvgSpread(markets: PolyBacktestMarket[]): Promise<number> {
    const spreads: number[] = []

    for (const market of markets.slice(0, 10)) {
      try {
        // Get a snapshot from the middle of the market window
        const midTime = new Date(
          (new Date(market.start_time).getTime() + new Date(market.end_time).getTime()) / 2,
        ).toISOString()

        const snapshot = await polyBacktestClient.getSnapshotAt(market.market_id, midTime)
        if (snapshot?.orderbook_up?.bids?.length && snapshot.orderbook_up.asks?.length) {
          const bestBid = snapshot.orderbook_up.bids[0].price
          const bestAsk = snapshot.orderbook_up.asks[0].price
          if (bestAsk > bestBid) {
            spreads.push(bestAsk - bestBid)
          }
        }
      } catch {
        // Skip this market
      }
    }

    if (spreads.length === 0) return 0
    return spreads.reduce((s, v) => s + v, 0) / spreads.length
  }

  private emptyEnrichment(): BacktestEnrichment {
    return {
      historicalWinRate: 0.5,
      avgSpread: 0,
      sampleSize: 0,
      timeOfDayWinRate: null,
      dayOfWeekWinRate: null,
    }
  }
}

export const historicalEnrichment = new HistoricalEnrichment()
