import type { Market } from '@/types'
import type { MarketGroup } from './types'
import { polymarketClient } from '@/services/api'

/**
 * EventAnalyzer
 * Groups Polymarket markets by event for cross-market dependency analysis.
 * Events naturally group related markets (e.g., "2024 Pennsylvania Election"
 * contains candidate-specific markets that are mutually exclusive).
 *
 * Zero LLM cost — uses Gamma API event data structure.
 */
export class EventAnalyzer {
  private groupCache: Map<string, MarketGroup> = new Map()
  private lastFetchAt = 0
  private cacheTTL: number

  constructor(cacheTTL = 60_000) {
    this.cacheTTL = cacheTTL
  }

  /**
   * Fetch all events and build MarketGroups from those with 2+ active markets.
   * Uses cache to avoid hammering the API.
   */
  async getMarketGroups(): Promise<MarketGroup[]> {
    if (Date.now() - this.lastFetchAt < this.cacheTTL && this.groupCache.size > 0) {
      return Array.from(this.groupCache.values())
    }

    const events = await polymarketClient.getEvents({ active: true, limit: 100 })
    const groups: MarketGroup[] = []

    for (const event of events) {
      // Gamma events have markets array directly
      const active = (event.markets || []).filter(m => m.active && !m.closed)
      if (active.length < 2) continue

      const totalLiquidity = active.reduce((sum, m) => sum + m.liquidity, 0)

      const group: MarketGroup = {
        eventId: String(event.id),
        eventTitle: event.title,
        markets: active,
        totalLiquidity,
        activeCount: active.length,
      }

      groups.push(group)
      this.groupCache.set(String(event.id), group)
    }

    this.lastFetchAt = Date.now()
    return groups
  }

  /**
   * Filter groups to those worth analyzing for cross-market dependencies.
   */
  filterCandidates(
    groups: MarketGroup[],
    minLiquidity = 10_000,
    minMarkets = 2,
  ): MarketGroup[] {
    return groups.filter(
      g => g.totalLiquidity >= minLiquidity && g.activeCount >= minMarkets,
    )
  }

  /**
   * Find which event a given market belongs to.
   * Returns the MarketGroup or undefined if the market isn't in any cached group.
   */
  findGroupForMarket(marketId: string): MarketGroup | undefined {
    for (const group of this.groupCache.values()) {
      if (group.markets.some(m => m.id === marketId)) {
        return group
      }
    }
    return undefined
  }

  /**
   * Generate all unique pairwise combinations of markets in a group.
   * For a group of k markets, returns k*(k-1)/2 pairs.
   */
  generatePairs(group: MarketGroup): Array<{ marketA: Market; marketB: Market }> {
    const pairs: Array<{ marketA: Market; marketB: Market }> = []
    const { markets } = group

    for (let i = 0; i < markets.length; i++) {
      for (let j = i + 1; j < markets.length; j++) {
        pairs.push({ marketA: markets[i], marketB: markets[j] })
      }
    }

    return pairs
  }

  clearCache(): void {
    this.groupCache.clear()
    this.lastFetchAt = 0
  }
}
