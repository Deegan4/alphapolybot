import { BaseStrategy } from './BaseStrategy'
import { ArbitrageScanner } from './projectfw/ArbitrageScanner'
import type { ArbOpportunity } from './projectfw/types'
import type { CrossMarketOpportunity } from './projectfw/crossmarket/types'
import { EventAnalyzer } from './projectfw/crossmarket/EventAnalyzer'
import { DependencyClassifier } from './projectfw/crossmarket/DependencyClassifier'
import { MutexValidator } from './projectfw/crossmarket/MutexValidator'
import type { ProjectFWConfig, FWArbRound, FWArbLeg, PriceData, RecordedSnapshot } from '@/types'
import { realtimeService } from '@/services/realtime'
import { tradingService } from '@/services/trading/TradingService'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'
import { KellySizer } from '@/services/trading/KellySizer'
import { tradeLogger } from '@/services/trading/TradeLogger'
import { rejectionTracker } from '@/services/trading/RejectionTracker'
import { gammaClient } from '@/services/api/GammaClient'
import { clobClient } from '@/services/api/CLOBClient'

const DEFAULT_CONFIG: ProjectFWConfig = {
  // Algorithm parameters
  alpha: 0.5,
  epsilonD: 0.001,
  epsilon0: 0.1,
  maxIterations: 50,
  // Trading parameters
  tradeSize: 5, // Polymarket minimum order size is 5 shares
  minProfitBps: 30, // 30bps — catches thin-edge arbs at small bankroll ($10-25)
  maxConcurrentArbs: 2,
  scanIntervalMs: 30000, // 30s (was 15s) — gives time for 75 order book checks
  cooldownMs: 60000,
  // Fee model — maker mode (GTD limit orders) pays 0% fees.
  // Only falls back to taker on revalidation failure or partial unwind.
  takerFeeBps: 0,
  gasEstimateUSD: 0.01,
  // Market filters — set low for small bankrolls. The optimizer + profitability
  // check are the real gates; these just filter out completely dead markets.
  minLiquidity: 50, // Lowered to find wider-spread low-liq markets
  minVolume24h: 10,
  maxSpreadBps: 500,
  // Multi-outcome
  enableMultiOutcome: false,
  // Safety
  stopLossPercent: 0.15,
  takeProfitPercent: 0.10,
  // Cross-market analysis (validation-only MVP)
  enableCrossMarket: false,
  crossMarketBudgetUSD: 0.25,
  mutexConfidenceThreshold: 0.75,
  crossMarketCacheTTL: 3_600_000,
  maxPairsPerLLMCall: 10,
  minEventLiquidity: 10_000,
}

/**
 * ProjectFW Arbitrage Strategy
 *
 * Uses Bregman Projection via Frank-Wolfe optimization (from academic paper)
 * to find and exploit price incoherence in prediction markets.
 *
 * When market prices don't form a valid probability distribution (sum != 1),
 * the optimizer computes the guaranteed-profitable trade bundle that maximizes
 * D(mu||theta) - g(mu) (KL divergence minus Frank-Wolfe duality gap).
 *
 * Execution flow:
 * 1. Periodic scan discovers markets with incoherent prices
 * 2. FrankWolfeOptimizer computes optimal trade bundle
 * 3. ArbitrageScanner verifies profitability after fees
 * 4. Strategy executes multi-leg buy (all outcomes)
 * 5. Positions held until resolution ($1/set) — tracked by PLM
 *
 * CLOB architecture: No on-chain merge/split. Profit is realized at resolution.
 * Overpriced path (bidSum > 1.0) is not available — requires on-chain bundle split.
 */
export class ProjectFWStrategy extends BaseStrategy {
  name = 'ProjectFW Arb'
  description = 'Frank-Wolfe optimized arbitrage: detects price incoherence via KL divergence, maximizes guaranteed profit'
  strategyType = 'arbitrage' as const

  private fwConfig: ProjectFWConfig = DEFAULT_CONFIG
  private scanner: ArbitrageScanner
  private scanInterval: number | null = null
  private unsubscribePrices: (() => void) | null = null
  private activeArbs = 0
  private arbRounds: FWArbRound[] = []
  private lastTradeTimes: Map<string, number> = new Map()

  constructor(config?: Partial<ProjectFWConfig>) {
    super()
    if (config) this.fwConfig = { ...DEFAULT_CONFIG, ...config }
    this._config = { enabled: false, ...this.fwConfig }

    this.scanner = new ArbitrageScanner(
      {
        alpha: this.fwConfig.alpha,
        epsilonD: this.fwConfig.epsilonD,
        epsilon0: this.fwConfig.epsilon0,
        maxIterations: this.fwConfig.maxIterations,
      },
      {
        minLiquidity: this.fwConfig.minLiquidity,
        minVolume24h: this.fwConfig.minVolume24h,
        maxSpreadBps: this.fwConfig.maxSpreadBps,
        minProfitBps: this.fwConfig.minProfitBps,
        takerFeeBps: this.fwConfig.takerFeeBps,
        gasEstimateUSD: this.fwConfig.gasEstimateUSD,
        enableMultiOutcome: this.fwConfig.enableMultiOutcome,
        tradeSize: this.fwConfig.tradeSize,
        maxConcurrency: 10,
        maxOpportunitiesPerScan: 5,
      }
    )
  }

  async initialize(): Promise<void> {
    this.log('Initializing ProjectFW Arbitrage Strategy')
    this.setStatus('idle')
    this.log('ProjectFW Arbitrage Strategy initialized')
  }

  async start(): Promise<void> {
    if (this._status === 'running') {
      this.log('Strategy already running')
      return
    }

    this.log('Starting ProjectFW Arbitrage Strategy')
    this.setStatus('running')

    // Subscribe to real-time price updates for reactive scanning
    this.unsubscribePrices = realtimeService.onPriceUpdate(
      (tokenId: string, price: PriceData) => this.handlePriceUpdate(tokenId, price)
    )

    // Clear any stale interval before creating a new one
    if (this.scanInterval) clearInterval(this.scanInterval)

    // Start periodic full scan
    this.scanInterval = window.setInterval(
      () => this.runFullScan(),
      this.fwConfig.scanIntervalMs
    )

    // Start snapshot recording for backtest data collection (non-blocking)
    this.startSnapshotRecording()

    // Run first scan immediately
    await this.runFullScan()

    activityLogger.logSystem('ProjectFW Arb started')
    activityLogger.logSystem(`Config: $${this.fwConfig.tradeSize}/bundle, ${this.fwConfig.minProfitBps}bps min profit, α=${this.fwConfig.alpha}`)
  }

  async stop(): Promise<void> {
    this.log('Stopping ProjectFW Arbitrage Strategy')

    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }

    if (this.unsubscribePrices) {
      this.unsubscribePrices()
      this.unsubscribePrices = null
    }

    // Stop snapshot recording
    this.stopSnapshotRecording()

    // Unsubscribe from all tracked markets
    const trackedTokens = this.scanner.getTrackedTokenIds()
    if (trackedTokens.length > 0) {
      realtimeService.unsubscribeMarket(trackedTokens)
    }

    this.scanner.reset()
    this.lastTradeTimes.clear()
    this.setStatus('idle')
    activityLogger.logSystem('ProjectFW Arb stopped')
  }

  /**
   * Periodic full scan — discovers and evaluates all active markets.
   */
  private async runFullScan(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    try {
      const { opportunities, metrics } = await this.scanner.fullScan()

      // Always log scan results with metrics + rejection breakdown for the UI
      activityLogger.logScan(
        `ProjectFW: ${metrics.total} markets → ${metrics.candidates} candidates → ${metrics.eligible} profitable`,
        {
          total: metrics.total,
          eligible: metrics.eligible,
          candidates: metrics.candidates,
          rejections: metrics.rejections,
        }
      )

      if (opportunities.length > 0) {
        // Subscribe to price feeds for discovered markets
        for (const opp of opportunities) {
          const tokenIds = opp.market.clobTokenIds
          if (tokenIds?.length) {
            realtimeService.subscribeMarket(tokenIds)
          }
        }

        // Execute best opportunities up to concurrency limit
        for (const opp of opportunities) {
          if (this.activeArbs >= this.fwConfig.maxConcurrentArbs) break
          if (this.isOnCooldown(opp.market.id)) continue
          await this.executeArb(opp)
        }
      }
    } catch (error) {
      this.logError('ProjectFW scan failed', error)
      activityLogger.logError('ProjectFW scan failed', error)
    }
  }

  /**
   * Reactive scan — re-evaluates a market when its price changes.
   */
  private async handlePriceUpdate(tokenId: string, price: PriceData): Promise<void> {
    if (!this._enabled || this._status !== 'running') return
    if (this.activeArbs >= this.fwConfig.maxConcurrentArbs) return

    try {
      const opp = await this.scanner.evaluateOnPriceUpdate(tokenId, price)
      if (!opp) return
      if (this.isOnCooldown(opp.market.id)) return

      await this.executeArb(opp)
    } catch {
      // Reactive scans can fail silently — periodic scan is the safety net
    }
  }

  /**
   * Execute an arbitrage bundle.
   *
   * UNDERPRICED (askSum < 1.0): Buy all outcomes via placeBet. Positions resolve
   * at $1/set — profit = (1 - askSum) * tradeSize - fees. Tracked by PLM.
   *
   * OVERPRICED (bidSum > 1.0): Not available on CLOB (requires on-chain bundle
   * splitting). Scanner still detects these for logging, but execution is skipped.
   */
  private async executeArb(opp: ArbOpportunity): Promise<void> {
    const round: FWArbRound = {
      id: crypto.randomUUID(),
      marketId: opp.market.id,
      timestamp: Date.now(),
      legs: [],
      totalCost: 0,
      guaranteedProfit: opp.result.guaranteedProfit,
      fwGap: opp.result.fwGap,
      klDivergence: opp.result.klDivergence,
      status: 'pending',
    }

    const priceSum = opp.snapshot.prices.reduce((s, p) => s + p, 0)
    const priceSumDisplay = (priceSum * 100).toFixed(1)
    const profitDisplay = (opp.netProfitUSD * 100).toFixed(2)

    const arbPath = opp.arbType === 'overpriced' ? 'OVERPRICED (not executable on CLOB)' : 'UNDERPRICED (buy all → hold to resolution)'
    this.log(`ARB OPPORTUNITY [${arbPath}]: ${opp.market.question.substring(0, 40)}...`)
    this.log(`  Price sum: ${priceSumDisplay}¢ | Net profit: ${profitDisplay}¢ | KL: ${opp.result.klDivergence.toFixed(4)}`)

    activityLogger.logSystem(
      `FW ARB: ${opp.snapshot.outcomes.map((o, i) => `${o} ${(opp.snapshot.prices[i] * 100).toFixed(0)}¢`).join(' + ')} = ${priceSumDisplay}¢`,
      {
        market: opp.market.question.substring(0, 50),
        netProfit: opp.netProfitUSD,
        klDivergence: opp.result.klDivergence,
        fwGap: opp.result.fwGap,
        iterations: opp.result.iterations,
      }
    )

    // Cross-market validation: block if mutex pair is coherent (no real arb)
    const cmOpp = opp as CrossMarketOpportunity
    if (cmOpp.mutexValidation?.isValidated) {
      this.log(`  [CROSS-MKT] ${cmOpp.mutexValidation.reasoning}`)
      activityLogger.logInfo(
        `Cross-market: ${cmOpp.mutexValidation.reasoning}`,
        {
          mutexPartner: cmOpp.mutexValidation.mutexPartner?.question?.substring(0, 50),
          combinedPriceSum: cmOpp.mutexValidation.combinedPriceSum,
          incoherence: cmOpp.mutexValidation.incoherence,
        },
      )

      if (cmOpp.mutexValidation.isCoherent) {
        this.log(`  [CROSS-MKT] BLOCKED: mutex pair is coherent — no real mispricing`)
        rejectionTracker.record('market_filter', 'fw', `mutex coherent: ${opp.market.question?.substring(0, 40)}`)
        activityLogger.logWarning('FW arb blocked by cross-market validation: mutex pair coherent', {
          market: opp.market.question.substring(0, 50),
          combinedPriceSum: cmOpp.mutexValidation.combinedPriceSum,
        })
        round.status = 'failed'
        this.arbRounds.push(round)
        return
      }
    }

    // ── OVERPRICED PATH: Not available on CLOB ──
    // Requires on-chain splitPosition (buy bundle at $1, sell outcomes at bid).
    // CLOB uses centralized clearing with no on-chain operations.
    if (opp.arbType === 'overpriced') {
      this.log(`OVERPRICED ARB: Skipped — requires on-chain bundle split (not available on CLOB)`)
      activityLogger.logInfo('FW overpriced arb detected but not executable on CLOB', {
        market: opp.market.question.substring(0, 50),
        bidSum: priceSum,
        netProfit: opp.netProfitUSD,
      })
      round.status = 'failed'
      this.arbRounds.push(round)
      return
    }

    try {
      this.activeArbs++
      this.lastTradeTimes.set(opp.market.id, Date.now())

      // Revalidate arb with FRESH order book prices before committing capital.
      try {
        this.scanner.invalidateSnapshotCache(opp.market.id)
        const freshSnapshot = await this.scanner.buildSnapshot(opp.market)

        if (freshSnapshot) {
          const freshResult = this.scanner.revalidate(freshSnapshot)
          if (!freshResult) {
            this.log(`Revalidation: optimizer found no profitable trade — aborting`)
            activityLogger.logInfo('FW arb aborted: revalidation found no profit', {
              market: opp.market.question.substring(0, 50),
            })
            round.status = 'failed'
            this.arbRounds.push(round)
            return
          }

          const freshAskPrices = freshSnapshot.depth.map((d, idx) => {
            const vwap = ArbitrageScanner.computeVWAP(d.asks, this.fwConfig.tradeSize)
            return vwap?.vwap ?? freshSnapshot.prices[idx]
          })
          const freshAskSum = freshAskPrices.reduce((s, p) => s + p, 0)
          const freshDeviation = freshAskSum < 1.0 ? 1 - freshAskSum : 0

          const freshNetProfit = this.scanner.computeNetProfit(
            freshDeviation,
            freshResult.tradeLegs.length,
            opp.feeRateBps
          )
          if (freshNetProfit <= 0) {
            this.log(`Revalidation: net profit $${freshNetProfit.toFixed(4)} ≤ 0 — aborting`)
            activityLogger.logInfo('FW arb aborted: revalidation net profit ≤ 0', {
              market: opp.market.question.substring(0, 50),
              freshNetProfit,
              originalNetProfit: opp.netProfitUSD,
            })
            round.status = 'failed'
            this.arbRounds.push(round)
            return
          }

          opp.result = freshResult
          opp.snapshot = freshSnapshot
          opp.netProfitUSD = freshNetProfit
          this.log(`Revalidation confirmed: net profit $${freshNetProfit.toFixed(4)} (was $${profitDisplay}¢)`)
        }
      } catch (err) {
        this.log(`Revalidation check failed, proceeding with original prices: ${err}`)
      }

      // Position sizing: penny mode → minimum viable, otherwise Kelly-sized
      let effectiveTradeSize: number
      if (useSettingsStore.getState().pennyTraderMode) {
        const minProportion = Math.min(...opp.result.tradeLegs.map(l => l.proportion))
        const maxPrice = Math.max(...opp.result.tradeLegs.map(l => l.price))
        effectiveTradeSize = Math.max(1, (5 * maxPrice) / Math.max(minProportion, 0.01))
      } else {
        const bankroll = useWalletStore.getState().balance
        const kellyFraction = useSettingsStore.getState().kellyFraction
        const fStar = KellySizer.arbKelly(opp.result.guaranteedProfit)
        effectiveTradeSize = KellySizer.sizeBet({ kellyFraction, bankroll, fullKelly: fStar })
      }

      // ── UNDERPRICED PATH: Buy all outcomes — profit locked at resolution ──
      // Paper: π = max(0, (1 - askSum) * tradeSize - N·γ)
      for (let i = 0; i < opp.result.tradeLegs.length; i++) {
        const leg = opp.result.tradeLegs[i]
        const amount = effectiveTradeSize * leg.proportion
        const outcomeName = opp.snapshot.outcomes[leg.outcomeIndex]
        const isBinary = opp.snapshot.outcomes.length === 2
        const outcome: 'yes' | 'no' = isBinary
          ? (outcomeName.toLowerCase() === 'yes' ? 'yes' : 'no')
          : 'yes'

        this.log(`LEG ${i + 1}: ${leg.side} ${outcomeName} $${amount.toFixed(2)} at ${(leg.price * 100).toFixed(1)}¢`)

        const result = await tradingService.placeBet(
          opp.market,
          outcome,
          amount,
          {
            orderType: 'GTD',
            skipGtcFallback: true,
            outcomeIndex: leg.outcomeIndex,
            postOnly: true,       // ensure maker status (0% fee)
            strategy: 'fw',
          }
        )

        const arbLeg: FWArbLeg = {
          tokenId: opp.snapshot.tokenIds[leg.outcomeIndex],
          outcome: opp.snapshot.outcomes[leg.outcomeIndex],
          side: leg.side,
          shares: result.filledSize ?? amount / leg.price,
          price: leg.price,
          orderId: result.orderId,
          executed: result.success,
        }
        round.legs.push(arbLeg)

        if (!result.success) {
          activityLogger.logError(`Leg ${i + 1} failed: ${result.error}`)
          await this.unwindLegs(round, opp)
          round.status = 'failed'
          this.arbRounds.push(round)
          return
        }

        round.totalCost += amount

        activityLogger.logTrade(
          `FW LEG ${i + 1}: ${leg.side} ${opp.snapshot.outcomes[leg.outcomeIndex]} $${amount.toFixed(2)}`,
          { price: leg.price, orderId: result.orderId }
        )
      }

      // All legs succeeded — positions held until resolution
      round.status = 'complete'
      const expectedProfit = (1 - opp.snapshot.prices.reduce((s, p) => s + p, 0)) * effectiveTradeSize
      this.log(`ALL LEGS COMPLETE — Arb locked in! Expected profit at resolution: $${expectedProfit.toFixed(4)}`)

      // Track all positions with PLM for SL/TP monitoring until resolution
      for (const leg of round.legs) {
        if (leg.executed) {
          this.trackFallbackPosition(leg, opp)
        }
      }

      activityLogger.logTrade(
        `FW ARB COMPLETE: ${round.legs.length} legs bought, held to resolution for $${expectedProfit.toFixed(4)} profit`,
        { market: opp.market.question.substring(0, 50), totalCost: round.totalCost }
      )

      // Record trade stats
      this.recordTrade(opp.netProfitUSD, round.totalCost, 0)
      this.emit('tradePlaced', { round })

      // Log entries for backtest framework
      for (const leg of round.legs) {
        tradeLogger.logEntry({
          strategy: 'fw',
          marketId: opp.market.id,
          conditionId: opp.snapshot.conditionId,
          question: opp.market.question,
          outcome: leg.outcome.toLowerCase() === 'yes' ? 'yes' : 'no',
          side: leg.side.toLowerCase() === 'sell' ? 'sell' : 'buy',
          tokenId: leg.tokenId,
          price: leg.price,
          shares: leg.shares,
          costUSD: leg.shares * leg.price,
          orderId: leg.orderId,
          context: {
            klDivergence: opp.result.klDivergence,
            fwGap: opp.result.fwGap,
            guaranteedProfit: opp.result.guaranteedProfit,
            netProfitUSD: opp.netProfitUSD,
            numLegs: opp.result.tradeLegs.length,
            arbType: opp.arbType ?? 'underpriced',
          },
        })
      }

      this.arbRounds.push(round)
    } catch (error) {
      this.logError('Arb execution failed', error)
      activityLogger.logError('FW arb execution failed', error)
      round.status = 'failed'
      this.arbRounds.push(round)
    } finally {
      this.activeArbs--
    }
  }

  /**
   * Unwind executed legs when a later leg fails.
   * Sells back each executed leg via CLOB API, or falls back to PLM tracking.
   */
  private async unwindLegs(round: FWArbRound, opp: ArbOpportunity): Promise<void> {
    this.log('Unwinding executed legs...')

    for (const leg of round.legs) {
      if (!leg.executed) continue

      const outcomeForSell: 'yes' | 'no' = leg.outcome.toLowerCase() === 'yes' ? 'yes' : 'no'

      try {
        const sellResult = await tradingService.placeSell(
          opp.market.slug,
          outcomeForSell,
          leg.shares
        )

        if (sellResult.success) {
          activityLogger.logSell(`Unwound ${leg.outcome}: sold ${leg.shares.toFixed(2)} shares`, {
            orderId: sellResult.orderId,
          })
        } else {
          activityLogger.logWarning(`Unwind sell failed for ${leg.outcome}: ${sellResult.error}`)
          this.trackFallbackPosition(leg, opp)
        }
      } catch (error) {
        this.logError(`Unwind failed for ${leg.outcome}`, error)
        this.trackFallbackPosition(leg, opp)
      }
    }
  }

  /**
   * Track a position with PositionLifecycleManager when sell fails.
   * Uses dynamic import to avoid circular dependency.
   */
  private trackFallbackPosition(leg: FWArbLeg, opp: ArbOpportunity): void {
    import('@/services/trading/PositionLifecycleManager').then((m) => {
      const outcomeIdx = leg.outcome.toLowerCase() === 'yes' ? 0 : 1
      m.positionLifecycleManager.trackPosition({
        marketSlug: opp.market.slug,
        outcome: leg.outcome.toLowerCase() === 'yes' ? 'yes' : 'no',
        question: opp.market.question,
        entryPrice: leg.price,
        size: leg.shares,
        costBasis: leg.shares * leg.price,
        entryTime: Date.now(),
        stopLossPercent: this.fwConfig.stopLossPercent,
        takeProfitPercent: this.fwConfig.takeProfitPercent,
        strategy: 'fw',
        tokenId: opp.market.clobTokenIds?.[outcomeIdx],
      })
    }).catch(err => console.warn('[ProjectFW] Failed to track fallback position:', err))
  }

  /**
   * Check if a market is on cooldown.
   */
  private isOnCooldown(marketId: string): boolean {
    const lastTradeTime = this.lastTradeTimes.get(marketId) || 0
    return Date.now() - lastTradeTime < this.fwConfig.cooldownMs
  }

  // ==========================================
  // SNAPSHOT RECORDING (backtest data collection)
  // ==========================================

  /**
   * Start recording market snapshots to IndexedDB for future backtesting.
   * Piggybacks on the same Gamma + CLOB data the scanner uses.
   * Runs every 60s (2x scan interval) — cheap since Gamma data is already cached.
   * Non-blocking: failures never affect live trading.
   */
  private startSnapshotRecording(): void {
    import('@/services/backtest/SnapshotRecorder').then(async ({ snapshotRecorder }) => {
      try {
        await snapshotRecorder.open()
        snapshotRecorder.startRecording(
          () => this.fetchSnapshotsForRecording(),
          60_000, // 60s interval — 2x the scan interval to avoid API pressure
        )
        activityLogger.logSystem('Snapshot recording started (backtest data collection)')
      } catch (err) {
        console.warn('[ProjectFW] Snapshot recorder failed to start:', err)
      }
    }).catch(() => {
      // Dynamic import failed — non-critical, don't block strategy
    })
  }

  private stopSnapshotRecording(): void {
    import('@/services/backtest/SnapshotRecorder').then(({ snapshotRecorder }) => {
      snapshotRecorder.stopRecording()
    }).catch(() => { /* non-critical */ })
  }

  /**
   * Fetch a batch of market snapshots with ask/bid prices for recording.
   * Samples up to 50 active markets per tick — enough for rich backtest data
   * without hammering the CLOB API.
   */
  private async fetchSnapshotsForRecording(): Promise<RecordedSnapshot[]> {
    const snapshots: RecordedSnapshot[] = []
    try {
      const markets = await gammaClient.getActiveMarkets()

      // Sample: take markets with 2+ outcomes and CLOB token IDs
      const eligible = markets.filter(m =>
        m.active && !m.closed &&
        m.outcomes?.length >= 2 &&
        m.clobTokenIds?.length >= 2
      ).slice(0, 50)

      if (eligible.length === 0) return snapshots

      // Batch-fetch spreads for all tokens
      const allTokenIds = new Set<string>()
      for (const m of eligible) {
        m.clobTokenIds.forEach(tid => allTokenIds.add(tid))
      }

      const spreadsMap = await clobClient.getSpreads(Array.from(allTokenIds))

      for (const market of eligible) {
        const askPrices = market.clobTokenIds.map(tid => {
          const spread = spreadsMap.get(tid)
          return spread?.ask ?? Number(market.outcomePrices[market.clobTokenIds.indexOf(tid)] ?? 0.5)
        })
        const bidPrices = market.clobTokenIds.map(tid => {
          const spread = spreadsMap.get(tid)
          return spread?.bid ?? Number(market.outcomePrices[market.clobTokenIds.indexOf(tid)] ?? 0.5)
        })

        snapshots.push({
          timestamp: new Date().toISOString(),
          marketId: market.id,
          slug: market.slug,
          question: market.question,
          outcomes: market.outcomes,
          outcomePrices: market.outcomePrices.map(Number),
          askPrices,
          bidPrices,
          volume24h: market.volume24hr,
          liquidity: market.liquidity,
          clobTokenIds: market.clobTokenIds,
          conditionId: market.conditionId,
          negRisk: market.negRisk,
        })
      }
    } catch {
      // Non-critical — recording failures never block the bot
    }
    return snapshots
  }

  // ==========================================
  // CROSS-MARKET ANALYSIS
  // ==========================================

  /**
   * Enable or disable cross-market dependency analysis.
   * When enabled, scan results are annotated with mutex validation metadata.
   * Execution is NOT changed — validation is metadata-only.
   */
  setCrossMarket(enabled: boolean): void {
    if (enabled) {
      const eventAnalyzer = new EventAnalyzer(this.fwConfig.crossMarketCacheTTL)
      const dependencyClassifier = new DependencyClassifier({
        maxPairsPerCall: this.fwConfig.maxPairsPerLLMCall,
        cacheTTL: this.fwConfig.crossMarketCacheTTL,
        confidenceThreshold: this.fwConfig.mutexConfidenceThreshold,
      })
      const mutexValidator = new MutexValidator()

      this.scanner.enableCrossMarket(eventAnalyzer, dependencyClassifier, mutexValidator)
      activityLogger.logSystem('Cross-market analysis enabled (validation-only mode)')
    } else {
      this.scanner.disableCrossMarket()
      activityLogger.logSystem('Cross-market analysis disabled')
    }
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  getFWConfig(): ProjectFWConfig {
    return { ...this.fwConfig }
  }

  setFWConfig(config: Partial<ProjectFWConfig>): void {
    this.fwConfig = { ...this.fwConfig, ...config }
    this._config = { ...this._config, ...this.fwConfig }

    // Rebuild scanner with new config
    this.scanner.setOptimizerConfig({
      alpha: this.fwConfig.alpha,
      epsilonD: this.fwConfig.epsilonD,
      epsilon0: this.fwConfig.epsilon0,
      maxIterations: this.fwConfig.maxIterations,
    })
    this.scanner.setConfig({
      minLiquidity: this.fwConfig.minLiquidity,
      minVolume24h: this.fwConfig.minVolume24h,
      maxSpreadBps: this.fwConfig.maxSpreadBps,
      minProfitBps: this.fwConfig.minProfitBps,
      takerFeeBps: this.fwConfig.takerFeeBps,
      gasEstimateUSD: this.fwConfig.gasEstimateUSD,
      enableMultiOutcome: this.fwConfig.enableMultiOutcome,
      tradeSize: this.fwConfig.tradeSize,
    })

    // If running, restart scan interval with new timing
    if (this._status === 'running' && this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = window.setInterval(
        () => this.runFullScan(),
        this.fwConfig.scanIntervalMs
      )
    }

    // Handle cross-market toggle
    if (config.enableCrossMarket !== undefined) {
      this.setCrossMarket(config.enableCrossMarket)
    }

    this.emit('configUpdated', this.fwConfig)
  }

  getArbRounds(): FWArbRound[] {
    return [...this.arbRounds]
  }

  getArbStats(): { rounds: number; completed: number; failed: number; totalProfit: number } {
    const completed = this.arbRounds.filter(r => r.status === 'complete' || r.status === 'merged')
    const failed = this.arbRounds.filter(r => r.status === 'failed')
    const totalProfit = completed.reduce((sum, r) => sum + r.guaranteedProfit, 0)

    return {
      rounds: this.arbRounds.length,
      completed: completed.length,
      failed: failed.length,
      totalProfit,
    }
  }
}

// Export singleton instance
export const projectFWStrategy = new ProjectFWStrategy()
