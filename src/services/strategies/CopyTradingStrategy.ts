/**
 * Copy Trading Strategy — Mirror trades from followed whale wallets.
 *
 * Polls Polymarket Gamma API for recent activity by a target wallet address.
 * When a new BUY is detected, mirrors it with configured trade size via
 * GTD maker orders (0% fees).
 *
 * Key properties:
 * - Polls at configurable interval (default 15s)
 * - Deduplicates by tracking last-seen timestamp
 * - Respects copyMaxConcurrent limit
 * - SL/TP on copied positions via PLM
 * - copyBuysOnly mode (default) — only copies buys, not sells
 * - GTD maker orders to avoid taker fees
 */

import { BaseStrategy } from './BaseStrategy'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'

// ==========================================
// TYPES
// ==========================================

interface WalletTrade {
  type: 'BUY' | 'SELL'
  market: string
  outcome: string
  price: number
  amount: number
  timestamp: number
  tokenId: string
  conditionId?: string
  slug?: string
}

interface CopiedPosition {
  id: string
  sourceTradeTimestamp: number
  marketSlug: string
  tokenId: string
  side: 'BUY' | 'SELL'
  entryPrice: number
  size: number
  orderId?: string
  status: 'pending' | 'filled' | 'closed'
  openedAt: number
}

interface CopyTradingConfig {
  followedAddress: string
  tradeSize: number
  maxConcurrent: number
  pollIntervalMs: number
  stopLossPercent: number
  takeProfitPercent: number
  buysOnly: boolean
}

// ==========================================
// STRATEGY
// ==========================================

export class CopyTradingStrategy extends BaseStrategy {
  name = 'Copy Trading'
  description = 'Mirrors trades from followed whale wallets'
  strategyType = 'mechanical' as const

  private pollInterval: ReturnType<typeof setInterval> | null = null
  private lastSeenTimestamp = 0
  private copiedPositions = new Map<string, CopiedPosition>()
  private polling = false

  // ==========================================
  // CONFIG
  // ==========================================

  get copyConfig(): CopyTradingConfig {
    const s = useSettingsStore.getState()
    return {
      followedAddress: s.followedAddress ?? '',
      tradeSize: s.copyTradeSize ?? 1,
      maxConcurrent: s.copyMaxConcurrent ?? 5,
      pollIntervalMs: s.copyPollIntervalMs ?? 15_000,
      stopLossPercent: s.copyStopLossPercent ?? 0.30,
      takeProfitPercent: s.copyTakeProfitPercent ?? 0.50,
      buysOnly: s.copyBuysOnly ?? true,
    }
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async initialize(): Promise<void> {
    this.log('Copy Trading strategy initialized')
  }

  async start(): Promise<void> {
    if (!this._enabled) return
    if (this._status === 'running') return

    const config = this.copyConfig
    if (!config.followedAddress) {
      this.log('No followed address configured — skipping start')
      return
    }

    this._status = 'running'
    this.log(`Copy Trading started — following ${config.followedAddress.slice(0, 10)}...`)
    activityLogger.logSystem(`Copy Trading: following ${config.followedAddress.slice(0, 10)}...`)

    // Initial poll
    await this.pollForTrades()

    // Schedule recurring polls
    this.pollInterval = setInterval(() => this.pollForTrades(), config.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this._status = 'idle'
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
    this.log('Copy Trading stopped')
  }

  // ==========================================
  // POLLING
  // ==========================================

  private async pollForTrades(): Promise<void> {
    if (this.polling) return
    this.polling = true

    try {
      const config = this.copyConfig
      if (!config.followedAddress) return

      const trades = await this.fetchWalletActivity(config.followedAddress)
      if (!trades.length) return

      // Filter to new trades only
      const newTrades = trades.filter(t => t.timestamp > this.lastSeenTimestamp)
      if (!newTrades.length) return

      // Update last-seen
      this.lastSeenTimestamp = Math.max(...newTrades.map(t => t.timestamp))

      // Filter by type
      const actionable = config.buysOnly
        ? newTrades.filter(t => t.type === 'BUY')
        : newTrades

      for (const trade of actionable) {
        await this.copyTrade(trade, config)
      }
    } catch (err) {
      this.logError('Poll failed', err)
    } finally {
      this.polling = false
    }
  }

  // ==========================================
  // TRADE EXECUTION
  // ==========================================

  private async copyTrade(trade: WalletTrade, config: CopyTradingConfig): Promise<void> {
    // Check concurrent limit
    const active = [...this.copiedPositions.values()].filter(p => p.status !== 'closed')
    if (active.length >= config.maxConcurrent) {
      this.log(`Skipping copy — at max concurrent (${config.maxConcurrent})`)
      return
    }

    // Check for duplicate (same market + direction within 60s)
    const isDuplicate = active.some(p =>
      p.tokenId === trade.tokenId &&
      p.side === trade.type &&
      Date.now() - p.openedAt < 60_000
    )
    if (isDuplicate) return

    const positionId = `copy-${trade.tokenId}-${Date.now()}`

    const position: CopiedPosition = {
      id: positionId,
      sourceTradeTimestamp: trade.timestamp,
      marketSlug: trade.slug ?? trade.market,
      tokenId: trade.tokenId,
      side: trade.type,
      entryPrice: trade.price,
      size: config.tradeSize,
      status: 'pending',
      openedAt: Date.now(),
    }

    this.copiedPositions.set(positionId, position)

    try {
      // Place GTD maker order via TradingService
      const { tradingService } = await import('@/services/trading/TradingService')
      const result = await tradingService.placeTrade({
        tokenId: trade.tokenId,
        side: trade.type,
        price: trade.price,
        size: config.tradeSize,
        orderType: 'GTD',
        expiryMs: 5 * 60 * 1000, // 5 min GTD
      })

      if (result?.orderId) {
        position.orderId = result.orderId
        position.status = 'filled'
        this.log(`COPIED ${trade.type} ${trade.market} @ ${trade.price.toFixed(3)} — $${config.tradeSize}`)
        activityLogger.logTrade(`Copy Trade: ${trade.type} ${trade.market} @ ${trade.price.toFixed(3)}`)
        this.recordTrade(0, config.tradeSize, 0)
        this.emit('tradeCopied', { position, sourceTrade: trade })
      } else {
        position.status = 'closed'
        this.log(`Copy order failed for ${trade.market}`)
      }
    } catch (err) {
      position.status = 'closed'
      this.logError(`Copy trade failed: ${trade.market}`, err)
    }
  }

  // ==========================================
  // GAMMA API
  // ==========================================

  private async fetchWalletActivity(address: string): Promise<WalletTrade[]> {
    try {
      const { gammaClient } = await import('@/services/api')
      const response = await gammaClient.get(`/activity?address=${address}&limit=20`)

      if (!response?.data) return []

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (response.data as any[])
        .filter((item: { type?: string }) => item.type === 'BUY' || item.type === 'SELL')
        .map((item: {
          type: string; market?: string; outcome?: string; price?: number;
          amount?: number; timestamp?: number; tokenId?: string;
          conditionId?: string; slug?: string
        }) => ({
          type: item.type as 'BUY' | 'SELL',
          market: item.market ?? '',
          outcome: item.outcome ?? '',
          price: item.price ?? 0,
          amount: item.amount ?? 0,
          timestamp: item.timestamp ?? 0,
          tokenId: item.tokenId ?? '',
          conditionId: item.conditionId,
          slug: item.slug,
        }))
    } catch (err) {
      this.logError('Failed to fetch wallet activity', err)
      return []
    }
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  getActivePositions(): CopiedPosition[] {
    return [...this.copiedPositions.values()].filter(p => p.status !== 'closed')
  }

  getCopiedCount(): number {
    return this.getActivePositions().length
  }
}

// ==========================================
// SINGLETON EXPORT
// ==========================================

export const copyTradingStrategy = new CopyTradingStrategy()
