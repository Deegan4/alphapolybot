/**
 * Gabagool Strategy — Direction-Agnostic Accumulation Merge Arbitrage
 *
 * Buys whichever side (YES or NO) of a BTC 15-min binary market is
 * temporarily cheap, accumulating small maker-only positions across
 * the window. Tracks cost basis and locks profit when:
 *
 *   min(qty_YES, qty_NO) > cost_YES + cost_NO
 *
 * At that point, each paired share resolves to $1.00 regardless of
 * outcome, guaranteeing profit.
 *
 * Key properties:
 * - Never predicts direction — purely mechanical
 * - Maker-only GTC+postOnly orders — 0% fees (10% taker would destroy edge)
 * - Multiple small entries per window, tracking running cost basis
 * - Balance-aware: caps imbalance to keep hedge tight
 * - Merges paired tokens on-chain via MergeService for instant recovery
 */

import { BaseStrategy } from './BaseStrategy'
import type { Market } from '@/types'
import { ASSET_SLUG_PATTERNS } from './BtcUpDownStrategy'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'

// ==========================================
// TYPES
// ==========================================

export interface GabagoolConfig {
  enabled: boolean
  maxExposurePerWindow: number
  orderSize: number
  cheapnessThreshold: number
  maxImbalance: number
  minProfitMargin: number
  cooldownMs: number
  limitPriceOffset: number
  minWindowRemainingMs: number
  staleOrderMs: number
}

export interface AccumulationFill {
  side: 'yes' | 'no'
  price: number
  qty: number
  cost: number
  orderId: string
  timestamp: number
}

export interface WindowAccumulator {
  marketId: string
  market: Market
  conditionId?: string
  yesTokenId: string
  noTokenId: string
  windowEndMs: number
  // Accumulation
  qtyYes: number
  qtyNo: number
  costYes: number
  costNo: number
  fills: AccumulationFill[]
  // Derived (recomputed on each fill)
  pairCost: number
  lockedProfit: number
  imbalance: number
  // Order tracking
  pendingOrderIds: Set<string>
  lastOrderTime: number
  totalOrders: number
  stopped: boolean
}

// ==========================================
// STRATEGY
// ==========================================

export class GabagoolStrategy extends BaseStrategy {
  name = 'Gabagool Accumulator'
  description = 'Direction-agnostic accumulation merge arb on BTC 15m markets'
  strategyType = 'mechanical' as const

  private accumulators = new Map<string, WindowAccumulator>()
  private scanInterval: ReturnType<typeof setInterval> | null = null
  private scanning = false  // Guard against overlapping async scan cycles
  private cleanupFns: Array<() => void> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private realtimeServiceRef: any = null
  private tokenToMarketMap = new Map<string, { marketId: string; side: 'yes' | 'no' }>()
  private orderSideMap = new Map<string, 'yes' | 'no'>()  // orderId → side for fill attribution

  // ==========================================
  // CONFIG
  // ==========================================

  get gabagoolConfig(): GabagoolConfig {
    const s = useSettingsStore.getState()
    return {
      enabled: s.gabagoolEnabled ?? false,
      maxExposurePerWindow: s.gabagoolMaxExposure ?? 10,
      orderSize: s.gabagoolOrderSize ?? 1,
      cheapnessThreshold: s.gabagoolCheapnessThreshold ?? 0.48,
      maxImbalance: s.gabagoolMaxImbalance ?? 0.20,
      minProfitMargin: s.gabagoolMinProfitMargin ?? 0.98,
      cooldownMs: s.gabagoolCooldownMs ?? 3000,
      limitPriceOffset: 0.01,
      minWindowRemainingMs: 120_000,
      staleOrderMs: 30_000,
    }
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async initialize(): Promise<void> {
    this.log('Gabagool strategy initialized')
  }

  async start(): Promise<void> {
    if (!this._enabled) return
    if (this._status === 'running') return
    this._status = 'running'
    this.log('Gabagool strategy started — scanning for 15m BTC markets')

    // Connect to RealtimeService for live CLOB prices
    try {
      const { realtimeService } = await import('@/services/realtime')
      await realtimeService.connect()
      this.realtimeServiceRef = realtimeService
    } catch (err) {
      this.log(`Failed to connect RealtimeService: ${err}`)
    }

    // Subscribe to UserChannel for fill detection
    this.subscribeToFills()

    // Run immediate scan then schedule interval
    await this.runScanCycle()
    this.scanInterval = setInterval(() => this.runScanCycle(), 5000)
  }

  async stop(): Promise<void> {
    this._status = 'idle'

    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }

    // Cancel all pending orders
    await this.cancelAllPendingOrders()

    // Attempt merge for any accumulators with fills on both sides
    for (const [, acc] of this.accumulators) {
      if (acc.qtyYes > 0 && acc.qtyNo > 0) {
        this.attemptMerge(acc).catch(err => this.log(`Merge on stop failed: ${err}`))
      }
    }

    // Clean up
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
    this.accumulators.clear()
    this.tokenToMarketMap.clear()
    this.orderSideMap.clear()
    this.realtimeServiceRef = null

    this.log('Gabagool strategy stopped')
  }

  // ==========================================
  // FILL DETECTION (UserChannel WebSocket)
  // ==========================================

  private subscribeToFills(): void {
    import('@/services/realtime').then(({ userChannelService }) => {
      const unsubTrade = userChannelService.onTrade((msg: {
        status: string
        maker_orders?: Array<{ order_id: string; matched_amount?: string; asset_id?: string }>
        price?: string
        size?: string
      }) => {
        if (msg.status !== 'CONFIRMED') return
        for (const makerOrder of msg.maker_orders || []) {
          this.onFill(makerOrder.order_id, makerOrder.asset_id, msg.price, msg.size)
        }
      })
      this.cleanupFns.push(unsubTrade)
    }).catch(err => this.log(`Failed to subscribe UserChannel: ${err}`))
  }

  private onFill(orderId: string, assetId?: string, priceStr?: string, sizeStr?: string): void {
    // Find which accumulator owns this order
    for (const [, acc] of this.accumulators) {
      if (!acc.pendingOrderIds.has(orderId)) continue

      // Determine side from orderId→side map (primary), then tokenToMarketMap (fallback)
      let side: 'yes' | 'no' | undefined = this.orderSideMap.get(orderId)
      if (!side && assetId) {
        const mapping = this.tokenToMarketMap.get(assetId)
        if (mapping) side = mapping.side
      }
      if (!side) {
        console.warn(`[Gabagool] Cannot determine side for fill ${orderId} — skipping`)
        acc.pendingOrderIds.delete(orderId)
        return
      }
      // Clean up the mapping
      this.orderSideMap.delete(orderId)

      const price = priceStr ? parseFloat(priceStr) : 0
      const qty = sizeStr ? parseFloat(sizeStr) : 0
      const cost = price * qty

      if (qty <= 0) {
        acc.pendingOrderIds.delete(orderId)
        return
      }

      // Update accumulator
      if (side === 'yes') {
        acc.qtyYes += qty
        acc.costYes += cost
      } else {
        acc.qtyNo += qty
        acc.costNo += cost
      }

      acc.fills.push({ side, price, qty, cost, orderId, timestamp: Date.now() })
      acc.pendingOrderIds.delete(orderId)

      // Recompute derived fields
      this.recomputeDerived(acc)

      this.log(
        `FILL ${side.toUpperCase()} ${qty.toFixed(2)} @ ${price.toFixed(3)} | ` +
        `pair=${acc.pairCost.toFixed(4)} profit=${acc.lockedProfit.toFixed(2)} imbal=${(acc.imbalance * 100).toFixed(0)}%`,
      )
      this.emit('accumulationFill', { marketId: acc.marketId, side, price, qty, cost, pairCost: acc.pairCost })

      // Check profit lock
      if (acc.lockedProfit > 0 && !acc.stopped) {
        acc.stopped = true
        this.log(`PROFIT LOCKED: $${acc.lockedProfit.toFixed(2)} guaranteed on ${acc.marketId}`)
        activityLogger.logTrade(`Gabagool PROFIT LOCKED: $${acc.lockedProfit.toFixed(2)}`)
        this.emit('profitLocked', { marketId: acc.marketId, profit: acc.lockedProfit, pairCost: acc.pairCost })
        this.attemptMerge(acc).catch(err => this.log(`Merge after profit lock failed: ${err}`))
      }

      return // Found the accumulator, done
    }
  }

  private recomputeDerived(acc: WindowAccumulator): void {
    const minQty = Math.min(acc.qtyYes, acc.qtyNo)
    const maxQty = Math.max(acc.qtyYes, acc.qtyNo)
    const totalCost = acc.costYes + acc.costNo

    acc.pairCost = minQty > 0 ? totalCost / minQty : Infinity
    acc.lockedProfit = minQty > 0 ? minQty - totalCost : -totalCost
    acc.imbalance = maxQty > 0 ? Math.abs(acc.qtyYes - acc.qtyNo) / maxQty : 0
  }

  // ==========================================
  // SCAN CYCLE
  // ==========================================

  private async runScanCycle(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return
    if (this.scanning) return  // Prevent overlapping async scan cycles

    // Early exit if emergency stop is active — don't waste cycles scanning
    try {
      const { riskManager } = await import('@/services/trading/RiskManager')
      if (riskManager.emergencyStopped) return
    } catch { /* proceed if import fails */ }

    this.scanning = true

    try {
      // 1. Discover markets
      await this.discoverMarkets()

      // 2. Evict expired accumulators
      const now = Date.now()
      for (const [marketId, acc] of this.accumulators) {
        if (acc.windowEndMs < now) {
          this.log(`Window expired for ${marketId} — evicting`)
          // Cancel pending orders
          for (const orderId of acc.pendingOrderIds) {
            this.cancelOrder(orderId)
          }
          // Attempt merge if we have both sides
          if (acc.qtyYes > 0 && acc.qtyNo > 0) {
            this.attemptMerge(acc).catch(err => this.log(`Merge on eviction failed: ${err}`))
          }
          // Log final stats
          if (acc.fills.length > 0) {
            activityLogger.logTrade(
              `Gabagool window closed: ${acc.fills.length} fills, ` +
              `pair=${acc.pairCost.toFixed(4)}, profit=${acc.lockedProfit.toFixed(2)}`,
            )
          }
          this.accumulators.delete(marketId)
        }
      }

      // 3. Evaluate and potentially order for each active accumulator
      for (const [, acc] of this.accumulators) {
        await this.evaluateAndOrder(acc)
      }

      // 4. Cancel stale pending orders (older than 30s without fill)
      await this.cancelStaleOrders()

    } catch (err) {
      this.log(`Scan cycle error: ${err}`)
    } finally {
      this.scanning = false
    }
  }

  // ==========================================
  // MARKET DISCOVERY
  // ==========================================

  private async discoverMarkets(): Promise<void> {
    const prefix = ASSET_SLUG_PATTERNS['BTC']?.['15m']
    if (!prefix) return

    const intervalSec = 900 // 15 minutes
    const nowSec = Math.floor(Date.now() / 1000)
    const currentWindowStart = Math.floor(nowSec / intervalSec) * intervalSec
    const nextWindowStart = currentWindowStart + intervalSec

    const slugs = [
      `${prefix}${currentWindowStart}`,
      `${prefix}${nextWindowStart}`,
    ]

    for (const slug of slugs) {
      try {
        const { polymarketClient } = await import('@/services/api/PolymarketClient')
        const event = await polymarketClient.getEventBySlug(slug)
        if (!event) continue

        const eventMarkets = event.markets || []
        for (const m of eventMarkets) {
          // Skip if already tracking, inactive, or no token IDs
          if (this.accumulators.has(m.id)) continue
          if (!m.active || m.closed) continue
          if (!m.clobTokenIds || m.clobTokenIds.length < 2) continue

          const windowEndMs = new Date(m.endDate).getTime()
          const now = Date.now()

          // Skip if not enough time remaining
          if (windowEndMs - now < this.gabagoolConfig.minWindowRemainingMs) continue

          // Create accumulator
          const acc: WindowAccumulator = {
            marketId: m.id,
            market: m,
            conditionId: m.conditionId,
            yesTokenId: m.clobTokenIds[0],
            noTokenId: m.clobTokenIds[1],
            windowEndMs,
            qtyYes: 0, qtyNo: 0,
            costYes: 0, costNo: 0,
            fills: [],
            pairCost: Infinity,
            lockedProfit: 0,
            imbalance: 0,
            pendingOrderIds: new Set(),
            lastOrderTime: 0,
            totalOrders: 0,
            stopped: false,
          }

          this.accumulators.set(m.id, acc)

          // Map token IDs for fill detection
          this.tokenToMarketMap.set(m.clobTokenIds[0], { marketId: m.id, side: 'yes' })
          this.tokenToMarketMap.set(m.clobTokenIds[1], { marketId: m.id, side: 'no' })

          // Subscribe to live CLOB prices
          if (this.realtimeServiceRef) {
            this.realtimeServiceRef.subscribeMarket(m.clobTokenIds)
          }

          this.log(`Tracking ${m.question || slug} (ends ${new Date(windowEndMs).toLocaleTimeString()})`)
        }
      } catch {
        // Slug not found — expected for future windows
      }
    }
  }

  // ==========================================
  // CORE EVALUATION LOOP
  // ==========================================

  async evaluateAndOrder(acc: WindowAccumulator): Promise<void> {
    if (acc.stopped) return

    const config = this.gabagoolConfig
    const now = Date.now()

    // Gate: window ending soon
    if (acc.windowEndMs - now < config.minWindowRemainingMs) {
      acc.stopped = true
      this.log(`Window ending soon for ${acc.marketId} — stopping`)
      return
    }

    // Gate: max exposure reached
    const totalExposure = acc.costYes + acc.costNo
    if (totalExposure >= config.maxExposurePerWindow) {
      this.log(`Max exposure $${totalExposure.toFixed(2)} reached for ${acc.marketId}`)
      return
    }

    // Gate: profit already locked
    if (acc.lockedProfit > 0) {
      acc.stopped = true
      return
    }

    // Gate: cooldown
    if (now - acc.lastOrderTime < config.cooldownMs) return

    // Gate: VPIN toxicity — skip cycle if informed flow detected
    try {
      const { vpinService } = await import('@/services/trading/VPINService')
      if (vpinService.isToxic(acc.yesTokenId) || vpinService.isToxic(acc.noTokenId)) {
        return // Silently skip — don't stop the accumulator, just wait
      }
    } catch { /* VPIN unavailable — proceed */ }

    // Gate: too many pending orders (prevent order buildup)
    if (acc.pendingOrderIds.size >= 3) return

    // Get live CLOB ask prices
    if (!this.realtimeServiceRef) return

    const yesPrice = this.realtimeServiceRef.getPrice(acc.yesTokenId)
    const noPrice = this.realtimeServiceRef.getPrice(acc.noTokenId)

    if (!yesPrice || !noPrice) return

    const yesAsk = yesPrice.ask
    const noAsk = noPrice.ask

    if (yesAsk <= 0 || noAsk <= 0) return

    // Check staleness (>30s old data is unreliable)
    if (this.realtimeServiceRef.isStale?.(acc.yesTokenId, 30_000)) return
    if (this.realtimeServiceRef.isStale?.(acc.noTokenId, 30_000)) return

    // Determine which side to buy
    const side = this.chooseSide(acc, yesAsk, noAsk, config)
    if (!side) return

    const askPrice = side === 'yes' ? yesAsk : noAsk
    const bidPrice = side === 'yes' ? (yesPrice.bid || 0) : (noPrice.bid || 0)

    // Place below ask for maker status. AS pricer when enabled, static offset fallback.
    let naiveLimit = askPrice - config.limitPriceOffset

    if (useSettingsStore.getState().useAvellanedaStoikov) {
      try {
        const { AvellanedaStoikovPricer } = await import('@/services/trading/AvellanedaStoikovPricer')
        const { btcUpDownStrategy } = await import('./BtcUpDownStrategy')
        const settings = useSettingsStore.getState()
        const highFreq = btcUpDownStrategy.getHighFreqPrices('BTC')
        const vol = AvellanedaStoikovPricer.estimateVolatility(highFreq.map(p => p.price), 1000, 900_000)
        const targetQty = config.maxExposurePerWindow / askPrice
        const inventory = AvellanedaStoikovPricer.gabagoolInventory(acc.qtyYes, acc.qtyNo, targetQty)

        const quotes = AvellanedaStoikovPricer.computeQuotes({
          midPrice: askPrice,
          inventory: side === 'yes' ? inventory : -inventory,
          sigma: vol.sigma,
          timeRemaining: Math.max(0, (acc.windowEndMs - now) / (15 * 60_000)),
          gamma: settings.asRiskAversion,
          kappa: settings.asOrderArrivalRate,
        })
        naiveLimit = quotes.bidPrice
      } catch { /* AS pricer failed — keep static offset */ }
    }

    // postOnly orders MUST sit below the best ask to avoid "crosses book" rejection.
    const limitPrice = Math.max(0.01, bidPrice > 0 ? Math.min(naiveLimit, bidPrice) : naiveLimit)

    // Additional arb viability check: would this side + other side's ask still be < $1.00?
    const otherAsk = side === 'yes' ? noAsk : yesAsk
    if (limitPrice + otherAsk >= 1.00) {
      // No merge arb edge at these prices — skip
      return
    }

    const remainingBudget = config.maxExposurePerWindow - totalExposure
    const orderUSD = Math.min(config.orderSize, remainingBudget)

    if (orderUSD < 0.50) return // Below CLOB minimum practical size

    // Place maker-only GTC order
    try {
      const { tradingService } = await import('@/services/trading/TradingService')

      const result = await tradingService.placeBet(acc.market, side, orderUSD, {
        orderType: 'GTC',
        skipGtcFallback: true,
        strategy: 'gabagool',
        postOnly: true,
        limitPrice,
      })

      if (result.orderId) {
        acc.pendingOrderIds.add(result.orderId)
        acc.lastOrderTime = now
        acc.totalOrders++

        // Store orderId→side for fill attribution and tokenId→market for fallback
        this.orderSideMap.set(result.orderId, side)
        const tokenId = side === 'yes' ? acc.yesTokenId : acc.noTokenId
        this.tokenToMarketMap.set(tokenId, { marketId: acc.marketId, side })

        this.log(
          `ORDER ${side.toUpperCase()} $${orderUSD.toFixed(2)} @ ${(limitPrice * 100).toFixed(0)}c ` +
          `(ask=${(askPrice * 100).toFixed(0)}c) ${acc.market.question?.slice(0, 30) || acc.marketId}`,
        )
        this.emit('orderPlaced', { marketId: acc.marketId, side, price: limitPrice, size: orderUSD })
      }
    } catch (err) {
      const msg = String(err)
      // "crosses book" is expected with postOnly — don't spam logs
      if (msg.includes('crosses book')) {
        this.log(`PostOnly rejected (ask moved) — will retry next cycle`)
      } else {
        this.log(`Order failed: ${msg}`)
      }
    }
  }

  // ==========================================
  // SIDE SELECTION
  // ==========================================

  /**
   * Decide which side to buy (or null to skip).
   *
   * Priority:
   * 1. If imbalance too high → buy lagging side (if cheap enough)
   * 2. Buy whichever side is below cheapness threshold
   * 3. Dynamic threshold: buy if adding to this side keeps pair cost < target
   * 4. If both cheap → buy the cheaper one
   */
  chooseSide(
    acc: WindowAccumulator,
    yesAsk: number,
    noAsk: number,
    config: GabagoolConfig,
  ): 'yes' | 'no' | null {
    const HARD_CAP = 0.55 // Never buy above 55c regardless

    // Priority 1: Rebalance if imbalance is too high
    if (acc.qtyYes > 0 && acc.qtyNo > 0 && acc.imbalance > config.maxImbalance) {
      const laggingSide = acc.qtyYes < acc.qtyNo ? 'yes' : 'no'
      const laggingAsk = laggingSide === 'yes' ? yesAsk : noAsk
      if (laggingAsk < HARD_CAP) {
        return laggingSide
      }
      return null // Lagging side too expensive, skip
    }

    // Determine cheapness for each side
    const yesIsCheap = yesAsk < config.cheapnessThreshold && yesAsk < HARD_CAP
    const noIsCheap = noAsk < config.cheapnessThreshold && noAsk < HARD_CAP

    // Dynamic threshold: if we have an avg on the other side, check if this
    // buy would keep pair cost below target
    if (acc.qtyNo > 0 && !yesIsCheap) {
      const avgNo = acc.costNo / acc.qtyNo
      const dynamicYesThreshold = 1.00 - avgNo - (1 - config.minProfitMargin)
      if (yesAsk < dynamicYesThreshold && yesAsk < HARD_CAP) {
        return 'yes'
      }
    }
    if (acc.qtyYes > 0 && !noIsCheap) {
      const avgYes = acc.costYes / acc.qtyYes
      const dynamicNoThreshold = 1.00 - avgYes - (1 - config.minProfitMargin)
      if (noAsk < dynamicNoThreshold && noAsk < HARD_CAP) {
        return 'no'
      }
    }

    // Priority 2: Both cheap → buy cheaper
    if (yesIsCheap && noIsCheap) {
      return yesAsk <= noAsk ? 'yes' : 'no'
    }

    // Priority 3: One side cheap
    if (yesIsCheap) return 'yes'
    if (noIsCheap) return 'no'

    return null // Nothing cheap enough
  }

  // ==========================================
  // MERGE
  // ==========================================

  private async attemptMerge(acc: WindowAccumulator): Promise<void> {
    if (!acc.conditionId) {
      this.log(`Merge skipped for ${acc.marketId} — no conditionId`)
      return
    }
    if (acc.qtyYes <= 0 || acc.qtyNo <= 0) return

    try {
      const { mergeService } = await import('@/services/trading/MergeService')

      if (!mergeService.isReady()) {
        const { walletService } = await import('@/services/wallet/WalletService')
        const wallet = walletService.getWallet()
        if (wallet) {
          mergeService.initialize(wallet)
        } else {
          this.log('Merge skipped — no wallet')
          return
        }
      }

      const mergeAmount = mergeService.computeMergeAmount(acc.qtyYes, acc.qtyNo)
      if (mergeAmount <= 0n) return

      this.log(`Merging ${Number(mergeAmount) / 1e6} USDC.e for ${acc.marketId}`)
      const result = await mergeService.merge(acc.conditionId, mergeAmount)

      if (result.success) {
        this.log(`MERGE SUCCESS: ${result.amountMerged?.toFixed(2)} USDC.e recovered`)
        this.emit('merged', { marketId: acc.marketId, ...result })
      } else {
        this.log(`Merge failed (non-critical): ${result.error}`)
      }
    } catch (err) {
      this.log(`Merge error (non-critical): ${err}`)
    }
  }

  // ==========================================
  // ORDER MANAGEMENT
  // ==========================================

  private async cancelOrder(orderId: string): Promise<void> {
    try {
      const { tradingService } = await import('@/services/trading/TradingService')
      await tradingService.cancelOrder(orderId)
    } catch {
      // Best-effort cancel
    }
  }

  private async cancelAllPendingOrders(): Promise<void> {
    const allOrderIds: string[] = []
    for (const acc of this.accumulators.values()) {
      for (const orderId of acc.pendingOrderIds) {
        allOrderIds.push(orderId)
      }
      acc.pendingOrderIds.clear()
    }

    for (const orderId of allOrderIds) {
      await this.cancelOrder(orderId)
    }
    if (allOrderIds.length > 0) {
      this.log(`Cancelled ${allOrderIds.length} pending orders`)
    }
  }

  private async cancelStaleOrders(): Promise<void> {
    const config = this.gabagoolConfig
    const now = Date.now()

    for (const acc of this.accumulators.values()) {
      if (acc.pendingOrderIds.size === 0) continue
      if (now - acc.lastOrderTime < config.staleOrderMs) continue

      // Snapshot and clear BEFORE cancelling — prevents double-cancel if
      // an overlapping scan cycle somehow enters this code path
      const staleIds = [...acc.pendingOrderIds]
      acc.pendingOrderIds.clear()

      for (const orderId of staleIds) {
        await this.cancelOrder(orderId)
        this.log(`Cancelled stale order ${orderId}`)
      }
    }
  }

  // ==========================================
  // UTILITIES
  // ==========================================

  protected log(message: string): void {
    console.log(`[Gabagool] ${message}`)
  }

  /** Expose accumulators for testing and dashboard */
  getAccumulators(): Map<string, WindowAccumulator> {
    return this.accumulators
  }

  /** Get stats for a specific window */
  getWindowStats(marketId: string): WindowAccumulator | undefined {
    return this.accumulators.get(marketId)
  }
}

// ==========================================
// SINGLETON EXPORT
// ==========================================

export const gabagoolStrategy = new GabagoolStrategy()
