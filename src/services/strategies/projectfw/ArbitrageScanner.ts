import type { Market, PriceData } from '@/types'
import type {
  ArbOpportunity,
  FWOptimizerConfig,
  MarketSnapshot,
} from './types'
import type { CrossMarketOpportunity, DependencyGraph } from './crossmarket/types'
import type { EventAnalyzer } from './crossmarket/EventAnalyzer'
import type { DependencyClassifier } from './crossmarket/DependencyClassifier'
import type { MutexValidator } from './crossmarket/MutexValidator'
import { FrankWolfeOptimizer } from './FrankWolfeOptimizer'
import { gammaClient } from '@/services/api'
import { clobClient } from '@/services/api/CLOBClient'
import { realtimeService } from '@/services/realtime'

export interface ScannerConfig {
  minLiquidity: number
  minVolume24h: number
  maxSpreadBps: number
  minProfitBps: number
  takerFeeBps: number
  gasEstimateUSD: number
  enableMultiOutcome: boolean
  tradeSize: number
}

export interface RejectionStats {
  inactive: number
  lowLiquidity: number
  lowVolume: number
  missingData: number
  coherent: number
  multiOutcome: number
  snapshotFailed: number
  optimizerFailed: number
  unprofitable: number
}

export interface ScanResult {
  opportunities: ArbOpportunity[] | CrossMarketOpportunity[]
  metrics: {
    total: number
    candidates: number
    eligible: number
    rejections: RejectionStats
  }
}

/**
 * ArbitrageScanner — Finds markets with incoherent prices and evaluates
 * arbitrage opportunities using the FrankWolfeOptimizer.
 *
 * Two scanning modes:
 * 1. Periodic full scan: fetches all active markets, filters, runs optimizer
 * 2. Reactive scan: re-evaluates tracked markets on real-time price updates
 */
export class ArbitrageScanner {
  private optimizer: FrankWolfeOptimizer
  private config: ScannerConfig

  /** Maps tokenId → marketId for reverse lookup on price updates */
  private tokenToMarket: Map<string, string> = new Map()
  /** Cached market data for reactive scanning */
  private marketCache: Map<string, Market> = new Map()
  /** Cached snapshots (avoid re-fetching order books on every price tick) */
  private snapshotCache: Map<string, { snapshot: MarketSnapshot; timestamp: number }> = new Map()
  /** How long to cache order book snapshots (ms) */
  private snapshotTTL = 5000

  // Cross-market validation (optional — enabled via enableCrossMarket())
  private eventAnalyzer: EventAnalyzer | null = null
  private dependencyClassifier: DependencyClassifier | null = null
  private mutexValidator: MutexValidator | null = null

  constructor(optimizerConfig: FWOptimizerConfig, config: ScannerConfig) {
    this.optimizer = new FrankWolfeOptimizer(optimizerConfig)
    this.config = config
  }

  /**
   * Enable cross-market validation on scan results.
   * Does NOT change execution — only annotates opportunities with mutex metadata.
   */
  enableCrossMarket(
    eventAnalyzer: EventAnalyzer,
    dependencyClassifier: DependencyClassifier,
    mutexValidator: MutexValidator,
  ): void {
    this.eventAnalyzer = eventAnalyzer
    this.dependencyClassifier = dependencyClassifier
    this.mutexValidator = mutexValidator
    console.log('[ArbitrageScanner] Cross-market validation enabled')
  }

  disableCrossMarket(): void {
    this.eventAnalyzer = null
    this.dependencyClassifier = null
    this.mutexValidator = null
    console.log('[ArbitrageScanner] Cross-market validation disabled')
  }

  get isCrossMarketEnabled(): boolean {
    return this.eventAnalyzer !== null && this.dependencyClassifier !== null && this.mutexValidator !== null
  }

  /**
   * Full scan — called periodically.
   * Fetches all active markets, filters candidates, runs optimizer on each.
   * If cross-market validation is enabled, annotates results with mutex metadata.
   */
  async fullScan(): Promise<ScanResult> {
    const markets = await gammaClient.getActiveMarkets()

    // Track rejection reasons for diagnostics
    const rejections: RejectionStats = {
      inactive: 0,
      lowLiquidity: 0,
      lowVolume: 0,
      missingData: 0,
      coherent: 0,
      multiOutcome: 0,
      snapshotFailed: 0,
      optimizerFailed: 0,
      unprofitable: 0,
    }

    const allCandidates: Market[] = []
    for (const m of markets) {
      const reason = this.classifyRejection(m)
      if (reason) {
        rejections[reason]++
      } else {
        allCandidates.push(m)
      }
    }

    // Limit order book fetches to top candidates by liquidity.
    // Checking 700+ order books every scan cycle would overwhelm the CLOB API.
    // Lower-liquidity markets are more likely to have wider spreads (arb opportunities)
    // but we need SOME liquidity for fills. Sort by liquidity ascending to
    // check the "sweet spot" markets first, then cap at maxOrderBookChecks.
    const maxOrderBookChecks = 75
    allCandidates.sort((a, b) => (a.liquidity ?? 0) - (b.liquidity ?? 0))
    const candidates = allCandidates.slice(0, maxOrderBookChecks)

    const opportunities: ArbOpportunity[] = []
    let closestAskSum = Infinity

    if (allCandidates.length > 0) {
      console.log(`[ArbitrageScanner] ${allCandidates.length} candidates passed basic filters, checking ${candidates.length} order books (sorted by liquidity asc)...`)
    }

    // Process candidates in parallel (batches of 5 to avoid rate limits).
    // For each market: fetch order books → check ask-sum < 1.0 → if yes, run optimizer.
    // Gamma mid-prices always sum to 1.00 so we MUST check real ask prices.
    const batchSize = 5
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize)
      const results = await Promise.allSettled(
        batch.map(async market => {
          const snapshot = await this.buildSnapshot(market)
          if (!snapshot) {
            rejections.snapshotFailed++
            return null
          }

          // Direct ask-sum check: the real profitability gate.
          // Market makers keep ask sums >= 1.0 most of the time.
          // An ask sum < 1.0 means we can buy all outcomes and merge for guaranteed profit.
          const askPrices = snapshot.depth.map((d, idx) => {
            const bestAsk = d.asks?.[0]?.price
            return bestAsk != null && bestAsk > 0 ? bestAsk : snapshot.prices[idx]
          })
          const askSum = askPrices.reduce((s, p) => s + p, 0)

          // Track closest askSum for diagnostics
          if (askSum < closestAskSum) closestAskSum = askSum

          if (askSum >= 1.0) {
            // No spread arb — ask-sum overpriced. This is the normal state.
            rejections.coherent++
            return null
          }

          // Ask sum is below $1.00 — potential arb! Run optimizer for optimal allocation.
          const result = this.optimizer.solve(snapshot)
          if (!result || result.tradeLegs.length === 0) {
            rejections.optimizerFailed++
            return null
          }

          const netProfitUSD = this.computeNetProfit(result.guaranteedProfit, result.tradeLegs.length)
          if (netProfitUSD <= 0) {
            rejections.unprofitable++
            return null
          }

          // Cache market for reactive scanning
          this.cacheMarket(market)

          console.log(`[ArbitrageScanner] ARB FOUND: ${market.question?.substring(0, 40)} | askSum=${askSum.toFixed(4)} | net=$${netProfitUSD.toFixed(4)}`)
          return { market, snapshot, result, netProfitUSD } as ArbOpportunity
        })
      )

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          opportunities.push(r.value)
        }
      }
    }

    // Sort by net profit descending — execute best opportunities first
    opportunities.sort((a, b) => b.netProfitUSD - a.netProfitUSD)

    // Diagnostic: log closest askSum so we can see how close markets get to profitability
    if (closestAskSum < Infinity) {
      console.log(`[ArbitrageScanner] Scan complete: ${candidates.length} checked, closest askSum=${closestAskSum.toFixed(4)} (need < 1.0000), arbs=${opportunities.length}`)
    }

    const metrics = { total: markets.length, candidates: allCandidates.length, eligible: opportunities.length, rejections }

    // Cross-market validation pass (if enabled)
    if (this.isCrossMarketEnabled) {
      return { opportunities: await this.annotateCrossMarket(opportunities), metrics }
    }

    return { opportunities, metrics }
  }

  /**
   * Annotate arb opportunities with cross-market mutex validation.
   * Finds event groups, builds dependency graphs, and checks mutex coherence.
   * Does NOT change the opportunities — only adds metadata.
   */
  private async annotateCrossMarket(
    opportunities: ArbOpportunity[],
  ): Promise<CrossMarketOpportunity[]> {
    if (!this.eventAnalyzer || !this.dependencyClassifier || !this.mutexValidator) {
      // Safety fallback — return un-annotated
      return opportunities.map(opp => ({
        ...opp,
        relatedMarkets: [],
        mutexValidation: { isValidated: false, reasoning: 'Cross-market not enabled' },
      }))
    }

    // Fetch event groups (cached internally by EventAnalyzer)
    let groups
    try {
      groups = await this.eventAnalyzer.getMarketGroups()
    } catch (error) {
      console.warn('[ArbitrageScanner] Failed to fetch market groups:', error)
      return opportunities.map(opp => ({
        ...opp,
        relatedMarkets: [],
        mutexValidation: { isValidated: false, reasoning: 'Event group fetch failed' },
      }))
    }

    const annotated: CrossMarketOpportunity[] = []

    for (const opp of opportunities) {
      // Find which event group this market belongs to
      const group = this.eventAnalyzer.findGroupForMarket(opp.market.id)
      if (!group || group.activeCount < 2) {
        annotated.push({
          ...opp,
          relatedMarkets: [],
          mutexValidation: { isValidated: false, reasoning: 'Market not in multi-market event' },
        })
        continue
      }

      // Build/get cached dependency graph
      let graph: DependencyGraph
      try {
        graph = await this.dependencyClassifier.getGraph(group, this.eventAnalyzer)
      } catch (error) {
        console.warn(`[ArbitrageScanner] Dependency graph failed for event ${group.eventId}:`, error)
        annotated.push({
          ...opp,
          relatedMarkets: group.markets.filter(m => m.id !== opp.market.id),
          mutexValidation: { isValidated: false, reasoning: 'Dependency classification failed' },
        })
        continue
      }

      // Find mutex partners
      const mutexPartners = this.dependencyClassifier.getMutexPartners(opp.market.id, graph)

      if (mutexPartners.length === 0) {
        annotated.push({
          ...opp,
          relatedMarkets: group.markets.filter(m => m.id !== opp.market.id),
          mutexValidation: { isValidated: false, reasoning: 'No high-confidence mutex partners found' },
        })
        continue
      }

      // Validate with first (highest confidence) mutex partner
      const best = mutexPartners.reduce((a, b) =>
        b.dependency.confidence > a.dependency.confidence ? b : a,
      )

      const validation = this.mutexValidator.buildValidation(
        opp.market,
        best.partner,
        best.dependency,
      )

      annotated.push({
        ...opp,
        relatedMarkets: mutexPartners.map(p => p.partner),
        mutexValidation: validation,
      })
    }

    return annotated
  }

  /**
   * Reactive evaluation — called when a tracked market's price changes.
   * Returns an opportunity if the price update creates/improves an arb.
   */
  async evaluateOnPriceUpdate(
    tokenId: string,
    priceData: PriceData
  ): Promise<ArbOpportunity | null> {
    const marketId = this.tokenToMarket.get(tokenId)
    if (!marketId) return null

    const market = this.marketCache.get(marketId)
    if (!market) return null

    // Update the market's price from real-time data
    const tokenIndex = market.clobTokenIds.indexOf(tokenId)
    if (tokenIndex >= 0) {
      market.outcomePrices[tokenIndex] = priceData.mid
    }

    // NOTE: Gamma mid-prices always sum to 1.00. No pre-filter on mid-prices.
    // We'll check the order book ask-sum in the snapshot below.

    // Build snapshot (uses cache if fresh enough)
    const snapshot = await this.buildSnapshot(market)
    if (!snapshot) return null

    // Direct ask-sum check — same as fullScan
    const askPrices = snapshot.depth.map((d, idx) => {
      const bestAsk = d.asks?.[0]?.price
      return bestAsk != null && bestAsk > 0 ? bestAsk : snapshot.prices[idx]
    })
    const askSum = askPrices.reduce((s, p) => s + p, 0)
    if (askSum >= 1.0) return null

    const result = this.optimizer.solve(snapshot)
    if (!result || result.tradeLegs.length === 0) return null

    const netProfitUSD = this.computeNetProfit(result.guaranteedProfit, result.tradeLegs.length)
    if (netProfitUSD <= 0) return null

    return { market, snapshot, result, netProfitUSD }
  }

  /**
   * Build a MarketSnapshot from a market by fetching order book depth.
   * Uses cache with TTL to avoid hammering the CLOB API.
   */
  async buildSnapshot(market: Market): Promise<MarketSnapshot | null> {
    if (!market.clobTokenIds || market.clobTokenIds.length < 2) return null

    // Check cache
    const cached = this.snapshotCache.get(market.id)
    if (cached && Date.now() - cached.timestamp < this.snapshotTTL) {
      // Update prices from real-time service if available
      const updated = { ...cached.snapshot }
      for (let i = 0; i < updated.tokenIds.length; i++) {
        const livePrice = realtimeService.getPrice(updated.tokenIds[i])
        if (livePrice) {
          updated.prices[i] = livePrice.mid
        }
      }
      return updated
    }

    try {
      // Fetch order books for all outcomes
      const books = await Promise.all(
        market.clobTokenIds.map(tid => clobClient.getOrderBook(tid))
      )

      // Compute mid-prices from order books (more accurate than Gamma prices)
      const prices = books.map((book, i) => {
        const bestBid = book.bids?.[0]?.price ?? 0
        const bestAsk = book.asks?.[0]?.price ?? 1
        if (bestBid > 0 && bestAsk > 0) {
          return (bestBid + bestAsk) / 2
        }
        // Fallback to Gamma prices
        return market.outcomePrices[i] ?? 0.5
      })

      const snapshot: MarketSnapshot = {
        prices,
        outcomes: market.outcomes,
        tokenIds: market.clobTokenIds,
        depth: books.map(book => ({
          bids: book.bids ?? [],
          asks: book.asks ?? [],
        })),
        settled: market.outcomes.map(() => false),
        conditionId: market.conditionId,
        negRisk: market.negRisk ?? false,
        marketId: market.id,
      }

      // Cache snapshot
      this.snapshotCache.set(market.id, { snapshot, timestamp: Date.now() })

      return snapshot
    } catch (error) {
      console.warn(`[ArbitrageScanner] Failed to build snapshot for ${market.id}:`, error)
      return null
    }
  }

  /**
   * Check if a market is a viable arb candidate (cheap pre-filter).
   */
  isCandidate(market: Market): boolean {
    return this.classifyRejection(market) === null
  }

  /**
   * Classify why a market is rejected (returns null if it passes all filters).
   */
  classifyRejection(market: Market): keyof RejectionStats | null {
    if (!market.active || market.closed) return 'inactive'
    if (market.liquidity < this.config.minLiquidity) return 'lowLiquidity'
    if ((market.volume24hr ?? market.volume ?? 0) < this.config.minVolume24h) return 'lowVolume'
    if (!market.outcomes || market.outcomes.length < 2) return 'missingData'
    if (!market.clobTokenIds || market.clobTokenIds.length < 2) return 'missingData'
    if (!market.outcomePrices || market.outcomePrices.length < 2) return 'missingData'

    // NOTE: Gamma API mid-prices ALWAYS sum to exactly 1.00 — they are display
    // prices, not tradeable prices. Coherence filtering on Gamma prices is useless
    // and rejects every market. Real profitability is determined by CLOB order book
    // ask prices (fetched in buildSnapshot) + optimizer + net-profit calculation.
    // No coherence pre-filter here — let the order book decide.

    // For now, binary only unless multi-outcome is enabled
    if (!this.config.enableMultiOutcome && market.outcomes.length > 2) return 'multiOutcome'

    return null
  }

  /**
   * Compute net profit in USD after taker fees and gas.
   *
   * netProfit = (guaranteedProfit * tradeSize) - (takerFee * tradeSize * numLegs) - (gas * numLegs)
   */
  computeNetProfit(guaranteedProfitRatio: number, numLegs: number): number {
    const grossProfit = guaranteedProfitRatio * this.config.tradeSize
    const totalFees = (this.config.takerFeeBps / 10000) * this.config.tradeSize * numLegs
    const totalGas = this.config.gasEstimateUSD * numLegs
    return grossProfit - totalFees - totalGas
  }

  /**
   * Re-run optimizer on a fresh snapshot (for pre-execution revalidation).
   * Returns null if no profitable arb found.
   */
  revalidate(snapshot: MarketSnapshot) {
    return this.optimizer.solve(snapshot)
  }

  /**
   * Invalidate cached snapshot for a market (force fresh order book fetch).
   */
  invalidateSnapshotCache(marketId: string): void {
    this.snapshotCache.delete(marketId)
  }

  /**
   * Track a market for reactive price updates.
   */
  cacheMarket(market: Market): void {
    this.marketCache.set(market.id, { ...market })
    for (const tokenId of market.clobTokenIds) {
      this.tokenToMarket.set(tokenId, market.id)
    }
  }

  /**
   * Get all tracked market token IDs (for WebSocket subscription).
   */
  getTrackedTokenIds(): string[] {
    return Array.from(this.tokenToMarket.keys())
  }

  /**
   * Clear all caches.
   */
  reset(): void {
    this.tokenToMarket.clear()
    this.marketCache.clear()
    this.snapshotCache.clear()
  }

  /**
   * Update scanner configuration.
   */
  setConfig(config: Partial<ScannerConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Update optimizer configuration.
   */
  setOptimizerConfig(config: Partial<FWOptimizerConfig>): void {
    this.optimizer.setConfig(config)
  }
}
