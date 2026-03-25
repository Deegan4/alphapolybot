/**
 * Gabagool Strategy — Direction-Agnostic Accumulation Merge Arbitrage
 *
 * Buys whichever side (YES or NO) of a BTC binary market is
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
 *
 * v2 Upgrades:
 * - Multi-duration: 15m, 1h, 4h windows (configurable)
 * - Order book depth-aware sizing: scales orders to available liquidity
 * - Adaptive cheapness: widens threshold when ask sum is far below $1.00
 * - Cross-window capital recycling: sells orphaned one-sided positions
 * - Fill-rate feedback: EMA on fill latency adjusts limit price offset
 * - Spread monitoring: skips tight-spread markets where maker fills are unlikely
 */

import { BaseStrategy } from './BaseStrategy'
import type { Market } from '@/types'
import { buildHourlySlug, ASSET_SLUG_PATTERNS } from './BtcUpDownStrategy'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'

// ==========================================
// TYPES
// ==========================================

export type GabagoolDuration = '15m' | '1h' | '4h'

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
  durations: GabagoolDuration[]
  depthAwareSizing: boolean
  adaptiveCheapness: boolean
  fillRateFeedback: boolean
  spreadMinWidth: number
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
  duration: GabagoolDuration
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

/** Per-duration timing config */
const DURATION_TIMING: Record<GabagoolDuration, { minWindowRemainingMs: number; staleOrderMs: number }> = {
  '15m': { minWindowRemainingMs: 60_000, staleOrderMs: 15_000 },    // 1 min min remaining, 15s stale
  '1h':  { minWindowRemainingMs: 300_000, staleOrderMs: 60_000 },   // 5 min min remaining, 60s stale
  '4h':  { minWindowRemainingMs: 900_000, staleOrderMs: 120_000 },  // 15 min min remaining, 2m stale
}

// ==========================================
// FILL RATE TRACKER
// ==========================================

interface FillRateState {
  emaFillLatencyMs: number   // EMA of time from order placement to fill
  totalFills: number
  totalOrders: number
}

// ==========================================
// STRATEGY
// ==========================================

export class GabagoolStrategy extends BaseStrategy {
  name = 'Gabagool Accumulator'
  description = 'Direction-agnostic accumulation merge arb on BTC markets'
  strategyType = 'mechanical' as const

  private accumulators = new Map<string, WindowAccumulator>()
  private scanInterval: ReturnType<typeof setInterval> | null = null
  private scanning = false  // Guard against overlapping async scan cycles
  private cleanupFns: Array<() => void> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private realtimeServiceRef: any = null
  private tokenToMarketMap = new Map<string, { marketId: string; side: 'yes' | 'no' }>()
  private orderSideMap = new Map<string, 'yes' | 'no'>()  // orderId → side for fill attribution
  private orderPlacedAt = new Map<string, number>()  // orderId → timestamp for fill latency

  // Fill-rate feedback state (shared across all windows)
  private fillRate: FillRateState = { emaFillLatencyMs: 5000, totalFills: 0, totalOrders: 0 }
  private static readonly FILL_EMA_ALPHA = 0.3  // Weight of new observation

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
      minWindowRemainingMs: 300_000,
      staleOrderMs: 60_000,
      durations: s.gabagoolDurations ?? ['1h'],
      depthAwareSizing: s.gabagoolDepthAwareSizing ?? false,
      adaptiveCheapness: s.gabagoolAdaptiveCheapness ?? true,
      fillRateFeedback: s.gabagoolFillRateFeedback ?? false,
      spreadMinWidth: s.gabagoolSpreadMinWidth ?? 0.02,
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
    const config = this.gabagoolConfig
    this.log(`Gabagool strategy started — durations: ${config.durations.join(', ')}`)

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
    this.orderPlacedAt.clear()
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

      // Update fill-rate feedback
      this.updateFillRate(orderId)

      // Recompute derived fields
      this.recomputeDerived(acc)

      this.log(
        `FILL ${side.toUpperCase()} ${qty.toFixed(2)} @ ${price.toFixed(3)} | ` +
        `pair=${acc.pairCost.toFixed(4)} profit=${acc.lockedProfit.toFixed(2)} imbal=${(acc.imbalance * 100).toFixed(0)}%`,
      )
      this.emit('accumulationFill', { marketId: acc.marketId, side, price, qty, cost, pairCost: acc.pairCost })

      // Hyperliquid hedge: when imbalance exceeds threshold, hedge the unpaired exposure
      this.manageHedge(acc, side, cost).catch(err => this.log(`Hedge management failed: ${err}`))

      // Check profit lock
      if (acc.lockedProfit > 0 && !acc.stopped) {
        acc.stopped = true
        this.log(`PROFIT LOCKED: $${acc.lockedProfit.toFixed(2)} guaranteed on ${acc.marketId}`)
        activityLogger.logTrade(`Gabagool PROFIT LOCKED: $${acc.lockedProfit.toFixed(2)}`)
        this.emit('profitLocked', { marketId: acc.marketId, profit: acc.lockedProfit, pairCost: acc.pairCost })
        this.attemptMerge(acc).catch(err => this.log(`Merge after profit lock failed: ${err}`))
        // Close any open hedge — exposure is now paired
        this.closeHedgeForAccumulator(acc.marketId).catch(() => {})
      }

      return // Found the accumulator, done
    }
  }

  private updateFillRate(orderId: string): void {
    const placedAt = this.orderPlacedAt.get(orderId)
    if (!placedAt) return
    this.orderPlacedAt.delete(orderId)

    const latency = Date.now() - placedAt
    this.fillRate.totalFills++
    this.fillRate.emaFillLatencyMs =
      GabagoolStrategy.FILL_EMA_ALPHA * latency +
      (1 - GabagoolStrategy.FILL_EMA_ALPHA) * this.fillRate.emaFillLatencyMs
  }

  recomputeDerived(acc: WindowAccumulator): void {
    const minQty = Math.min(acc.qtyYes, acc.qtyNo)
    const maxQty = Math.max(acc.qtyYes, acc.qtyNo)
    const totalCost = acc.costYes + acc.costNo

    acc.pairCost = minQty > 0 ? totalCost / minQty : Infinity
    acc.lockedProfit = minQty > 0 ? minQty - totalCost : -totalCost
    acc.imbalance = maxQty > 0 ? Math.abs(acc.qtyYes - acc.qtyNo) / maxQty : 0
  }

  // ==========================================
  // HYPERLIQUID HEDGE MANAGEMENT
  // ==========================================

  /** hedgeId per accumulator marketId */
  private activeHedges = new Map<string, string>()

  /**
   * Open or close a Hyperliquid hedge based on current imbalance.
   *
   * When one side fills but the other hasn't, we have directional BTC exposure.
   * Hedge on Hyperliquid to neutralize until the paired fill arrives.
   */
  private async manageHedge(acc: WindowAccumulator, fillSide: 'yes' | 'no', fillCostUSD: number): Promise<void> {
    const config = this.gabagoolConfig

    // Only hedge if imbalance exceeds threshold and we don't already have a hedge
    if (acc.imbalance <= config.maxImbalance) {
      // Imbalance is acceptable — close any existing hedge
      if (this.activeHedges.has(acc.marketId)) {
        await this.closeHedgeForAccumulator(acc.marketId)
      }
      return
    }

    // Already hedged for this accumulator
    if (this.activeHedges.has(acc.marketId)) return

    try {
      const { hyperliquidHedgeService } = await import('@/services/trading/HyperliquidHedgeService')
      if (!hyperliquidHedgeService.isReady()) return

      // Determine hedge direction:
      // If we filled YES (bullish BTC), we're long → hedge by shorting
      // If we filled NO (bearish BTC), we're short → hedge by going long
      const heavySide = acc.qtyYes > acc.qtyNo ? 'yes' : 'no'
      const hedgeSide = heavySide === 'yes' ? 'short' : 'long'

      // Hedge size = cost of the unpaired portion
      const unpairedUSD = Math.abs(acc.costYes - acc.costNo)
      if (unpairedUSD < 0.50) return  // Not worth hedging tiny amounts

      const result = await hyperliquidHedgeService.openHedge('BTC', hedgeSide, unpairedUSD, acc.marketId)
      if (result.success && result.hedgeId) {
        this.activeHedges.set(acc.marketId, result.hedgeId)
        this.log(`HEDGE OPENED: ${hedgeSide} BTC $${unpairedUSD.toFixed(2)} for ${acc.marketId} (imbal=${(acc.imbalance * 100).toFixed(0)}%)`)
      }
    } catch {
      // Hedge service not available — proceed without hedge (original behavior)
    }
  }

  private async closeHedgeForAccumulator(marketId: string): Promise<void> {
    const hedgeId = this.activeHedges.get(marketId)
    if (!hedgeId) return

    try {
      const { hyperliquidHedgeService } = await import('@/services/trading/HyperliquidHedgeService')
      await hyperliquidHedgeService.closeHedge(hedgeId)
      this.activeHedges.delete(marketId)
      this.log(`HEDGE CLOSED for ${marketId}`)
    } catch {
      // Best effort — hedge will expire or be closed manually
    }
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
          // Attempt to sell orphaned one-sided positions
          if ((acc.qtyYes > 0) !== (acc.qtyNo > 0)) {
            this.recycleOrphanedPosition(acc).catch(err => this.log(`Recycle failed: ${err}`))
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

      // 4. Cancel stale pending orders (older than staleOrderMs without fill)
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
    const config = this.gabagoolConfig

    for (const duration of config.durations) {
      if (duration === '1h') {
        await this.discoverHourlyMarkets()
      } else {
        await this.discoverSlugMarkets(duration)
      }
    }

    // Also scan weather markets if enabled
    await this.discoverWeatherMarkets()
  }

  /** Discover weather markets via WeatherMarketAdapter */
  private async discoverWeatherMarkets(): Promise<void> {
    try {
      const { weatherMarketAdapter } = await import('./WeatherMarketAdapter')
      const markets = weatherMarketAdapter.getActiveMarkets()

      for (const m of markets) {
        // Skip if already tracking, inactive, or no token IDs
        if (this.accumulators.has(m.id)) continue
        if (!m.active || m.closed) continue
        if (!m.clobTokenIds || m.clobTokenIds.length < 2) continue

        const windowEndMs = new Date(m.endDate).getTime()
        // Weather markets typically resolve in 24h+ — use 1h timing
        if (windowEndMs - Date.now() < DURATION_TIMING['1h'].minWindowRemainingMs) continue

        const acc: WindowAccumulator = {
          marketId: m.id,
          market: m,
          conditionId: m.conditionId,
          yesTokenId: m.clobTokenIds[0],
          noTokenId: m.clobTokenIds[1],
          windowEndMs,
          duration: '1h', // use 1h timing for weather (most conservative)
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
        this.tokenToMarketMap.set(m.clobTokenIds[0], { marketId: m.id, side: 'yes' })
        this.tokenToMarketMap.set(m.clobTokenIds[1], { marketId: m.id, side: 'no' })

        if (this.realtimeServiceRef) {
          this.realtimeServiceRef.subscribeMarket(m.clobTokenIds)
        }

        this.log(`Tracking [weather] ${m.question || m.id} (liq: $${m.liquidity.toFixed(0)})`)
      }
    } catch {
      // Weather adapter not available — proceed with crypto-only
    }
  }

  /** Discover hourly markets using buildHourlySlug */
  private async discoverHourlyMarkets(): Promise<void> {
    const now = new Date()
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000)

    const slugs = [
      buildHourlySlug('BTC', now),
      buildHourlySlug('BTC', nextHour),
    ].filter(Boolean)

    for (const slug of slugs) {
      await this.discoverBySlug(slug, '1h')
    }
  }

  /** Discover 15m/4h markets via ASSET_SLUG_PATTERNS */
  private async discoverSlugMarkets(duration: '15m' | '4h'): Promise<void> {
    const prefix = ASSET_SLUG_PATTERNS.BTC?.[duration]
    if (!prefix) return

    const intervalSec = duration === '15m' ? 900 : 14400
    const nowSec = Math.floor(Date.now() / 1000)

    // Current window + next window
    const currentStart = Math.floor(nowSec / intervalSec) * intervalSec
    const nextStart = currentStart + intervalSec

    for (const startSec of [currentStart, nextStart]) {
      const slug = `${prefix}${startSec}`
      await this.discoverBySlug(slug, duration)
    }
  }

  /** Shared discovery logic: resolve slug → create accumulators */
  private async discoverBySlug(slug: string, duration: GabagoolDuration): Promise<void> {
    const config = this.gabagoolConfig
    const timing = DURATION_TIMING[duration]

    try {
      const { polymarketClient } = await import('@/services/api/PolymarketClient')
      const event = await polymarketClient.getEventBySlug(slug)
      if (!event) return

      const eventMarkets = event.markets || []
      for (const m of eventMarkets) {
        // Skip if already tracking, inactive, or no token IDs
        if (this.accumulators.has(m.id)) continue
        if (!m.active || m.closed) continue
        if (!m.clobTokenIds || m.clobTokenIds.length < 2) continue

        const windowEndMs = new Date(m.endDate).getTime()

        // Skip if not enough time remaining (use per-duration timing)
        if (windowEndMs - Date.now() < timing.minWindowRemainingMs) continue

        // Create accumulator
        const acc: WindowAccumulator = {
          marketId: m.id,
          market: m,
          conditionId: m.conditionId,
          yesTokenId: m.clobTokenIds[0],
          noTokenId: m.clobTokenIds[1],
          windowEndMs,
          duration,
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

        // Compute max exposure per window based on duration
        const exposureLabel = `$${config.maxExposurePerWindow}`
        this.log(`Tracking [${duration}] ${m.question || slug} (ends ${new Date(windowEndMs).toLocaleTimeString()}) max=${exposureLabel}`)
      }
    } catch {
      // Slug not found — expected for future windows
    }
  }

  // ==========================================
  // CORE EVALUATION LOOP
  // ==========================================

  async evaluateAndOrder(acc: WindowAccumulator): Promise<void> {
    if (acc.stopped) return

    const config = this.gabagoolConfig
    const now = Date.now()
    const timing = DURATION_TIMING[acc.duration]

    // Gate: window ending soon (per-duration timing)
    if (acc.windowEndMs - now < timing.minWindowRemainingMs) {
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

    // Gate: hopeless imbalance — past 50% of window with only one side filled.
    // Continuing to accumulate just builds orphan exposure. Stop early and let
    // recycleOrphanedPosition() recover what it can at market close.
    const windowElapsedPct = (now - (acc.windowEndMs - this.durationMs(acc.duration))) / this.durationMs(acc.duration)
    if (windowElapsedPct > 0.50 && totalExposure > 0) {
      const minQty = Math.min(acc.qtyYes, acc.qtyNo)
      const maxQty = Math.max(acc.qtyYes, acc.qtyNo)
      if (maxQty > 0 && minQty / maxQty < 0.25) {
        acc.stopped = true
        this.log(`Hopeless imbalance for ${acc.marketId}: ${(minQty / maxQty * 100).toFixed(0)}% paired at ${(windowElapsedPct * 100).toFixed(0)}% elapsed — stopping`)
        return
      }
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

    // Check staleness (per-duration: 30s for short, relaxed for longer windows)
    const stalenessMs = acc.duration === '4h' ? 60_000 : 30_000
    if (this.realtimeServiceRef.isStale?.(acc.yesTokenId, stalenessMs)) return
    if (this.realtimeServiceRef.isStale?.(acc.noTokenId, stalenessMs)) return

    // Gate: spread monitoring — skip if spread is too tight for maker fills
    const yesSpread = yesAsk - (yesPrice.bid || 0)
    const noSpread = noAsk - (noPrice.bid || 0)
    if (config.spreadMinWidth > 0) {
      const relevantSpread = Math.max(yesSpread, noSpread)
      if (relevantSpread < config.spreadMinWidth) {
        return // Spread too tight — makers competing, low fill probability
      }
    }

    // Determine which side to buy (with adaptive cheapness)
    const side = this.chooseSide(acc, yesAsk, noAsk, config)
    if (!side) return

    const askPrice = side === 'yes' ? yesAsk : noAsk
    const bidPrice = side === 'yes' ? (yesPrice.bid || 0) : (noPrice.bid || 0)

    // Place below ask for maker status. AS pricer when enabled, static offset fallback.
    let naiveLimit = askPrice - this.effectiveLimitOffset(config)

    if (useSettingsStore.getState().useAvellanedaStoikov) {
      try {
        const { AvellanedaStoikovPricer } = await import('@/services/trading/AvellanedaStoikovPricer')
        const { btcUpDownStrategy } = await import('./BtcUpDownStrategy')
        const settings = useSettingsStore.getState()
        const highFreq = btcUpDownStrategy.getHighFreqPrices('BTC')
        const vol = AvellanedaStoikovPricer.estimateVolatility(highFreq.map(p => p.price), 1000, 3_600_000)
        const targetQty = config.maxExposurePerWindow / askPrice
        const inventory = AvellanedaStoikovPricer.gabagoolInventory(acc.qtyYes, acc.qtyNo, targetQty)

        const quotes = AvellanedaStoikovPricer.computeQuotes({
          midPrice: askPrice,
          inventory: side === 'yes' ? inventory : -inventory,
          sigma: vol.sigma,
          timeRemaining: Math.max(0, (acc.windowEndMs - now) / (60 * 60_000)),
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

    // Compute order size (depth-aware or flat)
    const remainingBudget = config.maxExposurePerWindow - totalExposure
    let orderUSD = Math.min(config.orderSize, remainingBudget)

    if (config.depthAwareSizing) {
      orderUSD = await this.depthAdjustedSize(
        side === 'yes' ? acc.yesTokenId : acc.noTokenId,
        orderUSD,
      )
    }

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
        asset: 'BTC',
      })

      if (result.orderId) {
        acc.pendingOrderIds.add(result.orderId)
        acc.lastOrderTime = now
        acc.totalOrders++
        this.fillRate.totalOrders++

        // Store orderId→side for fill attribution and timestamp for latency tracking
        this.orderSideMap.set(result.orderId, side)
        this.orderPlacedAt.set(result.orderId, now)
        const tokenId = side === 'yes' ? acc.yesTokenId : acc.noTokenId
        this.tokenToMarketMap.set(tokenId, { marketId: acc.marketId, side })

        this.log(
          `ORDER [${acc.duration}] ${side.toUpperCase()} $${orderUSD.toFixed(2)} @ ${(limitPrice * 100).toFixed(0)}c ` +
          `(ask=${(askPrice * 100).toFixed(0)}c spread=${(askPrice - bidPrice).toFixed(3)}) ` +
          `${acc.market.question?.slice(0, 30) || acc.marketId}`,
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
   *
   * Adaptive cheapness: when ask sum is far below $1.00, the threshold
   * widens proportionally — more aggressive buying when the arb edge is large.
   */
  chooseSide(
    acc: WindowAccumulator,
    yesAsk: number,
    noAsk: number,
    config: GabagoolConfig,
  ): 'yes' | 'no' | null {
    const HARD_CAP = 0.55 // Never buy above 55c regardless

    // Adaptive cheapness: widen threshold when ask sum signals strong arb edge
    let effectiveThreshold = config.cheapnessThreshold
    if (config.adaptiveCheapness) {
      const askSum = yesAsk + noAsk
      if (askSum < 0.95) {
        // askSum of 0.90 → +3c boost, 0.85 → +5c boost, etc.
        const boost = Math.min(0.07, (0.95 - askSum) * 0.5)
        effectiveThreshold = Math.min(HARD_CAP, effectiveThreshold + boost)
      }
    }

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
    const yesIsCheap = yesAsk < effectiveThreshold && yesAsk < HARD_CAP
    const noIsCheap = noAsk < effectiveThreshold && noAsk < HARD_CAP

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

    // Priority 3: One side cheap — but only if the OTHER side's ask makes a
    // sub-$1.00 pair plausible. Without this, we build one-sided exposure that
    // resolves as a 50/50 directional bet rather than a guaranteed merge arb.
    if (yesIsCheap && yesAsk + noAsk < 1.00) return 'yes'
    if (noIsCheap && yesAsk + noAsk < 1.00) return 'no'

    return null // Nothing cheap enough or no merge edge
  }

  // ==========================================
  // DEPTH-AWARE SIZING
  // ==========================================

  /**
   * Scale order size to available book depth. Returns the lesser of
   * desired size and 50% of available liquidity within 2% slippage.
   */
  private async depthAdjustedSize(tokenId: string, desiredUSD: number): Promise<number> {
    try {
      const { orderBookDepth } = await import('@/services/trading/OrderBookDepth')
      const depth = await orderBookDepth.checkBuyDepth(tokenId, desiredUSD, 0.02)
      if (!depth.sufficient && depth.maxFillableUSD > 0) {
        // Cap at 50% of available liquidity to avoid moving the book
        return Math.max(0.50, Math.min(desiredUSD, depth.maxFillableUSD * 0.5))
      }
      return desiredUSD
    } catch {
      return desiredUSD // Depth check failed, use original size
    }
  }

  // ==========================================
  // FILL-RATE FEEDBACK
  // ==========================================

  /**
   * Adjust limit price offset based on fill-rate feedback.
   * Fast fills (< 2s) → widen offset (leaving money on table).
   * Slow fills (> 10s) → tighten offset (improve fill rate).
   */
  private durationMs(duration: GabagoolDuration): number {
    switch (duration) {
      case '15m': return 15 * 60_000
      case '1h':  return 60 * 60_000
      case '4h':  return 4 * 60 * 60_000
    }
  }

  private effectiveLimitOffset(config: GabagoolConfig): number {
    if (!config.fillRateFeedback || this.fillRate.totalFills < 3) {
      return config.limitPriceOffset
    }

    const ema = this.fillRate.emaFillLatencyMs
    if (ema < 2000) {
      // Fills too fast — we're under-pricing, widen offset for better entry
      return Math.min(0.03, config.limitPriceOffset + 0.005)
    }
    if (ema > 10000) {
      // Fills too slow — tighten offset to improve fill probability
      return Math.max(0.002, config.limitPriceOffset - 0.003)
    }
    return config.limitPriceOffset
  }

  // ==========================================
  // CROSS-WINDOW CAPITAL RECYCLING
  // ==========================================

  /**
   * When a window expires with only one side filled, try to sell
   * the orphaned position at market. Better than waiting for resolution
   * on a 50/50 outcome.
   */
  private async recycleOrphanedPosition(acc: WindowAccumulator): Promise<void> {
    const orphanSide = acc.qtyYes > 0 ? 'yes' : 'no'
    const orphanQty = orphanSide === 'yes' ? acc.qtyYes : acc.qtyNo
    const orphanCost = orphanSide === 'yes' ? acc.costYes : acc.costNo

    if (orphanQty <= 0) return

    // Only sell if we can recover meaningful capital (> 80% of cost)
    const tokenId = orphanSide === 'yes' ? acc.yesTokenId : acc.noTokenId
    if (!this.realtimeServiceRef) return

    const priceData = this.realtimeServiceRef.getPrice(tokenId)
    if (!priceData?.bid || priceData.bid <= 0) return

    const recoverable = priceData.bid * orphanQty
    if (recoverable < orphanCost * 0.80) {
      this.log(`Recycle skip: ${orphanSide} bid ${priceData.bid.toFixed(3)} too low (would recover $${recoverable.toFixed(2)} vs cost $${orphanCost.toFixed(2)})`)
      return
    }

    try {
      const { tradingService } = await import('@/services/trading/TradingService')
      await tradingService.placeBet(acc.market, orphanSide === 'yes' ? 'no' : 'yes', orphanQty, {
        orderType: 'GTC',
        strategy: 'gabagool-recycle',
        postOnly: true,
        limitPrice: priceData.bid,
        asset: 'BTC',
      })
      this.log(`RECYCLE: selling ${orphanQty.toFixed(2)} ${orphanSide.toUpperCase()} @ ${priceData.bid.toFixed(3)} (recover ~$${recoverable.toFixed(2)})`)
      this.emit('recycled', { marketId: acc.marketId, side: orphanSide, qty: orphanQty, bid: priceData.bid })
    } catch (err) {
      this.log(`Recycle failed (non-critical): ${err}`)
    }
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
        const via = result.via === 'relayer' ? '(gasless relayer)' : '(direct on-chain)'
        this.log(`MERGE SUCCESS: ${result.amountMerged?.toFixed(2)} USDC.e recovered ${via}`)
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
    const now = Date.now()

    for (const acc of this.accumulators.values()) {
      if (acc.pendingOrderIds.size === 0) continue
      const timing = DURATION_TIMING[acc.duration]
      if (now - acc.lastOrderTime < timing.staleOrderMs) continue

      // Snapshot and clear BEFORE cancelling — prevents double-cancel if
      // an overlapping scan cycle somehow enters this code path
      const staleIds = [...acc.pendingOrderIds]
      acc.pendingOrderIds.clear()

      for (const orderId of staleIds) {
        await this.cancelOrder(orderId)
        this.orderPlacedAt.delete(orderId)
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

  /** Expose fill rate for dashboard/testing */
  getFillRate(): FillRateState {
    return { ...this.fillRate }
  }
}

// ==========================================
// SINGLETON EXPORT
// ==========================================

export const gabagoolStrategy = new GabagoolStrategy()
