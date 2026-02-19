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
  direction: 'up' | 'down'
  confidence: number
  placedAt: number
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

  // ==========================================
  // CONFIG
  // ==========================================

  get dualConfig(): DualSideConfig {
    const settings = useSettingsStore.getState()
    return {
      enabled: settings.dualSideEnabled ?? false,
      tradeSize: settings.dualSideTradeSize ?? 2.0,
      biasRatio: settings.dualSideBiasRatio ?? 0.70,
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

    // Periodic fill check for pending hedges
    this.fillCheckInterval = setInterval(() => this.checkPendingFills(), 5_000)
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
    this.pendingHedges.clear()
    this.log('Dual-Side Hedge strategy stopped')
  }

  // ==========================================
  // SIGNAL SUBSCRIPTION
  // ==========================================

  private subscribeToBtcSignals(): void {
    // Dynamic import to avoid circular dependency
    import('./BtcUpDownStrategy').then(({ btcUpDownStrategy }) => {
      this.unsubscribe = btcUpDownStrategy.on('signalComputed', (_event, data) => {
        const { asset, signal, windowOpenPrice, currentPrice } = data as {
          asset: string
          signal: Signal
          windowOpenPrice: number
          currentPrice: number
        }
        this.onSignal(asset, signal, windowOpenPrice, currentPrice).catch(err => {
          this.log(`Signal handler error: ${err}`)
        })
      })
      this.log('Subscribed to BtcUpDown signalComputed events')
    }).catch(err => {
      this.log(`Failed to subscribe to BTC signals: ${err}`)
    })
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
    _currentPrice: number,
  ): Promise<void> {
    if (!this._enabled || !this.dualConfig.enabled) {
      this.log(`Skipping signal: enabled=${this._enabled} dualConfig.enabled=${this.dualConfig.enabled}`)
      return
    }

    const config = this.dualConfig

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

    // We need the market data from BtcUpDownStrategy to get YES/NO prices.
    // Use dynamic import to access the singleton.
    let market: Market | undefined
    let yesPrice: number
    let noPrice: number

    try {
      const { btcUpDownStrategy } = await import('./BtcUpDownStrategy')
      const entries = btcUpDownStrategy.getActiveMarketEntries()
      const entry = entries.find(e => e.asset === asset)
      if (!entry) {
        this.log(`${asset}: no active market entry found`)
        return
      }

      // Get live prices from the strategy's tracked market
      const activeMarkets = btcUpDownStrategy.getActiveMarkets?.()
      if (!activeMarkets) {
        this.log(`${asset}: getActiveMarkets returned null`)
        return
      }

      // Look up market by iterating active markets
      for (const [_id, m] of activeMarkets) {
        if (m.asset === asset) {
          market = m.market
          break
        }
      }

      if (!market) {
        this.log(`${asset}: market object not found in activeMarkets`)
        return
      }

      yesPrice = parseFloat(market.outcomePrices[0]) || 0.50
      noPrice = parseFloat(market.outcomePrices[1]) || 0.50
    } catch (err) {
      this.log(`${asset}: failed to fetch market data: ${err}`)
      return
    }

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

    // Limit prices: offset below ask for maker status
    const yesLimitPrice = Math.max(0.01, yesPrice - config.limitPriceOffset)
    const noLimitPrice = Math.max(0.01, noPrice - config.limitPriceOffset)

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

      const yesResult = await tradingService.placeOrder?.(market, 'yes', yesSize, yesLimitPrice, {
        orderType: 'GTC',
        strategy: 'dual-side',
      })

      const noResult = await tradingService.placeOrder?.(market, 'no', noSize, noLimitPrice, {
        orderType: 'GTC',
        strategy: 'dual-side',
      })

      // Track pending hedge
      const hedge: PendingHedge = {
        marketId: market.id,
        asset,
        yesOrderId: yesResult?.orderId,
        noOrderId: noResult?.orderId,
        yesPrice: yesLimitPrice,
        noPrice: noLimitPrice,
        yesFilled: false,
        noFilled: false,
        direction: signal.direction,
        confidence: signal.confidence,
        placedAt: Date.now(),
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
   * Compute biased sizes: allocate more to predicted winner.
   *
   * biasRatio = 0.70 means 70% on predicted winner, 30% on other side.
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
  // FILL MONITORING
  // ==========================================

  private async checkPendingFills(): Promise<void> {
    const now = Date.now()
    const config = this.dualConfig

    for (const [asset, hedge] of this.pendingHedges) {
      const elapsed = now - hedge.placedAt

      // Timeout: cancel unfilled orders
      if (elapsed > config.maxWaitForFillMs) {
        this.log(`DUAL-SIDE: ${asset} fill timeout after ${Math.round(elapsed / 1000)}s`)

        if (config.requireBothLegs && (!hedge.yesFilled || !hedge.noFilled)) {
          // Cancel unfilled leg, optionally sell filled leg
          this.log(`DUAL-SIDE: ${asset} partial fill — cancelling remaining orders`)
          activityLogger.logTrade(`Dual-side ${asset}: timeout, cancelling unfilled legs`)
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
