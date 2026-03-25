/**
 * ChainlinkFeedService — on-chain price oracle for Polygon mainnet.
 *
 * Reads Chainlink aggregator latestRoundData() for BTC/ETH/SOL/XRP on Polygon.
 * This is the SAME price feed Polymarket uses to resolve Crypto Up/Down markets,
 * giving the bot resolution-source-level accuracy for last-window sniping.
 *
 * All reads are free eth_call (no gas, no signing).
 * Uses the same Polygon RPC infrastructure as MergeService.
 */

import { ethers } from 'ethers'

// ==========================================
// POLYGON CHAINLINK AGGREGATOR ADDRESSES
// Source: https://docs.chain.link/data-feeds/price-feeds/addresses?network=polygon
// Verified: https://polygonscan.com/address/0xc907E116054Ad103354f2D350FD2514433D57F6f
// ==========================================

const FEEDS: Record<string, string> = {
  BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f',  // BTC / USD
  ETH: '0xF9680D99D6C9589e2a93a78A04A279e509205945',  // ETH / USD
  SOL: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC',  // SOL / USD
  XRP: '0x785ba89291f676b5386652eB12b30cF361020694',  // XRP / USD
}

/** Chainlink AggregatorV3Interface — only latestRoundData() needed */
const AGGREGATOR_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)',
]

/** Default Polygon RPC — same as MergeService */
const POLYGON_RPC = import.meta.env?.VITE_POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com'
const POLYGON_RPC_FALLBACK = import.meta.env?.VITE_POLYGON_RPC_FALLBACK || 'https://polygon.llamarpc.com'

// ==========================================
// TYPES
// ==========================================

export interface ChainlinkPrice {
  symbol: string
  priceUSD: number
  roundId: bigint
  updatedAt: number      // unix seconds
  answeredInRound: bigint
  source: 'chainlink'
  latencyMs: number      // time to fetch
}

export type ChainlinkSymbol = 'BTC' | 'ETH' | 'SOL' | 'XRP'

// ==========================================
// SERVICE
// ==========================================

export class ChainlinkFeedService {
  private provider: ethers.JsonRpcProvider | null = null
  private fallbackProvider: ethers.JsonRpcProvider | null = null
  private contracts = new Map<string, ethers.Contract>()
  private decimalsCache = new Map<string, number>()
  private priceCache = new Map<string, ChainlinkPrice>()
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private callbacks = new Set<(price: ChainlinkPrice) => void>()
  private _connected = false

  get connected(): boolean { return this._connected }

  /**
   * Initialize provider and contract instances.
   * Safe to call multiple times (idempotent).
   */
  initialize(): void {
    if (this.provider) return

    try {
      this.provider = new ethers.JsonRpcProvider(POLYGON_RPC, 137, {
        staticNetwork: true,
        batchMaxCount: 4,
      })
      this.fallbackProvider = new ethers.JsonRpcProvider(POLYGON_RPC_FALLBACK, 137, {
        staticNetwork: true,
      })

      for (const [symbol, address] of Object.entries(FEEDS)) {
        this.contracts.set(symbol, new ethers.Contract(address, AGGREGATOR_ABI, this.provider))
      }

      this._connected = true
      console.log(`[ChainlinkFeed] Initialized with ${Object.keys(FEEDS).length} feeds on Polygon`)
    } catch (err) {
      console.error('[ChainlinkFeed] Failed to initialize:', err)
      this._connected = false
      // Fire-and-forget audit log — dynamic import avoids potential circular dep
      import('./ActivityLogger').then(({ activityLogger }) => {
        activityLogger.logWarning(`Chainlink feed init failed: ${err instanceof Error ? err.message : 'unknown'}`)
      }).catch(() => {})
    }
  }

  /**
   * Fetch latest price for a single asset.
   * Returns cached if fresh (<2s), otherwise hits on-chain.
   */
  async getPrice(symbol: ChainlinkSymbol): Promise<ChainlinkPrice | null> {
    const cached = this.priceCache.get(symbol)
    if (cached && Date.now() - cached.updatedAt * 1000 < 2000) {
      return cached
    }

    return this.fetchPrice(symbol)
  }

  /**
   * Get cached price synchronously (no RPC call).
   * Returns null if never fetched or stale beyond maxAgeMs.
   */
  getCachedPrice(symbol: ChainlinkSymbol, maxAgeMs = 30_000): ChainlinkPrice | null {
    const cached = this.priceCache.get(symbol)
    if (!cached) return null
    if (Date.now() - cached.updatedAt * 1000 > maxAgeMs) return null
    return cached
  }

  /**
   * Subscribe to price updates from polling loop.
   * Returns unsubscribe function.
   */
  onPriceUpdate(callback: (price: ChainlinkPrice) => void): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  /**
   * Start polling loop at given interval.
   * Default 2s — matches Polygon block time for freshest on-chain data.
   */
  startPolling(intervalMs = 2000, symbols: ChainlinkSymbol[] = ['BTC']): void {
    this.initialize()
    if (this.pollInterval) return

    // Initial fetch immediately
    this.fetchAll(symbols)

    this.pollInterval = setInterval(() => {
      this.fetchAll(symbols)
    }, intervalMs)

    console.log(`[ChainlinkFeed] Polling ${symbols.join(',')} every ${intervalMs}ms`)
  }

  /**
   * Stop polling.
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  /**
   * Fetch all requested symbols in parallel.
   */
  private async fetchAll(symbols: ChainlinkSymbol[]): Promise<void> {
    const results = await Promise.allSettled(
      symbols.map(s => this.fetchPrice(s))
    )
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn('[ChainlinkFeed] Fetch failed:', r.reason?.message || r.reason)
      }
    }
  }

  /**
   * Read latestRoundData() from on-chain aggregator.
   * Falls back to secondary RPC on failure.
   */
  private async fetchPrice(symbol: ChainlinkSymbol): Promise<ChainlinkPrice | null> {
    this.initialize()

    const contract = this.contracts.get(symbol)
    if (!contract) {
      console.warn(`[ChainlinkFeed] No feed configured for ${symbol}`)
      return null
    }

    const start = performance.now()

    try {
      const result = await this.callWithFallback(contract, symbol)
      if (!result) return null

      const [roundId, answer, , updatedAt, answeredInRound] = result
      const decimals = await this.getDecimals(symbol)
      const priceUSD = Number(answer) / Math.pow(10, decimals)

      const price: ChainlinkPrice = {
        symbol,
        priceUSD,
        roundId: BigInt(roundId),
        updatedAt: Number(updatedAt),
        answeredInRound: BigInt(answeredInRound),
        source: 'chainlink',
        latencyMs: Math.round(performance.now() - start),
      }

      const prev = this.priceCache.get(symbol)
      this.priceCache.set(symbol, price)

      // Only emit if price actually changed (avoid noisy callbacks)
      if (!prev || prev.priceUSD !== price.priceUSD || prev.roundId !== price.roundId) {
        for (const cb of this.callbacks) {
          try { cb(price) } catch { /* subscriber error */ }
        }
      }

      return price
    } catch (err) {
      console.error(`[ChainlinkFeed] ${symbol} fetch failed:`, (err as Error).message)
      return null
    }
  }

  /**
   * Try primary RPC, fall back to secondary on failure.
   */
  private async callWithFallback(
    contract: ethers.Contract,
    symbol: string,
  ): Promise<ethers.Result | null> {
    try {
      return await contract.latestRoundData()
    } catch (primaryErr) {
      if (!this.fallbackProvider) throw primaryErr

      console.warn(`[ChainlinkFeed] ${symbol} primary RPC failed, trying fallback`)
      const address = FEEDS[symbol]
      if (!address) throw primaryErr

      const fallbackContract = new ethers.Contract(address, AGGREGATOR_ABI, this.fallbackProvider)
      return await fallbackContract.latestRoundData()
    }
  }

  /**
   * Cache decimals() per feed (always 8 for USD pairs, but read once to be safe).
   */
  private async getDecimals(symbol: string): Promise<number> {
    const cached = this.decimalsCache.get(symbol)
    if (cached !== undefined) return cached

    const contract = this.contracts.get(symbol)
    if (!contract) return 8

    try {
      const d = await contract.decimals()
      this.decimalsCache.set(symbol, Number(d))
      return Number(d)
    } catch {
      this.decimalsCache.set(symbol, 8)
      return 8 // USD pairs are always 8
    }
  }

  /**
   * Tear down provider and stop polling.
   */
  destroy(): void {
    this.stopPolling()
    this.contracts.clear()
    this.priceCache.clear()
    this.callbacks.clear()
    this.provider = null
    this.fallbackProvider = null
    this._connected = false
  }
}

export const chainlinkFeedService = new ChainlinkFeedService()
