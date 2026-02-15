import type { PriceData } from '@/types'
import { realtimeService } from '@/services/realtime'
import { useSettingsStore } from '@/stores'
import { tradingService } from './TradingService'
import { riskManager } from './RiskManager'
import { activityLogger } from './ActivityLogger'
import { tradeLogger } from './TradeLogger'

// Default Polymarket taker fee (2%) — used to adjust take-profit threshold
// so the NET profit matches the user's configured percentage.
// SL doesn't need adjustment (a loss is a loss regardless of fee).
// NOTE: Fee-enabled markets (e.g. 15-min crypto) can have 10% (1000 bps).
// Per-position takerFeeBps overrides this default when available.
const DEFAULT_TAKER_FEE_PERCENT = 0.02

// ==========================================
// TYPES
// ==========================================

export interface TrackedPosition {
  tokenId: string
  marketId: string
  conditionId: string
  outcome: 'yes' | 'no'
  question: string            // market question for logging
  entryPrice: number          // price paid per share
  size: number                // shares held
  costBasis: number           // total USDC spent
  entryTime: number           // Date.now() at entry
  stopLossPercent: number     // e.g. 0.15 = 15%
  takeProfitPercent: number   // e.g. 0.30 = 30%
  strategy: 'llm' | 'dip' | 'fw' | 'btc' | 'micro' | 'meanrev' | 'copy'
  negRisk?: boolean           // true if market uses NegRisk exchange
  takerFeeBps?: number        // per-market taker fee in bps (e.g. 100 = 1%, 1000 = 10%). Falls back to DEFAULT_TAKER_FEE_PERCENT if absent.
  // Trailing stop-loss fields
  trailingStopPercent?: number  // e.g. 0.10 = 10% trail from peak
  peakPrice?: number            // highest price seen while in profit
  // Time-based exit (max hold duration)
  maxHoldMs?: number            // max hold time in ms (0 = no limit). Default: 4 hours
  // Partial position closing (scale out winners)
  partialCloseAt?: number       // PnL% threshold to close half (e.g. 0.20 = 20%)
  partialClosed?: boolean       // whether partial close has already fired
  // Time-exit deferral — losers get one 2h extension before forced exit
  _timeExtended?: boolean
  // Sell failure tracking — set after exhausting all retries to prevent infinite re-trigger loops
  sellFailed?: boolean
  // Resolution detection — set when price hits extreme values (≥0.95 or ≤0.05)
  // to prevent repeated logging while deferring to redemption sweep
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
  private redemptionIntervalId: ReturnType<typeof setInterval> | null = null

  // Generation counter per tokenId — incremented on trackPosition to abort
  // stale resting-exit retry loops when a position is overwritten.
  private positionGeneration = new Map<string, number>()

  // Resting exit order retry config — tokens may not be settled on Polygon
  // immediately after a FOK BUY (MATCHED but not yet CONFIRMED on-chain).
  private static readonly RESTING_ORDER_MAX_RETRIES = 5
  private static readonly RESTING_ORDER_BACKOFF_MS = [5_000, 10_000, 15_000, 20_000, 30_000]

  /**
   * Initialize — subscribe to real-time price feeds and hydrate from storage
   * Call once from App.tsx during startup
   */
  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    this.unsubscribePrice = realtimeService.onPriceUpdate(
      (tokenId, priceData) => this.handlePriceUpdate(tokenId, priceData)
    )

    // Subscribe to UserChannel trade events to update position size from actual fills
    this.subscribeToUserChannel()

    // Hydrate tracked positions from IndexedDB (crash recovery)
    this.hydrateFromStorage()

    // Periodic redemption sweep — check for resolved positions every 60s
    this.startRedemptionSweep()

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
        if (this.positions.has(position.tokenId)) continue

        // Skip positions older than maxHoldMs (would have been auto-exited)
        const maxHold = position.maxHoldMs ?? 4 * 60 * 60 * 1000
        if (maxHold > 0 && Date.now() - position.entryTime > maxHold) {
          indexedDBService.removePosition(position.tokenId).catch(() => {})
          skipped++
          continue
        }

        // Validate: check if the market is still active
        const isValid = await this.validateHydratedPosition(position)
        if (!isValid) {
          // Market is closed/resolved — remove stale entry from IndexedDB
          indexedDBService.removePosition(position.tokenId).catch(() => {})
          activityLogger.logInfo(
            `Skipped resolved position: ${position.question.substring(0, 40)}...`,
            { tokenId: position.tokenId, marketId: position.marketId }
          )
          skipped++
          continue
        }

        // Check on-chain token balance — if 0, position was already sold/redeemed.
        // This catches cases where Gamma still reports "active" but tokens are gone.
        try {
          const { walletService } = await import('@/services/wallet')
          if (walletService.isConnected()) {
            const balance = await walletService.getPositionBalance(position.tokenId)
            if (balance <= 0) {
              console.log(`[PLM] Hydration: zero on-chain balance for ${position.question.substring(0, 40)}... — skipping`)
              indexedDBService.removePosition(position.tokenId).catch(() => {})
              // Close TradeLogger record if still open
              const openRecord = tradeLogger.findOpenRecord(position.marketId, position.strategy, position.outcome)
              if (openRecord) {
                tradeLogger.logExit(openRecord.id, {
                  exitPrice: position.entryPrice, // Best-effort — no live price
                  exitReason: 'redemption',
                  pnlUSD: 0, // Unknown — tokens already gone
                  pnlPercent: 0,
                })
              }
              skipped++
              continue
            }
          }
        } catch {
          // Balance check failed — continue with hydration (safe fallback)
        }

        this.positions.set(position.tokenId, position)
        realtimeService.subscribeMarket(position.tokenId)
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
      const { gammaClient } = await import('@/services/api')
      const market = await gammaClient.getMarket(position.marketId)

      if (!market) {
        // Market not found — keep position (user can manually close)
        console.warn(`[PLM] Market not found for ${position.tokenId}, keeping position`)
        return true
      }

      // Skip if market is closed or inactive — attempt redemption first
      if (market.closed || !market.active) {
        console.log(`[PLM] Market ${position.marketId} is ${market.closed ? 'closed' : 'inactive'} — attempting redemption`)
        // Fire-and-forget — don't block other hydrations
        this.redeemResolvedPosition(position, market.outcomePrices).catch(() => {})
        return false
      }

      return true
    } catch (err) {
      // Validation failed (API error, network) — keep position to be safe
      console.warn(`[PLM] Position validation failed for ${position.tokenId}, keeping:`, err)
      return true
    }
  }

  /**
   * Subscribe to UserChannel BUY trade events to correct position size.
   * The CLOB POST /order response lacks filledSize, so strategies estimate
   * size as costBasis/price. The UserChannel CONFIRMED event has the actual
   * fill size, which we use to patch the tracked position and re-persist.
   */
  private subscribeToUserChannel(): void {
    import('@/services/realtime/UserChannelService').then(({ userChannelService }) => {
      this.unsubscribeUserChannel = userChannelService.onTrade((msg) => {
        // Only care about confirmed BUY fills
        if (msg.side !== 'BUY' || msg.status !== 'CONFIRMED') return

        const tokenId = msg.asset_id
        const position = this.positions.get(tokenId)
        if (!position) return

        const actualSize = parseFloat(msg.size)
        if (!actualSize || isNaN(actualSize) || actualSize <= 0) return

        // Only update if the size actually differs (avoids unnecessary writes)
        if (Math.abs(position.size - actualSize) < 0.001) return

        console.log(
          `[PLM] Fill correction: ${tokenId.slice(0, 8)}… size ${position.size.toFixed(4)} → ${actualSize.toFixed(4)} (from UserChannel)`
        )
        position.size = actualSize
        this.positions.set(tokenId, position)

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
    if (this.redemptionIntervalId) {
      clearInterval(this.redemptionIntervalId)
      this.redemptionIntervalId = null
    }
    this.initialized = false
  }

  /**
   * Track a new position after a successful buy
   * Called by strategies via dynamic import after placeBet() succeeds
   */
  trackPosition(position: TrackedPosition): void {
    // Increment generation to abort any in-flight resting-exit retry loops
    // for a previous position with the same tokenId
    const gen = (this.positionGeneration.get(position.tokenId) ?? 0) + 1
    this.positionGeneration.set(position.tokenId, gen)

    this.positions.set(position.tokenId, position)

    // Subscribe to real-time price updates for this token
    realtimeService.subscribeMarket(position.tokenId)

    activityLogger.logInfo(
      `Tracking ${position.outcome.toUpperCase()} position — SL: ${(position.stopLossPercent * 100).toFixed(0)}%, TP: ${(position.takeProfitPercent * 100).toFixed(0)}%`,
      {
        tokenId: position.tokenId,
        marketId: position.marketId,
        entryPrice: position.entryPrice,
        costBasis: position.costBasis,
        strategy: position.strategy,
      }
    )

    // Place resting limit sell orders at SL/TP prices (best-effort).
    // These sit on the order book and fill at-or-better without market sell slippage.
    // The real-time price-watching logic remains as a fallback if limits don't fill.
    this.placeRestingExitOrders(position)

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
  removePosition(tokenId: string): void {
    const pos = this.positions.get(tokenId)
    if (!pos) return

    this.positions.delete(tokenId)
    this.sellInProgress.delete(tokenId)
    this.sellRetries.delete(tokenId)
    // Bump generation to abort any in-flight resting-exit retry loops
    this.positionGeneration.set(tokenId, (this.positionGeneration.get(tokenId) ?? 0) + 1)

    // Unsubscribe from price updates if no other positions use this token
    realtimeService.unsubscribeMarket(tokenId)

    // Remove from IndexedDB (fire-and-forget)
    import('@/services/storage').then(({ indexedDBService }) => {
      indexedDBService.removePosition(tokenId)
    }).catch(() => {})

    this.notifyCallbacks()

    console.log(`[PLM] Removed position ${tokenId}, now tracking ${this.positions.size}`)
  }

  /**
   * Force-close a single position (manual override from UI)
   */
  async forceClosePosition(tokenId: string): Promise<boolean> {
    const position = this.positions.get(tokenId)
    if (!position) return false

    // Reset sellFailed so manual retry is allowed
    position.sellFailed = false
    this.sellRetries.delete(tokenId)
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
      // Reset sellFailed so emergency close can retry
      position.sellFailed = false
      this.sellRetries.delete(position.tokenId)
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
  abandonPosition(tokenId: string): boolean {
    const pos = this.positions.get(tokenId)
    if (!pos) return false

    const pnlUsd = -pos.costBasis // Assume total loss
    activityLogger.logWarning(
      `ABANDONED: ${pos.question.substring(0, 40)}... (write-off $${pos.costBasis.toFixed(2)})`,
      { tokenId, strategy: pos.strategy, costBasis: pos.costBasis }
    )
    riskManager.recordTradeResult(false, pnlUsd)

    // Log abandonment to TradeLogger so it shows in dashboard stats
    const openRecord = tradeLogger.findOpenRecord(pos.marketId, pos.strategy, pos.outcome)
    if (openRecord) {
      tradeLogger.logExit(openRecord.id, {
        exitPrice: 0,
        exitReason: 'manual',
        pnlUSD: pnlUsd,
        pnlPercent: -1,
      })
    }

    this.removePosition(tokenId)
    return true
  }

  /**
   * Abandon ALL tracked positions without selling.
   */
  abandonAll(): number {
    const tokenIds = Array.from(this.positions.keys())
    let count = 0
    for (const tokenId of tokenIds) {
      if (this.abandonPosition(tokenId)) count++
    }
    return count
  }

  /**
   * Get all tracked positions with current P&L
   */
  getPositions(): PositionStatus[] {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000

    return Array.from(this.positions.values()).map(pos => {
      const priceData = realtimeService.getPrice(pos.tokenId)
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
      const priceData = realtimeService.getPrice(pos.tokenId)
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
  private handlePriceUpdate(tokenId: string, priceData: PriceData): void {
    const position = this.positions.get(tokenId)
    if (!position) return

    // Skip if a sell is already in progress for this position
    if (this.sellInProgress.has(tokenId)) return

    // Skip if sell permanently failed — prevent endless TP/SL re-triggers
    if (position.sellFailed) return

    // Skip stale prices — don't trigger SL/TP on outdated data
    if (realtimeService.isStale(tokenId)) {
      return
    }

    const currentPrice = priceData.mid
    // Guard: ignore zero/near-zero prices from empty order books.
    // An empty book sends bid=0, ask=0 → mid=0, which looks like -100% PnL
    // but is just missing data, not a real price signal.
    if (currentPrice <= 0.001) return

    // Guard: detect market resolution prices (≥0.90 or ≤0.10).
    // When a binary market resolves, the winning outcome jumps toward ~1.00 and
    // the loser drops toward ~0.00. These extreme prices are NOT real trading
    // signals — they indicate the market has (or is about to) resolve.
    // Triggering TP/SL here would:
    //   1. Fire spurious sell attempts on a closed market (always fails)
    //   2. Pollute the activity log with fake TP/SL entries
    //   3. Waste gas/API calls on impossible trades
    // Since BTC Up/Down max entry is 0.45, prices ≥0.90 are already >100% gain
    // (deep TP territory). Any real exit would have fired well before 0.90.
    // Instead, skip TP/SL processing and let the 60s redemption sweep handle it.
    if (currentPrice >= 0.90 || currentPrice <= 0.10) {
      // Only log once to avoid spam — use a transient flag
      if (!position._resolutionDetected) {
        console.log(
          `[PLM] Resolution-range price detected for ${position.outcome.toUpperCase()} ` +
          `(${(currentPrice * 100).toFixed(1)}¢) — deferring to redemption sweep`
        )
        position._resolutionDetected = true
        // Trigger an immediate redemption check instead of waiting 60s
        this.sweepResolvedPositions().catch(() => {})
      }
      return
    }

    // Clear resolution flag if price returns to normal range (unlikely but defensive)
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
          { tokenId, entryPrice: position.entryPrice, currentPrice, pnlPercent: netPnlPercent, holdHours }
        )
        this.executeSell(position, 'time-exit')
      } else if (!position._timeExtended) {
        // Losing after fees — extend hold once to give it a chance to recover.
        // Extension is proportional to the original hold (25%, capped at 2h).
        // This prevents absurd 2h extensions on 5m/15m crypto markets.
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
          { tokenId, entryPrice: position.entryPrice, currentPrice, pnlPercent: netPnlPercent, holdHours, extensionMinutes: extMins }
        )
        import('@/services/storage').then(({ indexedDBService }) => {
          indexedDBService.storePosition(position)
        }).catch(() => {})
      } else {
        // Already extended once — exit regardless (SL should have caught deeper losses)
        console.log(`[PLM] TIME EXIT (extended) triggered for ${position.outcome.toUpperCase()} (held ${holdHours}h, net ${(netPnlPercent * 100).toFixed(1)}%)`)
        activityLogger.logInfo(
          `TIME EXIT (extended): ${position.question.substring(0, 40)}... (held ${holdHours}h, net PnL ${(netPnlPercent * 100).toFixed(1)}%)`,
          { tokenId, entryPrice: position.entryPrice, currentPrice, pnlPercent: netPnlPercent, holdHours }
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
          { tokenId, halfShares, totalShares: position.size, pnlPercent }
        )
        position.partialClosed = true
        position.size -= halfShares
        // Persist updated position
        import('@/services/storage').then(({ indexedDBService }) => {
          indexedDBService.storePosition(position)
        }).catch(() => {})
        // Execute partial sell (fire-and-forget, don't block the main loop)
        tradingService.placeSell(tokenId, halfShares, undefined, position.negRisk)
          .then(result => {
            if (result.success) {
              const partialPnl = (currentPrice - position.entryPrice) * halfShares
              riskManager.recordTradeResult(true, partialPnl)
              // Note: partial closes don't close the TradeLogger record —
              // the final full exit will log the cumulative PnL
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
        { tokenId, entryPrice: position.entryPrice, currentPrice, pnlPercent }
      )
      this.executeSell(position, 'stop-loss')
      return
    }

    // Update peak price tracking (only when in profit)
    if (pnlPercent > 0) {
      const prevPeak = position.peakPrice ?? position.entryPrice
      if (currentPrice > prevPeak) {
        position.peakPrice = currentPrice
        // Persist updated peak to IndexedDB (fire-and-forget)
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
          { tokenId, entryPrice: position.entryPrice, peakPrice: position.peakPrice, currentPrice, pnlPercent }
        )
        this.executeSell(position, 'trailing-stop')
        return
      }
    }

    // Check TAKE-PROFIT: price rose above fee-adjusted threshold.
    // Taker fee means the user nets less than the gross PnL, so we
    // trigger TP at (target + fee) so the NET profit matches their intent.
    // Example: user sets TP 30% → trigger at 32% → net ~30% after 2% fee.
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
        { tokenId, entryPrice: position.entryPrice, currentPrice, pnlPercent, netPnl }
      )
      this.executeSell(position, 'take-profit')
    }
  }

  /**
   * Place resting limit sell orders at SL/TP prices.
   * These are GTC orders that sit on the book and fill at-or-better,
   * avoiding market sell slippage. The real-time monitoring remains
   * as a fallback for gap-throughs.
   */
  private placeRestingExitOrders(position: TrackedPosition): void {
    // Skip resting orders in dry-run mode — no real positions to exit
    if (useSettingsStore.getState().dryRun) {
      console.log(`[PLM] Dry-run mode — skipping resting exit orders for ${position.tokenId.slice(0, 8)}…`)
      return
    }

    // Capture current generation so retries abort if position is overwritten/removed
    const generation = this.positionGeneration.get(position.tokenId) ?? 0

    // Fire-and-forget: attempt placement with retry on balance errors
    this.attemptRestingExitOrders(position, 0, generation).catch(() => {})
  }

  /**
   * Attempt to place a resting TP limit sell order with retry-on-balance-error.
   *
   * IMPORTANT: Only take-profit orders are placed as resting GTC SELLs.
   * Stop-loss orders are NOT placed as resting limits because a GTC SELL at
   * the SL price (e.g. 64c) means "sell at 64c or better" — if the current
   * market bid is above 64c (e.g. 75c), the order fills immediately at a loss.
   * Stop-losses are enforced exclusively by real-time price monitoring.
   *
   * After a FOK BUY succeeds, tokens are not immediately available — the trade
   * must be CONFIRMED on Polygon (typically 5-15s). The first attempt may fail
   * with "not enough balance" because the tokens haven't settled yet.
   *
   * Only retries on balance errors — other failures (invalid signature, auth,
   * tick size) are not retryable. Even if all retries fail, real-time price
   * monitoring remains as the safety-net fallback.
   */
  private async attemptRestingExitOrders(
    position: TrackedPosition,
    attempt: number,
    generation: number,
  ): Promise<void> {
    // Guard: position removed, or a newer trackPosition call superseded this one
    if (!this.positions.has(position.tokenId)) return
    if ((this.positionGeneration.get(position.tokenId) ?? 0) !== generation) {
      console.log(`[PLM] Resting exit retry aborted for ${position.tokenId.slice(0, 8)}… (position overwritten)`)
      return
    }

    // Re-read position from map — size may have been corrected by UserChannel fill data
    const current = this.positions.get(position.tokenId)!
    const { tokenId, entryPrice, size, takeProfitPercent, negRisk } = current
    const takerFeePercent = current.takerFeeBps != null ? current.takerFeeBps / 10000 : DEFAULT_TAKER_FEE_PERCENT

    // Take-profit price: entry plus TP% plus taker fee (clamped to Polymarket's 0-1 range)
    const tpPrice = Math.min(0.99, Math.round((entryPrice * (1 + takeProfitPercent + takerFeePercent)) * 100) / 100)

    const tpValid = tpPrice > 0 && tpPrice < 1
    if (!tpValid) return

    const { clobClient } = await import('@/services/api')

    let tpPlaced = false
    let hitBalanceError = false

    try {
      const tpResult = await clobClient.placeOrder({
        tokenId, side: 'SELL', price: tpPrice, size, type: 'GTC', negRisk,
      })
      if (tpResult.success) {
        console.log(`[PLM] Resting TP sell at ${(tpPrice * 100).toFixed(0)}¢ for ${tokenId.slice(0, 8)}…`)
        tpPlaced = true
      } else if (this.isBalanceError(tpResult.error)) {
        hitBalanceError = true
      } else {
        console.warn(`[PLM] TP order rejected (non-retryable): ${tpResult.error}`)
        tpPlaced = true  // Don't retry non-balance errors
      }
    } catch {
      tpPlaced = true  // Network/signing error — don't retry
    }

    if (tpPlaced) return

    // Balance error: tokens not yet confirmed on-chain. Schedule retry.
    if (hitBalanceError && attempt < PositionLifecycleManager.RESTING_ORDER_MAX_RETRIES) {
      const delay = PositionLifecycleManager.RESTING_ORDER_BACKOFF_MS[attempt] ?? 25_000
      const nextAttempt = attempt + 1
      console.log(
        `[PLM] Resting TP order: tokens not yet settled (attempt ${nextAttempt}/${PositionLifecycleManager.RESTING_ORDER_MAX_RETRIES + 1}), ` +
        `retrying in ${(delay / 1000).toFixed(0)}s…`
      )
      await new Promise(resolve => setTimeout(resolve, delay))
      return this.attemptRestingExitOrders(current, nextAttempt, generation)
    }

    // Exhausted retries — real-time monitoring is the fallback
    if (hitBalanceError) {
      console.warn(
        `[PLM] Resting TP order failed after ${attempt + 1} attempts (tokens may not have settled). ` +
        `Real-time price monitoring remains active as fallback.`
      )
    }
  }

  /**
   * Check if a CLOB API error indicates insufficient token balance.
   * This specific error is retryable after a FOK BUY because the tokens
   * are in-flight (MATCHED but not yet CONFIRMED on Polygon).
   */
  private isBalanceError(error?: string): boolean {
    if (!error) return false
    const lower = error.toLowerCase()
    return lower.includes('not enough balance') || lower.includes('insufficient balance')
  }

  /**
   * Execute a sell order with retry logic
   */
  private async executeSell(
    position: TrackedPosition,
    reason: 'stop-loss' | 'take-profit' | 'trailing-stop' | 'time-exit' | 'manual' | 'emergency'
  ): Promise<boolean> {
    const { tokenId, size } = position

    // Prevent re-triggering after permanent failure
    if (position.sellFailed) {
      return false
    }

    // Prevent double-sell
    if (this.sellInProgress.has(tokenId)) {
      console.log(`[PLM] Sell already in progress for ${tokenId}`)
      return false
    }

    this.sellInProgress.add(tokenId)

    try {
      // Use GTC for exit sells — FOK fails on thin-liquidity markets because it
      // requires 100% fill at stated price. GTC rests on the book and fills
      // at-or-better, matching how resting TP orders already work.
      const result = await tradingService.placeSell(tokenId, size, undefined, position.negRisk, 'GTC')

      if (result.success) {
        const priceData = realtimeService.getPrice(tokenId)
        const exitPrice = priceData?.mid ?? position.entryPrice
        const pnlUsd = (exitPrice - position.entryPrice) * size

        activityLogger.logSell(
          `SELL ${position.outcome.toUpperCase()} [${reason}] ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`,
          {
            tokenId,
            marketId: position.marketId,
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
        riskManager.reduceMarketExposure(position.conditionId, position.costBasis)

        // Log exit to TradeLogger so profit/loss shows in dashboard stats
        const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice
        const openRecord = tradeLogger.findOpenRecord(position.marketId, position.strategy, position.outcome)
        if (openRecord) {
          tradeLogger.logExit(openRecord.id, {
            exitPrice,
            exitReason: reason,
            pnlUSD: pnlUsd,
            pnlPercent,
          })
        }

        this.removePosition(tokenId)
        return true
      }

      // Sell failed — retry logic
      const retryCount = (this.sellRetries.get(tokenId) ?? 0) + 1
      this.sellRetries.set(tokenId, retryCount)

      if (retryCount < this.maxSellRetries) {
        const delayMs = retryCount * 2000
        console.warn(`[PLM] Sell failed (attempt ${retryCount}/${this.maxSellRetries}), retrying in ${delayMs / 1000}s...`)
        activityLogger.logWarning(`Sell retry ${retryCount}/${this.maxSellRetries}: ${result.error}`)

        // Schedule retry with backoff.
        // IMPORTANT: Keep sellInProgress lock held to prevent handlePriceUpdate
        // from triggering duplicate TP/SL sells during the retry window.
        // The lock is only released inside executeSell on success/final failure.
        setTimeout(() => {
          // Guard: position may have been removed while waiting
          if (!this.positions.has(tokenId)) {
            this.sellInProgress.delete(tokenId)
            return
          }
          // Re-enter sell logic directly (sellInProgress still held — bypass guard)
          this.executeSellRetry(position, reason)
        }, delayMs)
        return false
      }

      // Exhausted retries — check if "not enough balance" means tokens are gone
      console.error(`[PLM] Sell FAILED after ${this.maxSellRetries} attempts: ${result.error}`)
      activityLogger.logError(`Sell failed permanently for ${position.outcome.toUpperCase()}: ${result.error}`, {
        tokenId,
        reason,
        attempts: this.maxSellRetries,
      })

      const errorMsg = (result.error ?? '').toLowerCase()
      if (errorMsg.includes('not enough balance') || errorMsg.includes('allowance')) {
        // Tokens are gone — market likely resolved and tokens were redeemed,
        // or position was sold externally. Remove position IMMEDIATELY to prevent
        // infinite re-trigger on every price update, then attempt redemption sweep.
        console.log(`[PLM] No tokens held — removing stale position and triggering redemption sweep`)
        this.removePosition(tokenId)
        // Sweep in background to close TradeLogger records and compute final PnL
        this.sweepResolvedPositions().catch(() => {})
      } else {
        position.sellFailed = true
        this.sellInProgress.delete(tokenId)
      }
      // Sell failures are structural (market resolved/illiquid) — don't trigger circuit breaker
      riskManager.recordTradeResult(false, 0, 'structural')
      this.notifyCallbacks()
      return false
    } catch (error) {
      console.error('[PLM] Sell execution error:', error)
      riskManager.recordTradeResult(false, 0, 'structural')
      this.sellInProgress.delete(tokenId)
      return false
    }
  }

  /**
   * Retry sell for a position where sellInProgress is already held.
   * Called from the retry timer — skips the lock acquisition in executeSell.
   */
  private async executeSellRetry(
    position: TrackedPosition,
    reason: 'stop-loss' | 'take-profit' | 'trailing-stop' | 'time-exit' | 'manual' | 'emergency'
  ): Promise<void> {
    const { tokenId, size } = position

    try {
      const result = await tradingService.placeSell(tokenId, size, undefined, position.negRisk, 'GTC')

      if (result.success) {
        const priceData = realtimeService.getPrice(tokenId)
        const exitPrice = priceData?.mid ?? position.entryPrice
        const pnlUsd = (exitPrice - position.entryPrice) * size

        activityLogger.logSell(
          `SELL ${position.outcome.toUpperCase()} [${reason}] ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`,
          { tokenId, marketId: position.marketId, reason, entryPrice: position.entryPrice, exitPrice, pnlUsd, costBasis: position.costBasis, orderId: result.orderId }
        )
        riskManager.recordTradeResult(true, pnlUsd)
        riskManager.reduceMarketExposure(position.conditionId, position.costBasis)

        const pnlPercent = (exitPrice - position.entryPrice) / position.entryPrice
        const openRecord = tradeLogger.findOpenRecord(position.marketId, position.strategy, position.outcome)
        if (openRecord) {
          tradeLogger.logExit(openRecord.id, { exitPrice, exitReason: reason, pnlUSD: pnlUsd, pnlPercent })
        }
        this.removePosition(tokenId)
        return
      }

      // Still failing — escalate to the exhausted-retries path in executeSell
      const retryCount = (this.sellRetries.get(tokenId) ?? 0) + 1
      this.sellRetries.set(tokenId, retryCount)

      if (retryCount < this.maxSellRetries) {
        const delayMs = retryCount * 2000
        console.warn(`[PLM] Sell failed (attempt ${retryCount}/${this.maxSellRetries}), retrying in ${delayMs / 1000}s...`)
        activityLogger.logWarning(`Sell retry ${retryCount}/${this.maxSellRetries}: ${result.error}`)
        setTimeout(() => {
          if (!this.positions.has(tokenId)) {
            this.sellInProgress.delete(tokenId)
            return
          }
          this.executeSellRetry(position, reason)
        }, delayMs)
        return
      }

      // Exhausted all retries
      console.error(`[PLM] Sell FAILED after ${this.maxSellRetries} attempts: ${result.error}`)
      activityLogger.logError(`Sell failed permanently for ${position.outcome.toUpperCase()}: ${result.error}`, {
        tokenId, reason, attempts: this.maxSellRetries,
      })

      const errorMsg = (result.error ?? '').toLowerCase()
      if (errorMsg.includes('not enough balance') || errorMsg.includes('allowance')) {
        console.log(`[PLM] No tokens held — removing stale position and triggering redemption sweep`)
        this.removePosition(tokenId)
        this.sweepResolvedPositions().catch(() => {})
      } else {
        position.sellFailed = true
        this.sellInProgress.delete(tokenId)
      }
      riskManager.recordTradeResult(false, 0, 'structural')
      this.notifyCallbacks()
    } catch (error) {
      console.error('[PLM] Sell retry execution error:', error)
      riskManager.recordTradeResult(false, 0, 'structural')
      this.sellInProgress.delete(tokenId)
    }
  }

  // ==========================================
  // AUTO-REDEMPTION
  // ==========================================

  /**
   * Start periodic sweep for resolved positions.
   * Checks every 60s if any tracked position's market has resolved,
   * and attempts on-chain redemption if so.
   */
  private startRedemptionSweep(): void {
    if (this.redemptionIntervalId) return

    this.redemptionIntervalId = setInterval(() => {
      this.sweepResolvedPositions()
      this.sweepStalePositions()
    }, 60_000)
  }

  /**
   * Scan all tracked positions, check if their market has resolved,
   * and attempt redemption for any that have.
   */
  private async sweepResolvedPositions(): Promise<void> {
    if (this.positions.size === 0) return

    const positions = Array.from(this.positions.values())

    for (const position of positions) {
      // Skip if sell/redeem already in progress
      if (this.sellInProgress.has(position.tokenId)) continue

      try {
        const { gammaClient } = await import('@/services/api')
        const market = await gammaClient.getMarket(position.marketId)

        if (market && (market.closed || !market.active)) {
          console.log(`[PLM] Sweep: market ${position.marketId} resolved — redeeming`)
          await this.redeemResolvedPosition(position, market.outcomePrices)
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
   * market has resolved/closed. Both conditions must be met — a stale price
   * feed alone isn't enough (could be a WebSocket reconnection gap).
   */
  private async sweepStalePositions(): Promise<void> {
    if (this.positions.size === 0) return

    const STALE_ABANDON_MS = 30 * 60 * 1000 // 30 minutes

    for (const position of Array.from(this.positions.values())) {
      if (this.sellInProgress.has(position.tokenId)) continue

      const priceData = realtimeService.getPrice(position.tokenId)
      const lastUpdate = priceData?.timestamp?.getTime() ?? 0
      const staleDuration = Date.now() - lastUpdate

      if (staleDuration < STALE_ABANDON_MS) continue

      try {
        const { gammaClient } = await import('@/services/api')
        const market = await gammaClient.getMarket(position.marketId)

        if (market && (market.closed || !market.active)) {
          console.log(`[PLM] Auto-abandoning stale resolved position: ${position.question?.substring(0, 40)}...`)
          const redeemed = await this.redeemResolvedPosition(position, market.outcomePrices)
          if (!redeemed) {
            this.abandonPosition(position.tokenId)
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
   * Redeem a resolved position's CTF tokens for USDC.e on-chain.
   *
   * Flow:
   * 1. Check on-chain token balance (skip if zero — already redeemed)
   * 2. Call walletService.redeemPositions(conditionId)
   * 3. Compute PnL from resolved outcome prices
   * 4. Record result with riskManager and tradeLogger
   * 5. Remove from tracking
   *
   * @param resolvedPrices - [yesPrice, noPrice] from Gamma (e.g. [1.0, 0.0] if Yes won)
   */
  private async redeemResolvedPosition(
    position: TrackedPosition,
    resolvedPrices?: number[]
  ): Promise<boolean> {
    const { tokenId, conditionId, outcome, question, entryPrice, size, costBasis, strategy } = position

    // Prevent concurrent redemption attempts (reuses existing sellInProgress guard)
    if (this.sellInProgress.has(tokenId)) return false
    this.sellInProgress.add(tokenId)

    try {
      const { walletService } = await import('@/services/wallet')

      // Check on-chain token balance before attempting redemption
      const balance = await walletService.getPositionBalance(tokenId)
      if (balance <= 0) {
        // No tokens to redeem — already redeemed or sold elsewhere.
        // Still need to close the TradeLogger record so W/L tracking works.
        let exitPrice = 0
        if (resolvedPrices && resolvedPrices.length === 2) {
          const outcomeIndex = outcome === 'yes' ? 0 : 1
          exitPrice = resolvedPrices[outcomeIndex]
        }
        const pnlUsd = (exitPrice * size) - costBasis
        const won = pnlUsd >= 0
        const pnlPercent = exitPrice > 0 ? (exitPrice - entryPrice) / entryPrice : -1

        activityLogger.logInfo(
          `Position already redeemed: ${question.substring(0, 40)}... (${won ? '+' : ''}$${pnlUsd.toFixed(2)})`,
          { tokenId, conditionId, exitPrice, pnlUsd }
        )

        // Close trade record so it counts in W/L stats
        const openRecord = tradeLogger.findOpenRecord(position.marketId, strategy, outcome)
        if (openRecord) {
          tradeLogger.logExit(openRecord.id, {
            exitPrice,
            exitReason: 'redemption',
            pnlUSD: pnlUsd,
            pnlPercent,
          })
        }
        // Feed PnL to RiskManager even for externally-redeemed positions
        riskManager.recordTradeResult(won, pnlUsd)
        riskManager.reduceMarketExposure(conditionId, costBasis)

        this.removePosition(tokenId)
        return true
      }

      // Attempt on-chain redemption
      const result = await walletService.redeemPositions(conditionId)

      if (result.success) {
        // Determine PnL from resolved outcome prices
        // resolvedPrices[0] = Yes outcome, resolvedPrices[1] = No outcome
        // A value of 1.0 means that outcome won, 0.0 means it lost
        let exitPrice = 0
        if (resolvedPrices && resolvedPrices.length === 2) {
          const outcomeIndex = outcome === 'yes' ? 0 : 1
          exitPrice = resolvedPrices[outcomeIndex]
        }

        const pnlUsd = (exitPrice * size) - costBasis
        const won = pnlUsd >= 0
        const pnlPercent = exitPrice > 0 ? (exitPrice - entryPrice) / entryPrice : -1

        activityLogger.logInfo(
          `REDEEMED: ${question.substring(0, 40)}... (${won ? '+' : ''}$${pnlUsd.toFixed(2)})`,
          {
            tokenId, conditionId, strategy, outcome,
            entryPrice, exitPrice, costBasis, size,
            pnlUsd, txHash: result.txHash,
          }
        )

        // Feed PnL to RiskManager
        riskManager.recordTradeResult(won, pnlUsd)
        riskManager.reduceMarketExposure(conditionId, costBasis)

        // Log exit to TradeLogger
        const openRecord = tradeLogger.findOpenRecord(position.marketId, strategy, outcome)
        if (openRecord) {
          tradeLogger.logExit(openRecord.id, {
            exitPrice,
            exitReason: 'redemption',
            pnlUSD: pnlUsd,
            pnlPercent,
          })
        }

        this.removePosition(tokenId)
        return true
      }

      // Redemption failed — leave position for next sweep
      console.warn(`[PLM] Redemption failed for ${tokenId}: ${result.error}`)
      activityLogger.logWarning(
        `Redemption failed: ${question.substring(0, 40)}...`,
        { tokenId, conditionId, error: result.error }
      )
      return false
    } catch (error) {
      console.error('[PLM] Redemption error:', error)
      return false
    } finally {
      this.sellInProgress.delete(tokenId)
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
