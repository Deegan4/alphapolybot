import { BaseApiClient } from './BaseApiClient'
import type { Market, GammaMarketsResponse } from '@/types'

/**
 * Gamma API Client
 * Handles market discovery, metadata, and search
 * Endpoint: https://gamma-api.polymarket.com
 */
export class GammaClient extends BaseApiClient {
  constructor() {
    super(import.meta.env.VITE_GAMMA_API_URL || 'https://gamma-api.polymarket.com', {
      maxRequestsPerMinute: 100,
      maxRetries: 3,
      timeout: 15000,
    })
  }

  /**
   * Get active markets with filtering and pagination
   */
  async getMarkets(options: {
    active?: boolean
    closed?: boolean
    limit?: number
    offset?: number
    sort?: 'volume24hr' | 'createdAt' | 'liquidity' | 'volume'
    order?: 'asc' | 'desc'
    cursor?: string
  } = {}): Promise<Market[]> {
    const {
      active = true,
      closed = false,
      limit = 100,
      sort = 'volume24hr',
      order = 'desc',
      cursor,
    } = options

    const params = new URLSearchParams()
    params.set('active', String(active))
    params.set('closed', String(closed))
    params.set('limit', String(Math.min(limit, 100)))
    // params.set('order', order) // Removed due to Gamma API 422 error
    
    // Sort mapping for Gamma API
    // The 'ascending' param is not supported by the Gamma API and causes 422 errors.
    // const sortMap: Record<string, string> = {
    //   volume24hr: 'volume24hr',
    //   createdAt: 'startDate',
    //   liquidity: 'liquidity',
    //   volume: 'volume',
    // }
    // if (sortMap[sort]) {
    //   params.set('ascending', order === 'asc' ? 'true' : 'false')
    // }
    
    if (cursor) {
      params.set('next_cursor', cursor)
    }

    try {
      const response = await this.get<Market[] | GammaMarketsResponse>(`/markets?${params.toString()}`)
      
      // Handle both array response and object response
      if (Array.isArray(response)) {
        return response
      }
      return response.markets || []
    } catch (error) {
      console.error('Failed to fetch markets:', error)
      throw error
    }
  }

  /**
   * Get a single market by ID
   */
  async getMarket(marketId: string): Promise<Market | null> {
    try {
      const response = await this.get<Market>(`/markets/${marketId}`)
      return response
    } catch (error) {
      console.error(`Failed to fetch market ${marketId}:`, error)
      return null
    }
  }

  /**
   * Get market by condition ID
   */
  async getMarketByConditionId(conditionId: string): Promise<Market | null> {
    try {
      const markets = await this.getMarkets({ limit: 100 })
      return markets.find(m => m.conditionId === conditionId) || null
    } catch (error) {
      console.error(`Failed to fetch market by condition ${conditionId}:`, error)
      return null
    }
  }

  /**
   * Search markets by query
   */
  async searchMarkets(query: string, limit = 20): Promise<Market[]> {
    try {
      const response = await this.get<{ markets?: Market[] }>(`/search?q=${encodeURIComponent(query)}&limit=${limit}`)
      return response.markets || []
    } catch (error) {
      console.error('Failed to search markets:', error)
      return []
    }
  }

  /**
   * Get recently created markets (for scanning new opportunities)
   */
  async getNewMarkets(hoursAgo = 24): Promise<Market[]> {
    try {
      const allMarkets = await this.getMarkets({
        active: true,
        closed: false,
        limit: 100,
        sort: 'createdAt',
        order: 'desc',
      })

      const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000)
      
      return allMarkets.filter(market => {
        const createdAt = new Date(market.createdAt)
        return createdAt > cutoffTime
      })
    } catch (error) {
      console.error('Failed to fetch new markets:', error)
      return []
    }
  }

  /**
   * Get markets with specific criteria (for trading bot)
   */
  async getEligibleMarkets(options: {
    minLiquidity?: number
    minVolume?: number
    maxAge?: number // hours
    minOdds?: number
    maxOdds?: number
  } = {}): Promise<Market[]> {
    const {
      minLiquidity = 1000,
      minVolume = 500,
      maxAge = 48,
      minOdds = 0.40,
      maxOdds = 0.60,
    } = options

    try {
      const markets = await this.getNewMarkets(maxAge)
      
      return markets.filter(market => {
        // Check liquidity
        if (market.liquidity < minLiquidity) return false
        
        // Check volume
        if ((market.volume24hr || market.volume) < minVolume) return false
        
        // Check for balanced odds (near 50/50)
        if (!market.outcomePrices || market.outcomePrices.length !== 2) return false
        
        const [price1, price2] = market.outcomePrices
        const isBalanced = price1 >= minOdds && price1 <= maxOdds && 
                          price2 >= minOdds && price2 <= maxOdds
        
        if (!isBalanced) return false
        
        // Check outcomes exist
        if (!market.outcomes || market.outcomes.length !== 2) return false
        if (!market.clobTokenIds || market.clobTokenIds.length !== 2) return false
        
        return true
      })
    } catch (error) {
      console.error('Failed to fetch eligible markets:', error)
      return []
    }
  }

  /**
   * Get events (market groups)
   */
  async getEvents(options: {
    active?: boolean
    limit?: number
  } = {}): Promise<unknown[]> {
    const { active = true, limit = 50 } = options
    
    try {
      const params = new URLSearchParams()
      params.set('active', String(active))
      params.set('limit', String(limit))
      
      const response = await this.get<{ events?: unknown[] }>(`/events?${params.toString()}`)
      return response.events || []
    } catch (error) {
      console.error('Failed to fetch events:', error)
      return []
    }
  }

  /**
   * Get crypto markets (15-minute markets for dip arbitrage)
   */
  async getCryptoMarkets(underlyings: string[] = ['BTC', 'ETH', 'SOL']): Promise<Market[]> {
    try {
      const allMarkets = await this.getMarkets({
        active: true,
        closed: false,
        limit: 100,
      })

      return allMarkets.filter(market => {
        const question = market.question.toLowerCase()
        
        // Check if it's a crypto price market
        const isCrypto = underlyings.some(symbol => 
          question.includes(symbol.toLowerCase())
        )
        
        // Check if it's a short-term market (15 minutes, 1 hour, etc.)
        const isShortTerm = question.includes('15 min') || 
                           question.includes('15-min') ||
                           question.includes('minute')
        
        return isCrypto && isShortTerm
      })
    } catch (error) {
      console.error('Failed to fetch crypto markets:', error)
      return []
    }
  }
}

// Export singleton instance
export const gammaClient = new GammaClient()
