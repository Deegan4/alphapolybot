import { BaseApiClient } from './BaseApiClient'
import type { Order, OrderRequest, OrderResult, OrderBook, Trade } from '@/types'
import { ethers } from 'ethers'

/**
 * CLOB API Client
 * Handles order placement, order book data, and trade execution
 * Endpoint: https://clob.polymarket.com
 */
export class CLOBClient extends BaseApiClient {
  private wallet: ethers.Wallet | null = null
  private apiKey: string | null = null
  private apiSecret: string | null = null

  constructor() {
    super(import.meta.env.VITE_CLOB_API_URL || 'https://clob.polymarket.com', {
      maxRequestsPerMinute: 50,
      maxRetries: 3,
      timeout: 15000,
    })
  }

  /**
   * Initialize with wallet for signing
   */
  setWallet(wallet: ethers.Wallet): void {
    this.wallet = wallet
  }

  /**
   * Set API credentials
   */
  setCredentials(apiKey: string, apiSecret: string): void {
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.setAuthToken(apiKey)
  }

  /**
   * Get order book for a market
   */
  async getOrderBook(tokenId: string): Promise<OrderBook | null> {
    try {
      const response = await this.get<{
        market: string
        asset_id: string
        bids: Array<{ price: string; size: string }>
        asks: Array<{ price: string; size: string }>
        timestamp: string
      }>(`/book?token_id=${tokenId}`)

      return {
        marketId: response.market || '',
        bids: response.bids?.map(b => ({
          price: parseFloat(b.price),
          size: parseFloat(b.size),
        })) || [],
        asks: response.asks?.map(a => ({
          price: parseFloat(a.price),
          size: parseFloat(a.size),
        })) || [],
        lastUpdate: Date.now(),
      }
    } catch (error) {
      console.error('Failed to fetch order book:', error)
      return null
    }
  }

  /**
   * Get best bid/ask prices
   */
  async getBestPrices(tokenId: string): Promise<{ bid: number; ask: number; spread: number } | null> {
    const orderBook = await this.getOrderBook(tokenId)
    if (!orderBook) return null

    const bestBid = orderBook.bids[0]?.price || 0
    const bestAsk = orderBook.asks[0]?.price || 1
    const spread = bestAsk - bestBid

    return { bid: bestBid, ask: bestAsk, spread }
  }

  /**
   * Get midpoint price
   */
  async getMidPrice(tokenId: string): Promise<number | null> {
    const prices = await this.getBestPrices(tokenId)
    if (!prices) return null
    return (prices.bid + prices.ask) / 2
  }

  /**
   * Place a Fill-or-Kill (FOK) order
   */
  async placeFOKOrder(request: OrderRequest): Promise<OrderResult> {
    return this.placeOrder({ ...request, type: 'FOK' })
  }

  /**
   * Place a Fill-and-Kill (FAK) order - partial fills allowed
   */
  async placeFAKOrder(request: OrderRequest): Promise<OrderResult> {
    return this.placeOrder({ ...request, type: 'FAK' })
  }

  /**
   * Place a Good-Till-Cancelled (GTC) order
   */
  async placeGTCOrder(request: OrderRequest): Promise<OrderResult> {
    return this.placeOrder({ ...request, type: 'GTC' })
  }

  /**
   * Place an order
   */
  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    if (!this.wallet) {
      return { success: false, error: 'Wallet not initialized' }
    }

    try {
      // Adjust price to tick size (cents)
      const tickPrice = Math.round(request.price * 100) / 100

      // Build order payload
      const orderPayload = {
        tokenID: request.tokenId,
        price: tickPrice,
        size: request.size,
        side: request.side,
        feeRateBps: 0,
        nonce: Date.now(),
        expiration: Math.floor(Date.now() / 1000) + 300, // 5 minutes
      }

      // Sign the order
      const signature = await this.signOrder(orderPayload)

      // Submit order
      const response = await this.post<{
        success?: boolean
        orderID?: string
        transactionsHashes?: string[]
        errorMsg?: string
      }>('/order', {
        order: {
          ...orderPayload,
          signature,
          owner: await this.wallet.getAddress(),
        },
        orderType: request.type || 'FOK',
      })

      if (response.success || response.orderID) {
        return {
          success: true,
          orderId: response.orderID,
          txHash: response.transactionsHashes?.[0],
        }
      }

      return {
        success: false,
        error: response.errorMsg || 'Order placement failed',
      }
    } catch (error) {
      console.error('Failed to place order:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      const response = await this.delete<{ success?: boolean }>(`/order/${orderId}`)
      return response.success || false
    } catch (error) {
      console.error('Failed to cancel order:', error)
      return false
    }
  }

  /**
   * Cancel all orders for a token
   */
  async cancelAllOrders(tokenId?: string): Promise<boolean> {
    try {
      const url = tokenId ? `/orders?token_id=${tokenId}` : '/orders'
      const response = await this.delete<{ success?: boolean }>(url)
      return response.success || false
    } catch (error) {
      console.error('Failed to cancel orders:', error)
      return false
    }
  }

  /**
   * Get open orders
   */
  async getOpenOrders(tokenId?: string): Promise<Order[]> {
    try {
      if (!this.wallet) return []
      
      const address = await this.wallet.getAddress()
      const params = new URLSearchParams()
      params.set('maker', address)
      if (tokenId) params.set('token_id', tokenId)

      const response = await this.get<Order[]>(`/orders?${params.toString()}`)
      return response || []
    } catch (error) {
      console.error('Failed to fetch open orders:', error)
      return []
    }
  }

  /**
   * Get order status
   */
  async getOrder(orderId: string): Promise<Order | null> {
    try {
      const response = await this.get<Order>(`/order/${orderId}`)
      return response
    } catch (error) {
      console.error('Failed to fetch order:', error)
      return null
    }
  }

  /**
   * Get recent trades for a market
   */
  async getTrades(tokenId: string, limit = 100): Promise<Trade[]> {
    try {
      const response = await this.get<Trade[]>(`/trades?token_id=${tokenId}&limit=${limit}`)
      return response || []
    } catch (error) {
      console.error('Failed to fetch trades:', error)
      return []
    }
  }

  /**
   * Sign an order using EIP-712
   */
  private async signOrder(order: {
    tokenID: string
    price: number
    size: number
    side: string
    feeRateBps: number
    nonce: number
    expiration: number
  }): Promise<string> {
    if (!this.wallet) throw new Error('Wallet not initialized')

    const domain = {
      name: 'Polymarket CTF Exchange',
      version: '1',
      chainId: 137,
    }

    const types = {
      Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
      ],
    }

    const makerAddress = await this.wallet.getAddress()
    const value = {
      salt: order.nonce,
      maker: makerAddress,
      signer: makerAddress,
      taker: ethers.ZeroAddress,
      tokenId: order.tokenID,
      makerAmount: ethers.parseUnits(order.size.toString(), 6),
      takerAmount: ethers.parseUnits((order.size * order.price).toString(), 6),
      expiration: order.expiration,
      nonce: 0,
      feeRateBps: order.feeRateBps,
      side: order.side === 'BUY' ? 0 : 1,
      signatureType: 0,
    }

    return this.wallet.signTypedData(domain, types, value)
  }

  /**
   * Create API key credentials (if needed)
   */
  async createApiKey(): Promise<{ apiKey: string; secret: string } | null> {
    if (!this.wallet) return null

    try {
      const timestamp = Date.now()
      const message = `Create API Key: ${timestamp}`
      const signature = await this.wallet.signMessage(message)

      const response = await this.post<{ apiKey: string; secret: string }>('/auth/api-key', {
        timestamp,
        signature,
      })

      return response
    } catch (error) {
      console.error('Failed to create API key:', error)
      return null
    }
  }
}

// Export singleton instance
export const clobClient = new CLOBClient()
