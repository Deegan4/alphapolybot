import type { Market } from '@/types'
import { gammaClient } from '@/services/api'

export interface ScanResult {
  market: Market
  eligible: boolean
  score: number
  reason?: string
}

export interface ScannerConfig {
  minLiquidity: number
  minVolume: number
  maxAgeHours: number
  minOdds: number
  maxOdds: number
  excludedCategories: string[]
  excludedKeywords: string[]
}

const DEFAULT_CONFIG: ScannerConfig = {
  minLiquidity: 1000,
  minVolume: 500,
  maxAgeHours: 48,
  minOdds: 0.40,
  maxOdds: 0.60,
  excludedCategories: ['Sports'],
  excludedKeywords: [],
}

/**
 * Market Scanner Service
 * Discovers and filters eligible markets for trading
 */
export class MarketScanner {
  private config: ScannerConfig
  private scannedMarketIds = new Set<string>()
  private lastScanTime: Date | null = null
  private scanResults: ScanResult[] = []

  constructor(config: Partial<ScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Update scanner configuration
   */
  setConfig(config: Partial<ScannerConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Scan for new markets
   */
  async scan(): Promise<ScanResult[]> {
    try {
      const markets = await gammaClient.getNewMarkets(this.config.maxAgeHours)
      
      this.scanResults = markets.map(market => this.evaluateMarket(market))
      this.lastScanTime = new Date()

      // Mark markets as scanned
      markets.forEach(m => this.scannedMarketIds.add(m.id))

      return this.scanResults
    } catch (error) {
      console.error('Market scan failed:', error)
      return []
    }
  }

  /**
   * Get eligible markets from last scan
   */
  getEligibleMarkets(): Market[] {
    return this.scanResults
      .filter(r => r.eligible)
      .sort((a, b) => b.score - a.score)
      .map(r => r.market)
  }

  /**
   * Get all scan results
   */
  getScanResults(): ScanResult[] {
    return this.scanResults
  }

  /**
   * Get last scan time
   */
  getLastScanTime(): Date | null {
    return this.lastScanTime
  }

  /**
   * Check if a market has been scanned before
   */
  hasBeenScanned(marketId: string): boolean {
    return this.scannedMarketIds.has(marketId)
  }

  /**
   * Evaluate a single market for eligibility
   */
  evaluateMarket(market: Market): ScanResult {
    let score = 0
    const reasons: string[] = []

    // Check if market is active and not closed
    if (!market.active || market.closed) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: 'Market is not active or is closed',
      }
    }

    // Check liquidity
    if (market.liquidity < this.config.minLiquidity) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: `Liquidity ($${market.liquidity}) below minimum ($${this.config.minLiquidity})`,
      }
    }
    score += Math.min(market.liquidity / 10000, 10) // Max 10 points for liquidity

    // Check volume
    const volume = market.volume24hr || market.volume
    if (volume < this.config.minVolume) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: `Volume ($${volume}) below minimum ($${this.config.minVolume})`,
      }
    }
    score += Math.min(volume / 5000, 10) // Max 10 points for volume

    // Check odds are balanced (near 50/50)
    if (!market.outcomePrices || market.outcomePrices.length !== 2) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: 'Market does not have valid binary outcomes',
      }
    }

    const [price1, price2] = market.outcomePrices
    const isBalanced = 
      price1 >= this.config.minOdds && price1 <= this.config.maxOdds &&
      price2 >= this.config.minOdds && price2 <= this.config.maxOdds

    if (!isBalanced) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: `Odds not balanced: ${(price1 * 100).toFixed(1)}% / ${(price2 * 100).toFixed(1)}%`,
      }
    }

    // Higher score for odds closer to 50/50
    const oddsBalance = 1 - Math.abs(price1 - 0.5)
    score += oddsBalance * 20 // Max 10 points for balance (since 0.5 gives 1, scaled to 10)

    // Check outcomes exist
    if (!market.outcomes || market.outcomes.length !== 2) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: 'Market does not have valid outcomes',
      }
    }

    // Check token IDs exist
    if (!market.clobTokenIds || market.clobTokenIds.length !== 2) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: 'Market does not have valid token IDs',
      }
    }

    // Check excluded categories
    if (market.category && this.config.excludedCategories.includes(market.category)) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: `Category "${market.category}" is excluded`,
      }
    }

    // Check excluded keywords
    const questionLower = market.question.toLowerCase()
    for (const keyword of this.config.excludedKeywords) {
      if (questionLower.includes(keyword.toLowerCase())) {
        return {
          market,
          eligible: false,
          score: 0,
          reason: `Contains excluded keyword: "${keyword}"`,
        }
      }
    }

    // Check market age
    const ageHours = (Date.now() - new Date(market.createdAt).getTime()) / (1000 * 60 * 60)
    if (ageHours > this.config.maxAgeHours) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: `Market too old: ${ageHours.toFixed(1)} hours`,
      }
    }

    // Newer markets get higher scores
    const ageScore = Math.max(0, 10 - (ageHours / this.config.maxAgeHours) * 10)
    score += ageScore

    return {
      market,
      eligible: true,
      score: Math.round(score * 10) / 10,
      reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    }
  }

  /**
   * Reset scanner state
   */
  reset(): void {
    this.scannedMarketIds.clear()
    this.scanResults = []
    this.lastScanTime = null
  }
}

// Export singleton instance
export const marketScanner = new MarketScanner()
