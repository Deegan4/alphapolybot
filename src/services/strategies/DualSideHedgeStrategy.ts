/**
 * Dual-Side Hedge Strategy
 *
 * Buys both YES and NO outcomes simultaneously when detecting a BTC move
 * before the oracle adjusts, using maker-only limit orders (0% fee).
 *
 * Core insight: if combined ask < $1.00 and both legs fill,
 * the winning side resolves at $1.00 → guaranteed profit.
 *
 * Listens to BtcUpDownStrategy's 'signalComputed' event — no duplicate
 * market discovery or API calls.
 *
 * Risk controls:
 * - Maker-only (limit orders below ask) — avoids taker fees
 * - maxCombinedAsk gate: combined YES+NO must be < threshold
 * - requireBothLegs: cancel first leg if second doesn't fill
 * - Directional bias: allocate more to predicted winner
 * - Cancel/replace loop: BinanceWS-driven requoting on price moves
 */

import { BaseStrategy } from './BaseStrategy'
import type { Market, DualSideConfig } from '@/types'
import { dynamicFeeService } from '@/services/trading/DynamicFeeService'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { rejectionTracker } from '@/services/trading/RejectionTracker'
import { useSettingsStore } from '@/stores/settingsStore'
import type { Signal } from './btcupdown/signalEngine'

// ==========================================
// TYPES
// ==========================================

interface PendingHedge {
  marketId: string
  asset: string
  yesOrderId?: string
  noOrderId?: string
  yesPrice: number
  noPrice: number
  yesFilled: boolean
  noFilled: boolean
  yesFilledQty: number        // actual share count from UserChannel fill
  noFilledQty: number         // actual share count from UserChannel fill
  direction: 'up' | 'down'
  confidence: number
  placedAt: number
  btcPriceAtPlacement: number
  replaceThreshold: number    // fractional price change to trigger cancel/replace
}

// ==========================================
// STRATEGY
// ==========================================

export class DualSideHedgeStrategy extends BaseStrategy {
  name = 'Dual-Side Hedge'
  description = 'Maker-only dual-side hedging on BTC prediction markets'
  strategyType = 'mechanical' as const

  private pendingHedges = new Map<string, PendingHedge>()
  private unsubscribe: (() => void) | null = null
  private fillCheckInterval: ReturnType<typeof setInterval> | null = null
  private cleanupFns: Array<() => void> = []

  // ==========================================
  // CONFIG
  // ==========================================

  get dualConfig(): DualSideConfig {
    const settings = useSettingsStore.getState()
    return {
      enabled: settings.dualSideEnabled ?? false,
      tradeSize: settings.dualSideTradeSize ?? 2.0,
      biasRatio: settings.dualSideBiasRatio ?? 0.50,
      makerOnly: settings.dualSideMakerOnly ?? true,
      maxCombinedAsk: settings.dualSideMaxCombinedAsk ?? 0.995,
      requireBothLegs: settings.dualSideRequireBothLegs ?? true,
      limitPriceOffset: 0.01,       // 1¢ below ask for maker status
      maxWaitForFillMs: 30_000,     // 30s fill timeout
      minSignalConfidence: 0.40,    // Lower bar — hedged, not directional
    }
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async initialize(): Promise<void> {
    this.log('Dual-Side Hedge strategy initialized')
  }

  async start(): Promise<void> {
    if (!this._enabled) return
    this._status = 'running'
    this.log('Dual-Side Hedge strategy started — listening for BTC signals')

    // Subscribe to BtcUpDownStrategy signals (lazy import to avoid circular dep)
    this.subscribeToBtcSignals()

    // Subscribe to UserChannel for fill detection
    this.subscribeToFills()

    // Subscribe to BinanceWS for cancel/replace loop
    this.subscribeToPriceUpdates()

    // Safety-net timeout check (30s interval — handles BinanceWS disconnects)
    this.fillCheckInterval = setInterval(() => this.checkPendingFills(), 30_000)
  }

  async stop(): Promise<void> {
    this._status = 'idle'
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    if (this.fillCheckInterval) {
      clearInterval(this.fillCheckInterval)
      this.fillCheckInterval = null
    }
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
    this.pendingHedges.clear()
    this.log('Dual-Side Hedge strategy stopped')
  }

  // ==========================================
  // SIGNAL SUBSCRIPTION
  // ==========================================

  private subscribeToBtcSignals(): void {
    import('./BtcUpDownStrategy').then(({ btcUpDownStrategy }) => {
      this.unsubscribe = btcUpDownStrategy.on('signalComputed', (_event, data) => {
        const { asset, signal, windowOpenPrice, currentPrice, market } = data as {
          asset: string
          signal: Signal
          windowOpenPrice: number
          currentPrice: number
          market: Market
        }
        this.onSignal(asset, signal, windowOpenPrice, currentPrice, market).catch(err => {
          this.log(`Signal handler error: ${err}`)
        })
      })
      this.log('Subscribed to BtcUpDown signalComputed events')
    }).catch(err => {
      this.log(`Failed to subscribe to BTC signals: ${err}`)
    })
  }

  // ==========================================
  // FILL DETECTION (UserChannel WebSocket)
  // ==========================================

  private subscribeToFills(): void {
    import('@/services/realtime').then(({ userChannelService }) => {
      const unsubTrade = userChannelService.onTrade((msg) => {
        if (msg.status !== 'CONFIRMED') return
        for (const makerOrder of msg.maker_orders || []) {
          for (const [asset, hedge] of this.pendingHedges) {
            if (makerOrder.order_id === hedge.yesOrderId) {
              hedge.yesFilled = true
              hedge.yesFilledQty += parseFloat(makerOrder.matched_amount || msg.size || '0')
              this.log(`${asset}: YES leg filled ${hedge.yesFilledQty.toFixed(2)} shares (order ${makerOrder.order_id})`)
              this.checkBothFilled(asset, hedge)
            } else if (makerOrder.order_id === hedge.noOrderId) {
              hedge.noFilled = true
              hedge.noFilledQty += parseFloat(makerOrder.matched_amount || msg.size || '0')
              this.log(`${asset}: NO leg filled ${hedge.noFilledQty.toFixed(2)} shares (order ${makerOrder.order_id})`)
              this.checkBothFilled(asset, hedge)
            }
          }
        }
      })
      this.cleanupFns.push(unsubTrade)
    }).catch(err => this.log(`Failed to subscribe UserChannel: ${err}`))
  }

  private checkBothFilled(asset: string, hedge: PendingHedge): void {
    if (hedge.yesFilled && hedge.noFilled) {
      this.log(`${asset}: BOTH LEGS FILLED — hedge complete`)
      activityLogger.logTrade(`Dual-side ${asset}: both legs filled`)
      this.pendingHedges.delete(asset)
      this.emit('hedgeBothFilled', { asset, hedge })

      // Best-effort merge: recover USDC.e immediately instead of waiting for resolution.
      // For 5-min markets this is a ~5 min capital savings; for longer markets it's critical.
      // Merge failure is non-blocking — positions will still resolve normally.
      this.attemptMerge(asset, hedge).catch(err => {
        this.log(`${asset}: merge attempt failed (non-blocking): ${err}`)
      })
    }
  }

  /**
   * Attempt on-chain merge of YES+NO conditional tokens back to USDC.e.
   * Best-effort: if merge fails (no gas, no provider, etc.), positions
   * resolve normally at market close.
   */
  private async attemptMerge(asset: string, hedge: PendingHedge): Promise<void> {
    try {
      const { mergeService } = await import('@/services/trading/MergeService')

      if (!mergeService.isReady()) {
        // Try to initialize from wallet
        const { walletService } = await import('@/services/wallet/WalletService')
        const wallet = walletService.getWallet()
        if (wallet) {
          mergeService.initialize(wallet)
        } else {
          this.log(`${asset}: merge skipped — no wallet available`)
          return
        }
      }

      // Look up conditionId from the market
      const { btcUpDownStrategy } = await import('./BtcUpDownStrategy')
      const market = btcUpDownStrategy.getActiveMarket(asset)
      const conditionId = market?.conditionId
      if (!conditionId) {
        this.log(`${asset}: merge skipped — no conditionId on market`)
        return
      }

      // Compute mergeable amount from actual fill quantities (not USD sizing)
      const mergeAmount = mergeService.computeMergeAmount(hedge.yesFilledQty, hedge.noFilledQty)
      if (mergeAmount <= 0n) {
        this.log(`${asset}: merge skipped — no mergeable balance`)
        return
      }

      this.log(`${asset}: attempting on-chain merge for ${Number(mergeAmount) / 1e6} USDC.e`)
      const result = await mergeService.merge(conditionId, mergeAmount)

      if (result.success) {
        this.log(`${asset}: MERGE SUCCESS — ${result.amountMerged?.toFixed(2)} USDC.e recovered (tx: ${result.txHash})`)
        this.emit('hedgeMerged', { asset, ...result })
      } else {
        this.log(`${asset}: merge failed (non-critical): ${result.error}`)
      }
    } catch (err) {
      this.log(`${asset}: merge error (non-critical): ${err}`)
    }
  }

  // ==========================================
  // CANCEL/REPLACE LOOP (BinanceWS-driven)
  // ==========================================

  private subscribeToPriceUpdates(): void {
    import('@/services/realtime/BinanceWSService').then(({ binanceWSService }) => {
      const unsubPrice = binanceWSService.onPriceUpdate(async (update) => {
        if (update.symbol !== 'BTC') return
        await this.onBtcPriceUpdate(update.priceUSD)
      })
      this.cleanupFns.push(unsubPrice)
    }).catch(err => this.log(`Failed to subscribe BinanceWS: ${err}`))
  }

  private async onBtcPriceUpdate(currentPrice: number): Promise<void> {
    for (const [asset, hedge] of this.pendingHedges) {
      // Skip fully filled hedges
      if (hedge.yesFilled && hedge.noFilled) continue

      const priceChange = Math.abs(currentPrice - hedge.btcPriceAtPlacement) / hedge.btcPriceAtPlacement
      if (priceChange < hedge.replaceThreshold) continue

      await this.cancelAndReplace(asset, hedge, currentPrice)
    }
  }

  private async cancelAndReplace(asset: string, hedge: PendingHedge, currentBtcPrice: number): Promise<void> {
    const { tradingService } = await import('@/services/trading/TradingService')
    const config = this.dualConfig

    // Cancel unfilled legs in parallel
    const cancels: Promise<unknown>[] = []
    if (!hedge.yesFilled && hedge.yesOrderId) {
      cancels.push(tradingService.cancelOrder(hedge.yesOrderId).then(() => { hedge.yesOrderId = undefined }))
    }
    if (!hedge.noFilled && hedge.noOrderId) {
      cancels.push(tradingService.cancelOrder(hedge.noOrderId).then(() => { hedge.noOrderId = undefined }))
    }
    await Promise.all(cancels)

    // Get fresh market data for repricing
    const { btcUpDownStrategy } = await import('./BtcUpDownStrategy')
    const market = btcUpDownStrategy.getActiveMarket(asset)
    if (!market) {
      this.log(`${asset}: cancel/replace — market no longer active, removing hedge`)
      this.pendingHedges.delete(asset)
      return
    }

    const yesPrice = market.outcomePrices[0] ?? 0.50
    const noPrice = market.outcomePrices[1] ?? 0.50
    let yesLimitPrice = Math.max(0.01, yesPrice - config.limitPriceOffset)
    let noLimitPrice = Math.max(0.01, noPrice - config.limitPriceOffset)

    // AS pricer for cancel/replace repricing
    if (useSettingsStore.getState().useAvellanedaStoikov) {
      try {
        const { AvellanedaStoikovPricer } = await import('@/services/trading/AvellanedaStoikovPricer')
        const { btcUpDownStrategy } = await import('./BtcUpDownStrategy')
        const settings = useSettingsStore.getState()
        const highFreq = btcUpDownStrategy.getHighFreqPrices('BTC')
        const vol = AvellanedaStoikovPricer.estimateVolatility(highFreq.map(p => p.price), 1000, 900_000)
        const inventory = AvellanedaStoikovPricer.dualSideInventory(hedge.yesFilled, hedge.noFilled)

        const yesQ = AvellanedaStoikovPricer.computeQuotes({
          midPrice: yesPrice, inventory, sigma: vol.sigma, timeRemaining: 0.5,
          gamma: settings.asRiskAversion, kappa: settings.asOrderArrivalRate,
        })
        const noQ = AvellanedaStoikovPricer.computeQuotes({
          midPrice: noPrice, inventory: -inventory, sigma: vol.sigma, timeRemaining: 0.5,
          gamma: settings.asRiskAversion, kappa: settings.asOrderArrivalRate,
        })
        yesLimitPrice = yesQ.bidPrice
        noLimitPrice = noQ.bidPrice
      } catch { /* keep static offsets */ }
    }

    // Re-check combined ask viability
    const combinedAsk = yesPrice + noPrice
    if (combinedAsk >= config.maxCombinedAsk) {
      this.log(`${asset}: cancel/replace — combined ask ${combinedAsk.toFixed(4)} >= max, abandoning`)
      this.pendingHedges.delete(asset)
      return
    }

    // Place new orders for unfilled legs
    if (!hedge.yesFilled) {
      const { yesSize } = this.computeBiasedSizes(config.tradeSize, config.biasRatio, hedge.direction)
      const yesResult = await tradingService.placeBet(market, 'yes', yesSize, {
        orderType: 'GTC',
        skipGtcFallback: true,
        strategy: 'dual-side',
        postOnly: config.makerOnly,
        limitPrice: yesLimitPrice,
      })
      hedge.yesOrderId = yesResult.orderId
      hedge.yesPrice = yesLimitPrice
    }
    if (!hedge.noFilled) {
      const { noSize } = this.computeBiasedSizes(config.tradeSize, config.biasRatio, hedge.direction)
      const noResult = await tradingService.placeBet(market, 'no', noSize, {
        orderType: 'GTC',
        skipGtcFallback: true,
        strategy: 'dual-side',
        postOnly: config.makerOnly,
        limitPrice: noLimitPrice,
      })
      hedge.noOrderId = noResult.orderId
      hedge.noPrice = noLimitPrice
    }

    // Update price reference to prevent immediate re-trigger
    hedge.btcPriceAtPlacement = currentBtcPrice

    this.log(`${asset}: cancel/replace complete (BTC moved to $${currentBtcPrice.toFixed(2)})`)
    this.emit('hedgeCancelReplaced', { asset, hedge })
  }

  // ==========================================
  // CORE LOGIC
  // ==========================================

  /**
   * Called when BtcUpDownStrategy emits a new signal.
   * Evaluates whether a dual-side hedge is viable.
   */
  async onSignal(
    asset: string,
    signal: Signal,
    _windowOpenPrice: number,
    currentPrice: number,
    market?: Market,
  ): Promise<void> {
    if (!this._enabled || !this.dualConfig.enabled) {
      this.log(`Skipping signal: enabled=${this._enabled} dualConfig.enabled=${this.dualConfig.enabled}`)
      return
    }

    const config = this.dualConfig

    // Gate: VPIN toxicity — skip if informed flow detected (best-effort)
    try {
      const { vpinService } = await import('@/services/trading/VPINService')
      const yesTokenId = market?.tokens?.[0]?.token_id
      const noTokenId = market?.tokens?.[1]?.token_id
      if (yesTokenId && vpinService.isToxic(yesTokenId)) {
        this.log(`${asset}: VPIN toxic on YES token (${vpinService.getVPIN(yesTokenId).toFixed(2)}), skipping`)
        rejectionTracker.record('market_filter', 'dual-side', `${asset} VPIN toxic YES`)
        return
      }
      if (noTokenId && vpinService.isToxic(noTokenId)) {
        this.log(`${asset}: VPIN toxic on NO token (${vpinService.getVPIN(noTokenId).toFixed(2)}), skipping`)
        rejectionTracker.record('market_filter', 'dual-side', `${asset} VPIN toxic NO`)
        return
      }
    } catch { /* VPIN unavailable — proceed without */ }

    // Gate: minimum signal confidence
    if (signal.confidence < config.minSignalConfidence) {
      this.log(`${asset}: confidence ${(signal.confidence * 100).toFixed(0)}% < min ${(config.minSignalConfidence * 100).toFixed(0)}%`)
      return
    }

    // Gate: already have a pending hedge for this asset
    if (this.pendingHedges.has(asset)) {
      this.log(`${asset}: already has pending hedge`)
      return
    }

    // Gate: need market data (passed directly from signalComputed event)
    if (!market) {
      this.log(`${asset}: no market object in signal event`)
      return
    }

    const yesPrice = market.outcomePrices[0] ?? 0.50
    const noPrice = market.outcomePrices[1] ?? 0.50

    // Gate: combined ask must be below threshold
    const combinedAsk = yesPrice + noPrice
    if (combinedAsk >= config.maxCombinedAsk) {
      this.log(`${asset}: combined ask ${combinedAsk.toFixed(4)} >= max ${config.maxCombinedAsk}`)
      rejectionTracker.record('market_filter', 'dual-side', `${asset} combined ${combinedAsk.toFixed(4)} >= ${config.maxCombinedAsk}`)
      return
    }

    // Fee-viability check using DynamicFeeService
    const yesFeeEst = dynamicFeeService.estimateDynamicFee(yesPrice, true)
    const noFeeEst = dynamicFeeService.estimateDynamicFee(noPrice, true)

    // For maker-only, fees should be 0 bps — but check viability in case
    // the order gets matched as taker
    const effectiveYesFee = config.makerOnly ? 0 : yesFeeEst.feeRateBps
    const effectiveNoFee = config.makerOnly ? 0 : noFeeEst.feeRateBps

    const dualEV = dynamicFeeService.computeDualSideEV({
      yesPrice,
      noPrice,
      yesFeeRateBps: effectiveYesFee,
      noFeeRateBps: effectiveNoFee,
      winProbability: signal.direction === 'up' ? signal.confidence : 1 - signal.confidence,
    })

    if (!dualEV.isViable) {
      rejectionTracker.record('market_filter', 'dual-side', `${asset} fee-negative: netEV=${dualEV.netEV.toFixed(4)}`)
      return
    }

    // Calculate leg sizes with directional bias
    const { yesSize, noSize } = this.computeBiasedSizes(
      config.tradeSize,
      config.biasRatio,
      signal.direction,
    )

    // Limit prices: AS pricer when enabled, static offset fallback
    let yesLimitPrice = Math.max(0.01, yesPrice - config.limitPriceOffset)
    let noLimitPrice = Math.max(0.01, noPrice - config.limitPriceOffset)

    if (useSettingsStore.getState().useAvellanedaStoikov) {
      try {
        const { AvellanedaStoikovPricer } = await import('@/services/trading/AvellanedaStoikovPricer')
        const { btcUpDownStrategy } = await import('./BtcUpDownStrategy')
        const settings = useSettingsStore.getState()
        const gamma = settings.asRiskAversion
        const kappa = settings.asOrderArrivalRate
        const highFreq = btcUpDownStrategy.getHighFreqPrices('BTC')
        const vol = AvellanedaStoikovPricer.estimateVolatility(
          highFreq.map(p => p.price), 1000, 900_000,
        )
        const yesFilled = this.pendingHedges.get(asset)?.yesFilled ?? false
        const noFilled = this.pendingHedges.get(asset)?.noFilled ?? false
        const inventory = AvellanedaStoikovPricer.dualSideInventory(yesFilled, noFilled)

        const yesQuotes = AvellanedaStoikovPricer.computeQuotes({
          midPrice: yesPrice, inventory, sigma: vol.sigma, timeRemaining: 0.5, gamma, kappa,
        })
        const noQuotes = AvellanedaStoikovPricer.computeQuotes({
          midPrice: noPrice, inventory: -inventory, sigma: vol.sigma, timeRemaining: 0.5, gamma, kappa,
        })
        yesLimitPrice = yesQuotes.bidPrice
        noLimitPrice = noQuotes.bidPrice
      } catch { /* AS pricer failed — keep static offsets */ }
    }

    this.log(
      `DUAL-SIDE: ${asset} ${signal.direction.toUpperCase()} conf=${(signal.confidence * 100).toFixed(0)}% ` +
      `YES@${(yesLimitPrice * 100).toFixed(0)}c($${yesSize.toFixed(2)}) + ` +
      `NO@${(noLimitPrice * 100).toFixed(0)}c($${noSize.toFixed(2)}) ` +
      `combined=${combinedAsk.toFixed(4)} netEV=${dualEV.netEV.toFixed(4)}`,
    )

    activityLogger.logTrade(
      `Dual-side ${asset}: ${signal.direction.toUpperCase()} ` +
      `YES@${(yesLimitPrice * 100).toFixed(0)}c + NO@${(noLimitPrice * 100).toFixed(0)}c ` +
      `(netEV=${dualEV.netEV.toFixed(4)})`,
    )

    // Place both maker limit orders
    try {
      const { tradingService } = await import('@/services/trading/TradingService')

      const yesResult = await tradingService.placeBet(market, 'yes', yesSize, {
        orderType: 'GTC',
        skipGtcFallback: true,
        strategy: 'dual-side',
        postOnly: config.makerOnly,
        limitPrice: yesLimitPrice,
      })

      const noResult = await tradingService.placeBet(market, 'no', noSize, {
        orderType: 'GTC',
        skipGtcFallback: true,
        strategy: 'dual-side',
        postOnly: config.makerOnly,
        limitPrice: noLimitPrice,
      })

      // Track pending hedge
      const hedge: PendingHedge = {
        marketId: market.id,
        asset,
        yesOrderId: yesResult.orderId,
        noOrderId: noResult.orderId,
        yesPrice: yesLimitPrice,
        noPrice: noLimitPrice,
        yesFilled: false,
        noFilled: false,
        yesFilledQty: 0,
        noFilledQty: 0,
        direction: signal.direction,
        confidence: signal.confidence,
        placedAt: Date.now(),
        btcPriceAtPlacement: currentPrice,
        replaceThreshold: 0.001,  // 0.1% BTC price move triggers cancel/replace
      }
      this.pendingHedges.set(asset, hedge)

      this.emit('hedgePlaced', { asset, hedge, dualEV })
    } catch (err) {
      this.log(`Failed to place dual-side orders: ${err}`)
    }
  }

  // ==========================================
  // SIZING
  // ==========================================

  /**
   * Compute biased sizes: allocate to predicted winner vs other side.
   *
   * biasRatio = 0.50 means equal sizing (pure hedge, maximizes merge pairs).
   * biasRatio = 0.70 would mean 70% on predicted winner (directional tilt).
   * If direction is 'up', YES is the predicted winner.
   */
  computeBiasedSizes(
    totalSize: number,
    biasRatio: number,
    direction: 'up' | 'down',
  ): { yesSize: number; noSize: number } {
    const winnerSize = Math.round(totalSize * biasRatio * 100) / 100
    const loserSize = Math.round(totalSize * (1 - biasRatio) * 100) / 100

    return direction === 'up'
      ? { yesSize: winnerSize, noSize: loserSize }
      : { yesSize: loserSize, noSize: winnerSize }
  }

  // ==========================================
  // FILL MONITORING (safety-net timeout)
  // ==========================================

  private async checkPendingFills(): Promise<void> {
    const now = Date.now()
    const config = this.dualConfig

    for (const [asset, hedge] of this.pendingHedges) {
      const elapsed = now - hedge.placedAt

      // Timeout: cancel unfilled orders
      if (elapsed > config.maxWaitForFillMs) {
        this.log(`DUAL-SIDE: ${asset} fill timeout after ${Math.round(elapsed / 1000)}s`)

        // Actually cancel unfilled legs
        try {
          const { tradingService } = await import('@/services/trading/TradingService')

          if (!hedge.yesFilled && hedge.yesOrderId) {
            await tradingService.cancelOrder(hedge.yesOrderId)
            this.log(`${asset}: cancelled YES order ${hedge.yesOrderId}`)
          }
          if (!hedge.noFilled && hedge.noOrderId) {
            await tradingService.cancelOrder(hedge.noOrderId)
            this.log(`${asset}: cancelled NO order ${hedge.noOrderId}`)
          }
        } catch (err) {
          this.log(`${asset}: cancel error on timeout: ${err}`)
        }

        if (config.requireBothLegs && (hedge.yesFilled || hedge.noFilled) && !(hedge.yesFilled && hedge.noFilled)) {
          activityLogger.logWarning(`Dual-side ${asset}: partial fill on timeout — one leg open`)
        } else {
          activityLogger.logTrade(`Dual-side ${asset}: timeout, orders cancelled`)
        }

        this.pendingHedges.delete(asset)
        this.emit('hedgeTimeout', { asset, hedge })
      }
    }
  }

  // ==========================================
  // UTILITIES
  // ==========================================

  protected log(message: string): void {
    console.log(`[DualSideHedge] ${message}`)
  }

  /** Expose pending hedges for testing */
  getPendingHedges(): Map<string, PendingHedge> {
    return this.pendingHedges
  }
}

// ==========================================
// SINGLETON EXPORT
// ==========================================

export const dualSideHedgeStrategy = new DualSideHedgeStrategy()
