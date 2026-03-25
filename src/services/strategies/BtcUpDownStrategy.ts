import { BaseStrategy } from './BaseStrategy'
import type { BtcUpDownConfig, Market } from '@/types'
import { polymarketClient } from '@/services/api'
import { priceOracleService } from '@/services/api/PriceOracleService'
import { tradingService } from '@/services/trading/TradingService'
import { activityLogger } from '@/services/trading/ActivityLogger'
import { tradeLogger } from '@/services/trading/TradeLogger'
import { KellySizer } from '@/services/trading/KellySizer'
import { edgeTracker } from '@/services/trading/EdgeTracker'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'
import { rejectionTracker } from '@/services/trading/RejectionTracker'
import {
  computeSignal as _computeSignal,
  computeVolatility as _computeVolatility,
  classifyRegime as _classifyRegime,
  computeRSI as _computeRSI,
  linearRegressionSlope as _linearRegressionSlope,
  fuseBtcSignals,
} from './btcupdown/signalEngine'
import type { LLMDirectionSignal } from './btcupdown/signalEngine'

// Re-export types from signalEngine for backward compatibility
export type { SignalInput, Signal, CrossAssetSnapshot } from './btcupdown/signalEngine'
import type { SignalInput, Signal } from './btcupdown/signalEngine'

// ==========================================
// DEFAULTS
// ==========================================

const DEFAULT_CONFIG: BtcUpDownConfig = {
  enableBtc: true,
  enableEth: false,
  enableSol: false,            // Disabled — focus capital on fewer, higher-conviction trades
  enableXrp: false,
  enable5m: false,      // 5m OFF — signal is noise, snipe formula was broken, 0% win rate
  enable15m: false,     // 15m OFF — too noisy for directional signal
  enableHourly: true,   // Hourly windows — more data, better signal
  enable4h: true,       // 4hr windows — primary focus (strongest edge)
  enableDaily: false,
  tradeSize: 1.00,      // Reduced from $1.50 — preserve capital while signal proves itself
  useKellySizing: true,
  minConfidence: 0.55,  // Only trade strong signals (top ~15% of outputs)
  maxEntryPrice: 0.45,         // Tightened — better payout asymmetry on resolution
  minEntryPrice: 0.10,         // Low floor — only reject extreme long-shots
  minWindowRemaining: 120,     // 2 min before resolution for 15m
  minTimeIntoWindowMs: 60_000, // 60s into window — need enough data for meaningful signal
  regimeFilterEnabled: true,   // Skip choppy/mean-reverting markets
  rsiFilterEnabled: true,      // Reduce confidence on overbought/oversold
  scanIntervalMs: 15_000,
  maxConcurrentPositions: 3,   // One per asset — allow parallel BTC/ETH/SOL trades
  maxEntriesPerMarket: 1,      // One shot per window — preserve capital
  cooldownMs: 60_000,          // 60s cooldown — avoid rapid-fire noise trades
  stopLossPercent: 0.15,       // Cut losers fast at -15% (was -25%)
  takeProfitPercent: 0.40,     // Let winners run to +40% (was +20%) — fix SL/TP asymmetry
  maxHoldMs: 12 * 60 * 1000,  // 12min — exit before 15m resolution if unfilled
  useLLMConfirmation: false,   // LLM confirmation gate on hourly+ windows (opt-in)
  useLLMFusion: false,         // LLM signal fusion — independent direction prediction (opt-in)
}

/** Baseline window duration — all time-based config params are calibrated for this */
const BASELINE_WINDOW_MS = 15 * 60 * 1000

/** Supported window durations in ms */
export const WINDOW_DURATIONS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  'hourly': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  'daily': 24 * 60 * 60 * 1000,
} as const

export type WindowDuration = keyof typeof WINDOW_DURATIONS

const _ASSET_NAMES: Record<string, string> = {
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
  BTC: { '5m': 'btc-updown-5m-', '15m': 'btc-updown-15m-', '4h': 'btc-updown-4h-' },
  ETH: { '5m': 'eth-updown-5m-', '15m': 'eth-updown-15m-', '4h': 'eth-updown-4h-' },
  SOL: { '5m': 'sol-updown-5m-', '15m': 'sol-updown-15m-', '4h': 'sol-updown-4h-' },
  XRP: { '5m': 'xrp-updown-5m-', '15m': 'xrp-updown-15m-', '4h': 'xrp-updown-4h-' },
}

/** Full asset names used in human-readable hourly/daily slugs */
const ASSET_FULL_NAMES: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'xrp',
}

/** Month names for human-readable hourly/daily slugs (lowercase, matches Polymarket format) */
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

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
 * Hourly event slugs: {asset}-up-or-down-{month}-{day}-{year}-{hour}{am/pm}-et
 * e.g. bitcoin-up-or-down-march-19-2026-1pm-et
 */
export function buildHourlySlug(asset: string, utcDate: Date): string {
  const fullName = ASSET_FULL_NAMES[asset]
  if (!fullName) return ''
  const { etDate, hour12, ampm } = toEasternTime(utcDate)
  return `${fullName}-up-or-down-${MONTH_NAMES[etDate.getMonth()]}-${etDate.getDate()}-${etDate.getFullYear()}-${hour12}${ampm}-et`
}

/**
 * Daily event slugs: {asset}-up-or-down-on-{month}-{day}-{year}
 * e.g. bitcoin-up-or-down-on-march-19-2026
 */
function buildDailySlug(asset: string, utcDate: Date): string {
  const fullName = ASSET_FULL_NAMES[asset]
  if (!fullName) return ''
  const { etDate } = toEasternTime(utcDate)
  return `${fullName}-up-or-down-on-${MONTH_NAMES[etDate.getMonth()]}-${etDate.getDate()}-${etDate.getFullYear()}`
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
 * Crypto Up/Down Strategy
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
  name = 'Crypto Up/Down'
  description = 'Resolution-hold on cheap outcomes using multi-factor signals'
  strategyType = 'mechanical' as const

  private btcConfig: BtcUpDownConfig = DEFAULT_CONFIG
  private scanTimeout: number | null = null

  // Market tracking
  private activeMarkets = new Map<string, {
    market: Market
    windowOpenPrice: number
    asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'
    windowEndMs: number
    windowDurationMs: number  // 900_000 (15m) or longer for hourly/daily
    durationKey: string       // '5m' | '15m' | 'hourly' | 'daily'
  }>()
  private positionsByWindow = new Map<string, number>()
  private lastTradeTimes = new Map<string, number>()
  /** Sparse oracle-based history (legacy, kept for fallback) */
  private priceHistory = new Map<string, Array<{ price: number; timestamp: number }>>()
  /** High-frequency 1s price buffer from BinanceWS — 300 entries per asset (~5 min) */
  private highFreqPrices = new Map<string, Array<{ price: number; timestamp: number }>>()
  /** Volume buffer from BinanceWS — tracks 24h rolling volume at each tick for MRO oscillator */
  private volumeHistory = new Map<string, Array<{ volume: number; timestamp: number }>>()
  /** Unsubscribe function for BinanceWS price updates */
  private binanceUnsubscribe: (() => void) | null = null
  /** Cached reference price from market question — keyed by "{asset}:{windowStartMs}" */
  private windowOpenPriceCache = new Map<string, number>()
  /** Last computed signal per asset — exposed for dashboard display */
  private _lastSignals = new Map<string, { signal: Signal; windowOpenPrice: number; currentPrice: number }>()
  /** Cached RealtimeService reference (set in start(), null if unavailable) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically imported RealtimeService
  private realtimeServiceRef: any | null = null
  /** Map CLOB tokenId → { asset, outcomeIndex } for reverse-lookup on live price reads */
  private tokenToOutcomeMap = new Map<string, { asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'; outcomeIndex: number }>()
  // Maps marketId → [tokenId0, tokenId1] for WS subscription and live price lookups
  private marketOutcomeTokenIds = new Map<string, string[]>()
  /** Unsubscribe function for RealtimeService price callback */
  private realtimeUnsubscribe: (() => void) | null = null
  /** Per-market LLM fusion cooldown — prevents excessive LLM calls (60s min between calls per market) */
  private lastLLMFusionCallTimes = new Map<string, number>()
  /** Chainlink feed unsubscribe */
  private chainlinkUnsubscribe: (() => void) | null = null
  /** Cached ChainlinkFeedService reference (set in start(), null if unavailable) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically imported
  private chainlinkServiceRef: any | null = null
  /** Latest Chainlink BTC price (updated every ~2s from on-chain) */
  private chainlinkPrice: { priceUSD: number; updatedAt: number } | null = null

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
      enable4h: s.btcEnable4h,
      enableDaily: s.btcEnableDaily,
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
      useLLMFusion: s.btcUseLLMFusion,
    }
    this.btcConfig = { ...DEFAULT_CONFIG, ...persisted, ...config }
    this._config = { enabled: false, ...this.btcConfig }
  }

  async initialize(): Promise<void> {
    this.log('Crypto Up/Down Strategy initialized')
    this.setStatus('idle')
  }

  async start(): Promise<void> {
    if (this._status === 'running') return

    const earlyExit = useSettingsStore.getState().btcEarlyExitEnabled
    this.log(`Starting Crypto Up/Down Strategy (${earlyExit ? 'early-exit' : 'resolution-hold'} mode)`)
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
        // Keep last 1800 entries (~30 min at 1s) — sufficient for hourly/4hr regime detection
        if (buffer.length > 1800) buffer.shift()
        this.highFreqPrices.set(asset, buffer)

        // Buffer volume for MRO oscillator (24h rolling volume at each tick)
        if (update.volume24hUSD > 0) {
          const volBuf = this.volumeHistory.get(asset) || []
          volBuf.push({ volume: update.volume24hUSD, timestamp: update.timestamp })
          if (volBuf.length > 1800) volBuf.shift()
          this.volumeHistory.set(asset, volBuf)
        }
      })
      this.log('BinanceWS subscribed — 1s price buffer active')
    } catch (error) {
      this.logError('BinanceWS subscription failed — using sparse oracle data', error)
    }

    // Subscribe to Chainlink on-chain price feed (resolution-source for Crypto Up/Down)
    try {
      const { chainlinkFeedService } = await import('@/services/trading/ChainlinkFeedService')
      // Determine which assets need Chainlink feeds
      const chainlinkSymbols: Array<'BTC' | 'ETH' | 'SOL' | 'XRP'> = []
      if (this.btcConfig.enableBtc) chainlinkSymbols.push('BTC')
      if (this.btcConfig.enableEth) chainlinkSymbols.push('ETH')
      if (this.btcConfig.enableSol) chainlinkSymbols.push('SOL')
      if (this.btcConfig.enableXrp) chainlinkSymbols.push('XRP')

      this.chainlinkServiceRef = chainlinkFeedService
      chainlinkFeedService.startPolling(2000, chainlinkSymbols)
      this.chainlinkUnsubscribe = chainlinkFeedService.onPriceUpdate((price) => {
        if (price.symbol === 'BTC') {
          this.chainlinkPrice = { priceUSD: price.priceUSD, updatedAt: price.updatedAt * 1000 }
        }
      })
      this.log(`Chainlink feed active — polling ${chainlinkSymbols.join(',')} every 2s (resolution-source)`)
    } catch (error) {
      this.logError('Chainlink feed failed — using Binance/RTDS fallback', error)
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
          this.log(`[WS] Live price pipeline active (first update for ${tokenId.slice(0, 20)}…)`)
          firstPriceLogged = true
        }
      })
    } catch (error) {
      this.logError('WebSocket connection failed — will use Gamma mid-prices as fallback', error)
    }

    // Immediate first scan, then adaptive scheduling
    await this.runScanCycle()
    this.scheduleNextScan()

    activityLogger.logSystem('Crypto Up/Down Strategy started (resolution-hold mode)')
  }

  async stop(): Promise<void> {
    this.log('Stopping Crypto Up/Down Strategy')

    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout)
      this.scanTimeout = null
    }

    // Unsubscribe from BinanceWS
    if (this.binanceUnsubscribe) {
      this.binanceUnsubscribe()
      this.binanceUnsubscribe = null
    }

    // Stop Chainlink polling
    if (this.chainlinkUnsubscribe) {
      this.chainlinkUnsubscribe()
      this.chainlinkUnsubscribe = null
    }
    try {
      const { chainlinkFeedService } = await import('@/services/trading/ChainlinkFeedService')
      chainlinkFeedService.stopPolling()
    } catch { /* already stopped */ }
    this.chainlinkPrice = null
    this.chainlinkServiceRef = null

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
    this.volumeHistory.clear()
    this.windowOpenPriceCache.clear()
    this._lastSignals.clear()
    this.tokenToOutcomeMap.clear()
    this.marketOutcomeTokenIds.clear()

    this.setStatus('idle')
    activityLogger.logSystem('Crypto Up/Down Strategy stopped')
  }

  // ==========================================
  // SCAN LOOP
  // ==========================================

  private async runScanCycle(): Promise<void> {
    if (!this._enabled || this._status !== 'running') {
      this.log(`[Scan] Skipped — enabled=${this._enabled}, status=${this._status}`)
      return
    }

    // Skip scanning when emergency stop is active — avoid pointless log spam
    try {
      const { riskManager } = await import('@/services/trading/RiskManager')
      if (riskManager.emergencyStopped) return
    } catch { /* proceed if import fails */ }

    try {
      // 1. Discover markets for enabled assets
      await this.discoverMarkets()

      this.log(`[Scan] Active markets: ${this.activeMarkets.size}`)
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
        if (this.btcConfig.enable4h) durations.push('4h')
        if (this.btcConfig.enableDaily) durations.push('daily')

        // Synthetic dry-run: fabricate a market from live price data so the full
        // pipeline (signal → gates → sizing → PLM) can be exercised between windows.
        const isDryRun = useSettingsStore.getState().dryRun
        if (isDryRun && assets.length > 0) {
          const syntheticAsset = assets[0] as 'BTC' | 'ETH' | 'SOL' | 'XRP'
          await this.runSyntheticDryRun(syntheticAsset)
          return
        }

        const msg = `BTC: No Up/Down markets found (scanning ${durations.join('/')} for ${assets.join('/')})`
        this.log(`[Scan] ${msg}`)
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
        this.log(`[Scan] BLOCKED: position limit ${btcPositionCount}/${this.btcConfig.maxConcurrentPositions}`)
        rejectionTracker.record('position_limit', 'btc', `${btcPositionCount}/${this.btcConfig.maxConcurrentPositions} BTC positions`)
        return
      }

      // 3. Analyze each active market
      for (const [marketId, entry] of this.activeMarkets) {
        if (!this._enabled) break
        if ((this.positionsByWindow.get(marketId) ?? 0) >= this.btcConfig.maxEntriesPerMarket) {
          this.log(`[Scan] ${entry.asset}: maxEntries reached for ${marketId.slice(0, 8)}`)
          continue
        }

        // Skip markets whose window hasn't started yet (next-window pre-discovery)
        const windowStartMs = entry.windowEndMs - entry.windowDurationMs
        if (Date.now() < windowStartMs) continue

        // === SNIPE MODE: Chainlink-driven last-window sniping ===
        // In the final seconds, Chainlink price IS the resolution price.
        // Skip cooldown and normal signal — use on-chain truth directly.
        const snipe = this.getSnipeSignal(entry)
        if (snipe) {
          console.log(
            `[BTC SNIPE] ${entry.asset} ${entry.durationKey}: Chainlink $${snipe.chainlinkPrice.toFixed(2)} → ` +
            `${snipe.direction.toUpperCase()} (conf ${(snipe.confidence * 100).toFixed(0)}%, ` +
            `${Math.round((entry.windowEndMs - Date.now()) / 1000)}s to close)`,
          )
          await this.executeSnipe(entry.market, entry, snipe)
          continue
        }

        const lastTrade = this.lastTradeTimes.get(marketId) || 0
        // Scale cooldown proportionally to window duration
        const timeScale = entry.windowDurationMs / BASELINE_WINDOW_MS
        const scaledCooldown = this.btcConfig.cooldownMs * timeScale
        if (Date.now() - lastTrade < scaledCooldown) continue

        this.log(`[Scan] Analyzing ${entry.asset} ${entry.durationKey} market ${marketId.slice(0, 8)}...`)
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
        volumeHistory: this.volumeHistory.get(asset),
        market: syntheticMarket,
      }

      const signal = await this.computeSignal(signalInput)

      // Emit for dashboard display
      this._lastSignals.set(asset, { signal, windowOpenPrice, currentPrice })
      this.emit('signalComputed', { asset, signal, windowOpenPrice, currentPrice, market })

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

      // Calibrate + edge gate (same as real trading path)
      const { btcCalibrationService } = await import('@/services/trading/BtcCalibrationService')
      const calConf = btcCalibrationService.calibrate(signal.confidence)
      const dryRunSettings = useSettingsStore.getState()
      const minEdge = dryRunSettings.btcMinEdgeOverMarket
      if (calConf <= targetPrice + minEdge) {
        rejectionTracker.record('edge_gate', 'btc', `${logPrefix} conf ${(calConf * 100).toFixed(0)}% <= required ${((targetPrice + minEdge) * 100).toFixed(0)}%`)
        return
      }

      const positionSize = await this.calculatePositionSize(calConf, targetPrice, false)

      this.log(`${logPrefix} SIGNAL: ${signal.direction.toUpperCase()} @ ${(targetPrice * 100).toFixed(0)}c (cal ${(calConf * 100).toFixed(0)}%, $${positionSize.toFixed(2)})`)

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
          asset: 'BTC',
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

    const intervalMs = this.getAdaptiveScanInterval()
    this.scanTimeout = window.setTimeout(async () => {
      await this.runScanCycle()
      this.scheduleNextScan()
    }, intervalMs)
  }

  /**
   * Adaptive scan interval based on market state.
   * - No active markets: 8s (discovery-only, no need to hammer Gamma)
   * - Active window, early (<30%): 5s (gathering data, not yet decision time)
   * - Active window, decision phase (30-80%): 3s (critical trading window)
   * - Active window, late (80-93%): 5s (winding down, positions resolving)
   * - SNIPE ZONE (last ~60s for 15m, last ~20s for 5m): 1.5s (Chainlink-driven sniping)
   */
  private getAdaptiveScanInterval(): number {
    if (this.activeMarkets.size === 0) return 8_000

    const now = Date.now()
    let mostUrgentRatio = 0 // highest = most into window
    let closestWindowEndMs = Infinity

    for (const entry of this.activeMarkets.values()) {
      const windowStartMs = entry.windowEndMs - entry.windowDurationMs
      const elapsed = now - windowStartMs
      const ratio = Math.max(0, Math.min(1, elapsed / entry.windowDurationMs))
      if (ratio > mostUrgentRatio) mostUrgentRatio = ratio
      if (entry.windowEndMs < closestWindowEndMs) closestWindowEndMs = entry.windowEndMs
    }

    // Snipe zone: last 60s of any active window — maximum scan frequency
    const timeToClose = closestWindowEndMs - now
    if (timeToClose > 0 && timeToClose <= 60_000) return 1_500

    if (mostUrgentRatio > 0.80) return 5_000   // late: winding down
    if (mostUrgentRatio > 0.30) return 3_000   // decision phase
    return 5_000                                 // early: gathering data
  }

  /**
   * Check if a market is in the snipe zone (last 60s for 15m, last 20s for 5m).
   * Returns the Chainlink-derived direction if snipeable, null otherwise.
   */
  private getSnipeSignal(
    entry: { windowEndMs: number; windowDurationMs: number; windowOpenPrice: number; asset: string },
  ): { direction: 'up' | 'down'; confidence: number; chainlinkPrice: number } | null {
    const now = Date.now()
    const timeRemainingMs = entry.windowEndMs - now

    // Snipe zone: scaled by window duration — more time for longer windows
    const snipeWindowMs = entry.windowDurationMs <= 5 * 60 * 1000 ? 20_000      // 5m: 20s
      : entry.windowDurationMs <= 15 * 60 * 1000 ? 60_000                       // 15m: 60s
      : entry.windowDurationMs <= 60 * 60 * 1000 ? 120_000                      // hourly: 2 min
      : entry.windowDurationMs <= 4 * 60 * 60 * 1000 ? 300_000                  // 4h: 5 min
      : 600_000                                                                   // daily: 10 min
    if (timeRemainingMs <= 0 || timeRemainingMs > snipeWindowMs) return null

    // Need Chainlink price (the resolution source)
    let chainlinkPriceUSD: number | null = null

    // For BTC, use the locally cached Chainlink price (updated every 2s)
    if (entry.asset === 'BTC' && this.chainlinkPrice) {
      const ageMs = now - this.chainlinkPrice.updatedAt
      if (ageMs < 10_000) chainlinkPriceUSD = this.chainlinkPrice.priceUSD
    }

    // For other assets, use cached service ref (set during start())
    if (!chainlinkPriceUSD && this.chainlinkServiceRef) {
      const cached = this.chainlinkServiceRef.getCachedPrice(entry.asset, 10_000)
      if (cached) chainlinkPriceUSD = cached.priceUSD
    }

    if (!chainlinkPriceUSD) return null

    const refPrice = entry.windowOpenPrice
    const displacement = (chainlinkPriceUSD - refPrice) / refPrice

    // Direction is deterministic: if Chainlink > ref, outcome = Up
    const direction: 'up' | 'down' = displacement >= 0 ? 'up' : 'down'

    // Confidence must be EARNED from displacement, not gifted by proximity to close.
    // Previous formula started at 60% on entry — coin-flipping with fees.
    // New: displacement-driven with time as a minor kicker (max +10%).
    //   0.10% displacement → 0.30 confidence (below any sane gate)
    //   0.30% displacement → 0.60 confidence (borderline)
    //   0.50% displacement → 0.80 confidence (strong)
    //   1.00% displacement → 0.95+ confidence (very strong)
    const absPct = Math.abs(displacement) * 100
    const timeFactor = 1 - (timeRemainingMs / snipeWindowMs)  // 0 at zone entry, 1 at close

    // Minimum displacement: 0.10% (was 0.05% — too noisy for BTC $36 moves)
    if (absPct < 0.10) return null

    // Displacement-driven confidence: tanh curve saturates near 1.0% displacement
    const displacementConf = Math.tanh(absPct * 1.5)  // 0.10→0.15, 0.30→0.43, 0.50→0.64, 1.0→0.91
    const confidence = Math.min(0.98, displacementConf + timeFactor * 0.10)

    return { direction, confidence, chainlinkPrice: chainlinkPriceUSD }
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
    if (this.btcConfig.enable4h) enabledDurations.push('4h')
    if (this.btcConfig.enableDaily) enabledDurations.push('daily')

    if (assets.length === 0 || enabledDurations.length === 0) {
      this.log(`[Discovery] Nothing to scan — assets: [${assets}], durations: [${enabledDurations}]`)
      return
    }

    // Evict expired markets and associated tracking data
    const now = Date.now()
    for (const [id, entry] of this.activeMarkets) {
      if (entry.windowEndMs < now) {
        // Remove evicted token IDs from lookup map (do NOT unsubscribe — other consumers may need them)
        const evictedTokenIds = this.marketOutcomeTokenIds.get(id)
        if (evictedTokenIds) {
          for (const t of evictedTokenIds) {
            this.tokenToOutcomeMap.delete(t)
          }
          this.marketOutcomeTokenIds.delete(id)
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
          this.log(`[Discovery] ${asset} ${duration}: ${markets.length} markets found via slug`)

          if (markets.length === 0) {
            this.log(`[Discovery] No ${asset} ${duration} Up/Down markets currently active`)
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

            // Subscribe outcome token IDs for live bid/ask via WebSocket
            const outcomeTokenIds = this.marketOutcomeTokenIds.get(market.id)
            if (outcomeTokenIds?.length === 2 && this.realtimeServiceRef) {
              const mOutcomes = market.outcomes || []
              const mUpIdx = mOutcomes.includes('Up') ? mOutcomes.indexOf('Up')
                : mOutcomes.includes('Yes') && market.question.toUpperCase().includes('UP')
                  ? mOutcomes.indexOf('Yes')
                  : 0
              const mDownIdx = mUpIdx === 0 ? 1 : 0

              this.tokenToOutcomeMap.set(outcomeTokenIds[mUpIdx], { asset, outcomeIndex: mUpIdx })
              this.tokenToOutcomeMap.set(outcomeTokenIds[mDownIdx], { asset, outcomeIndex: mDownIdx })
              this.realtimeServiceRef.subscribeMarket(outcomeTokenIds)
              this.log(`[Discovery] Subscribed outcome tokens for ${asset} ${duration}`)
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
    if (duration === 'hourly') return this.discoverBySlugHourly(asset)
    if (duration === 'daily') return this.discoverBySlugDaily(asset)
    const prefix = ASSET_SLUG_PATTERNS[asset]?.[duration]
    if (!prefix) return []
    const intervalSecMap: Record<string, number> = { '5m': 300, '15m': 900, '4h': 14400 }
    const intervalSec = intervalSecMap[duration]
    if (!intervalSec) return []
    const nowSec = Math.floor(Date.now() / 1000)
    const currentWindowStart = Math.floor(nowSec / intervalSec) * intervalSec
    const nextWindowStart = currentWindowStart + intervalSec

    const slugs = [
      `${prefix}${currentWindowStart}`,
      `${prefix}${nextWindowStart}`,
    ]

    return this.discoverFromEventSlugs(slugs, 'slug')
  }

  private async discoverBySlugHourly(asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<Market[]> {
    const now = new Date()
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000)
    return this.discoverFromEventSlugs(
      [buildHourlySlug(asset, now), buildHourlySlug(asset, nextHour)].filter(Boolean) as string[],
      'Hourly',
    )
  }

  private async discoverBySlugDaily(asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'): Promise<Market[]> {
    const now = new Date()
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    return this.discoverFromEventSlugs(
      [buildDailySlug(asset, now), buildDailySlug(asset, tomorrow)].filter(Boolean) as string[],
      'Daily',
    )
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
        const event = await polymarketClient.getEventBySlug(slug)
        if (!event) continue

        // Gamma events have markets array directly
        const eventMarkets = event.markets || []

        for (const m of eventMarkets) {
          if (m.active && !m.closed) {
            markets.push(m)
            // Store THIS market's own clobTokenIds (e.g., [yesToken, noToken])
            // Previously stored cross-market tokens which broke live price lookups
            if (m.clobTokenIds && m.clobTokenIds.length >= 2) {
              this.marketOutcomeTokenIds.set(m.id, m.clobTokenIds)
            }
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
  private getLiveOutcomePrice(tokenId: string | undefined, fallback: number): number {
    if (!tokenId || !this.realtimeServiceRef) return fallback
    const pd = this.realtimeServiceRef.getPrice(tokenId)
    return pd && pd.mid > 0 ? pd.mid : fallback
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
        this.log(`[Gate] ${asset} ${durationKey}: too early — ${Math.round(timeIntoWindowMs/1000)}s into window (need ${Math.round(scaledMinTimeInto/1000)}s)`)
        return
      }

      // === Phase 3d: Liquidity pre-check ===
      try {
        const { orderBookDepth } = await import('@/services/trading/OrderBookDepth')
        const firstTokenId = this.marketOutcomeTokenIds.get(market.id)?.[0]
        if (firstTokenId) {
          const depthCheck = await orderBookDepth.checkBuyDepth(firstTokenId, 0.50, 1.0)
          if (depthCheck.maxFillableUSD < 1.0) {
            this.log(`[Gate] ${asset} ${durationLabel}: LOW LIQUIDITY $${depthCheck.maxFillableUSD.toFixed(2)} < $1`)
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

      // Crypto Up/Down markets use ["Up", "Down"] outcomes (NOT ["Yes", "No"]).
      let upIndex: number, downIndex: number
      let upPrice: number, downPrice: number

      const hasUpDown = market.outcomes.includes('Up') && market.outcomes.includes('Down')
      const hasYesNo = market.outcomes.includes('Yes') && market.outcomes.includes('No')

      if (hasUpDown) {
        upIndex = market.outcomes.indexOf('Up')
        downIndex = market.outcomes.indexOf('Down')
        upPrice = this.getLiveOutcomePrice(this.marketOutcomeTokenIds.get(market.id)?.[upIndex], market.outcomePrices[upIndex])
        downPrice = this.getLiveOutcomePrice(this.marketOutcomeTokenIds.get(market.id)?.[downIndex], market.outcomePrices[downIndex])
      } else if (hasYesNo) {
        const yesIndex = market.outcomes.indexOf('Yes')
        const noIndex = market.outcomes.indexOf('No')
        const questionMeansUp = market.question.toUpperCase().includes('UP')
        upIndex = questionMeansUp ? yesIndex : noIndex
        downIndex = questionMeansUp ? noIndex : yesIndex
        upPrice = this.getLiveOutcomePrice(this.marketOutcomeTokenIds.get(market.id)?.[upIndex], market.outcomePrices[upIndex])
        downPrice = this.getLiveOutcomePrice(this.marketOutcomeTokenIds.get(market.id)?.[downIndex], market.outcomePrices[downIndex])
      } else {
        console.warn(`[BTC] Unrecognized outcomes: ${JSON.stringify(market.outcomes)}`)
        return
      }

      // Build signal input — pass long-term buffer for dual-timeframe regime detection
      // when high-freq is the primary buffer and sparse history has enough data
      const priceBufferLongTerm = (highFreq.length >= 10 && history.length >= 5)
        ? history : undefined

      // Cross-asset correlation: grab live prices of peer assets from BinanceWS.
      // If BTC is being analyzed, include ETH/SOL snapshots so the signal engine
      // can detect macro moves (all crypto moving together = stronger signal).
      let crossAssets: Array<{ asset: 'BTC' | 'ETH' | 'SOL' | 'XRP'; currentPrice: number; windowOpenPrice: number }> | undefined
      try {
        const { binanceWSService } = await import('@/services/realtime/BinanceWSService')
        const peerSymbols: Array<'BTC' | 'ETH' | 'SOL' | 'XRP'> = ['BTC', 'ETH', 'SOL', 'XRP']
        const snapshots: typeof crossAssets = []
        for (const sym of peerSymbols) {
          if (sym === asset) continue
          const cached = binanceWSService.getCachedPrice(sym)
          if (cached) {
            // Use cached open price if we have a market for this peer in the same window,
            // otherwise approximate from 24h open price
            const peerEntry = [...this.activeMarkets.values()].find(m => m.asset === sym)
            const peerWindowOpen = peerEntry?.windowOpenPrice ?? cached.priceUSD / (1 + cached.priceChange24hPct / 100)
            snapshots.push({ asset: sym, currentPrice: cached.priceUSD, windowOpenPrice: peerWindowOpen })
          } else {
            // Fallback: use our own high-freq buffer if BinanceWS hasn't cached this peer yet
            const peerBuffer = this.highFreqPrices.get(sym)
            if (peerBuffer && peerBuffer.length >= 2) {
              const latest = peerBuffer[peerBuffer.length - 1]
              const oldest = peerBuffer[0]
              snapshots.push({ asset: sym, currentPrice: latest.price, windowOpenPrice: oldest.price })
            }
          }
        }
        if (snapshots.length > 0) crossAssets = snapshots
      } catch {
        // BinanceWS unavailable — try high-freq buffer directly
        const peerSymbols: Array<'BTC' | 'ETH' | 'SOL' | 'XRP'> = ['BTC', 'ETH', 'SOL', 'XRP']
        const snapshots: NonNullable<typeof crossAssets> = []
        for (const sym of peerSymbols) {
          if (sym === asset) continue
          const peerBuffer = this.highFreqPrices.get(sym)
          if (peerBuffer && peerBuffer.length >= 2) {
            const latest = peerBuffer[peerBuffer.length - 1]
            const oldest = peerBuffer[0]
            snapshots.push({ asset: sym, currentPrice: latest.price, windowOpenPrice: oldest.price })
          }
        }
        if (snapshots.length > 0) crossAssets = snapshots
      }

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
        crossAssets,
        volumeHistory: this.volumeHistory.get(asset),
        market,
      }

      // Multi-factor mechanical signal (with vol normalization + RSI)
      const signal = await this.computeSignal(signalInput)

      // Historical enrichment — non-blocking, best-effort confidence adjustment
      let historicalWinRate: number | null = null
      let historicalSampleSize = 0
      try {
        const apiKey = useSettingsStore.getState().polyBacktestApiKey || import.meta.env.VITE_POLYBACKTEST_API_KEY
        if (apiKey) {
          const { historicalEnrichment } = await import('./btcupdown/HistoricalEnrichment')
          const hour = new Date().getUTCHours()
          const dow = new Date().getUTCDay()
          const durationKeyMap: Record<string, string> = { '5m': '5m', '15m': '15m', 'hourly': '1hr', '4h': '4hr', 'daily': '24hr' }
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

      // Store for dashboard display + emit event for real-time UI updates
      this._lastSignals.set(asset, { signal, windowOpenPrice, currentPrice })
      this.emit('signalComputed', { asset, signal, windowOpenPrice, currentPrice, market })

      this.log(
        `${asset} ${durationLabel} signal: ${signal.direction.toUpperCase()} conf=${(signal.confidence * 100).toFixed(0)}% ` +
        `(price $${currentPrice.toFixed(2)} vs ref $${windowOpenPrice.toFixed(2)}, ` +
        `${Math.round(timeIntoWindowMs / 1000)}s into ${durationLabel}, ${priceBuffer.length} readings)`,
      )

      // Gate: confidence
      if (signal.confidence < this.btcConfig.minConfidence) {
        this.log(`[Gate] ${asset} ${durationLabel}: confidence ${(signal.confidence * 100).toFixed(0)}% < ${(this.btcConfig.minConfidence * 100).toFixed(0)}% min`)
        rejectionTracker.record('confidence', 'btc', `${asset} ${durationLabel} ${(signal.confidence * 100).toFixed(0)}% < ${(this.btcConfig.minConfidence * 100).toFixed(0)}%`)
        return
      }

      // Gate: Moon Dev HLP sentiment — contrarian filter using retail positioning z-scores.
      // Extreme z-score opposing our signal direction = skip trade (retail crowded on our side).
      {
        const sentSettings = useSettingsStore.getState()
        if (sentSettings.moondevSentimentEnabled && sentSettings.moondevApiKey) {
          try {
            const { moonDevSentimentService } = await import('@/services/trading/MoonDevSentimentService')
            if (moonDevSentimentService.isRunning() && moonDevSentimentService.shouldFilterTrade(asset, signal.direction)) {
              const sentSignal = moonDevSentimentService.getSentimentSignal(asset)
              rejectionTracker.record('sentiment', 'btc', `${asset} ${durationLabel} HLP z=${sentSignal?.zScore.toFixed(1)} opposes ${signal.direction}`)
              return
            }
          } catch { /* non-blocking */ }
        }
      }

      // Gate: LLM signal fusion — independent directional prediction fused with mechanical signal.
      // Takes priority over confirmation when both are enabled.
      const settings = useSettingsStore.getState()
      const useLLMFusion = this.btcConfig.useLLMFusion ?? settings.btcUseLLMFusion
      const llmFusionWeight = settings.btcLLMFusionWeight ?? 0.30
      const llmFusionPreFilter = settings.btcLLMFusionPreFilter ?? 0.30

      if (useLLMFusion && signal.confidence >= llmFusionPreFilter) {
        const llmPrediction = await this.llmFusion(asset, signalInput, durationLabel)
        if (llmPrediction) {
          const preFusionConf = signal.confidence
          const fused = fuseBtcSignals(signal, llmPrediction, llmFusionWeight)
          signal.confidence = fused.confidence
          signal.direction = fused.direction
          this.log(
            `[LLM Fusion] ${asset} ${durationLabel}: mech=${(preFusionConf * 100).toFixed(0)}% ${signal.direction.toUpperCase()} + ` +
            `llm=${(llmPrediction.confidence * 100).toFixed(0)}% ${llmPrediction.direction.toUpperCase()} → ` +
            `fused=${(signal.confidence * 100).toFixed(0)}% (${fused.direction === llmPrediction.direction ? 'AGREE' : 'DISAGREE'})`,
          )
          // Re-check confidence after fusion
          if (signal.confidence < this.btcConfig.minConfidence) {
            rejectionTracker.record('llm_fusion', 'btc', `${asset} ${durationLabel} post-fusion ${(signal.confidence * 100).toFixed(0)}% < ${(this.btcConfig.minConfidence * 100).toFixed(0)}%`)
            return
          }
        } else {
          this.log(`[LLM Fusion] ${asset} ${durationLabel}: LLM returned null — proceeding with mechanical signal`)
        }
      } else if (this.btcConfig.useLLMConfirmation) {
        // Fallback: legacy LLM confirmation gate (when fusion is off)
        const llmResult = await this.llmConfirmation(asset, signal, signalInput, durationLabel, windowDurationMs - timeIntoWindowMs, {
          historicalWinRate,
          historicalSampleSize,
        })
        if (llmResult === null) {
          rejectionTracker.record('llm_veto', 'btc', `${asset} ${durationLabel} LLM vetoed trade`)
          return
        }
        signal.confidence = Math.max(0, Math.min(1, llmResult.adjustedConfidence))
        this.log(`[LLM] ${asset} ${durationLabel} ${signal.direction.toUpperCase()} → ${llmResult.reasoning} (adj ${(signal.confidence * 100).toFixed(0)}%)`)
        if (signal.confidence < this.btcConfig.minConfidence) {
          rejectionTracker.record('llm_confidence', 'btc', `${asset} ${durationLabel} post-LLM ${(signal.confidence * 100).toFixed(0)}% < ${(this.btcConfig.minConfidence * 100).toFixed(0)}%`)
          return
        }
      }

      // Gate: cross-exchange price confirmation — skip trades when Binance and Crypto.com prices diverge
      {
        const xSettings = useSettingsStore.getState()
        if (xSettings.btcCrossExchangeEnabled) {
          try {
            const { cryptoComClient } = await import('@/services/api/CryptoComClient')
            const cryptoComPrice = await Promise.race([
              cryptoComClient.getPrice(asset),
              new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
            ])
            if (cryptoComPrice !== null) {
              const divergencePct = Math.abs(currentPrice - cryptoComPrice) / cryptoComPrice
              if (divergencePct > (xSettings.btcCrossExchangeMaxDivergencePct / 100)) {
                this.log(`[Gate] ${asset} ${durationLabel}: CROSS-EXCHANGE DIVERGENCE ${(divergencePct * 100).toFixed(3)}% > ${xSettings.btcCrossExchangeMaxDivergencePct}% (Binance $${currentPrice.toFixed(2)} vs Crypto.com $${(cryptoComPrice as number).toFixed(2)})`)
                rejectionTracker.record('cross_exchange', 'btc', `${asset} ${durationLabel} divergence ${(divergencePct * 100).toFixed(3)}% > ${xSettings.btcCrossExchangeMaxDivergencePct}%`)
                return
              }
            }
          } catch {
            // Crypto.com unavailable — proceed with Binance price (non-blocking)
          }
        }
      }

      // Gate: max entry price (cheap outcomes only for resolution-hold)
      const targetIndex = signal.direction === 'up' ? upIndex : downIndex
      const targetPrice = this.getLiveOutcomePrice(this.marketOutcomeTokenIds.get(market.id)?.[targetIndex], market.outcomePrices[targetIndex])
      this.log(`[Gate] ${asset} ${durationLabel}: ${signal.direction.toUpperCase()} @ ${(targetPrice * 100).toFixed(0)}c (conf ${(signal.confidence * 100).toFixed(0)}%, maxEntry ${(this.btcConfig.maxEntryPrice * 100).toFixed(0)}c)`)
      if (targetPrice > this.btcConfig.maxEntryPrice) {
        this.log(`[Gate] ${asset} ${durationLabel}: PRICE TOO HIGH ${(targetPrice * 100).toFixed(0)}c > ${(this.btcConfig.maxEntryPrice * 100).toFixed(0)}c`)
        rejectionTracker.record('market_filter', 'btc', `${asset} price ${(targetPrice * 100).toFixed(0)}c > ${(this.btcConfig.maxEntryPrice * 100).toFixed(0)}c max`)
        return
      }
      if (targetPrice < this.btcConfig.minEntryPrice) {
        rejectionTracker.record('market_filter', 'btc', `${asset} price ${(targetPrice * 100).toFixed(0)}c < ${(this.btcConfig.minEntryPrice * 100).toFixed(0)}c min (long-shot)`)
        return
      }

      // Determine maker mode before edge gate — fee rate affects required edge
      const makerModeMap: Record<string, boolean> = {
        '5m': settings.btcFiveMinMakerMode,
        '15m': settings.btcFifteenMinMakerMode,
        'hourly': settings.btcHourlyMakerMode,
        '4h': settings.btcFourHourMakerMode,
      }
      const makerModeEnabled = makerModeMap[durationLabel] ?? false

      // Circuit breaker: EdgeTracker blocks if realized edge is negative after 20+ trades
      let edgeFeeRateBps = 0
      if (!makerModeEnabled) {
        try {
          const { dynamicFeeService } = await import('@/services/trading/DynamicFeeService')
          edgeFeeRateBps = dynamicFeeService.estimateDynamicFee(targetPrice, true).feeRateBps
        } catch {
          edgeFeeRateBps = 1000
        }
      }
      if (!edgeTracker.shouldTrade('btc', edgeFeeRateBps)) {
        this.log(`[Gate] ${asset} ${durationLabel}: CIRCUIT BREAKER — realized edge negative after 20+ trades`)
        rejectionTracker.record('edge_gate', 'btc', `${asset} circuit breaker: negative realized edge`)
        return
      }

      // Calibrate signal confidence using historical win rates
      const { btcCalibrationService } = await import('@/services/trading/BtcCalibrationService')
      const calibratedConfidence = btcCalibrationService.calibrate(signal.confidence)

      // Gate: edge over market — calibrated confidence must exceed market price + fees + margin
      const effectiveFee = makerModeEnabled ? 0 : (edgeFeeRateBps / 10_000)
      const minEdge = settings.btcMinEdgeOverMarket
      const requiredConfidence = targetPrice + effectiveFee + minEdge
      if (calibratedConfidence <= requiredConfidence) {
        this.log(
          `[Gate] ${asset} ${durationLabel}: NO EDGE — ` +
          `conf ${(calibratedConfidence * 100).toFixed(0)}% <= ` +
          `market ${(targetPrice * 100).toFixed(0)}% + fee ${(effectiveFee * 100).toFixed(0)}% + edge ${(minEdge * 100).toFixed(0)}%`,
        )
        rejectionTracker.record('edge_gate', 'btc',
          `${asset} conf ${(calibratedConfidence * 100).toFixed(0)}% <= required ${(requiredConfidence * 100).toFixed(0)}%`)
        return
      }

      // Position sizing (fee-adjusted Kelly using calibrated confidence)
      const positionSize = await this.calculatePositionSize(calibratedConfidence, targetPrice, makerModeEnabled)

      this.log(
        `SIGNAL: ${asset} ${signal.direction.toUpperCase()} ` +
        `@ ${(targetPrice * 100).toFixed(0)}c ` +
        `(raw ${(signal.confidence * 100).toFixed(0)}% → cal ${(calibratedConfidence * 100).toFixed(0)}%, $${positionSize.toFixed(2)})`,
      )

      // Execute trade
      // TradingService.placeBet() expects 'yes'/'no' but we pass explicit outcomeIndex
      // which overrides the yes/no mapping. Map index 0 → 'yes', index 1 → 'no'.
      const outcomeStr: 'yes' | 'no' = targetIndex === 0 ? 'yes' : 'no'
      // PostOnly maker orders MUST be priced at or below the best bid to avoid
      // "crosses book" rejection. Using mid-offset can cross when spreads are tight.
      // Read the actual best bid from CLOB WebSocket; fall back to mid - offset.
      let makerLimitPrice: number | undefined
      if (makerModeEnabled) {
        const tokenId = this.marketOutcomeTokenIds.get(market.id)?.[targetIndex]
        const pd = tokenId ? this.realtimeServiceRef?.getPrice(tokenId) : null
        const bestBid = pd && pd.bid > 0 ? pd.bid : 0
        const makerOffset = isFifteenMin ? 0.01 : 0.03
        // Use best bid if available (guaranteed below ask); fall back to mid - offset
        makerLimitPrice = bestBid > 0
          ? Math.max(0.01, bestBid)
          : Math.max(0.01, targetPrice - makerOffset)
      }

      const result = await tradingService.placeBet(
        market,
        outcomeStr,
        positionSize,
        makerModeEnabled
          ? {
              skipGtcFallback: true,
              outcomeIndex: targetIndex,
              stopLossPercent: this.btcConfig.stopLossPercent,
              takeProfitPercent: this.btcConfig.takeProfitPercent,
              strategy: 'btc',
              orderType: 'GTC',
              postOnly: true,
              limitPrice: makerLimitPrice,
              asset: asset,
            }
          : {
              skipGtcFallback: false,
              outcomeIndex: targetIndex,
              stopLossPercent: this.btcConfig.stopLossPercent,
              takeProfitPercent: this.btcConfig.takeProfitPercent,
              strategy: 'btc',
              asset: asset,
            },
      )

      if (!result.success) {
        const isFokKill = result.error?.includes("couldn't be fully filled") || result.error?.includes('FOK')
        const isPostOnlyReject = result.error?.includes('post only') || result.error?.includes('post_only') || result.error?.includes('post-only') || result.error?.includes('crosses book')
        if (isFokKill) {
          activityLogger.logWarning(`BTC ${asset} FOK killed (thin book): ${result.error}`)
        } else if (isPostOnlyReject) {
          activityLogger.logWarning(`BTC ${asset} maker order rejected (would cross spread): ${result.error}`)
        } else {
          activityLogger.logError(`BTC ${asset} trade failed: ${result.error}`)
        }
        return
      }

      // For maker mode GTC orders, hand off to GtcOrderManager for fill tracking
      if (makerModeEnabled && result.success && result.orderId) {
        import('./../../services/trading/GtcOrderManager').then(({ gtcOrderManager }) => {
          const scaledMaxHold = Math.round(this.btcConfig.maxHoldMs * timeScale)
          gtcOrderManager.trackOrder({
            orderId: result.orderId!,
            marketSlug: market.slug,
            outcome: outcomeStr,
            question: market.question,
            side: 'BUY',
            price: makerLimitPrice!,
            size: positionSize / makerLimitPrice!,
            costBasis: positionSize,
            strategy: 'btc',
            stopLossPercent: this.btcConfig.stopLossPercent,
            takeProfitPercent: this.btcConfig.takeProfitPercent,
            placedAt: Date.now(),
            expiresAt: 0,  // GTC has no expiry
            status: 'pending',
            tokenId: market.clobTokenIds?.[targetIndex],
            maxHoldMs: scaledMaxHold,
          })
        }).catch(err => console.warn('[BtcUpDown] GtcOrderManager track failed:', err))
      }

      // Record success
      activityLogger.logTrade(
        `${asset} ${signal.direction.toUpperCase()} $${positionSize.toFixed(2)}${makerModeEnabled ? ' (maker)' : ''}`,
        { marketId: market.id, orderId: result.orderId },
      )
      this.positionsByWindow.set(market.id, (this.positionsByWindow.get(market.id) ?? 0) + 1)
      this.lastTradeTimes.set(market.id, Date.now())

      // Track with PLM (dynamic import for circular dep safety)
      // For pending GTC/maker orders, GtcOrderManager handles PLM handoff on fill.
      // Only track immediately for orders that filled now (FOK/taker).
      if (!result.pending) {
        const filledSize = result.filledSize ?? positionSize / targetPrice
        const scaledMaxHold = Math.round(this.btcConfig.maxHoldMs * timeScale)

        // Early exit: use real TP% + accurate taker fee so PLM sells before resolution
        const { btcEarlyExitEnabled, btcEarlyExitTPPercent } = useSettingsStore.getState()
        const effectiveTP = btcEarlyExitEnabled ? btcEarlyExitTPPercent : this.btcConfig.takeProfitPercent
        let exitFeeBps: number | undefined
        if (btcEarlyExitEnabled) {
          try {
            const { dynamicFeeService } = await import('@/services/trading/DynamicFeeService')
            exitFeeBps = dynamicFeeService.estimateDynamicFee(targetPrice, true).feeRateBps
          } catch { exitFeeBps = 1000 }
        }

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
            takeProfitPercent: effectiveTP,
            strategy: 'btc',
            tokenId: market.clobTokenIds?.[targetIndex],
            maxHoldMs: scaledMaxHold,
            trailingStopPercent: 0.10,
            ...(exitFeeBps != null && { takerFeeBps: exitFeeBps }),
          })
        }).catch(err => console.warn('[BtcUpDown] PLM track failed:', err))
      }

      // Log trade for backtest
      const kellyFraction = useSettingsStore.getState().kellyFraction
      const logFeeBps = makerModeEnabled ? 0 : 1000
      const fStar = KellySizer.polymarketKellyWithFee(signal.confidence, targetPrice, logFeeBps)
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
        calibratedProbability: calibratedConfidence,
      })

      this.emit('tradePlaced', { market, signal, result })
    } catch (error) {
      this.logError(`Analysis failed for ${asset}`, error)
    }
  }

  // ==========================================
  // CHAINLINK SNIPE EXECUTION
  // ==========================================

  /**
   * Execute a last-window snipe using Chainlink-derived direction.
   * Streamlined path: skip signal engine, skip LLM, skip cooldown.
   * Uses FOK for speed (need fill NOW, not maker queue).
   */
  private async executeSnipe(
    market: Market,
    entry: { windowEndMs: number; windowDurationMs: number; windowOpenPrice: number; asset: string; durationKey: string },
    snipe: { direction: 'up' | 'down'; confidence: number; chainlinkPrice: number },
  ): Promise<void> {
    try {
      const asset = entry.asset as 'BTC' | 'ETH' | 'SOL' | 'XRP'

      // Resolve outcome indices (same logic as analyzeAndTrade)
      let upIndex: number, downIndex: number
      const hasUpDown = market.outcomes.includes('Up') && market.outcomes.includes('Down')
      const hasYesNo = market.outcomes.includes('Yes') && market.outcomes.includes('No')

      if (hasUpDown) {
        upIndex = market.outcomes.indexOf('Up')
        downIndex = market.outcomes.indexOf('Down')
      } else if (hasYesNo) {
        const yesIndex = market.outcomes.indexOf('Yes')
        const noIndex = market.outcomes.indexOf('No')
        const questionMeansUp = market.question.toUpperCase().includes('UP')
        upIndex = questionMeansUp ? yesIndex : noIndex
        downIndex = questionMeansUp ? noIndex : yesIndex
      } else {
        return
      }

      const targetIndex = snipe.direction === 'up' ? upIndex : downIndex
      const targetPrice = this.getLiveOutcomePrice(
        this.marketOutcomeTokenIds.get(market.id)?.[targetIndex],
        market.outcomePrices[targetIndex],
      )

      // Gate: max entry price (still respect — don't buy 90c outcomes)
      if (targetPrice > this.btcConfig.maxEntryPrice) {
        this.log(`[SNIPE] ${asset}: price ${(targetPrice * 100).toFixed(0)}c > max ${(this.btcConfig.maxEntryPrice * 100).toFixed(0)}c — skip`)
        return
      }

      // Gate: edge check — snipe confidence must exceed market price + fees
      let feeBps = 0
      try {
        const { dynamicFeeService } = await import('@/services/trading/DynamicFeeService')
        feeBps = dynamicFeeService.estimateDynamicFee(targetPrice, true).feeRateBps
      } catch {
        feeBps = 1000
      }
      const effectiveFee = feeBps / 10_000
      if (snipe.confidence <= targetPrice + effectiveFee) {
        this.log(
          `[SNIPE] ${asset}: NO EDGE — conf ${(snipe.confidence * 100).toFixed(0)}% <= ` +
          `market ${(targetPrice * 100).toFixed(0)}% + fee ${(effectiveFee * 100).toFixed(0)}%`,
        )
        return
      }

      // Size: use Kelly but cap at 2x normal trade size for snipe aggressiveness
      const positionSize = await this.calculatePositionSize(snipe.confidence, targetPrice, false)
      const maxSnipeSize = this.btcConfig.tradeSize * 2
      const snipeSize = Math.min(positionSize, maxSnipeSize)

      this.log(
        `SNIPE: ${asset} ${snipe.direction.toUpperCase()} @ ${(targetPrice * 100).toFixed(0)}c ` +
        `$${snipeSize.toFixed(2)} (Chainlink $${snipe.chainlinkPrice.toFixed(2)} vs ref $${entry.windowOpenPrice.toFixed(2)}, ` +
        `${Math.round((entry.windowEndMs - Date.now()) / 1000)}s left)`,
      )

      // Execute with FOK — need immediate fill, no time for maker queue
      const outcomeStr: 'yes' | 'no' = targetIndex === 0 ? 'yes' : 'no'
      const result = await tradingService.placeBet(
        market,
        outcomeStr,
        snipeSize,
        {
          skipGtcFallback: false,
          outcomeIndex: targetIndex,
          stopLossPercent: this.btcConfig.stopLossPercent,
          takeProfitPercent: this.btcConfig.takeProfitPercent,
          strategy: 'btc',
          asset: asset,
        },
      )

      if (!result.success) {
        activityLogger.logWarning(`BTC SNIPE ${asset} failed: ${result.error}`)
        return
      }

      activityLogger.logTrade(
        `SNIPE ${asset} ${snipe.direction.toUpperCase()} $${snipeSize.toFixed(2)} (Chainlink ${Math.round((entry.windowEndMs - Date.now()) / 1000)}s before close)`,
        { marketId: market.id, orderId: result.orderId },
      )
      this.positionsByWindow.set(market.id, (this.positionsByWindow.get(market.id) ?? 0) + 1)
      this.lastTradeTimes.set(market.id, Date.now())

      // PLM tracking — snipe positions use same early exit setting as regular entries
      const filledSize = result.filledSize ?? snipeSize / targetPrice
      const { btcEarlyExitEnabled: snipeEarlyExit, btcEarlyExitTPPercent: snipeEarlyTP } = useSettingsStore.getState()
      const snipeEffectiveTP = snipeEarlyExit ? snipeEarlyTP : this.btcConfig.takeProfitPercent
      let snipeFeeBps: number | undefined
      if (snipeEarlyExit) {
        try {
          const { dynamicFeeService } = await import('@/services/trading/DynamicFeeService')
          snipeFeeBps = dynamicFeeService.estimateDynamicFee(targetPrice, true).feeRateBps
        } catch { snipeFeeBps = 1000 }
      }
      import('@/services/trading/PositionLifecycleManager').then(m => {
        m.positionLifecycleManager.trackPosition({
          marketSlug: market.slug,
          outcome: outcomeStr,
          question: market.question,
          entryPrice: targetPrice,
          size: filledSize,
          costBasis: snipeSize,
          entryTime: Date.now(),
          stopLossPercent: this.btcConfig.stopLossPercent,
          takeProfitPercent: snipeEffectiveTP,
          strategy: 'btc',
          tokenId: market.clobTokenIds?.[targetIndex],
          maxHoldMs: Math.round(this.btcConfig.maxHoldMs),
          trailingStopPercent: 0.10,
          ...(snipeFeeBps != null && { takerFeeBps: snipeFeeBps }),
        })
      }).catch(err => console.warn('[BtcUpDown] PLM track failed (snipe):', err))

      // TradeLogger
      tradeLogger.logEntry({
        marketId: market.id,
        slug: market.slug,
        question: market.question,
        outcomes: market.outcomes,
        strategy: 'btc',
        side: 'BUY',
        outcome: outcomeStr,
        marketPrice: targetPrice,
        kellyFraction: 0,
        kellyBetSize: 0,
        actualBetSize: snipeSize,
        orderId: result.orderId,
        orderType: 'FOK',
        fillPrice: result.avgPrice,
        filledSize: result.filledSize,
        success: true,
        modelProbability: snipe.confidence,
        calibratedProbability: snipe.confidence,
      })

      this.emit('tradePlaced', { market, signal: { direction: snipe.direction, confidence: snipe.confidence }, result })
    } catch (error) {
      this.logError(`Snipe execution failed for ${entry.asset}`, error)
    }
  }

  // ==========================================
  // LLM CONFIRMATION GATE
  // ==========================================

  /**
   * LLM confirmation gate — asks LLM to verify a mechanical signal before trade.
   * Only called for longer windows (hourly/daily) where latency is acceptable.
   * Returns adjusted confidence or null to veto the trade.
   * Fail-open: returns original confidence on any error (network, budget, parse).
   */
  /**
   * Call LLM for independent directional prediction (no mechanical signal in prompt).
   * Returns null on failure or cooldown (fail-open).
   */
  private async llmFusion(
    asset: string,
    signalInput: SignalInput,
    durationLabel: string,
  ): Promise<LLMDirectionSignal | null> {
    // Per-market cooldown: 60s min between LLM calls
    const cooldownKey = `${asset}-${durationLabel}`
    const lastCall = this.lastLLMFusionCallTimes.get(cooldownKey) ?? 0
    if (Date.now() - lastCall < 60_000) return null

    try {
      const { ollamaService } = await import('@/services/llm/OllamaService')
      const { binanceWSService } = await import('@/services/realtime/BinanceWSService')

      // Build prompt WITHOUT mechanical signal factors — independent opinion
      const bws = binanceWSService.getCachedPrice(asset as 'BTC' | 'ETH' | 'SOL' | 'XRP')
      let binanceSection = ''
      if (bws) {
        const range = bws.high24h - bws.low24h
        const rangePct = bws.priceUSD > 0 ? (range / bws.priceUSD * 100).toFixed(1) : '?'
        binanceSection = `
24H CONTEXT:
- ${asset}: $${bws.priceUSD.toLocaleString()} | 24h: ${bws.priceChange24hPct > 0 ? '+' : ''}${bws.priceChange24hPct.toFixed(1)}%
- Range: $${bws.low24h.toLocaleString()} – $${bws.high24h.toLocaleString()} (${rangePct}%)
- Volume: $${(bws.volume24hUSD / 1e9).toFixed(2)}B`
      }

      const displacement = ((signalInput.currentPrice - signalInput.windowOpenPrice) / signalInput.windowOpenPrice * 100).toFixed(3)

      const prompt = `Predict whether ${asset} price will be ABOVE or BELOW the reference price when this window closes.

WINDOW: ${durationLabel}
- Current ${asset}: $${signalInput.currentPrice.toFixed(2)}
- Reference price: $${signalInput.windowOpenPrice.toFixed(2)}
- Displacement: ${displacement}%${binanceSection}

Based on current price action and market context, will ${asset} finish ABOVE (up) or BELOW (down) the reference price?

Respond ONLY with JSON:
{"direction":"up|down","confidence":0-100,"reasoning":"1-2 sentences"}`

      this.lastLLMFusionCallTimes.set(cooldownKey, Date.now())

      const settings = useSettingsStore.getState()
      const model = settings.btcLLMModel || undefined
      return await ollamaService.predictCryptoDirection(prompt, model)
    } catch (error) {
      console.warn(`[llmFusion] ${asset} ${durationLabel} failed:`, error instanceof Error ? error.message : error)
      return null
    }
  }

  private async llmConfirmation(
    asset: string,
    signal: Signal,
    signalInput: SignalInput,
    durationLabel: string,
    timeRemainingMs: number,
    enrichment: { historicalWinRate: number | null; historicalSampleSize: number },
  ): Promise<{ adjustedConfidence: number; reasoning: string } | null> {
    try {
      const { ollamaService } = await import('@/services/llm/OllamaService')
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
      const result = await ollamaService.analyzeCryptoSignal(prompt, btcModel)

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
  private async computeSignal(input: SignalInput): Promise<Signal> {
    const imbalanceScore = 0

    // Determine effective fee: maker mode = 0% fee, taker mode = dynamic fee from model
    const settingsSnapshot = useSettingsStore.getState()
    const windowDurationKey = Object.entries(WINDOW_DURATIONS).find(([, ms]) => ms === input.windowDurationMs)?.[0] ?? ''
    const makerModeMap2: Record<string, boolean> = {
      '5m': settingsSnapshot.btcFiveMinMakerMode,
      '15m': settingsSnapshot.btcFifteenMinMakerMode,
      'hourly': settingsSnapshot.btcHourlyMakerMode,
      '4h': settingsSnapshot.btcFourHourMakerMode,
    }
    const makerActive = makerModeMap2[windowDurationKey] ?? false

    let effectiveFeeRateBps = 0
    if (!makerActive) {
      // Use DynamicFeeService's calibrated quadratic curve instead of hardcoded 1000 bps.
      // The dynamic fee varies by price level: ~315 bps at 50¢, ~75 bps at 10¢.
      // Falls back to 1000 bps if DynamicFeeService import fails.
      try {
        const { dynamicFeeService } = await import('@/services/trading/DynamicFeeService')
        const targetPrice = input.upPrice <= input.downPrice ? input.upPrice : input.downPrice
        const feeEstimate = dynamicFeeService.estimateDynamicFee(targetPrice, true)
        effectiveFeeRateBps = feeEstimate.feeRateBps
      } catch {
        effectiveFeeRateBps = 1000 // Legacy fallback: 10% flat
      }
    }

    return _computeSignal(input, {
      regimeFilterEnabled: this.btcConfig.regimeFilterEnabled,
      rsiFilterEnabled: this.btcConfig.rsiFilterEnabled,
      baselineWindowMs: BASELINE_WINDOW_MS,
      feeRateBps: effectiveFeeRateBps,
      mroEnabled: settingsSnapshot.btcMroEnabled,
      cvdEnabled: settingsSnapshot.btcCvdEnabled,
    }, imbalanceScore)
  }

  private computeVolatility(prices: Array<{ price: number; timestamp: number }>): number {
    return _computeVolatility(prices)
  }

  classifyRegime(prices: Array<{ price: number; timestamp: number }>): 'choppy' | 'trending' | 'neutral' {
    return _classifyRegime(prices)
  }

  private computeRSI(prices: Array<{ price: number; timestamp: number }>, period = 14): number {
    return _computeRSI(prices, period)
  }

  private linearRegressionSlope(points: Array<{ price: number; timestamp: number }>): number {
    return _linearRegressionSlope(points)
  }

  // ==========================================
  // POSITION SIZING
  // ==========================================

  private async calculatePositionSize(confidence: number, marketPrice: number, makerModeActive: boolean): Promise<number> {
    const pennyMode = useSettingsStore.getState().pennyTraderMode
    // Polymarket CLOB requires minimum 5 shares per order
    if (pennyMode) return Math.max(1.0, 5 * marketPrice)

    if (!this.btcConfig.useKellySizing) {
      return this.btcConfig.tradeSize
    }

    const bankroll = useWalletStore.getState().balance
    const kellyFraction = useSettingsStore.getState().kellyFraction

    // Use dynamic fee rate: 0 for maker mode, DynamicFeeService for taker, 1000 fallback
    let feeRateBps = 1000
    if (makerModeActive) {
      feeRateBps = 0
    } else {
      try {
        const { dynamicFeeService } = await import('@/services/trading/DynamicFeeService')
        feeRateBps = dynamicFeeService.estimateDynamicFee(marketPrice, true).feeRateBps
      } catch { /* keep 1000 bps fallback */ }
    }

    const adaptiveProb = edgeTracker.getAdaptiveModelProb('btc', confidence)

    // Monte Carlo Kelly: bootstrap-adjusted sizing when enabled and sufficient data
    const useMC = useSettingsStore.getState().btcUseMonteCarloKelly
    if (useMC) {
      try {
        const records = tradeLogger.getRecords(200)
        const btcReturns = records
          .filter(r => r.strategy === 'btc' && r.pnlUSD !== undefined)
          .map(r => r.pnlUSD!)
        if (btcReturns.length >= 30) {
          const mc = KellySizer.monteCarloKelly({ returns: btcReturns, marketPrice, feeRateBps })
          if (mc.adjustedFraction > 0) {
            const mcSized = KellySizer.sizeBet({ kellyFraction: 1, bankroll, fullKelly: mc.adjustedFraction })
            const volScalar = this.getVolatilityScalar()
            const raw = Math.round(mcSized * volScalar * 100) / 100
            return Math.max(raw, 1.0, 5 * marketPrice)
          }
        }
      } catch { /* fall through to point-estimate Kelly */ }
    }

    const fStar = KellySizer.polymarketKellyWithFee(adaptiveProb, marketPrice, feeRateBps)
    const sized = KellySizer.sizeBet({ kellyFraction, bankroll, fullKelly: fStar })

    // Volatility-based exposure cap: reduce size during high-vol periods
    const volScalar = this.getVolatilityScalar()

    // Floor at $1.00 (Polymarket minimum order size) to avoid repeated rejections.
    // Also ensure minimum 5 shares (CLOB requirement).
    const raw = Math.round(sized * volScalar * 100) / 100
    const floored = Math.max(raw, 1.0, 5 * marketPrice)

    // Cap to stay within RiskManager's per-market concentration limit.
    // Without this, the 5-share floor can push small bankrolls past the limit.
    const maxConcentration = 0.50  // Match RiskManager.maxPerMarketExposure default
    const concentrationCap = Math.floor(bankroll * maxConcentration * 100) / 100
    if (floored > concentrationCap) {
      this.log(`[Sizing] Capped $${floored.toFixed(2)} → $${concentrationCap.toFixed(2)} (${(maxConcentration * 100).toFixed(0)}% of $${bankroll.toFixed(2)})`)
      return Math.max(concentrationCap, 1.0)
    }
    return floored
  }

  /**
   * Compute a volatility scalar (0.25–1.0) from the high-frequency BinanceWS buffer.
   * Uses 1-min return standard deviation over the last 30+ ticks.
   * - Normal vol (sigma <= 0.001): 1.0 (no reduction)
   * - High vol (sigma > 0.002): 0.50 (halve position)
   * - Extreme vol (sigma > 0.003): 0.25 (quarter position)
   */
  private getVolatilityScalar(): number {
    // Use BTC high-freq buffer as the volatility proxy (most liquid)
    const buffer = this.highFreqPrices.get('BTC')
    if (!buffer || buffer.length < 30) return 1.0

    // Compute return std dev from last 30 ticks
    const recent = buffer.slice(-30)
    const returns: number[] = []
    for (let i = 1; i < recent.length; i++) {
      returns.push((recent[i].price - recent[i - 1].price) / recent[i - 1].price)
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length
    const sigma = Math.sqrt(variance)

    if (sigma > 0.003) return 0.25   // extreme vol: quarter size
    if (sigma > 0.002) return 0.50   // high vol: half size
    return 1.0
  }

  // ==========================================
  // DASHBOARD DATA API
  // ==========================================

  /** Get high-frequency price buffer for an asset (used by AS pricer for vol estimation). */
  getHighFreqPrices(asset: string): Array<{ price: number; timestamp: number }> {
    return this.highFreqPrices.get(asset) ?? []
  }

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

  /** Get all active windows grouped by duration key (for dual-timer dashboard display) */
  getActiveWindows(): Array<{ asset: string; windowStartMs: number; windowEndMs: number; windowDurationMs: number; durationKey: string }> {
    const seen = new Set<string>()
    const windows: Array<{ asset: string; windowStartMs: number; windowEndMs: number; windowDurationMs: number; durationKey: string }> = []
    for (const entry of this.activeMarkets.values()) {
      if (seen.has(entry.durationKey)) continue
      seen.add(entry.durationKey)
      windows.push({
        asset: entry.asset,
        windowStartMs: entry.windowEndMs - entry.windowDurationMs,
        windowEndMs: entry.windowEndMs,
        windowDurationMs: entry.windowDurationMs,
        durationKey: entry.durationKey,
      })
    }
    return windows
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

  /** Get the Market object for a given asset (for DualSideHedge cancel/replace) */
  getActiveMarket(asset: string): Market | undefined {
    for (const entry of this.activeMarkets.values()) {
      if (entry.asset === asset) return entry.market
    }
    return undefined
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
