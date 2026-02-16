import { BaseStrategy } from './BaseStrategy'
import { ArbitrageScanner } from './projectfw/ArbitrageScanner'
import type { ArbOpportunity } from './projectfw/types'
import type { CrossMarketOpportunity } from './projectfw/crossmarket/types'
import { EventAnalyzer } from './projectfw/crossmarket/EventAnalyzer'
import { DependencyClassifier } from './projectfw/crossmarket/DependencyClassifier'
import { MutexValidator } from './projectfw/crossmarket/MutexValidator'
import type { ProjectFWConfig, FWArbRound, FWArbLeg, PriceData } from '@/types'
import { gammaClient } from '@/services/api'
import { realtimeService } from '@/services/realtime'
import { tradingService } from '@/services/trading/TradingService'
import { walletService } from '@/services/wallet'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { openRouterService } from '@/services/llm/OpenRouterService'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'
import { KellySizer } from '@/services/trading/KellySizer'
import { gasOracle } from '@/services/trading/GasOracle'
import { tradeLogger } from '@/services/trading/TradeLogger'
import { rejectionTracker } from '@/services/trading/RejectionTracker'

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
  // Fee model — Polymarket charges ~1% taker fee on market orders.
  // Limit orders pay 0% maker fee, but we assume worst-case taker fills.
  takerFeeBps: 100,
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
 * 4. Strategy executes multi-leg buy (all outcomes) then merges to USDC
 * 5. If merge fails, positions tracked by PLM as safety net
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
   * Execute an arbitrage bundle — buy all outcomes, then merge to USDC.
   *
   * Pattern mirrors DipArbStrategy.handleDipEvent():
   *   1. Execute each leg sequentially via tradingService.placeBet()
   *   2. If any leg fails, unwind previous legs
   *   3. If all succeed, merge positions back to USDC
   *   4. If merge fails, track with PLM as safety net
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

    const arbPath = opp.arbType === 'overpriced' ? 'OVERPRICED (bundle→sell)' : 'UNDERPRICED (buy→merge)'
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

      // Hard gate: if mutex validation found the pair coherent, skip this arb.
      // "isCoherent" means the combined prices are consistent (no real mispricing).
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

    try {
      this.activeArbs++
      this.lastTradeTimes.set(opp.market.id, Date.now())

      // Gas check: skip if gas cost would eat the profit
      // Only the merge is on-chain; CLOB order legs are off-chain (sign + API POST = zero gas)
      try {
        const gasCost = await gasOracle.estimateCostUSD(1, 'merge') // only merge is on-chain
        if (gasCost > opp.netProfitUSD * 0.5) {
          this.log(`Gas too expensive: $${gasCost.toFixed(4)} > 50% of profit $${opp.netProfitUSD.toFixed(4)} — skipping`)
          rejectionTracker.record('gas', 'fw', `$${gasCost.toFixed(4)} > 50% of $${opp.netProfitUSD.toFixed(4)} profit`)
          activityLogger.logInfo('FW arb skipped: gas too expensive', {
            gasCost,
            netProfit: opp.netProfitUSD,
          })
          round.status = 'failed'
          this.arbRounds.push(round)
          return
        }
      } catch {
        // Gas oracle failed — proceed (arb profit calculation already includes static gas estimate)
      }

      // Revalidate arb with FRESH order book prices before committing capital.
      // Between scan finding the opportunity and now, prices may have moved.
      try {
        // Invalidate snapshot cache so buildSnapshot fetches fresh order books
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

          // Recompute askSum from fresh order books using VWAP pricing
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

          // Use fresh prices for execution
          opp.result = freshResult
          opp.snapshot = freshSnapshot
          opp.netProfitUSD = freshNetProfit
          this.log(`Revalidation confirmed: net profit $${freshNetProfit.toFixed(4)} (was $${profitDisplay}¢)`)
        }
      } catch (err) {
        // Revalidation failed — proceed with original data (best effort)
        this.log(`Revalidation check failed, proceeding with original prices: ${err}`)
      }

      // Position sizing: penny mode → $1, otherwise Kelly-sized by arb profit ratio
      let effectiveTradeSize: number
      if (useSettingsStore.getState().pennyTraderMode) {
        // Polymarket CLOB requires minimum 5 shares per leg.
        // Each leg gets effectiveTradeSize * leg.proportion dollars at leg.price,
        // so ensure the smallest leg yields >= 5 shares.
        const minProportion = Math.min(...opp.result.tradeLegs.map(l => l.proportion))
        const maxPrice = Math.max(...opp.result.tradeLegs.map(l => l.price))
        effectiveTradeSize = Math.max(1, (5 * maxPrice) / Math.max(minProportion, 0.01))
      } else {
        const bankroll = useWalletStore.getState().usdcBridgedBalance ?? useWalletStore.getState().usdcBalance
        const kellyFraction = useSettingsStore.getState().kellyFraction
        const fStar = KellySizer.arbKelly(opp.result.guaranteedProfit)
        effectiveTradeSize = KellySizer.sizeBet({ kellyFraction, bankroll, fullKelly: fStar })
      }

      // ── OVERPRICED PATH: Buy-a-Bundle at $1, sell outcomes at bid ──
      // Paper: π = max(0, (bidSum - 1) * tradeSize - N·γ) - gas
      // Buy-a-Bundle avoids the 2N·γ short-sell penalty from the paper.
      if (opp.arbType === 'overpriced') {
        // Step 1: Buy a complete set (on-chain splitPosition or mintSet)
        const bundleShares = effectiveTradeSize // $1 per complete set = effectiveTradeSize sets
        this.log(`OVERPRICED ARB: Buy-a-Bundle (${bundleShares.toFixed(2)} sets at $1 each)`)

        try {
          const splitResult = await walletService.splitPosition(
            opp.market.conditionId,
            bundleShares
          )

          if (!splitResult.success) {
            this.log(`Bundle purchase failed: ${splitResult.error} — aborting`)
            activityLogger.logError(`FW overpriced: bundle purchase failed: ${splitResult.error}`)
            round.status = 'failed'
            this.arbRounds.push(round)
            return
          }

          round.totalCost = bundleShares // Each set costs $1
          activityLogger.logTrade(
            `FW BUNDLE: Bought ${bundleShares.toFixed(2)} complete sets at $1`,
            { conditionId: opp.market.conditionId, txHash: splitResult.txHash }
          )
        } catch (error) {
          this.logError('Bundle purchase threw', error)
          round.status = 'failed'
          this.arbRounds.push(round)
          return
        }

        // Step 2: Sell each outcome at bid price
        for (let i = 0; i < opp.result.tradeLegs.length; i++) {
          const leg = opp.result.tradeLegs[i]
          const tokenId = opp.snapshot.tokenIds[leg.outcomeIndex]
          const sharesToSell = bundleShares // 1 share of each outcome per set

          this.log(`SELL LEG ${i + 1}: SELL ${opp.snapshot.outcomes[leg.outcomeIndex]} ${sharesToSell.toFixed(2)} shares at ${(leg.price * 100).toFixed(1)}¢`)

          const sellResult = await tradingService.placeSell(tokenId, sharesToSell)

          const arbLeg: FWArbLeg = {
            tokenId,
            outcome: opp.snapshot.outcomes[leg.outcomeIndex],
            side: 'SELL',
            shares: sellResult.filledSize ?? sharesToSell,
            price: leg.price,
            orderId: sellResult.orderId,
            executed: sellResult.success,
          }
          round.legs.push(arbLeg)

          if (!sellResult.success) {
            activityLogger.logError(`Sell leg ${i + 1} failed: ${sellResult.error}`)
            // Don't unwind — we own the shares, PLM will track them
            this.trackFallbackPosition(arbLeg, opp)
          } else {
            activityLogger.logSell(
              `FW SELL ${i + 1}: ${opp.snapshot.outcomes[leg.outcomeIndex]} ${sharesToSell.toFixed(2)} shares`,
              { price: leg.price, orderId: sellResult.orderId }
            )
          }
        }

        // All sell legs attempted
        const successLegs = round.legs.filter(l => l.executed).length
        round.status = successLegs === opp.result.tradeLegs.length ? 'complete' : 'partial'
        this.log(`OVERPRICED ARB: ${successLegs}/${opp.result.tradeLegs.length} sell legs executed`)
      } else {
        // ── UNDERPRICED PATH: Buy all outcomes, merge for $1 ──
        // Paper: π = max(0, (1 - askSum) * tradeSize - N·γ) - gas
        for (let i = 0; i < opp.result.tradeLegs.length; i++) {
          const leg = opp.result.tradeLegs[i]
          const amount = effectiveTradeSize * leg.proportion
          const outcomeName = opp.snapshot.outcomes[leg.outcomeIndex]
          // For binary markets: map to 'yes'/'no'. For multi-outcome: use explicit outcomeIndex.
          const isBinary = opp.snapshot.outcomes.length === 2
          const outcome: 'yes' | 'no' = isBinary
            ? (outcomeName.toLowerCase() === 'yes' ? 'yes' : 'no')
            : 'yes' // placeholder — outcomeIndex below overrides the token selection

          this.log(`LEG ${i + 1}: ${leg.side} ${outcomeName} $${amount.toFixed(2)} at ${(leg.price * 100).toFixed(1)}¢`)

          const result = await tradingService.placeBet(
            opp.market,
            outcome,
            amount,
            { skipGtcFallback: true, outcomeIndex: leg.outcomeIndex }
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
            // Leg failed — unwind previous legs
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

        // All legs succeeded
        round.status = 'complete'
        this.log('ALL LEGS COMPLETE — Arb locked in!')

        // Merge positions back to USDC
        await this.mergePositions(round, opp)
      }

      // Record trade stats
      this.recordTrade(opp.netProfitUSD, round.totalCost, 0)
      this.emit('tradePlaced', { round })

      // Log entry for backtest framework
      for (const leg of round.legs) {
        tradeLogger.logEntry({
          strategy: 'fw',
          marketId: opp.market.id,
          conditionId: opp.market.conditionId,
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
   * Sells back each executed leg, or falls back to PLM tracking.
   */
  private async unwindLegs(round: FWArbRound, opp: ArbOpportunity): Promise<void> {
    this.log('Unwinding executed legs...')

    for (const leg of round.legs) {
      if (!leg.executed) continue

      try {
        const sellResult = await tradingService.placeSell(
          leg.tokenId,
          leg.shares
        )

        if (sellResult.success) {
          activityLogger.logSell(`Unwound ${leg.outcome}: sold ${leg.shares.toFixed(2)} shares`, {
            orderId: sellResult.orderId,
          })
        } else {
          // Failed to sell — track with PLM as safety net
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
   * Merge all positions back to USDC (guaranteed $1 per complete set).
   * Same pattern as DipArbStrategy.
   */
  private async mergePositions(round: FWArbRound, opp: ArbOpportunity): Promise<void> {
    this.log('Merging positions back to USDC...')

    // Merge amount is the minimum shares across all legs
    const minShares = Math.min(...round.legs.map(l => l.shares))

    // Retry merge up to 3 times with exponential backoff (2s, 4s, 8s)
    const MAX_MERGE_RETRIES = 3
    let mergeSuccess = false

    for (let attempt = 1; attempt <= MAX_MERGE_RETRIES; attempt++) {
      try {
        const mergeResult = await walletService.mergePositions(
          opp.market.conditionId,
          minShares
        )

        if (mergeResult.success) {
          mergeSuccess = true
          round.status = 'merged'
          round.mergeResult = { success: true, txHash: mergeResult.txHash }

          const profit = (1 - opp.snapshot.prices.reduce((s, p) => s + p, 0)) * minShares
          activityLogger.logTrade(
            `FW MERGE: ${minShares.toFixed(2)} sets → +$${profit.toFixed(4)} profit`,
            { conditionId: opp.market.conditionId, txHash: mergeResult.txHash, attempt }
          )
          this.log(`Merge successful (attempt ${attempt})! Profit: $${profit.toFixed(4)}`)
          break
        }

        this.log(`Merge attempt ${attempt}/${MAX_MERGE_RETRIES} failed: ${mergeResult.error}`)

        if (attempt === MAX_MERGE_RETRIES) {
          round.mergeResult = { success: false, error: mergeResult.error }
          activityLogger.logWarning(`Merge failed after ${MAX_MERGE_RETRIES} attempts: ${mergeResult.error} — positions held until resolution`)
        } else {
          const delayMs = 2000 * Math.pow(2, attempt - 1)
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
      } catch (error) {
        this.log(`Merge attempt ${attempt}/${MAX_MERGE_RETRIES} threw: ${error}`)

        if (attempt === MAX_MERGE_RETRIES) {
          round.mergeResult = { success: false, error: String(error) }
          this.logError('Merge failed after all retries', error)
        } else {
          const delayMs = 2000 * Math.pow(2, attempt - 1)
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
      }
    }

    // If all retries failed, track with PLM as safety net
    if (!mergeSuccess) {
      for (const leg of round.legs) {
        if (leg.executed) {
          this.trackFallbackPosition(leg, opp)
        }
      }
    }
  }

  /**
   * Track a position with PositionLifecycleManager when sell/merge fails.
   * Uses dynamic import to avoid circular dependency (same pattern as DipArb).
   */
  private trackFallbackPosition(leg: FWArbLeg, opp: ArbOpportunity): void {
    Promise.all([
      import('@/services/trading/PositionLifecycleManager'),
      import('@/services/api').then(api => api.clobClient.getFeeRateBps(leg.tokenId)).catch(() => undefined),
    ]).then(([m, feeRate]) => {
      m.positionLifecycleManager.trackPosition({
        tokenId: leg.tokenId,
        marketId: opp.market.id,
        conditionId: opp.market.conditionId,
        outcome: leg.outcome.toLowerCase() === 'yes' ? 'yes' : 'no',
        question: opp.market.question,
        entryPrice: leg.price,
        size: leg.shares,
        costBasis: leg.shares * leg.price,
        entryTime: Date.now(),
        stopLossPercent: this.fwConfig.stopLossPercent,
        takeProfitPercent: this.fwConfig.takeProfitPercent,
        strategy: 'fw',
        negRisk: opp.market.negRisk,
        takerFeeBps: feeRate,
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

      // Set cross-market LLM budget
      openRouterService.setDailyBudget(this.fwConfig.crossMarketBudgetUSD, 'crossMarket')

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

    // Update cross-market LLM budget if changed
    if (config.crossMarketBudgetUSD !== undefined) {
      openRouterService.setDailyBudget(config.crossMarketBudgetUSD, 'crossMarket')
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
