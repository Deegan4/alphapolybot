import type { Market } from '@/types'
import { polymarketClient } from '@/services/api'
import { calibrationTracker } from './CalibrationTracker'

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
  maxAgeHours: 0, // 0 = no age limit (scan all active markets)
  minOdds: 0.15,
  maxOdds: 0.85,
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
      // Fetch all active markets from Gamma API
      const markets = await polymarketClient.getMarkets({ active: true })

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

    // Parse prices to numbers (Gamma API returns strings)
    const price1 = typeof market.outcomePrices[0] === 'string'
      ? parseFloat(market.outcomePrices[0] as unknown as string) : market.outcomePrices[0]
    const price2 = typeof market.outcomePrices[1] === 'string'
      ? parseFloat(market.outcomePrices[1] as unknown as string) : market.outcomePrices[1]

    if (isNaN(price1) || isNaN(price2)) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: 'Outcome prices are not valid numbers',
      }
    }

    // At least one side must be within [minOdds, maxOdds]
    const hasTradeableOdds =
      (price1 >= this.config.minOdds && price1 <= this.config.maxOdds) ||
      (price2 >= this.config.minOdds && price2 <= this.config.maxOdds)

    if (!hasTradeableOdds) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: `Odds outside range: ${(price1 * 100).toFixed(1)}% / ${(price2 * 100).toFixed(1)}% (need ${(this.config.minOdds * 100).toFixed(0)}–${(this.config.maxOdds * 100).toFixed(0)}%)`,
      }
    }

    // Higher score for odds closer to 50/50 (more uncertain = more LLM edge)
    const oddsBalance = 1 - Math.abs(price1 - 0.5)
    score += oddsBalance * 20

    // Check outcomes exist
    if (!market.outcomes || market.outcomes.length !== 2) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: 'Market does not have valid outcomes',
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

    // Exclude crypto Up/Down markets (5m/15m price direction bets).
    // These are mechanical-signal markets where LLMs have no informational edge.
    // Detection: outcomes are ["Up","Down"] or slug contains "updown".
    const hasUpDownOutcomes = market.outcomes?.includes('Up') && market.outcomes?.includes('Down')
    const hasUpDownSlug = market.slug?.includes('updown')
    if (hasUpDownOutcomes || hasUpDownSlug) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: 'Crypto Up/Down market (handled by BTC Up/Down strategy)',
      }
    }

    // Check market age (0 = no age limit)
    const ageHours = (Date.now() - new Date(market.createdAt).getTime()) / (1000 * 60 * 60)
    if (this.config.maxAgeHours > 0 && ageHours > this.config.maxAgeHours) {
      return {
        market,
        eligible: false,
        score: 0,
        reason: `Market too old: ${ageHours.toFixed(1)} hours`,
      }
    }

    // Newer markets get a bonus (max 10 points, decays over 30 days)
    const ageScore = Math.max(0, 10 - (ageHours / 720) * 10) // 720h = 30 days
    score += ageScore

    // Category edge bonus: reward categories where the LLM has proven accuracy
    if (market.category) {
      try {
        const catEdge = calibrationTracker.getCategoryAccuracy(market.category)
        if (catEdge && catEdge.sampleSize >= 10 && catEdge.accuracy > 0.6) {
          score += (catEdge.accuracy - 0.5) * 20 // up to +10 points for proven categories
        }
      } catch {
        // CalibrationTracker not ready — skip bonus
      }
    }

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
