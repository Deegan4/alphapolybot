/**
 * Polygon Gas Oracle
 *
 * Queries Polygon gas station for real-time gas prices before trade execution.
 * Used by TradingService to include gas cost in profitability calculations
 * and by arb strategies to abort when gas eats the profit margin.
 *
 * Caches prices for 15 seconds to avoid spamming the gas station.
 */

export interface GasEstimate {
  /** Gas price in gwei */
  safeLow: number
  standard: number
  fast: number
  /** Estimated cost in USD for a simple swap (65K gas) */
  swapCostUSD: number
  /** Estimated cost in USD for an order placement (~150K gas) */
  orderCostUSD: number
  /** Estimated cost in USD for a merge TX (~200K gas) */
  mergeCostUSD: number
  /** Timestamp of the estimate */
  timestamp: number
}

// Polygon gas station V2 endpoint
const GAS_STATION_URL = import.meta.env.VITE_GAS_STATION_URL || 'https://gasstation.polygon.technology/v2'

// POL (formerly MATIC) price in USD — updated via setMaticPrice() from PriceOracleService.
// Fallback only used until first real price arrives. POL was ~$0.09 as of Feb 2025.
const DEFAULT_POL_USD = 0.10

// Gas units for common operations
const GAS_UNITS = {
  swap: 65_000,
  order: 150_000,   // CLOB order (sign + submit, typical)
  merge: 200_000,   // CTF mergePositions
}

// Cache duration: 15 seconds
const CACHE_TTL_MS = 15_000

export class GasOracle {
  private cachedEstimate: GasEstimate | null = null
  private maticPriceUSD = DEFAULT_POL_USD
  private fetchInProgress: Promise<GasEstimate | null> | null = null

  /**
   * Get current gas estimate (cached for 15s).
   * Returns null if fetch fails — callers should use fallback.
   */
  async getEstimate(): Promise<GasEstimate | null> {
    // Return cache if fresh
    if (this.cachedEstimate && Date.now() - this.cachedEstimate.timestamp < CACHE_TTL_MS) {
      return this.cachedEstimate
    }

    // Coalesce concurrent requests
    if (this.fetchInProgress) return this.fetchInProgress

    this.fetchInProgress = this._fetch()
    const result = await this.fetchInProgress
    this.fetchInProgress = null
    return result
  }

  /**
   * Get estimated gas cost in USD for N transactions.
   * Falls back to hardcoded $0.01/tx if oracle is unavailable.
   */
  async estimateCostUSD(txCount: number, type: 'swap' | 'order' | 'merge' = 'order'): Promise<number> {
    const estimate = await this.getEstimate()
    if (!estimate) return txCount * 0.01 // fallback

    switch (type) {
      case 'swap': return estimate.swapCostUSD * txCount
      case 'order': return estimate.orderCostUSD * txCount
      case 'merge': return estimate.mergeCostUSD * txCount
    }
  }

  /**
   * Check if gas cost would eat too much of the expected profit.
   * Returns true if gas cost > maxGasPercent of profit.
   */
  async isGasTooExpensive(
    expectedProfitUSD: number,
    txCount: number,
    maxGasPercent = 0.50, // 50% of profit max (Polygon gas is typically $0.001-$0.01/tx)
  ): Promise<boolean> {
    const gasCost = await this.estimateCostUSD(txCount)
    return gasCost > expectedProfitUSD * maxGasPercent
  }

  /**
   * Update MATIC/USD price for cost calculations.
   * Called periodically by the app or on wallet balance sync.
   */
  setMaticPrice(priceUSD: number): void {
    if (priceUSD > 0) this.maticPriceUSD = priceUSD
  }

  private async _fetch(): Promise<GasEstimate | null> {
    try {
      // Refresh POL price alongside gas prices (best-effort, never blocks)
      this.refreshPolPrice().catch(() => {})

      const response = await fetch(GAS_STATION_URL, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) return this.cachedEstimate // Return stale cache on error

      const data = await response.json()

      // Polygon gas station V2 returns { safeLow, standard, fast, estimatedBaseFee, blockTime, blockNumber }
      // Each tier has { maxPriorityFee, maxFee } in gwei
      const safeLow = data.safeLow?.maxFee ?? 30
      const standard = data.standard?.maxFee ?? 50
      const fast = data.fast?.maxFee ?? 100

      const estimate: GasEstimate = {
        safeLow,
        standard,
        fast,
        swapCostUSD: this.gasCostUSD(standard, GAS_UNITS.swap),
        orderCostUSD: this.gasCostUSD(standard, GAS_UNITS.order),
        mergeCostUSD: this.gasCostUSD(standard, GAS_UNITS.merge),
        timestamp: Date.now(),
      }

      this.cachedEstimate = estimate
      console.debug(`[GasOracle] ${standard.toFixed(0)} gwei, POL=$${this.maticPriceUSD.toFixed(4)}, merge=$${estimate.mergeCostUSD.toFixed(4)}`)
      return estimate
    } catch (error) {
      console.warn('[GasOracle] Failed to fetch gas prices:', error)
      return this.cachedEstimate // Return stale cache
    }
  }

  /**
   * Fetch current POL (ex-MATIC) price from CoinGecko.
   * Called automatically on each gas fetch cycle (every 15s).
   * Best-effort — failure keeps the previous price.
   */
  private async refreshPolPrice(): Promise<void> {
    try {
      const coingeckoBase = import.meta.env.VITE_COINGECKO_API_URL || 'https://api.coingecko.com/api/v3'
      const resp = await fetch(
        `${coingeckoBase}/simple/price?ids=polygon-ecosystem-token&vs_currencies=usd`,
        { signal: AbortSignal.timeout(5000) }
      )
      if (!resp.ok) return
      const data = await resp.json()
      const price = data?.['polygon-ecosystem-token']?.usd
      if (typeof price === 'number' && price > 0) {
        this.maticPriceUSD = price
      }
    } catch {
      // Non-critical — keep using previous price
    }
  }

  /**
   * Convert gas price in gwei + gas units to USD cost.
   * Formula: (gasPrice_gwei * gasUnits * 1e-9) * MATIC_USD
   */
  private gasCostUSD(gasPriceGwei: number, gasUnits: number): number {
    return (gasPriceGwei * gasUnits * 1e-9) * this.maticPriceUSD
  }
}

// Export singleton
export const gasOracle = new GasOracle()
