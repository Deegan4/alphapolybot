import type { PriceData } from '@/types'
import { realtimeService } from '@/services/realtime'
import { useSettingsStore } from '@/stores'
import { tradingService } from './TradingService'
import { riskManager } from './RiskManager'
import { activityLogger } from './ActivityLogger'

// Polymarket taker fee (2%) — used to adjust take-profit threshold
// so the NET profit matches the user's configured percentage.
// SL doesn't need adjustment (a loss is a loss regardless of fee).
const TAKER_FEE_PERCENT = 0.02

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
  strategy: 'llm' | 'dip' | 'fw' | 'btc' | 'micro'
  negRisk?: boolean           // true if market uses NegRisk exchange
  // Trailing stop-loss fields
  trailingStopPercent?: number  // e.g. 0.10 = 10% trail from peak
  peakPrice?: number            // highest price seen while in profit
  // Time-based exit (max hold duration)
  maxHoldMs?: number            // max hold time in ms (0 = no limit). Default: 4 hours
  // Partial position closing (scale out winners)
  partialCloseAt?: number       // PnL% threshold to close half (e.g. 0.20 = 20%)
  partialClosed?: boolean       // whether partial close has already fired
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
  private callbacks = new Set<PositionChangeCallback>()
  private sellInProgress = new Set<string>()  // prevent double-sell
  private sellRetries = new Map<string, number>()
  private maxSellRetries = 3
  private initialized = false

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

    // Hydrate tracked positions from IndexedDB (crash recovery)
    this.hydrateFromStorage()

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

      // Skip if market is closed or inactive
      if (market.closed || !market.active) {
        console.log(`[PLM] Market ${position.marketId} is ${market.closed ? 'closed' : 'inactive'} — removing position`)
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
   * Shut down — unsubscribe from price feeds
   */
  destroy(): void {
    if (this.unsubscribePrice) {
      this.unsubscribePrice()
      this.unsubscribePrice = null
    }
    this.initialized = false
  }

  /**
   * Track a new position after a successful buy
   * Called by strategies via dynamic import after placeBet() succeeds
   */
  trackPosition(position: TrackedPosition): void {
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
      const pnlPercent = (currentPrice - pos.entryPrice) / pos.entryPrice
      const pnlUsd = (currentPrice - pos.entryPrice) * pos.size

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

    // Skip stale prices — don't trigger SL/TP on outdated data
    if (realtimeService.isStale(tokenId)) {
      return
    }

    const currentPrice = priceData.mid
    // Guard: ignore zero/near-zero prices from empty order books.
    // An empty book sends bid=0, ask=0 → mid=0, which looks like -100% PnL
    // but is just missing data, not a real price signal.
    if (currentPrice <= 0.001) return

    const pnlPercent = (currentPrice - position.entryPrice) / position.entryPrice

    // Check TIME-BASED EXIT: max hold duration exceeded
    const maxHold = position.maxHoldMs ?? 4 * 60 * 60 * 1000 // default 4 hours
    if (maxHold > 0 && Date.now() - position.entryTime > maxHold) {
      const holdHours = ((Date.now() - position.entryTime) / 3_600_000).toFixed(1)
      console.log(`[PLM] TIME EXIT triggered for ${position.outcome.toUpperCase()} (held ${holdHours}h)`)
      activityLogger.logInfo(
        `TIME EXIT: ${position.question.substring(0, 40)}... (held ${holdHours}h, PnL ${(pnlPercent * 100).toFixed(1)}%)`,
        { tokenId, entryPrice: position.entryPrice, currentPrice, pnlPercent, holdHours }
      )
      this.executeSell(position, 'time-exit')
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
    const adjustedTP = position.takeProfitPercent + TAKER_FEE_PERCENT
    if (pnlPercent >= adjustedTP) {
      const netPnl = pnlPercent - TAKER_FEE_PERCENT
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

    const { tokenId, entryPrice, size, stopLossPercent, takeProfitPercent, negRisk } = position

    // Stop-loss price: entry minus SL%
    const slPrice = Math.max(0.01, Math.round((entryPrice * (1 - stopLossPercent)) * 100) / 100)
    // Take-profit price: entry plus TP% plus taker fee (clamped to Polymarket's 0-1 range)
    const tpPrice = Math.min(0.99, Math.round((entryPrice * (1 + takeProfitPercent + TAKER_FEE_PERCENT)) * 100) / 100)

    // Validate prices are in valid Polymarket range (0, 1) exclusive
    const slValid = slPrice > 0 && slPrice < 1
    const tpValid = tpPrice > 0 && tpPrice < 1
    if (!slValid) {
      console.warn(`[PLM] Computed SL price ${slPrice} out of range for entry ${entryPrice} — skipping resting SL order`)
    }
    if (!tpValid) {
      console.warn(`[PLM] Computed TP price ${tpPrice} out of range for entry ${entryPrice} — skipping resting TP order`)
    }
    if (!slValid && !tpValid) return

    // Place both as fire-and-forget GTC limit sells
    import('@/services/api').then(async ({ clobClient }) => {
      if (slValid) {
        try {
          const slResult = await clobClient.placeOrder({
            tokenId,
            side: 'SELL',
            price: slPrice,
            size,
            type: 'GTC',
            negRisk,
          })
          if (slResult.success) {
            console.log(`[PLM] Resting SL sell at ${(slPrice * 100).toFixed(0)}¢ for ${tokenId.slice(0, 8)}…`)
          } else {
            console.warn(`[PLM] SL order rejected: ${slResult.error}`)
          }
        } catch {
          // Limit order failed — real-time monitoring is the fallback
        }
      }

      if (tpValid) {
        try {
          const tpResult = await clobClient.placeOrder({
            tokenId,
            side: 'SELL',
            price: tpPrice,
            size,
            type: 'GTC',
            negRisk,
          })
          if (tpResult.success) {
            console.log(`[PLM] Resting TP sell at ${(tpPrice * 100).toFixed(0)}¢ for ${tokenId.slice(0, 8)}…`)
          } else {
            console.warn(`[PLM] TP order rejected: ${tpResult.error}`)
          }
        } catch {
          // Limit order failed — real-time monitoring is the fallback
        }
      }
    }).catch(() => {})
  }

  /**
   * Execute a sell order with retry logic
   */
  private async executeSell(
    position: TrackedPosition,
    reason: 'stop-loss' | 'take-profit' | 'trailing-stop' | 'time-exit' | 'manual' | 'emergency'
  ): Promise<boolean> {
    const { tokenId, size } = position

    // Prevent double-sell
    if (this.sellInProgress.has(tokenId)) {
      console.log(`[PLM] Sell already in progress for ${tokenId}`)
      return false
    }

    this.sellInProgress.add(tokenId)

    try {
      const result = await tradingService.placeSell(tokenId, size, undefined, position.negRisk)

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

        this.removePosition(tokenId)
        return true
      }

      // Sell failed — retry logic
      const retryCount = (this.sellRetries.get(tokenId) ?? 0) + 1
      this.sellRetries.set(tokenId, retryCount)

      if (retryCount < this.maxSellRetries) {
        console.warn(`[PLM] Sell failed (attempt ${retryCount}/${this.maxSellRetries}), retrying in ${retryCount * 2}s...`)
        activityLogger.logWarning(`Sell retry ${retryCount}/${this.maxSellRetries}: ${result.error}`)

        // Schedule retry with backoff
        setTimeout(() => {
          this.sellInProgress.delete(tokenId)
          this.executeSell(position, reason)
        }, retryCount * 2000)
        return false
      }

      // Exhausted retries
      console.error(`[PLM] Sell FAILED after ${this.maxSellRetries} attempts: ${result.error}`)
      activityLogger.logError(`Sell failed permanently for ${position.outcome.toUpperCase()}: ${result.error}`, {
        tokenId,
        reason,
        attempts: this.maxSellRetries,
      })

      // Sell failures are structural (market resolved/illiquid) — don't trigger circuit breaker
      riskManager.recordTradeResult(false, 0, 'structural')
      this.sellInProgress.delete(tokenId)
      return false
    } catch (error) {
      console.error('[PLM] Sell execution error:', error)
      riskManager.recordTradeResult(false, 0, 'structural')
      this.sellInProgress.delete(tokenId)
      return false
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
