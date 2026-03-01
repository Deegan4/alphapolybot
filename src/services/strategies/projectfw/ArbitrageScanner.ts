import type { Market, PriceData } from '@/types'
import type {
  ArbOpportunity,
  FWOptimizerConfig,
  MarketSnapshot,
  TradeLeg,
} from './types'
import type { CrossMarketOpportunity, DependencyGraph } from './crossmarket/types'
import type { EventAnalyzer } from './crossmarket/EventAnalyzer'
import type { DependencyClassifier } from './crossmarket/DependencyClassifier'
import type { MutexValidator } from './crossmarket/MutexValidator'
import { FrankWolfeOptimizer } from './FrankWolfeOptimizer'
import { gammaClient } from '@/services/api/GammaClient'
import { clobClient } from '@/services/api/CLOBClient'
import { realtimeService } from '@/services/realtime'
import { dynamicFeeService } from '@/services/trading/DynamicFeeService'

export interface ScannerConfig {
  minLiquidity: number
  minVolume24h: number
  maxSpreadBps: number
  minProfitBps: number
  takerFeeBps: number
  gasEstimateUSD: number
  enableMultiOutcome: boolean
  tradeSize: number
  /** Max parallel market evaluations in Phase 2 (default: 10) */
  maxConcurrency: number
  /** Stop scanning after finding this many arbs (default: 5) */
  maxOpportunitiesPerScan: number
}

export interface RejectionStats {
  inactive: number
  lowLiquidity: number
  lowVolume: number
  missingData: number
  spreadPreFilter: number
  coherent: number
  multiOutcome: number
  snapshotFailed: number
  optimizerFailed: number
  unprofitable: number
  /** Order book depth too thin to fill tradeSize */
  insufficientDepth: number
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
      spreadPreFilter: 0,
      coherent: 0,
      multiOutcome: 0,
      snapshotFailed: 0,
      optimizerFailed: 0,
      unprofitable: 0,
      insufficientDepth: 0,
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
    const maxOrderBookChecks = 150
    allCandidates.sort((a, b) => (a.liquidity ?? 0) - (b.liquidity ?? 0))
    const candidates = allCandidates.slice(0, maxOrderBookChecks)

    const opportunities: ArbOpportunity[] = []
    let closestAskSum = Infinity

    if (allCandidates.length > 0) {
      console.log(`[ArbitrageScanner] ${allCandidates.length} candidates passed basic filters, pre-screening ${candidates.length} with spread data...`)
    }

    // Phase 1: Lightweight spread pre-screen.
    // Fetch best bid/ask for all tokens in one batch, then filter out markets
    // where askSum >= 1.02 (obviously no arb). Saves ~90% of full order book fetches.
    // Threshold is 1.02 (loose) because full snapshot check at 1.0 is the real gate.
    let spreadScreened = candidates
    if (candidates.length > 0) {
      try {
        const allTokenIds = new Set<string>()
        for (const m of candidates) {
          if (m.clobTokenIds) m.clobTokenIds.forEach(tid => allTokenIds.add(tid))
        }

        if (allTokenIds.size > 0) {
          const spreadsMap = await clobClient.getSpreads(Array.from(allTokenIds))

          spreadScreened = candidates.filter(market => {
            if (!market.clobTokenIds || market.clobTokenIds.length === 0) return true // keep if no tokens to check
            const askPrices = market.clobTokenIds.map(tid => {
              const spread = spreadsMap.get(tid)
              return spread?.ask ?? 1.0
            })
            const askSum = askPrices.reduce((s, p) => s + p, 0)
            if (askSum >= 1.02) {
              rejections.spreadPreFilter++
              return false
            }
            return true
          })

          console.log(`[ArbitrageScanner] Spread pre-screen: ${candidates.length} → ${spreadScreened.length} survivors (${rejections.spreadPreFilter} filtered)`)
        }
      } catch (err) {
        // Spread pre-screen is best-effort — fall through to full snapshot on failure
        console.warn('[ArbitrageScanner] Spread pre-screen failed, falling back to full scan:', err)
      }
    }

    // Phase 2: Full order book snapshot + VWAP + dynamic fees for survivors.
    // Uses concurrency pool (maxConcurrency) instead of fixed batches of 5.
    // Early-terminates when maxOpportunitiesPerScan arbs found.
    const maxOpps = this.config.maxOpportunitiesPerScan ?? 5
    const diagnostics = { closestAskSum }
    const evaluatedResults = await this.runWithConcurrency(
      spreadScreened,
      market => this.evaluateMarket(market, rejections, diagnostics),
      this.config.maxConcurrency ?? 10,
      () => opportunities.length >= maxOpps,
    )
    closestAskSum = diagnostics.closestAskSum

    for (const result of evaluatedResults) {
      opportunities.push(result)
    }

    // Sort by net profit descending — execute best opportunities first
    opportunities.sort((a, b) => b.netProfitUSD - a.netProfitUSD)

    // Diagnostic: log closest askSum so we can see how close markets get to profitability
    if (closestAskSum < Infinity) {
      console.log(`[ArbitrageScanner] Scan complete: ${spreadScreened.length}/${candidates.length} checked (${rejections.spreadPreFilter} spread-filtered), closest askSum=${closestAskSum.toFixed(4)} (need < 1.0000), arbs=${opportunities.length}`)
    }

    const metrics = { total: markets.length, candidates: allCandidates.length, eligible: opportunities.length, rejections }

    // Cross-market validation pass (if enabled)
    if (this.isCrossMarketEnabled) {
      return { opportunities: await this.annotateCrossMarket(opportunities), metrics }
    }

    return { opportunities, metrics }
  }

  /**
   * Evaluate a single market for arbitrage opportunity.
   * Uses VWAP depth-aware pricing and per-token dynamic fees.
   *
   * Extracted from fullScan for use with the concurrency pool.
   */
  private async evaluateMarket(
    market: Market,
    rejections: RejectionStats,
    diagnostics?: { closestAskSum: number },
  ): Promise<ArbOpportunity | null> {
    const snapshot = await this.buildSnapshot(market)
    if (!snapshot) {
      rejections.snapshotFailed++
      return null
    }

    // ── VWAP depth-aware pricing ──
    // Walk order book levels to compute volume-weighted average fill prices
    // instead of using only top-of-book (level 0). Prevents overestimating
    // profit on thin books where tradeSize eats through multiple levels.
    let hasInsufficientAskDepth = false
    const askPrices = snapshot.depth.map((d, idx) => {
      const vwap = ArbitrageScanner.computeVWAP(d.asks, this.config.tradeSize)
      if (vwap && !vwap.sufficient) hasInsufficientAskDepth = true
      return vwap?.vwap ?? snapshot.prices[idx]
    })
    const askSum = askPrices.reduce((s, p) => s + p, 0)

    // Track closest askSum for diagnostics
    if (diagnostics && askSum < diagnostics.closestAskSum) {
      diagnostics.closestAskSum = askSum
    }

    let hasInsufficientBidDepth = false
    const bidPrices = snapshot.depth.map((d, idx) => {
      const vwap = ArbitrageScanner.computeVWAP(d.bids, this.config.tradeSize)
      if (vwap && !vwap.sufficient) hasInsufficientBidDepth = true
      return vwap?.vwap ?? snapshot.prices[idx]
    })
    const bidSum = bidPrices.reduce((s, p) => s + p, 0)

    const numLegs = snapshot.prices.filter((_, i) => !snapshot.settled[i]).length

    // ── Per-token dynamic fees ──
    // Fetch actual fee rate from CLOB API (cached in CLOBClient for lifetime).
    // Use max fee across all outcomes (conservative). Crypto markets charge
    // 1000 bps (10%) vs standard 100 bps (1%).
    let marketFeeBps = this.config.takerFeeBps
    try {
      const feeRates = await Promise.all(
        market.clobTokenIds.map(tid => clobClient.getFeeRateBps(tid))
      )
      const maxFee = Math.max(...feeRates)
      if (maxFee > 0) marketFeeBps = maxFee
    } catch {
      // Fee API failed — estimate from mid-price via DynamicFeeService
      // (more accurate than static fallback for crypto markets near 50%)
      const midPrice = snapshot.prices.reduce((s, p) => s + p, 0) / snapshot.prices.length
      const isCrypto = market.slug?.includes('crypto') || market.slug?.includes('btc') || market.slug?.includes('eth')
      const estimate = dynamicFeeService.estimateDynamicFee(midPrice, !!isCrypto)
      marketFeeBps = Math.max(marketFeeBps, estimate.feeRateBps)
    }

    // ── Paper formula: π_i(t) = max(0, |y_i| − N_i·γ_i) ──

    // PATH 1: Underpriced bundle — buy all outcomes at VWAP ask, merge for $1
    if (askSum < 1.0) {
      if (hasInsufficientAskDepth) {
        rejections.insufficientDepth++
        return null
      }

      const result = this.optimizer.solve(snapshot)
      if (!result || result.tradeLegs.length === 0) {
        rejections.optimizerFailed++
        return null
      }

      const netProfitUSD = this.computeNetProfit(1 - askSum, result.tradeLegs.length, marketFeeBps)
      if (netProfitUSD <= 0) {
        rejections.unprofitable++
        return null
      }

      this.cacheMarket(market)
      console.log(`[ArbitrageScanner] ARB FOUND (underpriced): ${market.question?.substring(0, 40)} | askSum=${askSum.toFixed(4)} | fee=${marketFeeBps}bps | net=$${netProfitUSD.toFixed(4)}`)
      return { market, snapshot, result, netProfitUSD, arbType: 'underpriced' as const, feeRateBps: marketFeeBps }
    }

    // PATH 2: Overpriced bundle — Buy-a-Bundle at $1, sell outcomes at VWAP bid
    if (bidSum > 1.0) {
      if (hasInsufficientBidDepth) {
        rejections.insufficientDepth++
        return null
      }

      const overpricedProfit = this.computeOverpricedProfit(bidSum, numLegs, marketFeeBps)
      if (overpricedProfit <= 0) {
        rejections.unprofitable++
        return null
      }

      const sellLegs = this.buildOverpricedTradeLegs(snapshot, bidPrices)
      if (sellLegs.length === 0) {
        rejections.optimizerFailed++
        return null
      }

      const syntheticResult = {
        mu: snapshot.prices,
        guaranteedProfit: bidSum - 1.0,
        fwGap: 0,
        klDivergence: this.optimizer.klDivergence(snapshot.prices, snapshot.prices.map(() => 1 / snapshot.prices.length)),
        iterations: 0,
        converged: true,
        tradeLegs: sellLegs,
      }

      this.cacheMarket(market)
      console.log(`[ArbitrageScanner] ARB FOUND (overpriced): ${market.question?.substring(0, 40)} | bidSum=${bidSum.toFixed(4)} | fee=${marketFeeBps}bps | net=$${overpricedProfit.toFixed(4)}`)
      return { market, snapshot, result: syntheticResult, netProfitUSD: overpricedProfit, arbType: 'overpriced' as const, feeRateBps: marketFeeBps }
    }

    // Neither path profitable — normal state
    rejections.coherent++
    return null
  }

  /**
   * Run async tasks with bounded concurrency (semaphore pattern).
   * Replaces sequential batch processing with a concurrent pool.
   *
   * @param items - Input items to process
   * @param fn - Async function to apply to each item (should not throw)
   * @param limit - Max concurrent tasks
   * @param earlyStop - Optional callback; when true, stops launching new tasks
   * @returns Array of non-null results
   */
  private runWithConcurrency<T, R>(
    items: T[],
    fn: (item: T) => Promise<R | null>,
    limit: number,
    earlyStop?: () => boolean,
  ): Promise<R[]> {
    const results: R[] = []
    let index = 0
    let activeCount = 0

    return new Promise<R[]>((resolve) => {
      const next = () => {
        // Drain: all items processed, no active tasks
        if (index >= items.length && activeCount === 0) {
          resolve(results)
          return
        }

        // Launch tasks up to concurrency limit
        while (activeCount < limit && index < items.length) {
          if (earlyStop?.()) break
          const currentIndex = index++
          activeCount++

          fn(items[currentIndex])
            .then(result => {
              if (result !== null && result !== undefined) {
                results.push(result)
              }
            })
            .catch(() => { /* individual failures are silent */ })
            .finally(() => {
              activeCount--
              next()
            })
        }

        // If early-stopped or exhausted items, wait for active tasks to drain
        if (index >= items.length && activeCount === 0) {
          resolve(results)
        }
      }

      if (items.length === 0) {
        resolve(results)
      } else {
        next()
      }
    })
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
    try {
      await this.eventAnalyzer.getMarketGroups()
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

    // ── VWAP depth-aware pricing (same logic as evaluateMarket) ──
    let hasInsufficientAskDepth = false
    const askPrices = snapshot.depth.map((d, idx) => {
      const vwap = ArbitrageScanner.computeVWAP(d.asks, this.config.tradeSize)
      if (vwap && !vwap.sufficient) hasInsufficientAskDepth = true
      return vwap?.vwap ?? snapshot.prices[idx]
    })
    const askSum = askPrices.reduce((s, p) => s + p, 0)

    let hasInsufficientBidDepth = false
    const bidPrices = snapshot.depth.map((d, idx) => {
      const vwap = ArbitrageScanner.computeVWAP(d.bids, this.config.tradeSize)
      if (vwap && !vwap.sufficient) hasInsufficientBidDepth = true
      return vwap?.vwap ?? snapshot.prices[idx]
    })
    const bidSum = bidPrices.reduce((s, p) => s + p, 0)

    const numLegs = snapshot.prices.filter((_, i) => !snapshot.settled[i]).length

    // ── Per-token dynamic fees (cached after first call) ──
    let marketFeeBps = this.config.takerFeeBps
    try {
      const feeRates = await Promise.all(
        market.clobTokenIds.map(tid => clobClient.getFeeRateBps(tid))
      )
      const maxFee = Math.max(...feeRates)
      if (maxFee > 0) marketFeeBps = maxFee
    } catch {
      // Fee API failed — estimate from mid-price via DynamicFeeService
      const midPrice = snapshot.prices.reduce((s, p) => s + p, 0) / snapshot.prices.length
      const isCrypto = market.slug?.includes('crypto') || market.slug?.includes('btc') || market.slug?.includes('eth')
      const estimate = dynamicFeeService.estimateDynamicFee(midPrice, !!isCrypto)
      marketFeeBps = Math.max(marketFeeBps, estimate.feeRateBps)
    }

    // PATH 1: Underpriced — buy all, merge for $1
    if (askSum < 1.0) {
      if (hasInsufficientAskDepth) return null

      const result = this.optimizer.solve(snapshot)
      if (!result || result.tradeLegs.length === 0) return null

      const netProfitUSD = this.computeNetProfit(1 - askSum, result.tradeLegs.length, marketFeeBps)
      if (netProfitUSD <= 0) return null

      return { market, snapshot, result, netProfitUSD, arbType: 'underpriced' as const, feeRateBps: marketFeeBps }
    }

    // PATH 2: Overpriced — Buy-a-Bundle at $1, sell at bid
    if (bidSum > 1.0) {
      if (hasInsufficientBidDepth) return null

      const overpricedProfit = this.computeOverpricedProfit(bidSum, numLegs, marketFeeBps)
      if (overpricedProfit <= 0) return null

      const sellLegs = this.buildOverpricedTradeLegs(snapshot, bidPrices)
      if (sellLegs.length === 0) return null

      const syntheticResult = {
        mu: snapshot.prices,
        guaranteedProfit: bidSum - 1.0,
        fwGap: 0,
        klDivergence: this.optimizer.klDivergence(snapshot.prices, snapshot.prices.map(() => 1 / snapshot.prices.length)),
        iterations: 0,
        converged: true,
        tradeLegs: sellLegs,
      }

      return { market, snapshot, result: syntheticResult, netProfitUSD: overpricedProfit, arbType: 'overpriced' as const, feeRateBps: marketFeeBps }
    }

    return null
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
   * Walk order book levels to compute Volume-Weighted Average Price (VWAP)
   * for a given trade size. Pure function — no service dependencies.
   *
   * For BUY: walks ask levels (sorted lowest to highest price).
   * For SELL: walks bid levels (sorted highest to lowest price).
   *
   * @param levels - Order book levels (asks or bids from snapshot.depth)
   * @param tradeSize - Target trade size in USD
   * @returns { vwap, fillableUSD, sufficient } or null if no valid levels
   */
  static computeVWAP(
    levels: Array<{ price: number; size: number }>,
    tradeSize: number,
  ): { vwap: number; fillableUSD: number; sufficient: boolean } | null {
    if (!levels || levels.length === 0) return null

    let filledUSD = 0
    let totalShares = 0

    for (const level of levels) {
      if (level.price <= 0 || level.size <= 0) continue
      const remaining = tradeSize - filledUSD
      if (remaining <= 0) break

      const levelValueUSD = level.price * level.size
      const fillUSD = Math.min(levelValueUSD, remaining)
      const fillShares = fillUSD / level.price

      filledUSD += fillUSD
      totalShares += fillShares
    }

    if (filledUSD <= 0 || totalShares <= 0) return null

    return {
      vwap: filledUSD / totalShares,
      fillableUSD: filledUSD,
      sufficient: filledUSD >= tradeSize * 0.5,
    }
  }

  /**
   * Compute net arbitrage profit using the Bregman Projection paper's formula:
   *
   *   π_i(t) = max(0, |y_i| − N_i · γ_i)
   *
   * Where:
   *   |y_i| = actual price deviation from bundle cost $1.00:
   *           (1 - askSum) for underpriced, (bidSum - 1) for overpriced
   *   N_i   = number of trade legs (each incurs taker fee)
   *   γ_i   = per-leg taker fee in USD = (takerFeeBps / 10000) * tradeSize
   *
   * IMPORTANT: priceDeviation must be the actual ask/bid deviation, NOT the
   * optimizer's KL-based guaranteedProfit (which is in nats, not price units).
   *
   * The max(0, ...) is the paper's hard gate: small deviations that don't
   * overcome the per-leg fee threshold produce ZERO profit, not negative.
   * This prevents the optimizer from chasing micro-incoherence that fees eat.
   */
  computeNetProfit(priceDeviation: number, numLegs: number, feeRateBps?: number): number {
    const effectiveFeeBps = feeRateBps ?? this.config.takerFeeBps
    const grossProfit = priceDeviation * this.config.tradeSize
    const perLegFee = (effectiveFeeBps / 10000) * this.config.tradeSize
    const totalFees = numLegs * perLegFee
    const gasCost = this.config.gasEstimateUSD

    // Paper's formula: π = max(0, |y| - N·γ) minus gas
    // Gas is not part of the paper's model but is real on Polygon.
    return Math.max(0, grossProfit - totalFees) - gasCost
  }

  /**
   * Compute net profit for the OVERPRICED bundle path (bidSum > $1.00).
   *
   * Strategy: Buy a complete set via Buy-a-Bundle at exactly $1.00,
   * then sell each outcome at its bid price on the CLOB.
   *
   * Paper formula for overpriced case with Buy-a-Bundle:
   *   π = max(0, (bidSum - 1.0) * tradeSize - N_i · γ_i) - gasCost
   *
   * The Buy-a-Bundle approach avoids the 2N·γ penalty of short-sell-and-cover
   * because the bundle purchase is a single on-chain tx (not N separate buys).
   */
  computeOverpricedProfit(bidSum: number, numLegs: number, feeRateBps?: number): number {
    const effectiveFeeBps = feeRateBps ?? this.config.takerFeeBps
    const grossProfit = (bidSum - 1.0) * this.config.tradeSize
    const perLegFee = (effectiveFeeBps / 10000) * this.config.tradeSize
    const totalFees = numLegs * perLegFee
    const gasCost = this.config.gasEstimateUSD

    // Paper: π = max(0, |y| - N·γ) - gas
    return Math.max(0, grossProfit - totalFees) - gasCost
  }

  /**
   * Build SELL trade legs for overpriced bundle path.
   * Each outcome gets a SELL leg at its bid price — after buying the complete
   * set via Buy-a-Bundle at $1.00, we sell each outcome individually.
   *
   * Proportion is weighted by bid price (sell more of the expensive outcomes
   * to extract maximum value from the overpricing).
   */
  private buildOverpricedTradeLegs(
    snapshot: MarketSnapshot,
    bidPrices: number[]
  ): TradeLeg[] {
    const legs: TradeLeg[] = []
    const totalBid = bidPrices.reduce((s, p, i) => s + (snapshot.settled[i] ? 0 : p), 0)

    for (let i = 0; i < bidPrices.length; i++) {
      if (snapshot.settled[i]) continue
      if (bidPrices[i] <= 0) continue

      legs.push({
        outcomeIndex: i,
        side: 'SELL',
        proportion: bidPrices[i] / Math.max(totalBid, 1e-10),
        price: bidPrices[i],
      })
    }

    return legs
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
