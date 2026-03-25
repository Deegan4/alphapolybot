import type { Market, OrderRequest, OrderResult, Order, PendingGtcOrder } from '@/types'
import { polymarketClient } from '@/services/api'
import { realtimeService } from '@/services/realtime'
import { useSettingsStore } from '@/stores/settingsStore'
import { riskManager } from './RiskManager'
import { orderBookDepth } from './OrderBookDepth'
import { tradeLogger } from './TradeLogger'
import { rejectionTracker } from './RejectionTracker'
import { activityLogger } from './ActivityLogger'
import { orderRegistry } from './oms'

export interface TradingConfig {
  maxSlippage: number
  executionCooldown: number
  maxRetries: number
  fokOnly: boolean
  dryRun: boolean
  gtcFallbackEnabled: boolean  // When FOK is killed, resubmit as GTD limit order
  gtcExpiryMs: number          // GTD server-side expiry (default: 5 minutes)
}

const DEFAULT_CONFIG: TradingConfig = {
  maxSlippage: 0.02, // 2%
  executionCooldown: 500, // ms
  maxRetries: 3,
  fokOnly: true,
  dryRun: true, // SAFE DEFAULT: Always start in dry run mode
  gtcFallbackEnabled: true,  // ON by default — saves wasted analysis on illiquid markets
  gtcExpiryMs: 5 * 60 * 1000, // 5 minutes
}

/**
 * Trading Service
 * Handles order execution with FOK orders and risk management
 */
export class TradingService {
  private config: TradingConfig
  private lastOrderTime = 0
  private pendingOrders = new Map<string, Order>()
  private inFlightTrades = new Map<string, number>() // tradeId → USD amount

  constructor(config: Partial<TradingConfig> = {}) {
    // Read persisted dryRun from Zustand store (synchronous — safe in non-React code)
    const persistedDryRun = useSettingsStore.getState().dryRun
    this.config = { ...DEFAULT_CONFIG, dryRun: persistedDryRun, ...config }

    console.log(`[TradingService] Mode: ${this.config.dryRun ? 'DRY RUN 🟡' : 'LIVE 🟢'}`)

    // Register in-flight capital reservation with RiskManager
    riskManager.addCapitalReservationFn(() => this.getInFlightValue())
  }

  /**
   * Total USD value of trades currently awaiting API response
   */
  getInFlightValue(): number {
    let total = 0
    for (const amount of this.inFlightTrades.values()) {
      total += amount
    }
    return total
  }

  /**
   * Update trading configuration
   */
  setConfig(config: Partial<TradingConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Place a buy order for a market outcome
   * @param skipGtcFallback - If true, never use GTD fallback (e.g. DipArb)
   */
  async placeBet(
    market: Market,
    outcome: 'yes' | 'no',
    amount: number,
    options?: { skipGtcFallback?: boolean; stopLossPercent?: number; takeProfitPercent?: number; outcomeIndex?: number; strategy?: string; orderType?: 'FOK' | 'GTC' | 'GTD'; gtdExpiryMs?: number; postOnly?: boolean; limitPrice?: number; asset?: string }
  ): Promise<OrderResult> {
    // Reserve capital atomically BEFORE risk check to prevent concurrent overdraw
    const tradeReservationId = `${market.slug}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    this.inFlightTrades.set(tradeReservationId, amount)

    // Risk management gate — pass asset + strategy for correlation-aware exposure check
    const riskCheck = riskManager.validateTrade(amount, market.slug, undefined, options?.asset, options?.strategy)
    if (!riskCheck.allowed) {
      this.inFlightTrades.delete(tradeReservationId)
      console.warn(`[TradingService] BLOCKED by risk check: ${riskCheck.reason}`)
      rejectionTracker.record('risk', 'system', riskCheck.reason)
      activityLogger.logWarning(`Trade blocked by risk manager: ${riskCheck.reason}`)
      return { success: false, error: `Risk check failed: ${riskCheck.reason}` }
    }

    // Apply execution cooldown
    await this.waitForCooldown()

    // Determine outcome price from market data
    const outcomeIndex = options?.outcomeIndex ?? (outcome === 'yes' ? 0 : 1)
    const currentPrice = market.outcomePrices[outcomeIndex]

    if (!currentPrice) {
      this.inFlightTrades.delete(tradeReservationId)
      return { success: false, error: 'Invalid market data' }
    }

    // Order book depth check — cap order size to available liquidity
    try {
      const depthCheck = await orderBookDepth.checkBuyDepth(market.slug, amount, this.config.maxSlippage)
      if (!depthCheck.sufficient && depthCheck.maxFillableUSD > 0) {
        const capped = Math.min(amount, depthCheck.maxFillableUSD * 0.9) // 10% safety margin
        if (capped < 1.00) {
          return { success: false, error: `Insufficient liquidity: only $${depthCheck.maxFillableUSD.toFixed(2)} available within ${(this.config.maxSlippage * 100).toFixed(0)}% slippage` }
        }
        console.log(`[TradingService] Order capped by liquidity: $${amount.toFixed(2)} → $${capped.toFixed(2)}`)
        amount = capped
      }
    } catch {
      // Depth check is best-effort — proceed if it fails
    }

    // Apply slippage tolerance (or use explicit limit price for maker orders)
    const orderPrice = options?.limitPrice ?? currentPrice * (1 + this.config.maxSlippage)

    // Calculate shares from the effective price so the order's dollar value
    // equals the intended amount.  For maker orders with a limit price below
    // market, this allocates more shares so we don't undershoot the $1.00
    // Polymarket minimum.  For taker orders nothing changes (limitPrice is undefined).
    const shares = amount / (options?.limitPrice ?? currentPrice)

    // Determine order type: caller can override (e.g., DipArb uses GTD), otherwise use config default
    const resolvedOrderType = options?.orderType ?? (this.config.fokOnly ? 'FOK' : 'GTC')
    const gtdExpiration = resolvedOrderType === 'GTD'
      ? Math.floor((Date.now() + (options?.gtdExpiryMs ?? this.config.gtcExpiryMs)) / 1000)
      : undefined

    const orderRequest: OrderRequest = {
      marketSlug: market.slug,
      outcome,
      side: 'BUY',
      price: orderPrice,
      size: shares,
      type: resolvedOrderType,
      expiration: gtdExpiration,
      postOnly: options?.postOnly,
    }

    // GTD fallback metadata — passed through to executeOrder for use if FOK is killed
    const gtdMeta = !options?.skipGtcFallback ? {
      marketSlug: market.slug,
      outcome,
      question: market.question,
      costBasis: amount,
      stopLossPercent: options?.stopLossPercent ?? 0.15,
      takeProfitPercent: options?.takeProfitPercent ?? 0.30,
      strategy: options?.strategy ?? 'llm',
      asset: options?.asset,
    } : undefined

    return this.executeOrder(orderRequest, gtdMeta, tradeReservationId)
  }

  /**
   * Place a sell order
   */
  async placeSell(
    slug: string,
    outcome: 'yes' | 'no',
    shares: number,
    price?: number,
    orderType?: 'FOK' | 'GTC' | 'GTD'
  ): Promise<OrderResult> {
    // Apply execution cooldown
    await this.waitForCooldown()

    // Get current price if not provided — use best bid
    let sellPrice = price
    if (!sellPrice) {
      // Resolve token ID for WS price lookup (RealtimeService is token-ID-based)
      const tokenId = polymarketClient.tokens.get(slug, outcome)
      const priceData = tokenId ? realtimeService.getPrice(tokenId) : null
      if (priceData?.bid && priceData.bid > 0.01) {
        sellPrice = priceData.bid
      } else {
        const bestPrices = await polymarketClient.getBestPricesBySlug(slug)
        if (bestPrices?.bid && bestPrices.bid > 0.01) {
          sellPrice = bestPrices.bid
        } else if (this.config.dryRun) {
          // Dry run: simulate sell at mid-price so PLM can close the position
          sellPrice = 0.50
        } else {
          return { success: false, error: `Could not determine market price` }
        }
      }
    }

    // Clamp sell price to valid range (0.01, 0.99)
    sellPrice = Math.min(0.99, Math.max(0.01, Math.round(sellPrice * 100) / 100))

    // Cancel any existing orders for this slug first
    await polymarketClient.cancelAllOrdersBySlug(slug)

    const orderRequest: OrderRequest = {
      marketSlug: slug,
      outcome,
      side: 'SELL',
      price: sellPrice,
      size: shares,
      type: orderType ?? (this.config.fokOnly ? 'FOK' : 'GTC'),
    }

    return this.executeOrder(orderRequest)
  }

  /**
   * Close a position by selling at best bid minus slippage.
   * CLOB has no server-side close — we place a FOK sell order.
   */
  async closePosition(slug: string, outcome: 'yes' | 'no', shares: number, slippageBips = 200): Promise<OrderResult> {
    if (this.config.dryRun) {
      console.log(`[DRY RUN] Would close position: ${slug}`)
      return { success: true, orderId: `dry-run-close-${Date.now()}` }
    }

    try {
      return await polymarketClient.closePosition(slug, outcome, shares, slippageBips)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Close position failed' }
    }
  }

  /**
   * Check if dry run mode is enabled
   */
  isDryRun(): boolean {
    return this.config.dryRun
  }

  /**
   * Execute an order with retry logic
   * @param gtdMeta - If provided, enables GTD fallback when FOK is killed
   */
  private async executeOrder(
    request: OrderRequest,
    gtdMeta?: {
      marketSlug: string
      outcome: 'yes' | 'no'
      question: string
      costBasis: number
      stopLossPercent: number
      takeProfitPercent: number
      strategy?: string
      asset?: string
    },
    existingTradeId?: string,
  ): Promise<OrderResult> {
    // Pre-flight: CLOB requires $1 minimum for marketable orders.
    const orderDollarValue = request.price * request.size
    if (request.side === 'BUY' && orderDollarValue < 1.00) {
      if (existingTradeId) this.inFlightTrades.delete(existingTradeId)
      rejectionTracker.record('order_too_small', 'system', `$${orderDollarValue.toFixed(2)} < $1.00 minimum`)
      return {
        success: false,
        error: `Order too small: $${orderDollarValue.toFixed(2)} (Polymarket minimum is $1.00)`,
      }
    }

    // Use existing reservation from placeBet, or create one for direct executeOrder calls (sells)
    const tradeId = existingTradeId ?? `${request.marketSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    if (!existingTradeId && request.side === 'BUY') {
      this.inFlightTrades.set(tradeId, orderDollarValue)
    }

    // OMS: Create managed order for lifecycle tracking
    const omsOrder = orderRegistry.createOrder({
      strategyId: gtdMeta?.strategy ?? 'unknown',
      marketSlug: request.marketSlug,
      tokenId: '',
      outcome: request.outcome ?? 'yes',
      side: request.side,
      orderType: request.type ?? 'FOK',
      price: request.price,
      size: request.size,
      intent: request.side === 'BUY' ? 'open' : 'close',
      takerFeeBps: 0,
      stopLossPercent: gtdMeta?.stopLossPercent,
      takeProfitPercent: gtdMeta?.takeProfitPercent,
    })

    riskManager.recordTradeAttempt()

    // DRY RUN MODE: Simulate order without executing
    if (this.config.dryRun) {
      rejectionTracker.record('dry_run', 'system', `Simulated ${request.side} $${orderDollarValue.toFixed(2)}`)
      console.log('[DRY RUN] Would execute order:', {
        marketSlug: request.marketSlug,
        outcome: request.outcome,
        side: request.side,
        price: request.price,
        size: request.size,
        type: request.type,
      })

      // Simulate network delay
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300))

      this.inFlightTrades.delete(tradeId)
      riskManager.recordTradeResult(true)
      // Track per-market exposure for concentration limits (dry run too)
      if (request.side === 'BUY') {
        riskManager.recordMarketExposure(request.marketSlug, orderDollarValue)
        if (gtdMeta?.asset) {
          riskManager.recordAssetExposure(gtdMeta.asset, gtdMeta.strategy ?? 'unknown', orderDollarValue)
        }
      }

      const dryRunOrderId = `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // Log trade for backtest framework (dry run included for analysis)
      tradeLogger.logEntry({
        marketId: request.marketSlug,
        conditionId: request.marketSlug,
        question: '',
        outcomes: [],
        strategy: 'llm',
        side: request.side,
        outcome: request.outcome ?? '',
        marketPrice: request.price,
        kellyFraction: 0,
        kellyBetSize: orderDollarValue,
        actualBetSize: orderDollarValue,
        orderType: 'FOK',
        fillPrice: request.price,
        filledSize: request.size,
        slippage: 0,
        executionTimeMs: 300,
        success: true,
        orderId: dryRunOrderId,
      })

      return {
        success: true,
        orderId: dryRunOrderId,
        filledSize: request.size,
        avgPrice: request.price,
      }
    }

    // Pre-flight: check buying power before submitting
    if (request.side === 'BUY') {
      try {
        const balances = await polymarketClient.getBalances()
        const requiredAmount = request.price * request.size
        if (balances.buyingPower < requiredAmount) {
          const msg = `Insufficient buying power: $${balances.buyingPower.toFixed(2)} (need $${requiredAmount.toFixed(2)})`
          console.error(`[TradingService] ${msg}`)
          rejectionTracker.record('balance', 'system', msg)
          activityLogger.logWarning(`Trade blocked: insufficient buying power`)
          this.inFlightTrades.delete(tradeId)
          return { success: false, error: msg }
        }
      } catch (balErr) {
        // Fail-closed: if we can't verify balance, don't trade
        const msg = `Balance check failed: ${balErr instanceof Error ? balErr.message : 'unknown error'}`
        console.error(`[TradingService] ${msg}`)
        this.inFlightTrades.delete(tradeId)
        return { success: false, error: msg }
      }
    }

    let lastError: string | undefined
    let failureReason: 'transient' | 'structural' | undefined

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        // Adjust for tick size
        request.price = this.adjustForTickSize(request.price)

        // Place the order
        const result = await polymarketClient.placeOrder(request)

        if (result.success) {
          this.lastOrderTime = Date.now()
          this.inFlightTrades.delete(tradeId)
          riskManager.recordTradeResult(true)
          // Track per-market exposure for concentration limits
          if (request.side === 'BUY') {
            riskManager.recordMarketExposure(request.marketSlug, orderDollarValue)
            if (gtdMeta?.asset) {
              riskManager.recordAssetExposure(gtdMeta.asset, gtdMeta.strategy ?? 'unknown', orderDollarValue)
            }
          }

          // Query actual fill data if not in response
          if (result.orderId && !result.filledSize) {
            try {
              const orderDetails = await polymarketClient.getOrder(result.orderId)
              if (orderDetails) {
                result.filledSize = orderDetails.filledSize ?? result.filledSize
                result.avgPrice = orderDetails.price ?? result.avgPrice
              }
            } catch {
              // Best-effort
            }
          }

          // Log trade for backtest framework
          tradeLogger.logEntry({
            marketId: request.marketSlug,
            conditionId: request.marketSlug,
            question: '',
            outcomes: [],
            strategy: 'llm',
            side: request.side,
            outcome: request.outcome ?? '',
            marketPrice: request.price,
            kellyFraction: 0,
            kellyBetSize: orderDollarValue,
            actualBetSize: orderDollarValue,
            orderType: request.type === 'FOK' ? 'FOK' : request.type === 'GTD' ? 'GTD' : 'GTC',
            fillPrice: result.avgPrice,
            filledSize: result.filledSize,
            slippage: result.avgPrice && request.price ? Math.abs(result.avgPrice - request.price) / request.price : undefined,
            executionTimeMs: Date.now() - (this.lastOrderTime || Date.now()),
            success: true,
            orderId: result.orderId,
          })

          // OMS: Track submitted → filled lifecycle
          try {
            orderRegistry.markSubmitted(omsOrder.id, result.orderId ?? tradeId)
            orderRegistry.markAccepted(omsOrder.id)
            if (result.filledSize && result.filledSize > 0) {
              orderRegistry.markFilled(omsOrder.id, result.filledSize, result.avgPrice ?? request.price)
            }
          } catch { /* OMS tracking is best-effort */ }

          return result
        }

        lastError = result.error

        // "not enough balance" is NOT transient — don't waste retries
        if (lastError?.includes('not enough balance') || lastError?.includes('insufficient')) {
          console.error(`[TradingService] Balance error is not retryable — aborting immediately`)
          failureReason = 'structural'
          break
        }

        // Min size errors are structural
        if (lastError?.includes('min size') || lastError?.includes('lower than the minimum')) {
          console.error(`[TradingService] Order below minimum size — aborting immediately`)
          failureReason = 'structural'
          break
        }

        // FOK rejection — insufficient liquidity, don't retry
        if (lastError?.includes("couldn't be fully filled") || lastError?.includes('FOK')) {
          console.warn(`[TradingService] FOK order killed (no liquidity at this price/size) — not retrying`)
          failureReason = 'structural'
          break
        }

        // Post-only rejection — order would cross spread as taker, not retryable
        // Exchange returns "invalid post-only order: order crosses book" (hyphenated)
        if (lastError?.includes('post only') || lastError?.includes('post_only') || lastError?.includes('postOnly') || lastError?.includes('post-only') || lastError?.includes('crosses book')) {
          console.warn(`[TradingService] Post-only order rejected (would cross spread) — not retrying`)
          failureReason = 'structural'
          break
        }

        // Invalid amounts — rounding mismatch with exchange, not retryable
        if (lastError?.includes('invalid amounts')) {
          console.error(`[TradingService] Amount rounding mismatch — aborting immediately`)
          failureReason = 'structural'
          break
        }

        if (lastError?.includes('tick size') && attempt < this.config.maxRetries - 1) {
          request.price = this.adjustPriceForTick(request.price, request.side)
          continue
        }

        if (attempt < this.config.maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000))
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'
        console.error(`Order attempt ${attempt + 1} failed:`, error)

        if (lastError.includes('not enough balance') || lastError.includes('insufficient')) { failureReason = 'structural'; break }
        if (lastError.includes('min size') || lastError.includes('lower than the minimum')) { failureReason = 'structural'; break }
        if (lastError.includes("couldn't be fully filled") || lastError.includes('FOK')) {
          failureReason = 'structural'
          break
        }
        if (lastError.includes('post only') || lastError.includes('post_only') || lastError.includes('postOnly') || lastError.includes('post-only') || lastError.includes('crosses book')) {
          failureReason = 'structural'
          break
        }
        if (lastError.includes('invalid amounts')) { failureReason = 'structural'; break }

        if (attempt < this.config.maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        }
      }
    }

    // ── GTD Fallback ──────────────────────────────────────────────
    const isFokKill = lastError?.includes("couldn't be fully filled") ||
                      lastError?.includes('FOK')

    if (
      isFokKill &&
      this.config.gtcFallbackEnabled &&
      gtdMeta &&
      request.side === 'BUY'
    ) {
      try {
        const expirationSec = Math.floor((Date.now() + this.config.gtcExpiryMs) / 1000)
        const gtdRequest: OrderRequest = {
          ...request,
          type: 'GTD',
          expiration: expirationSec,
        }

        console.log(`[TradingService] FOK killed → submitting GTD fallback (expires in ${this.config.gtcExpiryMs / 60000}m)`)
        const gtdResult = await polymarketClient.placeOrder(gtdRequest)

        if (gtdResult.success && gtdResult.orderId) {
          this.lastOrderTime = Date.now()
          this.inFlightTrades.delete(tradeId)

          // Hand off to GtcOrderManager for fill tracking (dynamic import avoids circular dep)
          // If tracking fails, cancel the order to prevent orphaned capital on the exchange
          import('./GtcOrderManager').then(({ gtcOrderManager }) => {
            gtcOrderManager.trackOrder({
              orderId: gtdResult.orderId!,
              marketSlug: request.marketSlug,
              outcome: gtdMeta.outcome,
              question: gtdMeta.question,
              side: request.side,
              price: request.price,
              size: request.size,
              costBasis: gtdMeta.costBasis,
              strategy: gtdMeta.strategy as PendingGtcOrder['strategy'],
              stopLossPercent: gtdMeta.stopLossPercent,
              takeProfitPercent: gtdMeta.takeProfitPercent,
              placedAt: Date.now(),
              expiresAt: expirationSec,
              status: 'pending',
            })
          }).catch(err => {
            console.error('[TradingService] Failed to track GTD order — cancelling orphaned order:', err)
            polymarketClient.cancelOrder(gtdResult.orderId!).catch(() => {})
          })

          return {
            success: true,
            orderId: gtdResult.orderId,
            pending: true,
          }
        }

        console.warn(`[TradingService] GTD fallback also failed: ${gtdResult.error}`)
      } catch (error) {
        console.warn('[TradingService] GTD fallback error:', error)
      }
    }

    this.inFlightTrades.delete(tradeId)
    riskManager.recordTradeResult(false, 0, failureReason)

    // OMS: Mark order as rejected
    try {
      orderRegistry.markRejected(omsOrder.id, lastError || 'Order failed')
    } catch { /* OMS tracking is best-effort */ }

    return {
      success: false,
      error: lastError || `Order failed after ${this.config.maxRetries} attempts`,
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    return polymarketClient.cancelOrder(orderId)
  }

  /**
   * Cancel all orders (optionally filtered by tokenId)
   */
  async cancelAllOrders(tokenId?: string): Promise<boolean> {
    return polymarketClient.cancelAllOrders(tokenId)
  }

  /**
   * Get open orders (optionally filtered by tokenId)
   */
  async getOpenOrders(tokenId?: string): Promise<Order[]> {
    return polymarketClient.getOpenOrders(tokenId)
  }

  /**
   * Adjust price to tick size (cents)
   */
  private adjustForTickSize(price: number): number {
    return Math.round(price * 100) / 100
  }

  /**
   * Adjust price for tick requirements
   */
  private adjustPriceForTick(price: number, side: 'BUY' | 'SELL'): number {
    const adjustment = 0.01 // 1 cent
    return side === 'BUY' ? price + adjustment : price - adjustment
  }

  /**
   * Confirm order settlement via user channel push (primary) or API polling (fallback).
   * Returns true if the order is matched/filled, false if cancelled/expired/failed/timeout.
   */
  async confirmOrderSettlement(orderId: string, timeoutMs = 10000): Promise<boolean> {
    // Primary: Try push-based confirmation via UserChannelService
    try {
      const { userChannelService } = await import('@/services/realtime')
      if (userChannelService.isConnected()) {
        return await this.confirmViaUserChannel(orderId, timeoutMs)
      }
    } catch {
      // UserChannel not available — fall through to polling
    }

    // Fallback: Poll API order status
    return this.confirmViaPolling(orderId, timeoutMs)
  }

  /**
   * Listen for trade/order events from user channel WebSocket.
   */
  private async confirmViaUserChannel(orderId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      void (async () => {
      const { userChannelService } = await import('@/services/realtime')

      let resolved = false
      const cleanup = () => {
        resolved = true
        unsubTrade()
        unsubOrder()
      }

      const unsubTrade = userChannelService.onTrade((msg) => {
        if (resolved) return
        const matchesMaker = msg.maker_orders?.some(o => o.order_id === orderId)
        if (!matchesMaker) return

        if (msg.status === 'CONFIRMED') {
          console.log(`[TradingService] Order ${orderId} confirmed via user channel`)
          cleanup()
          resolve(true)
        } else if (msg.status === 'FAILED') {
          console.warn(`[TradingService] Order ${orderId} FAILED via user channel`)
          cleanup()
          resolve(false)
        }
      })

      const unsubOrder = userChannelService.onOrder((msg) => {
        if (resolved) return
        if (msg.order_id !== orderId) return

        if (msg.event_type === 'CANCELLATION') {
          console.warn(`[TradingService] Order ${orderId} cancelled via user channel`)
          cleanup()
          resolve(false)
        }
      })

      setTimeout(() => {
        if (resolved) return
        cleanup()
        console.log(`[TradingService] No user channel event for ${orderId} in ${timeoutMs}ms — falling back to polling`)
        void this.confirmViaPolling(orderId, 5000).then(resolve)
      }, timeoutMs)
      })()
    })
  }

  /**
   * Polling-based confirmation (fallback when user channel unavailable).
   */
  private async confirmViaPolling(orderId: string, timeoutMs: number): Promise<boolean> {
    const pollIntervalMs = 2000
    const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs)

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const order = await polymarketClient.getOrder(orderId)
        if (!order) return false

        if (order.status === 'filled') return true
        if (order.status === 'cancelled' || order.status === 'expired' || order.status === 'failed') return false

        await new Promise(r => setTimeout(r, pollIntervalMs))
      } catch {
        await new Promise(r => setTimeout(r, pollIntervalMs))
      }
    }

    console.warn(`[TradingService] Order ${orderId} not confirmed after ${timeoutMs}ms — may still settle`)
    return false
  }

  /**
   * Wait for execution cooldown
   */
  private async waitForCooldown(): Promise<void> {
    const elapsed = Date.now() - this.lastOrderTime
    const remaining = this.config.executionCooldown - elapsed

    if (remaining > 0) {
      await new Promise(r => setTimeout(r, remaining))
    }
  }
}

// Export singleton instance
export const tradingService = new TradingService()
