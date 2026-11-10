import { BaseStrategy } from './BaseStrategy'
import type { BtcUpDownConfig, Market } from '@/types'
import { polymarketUSClient, normalizeEventToMarkets, priceForOutcome, upDownEventSlugs, type UpDownHorizon } from '@/services/api'
import { priceOracleService } from '@/services/api/PriceOracleService'
import { tradingService } from '@/services/trading/TradingService'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { tradeLogger } from '@/services/trading/TradeLogger'
import { KellySizer } from '@/services/trading/KellySizer'
import { edgeTracker } from '@/services/trading/EdgeTracker'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'
import { rejectionTracker } from '@/services/trading/RejectionTracker'
import { btcSignalRecorder } from '@/services/trading/BtcSignalRecorder'
import {
  computeSignal as _computeSignal,
  classifyRegime as _classifyRegime,
} from './btcupdown/signalEngine'

// Re-export types from signalEngine for backward compatibility
export type { SignalInput, Signal } from './btcupdown/signalEngine'
import type { SignalInput, Signal } from './btcupdown/signalEngine'

// ==========================================
// DEFAULTS
// ==========================================

const DEFAULT_CONFIG: BtcUpDownConfig = {
  enableBtc: true,
  enableEth: false,
  enableSol: false,
  enableXrp: false,
  enable5m: false,   // 5m markets disabled — lower edge, higher fees, less liquidity
  enable15m: true,
  enableHourly: false,
  enableDaily: false,
  enable9pm: false,
  tradeSize: 2.0,
  useKellySizing: true,
  minConfidence: 0.55, // Higher confidence — selectivity over volume on small bankroll
  maxEntryPrice: 0.45,        // Only buy cheap outcomes where binary math works
  minEntryPrice: 0.10,        // Low floor — only reject extreme long-shots
  minWindowRemaining: 120,     // 2 min before resolution for 15m
  minTimeIntoWindowMs: 45_000, // Need 45s of data before trading
  regimeFilterEnabled: true,   // Skip choppy/mean-reverting markets
  rsiFilterEnabled: true,      // Reduce confidence on overbought/oversold
  scanIntervalMs: 15_000,
  maxConcurrentPositions: 4,   // Conservative — $16 bankroll, ~$2/trade = 4 max active
  maxEntriesPerMarket: 1,      // One shot per window — preserve capital
  cooldownMs: 15_000,          // 15s cooldown — be selective, not rapid-fire
  stopLossPercent: 0.95,       // Effectively disabled — hold to resolution
  takeProfitPercent: 0.95,     // Effectively disabled — hold to resolution
  maxHoldMs: 16 * 60 * 1000,  // 16min > 15m window — position resolves on-chain, never sold
  useLLMConfirmation: false,   // LLM confirmation gate on hourly+ windows (opt-in)
}

/** Baseline window duration — all time-based config params are calibrated for this */
const BASELINE_WINDOW_MS = 15 * 60 * 1000

/** Supported window durations in ms */
export const WINDOW_DURATIONS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  'hourly': 60 * 60 * 1000,
  'daily': 24 * 60 * 60 * 1000,
  '9pm': 24 * 60 * 60 * 1000,  // Daily event — actual duration derived from market endDate
} as const

export type WindowDuration = keyof typeof WINDOW_DURATIONS

/**
 * Polymarket US Up/Down event slug horizon per window duration.
 * Slugs are `{asset}-updown-{horizon}-{YYYY-MM-DD-HHMM}z` (window start, UTC);
 * daily windows start at 5pm New York time. There is no 9PM series on
 * Polymarket US — `9pm` discovers nothing.
 */
export const UPDOWN_HORIZONS: Partial<Record<WindowDuration, UpDownHorizon>> = {
  '5m': '5m',
  '15m': '15m',
  'hourly': '1h',
  'daily': '1d',
}

/**
 * Whether Up/Down discovery should run for one asset+duration. It runs when
 * no tracked market lasts beyond the pre-fetch lead, so the next window is
 * fetched shortly before the current one ends. The lead is 20% of the window
 * (30s–90s) plus a 5s stagger per asset, which spreads the lookups instead of
 * every asset hitting the gateway in the same second after rollover.
 */
export function needsUpDownDiscovery(
  trackedWindowEndsMs: number[],
  nowMs: number,
  windowDurationMs: number,
  assetIndex = 0,
): boolean {
  const leadMs = Math.min(90_000, Math.max(30_000, windowDurationMs * 0.2)) + Math.max(0, assetIndex) * 5_000
  return !trackedWindowEndsMs.some(end => end > nowMs + leadMs)
}

/** Current + next window event slugs for an asset/duration ([] if unsupported) */
export function upDownSlugsFor(asset: string, duration: WindowDuration, now: Date = new Date()): string[] {
  const horizon = UPDOWN_HORIZONS[duration]
  return horizon ? upDownEventSlugs(asset, horizon, now) : []
}

// ==========================================
// STRATEGY
// ==========================================

/**
 * Parse the reference ("price to beat") from the market question text.
 * Market questions contain the exact reference price, e.g.:
 *   "Will the price of BTC be up or down from $97,432.52 between..."
 *   "Will the price of Bitcoin be higher or lower than $98,150.00 at..."
 *
 * Returns null if no price found (caller falls back to oracle).
 */
export function parseReferencePrice(question: string): number | null {
  // Match $-prefixed numbers with optional commas and decimals
  const match = question.match(/\$([0-9,]+\.?\d*)/)
  if (!match) return null
  const cleaned = match[1].replace(/,/g, '')
  const parsed = parseFloat(cleaned)
  return isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * BTC Up/Down Strategy
 *
 * Trades 5-minute and 15-minute binary markets where the outcome is "Up" if
 * the asset's price finishes >= the window-start price, "Down" otherwise.
 *
 * Key design: Resolution-hold strategy. Buy cheap outcomes (<45c) and hold
 * to binary resolution. With 10% crypto taker fee, intermediate exits destroy
 * edge — the payout asymmetry at resolution ($0.90 payout on $0.35 entry)
 * compensates for fees.
 *
 * Signal: Vol-normalized momentum + regime detection + RSI filter.
 * Data: 1-second BinanceWS price buffer (300 entries) replaces sparse 15s oracle reads.
 * Reference price parsed from market question text (not oracle capture).
 */
export class BtcUpDownStrategy extends BaseStrategy {
  name = 'BTC Up/Down'
  description = '15m & 9PM binary markets on crypto price direction'
  strategyType = 'mechanical' as const

  private btcConfig: BtcUpDownConfig = DEFAULT_CONFIG
  private scanTimeout: number | null = null

  // Market tracking
  private activeMarkets = new Map<string, {
    market: Market
    windowOpenPrice: number
    asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'
    windowEndMs: number
    windowDurationMs: number  // 900_000 (15m) or longer for 9PM events
    durationKey: string       // '5m' | '15m' | 'hourly' | 'daily' | '9pm'
  }>()
  private positionsByWindow = new Map<string, number>()
  private lastTradeTimes = new Map<string, number>()
  /** Sparse oracle-based history (legacy, kept for fallback) */
  private priceHistory = new Map<string, Array<{ price: number; timestamp: number }>>()
  /** High-frequency 1s price buffer from BinanceWS — 300 entries per asset (~5 min) */
  private highFreqPrices = new Map<string, Array<{ price: number; timestamp: number }>>()
  /** Unsubscribe function for BinanceWS price updates */
  private binanceUnsubscribe: (() => void) | null = null
  /** Cached reference price from market question — keyed by "{asset}:{windowStartMs}" */
  private windowOpenPriceCache = new Map<string, number>()
  /** Last computed signal per asset — exposed for dashboard display */
  private _lastSignals = new Map<string, { signal: Signal; windowOpenPrice: number; currentPrice: number }>()
  /** Cached RealtimeService reference (set in start(), null if unavailable) */
  private realtimeServiceRef: any | null = null
  /** Map clobTokenId → { asset, outcomeIndex } for reverse-lookup on live price reads */
  private slugToOutcomeMap = new Map<string, { asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'; outcomeIndex: number }>()
  // Maps marketId → [outcomeSlug0, outcomeSlug1] for WS subscription and live price lookups
  private marketOutcomeSlugs = new Map<string, string[]>()
  private unsupportedDurationLogged = new Set<string>()
  /** Unsubscribe function for RealtimeService price callback */
  private realtimeUnsubscribe: (() => void) | null = null

  constructor(config?: Partial<BtcUpDownConfig>) {
    super()
    // Hydrate from persisted settings (same pattern as TradingService.ts line 45)
    const s = useSettingsStore.getState()
    const persisted: Partial<BtcUpDownConfig> = {
      enableBtc: s.btcEnableBtc,
      enableEth: s.btcEnableEth,
      enableSol: s.btcEnableSol,
      enableXrp: s.btcEnableXrp,
      enable5m: s.btcEnable5m,
      enable15m: s.btcEnable15m,
      enableHourly: s.btcEnableHourly,
      enableDaily: s.btcEnableDaily,
      enable9pm: s.btcEnable9pm,
      minConfidence: s.btcMinConfidence,
      maxEntryPrice: s.btcMaxEntryPrice,
      minEntryPrice: s.btcMinEntryPrice,
      minWindowRemaining: s.btcMinWindowRemaining,
      minTimeIntoWindowMs: s.btcMinTimeIntoWindowMs,
      regimeFilterEnabled: s.btcRegimeFilterEnabled,
      rsiFilterEnabled: s.btcRsiFilterEnabled,
      tradeSize: s.btcTradeSize,
      useKellySizing: s.btcUseKellySizing,
      stopLossPercent: s.btcStopLossPercent,
      takeProfitPercent: s.btcTakeProfitPercent,
      useLLMConfirmation: s.btcUseLLMConfirmation,
    }
    this.btcConfig = { ...DEFAULT_CONFIG, ...persisted, ...config }
    this._config = { enabled: false, ...this.btcConfig }
  }

  async initialize(): Promise<void> {
    this.log('BTC Up/Down Strategy initialized')
    this.setStatus('idle')
  }

  async start(): Promise<void> {
    if (this._status === 'running') return

    this.log('Starting BTC Up/Down Strategy (resolution-hold mode)')
    this.setStatus('running')

    // Subscribe to BinanceWS for 1-second high-frequency price data
    try {
      const { binanceWSService } = await import('@/services/realtime/BinanceWSService')
      this.binanceUnsubscribe = binanceWSService.onPriceUpdate((update) => {
        // BinanceWSService already maps to short symbols ('BTC', 'ETH', 'SOL', 'XRP')
        const asset = update.symbol
        if (!asset) return

        const buffer = this.highFreqPrices.get(asset) || []
        buffer.push({ price: update.priceUSD, timestamp: update.timestamp })
        // Keep last 300 entries (~5 min at 1s)
        if (buffer.length > 300) buffer.shift()
        this.highFreqPrices.set(asset, buffer)
      })
      this.log('BinanceWS subscribed — 1s price buffer active')
    } catch (error) {
      this.logError('BinanceWS subscription failed — using sparse oracle data', error)
    }

    // Connect Polymarket WebSocket for live CLOB prices + order flow signals
    try {
      const { realtimeService } = await import('@/services/realtime')
      this.realtimeServiceRef = realtimeService
      const connected = await realtimeService.connect()
      this.log(`Polymarket WebSocket connected: ${connected}`)

      // Lightweight callback — logs first live price confirmation per session
      let firstPriceLogged = false
      this.realtimeUnsubscribe = realtimeService.onPriceUpdate((slug: string) => {
        if (!firstPriceLogged && this.slugToOutcomeMap.has(slug)) {
          this.log(`[WS] Live price pipeline active (first update for ${slug.slice(0, 20)}…)`)
          firstPriceLogged = true
        }
      })
    } catch (error) {
      this.logError('WebSocket connection failed — will use Gamma mid-prices as fallback', error)
    }

    // Immediate first scan, then adaptive scheduling
    await this.runScanCycle()
    this.scheduleNextScan()

    activityLogger.logSystem('BTC Up/Down Strategy started (resolution-hold mode)')
  }

  async stop(): Promise<void> {
    this.log('Stopping BTC Up/Down Strategy')

    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout)
      this.scanTimeout = null
    }

    // Unsubscribe from BinanceWS
    if (this.binanceUnsubscribe) {
      this.binanceUnsubscribe()
      this.binanceUnsubscribe = null
    }

    // Unsubscribe from RealtimeService price callback (does NOT disconnect WebSocket)
    if (this.realtimeUnsubscribe) {
      this.realtimeUnsubscribe()
      this.realtimeUnsubscribe = null
    }
    this.realtimeServiceRef = null

    this.activeMarkets.clear()
    this.positionsByWindow.clear()
    this.lastTradeTimes.clear()
    this.priceHistory.clear()
    this.highFreqPrices.clear()
    this.windowOpenPriceCache.clear()
    this._lastSignals.clear()
    this.slugToOutcomeMap.clear()
    this.marketOutcomeSlugs.clear()

    this.setStatus('idle')
    activityLogger.logSystem('BTC Up/Down Strategy stopped')
  }

  // ==========================================
  // SCAN LOOP
  // ==========================================

  /** Confidence and entry-price limits in force (for the confidence report) */
  getEntryLimits(): { minConfidence: number; minEntryPrice: number; maxEntryPrice: number } {
    const { minConfidence, minEntryPrice, maxEntryPrice } = this.btcConfig
    return { minConfidence, minEntryPrice, maxEntryPrice }
  }

  private async runScanCycle(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    try {
      // 1. Discover markets for enabled assets
      await this.discoverMarkets()

      // Settle recorded signals whose window has just ended (best-effort)
      for (const asset of btcSignalRecorder.assetsToResolve(Date.now())) {
        try {
          const { priceUSD } = await priceOracleService.getPrice(asset as 'BTC' | 'ETH' | 'SOL' | 'XRP')
          btcSignalRecorder.resolve(asset, priceUSD, Date.now())
        } catch { /* price unavailable: retried next cycle until the grace period passes */ }
      }

      if (this.activeMarkets.size === 0) {
        const assets: string[] = []
        if (this.btcConfig.enableBtc) assets.push('BTC')
        if (this.btcConfig.enableEth) assets.push('ETH')
        if (this.btcConfig.enableSol) assets.push('SOL')
        if (this.btcConfig.enableXrp) assets.push('XRP')
        const durations: string[] = []
        if (this.btcConfig.enable5m) durations.push('5m')
        if (this.btcConfig.enable15m) durations.push('15m')
        if (this.btcConfig.enableHourly) durations.push('hourly')
        if (this.btcConfig.enableDaily) durations.push('daily')
        if (this.btcConfig.enable9pm) durations.push('9pm')

        // Synthetic dry-run: fabricate a market from live price data so the full
        // pipeline (signal → gates → sizing → PLM) can be exercised between windows.
        const isDryRun = useSettingsStore.getState().dryRun
        if (isDryRun && assets.length > 0) {
          const syntheticAsset = assets[0] as 'BTC' | 'ETH' | 'SOL' | 'XRP'
          await this.runSyntheticDryRun(syntheticAsset)
          return
        }

        const msg = `BTC: No Up/Down markets found (scanning ${durations.join('/')} for ${assets.join('/')})`
        console.log(`[BTC Scan] ${msg}`)
        activityLogger.logScan(msg, { total: 0, eligible: 0 })
        return
      }

      // 2. Check position limits
      let btcPositionCount = 0
      try {
        const { positionLifecycleManager } = await import('@/services/trading/PositionLifecycleManager')
        btcPositionCount = positionLifecycleManager.getPositions()
          .filter((p: { strategy: string }) => p.strategy === 'btc').length
      } catch { /* PLM not available */ }

      if (btcPositionCount >= this.btcConfig.maxConcurrentPositions) {
        rejectionTracker.record('position_limit', 'btc', `${btcPositionCount}/${this.btcConfig.maxConcurrentPositions} BTC positions`)
        return
      }

      // 3. Analyze each active market
      for (const [marketId, entry] of this.activeMarkets) {
        if (!this._enabled) break
        if ((this.positionsByWindow.get(marketId) ?? 0) >= this.btcConfig.maxEntriesPerMarket) continue

        const lastTrade = this.lastTradeTimes.get(marketId) || 0
        // Scale cooldown proportionally to window duration
        const timeScale = entry.windowDurationMs / BASELINE_WINDOW_MS
        const scaledCooldown = this.btcConfig.cooldownMs * timeScale
        if (Date.now() - lastTrade < scaledCooldown) continue

        await this.analyzeAndTrade(entry.market, entry.windowOpenPrice, entry.asset, entry.windowDurationMs, entry.durationKey)
      }
    } catch (error) {
      this.logError('Scan cycle failed', error)
    }
  }

  /**
   * Synthetic dry-run: when no real markets exist and dry-run is on, fabricate a
   * 15-min market from live price data and run the full analysis pipeline.
   * This exercises signal → confidence gates → sizing → TradingService (which
   * already simulates in dry-run mode) so the whole chain can be verified.
   */
  private async runSyntheticDryRun(asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<void> {
    try {
      const { priceUSD: currentPrice } = await priceOracleService.getPrice(asset)
      // Simulate being ~5 minutes into a 15-min window
      const windowDurationMs = WINDOW_DURATIONS['15m']
      const timeIntoWindowMs = 5 * 60 * 1000
      const windowEndMs = Date.now() + (windowDurationMs - timeIntoWindowMs)
      // Reference price = current price shifted slightly to create a signal
      const windowOpenPrice = currentPrice * (1 - 0.002) // 0.2% below → mild up bias

      // Synthetic outcome prices (cheap tokens as expected by resolution-hold)
      const upPrice = 0.40
      const downPrice = 0.60

      const syntheticMarket: Market = {
        id: `synthetic-${asset}-${Date.now()}`,
        slug: `synthetic-${asset.toLowerCase()}-dryrun`,
        question: `Will the price of ${asset} go up or down? [SYNTHETIC DRY RUN]`,
        outcomes: ['Up', 'Down'],
        active: true,
        closed: false,
        endDate: new Date(windowEndMs).toISOString(),
        createdAt: new Date(Date.now() - timeIntoWindowMs).toISOString(),
        volume: 0,
        liquidity: 0,
        outcomePrices: [upPrice, downPrice],
      }

      // Use high-freq buffer if available, else sparse history
      const highFreq = this.highFreqPrices.get(asset) || []
      const history = this.priceHistory.get(asset) || []
      const priceBuffer = highFreq.length >= 10 ? highFreq : history.length > 0 ? history : [
        { price: currentPrice * 0.999, timestamp: Date.now() - 60000 },
        { price: currentPrice * 0.998, timestamp: Date.now() - 45000 },
        { price: currentPrice * 1.001, timestamp: Date.now() - 30000 },
        { price: currentPrice, timestamp: Date.now() - 15000 },
      ]

      const signalInput: SignalInput = {
        asset,
        currentPrice,
        windowOpenPrice,
        upPrice,
        downPrice,
        timeIntoWindowMs,
        windowDurationMs,
        recentPriceHistory: priceBuffer,
        market: syntheticMarket,
      }

      const signal = this.computeSignal(signalInput)

      // Emit for dashboard display
      this._lastSignals.set(asset, { signal, windowOpenPrice, currentPrice })
      this.emit('signalComputed', { asset, signal, windowOpenPrice, currentPrice })

      const logPrefix = `[SYNTHETIC DRY RUN] ${asset}`
      this.log(
        `${logPrefix} signal: ${signal.direction.toUpperCase()} conf=${(signal.confidence * 100).toFixed(0)}% ` +
        `(price $${currentPrice.toFixed(2)} vs ref $${windowOpenPrice.toFixed(2)}, ${priceBuffer.length} readings)`,
      )
      activityLogger.logScan(
        `${logPrefix}: ${signal.direction.toUpperCase()} ${(signal.confidence * 100).toFixed(0)}%`,
        { total: 1, eligible: 1, synthetic: true },
      )

      // Apply same gates as real trading
      if (signal.confidence < this.btcConfig.minConfidence) {
        rejectionTracker.record('confidence', 'btc', `${logPrefix} ${(signal.confidence * 100).toFixed(0)}% < ${(this.btcConfig.minConfidence * 100).toFixed(0)}%`)
        return
      }

      const targetIndex = signal.direction === 'up' ? 0 : 1
      const targetPrice = targetIndex === 0 ? upPrice : downPrice
      if (targetPrice > this.btcConfig.maxEntryPrice) {
        rejectionTracker.record('market_filter', 'btc', `${logPrefix} price ${(targetPrice * 100).toFixed(0)}c > max`)
        return
      }

      const positionSize = this.calculatePositionSize(signal.confidence, targetPrice)

      this.log(`${logPrefix} SIGNAL: ${signal.direction.toUpperCase()} @ ${(targetPrice * 100).toFixed(0)}c ($${positionSize.toFixed(2)})`)

      // Execute via TradingService (which simulates in dry-run mode)
      const outcomeStr: 'yes' | 'no' = targetIndex === 0 ? 'yes' : 'no'
      const result = await tradingService.placeBet(
        syntheticMarket,
        outcomeStr,
        positionSize,
        {
          skipGtcFallback: true, // No GTC fallback for synthetic markets
          outcomeIndex: targetIndex,
          stopLossPercent: this.btcConfig.stopLossPercent,
          takeProfitPercent: this.btcConfig.takeProfitPercent,
          strategy: 'btc',
        },
      )

      if (result.success) {
        activityLogger.logTrade(
          `${logPrefix} ${signal.direction.toUpperCase()} $${positionSize.toFixed(2)} (simulated)`,
          { marketId: syntheticMarket.id, orderId: result.orderId },
        )
      }
    } catch (error) {
      this.logError('Synthetic dry-run failed', error)
    }
  }

  /**
   * Adaptive scan scheduler — adjusts interval based on market state.
   * - No active window: 30s (save API calls)
   * - Active window, early (0-30%): 10s
   * - Active window, decision phase (30-80%): 5s
   * - Active window, late (>80%): 15s (let positions resolve)
   */
  private scheduleNextScan(): void {
    if (!this._enabled || this._status !== 'running') return

    // Always scan every 1s for maximum speed
    const intervalMs = 1_000
    this.scanTimeout = window.setTimeout(async () => {
      await this.runScanCycle()
      this.scheduleNextScan()
    }, intervalMs)
  }

  // ==========================================
  // MARKET DISCOVERY
  // ==========================================

  private async discoverMarkets(): Promise<void> {
    const assets: Array<'BTC' | 'ETH' | 'SOL' | 'XRP'> = []
    if (this.btcConfig.enableBtc) assets.push('BTC')
    if (this.btcConfig.enableEth) assets.push('ETH')
    if (this.btcConfig.enableSol) assets.push('SOL')
    if (this.btcConfig.enableXrp) assets.push('XRP')

    const enabledDurations: WindowDuration[] = []
    if (this.btcConfig.enable5m) enabledDurations.push('5m')
    if (this.btcConfig.enable15m) enabledDurations.push('15m')
    if (this.btcConfig.enableHourly) enabledDurations.push('hourly')
    if (this.btcConfig.enableDaily) enabledDurations.push('daily')
    if (this.btcConfig.enable9pm) enabledDurations.push('9pm')

    if (assets.length === 0 || enabledDurations.length === 0) {
      this.log(`[Discovery] Nothing to scan — assets: [${assets}], durations: [${enabledDurations}]`)
      return
    }

    // Evict expired markets and associated tracking data
    const now = Date.now()
    for (const [id, entry] of this.activeMarkets) {
      if (entry.windowEndMs < now) {
        // Remove evicted slugs from lookup map (do NOT unsubscribe — other consumers may need them)
        const evictedSlugs = this.marketOutcomeSlugs.get(id)
        if (evictedSlugs) {
          for (const s of evictedSlugs) {
            this.slugToOutcomeMap.delete(s)
          }
          // The window is closed: stop keeping its full book in memory
          this.realtimeServiceRef?.unwatchBooks?.(evictedSlugs)
          this.marketOutcomeSlugs.delete(id)
        }
        this.activeMarkets.delete(id)
        this.positionsByWindow.delete(id)
        this.lastTradeTimes.delete(id)
      }
    }

    // Prune stale priceHistory and windowOpenPriceCache entries
    const activeAssets = new Set<string>()
    for (const entry of this.activeMarkets.values()) activeAssets.add(entry.asset)
    for (const asset of this.priceHistory.keys()) {
      if (!activeAssets.has(asset)) this.priceHistory.delete(asset)
    }
    for (const key of this.windowOpenPriceCache.keys()) {
      const cachedAsset = key.split(':')[0]
      if (!activeAssets.has(cachedAsset) && !assets.includes(cachedAsset as 'BTC' | 'ETH' | 'SOL' | 'XRP')) {
        this.windowOpenPriceCache.delete(key)
      }
    }

    for (const asset of assets) {
      for (const duration of enabledDurations) {
        try {
          const windowDurationMs = WINDOW_DURATIONS[duration]

          // Skip the lookup while a tracked market covers this asset+duration
          // beyond the pre-fetch lead — then the next window is fetched just
          // BEFORE rollover (staggered by asset) instead of every asset at once after it
          const trackedEnds = Array.from(this.activeMarkets.values())
            .filter(e => e.asset === asset && e.windowDurationMs === windowDurationMs)
            .map(e => e.windowEndMs)
          if (!needsUpDownDiscovery(trackedEnds, now, windowDurationMs, assets.indexOf(asset))) continue

          const markets = await this.discoverBySlug(asset, duration)

          this.log(`[Discovery] ${markets.length} ${duration} slug results for ${asset}`)
          console.log(`[BTC Discovery] ${asset} ${duration}: ${markets.length} markets found via slug`)

          if (markets.length === 0) {
            console.log(`[BTC Discovery] No ${asset} ${duration} Up/Down markets currently active`)
          }

          // Scale minWindowRemaining proportionally to window duration
          const timeScale = windowDurationMs / BASELINE_WINDOW_MS
          const scaledMinRemaining = this.btcConfig.minWindowRemaining * timeScale

          for (const market of markets) {
            if (!market.active || market.closed) continue
            if (this.activeMarkets.has(market.id)) continue
            if (!market.outcomes || market.outcomes.length !== 2) continue

            const windowEndMs = new Date(market.endDate).getTime()
            const timeRemaining = windowEndMs - now
            if (timeRemaining < scaledMinRemaining * 1000) {
              this.log(`[Discovery] ${market.id} (${duration}): only ${Math.round(timeRemaining / 1000)}s left (need ${Math.round(scaledMinRemaining)}s)`)
              continue
            }

            const windowStartMs = windowEndMs - windowDurationMs
            // Exchange-published reference price first (assetPriceTerms.priceToBeat)
            const windowOpenPrice = market.priceToBeat ?? await this.getWindowOpenPrice(asset, windowStartMs, market.question)

            this.activeMarkets.set(market.id, { market, windowOpenPrice, asset, windowEndMs, windowDurationMs, durationKey: duration })

            // Subscribe outcome slugs for live bid/ask via WebSocket
            const outcomeSlugs = this.marketOutcomeSlugs.get(market.id)
            if (outcomeSlugs?.length === 2 && this.realtimeServiceRef) {
              const mOutcomes = market.outcomes || []
              const mUpIdx = mOutcomes.includes('Up') ? mOutcomes.indexOf('Up')
                : mOutcomes.includes('Yes') && market.question.toUpperCase().includes('UP')
                  ? mOutcomes.indexOf('Yes')
                  : 0
              const mDownIdx = mUpIdx === 0 ? 1 : 0

              if (outcomeSlugs[mDownIdx] !== outcomeSlugs[mUpIdx]) {
                this.slugToOutcomeMap.set(outcomeSlugs[mDownIdx], { asset, outcomeIndex: mDownIdx })
              }
              this.slugToOutcomeMap.set(outcomeSlugs[mUpIdx], { asset, outcomeIndex: mUpIdx })
              this.realtimeServiceRef.subscribeMarket([...new Set(outcomeSlugs)])
              // Full book too: the entry depth check then reads it from memory, not REST
              this.realtimeServiceRef.watchBooks?.([...new Set(outcomeSlugs)])
              this.log(`[Discovery] Subscribed outcome slugs for ${asset} ${duration}`)
            }

            this.log(`Found ${duration}: ${market.question.substring(0, 60)}... (${Math.round(timeRemaining / 1000)}s left, open $${windowOpenPrice.toFixed(2)})`)
          }
        } catch (error) {
          this.logError(`Discovery failed for ${asset} ${duration}`, error)
        }
      }
    }
  }

  /**
   * Slug-based discovery for Up/Down markets: current + next window
   * (2 lookups per asset per duration). See upDownSlugsFor.
   */
  private async discoverBySlug(asset: 'BTC' | 'ETH' | 'SOL' | 'XRP', duration: WindowDuration): Promise<Market[]> {
    const slugs = upDownSlugsFor(asset, duration)
    if (slugs.length === 0) {
      if (!this.unsupportedDurationLogged.has(duration)) {
        this.unsupportedDurationLogged.add(duration)
        this.log(`[Discovery] No Polymarket US Up/Down series for "${duration}" windows — skipping`)
      }
      return []
    }
    return this.discoverFromEventSlugs(slugs, duration)
  }

  /**
   * Shared discovery: fetch events by slug, normalize to Markets,
   * and capture individual outcome slugs for WS subscriptions.
   */
  private async discoverFromEventSlugs(eventSlugs: string[], label: string): Promise<Market[]> {
    const markets: Market[] = []

    for (const slug of eventSlugs) {
      if (!slug) continue
      try {
        const event = await polymarketUSClient.getEventBySlug(slug)
        if (!event) continue

        // One binary market per event; Up = YES, Down = NO on the same slug
        for (const m of normalizeEventToMarkets(event as any)) {
          if (m.active && !m.closed) {
            markets.push(m)
            this.marketOutcomeSlugs.set(m.id, m.outcomeSlugs ?? [m.slug, m.slug])
          }
        }
      } catch (error) {
        this.log(`[Discovery] ${label} slug lookup failed for ${slug}: ${error}`)
      }
    }

    return markets
  }

  /**
   * Get the "price to beat" for a window.
   *
   * Priority:
   * 1. Parse from market question text (exact reference price from Polymarket)
   * 2. Fall back to live oracle price (approximate if discovered mid-window)
   * 3. Last resort: hardcoded estimate
   */
  private async getWindowOpenPrice(
    asset: 'BTC' | 'ETH' | 'SOL' | 'XRP',
    windowStartMs: number,
    questionText?: string,
  ): Promise<number> {
    const cacheKey = `${asset}:${windowStartMs}`

    // Return cached if we already captured for this window
    const cached = this.windowOpenPriceCache.get(cacheKey)
    if (cached !== undefined) return cached

    // Priority 1: Parse from question text
    if (questionText) {
      const parsed = parseReferencePrice(questionText)
      if (parsed !== null) {
        this.log(`[RefPrice] ${asset} parsed $${parsed.toFixed(2)} from question`)
        this.windowOpenPriceCache.set(cacheKey, parsed)
        return parsed
      }
    }

    // Priority 2: Live oracle price
    try {
      const { priceUSD } = await priceOracleService.getPrice(asset)
      this.log(`[RefPrice] ${asset} using oracle $${priceUSD.toFixed(2)} (question parse failed)`)
      this.windowOpenPriceCache.set(cacheKey, priceUSD)
      return priceUSD
    } catch (error) {
      this.logError(`Failed to capture open price for ${asset}`, error)
      return asset === 'BTC' ? 97000 : asset === 'ETH' ? 2600 : asset === 'SOL' ? 150 : 2.5
    }
  }

  /**
   * Read live CLOB mid-price for an outcome token via RealtimeService.
   * Falls back to stale Gamma mid-price if WebSocket data unavailable.
   */
  private getLiveOutcomePrice(slug: string | undefined, outcomeIndex: number, fallback: number): number {
    if (!slug || !this.realtimeServiceRef) return fallback
    const pd = this.realtimeServiceRef.getPrice(slug)
    if (!pd || !(pd.mid > 0)) return fallback
    // Feed is YES-quoted: outcome 0 (Up/Yes) is the mid, outcome 1 is 1 - mid
    return priceForOutcome(pd, outcomeIndex === 0 ? 'yes' : 'no').mid
  }

  // ==========================================
  // ANALYSIS & TRADE EXECUTION
  // ==========================================

  private async analyzeAndTrade(
    market: Market,
    windowOpenPrice: number,
    asset: 'BTC' | 'ETH' | 'SOL' | 'XRP',
    windowDurationMs: number,
    durationKey: string = '15m',
  ): Promise<void> {
    try {
      const windowEndMs = new Date(market.endDate).getTime()
      const windowStartMs = windowEndMs - windowDurationMs
      const timeIntoWindowMs = Date.now() - windowStartMs
      const timeScale = windowDurationMs / BASELINE_WINDOW_MS
      const durationLabel = durationKey

      // === Phase 3b: Entry timing corridor ===
      // Don't trade before we have enough data for a signal
      const scaledMinTimeInto = this.btcConfig.minTimeIntoWindowMs * timeScale
      if (timeIntoWindowMs < scaledMinTimeInto) {
        return // Silent skip — too early in window
      }

      // === Phase 3d: Liquidity pre-check ===
      try {
        const { orderBookDepth } = await import('@/services/trading/OrderBookDepth')
        const firstSlug = this.marketOutcomeSlugs.get(market.id)?.[0]
        if (firstSlug) {
          const depthCheck = await orderBookDepth.checkBuyDepth(firstSlug, 0.50, 1.0)
          if (depthCheck.maxFillableUSD < 1.0) {
            rejectionTracker.record('liquidity', 'btc', `${asset} ${durationLabel} depth $${depthCheck.maxFillableUSD.toFixed(2)} < $1`)
            return
          }
        }
      } catch {
        // OrderBookDepth unavailable — continue without liquidity check
      }

      // Fetch live asset price
      const { priceUSD: currentPrice } = await priceOracleService.getPrice(asset)

      // Update sparse price history (legacy fallback)
      const history = this.priceHistory.get(asset) || []
      history.push({ price: currentPrice, timestamp: Date.now() })
      if (history.length > 20) history.shift()
      this.priceHistory.set(asset, history)

      // Use high-freq buffer if available, else fall back to sparse history
      const highFreq = this.highFreqPrices.get(asset) || []
      const priceBuffer = highFreq.length >= 10 ? highFreq : history

      // === Phase 2b: Regime detection (graduated — no hard block) ===
      // Regime scaling is now applied inside computeSignal() via regimeMultiplier().
      // Log choppy for diagnostics but don't block — let reduced confidence handle it.
      if (this.btcConfig.regimeFilterEnabled && priceBuffer.length >= 30) {
        const regime = this.classifyRegime(priceBuffer)
        if (regime === 'choppy') {
          rejectionTracker.record('regime_filter', 'btc', `${asset} ${durationLabel} choppy regime (graduated)`)
        }
      }

      // BTC Up/Down markets use ["Up", "Down"] outcomes (NOT ["Yes", "No"]).
      let upIndex: number, downIndex: number
      let upPrice: number, downPrice: number

      const hasUpDown = market.outcomes.includes('Up') && market.outcomes.includes('Down')
      const hasYesNo = market.outcomes.includes('Yes') && market.outcomes.includes('No')

      if (hasUpDown) {
        upIndex = market.outcomes.indexOf('Up')
        downIndex = market.outcomes.indexOf('Down')
        upPrice = this.getLiveOutcomePrice(this.marketOutcomeSlugs.get(market.id)?.[upIndex], upIndex, market.outcomePrices[upIndex])
        downPrice = this.getLiveOutcomePrice(this.marketOutcomeSlugs.get(market.id)?.[downIndex], downIndex, market.outcomePrices[downIndex])
      } else if (hasYesNo) {
        const yesIndex = market.outcomes.indexOf('Yes')
        const noIndex = market.outcomes.indexOf('No')
        const questionMeansUp = market.question.toUpperCase().includes('UP')
        upIndex = questionMeansUp ? yesIndex : noIndex
        downIndex = questionMeansUp ? noIndex : yesIndex
        upPrice = this.getLiveOutcomePrice(this.marketOutcomeSlugs.get(market.id)?.[upIndex], upIndex, market.outcomePrices[upIndex])
        downPrice = this.getLiveOutcomePrice(this.marketOutcomeSlugs.get(market.id)?.[downIndex], downIndex, market.outcomePrices[downIndex])
      } else {
        console.warn(`[BTC] Unrecognized outcomes: ${JSON.stringify(market.outcomes)}`)
        return
      }

      // Build signal input — pass long-term buffer for dual-timeframe regime detection
      // when high-freq is the primary buffer and sparse history has enough data
      const priceBufferLongTerm = (highFreq.length >= 10 && history.length >= 5)
        ? history : undefined
      const signalInput: SignalInput = {
        asset,
        currentPrice,
        windowOpenPrice,
        upPrice,
        downPrice,
        timeIntoWindowMs,
        windowDurationMs,
        recentPriceHistory: priceBuffer,
        recentPriceHistoryLongTerm: priceBufferLongTerm,
        market,
      }

      // Multi-factor mechanical signal (with vol normalization + RSI)
      const signal = this.computeSignal(signalInput)

      // Historical enrichment — non-blocking, best-effort confidence adjustment
      let historicalWinRate: number | null = null
      let historicalSampleSize = 0
      try {
        const apiKey = useSettingsStore.getState().polyBacktestApiKey || import.meta.env.VITE_POLYBACKTEST_API_KEY
        if (apiKey) {
          const { historicalEnrichment } = await import('./btcupdown/HistoricalEnrichment')
          const hour = new Date().getUTCHours()
          const dow = new Date().getUTCDay()
          const durationKeyMap: Record<string, string> = { '5m': '5m', '15m': '15m', '1hr': '1hr', '4hr': '4hr', '24hr': '24hr' }
          const backtestType = durationKeyMap[durationLabel]
          if (backtestType) {
            const enrichment = await historicalEnrichment.getEnrichment(
              backtestType as import('@/types').PolyBacktestMarketType, hour, dow,
            )
            if (enrichment.sampleSize >= 20) {
              historicalWinRate = enrichment.historicalWinRate
              historicalSampleSize = enrichment.sampleSize
              // Conservative: max +/-5% confidence adjustment based on historical win rate
              const historicalDelta = (enrichment.historicalWinRate - 0.5) * 0.10
              signal.confidence = Math.max(0, Math.min(1, signal.confidence + historicalDelta))
            }
          }
        }
      } catch {
        // Enrichment unavailable — continue without
      }

      // Log the signal for the confidence report (resolved after the window ends)
      try {
        const sigIndex = signal.direction === 'up' ? upIndex : downIndex
        btcSignalRecorder.record({
          marketId: market.id,
          asset,
          duration: durationKey,
          t: Date.now(),
          direction: signal.direction,
          confidence: signal.confidence,
          price: this.getLiveOutcomePrice(this.marketOutcomeSlugs.get(market.id)?.[sigIndex], sigIndex, market.outcomePrices[sigIndex]),
          refPrice: windowOpenPrice,
          windowEndMs,
        })
      } catch { /* recording is best-effort */ }

      // Store for dashboard display + emit event for real-time UI updates
      this._lastSignals.set(asset, { signal, windowOpenPrice, currentPrice })
      this.emit('signalComputed', { asset, signal, windowOpenPrice, currentPrice })

      this.log(
        `${asset} ${durationLabel} signal: ${signal.direction.toUpperCase()} conf=${(signal.confidence * 100).toFixed(0)}% ` +
        `(price $${currentPrice.toFixed(2)} vs ref $${windowOpenPrice.toFixed(2)}, ` +
        `${Math.round(timeIntoWindowMs / 1000)}s into ${durationLabel}, ${priceBuffer.length} readings)`,
      )

      // Gate: confidence
      if (signal.confidence < this.btcConfig.minConfidence) {
        rejectionTracker.record('confidence', 'btc', `${asset} ${durationLabel} ${(signal.confidence * 100).toFixed(0)}% < ${(this.btcConfig.minConfidence * 100).toFixed(0)}%`)
        return
      }

      // Gate: LLM confirmation — when enabled, every trade gets LLM verification.
      // User controls which windows/assets are active via their own toggles.
      // Budget is enforced internally by OpenRouterService ($1/day prediction bucket).
      if (this.btcConfig.useLLMConfirmation) {
        const llmResult = await this.llmConfirmation(asset, signal, signalInput, durationLabel, windowDurationMs - timeIntoWindowMs, {
          historicalWinRate,
          historicalSampleSize,
        })
        if (llmResult === null) {
          rejectionTracker.record('llm_veto', 'btc', `${asset} ${durationLabel} LLM vetoed trade`)
          return
        }
        // Apply LLM confidence adjustment (capped at ±10%)
        signal.confidence = Math.max(0, Math.min(1, llmResult.adjustedConfidence))
        this.log(`[LLM] ${asset} ${durationLabel} ${signal.direction.toUpperCase()} → ${llmResult.reasoning} (adj ${(signal.confidence * 100).toFixed(0)}%)`)
        // Re-check confidence after LLM adjustment
        if (signal.confidence < this.btcConfig.minConfidence) {
          rejectionTracker.record('llm_confidence', 'btc', `${asset} ${durationLabel} post-LLM ${(signal.confidence * 100).toFixed(0)}% < ${(this.btcConfig.minConfidence * 100).toFixed(0)}%`)
          return
        }
      }

      // Gate: max entry price (cheap outcomes only for resolution-hold)
      const targetIndex = signal.direction === 'up' ? upIndex : downIndex
      const targetPrice = this.getLiveOutcomePrice(this.marketOutcomeSlugs.get(market.id)?.[targetIndex], targetIndex, market.outcomePrices[targetIndex])
      if (targetPrice > this.btcConfig.maxEntryPrice) {
        rejectionTracker.record('market_filter', 'btc', `${asset} price ${(targetPrice * 100).toFixed(0)}c > ${(this.btcConfig.maxEntryPrice * 100).toFixed(0)}c max`)
        return
      }
      if (targetPrice < this.btcConfig.minEntryPrice) {
        rejectionTracker.record('market_filter', 'btc', `${asset} price ${(targetPrice * 100).toFixed(0)}c < ${(this.btcConfig.minEntryPrice * 100).toFixed(0)}c min (long-shot)`)
        return
      }

      // Position sizing (fee-adjusted Kelly for crypto markets)
      const positionSize = this.calculatePositionSize(signal.confidence, targetPrice)

      this.log(
        `SIGNAL: ${asset} ${signal.direction.toUpperCase()} ` +
        `@ ${(targetPrice * 100).toFixed(0)}c ` +
        `(conf ${(signal.confidence * 100).toFixed(0)}%, $${positionSize.toFixed(2)})`,
      )

      // Execute trade
      // TradingService.placeBet() expects 'yes'/'no' but we pass explicit outcomeIndex
      // which overrides the yes/no mapping. Map index 0 → 'yes', index 1 → 'no'.
      const outcomeStr: 'yes' | 'no' = targetIndex === 0 ? 'yes' : 'no'
      const result = await tradingService.placeBet(
        market,
        outcomeStr,
        positionSize,
        {
          skipGtcFallback: false,
          outcomeIndex: targetIndex,
          stopLossPercent: this.btcConfig.stopLossPercent,
          takeProfitPercent: this.btcConfig.takeProfitPercent,
          strategy: 'btc',
        },
      )

      if (!result.success) {
        const isFokKill = result.error?.includes("couldn't be fully filled") || result.error?.includes('FOK')
        if (isFokKill) {
          activityLogger.logWarning(`BTC ${asset} FOK killed (thin book): ${result.error}`)
        } else {
          activityLogger.logError(`BTC ${asset} trade failed: ${result.error}`)
        }
        return
      }

      // Record success
      activityLogger.logTrade(
        `${asset} ${signal.direction.toUpperCase()} $${positionSize.toFixed(2)}`,
        { marketId: market.id, orderId: result.orderId },
      )
      this.positionsByWindow.set(market.id, (this.positionsByWindow.get(market.id) ?? 0) + 1)
      this.lastTradeTimes.set(market.id, Date.now())

      // Track with PLM (dynamic import for circular dep safety)
      // Fetch per-token fee rate so PLM adjusts TP threshold correctly
      // (crypto markets charge 1000 bps = 10%, not the default 2%)
      const filledSize = result.filledSize ?? positionSize / targetPrice
      const scaledMaxHold = Math.round(this.btcConfig.maxHoldMs * timeScale)
      import('@/services/trading/PositionLifecycleManager').then(m => {
        m.positionLifecycleManager.trackPosition({
          marketSlug: market.slug,
          outcome: targetIndex === 0 ? 'yes' : 'no',
          question: market.question,
          entryPrice: targetPrice,
          size: filledSize,
          costBasis: positionSize,
          entryTime: Date.now(),
          stopLossPercent: this.btcConfig.stopLossPercent,
          takeProfitPercent: this.btcConfig.takeProfitPercent,
          strategy: 'btc',
          maxHoldMs: scaledMaxHold,
        })
      }).catch(err => console.warn('[BtcUpDown] PLM track failed:', err))

      // Log trade for backtest
      const kellyFraction = useSettingsStore.getState().kellyFraction
      const fStar = KellySizer.pmusKelly(signal.confidence, targetPrice, market.feeCoefficient)
      tradeLogger.logEntry({
        marketId: market.id,
        slug: market.slug,
        question: market.question,
        outcomes: market.outcomes,
        strategy: 'btc',
        side: 'BUY',
        outcome: targetIndex === 0 ? 'yes' : 'no',
        marketPrice: targetPrice,
        kellyFraction: fStar,
        kellyBetSize: KellySizer.sizeBet({
          kellyFraction,
          bankroll: useWalletStore.getState().balance,
          fullKelly: fStar,
        }),
        actualBetSize: positionSize,
        orderId: result.orderId,
        orderType: result.pending ? 'GTD' : 'FOK',
        fillPrice: result.avgPrice,
        filledSize: result.filledSize,
        success: true,
        modelProbability: signal.confidence,
      })

      this.emit('tradePlaced', { market, signal, result })
    } catch (error) {
      this.logError(`Analysis failed for ${asset}`, error)
    }
  }

  // ==========================================
  // LLM CONFIRMATION GATE
  // ==========================================

  /**
   * LLM confirmation gate — asks LLM to verify a mechanical signal before trade.
   * Only called for longer windows (hourly/daily/9pm) where latency is acceptable.
   * Returns adjusted confidence or null to veto the trade.
   * Fail-open: returns original confidence on any error (network, budget, parse).
   */
  private async llmConfirmation(
    asset: string,
    signal: Signal,
    signalInput: SignalInput,
    durationLabel: string,
    timeRemainingMs: number,
    enrichment: { historicalWinRate: number | null; historicalSampleSize: number },
  ): Promise<{ adjustedConfidence: number; reasoning: string } | null> {
    try {
      const { openRouterService } = await import('@/services/llm/OpenRouterService')
      const { binanceWSService } = await import('@/services/realtime/BinanceWSService')

      const displacement = ((signalInput.currentPrice - signalInput.windowOpenPrice) / signalInput.windowOpenPrice * 100).toFixed(3)
      const timeRemainingMin = Math.round(timeRemainingMs / 60_000)

      // --- BinanceWS 24h context ---
      const bws = binanceWSService.getCachedPrice(asset as 'BTC' | 'ETH' | 'SOL' | 'XRP')
      let binanceSection = ''
      if (bws) {
        const range = bws.high24h - bws.low24h
        const rangePct = bws.priceUSD > 0 ? (range / bws.priceUSD * 100).toFixed(1) : '?'
        binanceSection = `
24H MARKET DATA (BinanceWS):
- ${asset} price: $${bws.priceUSD.toLocaleString()} | 24h change: ${bws.priceChange24hPct > 0 ? '+' : ''}${bws.priceChange24hPct.toFixed(1)}%
- 24h range: $${bws.low24h.toLocaleString()} – $${bws.high24h.toLocaleString()} (${rangePct}%)
- 24h volume: $${(bws.volume24hUSD / 1e9).toFixed(2)}B`
      }

      // --- Signal factor breakdown ---
      const f = signal.factors
      let factorsSection = ''
      if (f) {
        factorsSection = `
SIGNAL FACTORS (individual scores):
- Momentum (25%): ${(f.momentum * 100).toFixed(0)}% — vol-normalized z-score of displacement
- Velocity (25%): ${(f.velocity * 100).toFixed(0)}% — linear regression slope of recent prices
- Time Decay (20%): ${(f.timeDecay * 100).toFixed(0)}% — direction consistency × elapsed time
- Value Bet (15%): ${(f.valueBet * 100).toFixed(0)}% — how cheap the target outcome is
- Order Flow (15%): ${(f.orderFlow * 100).toFixed(0)}% — bid/ask imbalance
- Regime: ${f.regime} (ST=${f.regimeEfficiency.toFixed(3)}, LT=${f.regimeEfficiencyLongTerm.toFixed(3)}) | RSI: ${f.rsi.toFixed(0)} | Volatility: ${(f.volatility * 100).toFixed(3)}%`
      }

      // --- Price history mini-summary ---
      const hist = signalInput.recentPriceHistory
      let historySection = ''
      if (hist.length >= 5) {
        // Sample last 10 prices for a mini sparkline
        const step = Math.max(1, Math.floor(hist.length / 10))
        const samples = []
        for (let i = 0; i < hist.length; i += step) {
          samples.push(hist[i].price)
        }
        samples.push(hist[hist.length - 1].price)
        const min = Math.min(...samples)
        const max = Math.max(...samples)
        const trendDir = samples[samples.length - 1] > samples[0] ? 'rising' : samples[samples.length - 1] < samples[0] ? 'falling' : 'flat'
        historySection = `
PRICE HISTORY (${hist.length} readings, ${Math.round((hist[hist.length - 1].timestamp - hist[0].timestamp) / 1000)}s span):
- Trend: ${trendDir} | Range: $${min.toFixed(2)} – $${max.toFixed(2)}
- Samples: [${samples.map(p => p.toFixed(2)).join(', ')}]`
      }

      // --- Historical win rate ---
      let winRateSection = ''
      if (enrichment.historicalWinRate !== null) {
        winRateSection = `
HISTORICAL BACKTEST:
- Win rate: ${(enrichment.historicalWinRate * 100).toFixed(0)}% (${enrichment.historicalSampleSize} samples at this hour/day)`
      }

      // Build full prompt
      const prompt = `You are confirming a mechanical trading signal for a Polymarket crypto up/down binary market.

MARKET: "${signalInput.market.question}"
ASSET: ${asset}
WINDOW: ${durationLabel} (${timeRemainingMin} min remaining)

PRICE DATA:
- Current ${asset} price: $${signalInput.currentPrice.toFixed(2)}
- Window open price: $${signalInput.windowOpenPrice.toFixed(2)}
- Displacement: ${displacement}%
- Up outcome price: ${(signalInput.upPrice * 100).toFixed(0)}c
- Down outcome price: ${(signalInput.downPrice * 100).toFixed(0)}c${binanceSection}${factorsSection}${historySection}${winRateSection}

MECHANICAL SIGNAL:
- Direction: ${signal.direction.toUpperCase()}
- Composite confidence: ${(signal.confidence * 100).toFixed(0)}%

TASK: Should this trade be placed? Consider:
1. Is the ${displacement}% displacement likely to hold for ${timeRemainingMin} more minutes?
2. Do the individual factor scores support the composite confidence, or is one factor dominating?
3. Does the 24h market context (trend, volume, volatility) support the signal direction?
4. Is the outcome pricing fair given the displacement and time remaining?
${enrichment.historicalWinRate !== null ? '5. Does the historical win rate support taking this trade?\n' : ''}
Respond ONLY with JSON:
{"confirm":true/false,"confidence_adjustment":-20 to +20,"reasoning":"1-2 sentences"}`

      const btcModel = useSettingsStore.getState().btcLLMModel || undefined
      const result = await openRouterService.analyzeCryptoSignal(prompt, btcModel)

      if (!result) {
        // Fail-open: LLM unavailable → proceed with mechanical signal
        this.log(`[LLM] ${asset} ${durationLabel} — LLM unavailable, proceeding with mechanical signal`)
        return { adjustedConfidence: signal.confidence, reasoning: 'LLM unavailable — fail-open' }
      }

      if (!result.confirm) {
        this.log(`[LLM] ${asset} ${durationLabel} ${signal.direction.toUpperCase()} VETOED: ${result.reasoning}`)
        return null
      }

      // Apply adjustment (capped at ±10% of original)
      const adjustmentFraction = result.adjustment / 100
      const cappedAdjustment = Math.max(-0.10, Math.min(0.10, adjustmentFraction))
      const adjustedConfidence = signal.confidence + cappedAdjustment

      return { adjustedConfidence, reasoning: result.reasoning }
    } catch (error) {
      // Fail-open: any error → proceed with mechanical signal
      this.log(`[LLM] ${asset} ${durationLabel} — error: ${error instanceof Error ? error.message : 'unknown'}, proceeding`)
      return { adjustedConfidence: signal.confidence, reasoning: 'LLM error — fail-open' }
    }
  }

  // ==========================================
  // SIGNAL COMPUTATION — Multi-Factor Mechanical Signal
  // ==========================================

  /**
   * 5-factor signal computation with volatility-normalized momentum.
   *
   * FACTORS (weights vary by window duration — see below):
   * 1. MOMENTUM: z-score normalized price displacement from reference price
   * 2. VELOCITY: Linear regression slope of recent prices
   * 3. TIME DECAY: Later in window + consistent direction = more confident
   * 4. VALUE BET: How cheap the target outcome is (cheaper = higher payoff)
   * 5. ORDER FLOW: Microstructure bid/ask imbalance (if available)
   *
   * Weights: MOMENTUM 25%, VELOCITY 25%, TIME 20%, VALUE 15%, FLOW 15%
   *
   * Post-composite adjustments:
   * - Regime boost: +10% confidence in trending markets
   * - RSI filter: -15% confidence when entering overbought/oversold
   */
  private computeSignal(input: SignalInput): Signal {
    // Compute live order flow imbalance from MicrostructureAnalyzer
    let imbalanceScore = 0
    try {
      const { microstructureAnalyzer } = require('@/services/trading/MicrostructureAnalyzer')
      const firstSlug = input.market.slug
      if (firstSlug) {
        const signal = microstructureAnalyzer.getSignal(firstSlug)
        if (signal && signal.signalConfidence > 0.3) {
          const isFirstUp = input.market.outcomes[0] === 'Up' || input.market.question.toUpperCase().includes('UP')
          const adjustedSignal = isFirstUp ? signal.compositeSignal : -signal.compositeSignal
          const direction = ((input.currentPrice - input.windowOpenPrice) / input.windowOpenPrice) >= 0 ? 'up' : 'down'
          imbalanceScore = direction === 'up' ? adjustedSignal : -adjustedSignal
        }
      }
    } catch {
      // MicrostructureAnalyzer not available — continue without
    }

    return _computeSignal(input, {
      regimeFilterEnabled: this.btcConfig.regimeFilterEnabled,
      rsiFilterEnabled: this.btcConfig.rsiFilterEnabled,
      baselineWindowMs: BASELINE_WINDOW_MS,
    }, imbalanceScore)
  }

  classifyRegime(prices: Array<{ price: number; timestamp: number }>): 'choppy' | 'trending' | 'neutral' {
    return _classifyRegime(prices)
  }

  // ==========================================
  // POSITION SIZING
  // ==========================================

  private calculatePositionSize(confidence: number, marketPrice: number): number {
    const pennyMode = useSettingsStore.getState().pennyTraderMode
    // Polymarket CLOB requires minimum 5 shares per order
    if (pennyMode) return Math.max(1.0, 5 * marketPrice)

    if (!this.btcConfig.useKellySizing) {
      return this.btcConfig.tradeSize
    }

    const bankroll = useWalletStore.getState().balance
    const kellyFraction = useSettingsStore.getState().kellyFraction
    // PM US taker fee Θ·p·(1−p) per contract (Θ = 0.095 at tier 1)
    const adaptiveProb = edgeTracker.getAdaptiveModelProb('btc', confidence)
    const fStar = KellySizer.pmusKelly(adaptiveProb, marketPrice)
    return Math.round(KellySizer.sizeBet({ kellyFraction, bankroll, fullKelly: fStar }) * 100) / 100
  }

  // ==========================================
  // DASHBOARD DATA API
  // ==========================================

  /** Get the latest computed signal for an asset (for dashboard gauge display) */
  getLastSignal(asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'): { signal: Signal; windowOpenPrice: number; currentPrice: number } | null {
    return this._lastSignals.get(asset) ?? null
  }

  /** Get the current active window timing (for dashboard timer display) */
  getActiveWindow(): { asset: string; windowStartMs: number; windowEndMs: number; windowDurationMs: number } | null {
    for (const entry of this.activeMarkets.values()) {
      return {
        asset: entry.asset,
        windowStartMs: entry.windowEndMs - entry.windowDurationMs,
        windowEndMs: entry.windowEndMs,
        windowDurationMs: entry.windowDurationMs,
      }
    }
    return null
  }

  /** Get all active market entries (for dashboard asset cards) */
  getActiveMarketEntries(): Array<{
    asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'
    windowOpenPrice: number
    windowEndMs: number
    windowDurationMs: number
    marketId: string
  }> {
    return Array.from(this.activeMarkets.entries()).map(([id, entry]) => ({
      asset: entry.asset,
      windowOpenPrice: entry.windowOpenPrice,
      windowEndMs: entry.windowEndMs,
      windowDurationMs: entry.windowDurationMs,
      marketId: id,
    }))
  }

  // ==========================================
  // CONFIG API
  // ==========================================

  getBtcConfig(): BtcUpDownConfig {
    return { ...this.btcConfig }
  }

  setBtcConfig(config: Partial<BtcUpDownConfig>): void {
    this.btcConfig = { ...this.btcConfig, ...config }
    this._config = { ...this._config, ...this.btcConfig }
    this.emit('configUpdated', this.btcConfig)
  }
}

// Singleton
export const btcUpDownStrategy = new BtcUpDownStrategy()
