import type { Market, OrderRequest, OrderResult, Order, PendingGtcOrder } from '@/types'
import { clobClient } from '@/services/api'
import { realtimeService } from '@/services/realtime'
import { walletService } from '@/services/wallet'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'
import { riskManager } from './RiskManager'
import { orderBookDepth } from './OrderBookDepth'
import { gasOracle } from './GasOracle'
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
    // This ensures TradingService respects the user's saved preference at boot,
    // before React's useEffect can sync it.
    const persistedDryRun = useSettingsStore.getState().dryRun
    this.config = { ...DEFAULT_CONFIG, dryRun: persistedDryRun, ...config }

    console.log(`[TradingService] Mode: ${this.config.dryRun ? 'DRY RUN 🟡' : 'LIVE 🟢'}`)

    // Register in-flight capital reservation with RiskManager
    // so concurrent trades don't double-spend the same balance
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
    options?: { skipGtcFallback?: boolean; stopLossPercent?: number; takeProfitPercent?: number; outcomeIndex?: number; strategy?: string }
  ): Promise<OrderResult> {
    // Ensure approvals (skip actual transactions in dry run mode)
    const approvalResult = await walletService.ensureApprovals(this.config.dryRun)
    if (!approvalResult.success) {
      const reason = approvalResult.error ?? 'Failed to ensure token approvals'
      console.warn(`[TradingService] BLOCKED by approvals: ${reason}`)
      rejectionTracker.record('approval', 'system', reason)
      activityLogger.logWarning(`Trade blocked: ${reason}`)
      return { success: false, error: reason }
    }

    // Risk management gate (pass conditionId for per-market concentration check)
    const riskCheck = riskManager.validateTrade(amount, market.conditionId)
    if (!riskCheck.allowed) {
      console.warn(`[TradingService] BLOCKED by risk check: ${riskCheck.reason}`)
      rejectionTracker.record('risk', 'system', riskCheck.reason)
      activityLogger.logWarning(`Trade blocked by risk manager: ${riskCheck.reason}`)
      return { success: false, error: `Risk check failed: ${riskCheck.reason}` }
    }

    // Apply execution cooldown
    await this.waitForCooldown()

    // Determine which token to buy
    // For multi-outcome markets, explicit outcomeIndex overrides the yes/no mapping
    const outcomeIndex = options?.outcomeIndex ?? (outcome === 'yes' ? 0 : 1)
    const tokenId = market.clobTokenIds[outcomeIndex]
    const currentPrice = market.outcomePrices[outcomeIndex]

    if (!tokenId || !currentPrice) {
      return { success: false, error: 'Invalid market data' }
    }

    // Order book depth check — cap order size to available liquidity
    try {
      const depthCheck = await orderBookDepth.checkBuyDepth(tokenId, amount, this.config.maxSlippage)
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

    // Calculate shares (amount / price)
    const shares = amount / currentPrice

    // Apply slippage tolerance
    const maxPrice = currentPrice * (1 + this.config.maxSlippage)

    const orderRequest: OrderRequest = {
      tokenId,
      side: 'BUY',
      price: maxPrice,
      size: shares,
      type: this.config.fokOnly ? 'FOK' : 'GTC',
      conditionId: market.conditionId,
      negRisk: market.negRisk,
    }

    // GTD fallback metadata — passed through to executeOrder for use if FOK is killed
    const gtdMeta = !options?.skipGtcFallback ? {
      marketId: market.id,
      outcome,
      question: market.question,
      costBasis: amount,
      stopLossPercent: options?.stopLossPercent ?? 0.15,
      takeProfitPercent: options?.takeProfitPercent ?? 0.30,
      strategy: options?.strategy ?? 'llm',
    } : undefined

    return this.executeOrder(orderRequest, gtdMeta)
  }

  /**
   * Place a sell order
   */
  async placeSell(
    tokenId: string,
    shares: number,
    price?: number,
    negRisk?: boolean,
    orderType?: 'FOK' | 'GTC' | 'GTD'
  ): Promise<OrderResult> {
    // Ensure CTF approval for selling (skip actual transactions in dry run mode)
    const approvalResult = await walletService.ensureApprovals(this.config.dryRun)
    if (!approvalResult.success) {
      return { success: false, error: approvalResult.error ?? 'Failed to ensure token approvals' }
    }

    // Apply execution cooldown
    await this.waitForCooldown()

    // Get current price if not provided — use best bid (not mid minus slippage)
    let sellPrice = price
    if (!sellPrice) {
      // Priority: realtime bid > CLOB bid > CLOB mid (no slippage discount)
      const priceData = realtimeService.getPrice(tokenId)
      if (priceData?.bid && priceData.bid > 0.01) {
        sellPrice = priceData.bid
      } else {
        const bestPrices = await clobClient.getBestPrices(tokenId)
        if (bestPrices?.bid && bestPrices.bid > 0.01) {
          sellPrice = bestPrices.bid
        } else {
          const midPrice = await clobClient.getMidPrice(tokenId)
          if (!midPrice || midPrice < 0.01) {
            return { success: false, error: `Could not determine market price` }
          }
          sellPrice = midPrice
        }
      }
    }

    // Clamp sell price to Polymarket valid range (0.01, 0.99)
    // Mid prices at/near 1.0 (resolved markets) or 0 produce invalid orders
    sellPrice = Math.min(0.99, Math.max(0.01, Math.round(sellPrice * 100) / 100))

    // Cancel any existing orders for this token first
    await clobClient.cancelAllOrders(tokenId)

    const orderRequest: OrderRequest = {
      tokenId,
      side: 'SELL',
      price: sellPrice,
      size: shares,
      type: orderType ?? (this.config.fokOnly ? 'FOK' : 'GTC'),
      negRisk,
    }

    return this.executeOrder(orderRequest)
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
      marketId: string
      outcome: 'yes' | 'no'
      question: string
      costBasis: number
      stopLossPercent: number
      takeProfitPercent: number
    },
  ): Promise<OrderResult> {
    // Pre-flight: Polymarket CLOB requires $1 minimum for marketable orders.
    // Catch this before signing and submitting to avoid wasted API calls.
    const orderDollarValue = request.price * request.size
    if (request.side === 'BUY' && orderDollarValue < 1.00) {
      rejectionTracker.record('order_too_small', 'system', `$${orderDollarValue.toFixed(2)} < $1.00 minimum`)
      return {
        success: false,
        error: `Order too small: $${orderDollarValue.toFixed(2)} (Polymarket minimum is $1.00)`,
      }
    }

    // Track in-flight trade value so concurrent trades don't overdraw balance
    const tradeId = `${request.tokenId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    if (request.side === 'BUY') {
      this.inFlightTrades.set(tradeId, orderDollarValue)
    }

    riskManager.recordTradeAttempt()

    // DRY RUN MODE: Simulate order without executing
    if (this.config.dryRun) {
      rejectionTracker.record('dry_run', 'system', `Simulated ${request.side} $${orderDollarValue.toFixed(2)}`)
      console.log('[DRY RUN] Would execute order:', {
        tokenId: request.tokenId,
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
      if (request.side === 'BUY' && request.conditionId) {
        riskManager.recordMarketExposure(request.conditionId, orderDollarValue)
      }

      const dryRunOrderId = `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // Log trade for backtest framework (dry run included for analysis)
      tradeLogger.logEntry({
        marketId: request.conditionId ?? '',
        conditionId: request.conditionId ?? '',
        question: '',
        outcomes: [],
        strategy: 'llm',
        side: request.side,
        outcome: '',
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

      // Return simulated success
      return {
        success: true,
        orderId: dryRunOrderId,
        txHash: `0x${'0'.repeat(64)}`,
        filledSize: request.size,
        avgPrice: request.price,
      }
    }

    // Pre-flight: check CLOB-side balance before wasting API calls & retries.
    // The exchange pulls USDC.e (bridged) via transferFrom — if the CLOB sees
    // zero balance, no retry or size reduction will help.
    //
    // IMPORTANT: Pre-flight failures are structural (wallet config / approval issue),
    // NOT trade execution failures. Do NOT record them via riskManager.recordTradeResult()
    // or the circuit breaker will fire after 5 markets despite no actual trade attempts.
    if (request.side === 'BUY') {
      let clobBal = await clobClient.getBalanceAllowance()
      // If cached balance is zero, refresh from on-chain before giving up.
      // The CLOB caches balance — after deriving new creds or depositing,
      // the cache may be stale until updateBalanceAllowance is called.
      if (clobBal && clobBal.balance === 0) {
        console.log('[TradingService] CLOB cached balance is $0 — refreshing from on-chain...')
        const refreshed = await clobClient.updateBalanceAllowance()
        if (refreshed) clobBal = refreshed
      }
      if (clobBal) {
        const requiredAmount = request.price * request.size
        if (clobBal.balance < requiredAmount) {
          // CLOB says insufficient — check on-chain balance as fallback.
          // The CLOB balance-allowance API is a cache that may return $0 if the
          // server lacks a signer→proxy mapping. Since Polymarket uses transferFrom
          // directly, the trade can succeed if on-chain funds + approvals are present.
          const onChainBalance = useWalletStore.getState().usdcBridgedBalance
          if (onChainBalance >= requiredAmount) {
            console.warn(
              `[TradingService] CLOB reports $${clobBal.balance.toFixed(2)} but on-chain shows ` +
              `$${onChainBalance.toFixed(2)} USDC.e — proceeding with trade (exchange uses transferFrom directly)`
            )
            // Fall through — don't block the trade
          } else {
            const msg = `Insufficient balance: CLOB sees $${clobBal.balance.toFixed(2)}, ` +
              `on-chain $${onChainBalance.toFixed(2)} USDC.e (need $${requiredAmount.toFixed(2)}). ` +
              `Your funds may be in native USDC — Polymarket requires bridged USDC.e (0x2791…Aa84174)`
            console.error(`[TradingService] ${msg}`)
            rejectionTracker.record('balance', 'system', msg)
            activityLogger.logWarning(`Trade blocked: insufficient balance`)
            this.inFlightTrades.delete(tradeId)
            return { success: false, error: msg }
          }
        }
        // Only block on allowance if the API actually returned the field.
        // Some signature types / API versions omit `allowance` entirely —
        // in that case we let the order through and rely on the exchange
        // to reject it if allowance is actually insufficient.
        if (clobBal.allowance != null && clobBal.allowance < requiredAmount) {
          const msg = `Insufficient CLOB allowance: $${clobBal.allowance.toFixed(2)} ` +
            `(need $${requiredAmount.toFixed(2)}). Re-approve USDC.e for the exchange contract.`
          console.error(`[TradingService] ${msg}`)
          this.inFlightTrades.delete(tradeId)
          return { success: false, error: msg }
        }
      }
    }

    let lastError: string | undefined
    let failureReason: 'transient' | 'structural' | undefined

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        // Adjust for tick size
        request.price = this.adjustForTickSize(request.price)

        // Place the order
        const result = await clobClient.placeOrder(request)

        if (result.success) {
          this.lastOrderTime = Date.now()
          this.inFlightTrades.delete(tradeId)
          riskManager.recordTradeResult(true)
          // Track per-market exposure for concentration limits
          if (request.side === 'BUY' && request.conditionId) {
            riskManager.recordMarketExposure(request.conditionId, orderDollarValue)
          }

          // Query actual fill data from CLOB (the POST /order response lacks filledSize/avgPrice)
          if (result.orderId && !result.filledSize) {
            try {
              const orderDetails = await clobClient.getOrder(result.orderId)
              if (orderDetails) {
                result.filledSize = orderDetails.filledSize ?? result.filledSize
                result.avgPrice = orderDetails.price ?? result.avgPrice
              }
            } catch {
              // Best-effort — strategies fall back to estimated size if this fails
            }
          }

          // Log trade for backtest framework
          tradeLogger.logEntry({
            marketId: request.conditionId ?? '',
            conditionId: request.conditionId ?? '',
            question: '',
            outcomes: [],
            strategy: 'llm',
            side: request.side,
            outcome: '',
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

        // "not enough balance" is NOT transient — don't waste retries.
        // The exchange contract's transferFrom will always fail if the wallet
        // doesn't hold USDC.e.
        if (lastError?.includes('not enough balance')) {
          console.error(`[TradingService] Balance error is not retryable — aborting immediately`)
          failureReason = 'structural'
          break
        }

        // "min size" / "lower than the minimum" errors are structural —
        // order share count is below CLOB minimum (5 shares).
        if (lastError?.includes('min size') || lastError?.includes('lower than the minimum')) {
          console.error(`[TradingService] Order below minimum size (5 shares) — aborting immediately`)
          failureReason = 'structural'
          break
        }

        // FOK (Fill-or-Kill) rejection means insufficient liquidity at this
        // price/size. The order book won't change in 1 second — retrying the
        // exact same order is wasteful. Break immediately.
        if (lastError?.includes("couldn't be fully filled") || lastError?.includes('FOK')) {
          console.warn(`[TradingService] FOK order killed (no liquidity at this price/size) — not retrying`)
          failureReason = 'structural'
          break
        }

        if (lastError?.includes('tick size') && attempt < this.config.maxRetries - 1) {
          // Adjust price
          request.price = this.adjustPriceForTick(request.price, request.side)
          continue
        }

        // If order just failed (not due to specific errors), wait and retry
        if (attempt < this.config.maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000))
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'
        console.error(`Order attempt ${attempt + 1} failed:`, error)

        // Don't retry balance errors surfaced as exceptions either
        if (lastError.includes('not enough balance')) { failureReason = 'structural'; break }

        // Don't retry min size errors surfaced as exceptions
        if (lastError.includes('min size') || lastError.includes('lower than the minimum')) { failureReason = 'structural'; break }

        // Don't retry FOK liquidity failures surfaced as exceptions
        if (lastError.includes("couldn't be fully filled") || lastError.includes('FOK')) {
          console.warn(`[TradingService] FOK order killed (no liquidity) — not retrying`)
          failureReason = 'structural'
          break
        }

        if (attempt < this.config.maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        }
      }
    }

    // ── GTD Fallback ──────────────────────────────────────────────
    // If FOK was killed due to liquidity AND fallback is enabled,
    // resubmit as a GTD (Good-Til-Date) limit order that sits on
    // the order book with server-enforced expiry.
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
        const gtdResult = await clobClient.placeOrder(gtdRequest)

        if (gtdResult.success && gtdResult.orderId) {
          this.lastOrderTime = Date.now()
          this.inFlightTrades.delete(tradeId)

          // Hand off to GtcOrderManager for fill tracking (dynamic import avoids circular dep)
          import('./GtcOrderManager').then(({ gtcOrderManager }) => {
            gtcOrderManager.trackOrder({
              orderId: gtdResult.orderId!,
              tokenId: request.tokenId,
              marketId: gtdMeta.marketId,
              conditionId: request.conditionId ?? '',
              outcome: gtdMeta.outcome,
              question: gtdMeta.question,
              side: request.side,
              price: request.price,
              size: request.size,
              costBasis: gtdMeta.costBasis,
              strategy: gtdMeta.strategy as PendingGtcOrder['strategy'],
              negRisk: request.negRisk,
              stopLossPercent: gtdMeta.stopLossPercent,
              takeProfitPercent: gtdMeta.takeProfitPercent,
              placedAt: Date.now(),
              expiresAt: expirationSec,
              status: 'pending',
            })
          }).catch(err => console.warn('[TradingService] Failed to track GTD order:', err))

          // Return success with pending flag — do NOT record trade result yet
          // (GtcOrderManager will record it when the order fills or expires)
          return {
            success: true,
            orderId: gtdResult.orderId,
            pending: true,
          }
        }

        // GTD placement also failed — fall through to normal failure path
        console.warn(`[TradingService] GTD fallback also failed: ${gtdResult.error}`)
      } catch (error) {
        console.warn('[TradingService] GTD fallback error:', error)
      }
    }

    this.inFlightTrades.delete(tradeId)
    riskManager.recordTradeResult(false, 0, failureReason)

    return {
      success: false,
      error: lastError || `Order failed after ${this.config.maxRetries} attempts`,
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    return clobClient.cancelOrder(orderId)
  }

  /**
   * Cancel all orders for a token
   */
  async cancelAllOrders(tokenId?: string): Promise<boolean> {
    return clobClient.cancelAllOrders(tokenId)
  }

  /**
   * Get open orders
   */
  async getOpenOrders(tokenId?: string): Promise<Order[]> {
    return clobClient.getOpenOrders(tokenId)
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
   * Confirm order settlement via user channel push (primary) or CLOB polling (fallback).
   * Returns true if the order is matched/filled, false if cancelled/expired/failed/timeout.
   * Best-effort — failure here doesn't invalidate the trade.
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

    // Fallback: Poll CLOB order status
    return this.confirmViaPolling(orderId, timeoutMs)
  }

  /**
   * Listen for trade/order events from user channel WebSocket.
   * Resolves as soon as a matching CONFIRMED/FAILED event arrives.
   */
  private confirmViaUserChannel(orderId: string, timeoutMs: number): Promise<boolean> {
    return new Promise(async (resolve) => {
      const { userChannelService } = await import('@/services/realtime')

      let resolved = false
      const cleanup = () => {
        resolved = true
        unsubTrade()
        unsubOrder()
      }

      // Listen for trade fill events
      const unsubTrade = userChannelService.onTrade((msg) => {
        if (resolved) return
        // Match on maker_orders containing our orderId, or by checking associate trades
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
        // MINED/RETRYING — keep waiting
      })

      // Listen for order cancellation events
      const unsubOrder = userChannelService.onOrder((msg) => {
        if (resolved) return
        if (msg.order_id !== orderId) return

        if (msg.event_type === 'CANCELLATION') {
          console.warn(`[TradingService] Order ${orderId} cancelled via user channel`)
          cleanup()
          resolve(false)
        }
      })

      // Timeout fallback — if no push event within timeoutMs, try polling
      setTimeout(async () => {
        if (resolved) return
        cleanup()
        console.log(`[TradingService] No user channel event for ${orderId} in ${timeoutMs}ms — falling back to polling`)
        resolve(await this.confirmViaPolling(orderId, 5000))
      }, timeoutMs)
    })
  }

  /**
   * Original polling-based confirmation (fallback when user channel unavailable).
   */
  private async confirmViaPolling(orderId: string, timeoutMs: number): Promise<boolean> {
    const pollIntervalMs = 2000
    const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs)

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const order = await clobClient.getOrder(orderId)
        if (!order) return false

        // Order statuses: 'pending', 'open', 'filled', 'cancelled', 'expired', 'failed'
        if (order.status === 'filled') return true
        if (order.status === 'cancelled' || order.status === 'expired' || order.status === 'failed') return false

        await new Promise(r => setTimeout(r, pollIntervalMs))
      } catch {
        // API error — keep trying
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
