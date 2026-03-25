import { BaseStrategy } from './BaseStrategy'
import type { LLMPredictionConfig, Market } from '@/types'
import { marketScanner } from '@/services/trading/MarketScanner'
import { tradingService } from '@/services/trading/TradingService'
import { ollamaService, OllamaService } from '@/services/llm'
import { gatherMarketContext, enrichWithPriceTrend, gatherCryptoContext } from '@/services/llm/MarketContextBuilder'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useWalletStore, useSettingsStore } from '@/stores'
import { KellySizer } from '@/services/trading/KellySizer'
import { edgeTracker } from '@/services/trading/EdgeTracker'
import { calibrationTracker } from '@/services/trading/CalibrationTracker'
import { tradeLogger } from '@/services/trading/TradeLogger'
import { rejectionTracker } from '@/services/trading/RejectionTracker'

const DEFAULT_CONFIG: LLMPredictionConfig = {
  baseSize: 0.10, // 10% of capital ($1 on $10 bankroll)
  confidenceMultiplier: 2.0,
  maxPositionSize: 0.15, // 15% max — small bankroll needs room for minimum trades
  maxTradeSize: 1.00, // Hard cap per trade ($10 bankroll)
  minOdds: 0.15, // Widened: was 0.40, too tight — filtered out everything
  maxOdds: 0.85, // Widened: was 0.60, too tight — filtered out everything
  minLiquidity: 1000, // Lowered: was 2000
  minVolume24h: 500, // Lowered: was 1000
  maxSpread: 0.05,
  maxCreatedHours: 0, // 0 = no age limit — scan ALL active markets (was 24h, too restrictive)
  orderType: 'GTD',      // GTD-first: fill as maker (0% fees) instead of taker (up to 1.56%)
  gtdExpiryMinutes: 10,  // 10 min — LLM signals stable over 5-30 min
  maxSlippage: 0.02,
  executionCooldown: 5000,
  stopLossPercent: 0.15,
  takeProfitPercent: 0.30, // Realistic TP that fires before 4h time-exit (was 0.85 — never triggered)
  maxOpenPositions: 7,
  maxCapitalExposure: 0.25,
  minConfidence: 0.48, // Lowered from 0.52 — GTD-first mode eliminates taker fees, lowering break-even
  excludedCategories: ['Crypto Price', 'Crypto'], // Exclude all crypto-price markets (category naming varies)
  gtcFallbackEnabled: true,
  gtcExpiryMinutes: 5,
}

/**
 * LLM Prediction Strategy
 * Uses AI analysis to trade on prediction markets with balanced odds
 */
export class LLMPredictionStrategy extends BaseStrategy {
  name = 'LLM Prediction'
  description = 'AI-powered market analysis with web search capabilities'
  strategyType = 'ai' as const

  private llmConfig: LLMPredictionConfig = DEFAULT_CONFIG
  private scanInterval: number | null = null
  private cryptoScanInterval: number | null = null

  constructor(config?: Partial<LLMPredictionConfig>) {
    super()
    if (config) {
      this.llmConfig = { ...DEFAULT_CONFIG, ...config }
    }
    this._config = { enabled: false, ...this.llmConfig }
  }

  /**
   * Initialize the strategy
   */
  async initialize(): Promise<void> {
    this.log('Initializing LLM Prediction Strategy')
    
    // Configure market scanner with our settings
    marketScanner.setConfig({
      minLiquidity: this.llmConfig.minLiquidity,
      minVolume: this.llmConfig.minVolume24h,
      maxAgeHours: this.llmConfig.maxCreatedHours,
      minOdds: this.llmConfig.minOdds,
      maxOdds: this.llmConfig.maxOdds,
      excludedCategories: this.llmConfig.excludedCategories,
    })

    // Configure trading service
    tradingService.setConfig({
      maxSlippage: this.llmConfig.maxSlippage,
      executionCooldown: this.llmConfig.executionCooldown,
    })

    this.setStatus('idle')
    this.log('LLM Prediction Strategy initialized')
  }

  /**
   * Start the strategy
   */
  async start(): Promise<void> {
    if (this._status === 'running') {
      this.log('Strategy already running')
      return
    }

    this.log('Starting LLM Prediction Strategy')
    this.setStatus('running')

    // Clear any stale interval before creating a new one
    if (this.scanInterval) {
      clearInterval(this.scanInterval)
    }

    // Run first scan immediately, then start the adaptive loop
    await this.runScanCycle()

    // Start scanning loop with adaptive timing (tick() will schedule the NEXT scan)
    this.startAdaptiveScanLoop()

    // Start crypto scan loop if enabled
    if (this.llmConfig.cryptoLLMEnabled) {
      this.startCryptoScanLoop()
    }

    activityLogger.logSystem('LLM Prediction Strategy started')
  }

  /**
   * Stop the strategy
   */
  async stop(): Promise<void> {
    this.log('Stopping LLM Prediction Strategy')

    if (this.scanInterval) {
      clearTimeout(this.scanInterval)
      this.scanInterval = null
    }
    if (this.cryptoScanInterval) {
      clearTimeout(this.cryptoScanInterval)
      this.cryptoScanInterval = null
    }

    this.setStatus('idle')
    activityLogger.logSystem('LLM Prediction Strategy stopped')
  }

  /**
   * Adaptive scan loop — increases frequency near market resolution events.
   * Normal: 60s. Near event (< 30 min): 30s. Very near (< 5 min): 15s.
   */
  private startAdaptiveScanLoop(): void {
    const tick = async () => {
      if (!this._enabled || this._status !== 'running') return

      await this.runScanCycle()

      // Determine next scan delay based on nearest tracked market end time
      let nextDelay = 45_000 // default 45s (was 60s — more throughput)
      try {
        const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
        const positions = positionLifecycleManager.getPositions().filter(p => p.strategy === 'llm')
        // Check if any position's market resolves soon (we don't store endDate on positions,
        // so we just use hold time as a proxy — positions held > 3h get faster scans)
        for (const pos of positions) {
          const heldMs = Date.now() - pos.entryTime
          if (heldMs > 3 * 60 * 60 * 1000) {
            nextDelay = Math.min(nextDelay, 15_000) // 15s near time exit
          } else if (heldMs > 2 * 60 * 60 * 1000) {
            nextDelay = Math.min(nextDelay, 30_000) // 30s
          }
        }
      } catch {
        // Fall back to default
      }

      this.scanInterval = window.setTimeout(() => tick(), nextDelay)
    }

    // Schedule the first repeat after default delay (start() already ran the initial scan)
    this.scanInterval = window.setTimeout(() => tick(), 45_000)
  }

  /**
   * Run a scan cycle
   */
  private async runScanCycle(): Promise<void> {
    if (!this._enabled || this._status !== 'running') {
      return
    }

    try {
      // EdgeTracker circuit breaker: stop trading if empirical win rate shows negative edge
      const tradeCheck = edgeTracker.shouldTrade('llm', 200) // 200 bps ≈ 2% round-trip
      if (!tradeCheck.allowed) {
        this.log(`EdgeTracker blocked: ${tradeCheck.reason}`)
        activityLogger.logWarning(`LLM scan blocked by EdgeTracker: ${tradeCheck.reason}`)
        rejectionTracker.record('edge_tracker', 'llm', tradeCheck.reason)
        return
      }

      this.log('Starting market scan')
      activityLogger.logScan('Scanning for eligible markets')

      // Scan for markets and use score-sorted eligible list
      const results = await marketScanner.scan()
      const eligible = marketScanner.getEligibleMarkets() // Already sorted by quality score (desc)
      const rejected = results.filter(r => !r.eligible)

      // Summarize rejection reasons for diagnostics
      const rejectionCounts: Record<string, number> = {}
      for (const r of rejected) {
        // Group by first word of reason for summary (e.g. "Liquidity", "Odds", "Market")
        const key = r.reason?.split(/[:(]/)[0].trim() || 'Unknown'
        rejectionCounts[key] = (rejectionCounts[key] || 0) + 1
      }

      this.log(`Found ${eligible.length} eligible markets out of ${results.length}`)
      activityLogger.logScan(`Scanned ${results.length} markets → ${eligible.length} eligible`, {
        total: results.length,
        eligible: eligible.length,
        rejections: rejectionCounts,
      })

      // Check if we can open more positions (PLM is the source of truth)
      const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
      let llmPositionCount = positionLifecycleManager.getPositions()
        .filter(p => p.strategy === 'llm').length
      if (llmPositionCount >= this.llmConfig.maxOpenPositions) {
        // Auto-clean stale positions before giving up
        const cleaned = positionLifecycleManager.cleanStalePositions()
        if (cleaned > 0) {
          llmPositionCount = positionLifecycleManager.getPositions()
            .filter(p => p.strategy === 'llm').length
        }
        if (llmPositionCount >= this.llmConfig.maxOpenPositions) {
          this.log(`Maximum open positions reached (${llmPositionCount}/${this.llmConfig.maxOpenPositions}), skipping analysis`)
          activityLogger.logWarning(`LLM scan skipped: ${llmPositionCount}/${this.llmConfig.maxOpenPositions} positions open — close or remove stale positions to resume trading`)
          rejectionTracker.record('position_limit', 'llm', `${llmPositionCount}/${this.llmConfig.maxOpenPositions} positions`)
          return
        }
      }

      // Cross-strategy capital guard: check total exposure across ALL strategies
      // Prevents LLM from spending money that BTC/other strategies already committed
      const walletState = useWalletStore.getState()
      const totalBalance = walletState.balance
      const allPositions = positionLifecycleManager.getPositions()
      const totalCommitted = allPositions.reduce((sum, p) => sum + (p.costBasis || 0), 0)
      const availableCapital = totalBalance - totalCommitted
      const maxExposure = totalBalance * this.llmConfig.maxCapitalExposure
      const llmCommitted = allPositions
        .filter(p => p.strategy === 'llm')
        .reduce((sum, p) => sum + (p.costBasis || 0), 0)

      if (llmCommitted >= maxExposure) {
        this.log(`LLM capital exposure $${llmCommitted.toFixed(2)} >= max $${maxExposure.toFixed(2)} (${(this.llmConfig.maxCapitalExposure * 100).toFixed(0)}% of $${totalBalance.toFixed(2)})`)
        rejectionTracker.record('capital_exposure', 'llm', `$${llmCommitted.toFixed(2)} >= $${maxExposure.toFixed(2)}`)
        return
      }
      if (availableCapital < 1.00) {
        this.log(`Insufficient available capital: $${availableCapital.toFixed(2)} (total $${totalBalance.toFixed(2)}, committed $${totalCommitted.toFixed(2)} across all strategies)`)
        rejectionTracker.record('capital_exposure', 'llm', `only $${availableCapital.toFixed(2)} uncommitted`)
        return
      }

      // Analyze top markets (enrich top 5 with price trend data, rest get sync-only context)
      let trendBudget = 5
      for (const market of eligible.slice(0, 15)) {
        if (!this._enabled) break
        if (ollamaService.isCircuitBreakerActive()) {
          this.log('OpenRouter circuit breaker active — skipping remaining markets')
          break
        }

        await this.analyzeAndTrade(market, trendBudget > 0)
        trendBudget--
      }
    } catch (error) {
      this.logError('Scan cycle failed', error)
      activityLogger.logError('Scan cycle failed', error)
    }
  }

  /**
   * Analyze a market and potentially trade
   */
  private async analyzeAndTrade(market: Market, fetchTrend: boolean = false): Promise<void> {
    try {
      this.log(`Analyzing market: ${market.question.substring(0, 50)}...`)
      activityLogger.logAnalysis(`Analyzing: ${market.question.substring(0, 50)}...`)

      // Gather enrichment context from in-memory singletons (synchronous, no API calls)
      const slugForContext = market.slug
      let context = gatherMarketContext(market, slugForContext, 'llm')

      // Optionally enrich with price trend (async, rate-limited to top 5 per cycle)
      if (fetchTrend) {
        context = await enrichWithPriceTrend(context, slugForContext)
      }

      // Get LLM prediction with enriched context
      const prediction = await ollamaService.analyzeMarket(market, context)

      this.log(`Prediction: ${prediction.predictedOutcome} (${(prediction.confidence * 100).toFixed(1)}% confidence)`)
      activityLogger.logAnalysis(`Prediction: ${prediction.predictedOutcome}`, {
        confidence: prediction.confidence,
        reasoning: prediction.reasoning.substring(0, 200),
      })

      // Adaptive confidence threshold — nudge based on empirical win rate
      let effectiveMinConfidence = this.llmConfig.minConfidence
      const edge = edgeTracker.getStrategyEdge('llm')
      if (edge.isReliable) {
        if (edge.winRate > 0.60) {
          // Winning well → slightly lower bar (more trades)
          effectiveMinConfidence = Math.max(0.50, this.llmConfig.minConfidence - 0.02)
        } else if (edge.winRate < 0.50) {
          // Losing → tighter filter (fewer, higher-quality trades)
          effectiveMinConfidence = Math.min(0.70, this.llmConfig.minConfidence + 0.03)
        }
        if (effectiveMinConfidence !== this.llmConfig.minConfidence) {
          this.log(`Adaptive threshold: ${(this.llmConfig.minConfidence * 100).toFixed(0)}% → ${(effectiveMinConfidence * 100).toFixed(0)}% (win rate ${(edge.winRate * 100).toFixed(0)}%)`)
        }
      }

      // Check confidence threshold
      if (prediction.confidence < effectiveMinConfidence) {
        this.log(`Confidence ${(prediction.confidence * 100).toFixed(1)}% below threshold ${(effectiveMinConfidence * 100).toFixed(1)}%`)
        rejectionTracker.record('confidence', 'llm', `${(prediction.confidence * 100).toFixed(1)}% < ${(effectiveMinConfidence * 100).toFixed(1)}%`)
        return
      }

      // Record prediction for calibration tracking (with category for per-category accuracy)
      calibrationTracker.recordPrediction(market.id, prediction.confidence, prediction.predictedOutcome, market.category)

      // Apply calibration correction — adjusts LLM confidence based on historical accuracy
      // Skip calibration if insufficient samples (noisy early adjustments hurt more than help)
      const rawConfidence = prediction.confidence
      const hasEnoughCalibrationData = calibrationTracker.getTotalPredictions() >= 20
      const calibratedConfidence = hasEnoughCalibrationData
        ? calibrationTracker.calibrate(rawConfidence)
        : rawConfidence
      if (calibratedConfidence < effectiveMinConfidence) {
        console.warn(`[LLM Strategy] BLOCKED by calibration: ${(calibratedConfidence * 100).toFixed(1)}% (raw: ${(rawConfidence * 100).toFixed(1)}%) < ${(effectiveMinConfidence * 100).toFixed(1)}% threshold`)
        this.log(`Calibrated confidence ${(calibratedConfidence * 100).toFixed(1)}% (raw: ${(rawConfidence * 100).toFixed(1)}%) below threshold`)
        rejectionTracker.record('calibration', 'llm', `calibrated ${(calibratedConfidence * 100).toFixed(1)}% < ${(effectiveMinConfidence * 100).toFixed(1)}%`)
        return
      }

      // Multi-model signal fusion — get second opinion for borderline/high-stakes trades
      let finalConfidence = calibratedConfidence
      const isBorderline = calibratedConfidence >= effectiveMinConfidence &&
                           calibratedConfidence < effectiveMinConfidence + 0.15
      if (isBorderline) {
        try {
          const secondOpinion = await ollamaService.getSecondOpinion(market, context)
          const fusion = OllamaService.fuseSignals(prediction, secondOpinion)
          if (fusion.fusionApplied) {
            this.log(`Signal fusion: ${(calibratedConfidence * 100).toFixed(1)}% → ${(fusion.confidence * 100).toFixed(1)}% (${secondOpinion?.predictedOutcome === prediction.predictedOutcome ? 'agree' : 'disagree'})`)
            finalConfidence = fusion.confidence
            if (finalConfidence < effectiveMinConfidence) {
              this.log(`Fused confidence ${(finalConfidence * 100).toFixed(1)}% below threshold after disagreement — skipping`)
              rejectionTracker.record('confidence', 'llm', `fusion disagreement: ${(finalConfidence * 100).toFixed(1)}%`)
              return
            }
          }
        } catch {
          // Second opinion failed — proceed with primary
        }
      }

      // Calculate position size using FUSED/CALIBRATED confidence
      const outcomeIdx = prediction.predictedOutcome === 'yes' ? 0 : 1
      const marketPrice = market.outcomePrices[outcomeIdx]
      const positionSize = this.calculatePositionSize(finalConfidence, marketPrice)
      
      // Place the trade
      this.log(`Placing ${prediction.predictedOutcome.toUpperCase()} bet: $${positionSize.toFixed(2)}`)
      
      // GTD-first: place limit order 1¢ below market to fill as maker (0% fees).
      // Falls back to FOK if config says so (user toggle).
      const isGtd = this.llmConfig.orderType === 'GTD'
      const limitPrice = isGtd ? Math.max(0.01, marketPrice - 0.01) : undefined
      const result = await tradingService.placeBet(
        market,
        prediction.predictedOutcome,
        positionSize,
        {
          stopLossPercent: this.llmConfig.stopLossPercent,
          takeProfitPercent: this.llmConfig.takeProfitPercent,
          ...(isGtd && {
            orderType: 'GTD' as const,
            gtdExpiryMs: this.llmConfig.gtcExpiryMinutes * 60 * 1000,
            limitPrice,
            skipGtcFallback: true, // already GTD — no double-fallback
          }),
        },
      )

      if (result.success) {
        if (result.pending) {
          // GTD order placed but not yet filled — GtcOrderManager handles
          // fill detection and PLM handoff. We just log and count it.
          activityLogger.logTrade(`BUY ${prediction.predictedOutcome.toUpperCase()} $${positionSize.toFixed(2)} (GTD pending)`, {
            marketId: market.id,
            orderId: result.orderId,
          })
        } else {
          // Immediate fill (FOK succeeded)
          activityLogger.logTrade(`BUY ${prediction.predictedOutcome.toUpperCase()} $${positionSize.toFixed(2)}`, {
            marketId: market.id,
            orderId: result.orderId,
            txHash: result.txHash,
          })

          // Track position for stop-loss / take-profit enforcement
          const outcomeIndex = prediction.predictedOutcome === 'yes' ? 0 : 1
          const entryPrice = result.avgPrice ?? market.outcomePrices[outcomeIndex]
          import('@/services/trading/PositionLifecycleManager').then(m => {
            m.positionLifecycleManager.trackPosition({
              marketSlug: market.slug,
              outcome: prediction.predictedOutcome,
              question: market.question,
              entryPrice,
              size: result.filledSize || positionSize / entryPrice,
              costBasis: positionSize,
              entryTime: Date.now(),
              stopLossPercent: this.llmConfig.stopLossPercent,
              takeProfitPercent: this.llmConfig.takeProfitPercent,
              strategy: 'llm',
              tokenId: market.clobTokenIds?.[outcomeIndex],
              maxHoldMs: 4 * 60 * 60 * 1000, // 4 hour max hold for LLM positions
              partialCloseAt: this.llmConfig.takeProfitPercent * 0.6, // partial close at 60% of TP target
            })
          }).catch(err => console.warn('[LLM] Failed to track position:', err))

          // Log to backtest framework with full context
          tradeLogger.logEntry({
            marketId: market.id,
            slug: market.slug,
            question: market.question,
            outcomes: market.outcomes || [],
            strategy: 'llm',
            side: 'BUY',
            outcome: prediction.predictedOutcome,
            modelProbability: rawConfidence,
            calibratedProbability: calibratedConfidence,
            marketPrice,
            kellyFraction: useSettingsStore.getState().kellyFraction,
            kellyBetSize: positionSize,
            actualBetSize: positionSize,
            orderType: 'FOK',
            fillPrice: result.avgPrice ?? entryPrice,
            filledSize: result.filledSize,
            success: true,
            orderId: result.orderId,
          })
        }

        this.emit('tradePlaced', { market, prediction, result })
      } else {
        console.warn(`[LLM Strategy] Trade REJECTED: ${result.error} (market: ${market.question.substring(0, 50)})`)
        activityLogger.logError(`Trade failed: ${result.error}`)
      }
    } catch (error) {
      this.logError(`Analysis failed for market ${market.id}`, error)
      activityLogger.logError('Market analysis failed', error)
    }
  }

  /**
   * Calculate position size using Kelly Criterion.
   * f* = (bp - q) / b where b = (1-price)/price, p = model confidence.
   * Fractional Kelly (from settings) scales the optimal fraction down for safety.
   */
  private calculatePositionSize(confidence: number, marketPrice: number): number {
    // Penny mode: fixed $1.00 size (Polymarket minimum). Skip maxTradeSize cap —
    // capping below $1.00 causes "Order too small" rejections.
    // Polymarket CLOB requires minimum 5 shares per order
    if (useSettingsStore.getState().pennyTraderMode) return Math.max(1.0, 5 * marketPrice)

    const walletState = useWalletStore.getState()
    const bankroll = walletState.balance
    const baseKellyFraction = useSettingsStore.getState().kellyFraction

    // Scale Kelly fraction by confidence bucket — bet bigger on stronger signals
    let kellyFraction = baseKellyFraction
    if (confidence >= 0.80) {
      kellyFraction = Math.min(baseKellyFraction * 1.5, 0.50) // High confidence boost, capped at half Kelly
    } else if (confidence >= 0.70) {
      kellyFraction = baseKellyFraction * 1.2
    }

    const adaptiveProb = edgeTracker.getAdaptiveModelProb('llm', confidence)
    const fStar = KellySizer.polymarketKelly(adaptiveProb, marketPrice)
    let size = KellySizer.sizeBet({ kellyFraction, bankroll, fullKelly: fStar })

    // Enforce hard dollar cap per trade (only in non-penny mode)
    if (this.llmConfig.maxTradeSize > 0) {
      size = Math.min(size, this.llmConfig.maxTradeSize)
    }

    // Floor at $1.00 (Polymarket minimum) to avoid silent rejections
    size = Math.max(size, 1.00)

    return Math.round(size * 100) / 100
  }

  /**
   * Get current open position count (derived from PLM — survives restarts)
   */
  async getOpenPositionCount(): Promise<number> {
    try {
      const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
      return positionLifecycleManager.getPositions()
        .filter(p => p.strategy === 'llm').length
    } catch {
      return 0
    }
  }

  // ─── Crypto LLM Scan Loop ────────────────────────────────────

  /**
   * Start a dedicated scan loop for crypto prediction markets.
   * Runs independently from the general scan loop, with its own interval.
   */
  private startCryptoScanLoop(): void {
    const interval = this.llmConfig.cryptoScanIntervalMs ?? 30_000

    const tick = async () => {
      if (!this._enabled || this._status !== 'running' || !this.llmConfig.cryptoLLMEnabled) return

      try {
        await this.runCryptoScanCycle()
      } catch (error) {
        this.logError('Crypto scan cycle failed', error)
      }

      this.cryptoScanInterval = window.setTimeout(() => tick(), interval)
    }

    // Run first crypto scan immediately
    this.runCryptoScanCycle().catch(e => this.logError('Initial crypto scan failed', e))
    // Then schedule repeating
    this.cryptoScanInterval = window.setTimeout(() => tick(), interval)
  }

  /**
   * Scan only crypto prediction markets and analyze with crypto-enriched prompts.
   */
  private async runCryptoScanCycle(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    try {
      this.log('[Crypto] Starting crypto market scan')

      // Get eligible markets from the general scanner (already populated by main loop)
      // Filter to crypto categories only
      const allResults = marketScanner.getScanResults()
      const cryptoMarkets = allResults
        .filter(r => r.eligible)
        .filter(r => {
          const cat = r.market.category?.toLowerCase() || ''
          const q = r.market.question.toLowerCase()
          return cat.includes('crypto') ||
            q.includes('btc') || q.includes('bitcoin') ||
            q.includes('eth') || q.includes('ethereum') ||
            q.includes('sol') || q.includes('solana') ||
            q.includes('xrp') || q.includes('ripple')
        })
        .sort((a, b) => b.score - a.score)
        .map(r => r.market)

      if (cryptoMarkets.length === 0) {
        this.log('[Crypto] No eligible crypto markets found')
        return
      }

      this.log(`[Crypto] Found ${cryptoMarkets.length} crypto markets`)

      // Check position limits (shared with general loop)
      const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
      const llmPositionCount = positionLifecycleManager.getPositions()
        .filter(p => p.strategy === 'llm').length
      if (llmPositionCount >= this.llmConfig.maxOpenPositions) {
        this.log(`[Crypto] Max positions reached (${llmPositionCount}/${this.llmConfig.maxOpenPositions})`)
        return
      }

      // Analyze top crypto markets
      const cryptoMinConf = this.llmConfig.cryptoMinConfidence ?? 0.55
      const cryptoModel = this.llmConfig.cryptoModel

      for (const market of cryptoMarkets.slice(0, 5)) {
        if (!this._enabled) break

        try {
          // Gather general + crypto-specific context
          const slugForContext = market.slug
          let context = gatherMarketContext(market, slugForContext, 'llm')
          context = gatherCryptoContext(context, market)

          // Use crypto-specific prompt via analyzeCryptoMarket
          const prediction = await ollamaService.analyzeCryptoMarket(market, context, cryptoModel)

          this.log(`[Crypto] ${market.question.substring(0, 40)}: ${prediction.predictedOutcome} (${(prediction.confidence * 100).toFixed(1)}%)`)

          if (prediction.confidence < cryptoMinConf) {
            this.log(`[Crypto] Confidence ${(prediction.confidence * 100).toFixed(1)}% below crypto threshold ${(cryptoMinConf * 100).toFixed(1)}%`)
            rejectionTracker.record('confidence', 'llm-crypto', `${(prediction.confidence * 100).toFixed(1)}% < ${(cryptoMinConf * 100).toFixed(1)}%`)
            continue
          }

          // Record prediction for calibration
          calibrationTracker.recordPrediction(market.id, prediction.confidence, prediction.predictedOutcome, market.category)

          // Execute trade using the same logic as general loop
          const outcomeIdx = prediction.predictedOutcome === 'yes' ? 0 : 1
          const marketPrice = market.outcomePrices[outcomeIdx]

          const tradeAmount = this.calculatePositionSize(prediction.confidence, marketPrice)
          if (tradeAmount <= 0) continue

          this.log(`[Crypto] Placing ${prediction.predictedOutcome.toUpperCase()} trade: $${tradeAmount.toFixed(2)}`)
          activityLogger.logTrade(
            `Crypto LLM trade: ${prediction.predictedOutcome.toUpperCase()} $${tradeAmount.toFixed(2)}`,
            { confidence: prediction.confidence, reasoning: prediction.reasoning.substring(0, 100) },
          )

          const cryptoIsGtd = this.llmConfig.orderType === 'GTD'
          const cryptoLimitPrice = cryptoIsGtd ? Math.max(0.01, marketPrice - 0.01) : undefined
          const result = await tradingService.placeBet(
            market,
            prediction.predictedOutcome,
            tradeAmount,
            {
              stopLossPercent: this.llmConfig.stopLossPercent,
              takeProfitPercent: this.llmConfig.takeProfitPercent,
              ...(cryptoIsGtd && {
                orderType: 'GTD' as const,
                gtdExpiryMs: this.llmConfig.gtcExpiryMinutes * 60 * 1000,
                limitPrice: cryptoLimitPrice,
                skipGtcFallback: true,
              }),
            },
          )

          if (!result.success) {
            this.log(`[Crypto] Trade rejected: ${result.error}`)
            continue
          }

          this.updateStats({
            totalTrades: this._stats.totalTrades + 1,
          })

          // Track position with PLM for SL/TP enforcement
          if (!result.pending) {
            const entryPrice = result.avgPrice ?? marketPrice
            import('@/services/trading/PositionLifecycleManager').then(m => {
              m.positionLifecycleManager.trackPosition({
                marketSlug: market.slug,
                outcome: prediction.predictedOutcome,
                question: market.question,
                entryPrice,
                size: result.filledSize || tradeAmount / entryPrice,
                costBasis: tradeAmount,
                entryTime: Date.now(),
                stopLossPercent: this.llmConfig.stopLossPercent,
                takeProfitPercent: this.llmConfig.takeProfitPercent,
                strategy: 'llm',
                tokenId: market.clobTokenIds?.[prediction.predictedOutcome === 'yes' ? 0 : 1],
                maxHoldMs: 4 * 60 * 60 * 1000,
              })
            }).catch(err => console.warn('[LLM Crypto] PLM track failed:', err))
          }

          // Record in trade logger
          tradeLogger.logEntry({
            marketId: market.id,
            slug: market.slug,
            question: market.question,
            outcomes: market.outcomes || [],
            strategy: 'llm',
            side: 'BUY',
            outcome: prediction.predictedOutcome,
            modelProbability: prediction.confidence,
            calibratedProbability: prediction.confidence,
            marketPrice,
            kellyFraction: useSettingsStore.getState().kellyFraction,
            kellyBetSize: tradeAmount,
            actualBetSize: tradeAmount,
            orderType: result.pending ? 'GTD' : 'FOK',
            fillPrice: result.avgPrice ?? marketPrice,
            filledSize: result.filledSize,
            success: true,
            orderId: result.orderId,
          })

          // Only take one crypto trade per cycle to conserve budget
          break
        } catch (error) {
          this.logError(`[Crypto] Analysis/trade failed for ${market.question.substring(0, 40)}`, error)
        }
      }
    } catch (error) {
      this.logError('[Crypto] Scan cycle failed', error)
    }
  }

  /**
   * Get strategy configuration
   */
  getLLMConfig(): LLMPredictionConfig {
    return { ...this.llmConfig }
  }

  /**
   * Update strategy configuration
   */
  setLLMConfig(config: Partial<LLMPredictionConfig>): void {
    this.llmConfig = { ...this.llmConfig, ...config }
    this._config = { ...this._config, ...this.llmConfig }
    
    // Update dependent services
    marketScanner.setConfig({
      minLiquidity: this.llmConfig.minLiquidity,
      minVolume: this.llmConfig.minVolume24h,
      maxAgeHours: this.llmConfig.maxCreatedHours,
      minOdds: this.llmConfig.minOdds,
      maxOdds: this.llmConfig.maxOdds,
    })

    this.emit('configUpdated', this.llmConfig)
  }
}

// Export singleton instance
export const llmPredictionStrategy = new LLMPredictionStrategy()
