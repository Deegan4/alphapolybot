import { BaseStrategy } from './BaseStrategy'
import type { BtcUpDownConfig, Market } from '@/types'
import { gammaClient } from '@/services/api/GammaClient'
import { priceOracleService } from '@/services/api/PriceOracleService'
import { tradingService } from '@/services/trading/TradingService'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { tradeLogger } from '@/services/trading/TradeLogger'
import { KellySizer } from '@/services/trading/KellySizer'
import { edgeTracker } from '@/services/trading/EdgeTracker'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'
import { rejectionTracker } from '@/services/trading/RejectionTracker'

// ==========================================
// TYPES
// ==========================================

export interface SignalInput {
  asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'
  currentPrice: number       // Live asset price from oracle
  windowOpenPrice: number    // "Price to beat" from market question
  upPrice: number            // Current Up outcome price (0-1)
  downPrice: number          // Current Down outcome price (0-1)
  timeIntoWindowMs: number   // Elapsed ms since window start
  windowDurationMs: number   // 15 * 60 * 1000 or longer for 9PM events
  recentPriceHistory: Array<{ price: number; timestamp: number }>
  market: Market
}

export interface Signal {
  direction: 'up' | 'down'
  confidence: number // 0-1
}

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

const ASSET_NAMES: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  XRP: 'XRP',
}

/**
 * Slug prefixes for each asset × window duration on Polymarket.
 * Pattern: {asset}-updown-{duration}-{windowStartUnix}
 */
export const ASSET_SLUG_PATTERNS: Record<string, Partial<Record<WindowDuration, string>>> = {
  BTC: { '5m': 'btc-updown-5m-', '15m': 'btc-updown-15m-' },
  ETH: { '5m': 'eth-updown-5m-', '15m': 'eth-updown-15m-' },
  SOL: { '5m': 'sol-updown-5m-', '15m': 'sol-updown-15m-' },
  XRP: { '5m': 'xrp-updown-5m-', '15m': 'xrp-updown-15m-' },
}

/** Month names for 9PM event slug generation */
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december']

/**
 * 9PM event slugs use a different format: {asset}-up-or-down-{month}-{day}-9pm-et
 * Unlike 5m/15m which are timestamp-based, these are human-readable date-based.
 */
export const ASSET_9PM_SLUG_BUILDERS: Record<string, (date: Date) => string> = {
  BTC: (d) => `bitcoin-up-or-down-${MONTH_NAMES[d.getMonth()]}-${d.getDate()}-9pm-et`,
  ETH: (d) => `ethereum-up-or-down-${MONTH_NAMES[d.getMonth()]}-${d.getDate()}-9pm-et`,
  SOL: (d) => `solana-up-or-down-${MONTH_NAMES[d.getMonth()]}-${d.getDate()}-9pm-et`,
  XRP: (d) => `xrp-up-or-down-${MONTH_NAMES[d.getMonth()]}-${d.getDate()}-9pm-et`,
}

/** Full asset names used in human-readable hourly/daily slugs */
const ASSET_FULL_NAMES: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'xrp',
}

/**
 * Convert a UTC Date to Eastern Time hour components.
 * Returns { etDate, hour12, ampm } where hour12 is 1-12 and ampm is 'am'/'pm'.
 * Handles EST (UTC-5) and EDT (UTC-4) via Intl.DateTimeFormat.
 */
function toEasternTime(utcDate: Date): { etDate: Date; hour12: number; ampm: string } {
  // Use Intl to get the ET offset-aware date parts
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', hour12: false,
  }).formatToParts(utcDate)

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0'
  const etYear = parseInt(get('year'))
  const etMonth = parseInt(get('month')) - 1
  const etDay = parseInt(get('day'))
  const etHour24 = parseInt(get('hour')) % 24 // Intl returns 24 for midnight in some locales

  const etDate = new Date(etYear, etMonth, etDay)
  const ampm = etHour24 >= 12 ? 'pm' : 'am'
  const hour12 = etHour24 === 0 ? 12 : etHour24 > 12 ? etHour24 - 12 : etHour24
  return { etDate, hour12, ampm }
}

/**
 * Hourly event slugs: {asset}-up-or-down-{month}-{day}-{hour}{am/pm}-et
 * e.g. bitcoin-up-or-down-february-14-1pm-et
 */
function buildHourlySlug(asset: string, utcDate: Date): string {
  const fullName = ASSET_FULL_NAMES[asset]
  if (!fullName) return ''
  const { etDate, hour12, ampm } = toEasternTime(utcDate)
  return `${fullName}-up-or-down-${MONTH_NAMES[etDate.getMonth()]}-${etDate.getDate()}-${hour12}${ampm}-et`
}

/**
 * Daily event slugs: {asset}-up-or-down-on-{month}-{day}
 * e.g. bitcoin-up-or-down-on-february-15
 */
function buildDailySlug(asset: string, utcDate: Date): string {
  const fullName = ASSET_FULL_NAMES[asset]
  if (!fullName) return ''
  const { etDate } = toEasternTime(utcDate)
  return `${fullName}-up-or-down-on-${MONTH_NAMES[etDate.getMonth()]}-${etDate.getDate()}`
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
  private tokenToOutcomeMap = new Map<string, { asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'; outcomeIndex: number }>()
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
      this.realtimeUnsubscribe = realtimeService.onPriceUpdate((tokenId: string) => {
        if (!firstPriceLogged && this.tokenToOutcomeMap.has(tokenId)) {
          this.log(`[CLOB] Live price pipeline active (first update for ${tokenId.slice(0, 12)}…)`)
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
    this.tokenToOutcomeMap.clear()

    this.setStatus('idle')
    activityLogger.logSystem('BTC Up/Down Strategy stopped')
  }

  // ==========================================
  // SCAN LOOP
  // ==========================================

  private async runScanCycle(): Promise<void> {
    if (!this._enabled || this._status !== 'running') return

    try {
      // 1. Discover markets for enabled assets
      await this.discoverMarkets()

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
        // Remove evicted tokens from lookup map (do NOT unsubscribe — other consumers may need them)
        if (entry.market.clobTokenIds) {
          for (const tid of entry.market.clobTokenIds) {
            this.tokenToOutcomeMap.delete(tid)
          }
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

          // Skip Gamma API call if we already have an active market for this asset+duration
          const alreadyTracked = Array.from(this.activeMarkets.values()).some(
            e => e.asset === asset && e.windowDurationMs === windowDurationMs && e.windowEndMs > now
          )
          if (alreadyTracked) continue

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
            const windowOpenPrice = await this.getWindowOpenPrice(asset, windowStartMs, market.question)

            this.activeMarkets.set(market.id, { market, windowOpenPrice, asset, windowEndMs, windowDurationMs, durationKey: duration })

            // Subscribe CLOB tokens for live bid/ask via WebSocket
            if (market.clobTokenIds?.length === 2 && this.realtimeServiceRef) {
              const mOutcomes = market.outcomes || []
              const mUpIdx = mOutcomes.includes('Up') ? mOutcomes.indexOf('Up')
                : mOutcomes.includes('Yes') && market.question.toUpperCase().includes('UP')
                  ? mOutcomes.indexOf('Yes')
                  : 0
              const mDownIdx = mUpIdx === 0 ? 1 : 0

              this.tokenToOutcomeMap.set(market.clobTokenIds[mUpIdx], { asset, outcomeIndex: mUpIdx })
              this.tokenToOutcomeMap.set(market.clobTokenIds[mDownIdx], { asset, outcomeIndex: mDownIdx })
              this.realtimeServiceRef.subscribeMarket([market.clobTokenIds[mUpIdx], market.clobTokenIds[mDownIdx]])
              this.log(`[Discovery] Subscribed CLOB tokens for ${asset} ${duration}`)
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
   * Slug-based market discovery for Up/Down markets.
   * Slugs follow the pattern: {asset}-updown-{5m|15m}-{windowStartUnix}
   * where windowStartUnix aligns to 300-second (5m) or 900-second (15m) boundaries.
   *
   * Queries current window + next window (2 API calls per asset per duration).
   */
  private async discoverBySlug(asset: 'BTC' | 'ETH' | 'SOL' | 'XRP', duration: WindowDuration): Promise<Market[]> {
    // Human-readable slug formats — delegate to dedicated methods
    if (duration === '9pm') return this.discoverBySlug9pm(asset)
    if (duration === 'hourly') return this.discoverBySlugHourly(asset)
    if (duration === 'daily') return this.discoverBySlugDaily(asset)
    const prefix = ASSET_SLUG_PATTERNS[asset]?.[duration]
    if (!prefix) return []
    const intervalSec = duration === '5m' ? 300 : 900
    const nowSec = Math.floor(Date.now() / 1000)
    const currentWindowStart = Math.floor(nowSec / intervalSec) * intervalSec
    const nextWindowStart = currentWindowStart + intervalSec

    const slugs = [
      `${prefix}${currentWindowStart}`,
      `${prefix}${nextWindowStart}`,
    ]

    const markets: Market[] = []

    for (const slug of slugs) {
      try {
        const event = await gammaClient.getEventBySlug(slug)
        if (!event) continue

        // Event contains child markets — extract them
        const eventMarkets = event.markets || []
        for (const m of eventMarkets) {
          if (m.active && !m.closed) {
            markets.push(m)
          }
        }
      } catch (error) {
        this.log(`[Discovery] Slug lookup failed for ${slug}: ${error}`)
      }
    }

    return markets
  }

  /**
   * 9PM event discovery — uses human-readable date-based slugs.
   * Format: {asset}-up-or-down-{month}-{day}-9pm-et
   * Queries today's event + tomorrow's event.
   */
  private async discoverBySlug9pm(asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<Market[]> {
    const builder = ASSET_9PM_SLUG_BUILDERS[asset]
    if (!builder) return []

    const today = new Date()
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)

    const slugs = [builder(today), builder(tomorrow)]
    const markets: Market[] = []

    for (const slug of slugs) {
      try {
        const event = await gammaClient.getEventBySlug(slug)
        if (!event) continue

        const eventMarkets = event.markets || []
        for (const m of eventMarkets) {
          if (m.active && !m.closed) {
            markets.push(m)
          }
        }
      } catch (error) {
        this.log(`[Discovery] 9PM slug lookup failed for ${slug}: ${error}`)
      }
    }

    return markets
  }

  /**
   * Hourly event discovery — uses human-readable date-based slugs.
   * Format: {asset}-up-or-down-{month}-{day}-{hour}{am/pm}-et
   * Queries current hour + next hour (2 API calls per asset).
   */
  private async discoverBySlugHourly(asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<Market[]> {
    const now = new Date()
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000)

    const slugs = [buildHourlySlug(asset, now), buildHourlySlug(asset, nextHour)]
    const markets: Market[] = []

    for (const slug of slugs) {
      if (!slug) continue
      try {
        const event = await gammaClient.getEventBySlug(slug)
        if (!event) continue

        const eventMarkets = event.markets || []
        for (const m of eventMarkets) {
          if (m.active && !m.closed) {
            markets.push(m)
          }
        }
      } catch (error) {
        this.log(`[Discovery] Hourly slug lookup failed for ${slug}: ${error}`)
      }
    }

    return markets
  }

  /**
   * Daily event discovery — uses human-readable date-based slugs.
   * Format: {asset}-up-or-down-on-{month}-{day}
   * Queries today's event + tomorrow's event.
   */
  private async discoverBySlugDaily(asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<Market[]> {
    const now = new Date()
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)

    const slugs = [buildDailySlug(asset, now), buildDailySlug(asset, tomorrow)]
    const markets: Market[] = []

    for (const slug of slugs) {
      if (!slug) continue
      try {
        const event = await gammaClient.getEventBySlug(slug)
        if (!event) continue

        const eventMarkets = event.markets || []
        for (const m of eventMarkets) {
          if (m.active && !m.closed) {
            markets.push(m)
          }
        }
      } catch (error) {
        this.log(`[Discovery] Daily slug lookup failed for ${slug}: ${error}`)
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
  private getLiveOutcomePrice(tokenId: string | undefined, gammaFallback: number): number {
    if (!tokenId || !this.realtimeServiceRef) return gammaFallback
    const pd = this.realtimeServiceRef.getPrice(tokenId)
    return pd && pd.mid > 0 ? pd.mid : gammaFallback
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
        const { OrderBookDepth } = await import('@/services/trading/OrderBookDepth')
        const firstTokenId = market.clobTokenIds?.[0]
        if (firstTokenId) {
          const depthCheck = await OrderBookDepth.checkBuyDepth(firstTokenId, 0.50, 1.0)
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

      // === Phase 2b: Regime detection ===
      if (this.btcConfig.regimeFilterEnabled && priceBuffer.length >= 30) {
        const regime = this.classifyRegime(priceBuffer)
        if (regime === 'choppy') {
          rejectionTracker.record('regime_filter', 'btc', `${asset} ${durationLabel} choppy regime`)
          return
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
        upPrice = this.getLiveOutcomePrice(market.clobTokenIds?.[upIndex], market.outcomePrices[upIndex])
        downPrice = this.getLiveOutcomePrice(market.clobTokenIds?.[downIndex], market.outcomePrices[downIndex])
      } else if (hasYesNo) {
        const yesIndex = market.outcomes.indexOf('Yes')
        const noIndex = market.outcomes.indexOf('No')
        const questionMeansUp = market.question.toUpperCase().includes('UP')
        upIndex = questionMeansUp ? yesIndex : noIndex
        downIndex = questionMeansUp ? noIndex : yesIndex
        upPrice = this.getLiveOutcomePrice(market.clobTokenIds?.[upIndex], market.outcomePrices[upIndex])
        downPrice = this.getLiveOutcomePrice(market.clobTokenIds?.[downIndex], market.outcomePrices[downIndex])
      } else {
        console.warn(`[BTC] Unrecognized outcomes: ${JSON.stringify(market.outcomes)}`)
        return
      }

      // Build signal input
      const signalInput: SignalInput = {
        asset,
        currentPrice,
        windowOpenPrice,
        upPrice,
        downPrice,
        timeIntoWindowMs,
        windowDurationMs,
        recentPriceHistory: priceBuffer,
        market,
      }

      // Multi-factor mechanical signal (with vol normalization + RSI)
      const signal = this.computeSignal(signalInput)

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
        const llmResult = await this.llmConfirmation(asset, signal, signalInput, durationLabel, windowDurationMs - timeIntoWindowMs)
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
      const targetPrice = this.getLiveOutcomePrice(market.clobTokenIds?.[targetIndex], market.outcomePrices[targetIndex])
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
      const tokenIdForPlm = market.clobTokenIds[targetIndex]
      const scaledMaxHold = Math.round(this.btcConfig.maxHoldMs * timeScale)
      Promise.all([
        import('@/services/trading/PositionLifecycleManager'),
        import('@/services/api').then(api => api.clobClient.getFeeRateBps(tokenIdForPlm)).catch(() => undefined),
      ]).then(([m, feeRate]) => {
        m.positionLifecycleManager.trackPosition({
          tokenId: tokenIdForPlm,
          marketId: market.id,
          conditionId: market.conditionId,
          outcome: market.outcomes[targetIndex] || (targetIndex === 0 ? 'Yes' : 'No'),
          question: market.question,
          entryPrice: targetPrice,
          size: filledSize,
          costBasis: positionSize,
          entryTime: Date.now(),
          stopLossPercent: this.btcConfig.stopLossPercent,
          takeProfitPercent: this.btcConfig.takeProfitPercent,
          strategy: 'btc',
          negRisk: market.negRisk,
          maxHoldMs: scaledMaxHold,
          takerFeeBps: feeRate,
        })
      }).catch(err => console.warn('[BtcUpDown] PLM track failed:', err))

      // Log trade for backtest
      const kellyFraction = useSettingsStore.getState().kellyFraction
      const fStar = KellySizer.polymarketKelly(signal.confidence, targetPrice)
      tradeLogger.logEntry({
        marketId: market.id,
        conditionId: market.conditionId,
        question: market.question,
        outcomes: market.outcomes,
        strategy: 'btc',
        side: 'BUY',
        outcome: market.outcomes[targetIndex] || (targetIndex === 0 ? 'Yes' : 'No'),
        marketPrice: targetPrice,
        kellyFraction: fStar,
        kellyBetSize: KellySizer.sizeBet({
          kellyFraction,
          bankroll: useWalletStore.getState().usdcBridgedBalance ?? 0,
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
  ): Promise<{ adjustedConfidence: number; reasoning: string } | null> {
    try {
      const { openRouterService } = await import('@/services/llm/OpenRouterService')

      const displacement = ((signalInput.currentPrice - signalInput.windowOpenPrice) / signalInput.windowOpenPrice * 100).toFixed(3)
      const timeRemainingMin = Math.round(timeRemainingMs / 60_000)

      // Build crypto-specific prompt with signal context
      const prompt = `You are confirming a mechanical trading signal for a Polymarket crypto up/down binary market.

MARKET: "${signalInput.market.question}"
ASSET: ${asset}
WINDOW: ${durationLabel} (${timeRemainingMin} min remaining)

PRICE DATA:
- Current ${asset} price: $${signalInput.currentPrice.toFixed(2)}
- Window open price: $${signalInput.windowOpenPrice.toFixed(2)}
- Displacement: ${displacement}%
- Up outcome price: ${(signalInput.upPrice * 100).toFixed(0)}c
- Down outcome price: ${(signalInput.downPrice * 100).toFixed(0)}c

MECHANICAL SIGNAL:
- Direction: ${signal.direction.toUpperCase()}
- Confidence: ${(signal.confidence * 100).toFixed(0)}%
- Based on: momentum, velocity, time decay, value bet, order flow imbalance

TASK: Should this trade be placed? Consider:
1. Is the ${displacement}% displacement likely to hold for ${timeRemainingMin} more minutes?
2. Does the signal direction align with the price momentum?
3. Is the outcome pricing fair given the displacement?

Respond ONLY with JSON:
{"confirm":true/false,"confidence_adjustment":-20 to +20,"reasoning":"1 sentence"}`

      const result = await openRouterService.analyzeCryptoSignal(prompt)

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
    const {
      currentPrice, windowOpenPrice, upPrice, downPrice,
      timeIntoWindowMs, windowDurationMs, recentPriceHistory,
    } = input

    const timeScale = windowDurationMs / BASELINE_WINDOW_MS          // 1.0 for 15m

    // === Factor 1: MOMENTUM — vol-normalized z-score ===
    // Uses capped time normalization: sqrt(min(remaining, elapsed)) prevents
    // signal suppression early in windows when remaining time is large.
    const priceDelta = (currentPrice - windowOpenPrice) / windowOpenPrice
    const sigma = this.computeVolatility(recentPriceHistory)
    const elapsedS = Math.max(1, timeIntoWindowMs / 1000)
    const windowRemainingS = Math.max(1, (windowDurationMs - timeIntoWindowMs) / 1000)
    const timeNorm = Math.sqrt(Math.min(windowRemainingS, elapsedS))
    let momentumScore: number
    if (sigma > 0) {
      const zScore = priceDelta / (sigma * timeNorm)
      momentumScore = Math.tanh(zScore * 1.5)  // smooth saturation to [-1, 1]
    } else {
      // Fallback: fixed scaler when insufficient data for vol estimate
      momentumScore = Math.max(-1, Math.min(1, priceDelta * 50 / Math.sqrt(timeScale)))
    }

    const direction: 'up' | 'down' = priceDelta >= 0 ? 'up' : 'down'

    // === Factor 2: VELOCITY — linear regression slope ===
    let velocityScore = 0
    if (recentPriceHistory.length >= 3) {
      const slope = this.linearRegressionSlope(recentPriceHistory)
      const relativeSlope = slope / windowOpenPrice
      const velocityScaler = 30 / Math.sqrt(timeScale)
      velocityScore = Math.max(-1, Math.min(1, relativeSlope * 60_000 * velocityScaler))
    }

    // === Factor 3: TIME DECAY — direction consistency ===
    const timeRatio = Math.max(0, Math.min(1, timeIntoWindowMs / windowDurationMs))
    let directionConsistency = 0
    if (recentPriceHistory.length >= 2) {
      const onSameSide = recentPriceHistory.filter(p =>
        direction === 'up' ? p.price >= windowOpenPrice : p.price < windowOpenPrice,
      ).length
      directionConsistency = onSameSide / recentPriceHistory.length
    }
    const timeDecayBoost = timeRatio * directionConsistency

    // === Factor 4: VALUE BET — cheapness of target outcome ===
    const targetPrice = direction === 'up' ? upPrice : downPrice
    const cheapness = Math.max(0, Math.min(1, 1 - targetPrice))

    // === Factor 5: ORDER FLOW IMBALANCE ===
    let imbalanceScore = 0
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { microstructureAnalyzer } = require('@/services/trading/MicrostructureAnalyzer')
      const firstTokenId = input.market.clobTokenIds?.[0]
      if (firstTokenId) {
        const signal = microstructureAnalyzer.getSignal(firstTokenId)
        if (signal && signal.signalConfidence > 0.3) {
          const isFirstUp = input.market.outcomes[0] === 'Up' || input.market.question.toUpperCase().includes('UP')
          const adjustedSignal = isFirstUp ? signal.compositeSignal : -signal.compositeSignal
          imbalanceScore = direction === 'up' ? adjustedSignal : -adjustedSignal
        }
      }
    } catch {
      // MicrostructureAnalyzer not available — continue without
    }

    // === COMPOSITE with dynamic weights ===
    const wMomentum = 0.25
    const wVelocity = 0.25
    const wTime     = 0.20
    const wValue    = 0.15
    const wFlow     = 0.15

    const rawScore =
      momentumScore * wMomentum +
      velocityScore * wVelocity +
      timeDecayBoost * wTime +
      cheapness * wValue +
      imbalanceScore * wFlow

    // Sqrt scaling: stretches [0, 0.5] → [0, 0.7]
    const amplifiedScore = Math.sign(rawScore) * Math.sqrt(Math.abs(rawScore))

    // Noise dampening for shorter windows
    const noiseScale = Math.sqrt(timeScale)
    const noiseDampener = 0.85 + 0.15 * noiseScale
    let confidence = Math.max(0, Math.min(1, Math.abs(amplifiedScore) * noiseDampener))

    // === REGIME BOOST ===
    if (this.btcConfig.regimeFilterEnabled) {
      const regime = this.classifyRegime(recentPriceHistory)
      if (regime === 'trending') {
        confidence = Math.min(1, confidence * 1.10)  // +10% in trending markets
      }
      // Note: 'choppy' regime is gate-filtered in analyzeAndTrade before computeSignal
    }

    // === RSI FILTER ===
    if (this.btcConfig.rsiFilterEnabled && recentPriceHistory.length >= 20) {
      const rsi = this.computeRSI(recentPriceHistory, 14)
      if ((rsi > 75 && direction === 'up') || (rsi < 25 && direction === 'down')) {
        confidence *= 0.85  // -15% when chasing extended moves
      }
    }

    // === EARLY WINDOW RAMP ===
    const earlyRampMs = 60_000 * timeScale
    if (timeIntoWindowMs < earlyRampMs) {
      const earlyPenalty = 0.85 + 0.15 * (timeIntoWindowMs / earlyRampMs)
      confidence *= earlyPenalty
    }

    return { direction, confidence }
  }

  /**
   * Compute volatility (stddev of returns) from price history.
   * Returns 0 if insufficient data (< 5 points).
   */
  private computeVolatility(prices: Array<{ price: number; timestamp: number }>): number {
    if (prices.length < 5) return 0
    const returns: number[] = []
    for (let i = 1; i < prices.length; i++) {
      if (prices[i].price > 0 && prices[i - 1].price > 0) {
        returns.push((prices[i].price - prices[i - 1].price) / prices[i - 1].price)
      }
    }
    if (returns.length < 3) return 0
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
    return Math.sqrt(variance)
  }

  /**
   * Classify market regime using efficiency ratio.
   * Efficiency = |net displacement| / total path length.
   *   < 0.15 → choppy (mean-reverting, skip trading)
   *   > 0.40 → trending (boost confidence)
   *   else   → neutral
   */
  classifyRegime(prices: Array<{ price: number; timestamp: number }>): 'choppy' | 'trending' | 'neutral' {
    if (prices.length < 10) return 'neutral'
    const netDisplacement = Math.abs(prices[prices.length - 1].price - prices[0].price)
    let totalPath = 0
    for (let i = 1; i < prices.length; i++) {
      totalPath += Math.abs(prices[i].price - prices[i - 1].price)
    }
    if (totalPath === 0) return 'neutral'
    const efficiency = netDisplacement / totalPath
    if (efficiency < 0.15) return 'choppy'
    if (efficiency > 0.40) return 'trending'
    return 'neutral'
  }

  /**
   * Fast RSI computation over price history.
   * @param period Number of intervals for RSI (default 14)
   */
  private computeRSI(prices: Array<{ price: number; timestamp: number }>, period = 14): number {
    if (prices.length < period + 1) return 50  // neutral default
    const recent = prices.slice(-period - 1)
    let gains = 0, losses = 0
    for (let i = 1; i < recent.length; i++) {
      const change = recent[i].price - recent[i - 1].price
      if (change > 0) gains += change
      else losses -= change
    }
    if (losses === 0) return 100
    if (gains === 0) return 0
    const rs = (gains / period) / (losses / period)
    return 100 - 100 / (1 + rs)
  }

  /**
   * Compute linear regression slope over price history.
   * Returns price change per millisecond.
   */
  private linearRegressionSlope(
    points: Array<{ price: number; timestamp: number }>,
  ): number {
    const n = points.length
    if (n < 2) return 0

    // Use relative timestamps (ms from first point)
    const t0 = points[0].timestamp
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
    for (const p of points) {
      const x = p.timestamp - t0
      const y = p.price
      sumX += x
      sumY += y
      sumXY += x * y
      sumXX += x * x
    }

    const denom = n * sumXX - sumX * sumX
    if (Math.abs(denom) < 1e-12) return 0
    return (n * sumXY - sumX * sumY) / denom
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

    const bankroll = useWalletStore.getState().usdcBridgedBalance ?? useWalletStore.getState().usdcBalance
    const kellyFraction = useSettingsStore.getState().kellyFraction
    // Crypto markets have 1000 bps (10%) taker fee — use fee-adjusted Kelly
    const adaptiveProb = edgeTracker.getAdaptiveModelProb('btc', confidence)
    const fStar = KellySizer.polymarketKellyWithFee(adaptiveProb, marketPrice, 1000)
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
