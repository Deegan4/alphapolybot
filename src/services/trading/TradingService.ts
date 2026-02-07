import type { Market, OrderRequest, OrderResult, Order } from '@/types'
import { clobClient } from '@/services/api'
import { walletService } from '@/services/wallet'

export interface TradingConfig {
  maxSlippage: number
  executionCooldown: number
  maxRetries: number
  fokOnly: boolean
  dryRun: boolean
}

const DEFAULT_CONFIG: TradingConfig = {
  maxSlippage: 0.02, // 2%
  executionCooldown: 500, // ms
  maxRetries: 3,
  fokOnly: true,
  dryRun: true, // SAFE DEFAULT: Always start in dry run mode
}

/**
 * Trading Service
 * Handles order execution with FOK orders and risk management
 */
export class TradingService {
  private config: TradingConfig
  private lastOrderTime = 0
  private pendingOrders = new Map<string, Order>()

  constructor(config: Partial<TradingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Update trading configuration
   */
  setConfig(config: Partial<TradingConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Place a buy order for a market outcome
   */
  async placeBet(
    market: Market,
    outcome: 'yes' | 'no',
    amount: number
  ): Promise<OrderResult> {
    // Ensure approvals (skip actual transactions in dry run mode)
    const hasApprovals = await walletService.ensureApprovals(this.config.dryRun)
    if (!hasApprovals) {
      return { success: false, error: 'Failed to ensure token approvals' }
    }

    // Apply execution cooldown
    await this.waitForCooldown()

    // Determine which token to buy
    const outcomeIndex = outcome === 'yes' ? 0 : 1
    const tokenId = market.clobTokenIds[outcomeIndex]
    const currentPrice = market.outcomePrices[outcomeIndex]

    if (!tokenId || !currentPrice) {
      return { success: false, error: 'Invalid market data' }
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
    }

    return this.executeOrder(orderRequest)
  }

  /**
   * Place a sell order
   */
  async placeSell(
    tokenId: string,
    shares: number,
    price?: number
  ): Promise<OrderResult> {
    // Ensure CTF approval for selling (skip actual transactions in dry run mode)
    const hasApprovals = await walletService.ensureApprovals(this.config.dryRun)
    if (!hasApprovals) {
      return { success: false, error: 'Failed to ensure token approvals' }
    }

    // Apply execution cooldown
    await this.waitForCooldown()

    // Get current price if not provided
    let sellPrice = price
    if (!sellPrice) {
      const midPrice = await clobClient.getMidPrice(tokenId)
      if (!midPrice) {
        return { success: false, error: 'Could not determine market price' }
      }
      sellPrice = midPrice * (1 - this.config.maxSlippage) // Sell slightly below mid
    }

    // Cancel any existing orders for this token first
    await clobClient.cancelAllOrders(tokenId)

    const orderRequest: OrderRequest = {
      tokenId,
      side: 'SELL',
      price: sellPrice,
      size: shares,
      type: this.config.fokOnly ? 'FOK' : 'GTC',
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
   */
  private async executeOrder(request: OrderRequest): Promise<OrderResult> {
    // DRY RUN MODE: Simulate order without executing
    if (this.config.dryRun) {
      console.log('[DRY RUN] Would execute order:', {
        tokenId: request.tokenId,
        side: request.side,
        price: request.price,
        size: request.size,
        type: request.type,
      })
      
      // Simulate network delay
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300))
      
      // Return simulated success
      return {
        success: true,
        orderId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        txHash: `0x${'0'.repeat(64)}`,
        filledSize: request.size,
        avgPrice: request.price,
      }
    }

    let lastError: string | undefined

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        // Adjust for tick size
        request.price = this.adjustForTickSize(request.price)

        // Place the order
        const result = await clobClient.placeOrder(request)

        if (result.success) {
          this.lastOrderTime = Date.now()
          return result
        }

        lastError = result.error

        // Handle specific errors
        if (lastError?.includes('not enough balance') && attempt < this.config.maxRetries - 1) {
          // Reduce size by 1% to handle dust
          request.size *= 0.99
          console.log(`Reducing order size to ${request.size} to handle dust`)
          continue
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
        
        if (attempt < this.config.maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        }
      }
    }

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
