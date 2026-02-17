import { BaseStrategy } from './BaseStrategy'
import { DataClient } from '@/services/api/DataClient'
import { gammaClient } from '@/services/api/GammaClient'
import { useSettingsStore } from '@/stores/settingsStore'
import { activityLogger } from '@/services/trading/ActivityLogger'
import type { Trade, Market, StrategyType } from '@/types'

/**
 * CopyTradingStrategy
 *
 * Polls a followed trader's trade history via the public Data API.
 * When new BUY trades are detected, mirrors them using TradingService.placeBet().
 * Exits are handled by PLM's stop-loss / take-profit — we only copy entries.
 *
 * Deduplication: tracks copied trade IDs in a Set + lastSeenTimestamp watermark.
 */
export class CopyTradingStrategy extends BaseStrategy {
  name = 'Copy Trading'
  description = 'Mirror trades from a followed Polymarket trader'
  strategyType: StrategyType = 'copy'

  private dataClient: DataClient | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastSeenTimestamp = 0
  private copiedTradeIds = new Set<string>()
  private copiedCount = 0
  private marketCache = new Map<string, Market>()

  async initialize(): Promise<void> {
    console.log('[CopyTrading] Initialized')
  }

  async start(): Promise<void> {
    const settings = useSettingsStore.getState()
    const address = settings.followedAddress

    if (!address) {
      console.warn('[CopyTrading] No followed address configured')
      this.setStatus('error')
      return
    }

    // Create a dedicated DataClient for the followed wallet
    this.dataClient = new DataClient()
    this.dataClient.setWalletAddress(address)

    // Seed lastSeenTimestamp from the most recent trade to avoid copying old history
    await this.seedLastSeen()

    this.setStatus('running')
    console.log(`[CopyTrading] Started — polling ${address} every ${settings.copyPollIntervalMs}ms`)
    activityLogger.logSystem(`Copy trading started — following ${address.slice(0, 8)}...`)

    // Start polling loop
    this.pollTimer = setInterval(() => this.poll(), settings.copyPollIntervalMs)
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.dataClient = null
    this.marketCache.clear()
    this.setStatus('idle')
    console.log('[CopyTrading] Stopped')
  }

  /** Number of trades copied this session */
  get tradesCopied(): number {
    return this.copiedCount
  }

  /**
   * Seed lastSeenTimestamp by fetching the latest trade, so we don't
   * re-copy the entire history on first start.
   */
  private async seedLastSeen(): Promise<void> {
    if (!this.dataClient) return

    try {
      const trades = await this.dataClient.getTradeHistory({ limit: 1 })
      if (trades.length > 0) {
        const ts = new Date(trades[0].timestamp).getTime()
        this.lastSeenTimestamp = ts
        console.log(`[CopyTrading] Seeded lastSeen to ${new Date(ts).toISOString()}`)
      }
    } catch (err) {
      console.error('[CopyTrading] Failed to seed lastSeen:', err)
    }
  }

  /**
   * Main poll cycle — fetch recent trades, filter new BUYs, execute copies.
   */
  private async poll(): Promise<void> {
    if (!this._enabled || !this.dataClient) return

    try {
      const settings = useSettingsStore.getState()
      const trades = await this.dataClient.getTradeHistory({ limit: 50 })

      if (!trades || trades.length === 0) return

      // Filter: only trades newer than lastSeenTimestamp, not already copied
      const newTrades = trades.filter(t => {
        const ts = new Date(t.timestamp).getTime()
        return ts > this.lastSeenTimestamp && !this.copiedTradeIds.has(t.id)
      })

      if (newTrades.length === 0) return

      // Filter: only BUYs if copyBuysOnly is enabled
      const tradesToCopy = settings.copyBuysOnly
        ? newTrades.filter(t => t.side === 'BUY')
        : newTrades

      console.log(`[CopyTrading] Found ${newTrades.length} new trade(s), ${tradesToCopy.length} to copy`)

      for (const trade of tradesToCopy) {
        await this.copyTrade(trade, settings)
      }

      // Update watermark to the newest trade we've seen
      const maxTs = Math.max(...trades.map(t => new Date(t.timestamp).getTime()))
      if (maxTs > this.lastSeenTimestamp) {
        this.lastSeenTimestamp = maxTs
      }

      // Mark all new trades as seen (including SELLs we didn't copy)
      for (const t of newTrades) {
        this.copiedTradeIds.add(t.id)
      }

      // Prune old IDs (keep last 500 to prevent unbounded growth)
      if (this.copiedTradeIds.size > 500) {
        const arr = Array.from(this.copiedTradeIds)
        this.copiedTradeIds = new Set(arr.slice(-500))
      }
    } catch (err) {
      console.error('[CopyTrading] Poll error:', err)
    }
  }

  /**
   * Copy a single trade from the followed wallet.
   */
  private async copyTrade(
    trade: Trade,
    settings: ReturnType<typeof useSettingsStore.getState>
  ): Promise<void> {
    try {
      // Check concurrent position limit
      const { positionLifecycleManager } = await import('@/services/trading')
      if (positionLifecycleManager.count >= settings.copyMaxConcurrent) {
        console.log(`[CopyTrading] Skipping — at max concurrent (${settings.copyMaxConcurrent})`)
        return
      }

      // Fetch market (cached to avoid re-fetching within a scan)
      const market = await this.getMarketForTrade(trade)
      if (!market) {
        console.warn(`[CopyTrading] Could not fetch market for trade ${trade.id}`)
        return
      }

      // Skip closed/inactive markets
      if (market.closed || !market.active) {
        console.log(`[CopyTrading] Skipping closed/inactive market: ${market.question}`)
        return
      }

      // Skip if we already have a position on this token
      const existingPositions = positionLifecycleManager.getPositions()
      if (existingPositions.some(p => p.tokenId === trade.tokenId)) {
        console.log(`[CopyTrading] Skipping — already in position on ${trade.tokenId.slice(0, 8)}...`)
        return
      }

      // Determine outcome from tokenId
      const outcome = this.resolveOutcome(trade.tokenId, market)
      if (!outcome) {
        console.warn(`[CopyTrading] Could not resolve outcome for tokenId ${trade.tokenId}`)
        return
      }

      // Execute the copy via TradingService
      const { tradingService } = await import('@/services/trading')
      const result = await tradingService.placeBet(market, outcome, settings.copyTradeSize, {
        stopLossPercent: settings.copyStopLossPercent,
        takeProfitPercent: settings.copyTakeProfitPercent,
      })

      if (result.success) {
        this.copiedCount++
        this.recordTrade(0, settings.copyTradeSize, 0)
        this.emit('tradePlaced', { trade, market, outcome })

        const shortQ = market.question.length > 60
          ? market.question.slice(0, 57) + '...'
          : market.question
        activityLogger.logTrade(
          `Copied BUY: ${outcome.toUpperCase()} on "${shortQ}" ($${settings.copyTradeSize})`,
          { source: 'copy', followedAddress: settings.followedAddress, originalSize: trade.size }
        )
        console.log(`[CopyTrading] Copied trade — ${outcome} on "${shortQ}"`)
      } else {
        console.warn(`[CopyTrading] placeBet failed: ${result.error}`)
      }
    } catch (err) {
      console.error(`[CopyTrading] Error copying trade ${trade.id}:`, err)
    }
  }

  /**
   * Fetch market data for a trade, with caching.
   */
  private async getMarketForTrade(trade: Trade): Promise<Market | null> {
    const cached = this.marketCache.get(trade.marketId)
    if (cached) return cached

    const market = await gammaClient.getMarket(trade.marketId)
    if (market) {
      this.marketCache.set(trade.marketId, market)
    }
    return market
  }

  /**
   * Resolve 'yes' or 'no' from a tokenId by matching against market.clobTokenIds.
   * clobTokenIds[0] = Yes token, clobTokenIds[1] = No token.
   */
  private resolveOutcome(tokenId: string, market: Market): 'yes' | 'no' | null {
    if (!market.clobTokenIds || market.clobTokenIds.length < 2) return null
    if (tokenId === market.clobTokenIds[0]) return 'yes'
    if (tokenId === market.clobTokenIds[1]) return 'no'
    return null
  }
}

// Export singleton
export const copyTradingStrategy = new CopyTradingStrategy()
