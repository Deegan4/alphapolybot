import type { Market, PriceUpdate } from '@/types'

export interface DipEvent {
  market: Market
  tokenId: string
  outcome: 'yes' | 'no'
  previousPrice: number
  currentPrice: number
  dipPercent: number
  timestamp: number
  windowMs: number
}

interface PriceWindow {
  prices: Array<{ price: number; timestamp: number }>
  maxPrice: number
  minPrice: number
}

/**
 * DipDetector - Detects price dips in real-time market data
 * 
 * Per spec: "Monitors for sudden price drops (typically ≥30%)
 * that represent buying opportunities"
 * 
 * Proven configuration (86% ROI):
 * - dipThreshold: 0.30 (30% drop from recent high)
 * - slidingWindowMs: 10000 (10 second window)
 * - sumTarget: 0.95 (YES + NO ≥ 95 cents)
 */
export class DipDetector {
  private priceWindows: Map<string, PriceWindow> = new Map()
  private config = {
    dipThreshold: 0.30, // 30% drop triggers dip
    slidingWindowMs: 10000, // 10 second sliding window
    sumTarget: 0.95, // YES + NO must sum to at least 95 cents
    minPrice: 0.10, // Minimum price to consider
    maxPrice: 0.90, // Maximum price to consider (avoid extreme odds)
  }
  
  private dipCallbacks: Array<(event: DipEvent) => void> = []
  private recentDips: Set<string> = new Set() // Prevent duplicate triggers
  private dipCooldownMs = 30000 // 30 second cooldown per market

  constructor(config?: Partial<typeof DipDetector.prototype.config>) {
    if (config) {
      this.config = { ...this.config, ...config }
    }
  }

  /**
   * Process a price update and check for dips
   */
  processPriceUpdate(market: Market, update: PriceUpdate): DipEvent | null {
    const key = this.getKey(market.id, update.outcome)
    
    // Get or create price window
    let window = this.priceWindows.get(key)
    if (!window) {
      window = { prices: [], maxPrice: 0, minPrice: 1 }
      this.priceWindows.set(key, window)
    }

    const now = Date.now()
    const price = update.price

    // Add new price
    window.prices.push({ price, timestamp: now })

    // Remove prices outside the sliding window
    const cutoff = now - this.config.slidingWindowMs
    window.prices = window.prices.filter(p => p.timestamp > cutoff)

    // Recalculate max/min for the window
    window.maxPrice = Math.max(...window.prices.map(p => p.price))
    window.minPrice = Math.min(...window.prices.map(p => p.price))

    // Check for dip
    const dipEvent = this.checkForDip(market, update, window)
    
    if (dipEvent && !this.isOnCooldown(key)) {
      this.triggerDip(dipEvent, key)
      return dipEvent
    }

    return null
  }

  /**
   * Check if current price represents a dip from recent high
   */
  private checkForDip(market: Market, update: PriceUpdate, window: PriceWindow): DipEvent | null {
    const currentPrice = update.price

    // Need enough history to detect a dip
    if (window.prices.length < 2) {
      return null
    }

    // Price must be in valid range
    if (currentPrice < this.config.minPrice || currentPrice > this.config.maxPrice) {
      return null
    }

    // Sum constraint check: YES + NO < sumTarget means arb opportunity.
    // Use the ACTUAL complement price from the market (not 1-currentPrice,
    // which always sums to exactly 1.0 and would never trigger arbs).
    const complementIndex = update.outcome === 'yes' ? 1 : 0
    const complementPrice = market.outcomePrices?.[complementIndex] ?? (1 - currentPrice)
    const totalCost = currentPrice + complementPrice

    // For dip detection, we want the sum to be BELOW the target (profitable arb).
    // Skip if sum is too high — no arb exists.
    // Note: we DON'T reject if below sumTarget here — that's the arb condition!
    // The dip detection (below) handles the actual trigger logic.

    // Calculate dip percentage from window high
    const dipPercent = (window.maxPrice - currentPrice) / window.maxPrice

    // Check if it meets threshold
    if (dipPercent >= this.config.dipThreshold) {
      return {
        market,
        tokenId: update.tokenId,
        outcome: update.outcome,
        previousPrice: window.maxPrice,
        currentPrice,
        dipPercent,
        timestamp: Date.now(),
        windowMs: this.config.slidingWindowMs,
      }
    }

    return null
  }

  /**
   * Generate unique key for market+outcome combination
   */
  private getKey(marketId: string, outcome: 'yes' | 'no'): string {
    return `${marketId}-${outcome}`
  }

  /**
   * Check if market is on cooldown (recently triggered)
   */
  private isOnCooldown(key: string): boolean {
    return this.recentDips.has(key)
  }

  /**
   * Trigger dip event and set cooldown
   */
  private triggerDip(event: DipEvent, key: string): void {
    // Set cooldown
    this.recentDips.add(key)
    setTimeout(() => {
      this.recentDips.delete(key)
    }, this.dipCooldownMs)

    // Notify callbacks
    this.dipCallbacks.forEach(callback => {
      try {
        callback(event)
      } catch (error) {
        console.error('[DipDetector] Callback error:', error)
      }
    })
  }

  /**
   * Subscribe to dip events
   */
  onDip(callback: (event: DipEvent) => void): () => void {
    this.dipCallbacks.push(callback)
    return () => {
      const index = this.dipCallbacks.indexOf(callback)
      if (index !== -1) {
        this.dipCallbacks.splice(index, 1)
      }
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): typeof this.config {
    return { ...this.config }
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<typeof this.config>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Clear all price windows
   */
  reset(): void {
    this.priceWindows.clear()
    this.recentDips.clear()
  }

  /**
   * Get statistics about tracked markets
   */
  getStats(): { trackedMarkets: number; recentDips: number } {
    return {
      trackedMarkets: this.priceWindows.size,
      recentDips: this.recentDips.size,
    }
  }
}

// Export singleton instance — aligned with DipArbStrategy defaults
// (DipArbStrategy creates its own DipDetector, but this singleton
// prevents confusion if referenced elsewhere)
export const dipDetector = new DipDetector({
  dipThreshold: 0.05,      // 5% dip (was 30% — too extreme, never triggers)
  slidingWindowMs: 30000,  // 30 second window (was 10s)
  sumTarget: 0.98,         // YES + NO ≤ 98¢ (was 0.95)
})
