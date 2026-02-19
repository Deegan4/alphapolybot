import type { PriceData } from '@/types'
import { realtimeService } from '@/services/realtime'
import { tradingService } from './TradingService'
import { riskManager } from './RiskManager'
import { activityLogger } from './ActivityLogger'
import { tradeLogger } from './TradeLogger'

// Default Polymarket US taker fee (flat 10 bps = 0.1%)
// Used to adjust take-profit threshold so NET profit matches user's configured percentage.
// SL doesn't need adjustment (a loss is a loss regardless of fee).
const DEFAULT_TAKER_FEE_PERCENT = 0.001

// ==========================================
// TYPES
// ==========================================

export interface TrackedPosition {
  marketSlug: string
  outcome: 'yes' | 'no'
  question: string            // market question for logging
  entryPrice: number          // price paid per share
  size: number                // shares held
  costBasis: number           // total USD spent
  entryTime: number           // Date.now() at entry
  stopLossPercent: number     // e.g. 0.15 = 15%
  takeProfitPercent: number   // e.g. 0.30 = 30%
  strategy: 'llm' | 'dip' | 'fw' | 'btc' | 'micro' | 'meanrev' | 'copy'
  takerFeeBps?: number        // per-position taker fee in bps (default 10 for PM US). Falls back to DEFAULT_TAKER_FEE_PERCENT if absent.
  // Trailing stop-loss fields
  trailingStopPercent?: number  // e.g. 0.10 = 10% trail from peak
  peakPrice?: number            // highest price seen while in profit
  // Time-based exit (max hold duration)
  maxHoldMs?: number            // max hold time in ms (0 = no limit). Default: 4 hours
  // Partial position closing (scale out winners)
  partialCloseAt?: number       // PnL% threshold to close half (e.g. 0.20 = 20%)
  partialClosed?: boolean       // whether partial close has already fired
  // Time-exit deferral — losers get one extension before forced exit
  _timeExtended?: boolean
  // Sell failure tracking — set after exhausting all retries to prevent infinite re-trigger loops
  sellFailed?: boolean
  // Resolution detection — set when price hits extreme values (≥0.95 or ≤0.05)
  // to prevent repeated logging while deferring to resolution sweep
  _resolutionDetected?: boolean
}

export interface PositionStatus extends TrackedPosition {
  currentPrice: number
  pnlPercent: number
  pnlUsd: number
  isStale: boolean   // no price update in >5 minutes
}

type PositionChangeCallback = (positions: TrackedPosition[]) => void

// ==========================================
// POSITION LIFECYCLE MANAGER
// ==========================================

/**
 * Position Lifecycle Manager
 *
 * Enforces stop-loss and take-profit by subscribing to real-time price feeds
 * and triggering sells when thresholds are breached. Also supports manual
 * force-close from the UI.
 *
 * This is the CRITICAL safety layer — without it, stop-loss/take-profit
 * config values are decorative.
 *
 * Polymarket US version: No on-chain operations. PM US handles settlement
 * and resolution automatically via centralized clearing.
 */
export class PositionLifecycleManager {
  private positions = new Map<string, TrackedPosition>()
  private unsubscribePrice: (() => void) | null = null
  private unsubscribeUserChannel: (() => void) | null = null
  private callbacks = new Set<PositionChangeCallback>()
  private sellInProgress = new Set<string>()  // prevent double-sell
  private sellRetries = new Map<string, number>()
  private maxSellRetries = 3
  private initialized = false
  private resolutionIntervalId: ReturnType<typeof setInterval> | null = null

  /**
   * Initialize — subscribe to real-time price feeds and hydrate from storage
   * Call once from App.tsx during startup
   */
  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    this.unsubscribePrice = realtimeService.onPriceUpdate(
      (slug, priceData) => this.handlePriceUpdate(slug, priceData)
    )

    // Subscribe to UserChannel trade events to update position size from actual fills
    this.subscribeToUserChannel()

    // Hydrate tracked positions from IndexedDB (crash recovery)
    this.hydrateFromStorage()

    // Periodic resolution sweep — check for resolved positions every 60s
    this.startResolutionSweep()

    console.log('[PositionLifecycleManager] Initialized — monitoring positions for stop-loss/take-profit')
  }

  /**
   * Restore positions from IndexedDB after a page refresh.
   * Validates each position's market — skips closed/resolved markets.
   */
  private hydrateFromStorage(): void {
    import('@/services/storage').then(async ({ indexedDBService }) => {
      const stored = await indexedDBService.loadPositions()
      if (stored.length === 0) return

      let hydrated = 0
      let skipped = 0

      for (const position of stored) {
        if (this.positions.has(position.marketSlug)) continue

        // Skip positions older than maxHoldMs (would have been auto-exited)
        const maxHold = position.maxHoldMs ?? 4 * 60 * 60 * 1000
        if (maxHold > 0 && Date.now() - position.entryTime > maxHold) {
          indexedDBService.removePosition(position.marketSlug).catch(() => {})
          skipped++
          continue
        }

        // Validate: check if the market is still active
        const isValid = await this.validateHydratedPosition(position)
        if (!isValid) {
          indexedDBService.removePosition(position.marketSlug).catch(() => {})
          activityLogger.logInfo(
            `Skipped resolved position: ${position.question.substring(0, 40)}...`,
            { marketSlug: position.marketSlug }
          )
          skipped++
          continue
        }

        // Check live position balance via API — if 0, position was already closed
        try {
          const { polymarketUSClient } = await import('@/services/api')
          const positions = await polymarketUSClient.getPositions(position.marketSlug)
          const matchingPos = positions.find(p =>
            p.marketSlug === position.marketSlug && p.outcome === position.outcome
          )
          if (!matchingPos || (matchingPos.netPosition ?? 0) <= 0) {
            console.log(`[PLM] Hydration: zero position for ${position.question.substring(0, 40)}... — skipping`)
            indexedDBService.removePosition(position.marketSlug).catch(() => {})
            // Close TradeLogger record if still open
            const openRecord = tradeLogger.findOpenRecord(position.marketSlug, position.strategy, position.outcome)
            if (openRecord) {
              tradeLogger.logExit(openRecord.id, {
                exitPrice: position.entryPrice,
                exitReason: 'redemption',
                pnlUSD: 0,
                pnlPercent: 0,
              })
            }
            skipped++
            continue
          }
        } catch {
          // API failure — continue with hydration (safe fallback)
        }

        this.positions.set(position.marketSlug, position)
        realtimeService.subscribeMarket(position.marketSlug)
        hydrated++
      }

      if (hydrated > 0 || skipped > 0) {
        this.notifyCallbacks()
        console.log(`[PLM] Hydrated ${hydrated} position(s) from storage (${skipped} resolved/closed skipped)`)
      }
    }).catch(err => {
      console.warn('[PLM] Failed to hydrate from storage:', err)
    })
  }

  /**
   * Check if a hydrated position's market is still active.
   * Returns true if the market is active (or if validation fails — err on safe side).
   */
  private async validateHydratedPosition(position: TrackedPosition): Promise<boolean> {
    try {
      const { polymarketUSClient } = await import('@/services/api')
      const market = await polymarketUSClient.getMarketBySlug(position.marketSlug)

      if (!market) {
        // Market not found — keep position (user can manually close)
        console.warn(`[PLM] Market not found for ${position.marketSlug}, keeping position`)
        return true
      }

      // Skip if market is closed or inactive — PM US auto-settles resolved markets
      if (market.closed || !market.active) {
        console.log(`[PLM] Market ${position.marketSlug} is ${market.closed ? 'closed' : 'inactive'} — cleaning up`)
        this.handleResolvedPosition(position, market.outcomePrices).catch(() => {})
        return false
      }

      return true
    } catch (err) {
      // Validation failed (API error, network) — keep position to be safe
      console.warn(`[PLM] Position validation failed for ${position.marketSlug}, keeping:`, err)
      return true
    }
  }

  /**
   * Subscribe to UserChannel trade events to correct position size from actual fills.
   * The POST /order response may not have exact filledSize, so strategies estimate
   * size as costBasis/price. The UserChannel event has the actual fill size.
   */
  private subscribeToUserChannel(): void {
    import('@/services/realtime/UserChannelService').then(({ userChannelService }) => {
      this.unsubscribeUserChannel = userChannelService.onTrade((msg) => {
        // Only care about confirmed BUY fills
        if (msg.side !== 'BUY' || msg.status !== 'CONFIRMED') return

        // US user channel uses market_slug (not asset_id)
        const slug = msg.market_slug ?? msg.asset_id
        if (!slug) return

        const position = this.positions.get(slug)
        if (!position) return

        const actualSize = parseFloat(msg.size)
        if (!actualSize || isNaN(actualSize) || actualSize <= 0) return

        // Only update if the size actually differs (avoids unnecessary writes)
        if (Math.abs(position.size - actualSize) < 0.001) return

        console.log(
          `[PLM] Fill correction: ${slug} size ${position.size.toFixed(4)} → ${actualSize.toFixed(4)} (from UserChannel)`
        )
        position.size = actualSize
        this.positions.set(slug, position)

        // Re-persist corrected position
        import('@/services/storage').then(({ indexedDBService }) => {
          indexedDBService.storePosition(position)
        }).catch(() => {})
      })
    }).catch(() => {
      // UserChannel not available yet — non-critical
    })
  }

  /**
   * Shut down — unsubscribe from price feeds
   */
  destroy(): void {
    if (this.unsubscribePrice) {
      this.unsubscribePrice()
      this.unsubscribePrice = null
    }
    if (this.unsubscribeUserChannel) {
      this.unsubscribeUserChannel()
      this.unsubscribeUserChannel = null
    }
    if (this.resolutionIntervalId) {
      clearInterval(this.resolutionIntervalId)
      this.resolutionIntervalId = null
    }
    this.initialized = false
  }

  /**
   * Track a new position after a successful buy
   * Called by strategies via dynamic import after placeBet() succeeds
   */
  trackPosition(position: TrackedPosition): void {
    this.positions.set(position.marketSlug, position)

    // Subscribe to real-time price updates for this market
    realtimeService.subscribeMarket(position.marketSlug)

    activityLogger.logInfo(
      `Tracking ${position.outcome.toUpperCase()} position — SL: ${(position.stopLossPercent * 100).toFixed(0)}%, TP: ${(position.takeProfitPercent * 100).toFixed(0)}%`,
      {
        marketSlug: position.marketSlug,
        entryPrice: position.entryPrice,
        costBasis: position.costBasis,
        strategy: position.strategy,
      }
    )

    // Persist to IndexedDB (fire-and-forget)
    import('@/services/storage').then(({ indexedDBService }) => {
      indexedDBService.storePosition(position)
    }).catch(() => {})

    this.notifyCallbacks()
    console.log(`[PLM] Now tracking ${this.positions.size} position(s)`)
  }

  /**
   * Remove a position from tracking (after confirmed sell)
   */
  removePosition(slug: string): void {
    const pos = this.positions.get(slug)
    if (!pos) return

    this.positions.delete(slug)
    this.sellInProgress.delete(slug)
    this.sellRetries.delete(slug)

    // Unsubscribe from price updates if no other positions use this market
    realtimeService.unsubscribeMarket(slug)

    // Remove from IndexedDB (fire-and-forget)
    import('@/services/storage').then(({ indexedDBService }) => {
      indexedDBService.removePosition(slug)
    }).catch(() => {})

    this.notifyCallbacks()

    console.log(`[PLM] Removed position ${slug}, now tracking ${this.positions.size}`)
  }

  /**
   * Force-close a single position (manual override from UI)
   */
  async forceClosePosition(slug: string): Promise<boolean> {
    const position = this.positions.get(slug)
    if (!position) return false

    // Reset sellFailed so manual retry is allowed
    position.sellFailed = false
    this.sellRetries.delete(slug)
    activityLogger.logWarning(`Manual close: ${position.question.substring(0, 40)}...`)
    return this.executeSell(position, 'manual')
  }

  /**
   * Force-close ALL tracked positions (emergency override)
   */
  async forceCloseAll(): Promise<{ closed: number; failed: number }> {
    const positions = Array.from(this.positions.values())
    let closed = 0
    let failed = 0

    activityLogger.logWarning(`Emergency close: closing all ${positions.length} positions`)

    for (const position of positions) {
      position.sellFailed = false
      this.sellRetries.delete(position.marketSlug)
      const success = await this.executeSell(position, 'emergency')
      if (success) closed++
      else failed++
    }

    return { closed, failed }
  }

  /**
   * Abandon a position without selling — removes from tracking and IndexedDB.
   * Use for zombie positions that can't be sold (resolved markets, empty books, etc.)
   */
  abandonPosition(slug: string): boolean {
    const pos = this.positions.get(slug)
    if (!pos) return false

    const pnlUsd = -pos.costBasis // Assume total loss
    activityLogger.logWarning(
      `ABANDONED: ${pos.question.substring(0, 40)}... (write-off $${pos.costBasis.toFixed(2)})`,
      { marketSlug: slug, strategy: pos.strategy, costBasis: pos.costBasis }
    )
    riskManager.recordTradeResult(false, pnlUsd)

    // Log abandonment to TradeLogger so it shows in dashboard stats
    const openRecord = tradeLogger.findOpenRecord(pos.marketSlug, pos.strategy, pos.outcome)
    if (openRecord) {
      tradeLogger.logExit(openRecord.id, {
        exitPrice: 0,
        exitReason: 'manual',
        pnlUSD: pnlUsd,
        pnlPercent: -1,
      })
    }

    this.removePosition(slug)
    return true
  }

  /**
   * Abandon ALL tracked positions without selling.
   */
  abandonAll(): number {
    const slugs = Array.from(this.positions.keys())
    let count = 0
    for (const slug of slugs) {
      if (this.abandonPosition(slug)) count++
    }
    return count
  }

  /**
   * Auto-clean stale positions that are blocking trading.
   * Abandons positions that have been open >24h AND have no live price data.
   * Also abandons positions from resolved markets (price ≥0.95 or ≤0.05).
   * Returns the number of positions cleaned.
   */
  cleanStalePositions(): number {
    const now = Date.now()
    const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 hours
    const slugs = Array.from(this.positions.keys())
    let cleaned = 0

    for (const slug of slugs) {
      const pos = this.positions.get(slug)
      if (!pos) continue

      const age = now - pos.entryTime
      const priceData = realtimeService.getPrice(slug)
      const hasLivePrice = priceData && (now - priceData.timestamp.getTime()) < 10 * 60 * 1000 // 10 min
      const isResolved = priceData && (priceData.mid >= 0.95 || priceData.mid <= 0.05)

      // Auto-abandon if: (a) very old with no live price, or (b) market resolved
      if ((age > STALE_THRESHOLD_MS && !hasLivePrice) || isResolved) {
        const reason = isResolved ? 'resolved market' : 'stale (>24h, no price)'
        console.log(`[PLM] Auto-cleaning ${reason}: ${pos.question.substring(0, 40)}...`)
        activityLogger.logWarning(
          `Auto-cleaned ${reason}: ${pos.question.substring(0, 40)}...`,
          { marketSlug: slug, strategy: pos.strategy, age: Math.round(age / 3600000) + 'h' }
        )
        this.abandonPosition(slug)
        cleaned++
      }
    }

    if (cleaned > 0) {
      console.log(`[PLM] Auto-cleaned ${cleaned} stale position(s), now tracking ${this.positions.size}`)
    }
    return cleaned
  }

  /**
   * Get all tracked positions with current P&L
   */
  getPositions(): PositionStatus[] {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000

    return Array.from(this.positions.values()).map(pos => {
      const priceData = realtimeService.getPrice(pos.marketSlug)
      const currentPrice = priceData?.mid ?? pos.entryPrice
      // Show GROSS unrealized P&L (matches Polymarket display).
      // Fees are only deducted at sell time — pre-subtracting them makes
      // dashboard numbers look wrong compared to Polymarket's portfolio page.
      const pnlPercent = (currentPrice - pos.entryPrice) / pos.entryPrice
      const pnlUsd = pos.size * (currentPrice - pos.entryPrice)

      return {
        ...pos,
        currentPrice,
        pnlPercent,
        pnlUsd,
        isStale: priceData ? priceData.timestamp.getTime() < fiveMinAgo : true,
      }
    })
  }

  /**
   * Get aggregate unrealized PnL across all open positions.
   * Uses last known prices — stale positions fall back to entry price (0 PnL).
   */
  getUnrealizedPnl(): { totalUsd: number; positionCount: number } {
    let totalUsd = 0
    for (const pos of this.positions.values()) {
      const priceData = realtimeService.getPrice(pos.marketSlug)
      const currentPrice = priceData?.mid ?? pos.entryPrice
      totalUsd += pos.size * (currentPrice - pos.entryPrice)
    }
    return { totalUsd, positionCount: this.positions.size }
  }

  /**
   * Get number of tracked positions
   */
  get count(): number {
    return this.positions.size
  }

  /**
   * Subscribe to position changes
   */
  onChange(callback: PositionChangeCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  // ==========================================
  // PRIVATE — Core price monitoring logic
  // ==========================================

  /**
   * Handle incoming price update — check all positions for threshold breach
   */
  private handlePriceUpdate(slug: string, priceData: PriceData): void {
    const position = this.positions.get(slug)
    if (!position) return

    // Skip if a sell is already in progress for this position
    if (this.sellInProgress.has(slug)) return

    // Skip if sell permanently failed — prevent endless TP/SL re-triggers
    if (position.sellFailed) return

    // Skip stale prices — don't trigger SL/TP on outdated data
    if (realtimeService.isStale(slug)) {
      return
    }

    const currentPrice = priceData.mid
    // Guard: ignore zero/near-zero prices from empty order books.
    if (currentPrice <= 0.001) return

    // Guard: detect market resolution prices (≥0.90 or ≤0.10).
    // When a binary market resolves, the winning outcome jumps toward ~1.00 and
    // the loser drops toward ~0.00. These extreme prices are NOT real trading
    // signals — triggering TP/SL here would fire spurious sell attempts.
    // Instead, skip TP/SL processing and let the resolution sweep handle it.
    if (currentPrice >= 0.90 || currentPrice <= 0.10) {
      if (!position._resolutionDetected) {
        console.log(
          `[PLM] Resolution-range price detected for ${position.outcome.toUpperCase()} ` +
          `(${(currentPrice * 100).toFixed(1)}¢) — deferring to resolution sweep`
        )
        position._resolutionDetected = true
        // Trigger an immediate resolution check instead of waiting 60s
        this.sweepResolvedPositions().catch(() => {})
      }
      return
    }

    // Clear resolution flag if price returns to normal range
    if (position._resolutionDetected) {
      position._resolutionDetected = false
    }

    const pnlPercent = (currentPrice - position.entryPrice) / position.entryPrice

    // Check TIME-BASED EXIT: max hold duration exceeded
    const maxHold = position.maxHoldMs ?? 4 * 60 * 60 * 1000 // default 4 hours
    if (maxHold > 0 && Date.now() - position.entryTime > maxHold) {
      const holdHours = ((Date.now() - position.entryTime) / 3_600_000).toFixed(1)
      const takerFeePercent = position.takerFeeBps != null ? position.takerFeeBps / 10000 : DEFAULT_TAKER_FEE_PERCENT
      const netPnlPercent = pnlPercent - takerFeePercent

      if (netPnlPercent > 0) {
        // Profitable after fees — take the win
        console.log(`[PLM] TIME EXIT triggered for ${position.outcome.toUpperCase()} (held ${holdHours}h, net +${(netPnlPercent * 100).toFixed(1)}%)`)
        activityLogger.logInfo(
          `TIME EXIT: ${position.question.substring(0, 40)}... (held ${holdHours}h, net PnL +${(netPnlPercent * 100).toFixed(1)}%)`,
          { marketSlug: slug, entryPrice: position.entryPrice, currentPrice, pnlPercent: netPnlPercent, holdHours }
        )
        this.executeSell(position, 'time-exit')
      } else if (!position._timeExtended) {
        // Losing after fees — extend hold once to give it a chance to recover.
        const extensionMs = Math.min(
          Math.round((position.maxHoldMs ?? maxHold) * 0.25),
          2 * 60 * 60 * 1000
        )
        position._timeExtended = true
        position.maxHoldMs = (position.maxHoldMs ?? maxHold) + extensionMs
        const extMins = (extensionMs / 60_000).toFixed(0)
        console.log(`[PLM] TIME EXIT DEFERRED for ${position.outcome.toUpperCase()} (net ${(netPnlPercent * 100).toFixed(1)}%, extending ${extMins}m)`)
        activityLogger.logInfo(
          `TIME EXIT DEFERRED: ${position.question.substring(0, 40)}... (net PnL ${(netPnlPercent * 100).toFixed(1)}%, extending ${extMins}m)`,
          { marketSlug: slug, entryPrice: position.entryPrice, currentPrice, pnlPercent: netPnlPercent, holdHours, extensionMinutes: extMins }
        )
        import('@/services/storage').then(({ indexedDBService }) => {
          indexedDBService.storePosition(position)
        }).catch(() => {})
      } else {
        // Already extended once — exit regardless
        console.log(`[PLM] TIME EXIT (extended) triggered for ${position.outcome.toUpperCase()} (held ${holdHours}h, net ${(netPnlPercent * 100).toFixed(1)}%)`)
        activityLogger.logInfo(
          `TIME EXIT (extended): ${position.question.substring(0, 40)}... (held ${holdHours}h, net PnL ${(netPnlPercent * 100).toFixed(1)}%)`,
          { marketSlug: slug, entryPrice: position.entryPrice, currentPrice, pnlPercent: netPnlPercent, holdHours }
        )
        this.executeSell(position, 'time-exit')
      }
      return
    }

    // Check PARTIAL CLOSE: scale out 50% at partialCloseAt threshold
    if (
      position.partialCloseAt &&
      !position.partialClosed &&
      pnlPercent >= position.partialCloseAt
    ) {
      const halfShares = Math.floor(position.size / 2)
      if (halfShares > 0) {
        console.log(`[PLM] PARTIAL CLOSE: selling ${halfShares} of ${position.size} shares at +${(pnlPercent * 100).toFixed(1)}%`)
        activityLogger.logInfo(
          `PARTIAL CLOSE: ${position.question.substring(0, 40)}... (50% at +${(pnlPercent * 100).toFixed(1)}%)`,
          { marketSlug: slug, halfShares, totalShares: position.size, pnlPercent }
        )
        position.partialClosed = true
        position.size -= halfShares
        // Persist updated position
        import('@/services/storage').then(({ indexedDBService }) => {
          indexedDBService.storePosition(position)
        }).catch(() => {})
        // Execute partial sell (fire-and-forget, don't block the main loop)
        tradingService.placeSell(slug, position.outcome, halfShares)
          .then(result => {
            if (result.success) {
              const partialPnl = (currentPrice - position.entryPrice) * halfShares
              riskManager.recordTradeResult(true, partialPnl)
            }
          })
          .catch(() => {})
        this.notifyCallbacks()
      }
    }

    // Check STOP-LOSS: price dropped below threshold
    if (pnlPercent <= -position.stopLossPercent) {
      console.log(
        `[PLM] STOP-LOSS triggered for ${position.outcome.toUpperCase()} ` +
        `(${(pnlPercent * 100).toFixed(1)}% <= -${(position.stopLossPercent * 100).toFixed(0)}%)`
      )
      activityLogger.logWarning(
        `STOP-LOSS: ${position.question.substring(0, 40)}... (${(pnlPercent * 100).toFixed(1)}%)`,
        { marketSlug: slug, entryPrice: position.entryPrice, currentPrice, pnlPercent }
      )
      this.executeSell(position, 'stop-loss')
      return
    }

    // Update peak price tracking (only when in profit)
    if (pnlPercent > 0) {
      const prevPeak = position.peakPrice ?? position.entryPrice
      if (currentPrice > prevPeak) {
        position.peakPrice = currentPrice
        import('@/services/storage').then(({ indexedDBService }) => {
          indexedDBService.storePosition(position)
        }).catch(() => {})
      }
    }

    // Check TRAILING STOP: price dropped from peak by trailingStopPercent
    if (position.trailingStopPercent && position.peakPrice) {
      const dropFromPeak = (position.peakPrice - currentPrice) / position.peakPrice
      if (dropFromPeak >= position.trailingStopPercent && pnlPercent > 0) {
        console.log(
          `[PLM] TRAILING STOP triggered for ${position.outcome.toUpperCase()} ` +
          `(dropped ${(dropFromPeak * 100).toFixed(1)}% from peak ${(position.peakPrice * 100).toFixed(1)}¢)`
        )
        activityLogger.logInfo(
          `TRAILING STOP: ${position.question.substring(0, 40)}... (${(dropFromPeak * 100).toFixed(1)}% from peak)`,
          { marketSlug: slug, entryPrice: position.entryPrice, peakPrice: position.peakPrice, currentPrice, pnlPercent }
        )
        this.executeSell(position, 'trailing-stop')
        return
      }
    }

    // Check TAKE-PROFIT: price rose above fee-adjusted threshold.
    const takerFeePercent = position.takerFeeBps != null ? position.takerFeeBps / 10000 : DEFAULT_TAKER_FEE_PERCENT
    const adjustedTP = position.takeProfitPercent + takerFeePercent
    if (pnlPercent >= adjustedTP) {
      const netPnl = pnlPercent - takerFeePercent
      console.log(
        `[PLM] TAKE-PROFIT triggered for ${position.outcome.toUpperCase()} ` +
        `(${(pnlPercent * 100).toFixed(1)}% >= +${(adjustedTP * 100).toFixed(0)}%, net ~${(netPnl * 100).toFixed(1)}%)`
      )
      activityLogger.logInfo(
        `TAKE-PROFIT: ${position.question.substring(0, 40)}... (+${(pnlPercent * 100).toFixed(1)}% gross, ~${(netPnl * 100).toFixed(1)}% net)`,
        { marketSlug: slug, entryPrice: position.entryPrice, currentPrice, pnlPercent, netPnl }
      )
      this.executeSell(position, 'take-profit')
    }
  }

  /**
   * Execute a sell order with retry logic
   */
  private async executeSell(
    position: TrackedPosition,
    reason: 'stop-loss' | 'take-profit' | 'trailing-stop' | 'time-exit' | 'manual' | 'emergency'
  ): Promise<boolean> {
    const { marketSlug, outcome, size } = position

    // Prevent re-triggering after permanent failure
    if (position.sellFailed) {
      return false
    }

    // Prevent double-sell
    if (this.sellInProgress.has(marketSlug)) {
      console.log(`[PLM] Sell already in progress for ${marketSlug}`)
      return false
    }

    this.sellInProgress.add(marketSlug)

    try {
      // Use GTC for exit sells — FOK fails on thin-liquidity markets because it
      // requires 100% fill at stated price. GTC rests on the book and fills
      // at-or-better.
      const result = await tradingService.placeSell(marketSlug, outcome, position.size, undefined, 'GTC')

      if (result.success) {
        const priceData = realtimeService.getPrice(marketSlug)
        const exitPrice = priceData?.mid ?? position.entryPrice
        const pnlUsd = (exitPrice - position.entryPrice) * size

        activityLogger.logSell(
          `SELL ${outcome.toUpperCase()} [${reason}] ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`,
          {
            marketSlug,
            reason,
            entryPrice: position.entryPrice,
            exitPrice,
            pnlUsd,
            costBasis: position.costBasis,
            orderId: result.orderId,
          }
        )

        // Feed PnL to RiskManager for daily/weekly loss tracking
        riskManager.recordTradeResult(true, pnlUsd)
        // Reduce per-market concentration tracking
        riskManager.reduceMarketExposure(marketSlug, position.costBasis)

        // Log exit to TradeLogger so profit/loss shows in dashboard stats
        const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice
        const openRecord = tradeLogger.findOpenRecord(marketSlug, position.strategy, outcome)
        if (openRecord) {
          tradeLogger.logExit(openRecord.id, {
            exitPrice,
            exitReason: reason,
            pnlUSD: pnlUsd,
            pnlPercent,
          })
        }

        this.removePosition(marketSlug)
        return true
      }

      // Sell failed — retry logic
      const retryCount = (this.sellRetries.get(marketSlug) ?? 0) + 1
      this.sellRetries.set(marketSlug, retryCount)

      if (retryCount < this.maxSellRetries) {
        const delayMs = retryCount * 2000
        console.warn(`[PLM] Sell failed (attempt ${retryCount}/${this.maxSellRetries}), retrying in ${delayMs / 1000}s...`)
        activityLogger.logWarning(`Sell retry ${retryCount}/${this.maxSellRetries}: ${result.error}`)

        // Schedule retry — keep sellInProgress lock held to prevent handlePriceUpdate
        // from triggering duplicate TP/SL sells during the retry window.
        setTimeout(() => {
          if (!this.positions.has(marketSlug)) {
            this.sellInProgress.delete(marketSlug)
            return
          }
          this.executeSellRetry(position, reason)
        }, delayMs)
        return false
      }

      // Exhausted retries
      console.error(`[PLM] Sell FAILED after ${this.maxSellRetries} attempts: ${result.error}`)
      activityLogger.logError(`Sell failed permanently for ${outcome.toUpperCase()}: ${result.error}`, {
        marketSlug, reason, attempts: this.maxSellRetries,
      })

      const errorMsg = (result.error ?? '').toLowerCase()
      if (errorMsg.includes('not enough balance') || errorMsg.includes('no position')) {
        // Position gone — market likely resolved. Remove immediately.
        console.log(`[PLM] No position held — removing stale position and triggering resolution sweep`)
        this.removePosition(marketSlug)
        this.sweepResolvedPositions().catch(() => {})
      } else {
        position.sellFailed = true
        this.sellInProgress.delete(marketSlug)
      }
      // Sell failures are structural (market resolved/illiquid) — don't trigger circuit breaker
      riskManager.recordTradeResult(false, 0, 'structural')
      this.notifyCallbacks()
      return false
    } catch (error) {
      console.error('[PLM] Sell execution error:', error)
      riskManager.recordTradeResult(false, 0, 'structural')
      this.sellInProgress.delete(marketSlug)
      return false
    }
  }

  /**
   * Retry sell for a position where sellInProgress is already held.
   */
  private async executeSellRetry(
    position: TrackedPosition,
    reason: 'stop-loss' | 'take-profit' | 'trailing-stop' | 'time-exit' | 'manual' | 'emergency'
  ): Promise<void> {
    const { marketSlug, outcome, size } = position

    try {
      const result = await tradingService.placeSell(marketSlug, outcome, size, undefined, 'GTC')

      if (result.success) {
        const priceData = realtimeService.getPrice(marketSlug)
        const exitPrice = priceData?.mid ?? position.entryPrice
        const pnlUsd = (exitPrice - position.entryPrice) * size

        activityLogger.logSell(
          `SELL ${outcome.toUpperCase()} [${reason}] ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`,
          { marketSlug, reason, entryPrice: position.entryPrice, exitPrice, pnlUsd, costBasis: position.costBasis, orderId: result.orderId }
        )
        riskManager.recordTradeResult(true, pnlUsd)
        riskManager.reduceMarketExposure(marketSlug, position.costBasis)

        const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice
        const openRecord = tradeLogger.findOpenRecord(marketSlug, position.strategy, outcome)
        if (openRecord) {
          tradeLogger.logExit(openRecord.id, { exitPrice, exitReason: reason, pnlUSD: pnlUsd, pnlPercent })
        }
        this.removePosition(marketSlug)
        return
      }

      // Still failing — escalate
      const retryCount = (this.sellRetries.get(marketSlug) ?? 0) + 1
      this.sellRetries.set(marketSlug, retryCount)

      if (retryCount < this.maxSellRetries) {
        const delayMs = retryCount * 2000
        console.warn(`[PLM] Sell failed (attempt ${retryCount}/${this.maxSellRetries}), retrying in ${delayMs / 1000}s...`)
        activityLogger.logWarning(`Sell retry ${retryCount}/${this.maxSellRetries}: ${result.error}`)
        setTimeout(() => {
          if (!this.positions.has(marketSlug)) {
            this.sellInProgress.delete(marketSlug)
            return
          }
          this.executeSellRetry(position, reason)
        }, delayMs)
        return
      }

      // Exhausted all retries
      console.error(`[PLM] Sell FAILED after ${this.maxSellRetries} attempts: ${result.error}`)
      activityLogger.logError(`Sell failed permanently for ${outcome.toUpperCase()}: ${result.error}`, {
        marketSlug, reason, attempts: this.maxSellRetries,
      })

      const errorMsg = (result.error ?? '').toLowerCase()
      if (errorMsg.includes('not enough balance') || errorMsg.includes('no position')) {
        console.log(`[PLM] No position held — removing stale position and triggering resolution sweep`)
        this.removePosition(marketSlug)
        this.sweepResolvedPositions().catch(() => {})
      } else {
        position.sellFailed = true
        this.sellInProgress.delete(marketSlug)
      }
      riskManager.recordTradeResult(false, 0, 'structural')
      this.notifyCallbacks()
    } catch (error) {
      console.error('[PLM] Sell retry execution error:', error)
      riskManager.recordTradeResult(false, 0, 'structural')
      this.sellInProgress.delete(marketSlug)
    }
  }

  // ==========================================
  // RESOLUTION SWEEP
  // ==========================================

  /**
   * Start periodic sweep for resolved positions.
   * Checks every 60s if any tracked position's market has resolved.
   * PM US handles settlement automatically — we just clean up tracking.
   */
  private startResolutionSweep(): void {
    if (this.resolutionIntervalId) return

    this.resolutionIntervalId = setInterval(() => {
      this.sweepResolvedPositions()
      this.sweepStalePositions()
    }, 60_000)
  }

  /**
   * Scan all tracked positions, check if their market has resolved,
   * and clean up tracking for any that have.
   * PM US auto-settles resolved markets — we just compute PnL and remove tracking.
   */
  private async sweepResolvedPositions(): Promise<void> {
    if (this.positions.size === 0) return

    const positions = Array.from(this.positions.values())

    for (const position of positions) {
      // Skip if sell already in progress
      if (this.sellInProgress.has(position.marketSlug)) continue

      try {
        const { polymarketUSClient } = await import('@/services/api')
        const market = await polymarketUSClient.getMarketBySlug(position.marketSlug)

        if (market && (market.closed || !market.active)) {
          console.log(`[PLM] Sweep: market ${position.marketSlug} resolved — cleaning up`)
          await this.handleResolvedPosition(position, market.outcomePrices)
        }
      } catch {
        // API error — skip this position, try again next sweep
      }

      // Small delay between API calls to avoid rate limiting
      await new Promise(r => setTimeout(r, 500))
    }
  }

  /**
   * Auto-abandon positions that have been stale for >30 minutes AND whose
   * market has resolved/closed.
   */
  private async sweepStalePositions(): Promise<void> {
    if (this.positions.size === 0) return

    const STALE_ABANDON_MS = 30 * 60 * 1000 // 30 minutes

    for (const position of Array.from(this.positions.values())) {
      if (this.sellInProgress.has(position.marketSlug)) continue

      const priceData = realtimeService.getPrice(position.marketSlug)
      const lastUpdate = priceData?.timestamp?.getTime() ?? 0
      const staleDuration = Date.now() - lastUpdate

      if (staleDuration < STALE_ABANDON_MS) continue

      try {
        const { polymarketUSClient } = await import('@/services/api')
        const market = await polymarketUSClient.getMarketBySlug(position.marketSlug)

        if (market && (market.closed || !market.active)) {
          console.log(`[PLM] Auto-abandoning stale resolved position: ${position.question?.substring(0, 40)}...`)
          const handled = await this.handleResolvedPosition(position, market.outcomePrices)
          if (!handled) {
            this.abandonPosition(position.marketSlug)
          }
        }
        // If market still active but stale, leave it — WS may reconnect
      } catch {
        // API error — skip, try next sweep
      }

      await new Promise(r => setTimeout(r, 500))
    }
  }

  /**
   * Handle a resolved position — compute PnL from outcome prices and clean up.
   *
   * PM US handles settlement automatically via centralized clearing.
   * This method just:
   * 1. Computes PnL from resolved outcome prices
   * 2. Records result with riskManager and tradeLogger
   * 3. Removes from tracking
   *
   * @param resolvedPrices - [yesPrice, noPrice] from market data (e.g. [1.0, 0.0] if Yes won)
   */
  private async handleResolvedPosition(
    position: TrackedPosition,
    resolvedPrices?: number[]
  ): Promise<boolean> {
    const { marketSlug, outcome, question, entryPrice, size, costBasis, strategy } = position

    // Prevent concurrent handling
    if (this.sellInProgress.has(marketSlug)) return false
    this.sellInProgress.add(marketSlug)

    try {
      // Determine PnL from resolved outcome prices
      let exitPrice = 0
      if (resolvedPrices && resolvedPrices.length === 2) {
        const outcomeIndex = outcome === 'yes' ? 0 : 1
        exitPrice = resolvedPrices[outcomeIndex]
      }

      const pnlUsd = (exitPrice * size) - costBasis
      const won = pnlUsd >= 0
      const pnlPercent = exitPrice > 0 ? (exitPrice - entryPrice) / entryPrice : -1

      activityLogger.logInfo(
        `RESOLVED: ${question.substring(0, 40)}... (${won ? '+' : ''}$${pnlUsd.toFixed(2)})`,
        {
          marketSlug, strategy, outcome,
          entryPrice, exitPrice, costBasis, size, pnlUsd,
        }
      )

      // Feed PnL to RiskManager
      riskManager.recordTradeResult(won, pnlUsd)
      riskManager.reduceMarketExposure(marketSlug, costBasis)

      // Log exit to TradeLogger
      const openRecord = tradeLogger.findOpenRecord(marketSlug, strategy, outcome)
      if (openRecord) {
        tradeLogger.logExit(openRecord.id, {
          exitPrice,
          exitReason: 'redemption',
          pnlUSD: pnlUsd,
          pnlPercent,
        })
      }

      this.removePosition(marketSlug)
      return true
    } catch (error) {
      console.error('[PLM] Resolution handling error:', error)
      return false
    } finally {
      this.sellInProgress.delete(marketSlug)
    }
  }

  private notifyCallbacks(): void {
    const positions = Array.from(this.positions.values())
    for (const callback of this.callbacks) {
      try {
        callback(positions)
      } catch (error) {
        console.error('[PLM] Callback error:', error)
      }
    }
  }
}

// Export singleton instance
export const positionLifecycleManager = new PositionLifecycleManager()
