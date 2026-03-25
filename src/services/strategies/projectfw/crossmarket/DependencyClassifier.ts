import type { Market } from '@/types'
import type { DependencyGraph, MarketDependency, MarketGroup } from './types'
import type { EventAnalyzer } from './EventAnalyzer'
import { ollamaService } from '@/services/llm/OllamaService'

/**
 * DependencyClassifier
 * Uses LLM to classify pairwise dependencies between markets within events,
 * then caches the resulting dependency graphs.
 *
 * The classifier batches pairs for cost efficiency (up to maxPairsPerCall
 * per LLM request) and caches graphs with a configurable TTL.
 */
export class DependencyClassifier {
  private graphCache: Map<string, DependencyGraph> = new Map()
  private maxPairsPerCall: number
  private cacheTTL: number
  private confidenceThreshold: number

  constructor(options: {
    maxPairsPerCall?: number
    cacheTTL?: number
    confidenceThreshold?: number
  } = {}) {
    this.maxPairsPerCall = options.maxPairsPerCall ?? 10
    this.cacheTTL = options.cacheTTL ?? 3_600_000 // 1 hour
    this.confidenceThreshold = options.confidenceThreshold ?? 0.75
  }

  /**
   * Get or build the dependency graph for an event group.
   * Returns cached graph if fresh, otherwise runs LLM classification.
   */
  async getGraph(
    group: MarketGroup,
    eventAnalyzer: EventAnalyzer,
  ): Promise<DependencyGraph> {
    const cached = this.graphCache.get(group.eventId)
    if (cached && Date.now() - cached.cachedAt < this.cacheTTL) {
      return cached
    }

    const pairs = eventAnalyzer.generatePairs(group)

    // Classify in batches
    const allEdges: MarketDependency[] = []
    for (let i = 0; i < pairs.length; i += this.maxPairsPerCall) {
      const batch = pairs.slice(i, i + this.maxPairsPerCall)
      try {
        const edges = await ollamaService.classifyDependencies(batch)
        allEdges.push(...edges)
      } catch (error) {
        console.warn(
          `[DependencyClassifier] Batch ${i / this.maxPairsPerCall + 1} failed for event ${group.eventId}:`,
          error,
        )
        // Continue with remaining batches — partial data is still useful
      }
    }

    const graph = this.buildGraph(group, allEdges)
    this.graphCache.set(group.eventId, graph)
    return graph
  }

  /**
   * Build a DependencyGraph from classified edges.
   */
  private buildGraph(
    group: MarketGroup,
    edges: MarketDependency[],
  ): DependencyGraph {
    const markets = new Map<string, Market>()
    for (const m of group.markets) {
      markets.set(m.id, m)
    }

    return {
      eventId: group.eventId,
      eventTitle: group.eventTitle,
      markets,
      edges,
      cachedAt: Date.now(),
    }
  }

  /**
   * Find mutex partners for a given market within a dependency graph.
   * Only returns edges that meet the confidence threshold.
   */
  getMutexPartners(
    marketId: string,
    graph: DependencyGraph,
  ): Array<{ partner: Market; dependency: MarketDependency }> {
    const results: Array<{ partner: Market; dependency: MarketDependency }> = []

    for (const edge of graph.edges) {
      if (edge.type !== 'mutex') continue
      if (edge.confidence < this.confidenceThreshold) continue

      let partnerId: string | undefined
      if (edge.marketIdA === marketId) partnerId = edge.marketIdB
      else if (edge.marketIdB === marketId) partnerId = edge.marketIdA

      if (partnerId) {
        const partner = graph.markets.get(partnerId)
        if (partner) {
          results.push({ partner, dependency: edge })
        }
      }
    }

    return results
  }

  /**
   * Get all non-independent edges in a graph (the interesting relationships).
   */
  getDependentEdges(graph: DependencyGraph): MarketDependency[] {
    return graph.edges.filter(
      e => e.type !== 'independent' && e.confidence >= this.confidenceThreshold,
    )
  }

  /**
   * Update configuration at runtime (from settings changes).
   */
  setConfig(options: {
    maxPairsPerCall?: number
    cacheTTL?: number
    confidenceThreshold?: number
  }): void {
    if (options.maxPairsPerCall != null) this.maxPairsPerCall = options.maxPairsPerCall
    if (options.cacheTTL != null) this.cacheTTL = options.cacheTTL
    if (options.confidenceThreshold != null) this.confidenceThreshold = options.confidenceThreshold
  }

  getCachedGraph(eventId: string): DependencyGraph | undefined {
    const cached = this.graphCache.get(eventId)
    if (cached && Date.now() - cached.cachedAt < this.cacheTTL) {
      return cached
    }
    return undefined
  }

  clearCache(): void {
    this.graphCache.clear()
  }
}
