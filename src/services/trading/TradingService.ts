import type { Market, Order, OrderRequest, OrderResult, PendingGtcOrder } from '@/types'
import { polymarketUSClient, priceForOutcome, reportedPriceForOutcome, roundOrderQuantity, isTransientLatencyReject, makerEntryPrice } from '@/services/api'
import { realtimeService } from '@/services/realtime'
import { useSettingsStore } from '@/stores/settingsStore'
import { riskManager } from './RiskManager'
import { orderBookDepth } from './OrderBookDepth'
import { tradeLogger } from './TradeLogger'
import { rejectionTracker } from './RejectionTracker'
import { activityLogger } from './ActivityLogger'

export interface TradingConfig {
  maxSlippage: number
  executionCooldown: number
  maxRetries: number
  fokOnly: boolean
  dryRun: boolean
  gtcFallbackEnabled: boolean  // When FOK is killed, resubmit as GTD limit order
  gtcExpiryMs: number          // GTD server-side expiry (default: 5 minutes)
  /**
   * Maker-first entries: buys rest as post-only GTD orders one tick inside the
   * spread (no taker fee at tier 1, vs Θ·p·(1−p) as taker) and fall back to the
   * normal taker path if the post-only order is rejected or the book is one-sided.
   * Applies only where the GTD fallback could (gtdMeta present, no explicit orderType).
   */
  makerFirst: boolean
}

const DEFAULT_CONFIG: TradingConfig = {
  maxSlippage: 0.02, // 2%
  executionCooldown: 500, // ms
  maxRetries: 3,
  fokOnly: true,
  dryRun: true, // SAFE DEFAULT: Always start in dry run mode
  gtcFallbackEnabled: true,  // ON by default — saves wasted analysis on illiquid markets
  gtcExpiryMs: 5 * 60 * 1000, // 5 minutes
  makerFirst: false,           // opt-in (Settings → Trading → Order Execution)
}

/**
 * Trading Service
 * Handles order execution with FOK orders and risk management
 */
export class TradingService {
  private config: TradingConfig
  private lastOrderTime = 0
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
    options?: { skipGtcFallback?: boolean; stopLossPercent?: number; takeProfitPercent?: number; outcomeIndex?: number; strategy?: string; orderType?: 'FOK' | 'GTC' | 'GTD'; gtdExpiryMs?: number }
  ): Promise<OrderResult> {
    // Risk management gate (pass marketSlug for per-market concentration check)
    const riskCheck = riskManager.validateTrade(amount, market.slug)
    if (!riskCheck.allowed) {
      console.warn(`[TradingService] BLOCKED by risk check: ${riskCheck.reason}`)
      rejectionTracker.record('risk', 'system', riskCheck.reason ?? 'risk check failed')
      activityLogger.logWarning(`Trade blocked by risk manager: ${riskCheck.reason}`)
      return { success: false, error: `Risk check failed: ${riskCheck.reason}` }
    }

    // Apply execution cooldown
    await this.waitForCooldown()

    // Determine outcome price from market data
    const outcomeIndex = options?.outcomeIndex ?? (outcome === 'yes' ? 0 : 1)
    const currentPrice = market.outcomePrices[outcomeIndex]

    if (!currentPrice) {
      return { success: false, error: 'Invalid market data' }
    }

    // Order book depth check — cap order size to available liquidity
    try {
      const depthCheck = await orderBookDepth.checkBuyDepth(market.slug, amount, this.config.maxSlippage, outcome)
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

    // Calculate shares (amount / price), rounded down to the market's step:
    // whole contracts unless minimumTradeQty < 1, or the exchange rejects it
    const shares = roundOrderQuantity(amount / currentPrice, market.orderMinSize)
    if (shares <= 0) {
      return { success: false, error: `Order too small: $${amount.toFixed(2)} at ${currentPrice.toFixed(3)} is under one contract` }
    }

    // Apply slippage tolerance
    const maxPrice = currentPrice * (1 + this.config.maxSlippage)

    // Determine order type: caller can override (e.g., DipArb uses GTD), otherwise use config default
    const resolvedOrderType = options?.orderType ?? (this.config.fokOnly ? 'FOK' : 'GTC')
    // PM US `goodTillTime` is an ISO-8601 timestamp (not unix seconds)
    const gtdExpiration = resolvedOrderType === 'GTD'
      ? new Date(Date.now() + (options?.gtdExpiryMs ?? this.config.gtcExpiryMs)).toISOString()
      : undefined

    const orderRequest: OrderRequest = {
      marketSlug: market.slug,
      outcome,
      side: 'BUY',
      price: maxPrice,
      size: shares,
      type: resolvedOrderType,
      expiration: gtdExpiration,
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
    } : undefined

    // Maker-first: try a resting post-only order before crossing the spread
    if (this.config.makerFirst && gtdMeta && !options?.orderType) {
      const maker = await this.tryMakerEntry(market, outcome, amount, gtdMeta)
      if (maker) return maker
    }

    return this.executeOrder(orderRequest, gtdMeta)
  }

  /**
   * Place a post-only GTD buy one tick inside the spread and hand it to
   * GtcOrderManager. Returns null (caller falls back to taker) when the book
   * is not two-sided, the size rounds to zero, or the exchange rejects it.
   */
  private async tryMakerEntry(
    market: Market,
    outcome: 'yes' | 'no',
    amount: number,
    gtdMeta: NonNullable<Parameters<TradingService['executeOrder']>[1]>,
  ): Promise<OrderResult | null> {
    const live = realtimeService.getPrice(market.slug) ?? await polymarketUSClient.getBestPrices(market.slug)
    if (!live) return null
    const book = priceForOutcome(live, outcome)
    // Orders are sent on the 1¢ grid (adjustForTickSize), valid on every market
    const price = makerEntryPrice(book.bid, book.ask, 0.01)
    if (price === null) return null
    const size = roundOrderQuantity(amount / price, market.orderMinSize)
    if (size <= 0) return null

    const expiresAtMs = Date.now() + this.config.gtcExpiryMs
    const request: OrderRequest = {
      marketSlug: market.slug,
      outcome,
      side: 'BUY',
      price,
      size,
      type: 'GTD',
      expiration: new Date(expiresAtMs).toISOString(),
      postOnly: true,
    }
    const result = await this.executeOrder(request, undefined, { countFailure: false })
    if (!result.success) {
      console.log(`[TradingService] Maker entry not placed (${result.error}) — falling back to taker`)
      import('./MakerFillTracker').then(m => m.makerFillTracker.recordRejected()).catch(() => {})
      return null
    }
    if (result.orderId && !result.filledSize && !this.config.dryRun) {
      this.trackRestingOrder(result.orderId, request, gtdMeta, expiresAtMs, { entryKind: 'maker', feeCoefficient: market.feeCoefficient })
      return { ...result, pending: true }
    }
    return result
  }

  /** Hand a resting GTD buy to GtcOrderManager for fill / expiry tracking */
  private trackRestingOrder(
    orderId: string,
    request: OrderRequest,
    meta: NonNullable<Parameters<TradingService['executeOrder']>[1]>,
    expiresAtMs: number,
    extra: Pick<PendingGtcOrder, 'entryKind' | 'feeCoefficient'> = {},
  ): void {
    import('./GtcOrderManager').then(({ gtcOrderManager }) => {
      gtcOrderManager.trackOrder({
        orderId,
        marketSlug: request.marketSlug,
        outcome: meta.outcome,
        question: meta.question,
        side: request.side,
        price: request.price,
        size: request.size,
        costBasis: meta.costBasis,
        strategy: meta.strategy as PendingGtcOrder['strategy'],
        stopLossPercent: meta.stopLossPercent,
        takeProfitPercent: meta.takeProfitPercent,
        placedAt: Date.now(),
        expiresAt: expiresAtMs,
        status: 'pending',
        ...extra,
      })
    }).catch(err => console.warn('[TradingService] Failed to track resting order:', err))
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

    // Get current price if not provided — best bid in the outcome's terms
    // (the book is YES-quoted: the NO bid is 1 - YES ask)
    let sellPrice = price
    if (!sellPrice) {
      const live = realtimeService.getPrice(slug)
      const priceData = live ? priceForOutcome(live, outcome) : null
      if (priceData?.bid && priceData.bid > 0.01) {
        sellPrice = priceData.bid
      } else {
        const best = await polymarketUSClient.getBestPrices(slug)
        const bestPrices = best ? priceForOutcome(best, outcome) : null
        if (bestPrices?.bid && bestPrices.bid > 0.01) {
          sellPrice = bestPrices.bid
        } else {
          return { success: false, error: `Could not determine market price` }
        }
      }
    }

    // Clamp sell price to valid range (0.01, 0.99)
    sellPrice = Math.min(0.99, Math.max(0.01, Math.round(sellPrice * 100) / 100))

    // Cancel any existing orders for this slug first
    await polymarketUSClient.cancelAllOrders([slug])

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
   * Close an entire position via the US API's close-position endpoint.
   * This is the preferred way to exit positions on PM US — the exchange
   * handles order routing and fills automatically.
   */
  async closePosition(slug: string, slippageBips = 200): Promise<OrderResult> {
    if (this.config.dryRun) {
      console.log(`[DRY RUN] Would close position: ${slug}`)
      return { success: true, orderId: `dry-run-close-${Date.now()}` }
    }

    try {
      return await polymarketUSClient.closePosition(slug, slippageBips)
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
    },
    /** countFailure=false: a failed attempt that the caller will retry another way
     *  (maker-first → taker) must not count toward the circuit breaker */
    opts: { countFailure?: boolean } = {},
  ): Promise<OrderResult> {
    // Pre-flight: PM US requires $1 minimum for marketable orders.
    const orderDollarValue = request.price * request.size
    if (request.side === 'BUY' && orderDollarValue < 1.00) {
      rejectionTracker.record('order_too_small', 'system', `$${orderDollarValue.toFixed(2)} < $1.00 minimum`)
      return {
        success: false,
        error: `Order too small: $${orderDollarValue.toFixed(2)} (Polymarket minimum is $1.00)`,
      }
    }

    // Track in-flight trade value so concurrent trades don't overdraw balance
    const tradeId = `${request.marketSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    if (request.side === 'BUY') {
      this.inFlightTrades.set(tradeId, orderDollarValue)
    }

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
        const balances = await polymarketUSClient.getBalances()
        const requiredAmount = request.price * request.size
        if (balances.buyingPower < requiredAmount) {
          const msg = `Insufficient buying power: $${balances.buyingPower.toFixed(2)} (need $${requiredAmount.toFixed(2)})`
          console.error(`[TradingService] ${msg}`)
          rejectionTracker.record('balance', 'system', msg)
          activityLogger.logWarning(`Trade blocked: insufficient buying power`)
          this.inFlightTrades.delete(tradeId)
          return { success: false, error: msg }
        }
      } catch {
        // Balance check failed — proceed anyway (best-effort pre-flight)
      }
    }

    let lastError: string | undefined
    let failureReason: 'transient' | 'structural' | undefined

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        // Adjust for tick size
        request.price = this.adjustForTickSize(request.price)

        // Place the order. A latency stopgap reject ("Order Processing Max
        // Delay Exceeded") is transient and may be resubmitted once.
        let result = await polymarketUSClient.placeOrder(request)
        if (!result.success && isTransientLatencyReject(result.error)) {
          console.warn(`[TradingService] Exchange latency reject — resubmitting once: ${result.error}`)
          result = await polymarketUSClient.placeOrder(request)
        }

        if (result.success) {
          this.lastOrderTime = Date.now()
          this.inFlightTrades.delete(tradeId)
          riskManager.recordTradeResult(true)
          // Track per-market exposure for concentration limits
          if (request.side === 'BUY') {
            riskManager.recordMarketExposure(request.marketSlug, orderDollarValue)
          }

          // Query actual fill data if not in response
          if (result.orderId && !result.filledSize) {
            try {
              const orderDetails = await polymarketUSClient.getOrder(result.orderId)
              if (orderDetails) {
                result.filledSize = orderDetails.filledSize ?? result.filledSize
                result.avgPrice = orderDetails.price
                  ? reportedPriceForOutcome(orderDetails.price, request.outcome, request.price)
                  : result.avgPrice
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
        const expiresAtMs = Date.now() + this.config.gtcExpiryMs
        const gtdRequest: OrderRequest = {
          ...request,
          type: 'GTD',
          expiration: new Date(expiresAtMs).toISOString(),  // PM US goodTillTime is ISO-8601
        }

        console.log(`[TradingService] FOK killed → submitting GTD fallback (expires in ${this.config.gtcExpiryMs / 60000}m)`)
        const gtdResult = await polymarketUSClient.placeOrder(gtdRequest)

        if (gtdResult.success && gtdResult.orderId) {
          this.lastOrderTime = Date.now()
          this.inFlightTrades.delete(tradeId)

          // Hand off to GtcOrderManager for fill tracking (dynamic import avoids circular dep)
          this.trackRestingOrder(gtdResult.orderId, request, gtdMeta, expiresAtMs)

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
    if (opts.countFailure !== false) {
      riskManager.recordTradeResult(false, 0, failureReason)
    }

    return {
      success: false,
      error: lastError || `Order failed after ${this.config.maxRetries} attempts`,
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string, marketSlug: string): Promise<boolean> {
    return polymarketUSClient.cancelOrder(orderId, marketSlug)
  }

  /**
   * Cancel all orders for given slugs (or all orders if no slugs)
   */
  async cancelAllOrders(slugs?: string[]): Promise<string[]> {
    return polymarketUSClient.cancelAllOrders(slugs)
  }

  /**
   * Get open orders
   */
  async getOpenOrders(slugs?: string[]): Promise<Order[]> {
    return polymarketUSClient.getOpenOrders(slugs)
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

      // onTrade only fires for FILL / PARTIAL_FILL — either means the order matched
      const unsubTrade = userChannelService.onTrade((msg) => {
        if (resolved) return
        if (msg.orderId !== orderId) return

        console.log(`[TradingService] Order ${orderId} ${msg.type === 'EXECUTION_TYPE_FILL' ? 'filled' : 'partially filled'} via user channel`)
        cleanup()
        resolve(true)
      })

      const unsubOrder = userChannelService.onOrder((msg) => {
        if (resolved) return
        if (msg.orderId !== orderId) return

        if (
          msg.type === 'EXECUTION_TYPE_CANCELED' ||
          msg.type === 'EXECUTION_TYPE_REJECTED' ||
          msg.type === 'EXECUTION_TYPE_EXPIRED'
        ) {
          console.warn(`[TradingService] Order ${orderId} ${msg.type.replace('EXECUTION_TYPE_', '').toLowerCase()} via user channel`)
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
        const order = await polymarketUSClient.getOrder(orderId)
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
