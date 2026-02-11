import type { Market, GammaEvent } from '@/types'
import type { MarketGroup } from './types'
import { gammaClient } from '@/services/api'

/**
 * EventAnalyzer
 * Groups Polymarket markets by event for cross-market dependency analysis.
 * Events naturally group related markets (e.g., "2024 Pennsylvania Election"
 * contains candidate-specific markets that are mutually exclusive).
 *
 * Zero LLM cost — uses existing GammaClient.getEvents() data structure.
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

    const events = await gammaClient.getEvents({ active: true, limit: 100 })
    const groups: MarketGroup[] = []

    for (const event of events) {
      const normalized = this.normalizeEventMarkets(event)
      const active = normalized.filter(m => m.active && !m.closed)
      if (active.length < 2) continue

      const totalLiquidity = active.reduce((sum, m) => sum + m.liquidity, 0)

      const group: MarketGroup = {
        eventId: event.id,
        eventTitle: event.title,
        markets: active,
        totalLiquidity,
        activeCount: active.length,
      }

      groups.push(group)
      this.groupCache.set(event.id, group)
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

  /**
   * Normalize raw event market data to typed Market objects.
   * GammaClient.getEvents() returns raw data — fields like outcomes,
   * clobTokenIds, and outcomePrices may be JSON strings instead of arrays.
   */
  private normalizeEventMarkets(event: GammaEvent): Market[] {
    const rawMarkets = (event as any).markets || []
    const eventNegRisk = Boolean(
      (event as any).enableNegRisk ?? (event as any).negRisk ?? false,
    )

    return rawMarkets.map((raw: any) => {
      const outcomes = this.parseJsonArray(raw.outcomes).map(String)
      const clobTokenIds = this.parseJsonArray(raw.clobTokenIds).map(String)
      const outcomePrices = this.parseJsonArray(raw.outcomePrices).map(
        (p: unknown) => (typeof p === 'string' ? parseFloat(p) : Number(p)),
      )

      return {
        ...raw,
        outcomes,
        clobTokenIds,
        outcomePrices,
        volume:
          typeof raw.volume === 'string'
            ? parseFloat(raw.volume) || 0
            : raw.volume ?? 0,
        volume24hr:
          raw.volume24hr != null
            ? typeof raw.volume24hr === 'string'
              ? parseFloat(raw.volume24hr) || 0
              : raw.volume24hr
            : undefined,
        liquidity:
          typeof raw.liquidity === 'string'
            ? parseFloat(raw.liquidity) || 0
            : raw.liquidity ?? 0,
        negRisk: Boolean(
          raw.negRisk ?? raw.enableNegRisk ?? raw.neg_risk ?? eventNegRisk,
        ),
      } as Market
    })
  }

  private parseJsonArray(val: unknown): unknown[] {
    if (Array.isArray(val)) return val
    if (typeof val === 'string') {
      try {
        const parsed = JSON.parse(val)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return []
  }

  clearCache(): void {
    this.groupCache.clear()
    this.lastFetchAt = 0
  }
}
