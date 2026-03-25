/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Market } from '@/types'
import type { LiquidationEvent } from '@/services/realtime/HyperliquidWSService'

// ==========================================
// MOCK SETTINGS (vi.hoisted to avoid TDZ with vi.mock hoisting)
// ==========================================

const { mockSettings } = vi.hoisted(() => {
  const mockSettings: Record<string, unknown> = {
    liqEnabled: true,
    liqMinThresholdUSD: 25_000,
    liqMaxThresholdUSD: 100_000,
    liqWindowMs: 60_000,
    liqCooldownMs: 120_000,
    liqTradeSize: 1,
    liqMaxAskPrice: 0.55,
    liqOrderExpiryMs: 45_000,
    liqStopLossPct: 0.30,
    liqTakeProfitPct: 0.60,
    liqPreferredDuration: '5m',
  }
  return { mockSettings }
})

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ ...mockSettings }),
  },
}))

vi.mock('@/stores/walletStore', () => ({
  useWalletStore: {
    getState: () => ({ balance: 100, buyingPower: 100 }),
  },
}))

vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: {
    logTrade: vi.fn(),
    logScan: vi.fn(),
    logSystem: vi.fn(),
    logWarning: vi.fn(),
    logError: vi.fn(),
  },
}))

const mockPlaceBet = vi.fn().mockResolvedValue({ success: true, orderId: 'order-123' })
vi.mock('@/services/trading', () => ({
  tradingService: {
    placeBet: (...args: unknown[]) => mockPlaceBet(...args),
  },
}))

const mockGetPrice = vi.fn().mockReturnValue(null)
vi.mock('@/services/realtime', () => ({
  realtimeService: {
    connect: vi.fn().mockResolvedValue(true),
    subscribeMarket: vi.fn(),
    getPrice: (...args: unknown[]) => mockGetPrice(...args),
  },
}))

const mockOnLiquidation = vi.fn().mockReturnValue(() => {})
const mockOnConnectionChange = vi.fn().mockReturnValue(() => {})
const mockConnect = vi.fn().mockResolvedValue(true)
vi.mock('@/services/realtime/HyperliquidWSService', () => ({
  hyperliquidWSService: {
    connect: (...args: unknown[]) => mockConnect(...args),
    onLiquidation: (...args: unknown[]) => mockOnLiquidation(...args),
    onConnectionChange: (...args: unknown[]) => mockOnConnectionChange(...args),
  },
}))

vi.mock('@/services/api/PolymarketClient', () => ({
  polymarketClient: {
    getEventBySlug: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('@/services/trading/RiskManager', () => ({
  riskManager: {
    emergencyStopped: false,
    validateTrade: vi.fn().mockReturnValue({ allowed: true }),
    addCapitalReservationFn: vi.fn(),
  },
}))

vi.mock('@/services/trading/MoonDevLiquidationService', () => ({
  moonDevLiquidationService: {
    isRunning: vi.fn().mockReturnValue(false),
    getLiquidationSummary: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

vi.mock('@/services/trading/MoonDevPositionProximityService', () => ({
  moonDevPositionProximityService: {
    isRunning: vi.fn().mockReturnValue(false),
    getProximitySignal: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

vi.mock('@/services/trading/MoonDevSentimentService', () => ({
  moonDevSentimentService: {
    isRunning: vi.fn().mockReturnValue(false),
    shouldFilterTrade: vi.fn().mockReturnValue(false),
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

const mockShouldTrade = vi.fn().mockReturnValue({ allowed: true })
vi.mock('@/services/trading/EdgeTracker', () => ({
  edgeTracker: {
    shouldTrade: (...args: unknown[]) => mockShouldTrade(...args),
    getStrategyEdge: vi.fn().mockReturnValue({ winRate: 0.5, sampleSize: 0, isReliable: false }),
  },
}))

// Must import AFTER all vi.mock() calls
import { LiquidationMomentumStrategy } from '../LiquidationMomentumStrategy'

// ==========================================
// HELPERS
// ==========================================

function createMockMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: 'market-1',
    question: 'Will BTC go up in the next 5 minutes?',
    slug: 'btc-updown-5m-1710000000',
    active: true,
    closed: false,
    clobTokenIds: ['yes-token-1', 'no-token-1'],
    outcomes: ['Yes', 'No'],
    outcomePrices: ['0.50', '0.50'],
    endDateIso: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  } as Market
}

function makeLiqEvent(side: 'long' | 'short', sizeUSD: number, timestamp?: number): LiquidationEvent {
  return {
    coin: 'BTC',
    side,
    sizeUSD,
    price: 65_000,
    timestamp: timestamp ?? Date.now(),
  }
}

/** Inject a cached market directly into the strategy's private cachedMarkets */
function injectMarket(strategy: any, market: Market, duration = '5m'): void {
  const clobIds = market.clobTokenIds!
  strategy['cachedMarkets'].set(`BTC:${duration}`, {
    market,
    yesTokenId: clobIds[0],
    noTokenId: clobIds[1],
    windowEndMs: Date.now() + 300_000,
    durationKey: duration,
  })
}

/** Simulate liquidation events through the strategy's private handler */
function fireLiquidation(strategy: any, event: LiquidationEvent): Promise<void> {
  return strategy['onLiquidation'](event)
}

// ==========================================
// TESTS
// ==========================================

describe('LiquidationMomentumStrategy', () => {
  let strategy: any

  beforeEach(() => {
    strategy = new LiquidationMomentumStrategy()
    // Reset mock settings
    Object.assign(mockSettings, {
      liqEnabled: true,
      liqMinThresholdUSD: 25_000,
      liqMaxThresholdUSD: 100_000,
      liqWindowMs: 60_000,
      liqCooldownMs: 120_000,
      liqTradeSize: 1,
      liqMaxAskPrice: 0.55,
      liqOrderExpiryMs: 45_000,
      liqStopLossPct: 0.30,
      liqTakeProfitPct: 0.60,
      liqPreferredDuration: '5m',
    })
    mockPlaceBet.mockResolvedValue({ success: true, orderId: 'order-123' })
    mockGetPrice.mockReturnValue(null)
    mockShouldTrade.mockReturnValue({ allowed: true })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ──────────────────────────────────────
  // LIFECYCLE
  // ──────────────────────────────────────

  describe('lifecycle', () => {
    it('should initialize without errors', async () => {
      await strategy.initialize()
      expect(strategy.name).toBe('Liquidation Momentum')
    })

    it('should not start if not enabled', async () => {
      // Don't call enable() — _enabled stays false
      await strategy.start()
      expect(strategy['_status']).toBe('idle')
    })

    it('should start and set status to running', async () => {
      strategy.enable()
      await strategy.start()
      expect(strategy['_status']).toBe('running')
      // HyperliquidWS is connected via dynamic import inside start()
    })

    it('should stop and clear all state', async () => {
      strategy.enable()
      await strategy.start()
      await strategy.stop()
      expect(strategy['_status']).toBe('idle')
      expect(strategy['liqBuffer']).toEqual([])
      expect(strategy['cachedMarkets'].size).toBe(0)
      expect(strategy['activePositionMarkets'].size).toBe(0)
    })

    it('should be idempotent on double start', async () => {
      strategy.enable()
      await strategy.start()
      await strategy.start()
      expect(strategy['_status']).toBe('running')
    })
  })

  // ──────────────────────────────────────
  // SIGNAL DETECTION
  // ──────────────────────────────────────

  describe('signal detection', () => {
    beforeEach(() => {
      strategy['_enabled'] = true
      strategy['_status'] = 'running'
    })

    it('should not trigger below min threshold', async () => {
      await fireLiquidation(strategy, makeLiqEvent('long', 20_000))
      expect(strategy.getLiquidationMetrics().triggered).toBe(0)
    })

    it('should trigger at min threshold with long liqs → DOWN', async () => {
      const market = createMockMarket()
      injectMarket(strategy, market)
      mockGetPrice.mockReturnValue({ ask: 0.50, bid: 0.48, mid: 0.49, spread: 0.02, timestamp: new Date() })
      strategy['realtimeServiceRef'] = { getPrice: mockGetPrice, subscribeMarket: vi.fn() }

      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))

      expect(strategy.getLiquidationMetrics().triggered).toBe(1)
      // Long liqs → down → buy NO
      if (mockPlaceBet.mock.calls.length > 0) {
        expect(mockPlaceBet.mock.calls[0][1]).toBe('no')
      }
    })

    it('should trigger at min threshold with short liqs → UP', async () => {
      const market = createMockMarket()
      injectMarket(strategy, market)
      mockGetPrice.mockReturnValue({ ask: 0.50, bid: 0.48, mid: 0.49, spread: 0.02, timestamp: new Date() })
      strategy['realtimeServiceRef'] = { getPrice: mockGetPrice, subscribeMarket: vi.fn() }

      await fireLiquidation(strategy, makeLiqEvent('short', 30_000))
      await new Promise(r => setTimeout(r, 50))

      expect(strategy.getLiquidationMetrics().triggered).toBe(1)
      // Short liqs → up → buy YES
      if (mockPlaceBet.mock.calls.length > 0) {
        expect(mockPlaceBet.mock.calls[0][1]).toBe('yes')
      }
    })

    it('should not trigger above max threshold', async () => {
      await fireLiquidation(strategy, makeLiqEvent('long', 150_000))
      expect(strategy.getLiquidationMetrics().triggered).toBe(0)
    })

    it('should accumulate multiple small liquidations to threshold', async () => {
      const market = createMockMarket()
      injectMarket(strategy, market)
      mockGetPrice.mockReturnValue({ ask: 0.50, bid: 0.48, mid: 0.49, spread: 0.02, timestamp: new Date() })
      strategy['realtimeServiceRef'] = { getPrice: mockGetPrice, subscribeMarket: vi.fn() }

      // 5 events × $6K = $30K → should trigger
      for (let i = 0; i < 5; i++) {
        await fireLiquidation(strategy, makeLiqEvent('long', 6_000))
      }
      await new Promise(r => setTimeout(r, 10))

      expect(strategy.getLiquidationMetrics().triggered).toBe(1)
    })

    it('should not count when strategy is not running', async () => {
      strategy['_status'] = 'idle'
      await fireLiquidation(strategy, makeLiqEvent('long', 50_000))
      expect(strategy.getLiquidationMetrics().detected).toBe(0)
    })

    it('should pick side with more volume when both triggered', async () => {
      const market = createMockMarket()
      injectMarket(strategy, market)
      mockGetPrice.mockReturnValue({ ask: 0.50, bid: 0.48, mid: 0.49, spread: 0.02, timestamp: new Date() })
      strategy['realtimeServiceRef'] = { getPrice: mockGetPrice, subscribeMarket: vi.fn() }

      // Long liqs: $40K, Short liqs: $30K → long wins → direction = down → buy NO
      await fireLiquidation(strategy, makeLiqEvent('long', 40_000))
      await fireLiquidation(strategy, makeLiqEvent('short', 30_000))
      await new Promise(r => setTimeout(r, 10))

      expect(strategy.getLiquidationMetrics().triggered).toBeGreaterThanOrEqual(1)
      if (mockPlaceBet.mock.calls.length > 0) {
        expect(mockPlaceBet.mock.calls[0][1]).toBe('no') // long liqs → down → NO
      }
    })
  })

  // ──────────────────────────────────────
  // ROLLING WINDOW
  // ──────────────────────────────────────

  describe('rolling window', () => {
    beforeEach(() => {
      strategy['_enabled'] = true
      strategy['_status'] = 'running'
    })

    it('should trim events outside the window', async () => {
      const now = Date.now()
      // Event from 90s ago (outside 60s window)
      await fireLiquidation(strategy, makeLiqEvent('long', 10_000, now - 90_000))
      // Event from 30s ago (inside window)
      await fireLiquidation(strategy, makeLiqEvent('long', 10_000, now - 30_000))

      expect(strategy['liqBuffer'].length).toBe(1)
    })

    it('should keep events within the window', async () => {
      const now = Date.now()
      await fireLiquidation(strategy, makeLiqEvent('long', 5_000, now - 50_000))
      await fireLiquidation(strategy, makeLiqEvent('long', 5_000, now - 30_000))
      await fireLiquidation(strategy, makeLiqEvent('long', 5_000, now - 10_000))

      expect(strategy['liqBuffer'].length).toBe(3)
    })

    it('should respect custom window size from settings', async () => {
      mockSettings.liqWindowMs = 30_000 // 30s window
      const now = Date.now()

      await fireLiquidation(strategy, makeLiqEvent('long', 5_000, now - 40_000)) // outside 30s
      await fireLiquidation(strategy, makeLiqEvent('long', 5_000, now - 20_000)) // inside

      expect(strategy['liqBuffer'].length).toBe(1)
    })
  })

  // ──────────────────────────────────────
  // VIABILITY GATES
  // ──────────────────────────────────────

  describe('viability gates', () => {
    beforeEach(async () => {
      strategy['_enabled'] = true
      strategy['_status'] = 'running'
      const market = createMockMarket()
      injectMarket(strategy, market)
      mockGetPrice.mockReturnValue({ ask: 0.50, bid: 0.48, mid: 0.49, spread: 0.02, timestamp: new Date() })
      strategy['realtimeServiceRef'] = { getPrice: mockGetPrice, subscribeMarket: vi.fn() }
    })

    it('should skip on cooldown', async () => {
      // First trade
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))
      expect(mockPlaceBet).toHaveBeenCalledTimes(1)

      // Inject another market (buffer was cleared after trade)
      const market2 = createMockMarket({ id: 'market-2' })
      injectMarket(strategy, market2)
      mockPlaceBet.mockClear()

      // Second trade within cooldown — should skip
      await fireLiquidation(strategy, makeLiqEvent('short', 30_000))
      await new Promise(r => setTimeout(r, 10))
      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(strategy.getLiquidationMetrics().skippedReasons['cooldown']).toBe(1)
    })

    it('should skip when no market is cached', async () => {
      strategy['cachedMarkets'].clear()
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))
      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(strategy.getLiquidationMetrics().skippedReasons['no_market']).toBe(1)
    })

    it('should skip when ask price is too high', async () => {
      mockGetPrice.mockReturnValue({ ask: 0.70, bid: 0.68, mid: 0.69, spread: 0.02, timestamp: new Date() })
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))
      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(strategy.getLiquidationMetrics().skippedReasons['ask_too_high']).toBe(1)
    })

    it('should skip when no CLOB price data', async () => {
      mockGetPrice.mockReturnValue(null)
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))
      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(strategy.getLiquidationMetrics().skippedReasons['no_clob_price']).toBe(1)
    })

    it('should skip when no realtime service', async () => {
      strategy['realtimeServiceRef'] = null
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))
      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(strategy.getLiquidationMetrics().skippedReasons['no_realtime']).toBe(1)
    })

    it('should skip when EdgeTracker blocks', async () => {
      mockShouldTrade.mockReturnValue({ allowed: false, reason: 'negative_edge' })
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))
      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(strategy.getLiquidationMetrics().skippedReasons['edge_tracker_blocked']).toBe(1)
    })

    it('should skip when position already exists on same market+direction', async () => {
      // First trade succeeds
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))
      expect(mockPlaceBet).toHaveBeenCalledTimes(1)

      // Re-inject same market (buffer was cleared)
      const market = createMockMarket()
      injectMarket(strategy, market)
      strategy['lastTradeTime'] = 0 // reset cooldown
      mockPlaceBet.mockClear()

      // Same direction on same market — should skip
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))
      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(strategy.getLiquidationMetrics().skippedReasons['position_exists']).toBe(1)
    })
  })

  // ──────────────────────────────────────
  // ORDER PLACEMENT
  // ──────────────────────────────────────

  describe('order placement', () => {
    beforeEach(() => {
      strategy['_enabled'] = true
      strategy['_status'] = 'running'
      const market = createMockMarket()
      injectMarket(strategy, market)
      mockGetPrice.mockReturnValue({ ask: 0.50, bid: 0.48, mid: 0.49, spread: 0.02, timestamp: new Date() })
      strategy['realtimeServiceRef'] = { getPrice: mockGetPrice, subscribeMarket: vi.fn() }
    })

    it('should place GTD order with correct parameters', async () => {
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))

      expect(mockPlaceBet).toHaveBeenCalledTimes(1)
      const [_market, outcome, size, options] = mockPlaceBet.mock.calls[0]
      expect(outcome).toBe('no') // long liqs → down → NO
      expect(size).toBe(1) // liqTradeSize
      expect(options.orderType).toBe('GTD')
      expect(options.strategy).toBe('liquidation')
      expect(options.skipGtcFallback).toBe(true)
      expect(options.gtdExpiryMs).toBe(45_000)
      expect(options.limitPrice).toBe(0.50)
      expect(options.stopLossPercent).toBe(0.30)
      expect(options.takeProfitPercent).toBe(0.60)
    })

    it('should place YES order for short liquidations', async () => {
      await fireLiquidation(strategy, makeLiqEvent('short', 30_000))
      await new Promise(r => setTimeout(r, 10))

      expect(mockPlaceBet).toHaveBeenCalledTimes(1)
      const [_market, outcome] = mockPlaceBet.mock.calls[0]
      expect(outcome).toBe('yes') // short liqs → up → YES
    })

    it('should clear liquidation buffer after successful trade', async () => {
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))

      expect(mockPlaceBet).toHaveBeenCalled()
      expect(strategy['liqBuffer']).toEqual([])
    })

    it('should increment stats on successful trade', async () => {
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))

      expect(strategy['_stats'].totalTrades).toBe(1)
      expect(strategy.getLiquidationMetrics().traded).toBe(1)
    })

    it('should handle order failure gracefully', async () => {
      mockPlaceBet.mockResolvedValue({ success: false, error: 'insufficient balance' })
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))

      expect(strategy.getLiquidationMetrics().skippedReasons['order_failed']).toBe(1)
      expect(strategy['_stats'].totalTrades).toBe(0)
    })

    it('should use correct trade size from settings', async () => {
      mockSettings.liqTradeSize = 5
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))

      const [_market, _outcome, size] = mockPlaceBet.mock.calls[0]
      expect(size).toBe(5)
    })

    it('should use correct SL/TP from settings', async () => {
      mockSettings.liqStopLossPct = 0.15
      mockSettings.liqTakeProfitPct = 0.40
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))

      const options = mockPlaceBet.mock.calls[0][3]
      expect(options.stopLossPercent).toBe(0.15)
      expect(options.takeProfitPercent).toBe(0.40)
    })
  })

  // ──────────────────────────────────────
  // MARKET DISCOVERY
  // ──────────────────────────────────────

  describe('market discovery', () => {
    beforeEach(() => {
      strategy['_enabled'] = true
      strategy['_status'] = 'running'
    })

    it('should find best market by preferred duration', () => {
      const market5m = createMockMarket({ id: '5m-market' })
      injectMarket(strategy, market5m, '5m')

      const result = strategy['findBestMarket']('5m')
      expect(result).not.toBeNull()
      expect(result.durationKey).toBe('5m')
    })

    it('should fall back to 15m when 5m not available', () => {
      const market15m = createMockMarket({ id: '15m-market' })
      injectMarket(strategy, market15m, '15m')

      const result = strategy['findBestMarket']('5m')
      expect(result).not.toBeNull()
      expect(result.durationKey).toBe('15m')
    })

    it('should return null when no markets cached', () => {
      const result = strategy['findBestMarket']('5m')
      expect(result).toBeNull()
    })

    it('should skip expired markets', () => {
      const market = createMockMarket()
      const clobIds = market.clobTokenIds!
      strategy['cachedMarkets'].set('BTC:5m', {
        market,
        yesTokenId: clobIds[0],
        noTokenId: clobIds[1],
        windowEndMs: Date.now() - 1000, // expired
        durationKey: '5m',
      })

      const result = strategy['findBestMarket']('5m')
      expect(result).toBeNull()
    })
  })

  // ──────────────────────────────────────
  // METRICS
  // ──────────────────────────────────────

  describe('metrics', () => {
    beforeEach(() => {
      strategy['_enabled'] = true
      strategy['_status'] = 'running'
    })

    it('should track max liquidation volumes', async () => {
      await fireLiquidation(strategy, makeLiqEvent('long', 15_000))
      await fireLiquidation(strategy, makeLiqEvent('short', 8_000))

      const metrics = strategy.getLiquidationMetrics()
      expect(metrics.recentMaxLongLiq).toBe(15_000)
      expect(metrics.recentMaxShortLiq).toBe(8_000)
    })

    it('should count detected events', async () => {
      await fireLiquidation(strategy, makeLiqEvent('long', 100))
      await fireLiquidation(strategy, makeLiqEvent('short', 200))

      expect(strategy.getLiquidationMetrics().detected).toBe(2)
    })

    it('should return deep copy of metrics', async () => {
      const metrics1 = strategy.getLiquidationMetrics()
      metrics1.detected = 999
      expect(strategy.getLiquidationMetrics().detected).toBe(0)
    })
  })

  // ──────────────────────────────────────
  // THRESHOLD TUNING
  // ──────────────────────────────────────

  describe('threshold configuration', () => {
    beforeEach(() => {
      strategy['_enabled'] = true
      strategy['_status'] = 'running'
      const market = createMockMarket()
      injectMarket(strategy, market)
      mockGetPrice.mockReturnValue({ ask: 0.50, bid: 0.48, mid: 0.49, spread: 0.02, timestamp: new Date() })
      strategy['realtimeServiceRef'] = { getPrice: mockGetPrice, subscribeMarket: vi.fn() }
    })

    it('should respect custom min threshold', async () => {
      mockSettings.liqMinThresholdUSD = 50_000
      await fireLiquidation(strategy, makeLiqEvent('long', 40_000))
      await new Promise(r => setTimeout(r, 10))
      expect(strategy.getLiquidationMetrics().triggered).toBe(0)
    })

    it('should respect custom max threshold', async () => {
      mockSettings.liqMaxThresholdUSD = 50_000
      await fireLiquidation(strategy, makeLiqEvent('long', 60_000))
      await new Promise(r => setTimeout(r, 10))
      expect(strategy.getLiquidationMetrics().triggered).toBe(0)
    })

    it('should trigger between min and max', async () => {
      mockSettings.liqMinThresholdUSD = 10_000
      mockSettings.liqMaxThresholdUSD = 50_000
      await fireLiquidation(strategy, makeLiqEvent('long', 30_000))
      await new Promise(r => setTimeout(r, 10))
      expect(strategy.getLiquidationMetrics().triggered).toBe(1)
    })
  })
})
