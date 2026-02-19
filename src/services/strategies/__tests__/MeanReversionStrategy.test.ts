import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MeanRevConfig, SpotPosition, MeanRevSignal } from '@/types'

// ==========================================
// MOCKS — vi.hoisted() runs in the same scope as vi.mock() factories
// ==========================================

// Must use vi.hoisted so the mock factory can reference it (vi.mock is hoisted above const)
const { mockSettingsState } = vi.hoisted(() => {
  const mockSettingsState: Record<string, unknown> = {
    dryRun: true,
    mrEnableBtc: true,
    mrEnableEth: false,
    mrEnableSol: false,
    mrLookbackPeriod: 20,
    mrEntryZScore: 2.0,
    mrExitZScore: 0.5,
    mrTradeSize: 10.0,
    mrScanIntervalMs: 10_000,
    mrStopLossPercent: 0.03,
    mrTakeProfitPercent: 0.02,
    mrMaxHoldMs: 3_600_000,
  }
  return { mockSettingsState }
})

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ ...mockSettingsState }),
  },
}))

// Mock activityLogger
vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: {
    logSystem: vi.fn(),
    logTrade: vi.fn(),
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    logScan: vi.fn(),
    logAnalysis: vi.fn(),
  },
}))

// Mock tradeLogger
vi.mock('@/services/trading/TradeLogger', () => ({
  tradeLogger: {
    logEntry: vi.fn(),
  },
}))

// Mock BinanceWSService
const mockOnPriceUpdate = vi.fn(() => () => {})
vi.mock('@/services/realtime/BinanceWSService', () => ({
  binanceWSService: {
    connect: vi.fn().mockResolvedValue(undefined),
    onPriceUpdate: (...args: unknown[]) => mockOnPriceUpdate(...args),
    disconnect: vi.fn(),
  },
}))

// Mock CoinbaseClient
const mockPlaceMarketOrder = vi.fn()
const mockGetOrder = vi.fn()
const mockGetCandles = vi.fn().mockResolvedValue([])
const mockHasCredentials = vi.fn().mockReturnValue(false)

vi.mock('@/services/api/CoinbaseClient', () => ({
  coinbaseClient: {
    placeMarketOrder: (...args: unknown[]) => mockPlaceMarketOrder(...args),
    getOrder: (...args: unknown[]) => mockGetOrder(...args),
    getCandles: (...args: unknown[]) => mockGetCandles(...args),
    hasCredentials: () => mockHasCredentials(),
    setCredentials: vi.fn(),
  },
  CoinbaseClient: {
    productId: (symbol: string) => `${symbol}-USD`,
  },
}))

// Mock RiskManager
const mockValidateTrade = vi.fn().mockResolvedValue({ approved: true })
const mockRecordTradeResult = vi.fn()
vi.mock('@/services/trading/RiskManager', () => ({
  riskManager: {
    validateTrade: (...args: unknown[]) => mockValidateTrade(...args),
    recordTradeResult: (...args: unknown[]) => mockRecordTradeResult(...args),
  },
}))

// ==========================================
// IMPORT under test (after mocks)
// ==========================================
import { MeanReversionStrategy } from '../MeanReversionStrategy'

// ==========================================
// HELPERS
// ==========================================

/** Create a fresh strategy instance for each test */
function createStrategy(config?: Partial<MeanRevConfig>): MeanReversionStrategy {
  return new MeanReversionStrategy(config)
}

/**
 * Generate prices centered around a mean with a known standard deviation.
 * The last price is the outlier we want to test signal generation with.
 */
function generatePriceBuffer(
  mean: number,
  stdDev: number,
  count: number,
  lastPrice?: number,
): number[] {
  // Create a uniform set of prices that have the desired mean/stdDev
  // Simple approach: alternate above/below mean by exactly stdDev
  const prices: number[] = []
  for (let i = 0; i < count - 1; i++) {
    // Alternate +/- to keep mean stable
    const offset = (i % 2 === 0 ? 1 : -1) * stdDev * 0.5
    prices.push(mean + offset)
  }
  // Add the last price (the current price being evaluated)
  prices.push(lastPrice ?? mean)
  return prices
}

/** Feed prices into strategy's buffer via the price update handler */
function feedPrices(strategy: MeanReversionStrategy, symbol: string, prices: number[]): void {
  // Access the private handlePriceUpdate method via the callback
  // We'll use the internal buffer setter approach
  // @ts-expect-error accessing private for testing
  strategy.priceBuffers.set(symbol, [...prices])
}

/** Set an open position on the strategy */
function setPosition(strategy: MeanReversionStrategy, pos: SpotPosition): void {
  // @ts-expect-error accessing private for testing
  strategy.positions.set(pos.symbol, pos)
}

/** Get open positions count */
function getPositions(strategy: MeanReversionStrategy): SpotPosition[] {
  return strategy.getOpenPositions()
}

// ==========================================
// TESTS
// ==========================================

describe('MeanReversionStrategy', () => {
  let strategy: MeanReversionStrategy

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Reset ALL mutable settings to defaults before each test
    mockSettingsState.dryRun = true
    mockSettingsState.mrEnableBtc = true
    mockSettingsState.mrEnableEth = false
    mockSettingsState.mrEnableSol = false
    mockSettingsState.mrLookbackPeriod = 20
    mockSettingsState.mrEntryZScore = 2.0
    mockSettingsState.mrExitZScore = 0.5
    mockSettingsState.mrTradeSize = 10.0
    mockSettingsState.mrScanIntervalMs = 10_000
    mockSettingsState.mrStopLossPercent = 0.03
    mockSettingsState.mrTakeProfitPercent = 0.02
    mockSettingsState.mrMaxHoldMs = 3_600_000
    strategy = createStrategy()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ------------------------------------------
  // Construction & Config
  // ------------------------------------------

  describe('construction and config', () => {
    it('initializes with default config values', () => {
      const config = strategy.getMrConfig()
      expect(config.lookbackPeriod).toBe(20)
      expect(config.entryZScore).toBe(2.0)
      expect(config.exitZScore).toBe(0.5)
      expect(config.bollingerMultiplier).toBe(2.0)
      expect(config.tradeSize).toBe(10.0)
      expect(config.stopLossPercent).toBe(0.03)
      expect(config.takeProfitPercent).toBe(0.02)
      expect(config.maxHoldMs).toBe(3_600_000)
    })

    it('hydrates config from settingsStore', () => {
      mockSettingsState.mrLookbackPeriod = 30
      mockSettingsState.mrEntryZScore = 2.5
      const s = createStrategy()
      const config = s.getMrConfig()
      expect(config.lookbackPeriod).toBe(30)
      expect(config.entryZScore).toBe(2.5)
    })

    it('accepts constructor overrides that take precedence over settingsStore', () => {
      const s = createStrategy({ lookbackPeriod: 50, entryZScore: 3.0 })
      const config = s.getMrConfig()
      expect(config.lookbackPeriod).toBe(50)
      expect(config.entryZScore).toBe(3.0)
    })

    it('updates config via setMrConfig and emits event', () => {
      const handler = vi.fn()
      strategy.on('configUpdated', handler)

      strategy.setMrConfig({ tradeSize: 25.0, lookbackPeriod: 40 })

      const config = strategy.getMrConfig()
      expect(config.tradeSize).toBe(25.0)
      expect(config.lookbackPeriod).toBe(40)
      expect(handler).toHaveBeenCalledOnce()
    })

    it('getMrConfig returns a copy (not a reference)', () => {
      const config1 = strategy.getMrConfig()
      config1.tradeSize = 999
      const config2 = strategy.getMrConfig()
      expect(config2.tradeSize).toBe(10.0) // unchanged
    })
  })

  // ------------------------------------------
  // Stats / Bollinger Band Math
  // ------------------------------------------

  describe('Z-score / Bollinger Band math', () => {
    it('computeStats returns correct mean and stdDev', () => {
      // @ts-expect-error accessing private method for testing
      const stats = strategy.computeStats([10, 20, 30, 40, 50])
      expect(stats.mean).toBe(30)
      // population stddev: sqrt(((10-30)^2 + (20-30)^2 + (30-30)^2 + (40-30)^2 + (50-30)^2) / 5)
      // = sqrt((400+100+0+100+400)/5) = sqrt(200) ≈ 14.142
      expect(stats.stdDev).toBeCloseTo(14.142, 2)
    })

    it('computeStats handles single-element array', () => {
      // @ts-expect-error accessing private
      const stats = strategy.computeStats([100])
      expect(stats.mean).toBe(100)
      expect(stats.stdDev).toBe(0)
    })

    it('computeStats handles empty array', () => {
      // @ts-expect-error accessing private
      const stats = strategy.computeStats([])
      expect(stats.mean).toBe(0)
      expect(stats.stdDev).toBe(0)
    })

    it('computeStats handles uniform prices (zero stddev)', () => {
      // @ts-expect-error accessing private
      const stats = strategy.computeStats([50, 50, 50, 50])
      expect(stats.mean).toBe(50)
      expect(stats.stdDev).toBe(0)
    })

    it('computes correct Z-score for oversold price', () => {
      // Mean=100, stdDev=10, price=78 → Z = (78-100)/10 = -2.2
      const prices = [90, 110, 90, 110, 90, 110, 90, 110, 90, 110] // mean=100, stdDev=10
      // @ts-expect-error accessing private
      const signal: MeanRevSignal = strategy.computeSignal('BTC', prices, 78)
      expect(signal.zScore).toBe(-2.2)
      expect(signal.action).toBe('buy') // Z=-2.2 <= -2.0 threshold
    })

    it('computes hold signal when Z-score is within thresholds', () => {
      const prices = [90, 110, 90, 110, 90, 110, 90, 110, 90, 110]
      // @ts-expect-error accessing private
      const signal: MeanRevSignal = strategy.computeSignal('BTC', prices, 100)
      expect(signal.zScore).toBeCloseTo(0, 1)
      expect(signal.action).toBe('hold')
    })

    it('computes Bollinger bands correctly', () => {
      const prices = [90, 110, 90, 110, 90, 110, 90, 110, 90, 110]
      // mean=100, stdDev=10, bollinger multiplier=2.0
      // @ts-expect-error accessing private
      const signal: MeanRevSignal = strategy.computeSignal('BTC', prices, 100)
      expect(signal.mean).toBe(100)
      expect(signal.stdDev).toBe(10)
      expect(signal.upperBand).toBeCloseTo(120, 1) // 100 + 2*10
      expect(signal.lowerBand).toBeCloseTo(80, 1)  // 100 - 2*10
    })

    it('returns zero Z-score when stdDev is zero', () => {
      const prices = [100, 100, 100, 100, 100]
      // @ts-expect-error accessing private
      const signal: MeanRevSignal = strategy.computeSignal('BTC', prices, 100)
      expect(signal.zScore).toBe(0)
      expect(signal.action).toBe('hold')
    })

    it('maps confidence from Z-score magnitude', () => {
      const prices = [90, 110, 90, 110, 90, 110, 90, 110, 90, 110]
      // Z = -2.2, entryZScore = 2.0, confidence = min(1, 2.2 / (2.0 * 1.5)) = min(1, 0.733)
      // @ts-expect-error accessing private
      const signal: MeanRevSignal = strategy.computeSignal('BTC', prices, 78)
      expect(signal.confidence).toBeCloseTo(0.733, 2)
    })

    it('caps confidence at 1.0 for extreme Z-scores', () => {
      const prices = [90, 110, 90, 110, 90, 110, 90, 110, 90, 110]
      // price=50: Z = (50-100)/10 = -5.0, confidence = min(1, 5.0/3.0) = 1.0
      // @ts-expect-error accessing private
      const signal: MeanRevSignal = strategy.computeSignal('BTC', prices, 50)
      expect(signal.confidence).toBe(1.0)
    })
  })

  // ------------------------------------------
  // Signal Generation via analyzeSymbol
  // ------------------------------------------

  describe('signal generation', () => {
    it('emits signalComputed on analyzeSymbol', async () => {
      const handler = vi.fn()
      strategy.on('signalComputed', handler)

      // Need _enabled + running for scan loop
      await strategy.enable()

      const prices = [90, 110, 90, 110, 90, 110, 90, 110, 90, 110]
      feedPrices(strategy, 'BTC', prices)

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      expect(handler).toHaveBeenCalledOnce()
      const [, data] = handler.mock.calls[0]
      expect((data as { symbol: string }).symbol).toBe('BTC')
      expect((data as { signal: MeanRevSignal }).signal).toBeDefined()
    })

    it('skips analysis when buffer has fewer than 5 data points', async () => {
      const handler = vi.fn()
      strategy.on('signalComputed', handler)

      feedPrices(strategy, 'BTC', [100, 101, 102, 103]) // only 4

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      expect(handler).not.toHaveBeenCalled()
    })

    it('generates BUY signal for oversold price', async () => {
      await strategy.enable()
      const handler = vi.fn()
      strategy.on('signalComputed', handler)

      // analyzeSymbol uses buffer[last] as currentPrice and computes stats from the FULL buffer.
      // We need Z = (currentPrice - mean) / stdDev <= -2.0 where currentPrice IS in the buffer.
      // 9 prices at 100 + 1 outlier at 60: mean=96, variance = (9×16 + 36²×1)/10 = ...
      // Simpler: use many stable prices + one extreme dip
      const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 60]
      // mean = 96, variance = (9×16 + 1296)/10 = (144+1296)/10 = 144, stdDev=12
      // Z = (60-96)/12 = -3.0 → BUY
      feedPrices(strategy, 'BTC', prices)

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      const [, data] = handler.mock.calls[0]
      const signal = (data as { signal: MeanRevSignal }).signal
      expect(signal.action).toBe('buy')
      expect(signal.zScore).toBeLessThan(-2.0)
    })

    it('generates SELL signal when Z reverts above exit threshold with position', async () => {
      await strategy.enable()
      const handler = vi.fn()
      strategy.on('signalComputed', handler)

      // Put in a position first
      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 95,
        quantity: 0.1,
        costBasis: 9.5,
        entryTime: Date.now(),
        currentPrice: 105,
        unrealizedPnl: 1.0,
        unrealizedPnlPercent: 0.105,
      })

      // mean=100, stdDev=10, current=106 → Z = +0.6 (above exitZScore 0.5)
      const prices = [90, 110, 90, 110, 90, 110, 90, 110, 90, 106]
      feedPrices(strategy, 'BTC', prices)

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      const [, data] = handler.mock.calls[0]
      const signal = (data as { signal: MeanRevSignal }).signal
      expect(signal.action).toBe('sell')
    })

    it('does NOT generate sell signal without open position even if Z > exitZScore', async () => {
      await strategy.enable()
      const handler = vi.fn()
      strategy.on('signalComputed', handler)

      // Z > exitZScore but no position
      const prices = [90, 110, 90, 110, 90, 110, 90, 110, 90, 106]
      feedPrices(strategy, 'BTC', prices)

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      const [, data] = handler.mock.calls[0]
      const signal = (data as { signal: MeanRevSignal }).signal
      expect(signal.action).toBe('hold') // not sell — no position
    })
  })

  // ------------------------------------------
  // Price Buffer Management
  // ------------------------------------------

  describe('buffer management', () => {
    it('handlePriceUpdate adds prices to buffer', () => {
      strategy.setMrConfig({ enableBtc: true })

      // @ts-expect-error calling private
      strategy.handlePriceUpdate({ symbol: 'BTC', priceUSD: 100 })
      // @ts-expect-error calling private
      strategy.handlePriceUpdate({ symbol: 'BTC', priceUSD: 101 })
      // @ts-expect-error calling private
      strategy.handlePriceUpdate({ symbol: 'BTC', priceUSD: 102 })

      const buffer = strategy.getPriceBuffer('BTC')
      expect(buffer).toEqual([100, 101, 102])
    })

    it('trims buffer to lookbackPeriod', () => {
      strategy.setMrConfig({ enableBtc: true, lookbackPeriod: 5 })

      for (let i = 0; i < 10; i++) {
        // @ts-expect-error calling private
        strategy.handlePriceUpdate({ symbol: 'BTC', priceUSD: 100 + i })
      }

      const buffer = strategy.getPriceBuffer('BTC')
      expect(buffer.length).toBe(5)
      expect(buffer[0]).toBe(105) // oldest surviving
      expect(buffer[4]).toBe(109) // newest
    })

    it('ignores price updates for disabled symbols', () => {
      strategy.setMrConfig({ enableBtc: true, enableEth: false })

      // @ts-expect-error calling private
      strategy.handlePriceUpdate({ symbol: 'ETH', priceUSD: 3500 })

      const buffer = strategy.getPriceBuffer('ETH')
      expect(buffer.length).toBe(0)
    })

    it('getPriceBuffer returns a copy', () => {
      feedPrices(strategy, 'BTC', [100, 101, 102])
      const buf1 = strategy.getPriceBuffer('BTC')
      buf1.push(999)
      const buf2 = strategy.getPriceBuffer('BTC')
      expect(buf2.length).toBe(3) // unchanged
    })

    it('updates open position currentPrice on price update', () => {
      strategy.setMrConfig({ enableBtc: true })
      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 100,
        quantity: 0.1,
        costBasis: 10,
        entryTime: Date.now(),
        currentPrice: 100,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
      })

      // @ts-expect-error calling private
      strategy.handlePriceUpdate({ symbol: 'BTC', priceUSD: 105 })

      const positions = getPositions(strategy)
      expect(positions[0].currentPrice).toBe(105)
      expect(positions[0].unrealizedPnl).toBeCloseTo(0.5, 4) // (105-100)*0.1
      expect(positions[0].unrealizedPnlPercent).toBeCloseTo(0.05, 4) // 5%
    })
  })

  // ------------------------------------------
  // Exit Logic
  // ------------------------------------------

  describe('exit conditions', () => {
    it('triggers stop loss when price drops below threshold', () => {
      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 100,
        quantity: 0.1,
        costBasis: 10,
        entryTime: Date.now(),
        currentPrice: 96.5, // -3.5% < -3% SL
        unrealizedPnl: -0.35,
        unrealizedPnlPercent: -0.035,
      })

      // @ts-expect-error calling private
      const shouldExit = strategy.shouldForceExit('BTC')
      expect(shouldExit).toBe(true)

      // @ts-expect-error calling private
      const reason = strategy.getExitReason('BTC', { action: 'hold' } as MeanRevSignal)
      expect(reason).toBe('stop_loss')
    })

    it('triggers take profit when price rises above threshold', () => {
      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 100,
        quantity: 0.1,
        costBasis: 10,
        entryTime: Date.now(),
        currentPrice: 102.5, // +2.5% > +2% TP
        unrealizedPnl: 0.25,
        unrealizedPnlPercent: 0.025,
      })

      // @ts-expect-error calling private
      const shouldExit = strategy.shouldForceExit('BTC')
      expect(shouldExit).toBe(true)

      // @ts-expect-error calling private
      const reason = strategy.getExitReason('BTC', { action: 'hold' } as MeanRevSignal)
      expect(reason).toBe('take_profit')
    })

    it('triggers max hold time exit', () => {
      const entryTime = Date.now() - 4_000_000 // 4M ms > 3.6M ms limit
      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 100,
        quantity: 0.1,
        costBasis: 10,
        entryTime,
        currentPrice: 100,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
      })

      // @ts-expect-error calling private
      expect(strategy.shouldForceExit('BTC')).toBe(true)

      // @ts-expect-error calling private
      const reason = strategy.getExitReason('BTC', { action: 'hold' } as MeanRevSignal)
      expect(reason).toBe('max_hold_time')
    })

    it('returns z_reversion exit reason when signal is sell', () => {
      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 100,
        quantity: 0.1,
        costBasis: 10,
        entryTime: Date.now(),
        currentPrice: 101, // within SL/TP range
        unrealizedPnl: 0.1,
        unrealizedPnlPercent: 0.01,
      })

      // @ts-expect-error calling private
      const reason = strategy.getExitReason('BTC', { action: 'sell' } as MeanRevSignal)
      expect(reason).toBe('z_reversion')
    })

    it('does NOT force exit when position is within all thresholds', () => {
      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 100,
        quantity: 0.1,
        costBasis: 10,
        entryTime: Date.now(),
        currentPrice: 101, // +1% — below TP, above SL
        unrealizedPnl: 0.1,
        unrealizedPnlPercent: 0.01,
      })

      // @ts-expect-error calling private
      expect(strategy.shouldForceExit('BTC')).toBe(false)
    })

    it('returns no_position when checking exit reason without position', () => {
      // @ts-expect-error calling private
      const reason = strategy.getExitReason('BTC', { action: 'hold' } as MeanRevSignal)
      expect(reason).toBe('no_position')
    })
  })

  // ------------------------------------------
  // Trade Execution (Dry Run)
  // ------------------------------------------

  describe('dry run execution', () => {
    it('creates position on buy signal in dry run mode', async () => {
      mockSettingsState.dryRun = true
      strategy = createStrategy({ enableBtc: true })
      await strategy.enable()

      const handler = vi.fn()
      strategy.on('tradePlaced', handler)

      // Oversold buffer: 9 stable prices + extreme dip → Z < -2.0
      const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 60]
      feedPrices(strategy, 'BTC', prices)

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      const positions = getPositions(strategy)
      expect(positions.length).toBe(1)
      expect(positions[0].symbol).toBe('BTC')
      expect(positions[0].side).toBe('LONG')
      expect(positions[0].costBasis).toBe(10.0) // default tradeSize

      expect(handler).toHaveBeenCalledOnce()
      const [, data] = handler.mock.calls[0]
      expect((data as { dryRun: boolean }).dryRun).toBe(true)
    })

    it('does NOT call coinbaseClient in dry run mode', async () => {
      mockSettingsState.dryRun = true
      strategy = createStrategy({ enableBtc: true })
      await strategy.enable()

      const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 60]
      feedPrices(strategy, 'BTC', prices)

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      expect(mockPlaceMarketOrder).not.toHaveBeenCalled()
    })

    it('closes position on dry run sell', async () => {
      mockSettingsState.dryRun = true
      strategy = createStrategy({ enableBtc: true })
      await strategy.enable()

      // Open position
      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 95,
        quantity: 0.105,
        costBasis: 10,
        entryTime: Date.now(),
        currentPrice: 105,
        unrealizedPnl: 1.05,
        unrealizedPnlPercent: 0.105,
      })

      // Price reverted: Z > exitZScore (0.5)
      const prices = [90, 110, 90, 110, 90, 110, 90, 110, 90, 106]
      feedPrices(strategy, 'BTC', prices)

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      const positions = getPositions(strategy)
      expect(positions.length).toBe(0) // position closed
    })

    it('records stats after dry run sell', async () => {
      mockSettingsState.dryRun = true
      strategy = createStrategy({ enableBtc: true })
      await strategy.enable()

      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 95,
        quantity: 0.105,
        costBasis: 10,
        entryTime: Date.now() - 30_000,
        currentPrice: 106,
        unrealizedPnl: 1.155,
        unrealizedPnlPercent: 0.116,
      })

      const prices = [90, 110, 90, 110, 90, 110, 90, 110, 90, 106]
      feedPrices(strategy, 'BTC', prices)

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      const stats = strategy.getStats()
      expect(stats.totalTrades).toBe(1)
      expect(stats.totalPnl).toBeGreaterThan(0) // profitable sell
      expect(stats.winningTrades).toBe(1)
    })
  })

  // ------------------------------------------
  // Cooldown
  // ------------------------------------------

  describe('cooldown', () => {
    it('respects per-symbol cooldown after buy', async () => {
      mockSettingsState.dryRun = true
      strategy = createStrategy({ enableBtc: true, cooldownMs: 60_000 })
      await strategy.enable()

      // First buy — should succeed (buffer gives Z=-3.0, well below -2.0 threshold)
      const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 60]
      feedPrices(strategy, 'BTC', prices)
      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')
      expect(getPositions(strategy).length).toBe(1)

      // Sell to clear position
      // @ts-expect-error accessing private
      strategy.positions.delete('BTC')

      // Second buy immediately — should be blocked by cooldown
      feedPrices(strategy, 'BTC', prices)
      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')
      expect(getPositions(strategy).length).toBe(0) // blocked

      // Advance time past cooldown
      vi.advanceTimersByTime(61_000)

      feedPrices(strategy, 'BTC', prices)
      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')
      expect(getPositions(strategy).length).toBe(1) // allowed now
    })
  })

  // ------------------------------------------
  // RiskManager Integration
  // ------------------------------------------

  describe('RiskManager integration', () => {
    it('skips buy when RiskManager rejects', async () => {
      mockSettingsState.dryRun = true
      mockValidateTrade.mockResolvedValueOnce({ approved: false, reason: 'Daily loss limit' })

      strategy = createStrategy({ enableBtc: true })
      await strategy.enable()

      const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 60]
      feedPrices(strategy, 'BTC', prices)

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      // Signal triggers buy (Z=-3.0) but RiskManager blocks it
      expect(getPositions(strategy).length).toBe(0)
    })
  })

  // ------------------------------------------
  // Symbol Enable/Disable
  // ------------------------------------------

  describe('symbol filtering', () => {
    it('isSymbolEnabled respects config', () => {
      strategy.setMrConfig({ enableBtc: true, enableEth: false, enableSol: true })

      // @ts-expect-error accessing private
      expect(strategy.isSymbolEnabled('BTC')).toBe(true)
      // @ts-expect-error accessing private
      expect(strategy.isSymbolEnabled('ETH')).toBe(false)
      // @ts-expect-error accessing private
      expect(strategy.isSymbolEnabled('SOL')).toBe(true)
      // @ts-expect-error accessing private
      expect(strategy.isSymbolEnabled('DOGE')).toBe(false)
    })

    it('getEnabledSymbols returns only enabled symbols', () => {
      strategy.setMrConfig({ enableBtc: true, enableEth: true, enableSol: false })
      // @ts-expect-error accessing private
      const symbols = strategy.getEnabledSymbols()
      expect(symbols).toEqual(['BTC', 'ETH'])
    })
  })

  // ------------------------------------------
  // Lifecycle
  // ------------------------------------------

  describe('lifecycle', () => {
    it('initialize sets status to idle', async () => {
      await strategy.initialize()
      expect(strategy.status).toBe('idle')
    })

    it('enable calls start and sets _enabled', async () => {
      await strategy.enable()
      expect(strategy.enabled).toBe(true)
      expect(strategy.status).toBe('running')
    })

    it('disable calls stop and clears _enabled', async () => {
      await strategy.enable()
      await strategy.disable()
      expect(strategy.enabled).toBe(false)
      expect(strategy.status).toBe('idle')
    })

    it('stop clears intervals and buffers', async () => {
      await strategy.enable()
      feedPrices(strategy, 'BTC', [100, 101, 102])

      await strategy.stop()

      expect(strategy.getPriceBuffer('BTC').length).toBe(0)
      expect(strategy.getLastSignal('BTC')).toBeNull()
    })

    it('stop does NOT clear open positions', async () => {
      await strategy.enable()
      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 100,
        quantity: 0.1,
        costBasis: 10,
        entryTime: Date.now(),
        currentPrice: 100,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
      })

      await strategy.stop()

      const positions = getPositions(strategy)
      expect(positions.length).toBe(1) // preserved
    })

    it('scan loop guards on _enabled flag', async () => {
      // Don't call enable — only start
      await strategy.start()

      const handler = vi.fn()
      strategy.on('signalComputed', handler)
      feedPrices(strategy, 'BTC', [90, 110, 90, 110, 90, 110, 90, 110, 90, 78])

      // Run a scan — should be blocked because _enabled is false
      // @ts-expect-error calling private
      await strategy.runScanCycle()

      expect(handler).not.toHaveBeenCalled()
    })
  })

  // ------------------------------------------
  // Dashboard Data API
  // ------------------------------------------

  describe('dashboard API', () => {
    it('getLastSignal returns null when no signal computed', () => {
      expect(strategy.getLastSignal('BTC')).toBeNull()
      expect(strategy.getLastSignal('ETH')).toBeNull()
    })

    it('getLastSignal returns latest signal after analysis', async () => {
      await strategy.enable()
      feedPrices(strategy, 'BTC', [90, 110, 90, 110, 90, 110, 90, 110, 90, 100])

      // @ts-expect-error calling private
      await strategy.analyzeSymbol('BTC')

      const signal = strategy.getLastSignal('BTC')
      expect(signal).not.toBeNull()
      expect(signal!.symbol).toBe('BTC')
      expect(signal!.mean).toBeDefined()
      expect(signal!.zScore).toBeDefined()
    })

    it('getOpenPositions returns empty array when no positions', () => {
      expect(getPositions(strategy)).toEqual([])
    })

    it('getOpenPositions returns all open positions', () => {
      setPosition(strategy, {
        symbol: 'BTC',
        side: 'LONG',
        entryPrice: 100,
        quantity: 0.1,
        costBasis: 10,
        entryTime: Date.now(),
        currentPrice: 100,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
      })
      setPosition(strategy, {
        symbol: 'ETH',
        side: 'LONG',
        entryPrice: 3500,
        quantity: 0.003,
        costBasis: 10.5,
        entryTime: Date.now(),
        currentPrice: 3500,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
      })

      const positions = getPositions(strategy)
      expect(positions.length).toBe(2)
    })

    it('strategy has correct metadata', () => {
      expect(strategy.name).toBe('Mean Reversion')
      expect(strategy.strategyType).toBe('mechanical')
    })
  })

  // ------------------------------------------
  // BaseStrategy stats recording
  // ------------------------------------------

  describe('stats recording', () => {
    it('recordTrade updates stats correctly for winning trade', () => {
      // @ts-expect-error calling protected
      strategy.recordTrade(2.50, 10.0, 120_000)

      const stats = strategy.getStats()
      expect(stats.totalTrades).toBe(1)
      expect(stats.winningTrades).toBe(1)
      expect(stats.losingTrades).toBe(0)
      expect(stats.totalPnl).toBe(2.50)
      expect(stats.winRate).toBe(100)
      expect(stats.bestTrade).toBe(2.50)
      expect(stats.avgTradeSize).toBe(10.0)
    })

    it('recordTrade updates stats correctly for losing trade', () => {
      // @ts-expect-error calling protected
      strategy.recordTrade(-1.50, 10.0, 60_000)

      const stats = strategy.getStats()
      expect(stats.totalTrades).toBe(1)
      expect(stats.winningTrades).toBe(0)
      expect(stats.losingTrades).toBe(1)
      expect(stats.totalPnl).toBe(-1.50)
      expect(stats.winRate).toBe(0)
      expect(stats.worstTrade).toBe(-1.50)
    })

    it('tracks running averages across multiple trades', () => {
      // @ts-expect-error calling protected
      strategy.recordTrade(3.0, 10.0, 120_000)
      // @ts-expect-error calling protected
      strategy.recordTrade(-1.0, 15.0, 60_000)
      // @ts-expect-error calling protected
      strategy.recordTrade(2.0, 20.0, 90_000)

      const stats = strategy.getStats()
      expect(stats.totalTrades).toBe(3)
      expect(stats.winningTrades).toBe(2)
      expect(stats.losingTrades).toBe(1)
      expect(stats.totalPnl).toBe(4.0)
      expect(stats.winRate).toBeCloseTo(66.67, 1)
      expect(stats.avgTradeSize).toBe(15.0) // (10+15+20)/3
      expect(stats.bestTrade).toBe(3.0)
      expect(stats.worstTrade).toBe(-1.0)
    })
  })
})
