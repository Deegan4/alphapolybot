import { BaseStrategy } from './BaseStrategy'
import { ASSET_SLUG_PATTERNS } from './BtcUpDownStrategy'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'
import type { Market } from '@/types/api'
import type { LiquidationEvent } from '@/services/realtime/HyperliquidWSService'

// ==========================================
// TYPES
// ==========================================

interface CachedMarket {
  market: Market
  yesTokenId: string
  noTokenId: string
  windowEndMs: number
  durationKey: string
}

interface LiquidationMetrics {
  detected: number       // total liquidation events received
  triggered: number      // times threshold was crossed
  traded: number         // orders placed
  skippedReasons: Record<string, number>
  recentMaxLongLiq: number   // max long liq volume in recent window (for tuning)
  recentMaxShortLiq: number  // max short liq volume in recent window (for tuning)
  heatmapChecks: number       // total heatmap checks
  heatmapTriggers: number     // times cascade risk exceeded threshold
  heatmapTrades: number       // predictive trades placed
}

// ==========================================
// STRATEGY
// ==========================================

export class LiquidationMomentumStrategy extends BaseStrategy {
  name = 'Liquidation Momentum'
  description = 'Trades Polymarket 5m BTC binaries based on Hyperliquid liquidation cascades'
  strategyType = 'mechanical' as const

  // Liquidation event buffer — rolling window
  private liqBuffer: LiquidationEvent[] = []

  // Subscriptions
  private liqUnsubscribe: (() => void) | null = null
  private connectionUnsubscribe: (() => void) | null = null

  // Cooldown
  private lastTradeTime = 0

  // Position tracking
  private activePositionMarkets = new Set<string>() // marketId:direction

  // Heatmap — predictive cascade detection (separate timer)
  private heatmapCheckInterval: ReturnType<typeof setInterval> | null = null
  private lastHeatmapTradeTime = 0

  // Market cache (refreshed every 30s)
  private cachedMarkets = new Map<string, CachedMarket>()
  private marketRefreshInterval: ReturnType<typeof setInterval> | null = null
  private realtimeServiceRef: {
    subscribeMarket: (ids: string[]) => void
    getPrice: (id: string) => { bid: number; ask: number; mid: number; spread: number; timestamp: Date } | undefined
  } | null = null
  private cleanupFns: Array<() => void> = []

  // Performance metrics
  private metrics: LiquidationMetrics = {
    detected: 0,
    triggered: 0,
    traded: 0,
    skippedReasons: {},
    recentMaxLongLiq: 0,
    recentMaxShortLiq: 0,
    heatmapChecks: 0,
    heatmapTriggers: 0,
    heatmapTrades: 0,
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async initialize(): Promise<void> {
    this.log('LiquidationMomentum initialized')
  }

  async start(): Promise<void> {
    if (!this._enabled) return
    if (this._status === 'running') return
    this.setStatus('running')

    // Connect to RealtimeService for CLOB prices
    try {
      const { realtimeService } = await import('@/services/realtime')
      await realtimeService.connect()
      this.realtimeServiceRef = realtimeService
    } catch (err) {
      this.log(`Failed to connect RealtimeService: ${err}`)
    }

    // Subscribe to HyperliquidWS for liquidation events
    try {
      const { hyperliquidWSService } = await import('@/services/realtime/HyperliquidWSService')
      await hyperliquidWSService.connect()
      this.liqUnsubscribe = hyperliquidWSService.onLiquidation((event) => {
        this.onLiquidation(event)
      })
      this.connectionUnsubscribe = hyperliquidWSService.onConnectionChange((status) => {
        if (status === 'disconnected') {
          this.liqBuffer = []
          this.log('HyperliquidWS disconnected — liquidation buffer cleared')
        }
      })
    } catch (err) {
      this.log(`Failed to subscribe HyperliquidWS: ${err}`)
    }

    // Pre-cache markets immediately, then every 30s
    await this.refreshMarketCache()
    this.marketRefreshInterval = setInterval(() => this.refreshMarketCache(), 30_000)

    // Start heatmap predictive check if enabled (uses Hyperliquid free API — no key needed)
    const heatmapSettings = useSettingsStore.getState()
    if (heatmapSettings.liqHeatmapEnabled) {
      try {
        const { liquidationHeatmapService } = await import('@/services/trading/LiquidationHeatmapService')
        await liquidationHeatmapService.start()
        // Check every 30s (aligned with heatmap poll interval)
        this.heatmapCheckInterval = setInterval(() => this.checkHeatmap(), 30_000)
        this.log('Heatmap predictive mode enabled — pre-positioning on cascade risk')
      } catch (err) {
        this.log(`Failed to start heatmap: ${err}`)
      }
    }

    // Start Moon Dev data services if enabled
    const moondevSettings = useSettingsStore.getState()
    if (moondevSettings.moondevApiKey) {
      try {
        if (moondevSettings.moondevMultiExchangeLiqEnabled) {
          const { moonDevLiquidationService } = await import('@/services/trading/MoonDevLiquidationService')
          await moonDevLiquidationService.start()
          this.log('Moon Dev multi-exchange liquidation aggregation enabled')
        }
        if (moondevSettings.moondevProximityEnabled) {
          const { moonDevPositionProximityService } = await import('@/services/trading/MoonDevPositionProximityService')
          await moonDevPositionProximityService.start()
          this.log('Moon Dev position proximity tracking enabled')
        }
        if (moondevSettings.moondevSentimentEnabled) {
          const { moonDevSentimentService } = await import('@/services/trading/MoonDevSentimentService')
          await moonDevSentimentService.start()
          this.log('Moon Dev HLP sentiment filter enabled')
        }
      } catch (err) {
        this.log(`Moon Dev service start error (non-blocking): ${err}`)
      }
    }

    this.log('LiquidationMomentum started — monitoring BTC liquidations on Hyperliquid')
    activityLogger.logSystem('Liquidation Momentum started')
  }

  async stop(): Promise<void> {
    this.setStatus('idle')

    // Unsubscribe HyperliquidWS
    if (this.liqUnsubscribe) {
      this.liqUnsubscribe()
      this.liqUnsubscribe = null
    }
    if (this.connectionUnsubscribe) {
      this.connectionUnsubscribe()
      this.connectionUnsubscribe = null
    }

    // Clear timers
    if (this.marketRefreshInterval) {
      clearInterval(this.marketRefreshInterval)
      this.marketRefreshInterval = null
    }
    if (this.heatmapCheckInterval) {
      clearInterval(this.heatmapCheckInterval)
      this.heatmapCheckInterval = null
    }

    // Stop heatmap service
    import('@/services/trading/LiquidationHeatmapService')
      .then(({ liquidationHeatmapService }) => liquidationHeatmapService.stop())
      .catch(() => {})

    // Stop Moon Dev services
    import('@/services/trading/MoonDevLiquidationService')
      .then(({ moonDevLiquidationService }) => moonDevLiquidationService.stop())
      .catch(() => {})
    import('@/services/trading/MoonDevPositionProximityService')
      .then(({ moonDevPositionProximityService }) => moonDevPositionProximityService.stop())
      .catch(() => {})
    import('@/services/trading/MoonDevSentimentService')
      .then(({ moonDevSentimentService }) => moonDevSentimentService.stop())
      .catch(() => {})

    // Clear state
    this.liqBuffer = []
    this.lastTradeTime = 0
    this.lastHeatmapTradeTime = 0
    this.cachedMarkets.clear()
    this.activePositionMarkets.clear()

    // Cleanup subscriptions
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
    this.realtimeServiceRef = null

    this.log('LiquidationMomentum stopped')
    activityLogger.logSystem('Liquidation Momentum stopped')
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  /** Get current performance metrics */
  getLiquidationMetrics(): LiquidationMetrics {
    return { ...this.metrics, skippedReasons: { ...this.metrics.skippedReasons } }
  }

  // ==========================================
  // SIGNAL DETECTION (runs on every liquidation event)
  // ==========================================

  /** Called on every Hyperliquid liquidation event */
  private async onLiquidation(event: LiquidationEvent): Promise<void> {
    if (this._status !== 'running') return

    this.metrics.detected++

    const settings = useSettingsStore.getState()

    // 1. Push to rolling buffer, trim to window
    this.liqBuffer.push(event)
    const cutoff = Date.now() - settings.liqWindowMs
    while (this.liqBuffer.length > 0 && this.liqBuffer[0].timestamp < cutoff) {
      this.liqBuffer.shift()
    }

    // 2. Sum liquidation volume by side within the window
    let longLiqVolume = 0
    let shortLiqVolume = 0
    for (const e of this.liqBuffer) {
      if (e.side === 'long') longLiqVolume += e.sizeUSD
      else shortLiqVolume += e.sizeUSD
    }

    // Track max volumes for tuning
    if (longLiqVolume > this.metrics.recentMaxLongLiq) this.metrics.recentMaxLongLiq = longLiqVolume
    if (shortLiqVolume > this.metrics.recentMaxShortLiq) this.metrics.recentMaxShortLiq = shortLiqVolume

    // 3. Check if either side crosses threshold
    const longTriggered = longLiqVolume >= settings.liqMinThresholdUSD && longLiqVolume <= settings.liqMaxThresholdUSD
    const shortTriggered = shortLiqVolume >= settings.liqMinThresholdUSD && shortLiqVolume <= settings.liqMaxThresholdUSD

    if (!longTriggered && !shortTriggered) return

    // 4. Determine direction
    // Long liquidations = downward momentum → buy NO (down)
    // Short liquidations = upward momentum → buy YES (up)
    // If both triggered, pick the side with more volume
    let direction: 'up' | 'down'
    let triggerVolume: number
    if (longTriggered && shortTriggered) {
      if (longLiqVolume >= shortLiqVolume) {
        direction = 'down'
        triggerVolume = longLiqVolume
      } else {
        direction = 'up'
        triggerVolume = shortLiqVolume
      }
    } else if (longTriggered) {
      direction = 'down'
      triggerVolume = longLiqVolume
    } else {
      direction = 'up'
      triggerVolume = shortLiqVolume
    }

    this.metrics.triggered++

    // 4b. Moon Dev multi-exchange liquidation confirmation + proximity boost
    // If Moon Dev services are running, check if cross-exchange data confirms the cascade
    let confidenceMultiplier = 1.0
    try {
      if (settings.moondevMultiExchangeLiqEnabled && settings.moondevApiKey) {
        const { moonDevLiquidationService } = await import('@/services/trading/MoonDevLiquidationService')
        if (moonDevLiquidationService.isRunning()) {
          const summary = moonDevLiquidationService.getLiquidationSummary()
          // If multi-exchange data agrees with our direction, boost confidence
          if (summary.dominantSide !== 'balanced') {
            const multiExAgrees =
              (direction === 'down' && summary.dominantSide === 'long') ||
              (direction === 'up' && summary.dominantSide === 'short')
            if (multiExAgrees) {
              confidenceMultiplier *= 1.15 // 15% boost when 4 exchanges agree
              this.log(`[MultiEx] Cross-exchange confirms ${direction} — cascade momentum ${summary.cascadeMomentum.toFixed(1)}x`)
            }
          }
        }
      }
      if (settings.moondevProximityEnabled && settings.moondevApiKey) {
        const { moonDevPositionProximityService } = await import('@/services/trading/MoonDevPositionProximityService')
        if (moonDevPositionProximityService.isRunning()) {
          const proxSignal = moonDevPositionProximityService.getProximitySignal()
          // More fuel near liquidation = bigger cascade expected
          if (proxSignal.asymmetry > 2.0) {
            confidenceMultiplier *= 1.10 // 10% boost when heavy fuel on one side
            this.log(`[Proximity] Fuel asymmetry ${proxSignal.asymmetry.toFixed(1)}x favoring ${proxSignal.dominantRisk} liquidations`)
          }
        }
      }
    } catch { /* non-blocking — Moon Dev services are optional */ }

    this.log(`Liquidation signal: ${direction.toUpperCase()} — $${triggerVolume.toFixed(0)} ${direction === 'down' ? 'long' : 'short'} liqs in ${(settings.liqWindowMs / 1000).toFixed(0)}s window (boost: ${confidenceMultiplier.toFixed(2)}x)`)
    this.emit('liquidationTriggered', { direction, volume: triggerVolume })

    // 5. Execute trade (async, fire-and-forget with error logging)
    this.executeTrade(direction, triggerVolume, confidenceMultiplier).catch((err) => {
      this.logError(`Trade execution error: ${err}`)
    })
  }

  // ==========================================
  // TRADE EXECUTION
  // ==========================================

  private async executeTrade(direction: 'up' | 'down', triggerVolume: number, _confidenceMultiplier = 1.0): Promise<void> {
    const settings = useSettingsStore.getState()

    // 1. Cooldown check
    const now = Date.now()
    if (now - this.lastTradeTime < settings.liqCooldownMs) {
      this.recordSkip('cooldown')
      this.emit('liquidationSkipped', { reason: 'cooldown', direction })
      return
    }

    // 2. RiskManager check
    try {
      const { riskManager } = await import('@/services/trading/RiskManager')
      if (riskManager.emergencyStopped) {
        this.recordSkip('emergency_stopped')
        this.emit('liquidationSkipped', { reason: 'emergency_stopped', direction })
        return
      }
    } catch { /* proceed if import fails */ }

    // 3. Find best market
    const cached = this.findBestMarket(settings.liqPreferredDuration)
    if (!cached) {
      this.log('No active BTC market found — skipping')
      this.recordSkip('no_market')
      this.emit('liquidationSkipped', { reason: 'no_market', direction })
      return
    }

    // 4. Determine outcome: UP → buy YES, DOWN → buy NO
    const outcome: 'yes' | 'no' = direction === 'up' ? 'yes' : 'no'
    const targetTokenId = direction === 'up' ? cached.yesTokenId : cached.noTokenId

    // 5. Position awareness
    const posKey = `${cached.market.id}:${direction}`
    if (this.activePositionMarkets.has(posKey)) {
      this.log(`Already have ${direction} position on ${cached.market.id} — skipping`)
      this.recordSkip('position_exists')
      this.emit('liquidationSkipped', { reason: 'position_exists', direction })
      return
    }

    // 6. Get live CLOB ask price
    if (!this.realtimeServiceRef) {
      this.recordSkip('no_realtime')
      this.emit('liquidationSkipped', { reason: 'no_realtime', direction })
      return
    }
    const priceData = this.realtimeServiceRef.getPrice(targetTokenId)
    if (!priceData || priceData.ask <= 0) {
      this.log('No CLOB price data — skipping')
      this.recordSkip('no_clob_price')
      this.emit('liquidationSkipped', { reason: 'no_clob_price', direction })
      return
    }

    const askPrice = priceData.ask

    // 7. Max ask price gate
    if (askPrice > settings.liqMaxAskPrice) {
      this.log(`Ask ${askPrice.toFixed(3)} > max ${settings.liqMaxAskPrice} — skipping`)
      this.recordSkip('ask_too_high')
      this.emit('liquidationSkipped', { reason: 'ask_too_high', askPrice, direction })
      return
    }

    // 8. EdgeTracker circuit breaker
    try {
      const { edgeTracker } = await import('@/services/trading/EdgeTracker')
      const edgeCheck = edgeTracker.shouldTrade('liquidation', 0) // 0 bps = maker
      if (!edgeCheck.allowed) {
        this.log(`EdgeTracker blocked: ${edgeCheck.reason}`)
        this.recordSkip('edge_tracker_blocked')
        this.emit('liquidationSkipped', { reason: 'edge_tracker_blocked', detail: edgeCheck.reason, direction })
        return
      }
    } catch { /* proceed if EdgeTracker unavailable */ }

    // 9. Place GTD maker order
    try {
      const { tradingService } = await import('@/services/trading')

      const result = await tradingService.placeBet(
        cached.market,
        outcome,
        settings.liqTradeSize,
        {
          orderType: 'GTD',
          strategy: 'liquidation',
          skipGtcFallback: true,
          gtdExpiryMs: settings.liqOrderExpiryMs,
          limitPrice: askPrice,
          stopLossPercent: settings.liqStopLossPct,
          takeProfitPercent: settings.liqTakeProfitPct,
          asset: 'BTC',
        },
      )

      if (result.success) {
        this.lastTradeTime = Date.now()
        this.activePositionMarkets.add(posKey)
        this._stats.totalTrades++
        this.metrics.traded++

        // Clear the buffer after a successful trade to avoid re-triggering on the same cascade
        this.liqBuffer = []

        activityLogger.logTrade(
          `Liq Momentum ${direction.toUpperCase()}: $${settings.liqTradeSize} on ${cached.durationKey} market at ask=${askPrice.toFixed(3)}, liq_vol=$${triggerVolume.toFixed(0)}`
        )
        this.emit('tradePlaced', {
          direction,
          askPrice,
          triggerVolume,
          market: cached.market,
          orderId: result.orderId,
          duration: cached.durationKey,
        })
        this.log(`TRADE PLACED: ${outcome.toUpperCase()} at ${askPrice.toFixed(3)} (${cached.durationKey}, liq=$${triggerVolume.toFixed(0)}, SL=${(settings.liqStopLossPct * 100).toFixed(0)}%/TP=${(settings.liqTakeProfitPct * 100).toFixed(0)}%)`)
      } else {
        this.log(`Order failed: ${result.error || 'unknown'}`)
        this.recordSkip('order_failed')
        this.emit('liquidationSkipped', { reason: 'order_failed', error: result.error, direction })
      }
    } catch (err) {
      this.logError(`Trade execution error: ${err}`)
    }
  }

  // ==========================================
  // MARKET DISCOVERY (pre-cached every 30s)
  // ==========================================

  /** Find the best available market, preferring the configured duration */
  private findBestMarket(preferred: '5m' | '15m'): CachedMarket | null {
    const key = `BTC:${preferred}`
    const pref = this.cachedMarkets.get(key)
    if (pref && pref.windowEndMs > Date.now() + 30_000) return pref

    // Fallback: try the other duration
    const fallback = preferred === '5m' ? '15m' : '5m'
    const fb = this.cachedMarkets.get(`BTC:${fallback}`)
    if (fb && fb.windowEndMs > Date.now() + 30_000) return fb

    return null
  }

  /** Refresh market cache for BTC 5m and 15m */
  private async refreshMarketCache(): Promise<void> {
    const durations = ['5m', '15m'] as const

    for (const duration of durations) {
      try {
        const markets = await this.discoverMarkets(duration)
        if (markets.length > 0) {
          const m = markets[0]
          const clobIds = m.clobTokenIds
          if (clobIds && clobIds.length >= 2) {
            this.cachedMarkets.set(`BTC:${duration}`, {
              market: m,
              yesTokenId: clobIds[0],
              noTokenId: clobIds[1],
              windowEndMs: m.endDateIso ? new Date(m.endDateIso).getTime() : Date.now() + 300_000,
              durationKey: duration,
            })
            // Subscribe to CLOB price feed
            if (this.realtimeServiceRef) {
              this.realtimeServiceRef.subscribeMarket(clobIds)
            }
          }
        }
      } catch (err) {
        this.log(`Market discovery failed for BTC:${duration}: ${err}`)
      }
    }

    // Evict expired markets
    for (const [key, cached] of this.cachedMarkets) {
      if (cached.windowEndMs < Date.now()) {
        this.cachedMarkets.delete(key)
        this.activePositionMarkets.delete(`${cached.market.id}:up`)
        this.activePositionMarkets.delete(`${cached.market.id}:down`)
      }
    }
  }

  /** Discover markets for BTC at a given duration */
  private async discoverMarkets(duration: '5m' | '15m'): Promise<Market[]> {
    const { polymarketClient } = await import('@/services/api/PolymarketClient')

    const prefix = ASSET_SLUG_PATTERNS['BTC']?.[duration]
    if (!prefix) return []

    const intervalSec = duration === '5m' ? 300 : 900
    const nowSec = Math.floor(Date.now() / 1000)
    const currentWindowStart = Math.floor(nowSec / intervalSec) * intervalSec
    const nextWindowStart = currentWindowStart + intervalSec
    const slugs = [`${prefix}${currentWindowStart}`, `${prefix}${nextWindowStart}`]

    return this.fetchMarketsBySlugs(slugs, polymarketClient)
  }

  /** Fetch markets from Gamma by slug, filter for active ones */
  private async fetchMarketsBySlugs(
    slugs: string[],
    polymarketClient: { getEventBySlug: (slug: string) => Promise<{ markets?: Market[] }> },
  ): Promise<Market[]> {
    const markets: Market[] = []
    for (const slug of slugs) {
      if (!slug) continue
      try {
        const event = await polymarketClient.getEventBySlug(slug)
        if (event?.markets) {
          for (const m of event.markets) {
            if (m.active && !m.closed && m.clobTokenIds?.length >= 2) {
              markets.push(m)
            }
          }
        }
      } catch { /* slug not found — normal for future windows */ }
    }
    return markets
  }

  // ==========================================
  // HEATMAP — PREDICTIVE CASCADE DETECTION
  // ==========================================

  /**
   * Check heatmap for high cascade risk and pre-position BEFORE liquidations happen.
   * Runs on a 30s timer, separate from the reactive WS path.
   */
  private async checkHeatmap(): Promise<void> {
    if (this._status !== 'running') return

    this.metrics.heatmapChecks++

    const settings = useSettingsStore.getState()
    if (!settings.liqHeatmapEnabled) return

    let cascadeRisk
    try {
      const { liquidationHeatmapService } = await import('@/services/trading/LiquidationHeatmapService')

      // Check both directions for BTC
      const downRisk = liquidationHeatmapService.getCascadeRisk('BTC', 'down')
      const upRisk = liquidationHeatmapService.getCascadeRisk('BTC', 'up')

      // Pick the higher risk
      if (downRisk && upRisk) {
        cascadeRisk = downRisk.score >= upRisk.score ? downRisk : upRisk
      } else {
        cascadeRisk = downRisk || upRisk
      }
    } catch {
      return // heatmap service unavailable
    }

    if (!cascadeRisk) return
    if (cascadeRisk.score < settings.liqHeatmapMinScore) return
    if (cascadeRisk.distancePct > settings.liqHeatmapMaxDistancePct) return

    this.metrics.heatmapTriggers++

    // Cooldown — reuse the same cooldown as reactive trades
    const now = Date.now()
    if (now - this.lastHeatmapTradeTime < settings.liqCooldownMs) {
      this.recordSkip('heatmap_cooldown')
      return
    }

    this.log(`HEATMAP CASCADE RISK: ${cascadeRisk.direction.toUpperCase()} score=${cascadeRisk.score.toFixed(2)}, fuel=$${(cascadeRisk.fuelUSD / 1000).toFixed(0)}K, trigger=${cascadeRisk.triggerPrice.toFixed(0)}, dist=${cascadeRisk.distancePct.toFixed(1)}%`)
    this.emit('heatmapTriggered', cascadeRisk)

    // Execute predictive trade using the same execution pipeline
    await this.executeHeatmapTrade(cascadeRisk.direction, cascadeRisk)
  }

  /** Execute a predictive pre-positioning trade based on heatmap cascade risk */
  private async executeHeatmapTrade(
    direction: 'up' | 'down',
    cascadeRisk: { score: number; fuelUSD: number; triggerPrice: number; distancePct: number },
  ): Promise<void> {
    const settings = useSettingsStore.getState()

    // RiskManager check
    try {
      const { riskManager } = await import('@/services/trading/RiskManager')
      if (riskManager.emergencyStopped) {
        this.recordSkip('heatmap_emergency_stopped')
        return
      }
    } catch { /* proceed */ }

    // Find best market
    const cached = this.findBestMarket(settings.liqPreferredDuration)
    if (!cached) {
      this.recordSkip('heatmap_no_market')
      return
    }

    const outcome: 'yes' | 'no' = direction === 'up' ? 'yes' : 'no'
    const targetTokenId = direction === 'up' ? cached.yesTokenId : cached.noTokenId

    // Position awareness
    const posKey = `${cached.market.id}:hm_${direction}`
    if (this.activePositionMarkets.has(posKey)) {
      this.recordSkip('heatmap_position_exists')
      return
    }

    // Get live CLOB ask price
    if (!this.realtimeServiceRef) {
      this.recordSkip('heatmap_no_realtime')
      return
    }
    const priceData = this.realtimeServiceRef.getPrice(targetTokenId)
    if (!priceData || priceData.ask <= 0) {
      this.recordSkip('heatmap_no_clob_price')
      return
    }

    const askPrice = priceData.ask
    if (askPrice > settings.liqMaxAskPrice) {
      this.recordSkip('heatmap_ask_too_high')
      return
    }

    // EdgeTracker check
    try {
      const { edgeTracker } = await import('@/services/trading/EdgeTracker')
      const edgeCheck = edgeTracker.shouldTrade('liquidation', 0)
      if (!edgeCheck.allowed) {
        this.recordSkip('heatmap_edge_blocked')
        return
      }
    } catch { /* proceed */ }

    // Place GTD maker order — use heatmap-specific trade size
    try {
      const { tradingService } = await import('@/services/trading')

      const result = await tradingService.placeBet(
        cached.market,
        outcome,
        settings.liqHeatmapTradeSize,
        {
          orderType: 'GTD',
          strategy: 'liquidation',
          skipGtcFallback: true,
          gtdExpiryMs: settings.liqOrderExpiryMs,
          limitPrice: askPrice,
          stopLossPercent: settings.liqStopLossPct,
          takeProfitPercent: settings.liqTakeProfitPct,
          asset: 'BTC',
        },
      )

      if (result.success) {
        this.lastHeatmapTradeTime = Date.now()
        this.activePositionMarkets.add(posKey)
        this._stats.totalTrades++
        this.metrics.heatmapTrades++

        activityLogger.logTrade(
          `Liq HEATMAP ${direction.toUpperCase()}: $${settings.liqHeatmapTradeSize} on ${cached.durationKey} at ask=${askPrice.toFixed(3)}, score=${cascadeRisk.score.toFixed(2)}, fuel=$${(cascadeRisk.fuelUSD / 1000).toFixed(0)}K, dist=${cascadeRisk.distancePct.toFixed(1)}%`
        )
        this.emit('heatmapTradePlaced', {
          direction,
          askPrice,
          cascadeRisk,
          market: cached.market,
          orderId: result.orderId,
          duration: cached.durationKey,
        })
        this.log(`HEATMAP TRADE: ${outcome.toUpperCase()} at ${askPrice.toFixed(3)} (${cached.durationKey}, score=${cascadeRisk.score.toFixed(2)}, fuel=$${(cascadeRisk.fuelUSD / 1000).toFixed(0)}K)`)
      } else {
        this.recordSkip('heatmap_order_failed')
      }
    } catch (err) {
      this.logError(`Heatmap trade error: ${err}`)
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================

  /** Record a skip reason in metrics */
  private recordSkip(reason: string): void {
    this.metrics.skippedReasons[reason] = (this.metrics.skippedReasons[reason] || 0) + 1
  }
}

// Export singleton
export const liquidationMomentumStrategy = new LiquidationMomentumStrategy()
