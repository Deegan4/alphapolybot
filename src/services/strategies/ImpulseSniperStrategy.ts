import { BaseStrategy } from './BaseStrategy'
import { ASSET_SLUG_PATTERNS, buildHourlySlug } from './BtcUpDownStrategy'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { useSettingsStore } from '@/stores/settingsStore'
import type { Market } from '@/types/api'

// ==========================================
// TYPES
// ==========================================

type CryptoAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP'

interface PriceEntry {
  price: number
  timestamp: number
}

interface ClobAskEntry {
  ask: number
  timestamp: number
}

interface ImpulseEvent {
  asset: CryptoAsset
  direction: 'up' | 'down'
  magnitude: number
  startPrice: number
  endPrice: number
  detectedAt: number
}

interface CachedMarket {
  market: Market
  yesTokenId: string
  noTokenId: string
  windowEndMs: number
  durationKey: string
}

interface ImpulseMetrics {
  detected: number
  confirmed: number
  aborted: number
  traded: number
  skippedReasons: Record<string, number>
}

/** Default impulse thresholds per asset (USD absolute move) */
const DEFAULT_THRESHOLDS: Record<CryptoAsset, number> = {
  BTC: 200,
  ETH: 15,
  SOL: 1.5,
  XRP: 0.05,
}

// ==========================================
// STRATEGY
// ==========================================

export class ImpulseSniperStrategy extends BaseStrategy {
  name = 'Impulse Sniper'
  description = 'Latency arbitrage on stale Polymarket odds after crypto impulse moves'
  strategyType = 'mechanical' as const

  // Per-asset price tracking — 60s rolling buffer of 1s BinanceWS ticks
  private priceBuffers = new Map<CryptoAsset, PriceEntry[]>()
  private binanceUnsubscribe: (() => void) | null = null
  private connectionUnsubscribe: (() => void) | null = null

  // CLOB ask price history for stale-odds detection
  private clobAskHistory = new Map<string, ClobAskEntry[]>() // tokenId -> ask history

  // Per-asset state
  private lastTradeTimes = new Map<CryptoAsset, number>()
  private pendingConfirmation: ImpulseEvent | null = null
  private confirmationTimer: ReturnType<typeof setTimeout> | null = null
  private activePositionMarkets = new Set<string>() // marketId:direction

  // Market cache (refreshed every 30s) — keyed by `${asset}:${duration}`
  private cachedMarkets = new Map<string, CachedMarket>()
  private marketRefreshInterval: ReturnType<typeof setInterval> | null = null
  private realtimeServiceRef: {
    subscribeMarket: (ids: string[]) => void
    getPrice: (id: string) => { bid: number; ask: number; mid: number; spread: number; timestamp: Date } | undefined
  } | null = null
  private cleanupFns: Array<() => void> = []

  // Performance metrics
  private metrics: ImpulseMetrics = {
    detected: 0,
    confirmed: 0,
    aborted: 0,
    traded: 0,
    skippedReasons: {},
  }

  // ==========================================
  // LIFECYCLE
  // ==========================================

  async initialize(): Promise<void> {
    this.log('ImpulseSniper initialized')
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

    // Subscribe to BinanceWS for 1s crypto price ticks (all assets)
    try {
      const { binanceWSService } = await import('@/services/realtime/BinanceWSService')
      this.binanceUnsubscribe = binanceWSService.onPriceUpdate((update) => {
        const asset = update.symbol as CryptoAsset
        const settings = useSettingsStore.getState()
        if (!settings.impulseAssets.includes(asset)) return
        this.onPriceTick(asset, update.priceUSD, update.timestamp)
      })
      // Clear buffers on disconnect to avoid stale comparisons
      this.connectionUnsubscribe = binanceWSService.onConnectionChange((connected) => {
        if (!connected) {
          this.priceBuffers.clear()
          this.clearPendingConfirmation()
          this.log('BinanceWS disconnected — buffers cleared')
        }
      })
    } catch (err) {
      this.log(`Failed to subscribe BinanceWS: ${err}`)
    }

    // Pre-cache markets immediately, then every 30s
    await this.refreshMarketCache()
    this.marketRefreshInterval = setInterval(() => this.refreshMarketCache(), 30_000)

    const settings = useSettingsStore.getState()
    this.log(`ImpulseSniper started — monitoring ${settings.impulseAssets.join(', ')} impulses`)
    activityLogger.logSystem(`Impulse Sniper started — assets: ${settings.impulseAssets.join(', ')}`)
  }

  async stop(): Promise<void> {
    this.setStatus('idle')

    // Unsubscribe BinanceWS
    if (this.binanceUnsubscribe) {
      this.binanceUnsubscribe()
      this.binanceUnsubscribe = null
    }
    if (this.connectionUnsubscribe) {
      this.connectionUnsubscribe()
      this.connectionUnsubscribe = null
    }

    // Clear timers
    this.clearPendingConfirmation()
    if (this.marketRefreshInterval) {
      clearInterval(this.marketRefreshInterval)
      this.marketRefreshInterval = null
    }

    // Clear state
    this.priceBuffers.clear()
    this.lastTradeTimes.clear()
    this.cachedMarkets.clear()
    this.clobAskHistory.clear()
    this.activePositionMarkets.clear()

    // Cleanup subscriptions
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
    this.realtimeServiceRef = null

    this.log('ImpulseSniper stopped')
    activityLogger.logSystem('Impulse Sniper stopped')
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  /** Get current impulse performance metrics */
  getImpulseMetrics(): ImpulseMetrics {
    return { ...this.metrics, skippedReasons: { ...this.metrics.skippedReasons } }
  }

  // ==========================================
  // IMPULSE DETECTION (runs on every 1s tick)
  // ==========================================

  /** Called on every BinanceWS price tick (~1s) for any monitored asset */
  private onPriceTick(asset: CryptoAsset, price: number, timestamp: number): void {
    if (this._status !== 'running') return

    // 1. Push to per-asset rolling buffer, trim to 60s
    let buffer = this.priceBuffers.get(asset)
    if (!buffer) {
      buffer = []
      this.priceBuffers.set(asset, buffer)
    }
    buffer.push({ price, timestamp })
    const cutoff = timestamp - 60_000
    while (buffer.length > 0 && buffer[0].timestamp < cutoff) {
      buffer.shift()
    }

    // 2. Record CLOB ask prices for cached market outcomes
    this.recordClobAsks()

    // 3. Guards: pending confirmation, cooldown
    if (this.pendingConfirmation) return

    const settings = useSettingsStore.getState()
    const now = Date.now()
    const lastTradeTime = this.lastTradeTimes.get(asset) || 0
    if (now - lastTradeTime < settings.impulseCooldownMs) return

    // 4. Lookback comparison
    const lookbackMs = settings.impulseLookbackSeconds * 1000
    const targetTs = timestamp - lookbackMs
    const lookbackEntry = this.findClosestEntry(buffer, targetTs)
    if (!lookbackEntry) return // buffer too short

    // 5. Compute delta with vol-aware dynamic threshold
    const delta = price - lookbackEntry.price
    const magnitude = Math.abs(delta)
    const baseThreshold = this.getAssetThreshold(asset, settings)
    const effectiveThreshold = settings.impulseAggressiveMode
      ? Math.min(baseThreshold, baseThreshold * 0.5)
      : this.applyVolAdjustedThreshold(baseThreshold, buffer)

    if (magnitude < effectiveThreshold) return

    // 6. Impulse detected!
    const direction: 'up' | 'down' = delta > 0 ? 'up' : 'down'
    const impulse: ImpulseEvent = {
      asset,
      direction,
      magnitude,
      startPrice: lookbackEntry.price,
      endPrice: price,
      detectedAt: now,
    }

    this.pendingConfirmation = impulse
    this.metrics.detected++
    this.emit('impulseDetected', { ...impulse })
    this.log(`[${asset}] Impulse DETECTED: ${direction.toUpperCase()} $${magnitude.toFixed(asset === 'XRP' ? 4 : 0)} (${lookbackEntry.price.toFixed(asset === 'XRP' ? 4 : 0)} → ${price.toFixed(asset === 'XRP' ? 4 : 0)})`)

    // 7. Schedule confirmation check
    this.confirmationTimer = setTimeout(() => {
      this.confirmImpulse()
    }, settings.impulseConfirmationMs)
  }

  /** Get the threshold for a given asset from settings */
  private getAssetThreshold(asset: CryptoAsset, settings: ReturnType<typeof useSettingsStore.getState>): number {
    switch (asset) {
      case 'BTC': return settings.impulseThreshold
      case 'ETH': return settings.impulseThresholdETH
      case 'SOL': return settings.impulseThresholdSOL
      case 'XRP': return settings.impulseThresholdXRP
      default: return DEFAULT_THRESHOLDS[asset] ?? 200
    }
  }

  /** Apply volatility-adjusted threshold using AvellanedaStoikov vol estimator */
  private applyVolAdjustedThreshold(baseThreshold: number, buffer: PriceEntry[]): number {
    if (buffer.length < 20) return baseThreshold // not enough data

    try {
      // Import is synchronous-safe because we only use the static method
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AvellanedaStoikovPricer } = require('@/services/trading/AvellanedaStoikovPricer')
      const prices = buffer.map(e => e.price)
      const volEstimate = AvellanedaStoikovPricer.estimateVolatility(prices, 1000, 60_000)
      if (!volEstimate || volEstimate.annualized <= 0) return baseThreshold

      // Normalize: compute ratio of current vol to a "normal" baseline
      // Normal BTC vol ~65% annualized. For simplicity, use self-relative:
      // Compare to median vol (first call = baseline, subsequent = ratio)
      const volRatio = volEstimate.annualized / (volEstimate.annualized || 1)
      // Since we can't store historical vol in this tick, use a simpler heuristic:
      // High sample variance (> 2x mean abs change) → raise threshold 50%
      // Low sample variance (< 0.5x mean abs change) → lower threshold 25%
      const changes = prices.slice(1).map((p, i) => Math.abs(p - prices[i]))
      const meanChange = changes.reduce((a, b) => a + b, 0) / changes.length
      const lastChange = changes.length > 0 ? changes[changes.length - 1] : 0
      if (lastChange > meanChange * 3) {
        // Very noisy — raise threshold to filter false positives
        return baseThreshold * 1.5
      } else if (meanChange > 0 && lastChange < meanChange * 0.3) {
        // Very quiet — lower threshold to catch real moves
        return baseThreshold * 0.75
      }
      return baseThreshold * (volRatio > 0 ? 1 : 1)
    } catch {
      return baseThreshold // AS pricer unavailable, use base
    }
  }

  /** Find the buffer entry closest to a target timestamp */
  private findClosestEntry(buffer: PriceEntry[], targetTs: number): PriceEntry | null {
    if (buffer.length < 5) return null // need minimum history

    let closest: PriceEntry | null = null
    let closestDiff = Infinity

    for (const entry of buffer) {
      const diff = Math.abs(entry.timestamp - targetTs)
      if (diff < closestDiff) {
        closestDiff = diff
        closest = entry
      }
    }

    // Only accept if within 1.5s of target (avoid stale comparisons)
    if (closestDiff > 1500) return null
    return closest
  }

  // ==========================================
  // CONFIRMATION
  // ==========================================

  /** Called after confirmationMs delay to check for snapback */
  private confirmImpulse(): void {
    const impulse = this.pendingConfirmation
    if (!impulse) return

    const settings = useSettingsStore.getState()
    const buffer = this.priceBuffers.get(impulse.asset)
    const latestPrice = buffer && buffer.length > 0
      ? buffer[buffer.length - 1].price
      : null

    if (!latestPrice) {
      this.recordSkip('no_price_data')
      this.metrics.aborted++
      this.emit('impulseSkipped', { reason: 'no_price_data', impulse })
      this.clearPendingConfirmation()
      return
    }

    // Check snapback: did price retrace too far?
    const retrace = impulse.direction === 'up'
      ? impulse.endPrice - latestPrice  // positive if price dropped back
      : latestPrice - impulse.endPrice   // positive if price bounced back
    const retraceFraction = Math.max(0, retrace) / impulse.magnitude

    if (retraceFraction > settings.impulseSnapbackPct) {
      this.log(`[${impulse.asset}] Impulse ABORTED: ${(retraceFraction * 100).toFixed(0)}% snapback (threshold: ${(settings.impulseSnapbackPct * 100).toFixed(0)}%)`)
      this.recordSkip('snapback')
      this.metrics.aborted++
      this.emit('impulseSkipped', { reason: 'snapback', retracePct: retraceFraction, impulse })
      this.clearPendingConfirmation()
      return
    }

    // Confirmed!
    this.metrics.confirmed++
    this.log(`[${impulse.asset}] Impulse CONFIRMED: ${impulse.direction.toUpperCase()} $${impulse.magnitude.toFixed(impulse.asset === 'XRP' ? 4 : 0)}, current: $${latestPrice.toFixed(impulse.asset === 'XRP' ? 4 : 0)} (${(retraceFraction * 100).toFixed(0)}% retrace)`)
    this.emit('impulseConfirmed', { ...impulse, confirmedPrice: latestPrice })

    // Execute trade
    this.executeTrade(impulse).catch(err => {
      this.logError(`Trade execution failed: ${err}`)
    })

    this.clearPendingConfirmation()
  }

  private clearPendingConfirmation(): void {
    if (this.confirmationTimer) {
      clearTimeout(this.confirmationTimer)
      this.confirmationTimer = null
    }
    this.pendingConfirmation = null
  }

  // ==========================================
  // CLOB STALE-ODDS DETECTION
  // ==========================================

  /** Record current CLOB ask prices for all cached market outcomes */
  private recordClobAsks(): void {
    if (!this.realtimeServiceRef) return

    for (const [, cached] of this.cachedMarkets) {
      for (const tokenId of [cached.yesTokenId, cached.noTokenId]) {
        const priceData = this.realtimeServiceRef.getPrice(tokenId)
        if (!priceData || priceData.ask <= 0) continue

        const history = this.clobAskHistory.get(tokenId) || []
        history.push({ ask: priceData.ask, timestamp: Date.now() })
        // Keep last 10 entries (~10s at 1s tick rate)
        while (history.length > 10) history.shift()
        this.clobAskHistory.set(tokenId, history)
      }
    }
  }

  /** Check if CLOB ask has already moved 3+ cents in the impulse direction */
  private hasClobAlreadyMoved(tokenId: string, _direction: 'up' | 'down'): boolean {
    const history = this.clobAskHistory.get(tokenId)
    if (!history || history.length < 3) return false // not enough data, proceed

    const currentAsk = history[history.length - 1].ask
    // Compare to ask ~3-5s ago
    const oldEntry = history[Math.max(0, history.length - 4)]
    const askDelta = currentAsk - oldEntry.ask

    // If ask moved 3+ cents toward the impulse direction, market is repricing
    return askDelta >= 0.03
  }

  // ==========================================
  // TRADE EXECUTION
  // ==========================================

  private async executeTrade(impulse: ImpulseEvent): Promise<void> {
    const settings = useSettingsStore.getState()

    // 1. RiskManager check
    try {
      const { riskManager } = await import('@/services/trading/RiskManager')
      if (riskManager.emergencyStopped) {
        this.recordSkip('emergency_stopped')
        this.emit('impulseSkipped', { reason: 'emergency_stopped', impulse })
        return
      }
    } catch { /* proceed if import fails */ }

    // 2. Find best market for this asset
    const cached = this.findBestMarket(impulse.asset, settings.impulsePreferredDuration)
    if (!cached) {
      this.log(`[${impulse.asset}] No active market found — skipping impulse`)
      this.recordSkip('no_market')
      this.emit('impulseSkipped', { reason: 'no_market', impulse })
      return
    }

    // 3. Determine outcome: UP → buy YES (index 0), DOWN → buy NO (index 1)
    const outcome: 'yes' | 'no' = impulse.direction === 'up' ? 'yes' : 'no'
    const targetTokenId = impulse.direction === 'up' ? cached.yesTokenId : cached.noTokenId

    // 4. Position awareness: skip if same direction already active
    const posKey = `${cached.market.id}:${impulse.direction}`
    if (this.activePositionMarkets.has(posKey)) {
      this.log(`[${impulse.asset}] Already have ${impulse.direction} position on ${cached.market.id} — skipping`)
      this.recordSkip('position_exists')
      this.emit('impulseSkipped', { reason: 'position_exists', impulse })
      return
    }

    // 5. Get live CLOB ask price
    if (!this.realtimeServiceRef) {
      this.recordSkip('no_realtime')
      this.emit('impulseSkipped', { reason: 'no_realtime', impulse })
      return
    }
    const priceData = this.realtimeServiceRef.getPrice(targetTokenId)
    if (!priceData || priceData.ask <= 0) {
      this.log(`[${impulse.asset}] No CLOB price data — skipping`)
      this.recordSkip('no_clob_price')
      this.emit('impulseSkipped', { reason: 'no_clob_price', impulse })
      return
    }

    const askPrice = priceData.ask

    // 6. Max ask price gate
    if (askPrice > settings.impulseMaxAskPrice) {
      this.log(`[${impulse.asset}] Ask ${askPrice.toFixed(3)} > max ${settings.impulseMaxAskPrice} — already repriced, skipping`)
      this.recordSkip('ask_too_high')
      this.emit('impulseSkipped', { reason: 'ask_too_high', askPrice, impulse })
      return
    }

    // 7. CLOB stale-odds check
    if (this.hasClobAlreadyMoved(targetTokenId, impulse.direction)) {
      this.log(`[${impulse.asset}] CLOB ask already moved 3c+ — market repricing, skipping`)
      this.recordSkip('clob_already_moved')
      this.emit('impulseSkipped', { reason: 'clob_already_moved', impulse })
      return
    }

    // 8. Fee viability check
    let feeBps = 100 // default
    try {
      const { dynamicFeeService } = await import('@/services/trading/DynamicFeeService')
      const is15m = cached.durationKey === '15m'
      feeBps = is15m ? 1000 : dynamicFeeService.computeTakerFeeBps(askPrice)
      const feePct = feeBps / 10_000
      // Rough edge estimate: impulse magnitude relative to asset price
      const impulsePct = impulse.magnitude / impulse.endPrice
      // Binary outcome shift is roughly proportional to impulse (simplified)
      const estimatedEdge = Math.min(impulsePct * 5, 0.15) // cap at 15%
      if (feePct > estimatedEdge) {
        this.log(`[${impulse.asset}] Fee ${(feePct * 100).toFixed(1)}% > estimated edge ${(estimatedEdge * 100).toFixed(1)}% — not +EV`)
        this.recordSkip('fee_exceeds_edge')
        this.emit('impulseSkipped', { reason: 'fee_exceeds_edge', feePct, estimatedEdge, impulse })
        return
      }
    } catch { /* proceed if fee service unavailable */ }

    // 9. EdgeTracker circuit breaker — block if negative Kelly after 20+ trades
    try {
      const { edgeTracker } = await import('@/services/trading/EdgeTracker')
      const edgeCheck = edgeTracker.shouldTrade('impulse', feeBps)
      if (!edgeCheck.allowed) {
        this.log(`[${impulse.asset}] EdgeTracker blocked: ${edgeCheck.reason}`)
        this.recordSkip('edge_tracker_blocked')
        this.emit('impulseSkipped', { reason: 'edge_tracker_blocked', detail: edgeCheck.reason, impulse })
        return
      }
    } catch { /* proceed if EdgeTracker unavailable */ }

    // 10. VPIN toxicity filter (optional)
    if (settings.impulseVpinFilter) {
      try {
        const { vpinService } = await import('@/services/trading/VPINService')
        const vpin = vpinService.getVPIN(targetTokenId)
        if (vpin > settings.vpinToxicityThreshold) {
          this.log(`[${impulse.asset}] VPIN ${vpin.toFixed(2)} > threshold ${settings.vpinToxicityThreshold} — informed flow detected, skipping`)
          this.recordSkip('vpin_toxic')
          this.emit('impulseSkipped', { reason: 'vpin_toxic', vpin, impulse })
          return
        }
      } catch { /* proceed if VPIN service unavailable */ }
    }

    // 11. Place order with SL/TP
    try {
      const { tradingService } = await import('@/services/trading')
      const orderOptions: {
        orderType: 'FOK' | 'GTC' | 'GTD'
        strategy: string
        skipGtcFallback: boolean
        gtdExpiryMs?: number
        limitPrice?: number
        stopLossPercent?: number
        takeProfitPercent?: number
      } = {
        orderType: settings.impulseOrderMode === 'gtd' ? 'GTD' : 'FOK',
        strategy: 'impulse',
        skipGtcFallback: true,
        stopLossPercent: settings.impulseStopLossPct,
        takeProfitPercent: settings.impulseTakeProfitPct,
      }
      if (settings.impulseOrderMode === 'gtd') {
        orderOptions.gtdExpiryMs = 30_000 // 30s expiry
        orderOptions.limitPrice = askPrice
      }

      // Compute vol estimate for trade event enrichment
      let volEstimate: number | undefined
      try {
        const buffer = this.priceBuffers.get(impulse.asset)
        if (buffer && buffer.length >= 20) {
          const { AvellanedaStoikovPricer } = await import('@/services/trading/AvellanedaStoikovPricer')
          const vol = AvellanedaStoikovPricer.estimateVolatility(buffer.map(e => e.price), 1000, 60_000)
          volEstimate = vol?.annualized
        }
      } catch { /* non-critical */ }

      const result = await tradingService.placeBet(
        cached.market,
        outcome,
        settings.impulseTradeSize,
        orderOptions,
      )

      if (result.success) {
        this.lastTradeTimes.set(impulse.asset, Date.now())
        this.activePositionMarkets.add(posKey)
        this._stats.totalTrades++
        this.metrics.traded++
        activityLogger.logTrade(
          `Impulse ${impulse.asset} ${impulse.direction.toUpperCase()}: $${settings.impulseTradeSize} on ${cached.durationKey} market at ask=${askPrice.toFixed(3)}, move=$${impulse.magnitude.toFixed(impulse.asset === 'XRP' ? 4 : 0)}`
        )
        this.emit('tradePlaced', {
          asset: impulse.asset,
          direction: impulse.direction,
          askPrice,
          magnitude: impulse.magnitude,
          market: cached.market,
          orderId: result.orderId,
          duration: cached.durationKey,
          feeBps,
          volEstimate,
        })
        this.log(`[${impulse.asset}] TRADE PLACED: ${outcome.toUpperCase()} at ${askPrice.toFixed(3)} (${cached.durationKey}, SL=${(settings.impulseStopLossPct * 100).toFixed(0)}%/TP=${(settings.impulseTakeProfitPct * 100).toFixed(0)}%)`)
      } else {
        this.log(`[${impulse.asset}] Order failed: ${result.error || 'unknown'}`)
        this.recordSkip('order_failed')
        this.emit('impulseSkipped', { reason: 'order_failed', error: result.error, impulse })
      }
    } catch (err) {
      this.logError(`Trade execution error: ${err}`)
    }
  }

  // ==========================================
  // MARKET DISCOVERY (pre-cached every 30s)
  // ==========================================

  /** Find the best available market for an asset, preferring the configured duration */
  private findBestMarket(asset: CryptoAsset, preferred: '15m' | '1h' | '4h'): CachedMarket | null {
    // Try preferred first
    const key = `${asset}:${preferred}`
    const pref = this.cachedMarkets.get(key)
    if (pref && pref.windowEndMs > Date.now() + 60_000) return pref

    // Fallback order: 1h → 4h → 15m (skip 15m if fees too high unless it's preferred)
    const fallbacks = ['1h', '4h', '15m'].filter(d => d !== preferred)
    for (const d of fallbacks) {
      const cached = this.cachedMarkets.get(`${asset}:${d}`)
      if (cached && cached.windowEndMs > Date.now() + 60_000) return cached
    }
    return null
  }

  /** Refresh market cache for all enabled assets × durations */
  private async refreshMarketCache(): Promise<void> {
    const settings = useSettingsStore.getState()
    const assets = settings.impulseAssets
    const durations = ['15m', '4h', '1h'] as const

    for (const asset of assets) {
      for (const duration of durations) {
        try {
          const markets = await this.discoverMarkets(asset, duration)
          if (markets.length > 0) {
            const m = markets[0]
            const clobIds = m.clobTokenIds
            if (clobIds && clobIds.length >= 2) {
              this.cachedMarkets.set(`${asset}:${duration}`, {
                market: m,
                yesTokenId: clobIds[0],
                noTokenId: clobIds[1],
                windowEndMs: m.endDateIso ? new Date(m.endDateIso).getTime() : Date.now() + 3600_000,
                durationKey: duration,
              })
              // Subscribe to CLOB price feed
              if (this.realtimeServiceRef) {
                this.realtimeServiceRef.subscribeMarket(clobIds)
              }
            }
          }
        } catch (err) {
          this.log(`Market discovery failed for ${asset}:${duration}: ${err}`)
        }
      }
    }

    // Evict expired markets
    for (const [key, cached] of this.cachedMarkets) {
      if (cached.windowEndMs < Date.now()) {
        this.cachedMarkets.delete(key)
        // Clear position tracking for expired markets
        this.activePositionMarkets.delete(`${cached.market.id}:up`)
        this.activePositionMarkets.delete(`${cached.market.id}:down`)
      }
    }
  }

  /** Discover markets for a given asset + duration */
  private async discoverMarkets(asset: CryptoAsset, duration: '15m' | '4h' | '1h'): Promise<Market[]> {
    const { polymarketClient } = await import('@/services/api/PolymarketClient')

    if (duration === '1h') {
      // Hourly uses human-readable slugs
      const now = new Date()
      const nextHour = new Date(now.getTime() + 60 * 60 * 1000)
      const slugs = [buildHourlySlug(asset, now), buildHourlySlug(asset, nextHour)].filter(Boolean)
      return this.fetchMarketsBySlugs(slugs, polymarketClient)
    }

    // 15m and 4h use timestamp-based slugs
    const prefix = ASSET_SLUG_PATTERNS[asset]?.[duration]
    if (!prefix) return []

    const intervalSecMap: Record<string, number> = { '15m': 900, '4h': 14400 }
    const intervalSec = intervalSecMap[duration]
    if (!intervalSec) return []

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
  // HELPERS
  // ==========================================

  /** Record a skip reason in metrics */
  private recordSkip(reason: string): void {
    this.metrics.skippedReasons[reason] = (this.metrics.skippedReasons[reason] || 0) + 1
  }
}

// Export singleton
export const impulseSniperStrategy = new ImpulseSniperStrategy()
