import { BaseApiClient } from './BaseApiClient'
import type { Position, ApiPosition, Trade, PortfolioSummary } from '@/types'

/**
 * Data API Client
 * Handles position tracking, trade history, and portfolio analytics
 * Endpoint: https://data-api.polymarket.com
 */
export class DataClient extends BaseApiClient {
  private walletAddress: string | null = null

  constructor() {
    super(import.meta.env.VITE_DATA_API_URL || 'https://data-api.polymarket.com', {
      maxRequestsPerMinute: 200,
      maxRetries: 3,
      timeout: 15000,
    })
  }

  /**
   * Set the wallet address for queries
   */
  setWalletAddress(address: string): void {
    this.walletAddress = address.toLowerCase()
  }

  /**
   * Get all positions for the connected wallet
   */
  async getPositions(options: {
    sizeThreshold?: number
  } = {}): Promise<Position[]> {
    if (!this.walletAddress) {
      console.error('Wallet address not set')
      return []
    }

    const { sizeThreshold = 0.01 } = options

    try {
      const response = await this.get<ApiPosition[]>(`/positions?user=${this.walletAddress}`)
      
      if (!response || !Array.isArray(response)) {
        return []
      }

      // Convert API positions to our Position type
      return response
        .filter(p => p.size > sizeThreshold)
        .map(this.convertApiPosition)
    } catch (error) {
      console.error('Failed to fetch positions:', error)
      return []
    }
  }

  /**
   * Get a specific position
   */
  async getPosition(tokenId: string): Promise<Position | null> {
    const positions = await this.getPositions()
    return positions.find(p => p.tokenId === tokenId) || null
  }

  /**
   * Get trade history
   */
  async getTradeHistory(options: {
    limit?: number
    offset?: number
  } = {}): Promise<Trade[]> {
    if (!this.walletAddress) {
      console.error('Wallet address not set')
      return []
    }

    const { limit = 100, offset = 0 } = options

    try {
      const response = await this.get<Trade[]>(
        `/trades?user=${this.walletAddress}&limit=${limit}&offset=${offset}`
      )
      
      return response || []
    } catch (error) {
      console.error('Failed to fetch trade history:', error)
      return []
    }
  }

  /**
   * Get portfolio summary
   */
  async getPortfolioSummary(): Promise<PortfolioSummary | null> {
    if (!this.walletAddress) {
      console.error('Wallet address not set')
      return null
    }

    try {
      const positions = await this.getPositions()
      
      if (positions.length === 0) {
        return {
          totalValue: 0,
          totalPnl: 0,
          totalPnlPercent: 0,
          unrealizedPnl: 0,
          realizedPnl: 0,
          positionCount: 0,
        }
      }

      // Calculate portfolio metrics
      const totalValue = positions.reduce((sum, p) => sum + p.size * p.currentPrice, 0)
      const totalCost = positions.reduce((sum, p) => sum + p.size * p.entryPrice, 0)
      const unrealizedPnl = positions.reduce((sum, p) => sum + p.pnl.dollar, 0)
      
      // Get realized P&L from trade history
      const trades = await this.getTradeHistory({ limit: 100 })
      const realizedPnl = this.calculateRealizedPnl(trades)

      const winningPositions = positions.filter(p => p.pnl.percent > 0).length
      const winRate = positions.length > 0 
        ? (winningPositions / positions.length) * 100 
        : 0

      return {
        totalValue,
        totalPnl: unrealizedPnl + realizedPnl,
        totalPnlPercent: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
        unrealizedPnl,
        realizedPnl,
        positionCount: positions.length,
        winRate,
      }
    } catch (error) {
      console.error('Failed to calculate portfolio summary:', error)
      return null
    }
  }

  /**
   * Get profit/loss data for a specific time period
   */
  async getPnLHistory(period: '24h' | '7d' | '30d' = '7d'): Promise<{
    timestamp: Date
    pnl: number
    cumulative: number
  }[]> {
    const trades = await this.getTradeHistory({ limit: 500 })
    
    const now = Date.now()
    const periodMs = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    }[period]

    const cutoff = new Date(now - periodMs)
    const relevantTrades = trades.filter(t => new Date(t.timestamp) > cutoff)

    let cumulative = 0
    return relevantTrades.map(trade => {
      const pnl = trade.side === 'SELL' 
        ? trade.price * trade.size - (trade.fee || 0)
        : -(trade.price * trade.size + (trade.fee || 0))
      cumulative += pnl
      
      return {
        timestamp: new Date(trade.timestamp),
        pnl,
        cumulative,
      }
    })
  }

  /**
   * Convert API position to our Position type
   */
  private convertApiPosition(apiPos: ApiPosition): Position {
    return {
      tokenId: apiPos.asset,
      marketId: apiPos.conditionId,
      conditionId: apiPos.conditionId,
      marketQuestion: apiPos.title || 'Unknown Market',
      outcome: apiPos.outcomeIndex === 0 ? 'Yes' : 'No',
      outcomeIndex: apiPos.outcomeIndex,
      size: apiPos.size,
      entryPrice: apiPos.avgPrice,
      currentPrice: apiPos.curPrice || apiPos.avgPrice,
      pnl: {
        dollar: apiPos.cashPnl || 0,
        percent: apiPos.percentPnl || 0,
      },
      entryTime: new Date(),
      lastUpdate: new Date(apiPos.lastUpdated || Date.now()),
    }
  }

  /**
   * Calculate realized P&L from trades
   */
  private calculateRealizedPnl(trades: Trade[]): number {
    // Group trades by market
    const tradesByMarket = new Map<string, Trade[]>()
    
    for (const trade of trades) {
      const existing = tradesByMarket.get(trade.marketId) || []
      existing.push(trade)
      tradesByMarket.set(trade.marketId, existing)
    }

    let totalRealizedPnl = 0

    // Calculate P&L for each market
    for (const marketTrades of tradesByMarket.values()) {
      const buys = marketTrades.filter(t => t.side === 'BUY')
      const sells = marketTrades.filter(t => t.side === 'SELL')

      if (sells.length > 0) {
        const avgBuyPrice = buys.reduce((sum, t) => sum + t.price * t.size, 0) / 
                           buys.reduce((sum, t) => sum + t.size, 0)
        
        for (const sell of sells) {
          const pnl = (sell.price - avgBuyPrice) * sell.size - (sell.fee || 0)
          totalRealizedPnl += pnl
        }
      }
    }

    return totalRealizedPnl
  }
}

// Export singleton instance
export const dataClient = new DataClient()
