import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DualSideHedgeStrategy } from '../DualSideHedgeStrategy'
import { DynamicFeeService } from '@/services/trading/DynamicFeeService'
import type { Signal } from '../btcupdown/signalEngine'
import type { Market } from '@/types'

// ==========================================
// MOCK SETTINGS
// ==========================================

const mockSettings: Record<string, unknown> = {
  dualSideEnabled: true,
  dualSideTradeSize: 2.0,
  dualSideBiasRatio: 0.70,
  dualSideMakerOnly: true,
  dualSideMaxCombinedAsk: 0.995,
  dualSideRequireBothLegs: true,
  btcFiveMinMakerMode: false,
}

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => mockSettings,
  },
}))

vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: {
    logTrade: vi.fn(),
    logScan: vi.fn(),
    logSystem: vi.fn(),
    logWarning: vi.fn(),
  },
}))

vi.mock('@/services/trading/RejectionTracker', () => ({
  rejectionTracker: {
    record: vi.fn(),
  },
}))

// Mock TradingService for order placement tests
const mockPlaceBet = vi.fn().mockResolvedValue({ success: true, orderId: 'order-yes-123' })
const mockCancelOrder = vi.fn().mockResolvedValue(true)
vi.mock('@/services/trading/TradingService', () => ({
  tradingService: {
    placeBet: (...args: unknown[]) => mockPlaceBet(...args),
    cancelOrder: (...args: unknown[]) => mockCancelOrder(...args),
  },
}))

// Mock UserChannelService for fill detection tests
const mockTradeCallbacks = new Set<(msg: unknown) => void>()
vi.mock('@/services/realtime', () => ({
  userChannelService: {
    onTrade: (cb: (msg: unknown) => void) => {
      mockTradeCallbacks.add(cb)
      return () => mockTradeCallbacks.delete(cb)
    },
    isConnected: () => true,
  },
}))

// Mock BinanceWSService for cancel/replace tests
const mockPriceCallbacks = new Set<(update: unknown) => void>()
vi.mock('@/services/realtime/BinanceWSService', () => ({
  binanceWSService: {
    onPriceUpdate: (cb: (update: unknown) => void) => {
      mockPriceCallbacks.add(cb)
      return () => mockPriceCallbacks.delete(cb)
    },
  },
}))

// Mock BtcUpDownStrategy for signal subscription + getActiveMarket
vi.mock('../BtcUpDownStrategy', () => ({
  btcUpDownStrategy: {
    on: vi.fn().mockReturnValue(() => {}),
    getActiveMarketEntries: vi.fn().mockReturnValue([]),
    getActiveMarket: vi.fn().mockReturnValue(undefined),
  },
}))

// ==========================================
// HELPERS
// ==========================================

const feeService = new DynamicFeeService()

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    direction: 'up',
    confidence: 0.65,
    factors: {
      momentumScore: 0.7,
      velocityScore: 0.5,
      timeScore: 0.6,
      valueScore: 0.4,
      flowScore: 0.3,
    },
    regime: 'trending',
    rsi: 55,
    ...overrides,
  }
}

function makeMarket(overrides?: Partial<Market>): Market {
  return {
    id: 'market-btc-15m',
    slug: 'btc-up-down-15m',
    question: 'Will BTC go up?',
    outcomes: ['Up', 'Down'],
    active: true,
    closed: false,
    endDate: new Date(Date.now() + 900_000).toISOString(),
    createdAt: new Date().toISOString(),
    volume: 10000,
    liquidity: 5000,
    outcomePrices: [0.48, 0.48],  // combined = 0.96 < 0.995
    ...overrides,
  }
}

// ==========================================
// BIAS SIZING
// ==========================================

describe('DualSideHedgeStrategy — computeBiasedSizes', () => {
  const strategy = new DualSideHedgeStrategy()

  it('allocates 70/30 with biasRatio=0.70 when direction=up', () => {
    const { yesSize, noSize } = strategy.computeBiasedSizes(2.0, 0.70, 'up')
    expect(yesSize).toBeCloseTo(1.40, 2)
    expect(noSize).toBeCloseTo(0.60, 2)
  })

  it('allocates 70/30 inversely when direction=down', () => {
    const { yesSize, noSize } = strategy.computeBiasedSizes(2.0, 0.70, 'down')
    expect(yesSize).toBeCloseTo(0.60, 2)
    expect(noSize).toBeCloseTo(1.40, 2)
  })

  it('50/50 split with biasRatio=0.50', () => {
    const { yesSize, noSize } = strategy.computeBiasedSizes(2.0, 0.50, 'up')
    expect(yesSize).toBeCloseTo(1.00, 2)
    expect(noSize).toBeCloseTo(1.00, 2)
  })

  it('all-in on winner with biasRatio=1.0', () => {
    const { yesSize, noSize } = strategy.computeBiasedSizes(2.0, 1.0, 'up')
    expect(yesSize).toBeCloseTo(2.00, 2)
    expect(noSize).toBeCloseTo(0.00, 2)
  })
})

// ==========================================
// FEE VIABILITY (via DynamicFeeService)
// ==========================================

describe('DualSideHedgeStrategy — fee viability integration', () => {
  it('maker (0 bps) with combined 0.98 is profitable', () => {
    const ev = feeService.computeDualSideEV({
      yesPrice: 0.49,
      noPrice: 0.49,
      yesFeeRateBps: 0,    // maker
      noFeeRateBps: 0,      // maker
      winProbability: 0.60,
    })
    expect(ev.isViable).toBe(true)
    expect(ev.netEV).toBeCloseTo(0.02, 4)
  })

  it('taker (1000 bps) with combined 0.98 is NOT profitable', () => {
    const ev = feeService.computeDualSideEV({
      yesPrice: 0.49,
      noPrice: 0.49,
      yesFeeRateBps: 1000,  // 10% taker
      noFeeRateBps: 1000,
      winProbability: 0.60,
    })
    expect(ev.isViable).toBe(false)
  })

  it('taker dynamic fee (~315 bps) at 50/50 with combined 0.98 is NOT profitable', () => {
    const ev = feeService.computeDualSideEV({
      yesPrice: 0.50,
      noPrice: 0.48,
      yesFeeRateBps: 315,
      noFeeRateBps: 315,
      winProbability: 0.60,
    })
    expect(ev.isViable).toBe(false)
  })

  it('maker with combined 0.995 is barely profitable', () => {
    const ev = feeService.computeDualSideEV({
      yesPrice: 0.50,
      noPrice: 0.495,
      yesFeeRateBps: 0,
      noFeeRateBps: 0,
      winProbability: 0.50,
    })
    expect(ev.isViable).toBe(true)
    expect(ev.netEV).toBeCloseTo(0.005, 4)
  })
})

// ==========================================
// SIGNAL GATING
// ==========================================

describe('DualSideHedgeStrategy — signal gating', () => {
  let strategy: DualSideHedgeStrategy

  beforeEach(() => {
    strategy = new DualSideHedgeStrategy()
    strategy['_enabled'] = true
    Object.assign(mockSettings, {
      dualSideEnabled: true,
      dualSideTradeSize: 2.0,
      dualSideBiasRatio: 0.70,
      dualSideMakerOnly: true,
      dualSideMaxCombinedAsk: 0.995,
      dualSideRequireBothLegs: true,
    })
    mockPlaceBet.mockClear()
  })

  it('rejects signals below minSignalConfidence', async () => {
    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.30 }), 65000, 65300)
    expect(emitted).toHaveLength(0)
  })

  it('rejects when strategy is disabled', async () => {
    strategy['_enabled'] = false
    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65 }), 65000, 65300)
    expect(emitted).toHaveLength(0)
  })

  it('rejects when dualSideEnabled is false', async () => {
    mockSettings.dualSideEnabled = false
    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65 }), 65000, 65300)
    expect(emitted).toHaveLength(0)
  })

  it('rejects duplicate hedge for same asset', async () => {
    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesPrice: 0.49,
      noPrice: 0.49,
      yesFilled: false,
      noFilled: false,
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now(),
      btcPriceAtPlacement: 65000,
      replaceThreshold: 0.001,
    })

    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65 }), 65000, 65300)
    expect(emitted).toHaveLength(0) // rejected — already pending
  })

  it('rejects when no market object is provided', async () => {
    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    // Call without market (undefined)
    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65 }), 65000, 65300)
    expect(emitted).toHaveLength(0)
  })

  it('rejects when combined ask >= maxCombinedAsk', async () => {
    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    const market = makeMarket({ outcomePrices: [0.51, 0.50] }) // combined 1.01
    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65 }), 65000, 65300, market)
    expect(emitted).toHaveLength(0)
  })
})

// ==========================================
// ORDER PLACEMENT (Bug #2 fix)
// ==========================================

describe('DualSideHedgeStrategy — order placement', () => {
  let strategy: DualSideHedgeStrategy

  beforeEach(() => {
    strategy = new DualSideHedgeStrategy()
    strategy['_enabled'] = true
    Object.assign(mockSettings, {
      dualSideEnabled: true,
      dualSideTradeSize: 2.0,
      dualSideBiasRatio: 0.70,
      dualSideMakerOnly: true,
      dualSideMaxCombinedAsk: 0.995,
      dualSideRequireBothLegs: true,
    })
    mockPlaceBet.mockClear()
    mockPlaceBet.mockResolvedValue({ success: true, orderId: 'order-123' })
  })

  it('calls tradingService.placeBet with GTC + postOnly + limitPrice', async () => {
    const market = makeMarket({ outcomePrices: [0.48, 0.48] })

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65, direction: 'up' }), 65000, 65300, market)

    expect(mockPlaceBet).toHaveBeenCalledTimes(2) // YES + NO

    // YES leg
    const yesCall = mockPlaceBet.mock.calls[0]
    expect(yesCall[0]).toBe(market)
    expect(yesCall[1]).toBe('yes')
    expect(yesCall[3]).toMatchObject({
      orderType: 'GTC',
      skipGtcFallback: true,
      strategy: 'dual-side',
      postOnly: true,
      limitPrice: 0.47, // 0.48 - 0.01
    })

    // NO leg
    const noCall = mockPlaceBet.mock.calls[1]
    expect(noCall[1]).toBe('no')
    expect(noCall[3]).toMatchObject({
      orderType: 'GTC',
      postOnly: true,
      limitPrice: 0.47,
    })
  })

  it('tracks pending hedge after successful order placement', async () => {
    const market = makeMarket({ outcomePrices: [0.48, 0.48] })
    mockPlaceBet.mockResolvedValue({ success: true, orderId: 'order-abc' })

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65 }), 65000, 65300, market)

    const hedges = strategy.getPendingHedges()
    expect(hedges.size).toBe(1)
    expect(hedges.get('BTC')).toMatchObject({
      asset: 'BTC',
      yesOrderId: 'order-abc',
      noOrderId: 'order-abc',
      yesFilled: false,
      noFilled: false,
      direction: 'up',
      btcPriceAtPlacement: 65300,
    })
  })

  it('emits hedgePlaced event on successful placement', async () => {
    const market = makeMarket({ outcomePrices: [0.48, 0.48] })
    const emitted: unknown[] = []
    strategy.on('hedgePlaced', (_e, d) => emitted.push(d))

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65 }), 65000, 65300, market)

    expect(emitted).toHaveLength(1)
  })

  it('uses biased sizing (70/30) in order amounts', async () => {
    const market = makeMarket({ outcomePrices: [0.48, 0.48] })

    await strategy.onSignal('BTC', makeSignal({ confidence: 0.65, direction: 'up' }), 65000, 65300, market)

    // YES = 70% of $2 = $1.40, NO = 30% of $2 = $0.60
    const yesAmount = mockPlaceBet.mock.calls[0][2]
    const noAmount = mockPlaceBet.mock.calls[1][2]
    expect(yesAmount).toBeCloseTo(1.40, 2)
    expect(noAmount).toBeCloseTo(0.60, 2)
  })
})

// ==========================================
// FILL DETECTION (Bug #5 fix)
// ==========================================

describe('DualSideHedgeStrategy — fill detection', () => {
  let strategy: DualSideHedgeStrategy

  beforeEach(() => {
    strategy = new DualSideHedgeStrategy()
    strategy['_enabled'] = true
    mockTradeCallbacks.clear()
  })

  it('sets yesFilled when UserChannel confirms YES order', async () => {
    // Start to register callbacks
    await strategy.start()
    // Flush dynamic import() microtask chain (import → .then → onTrade registration)
    await vi.waitFor(() => { if (mockTradeCallbacks.size === 0) throw new Error('waiting') })

    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesOrderId: 'yes-order-1',
      noOrderId: 'no-order-1',
      yesPrice: 0.47,
      noPrice: 0.47,
      yesFilled: false,
      noFilled: false,
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now(),
      btcPriceAtPlacement: 65000,
      replaceThreshold: 0.001,
    })

    // Simulate UserChannel trade event for YES order
    for (const cb of mockTradeCallbacks) {
      cb({
        status: 'CONFIRMED',
        maker_orders: [{ order_id: 'yes-order-1' }],
      })
    }

    const hedge = strategy.getPendingHedges().get('BTC')
    expect(hedge?.yesFilled).toBe(true)
    expect(hedge?.noFilled).toBe(false)

    await strategy.stop()
  })

  it('removes hedge when both legs fill', async () => {
    await strategy.start()
    await vi.waitFor(() => { if (mockTradeCallbacks.size === 0) throw new Error('waiting') })

    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesOrderId: 'yes-order-1',
      noOrderId: 'no-order-1',
      yesPrice: 0.47,
      noPrice: 0.47,
      yesFilled: false,
      noFilled: false,
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now(),
      btcPriceAtPlacement: 65000,
      replaceThreshold: 0.001,
    })

    const emitted: unknown[] = []
    strategy.on('hedgeBothFilled', (_e, d) => emitted.push(d))

    // Fill YES
    for (const cb of mockTradeCallbacks) {
      cb({ status: 'CONFIRMED', maker_orders: [{ order_id: 'yes-order-1' }] })
    }
    // Fill NO
    for (const cb of mockTradeCallbacks) {
      cb({ status: 'CONFIRMED', maker_orders: [{ order_id: 'no-order-1' }] })
    }

    expect(strategy.getPendingHedges().size).toBe(0)
    expect(emitted).toHaveLength(1)

    await strategy.stop()
  })
})

// ==========================================
// CANCEL ON TIMEOUT (Bug #4 fix)
// ==========================================

describe('DualSideHedgeStrategy — timeout cancel', () => {
  let strategy: DualSideHedgeStrategy

  beforeEach(() => {
    strategy = new DualSideHedgeStrategy()
    strategy['_enabled'] = true
    mockCancelOrder.mockClear()
  })

  it('calls cancelOrder for unfilled legs on timeout', async () => {
    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesOrderId: 'yes-order-timeout',
      noOrderId: 'no-order-timeout',
      yesPrice: 0.47,
      noPrice: 0.47,
      yesFilled: false,
      noFilled: false,
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now() - 60_000, // 60s ago — well past 30s timeout
      btcPriceAtPlacement: 65000,
      replaceThreshold: 0.001,
    })

    // Directly invoke the private method
    await strategy['checkPendingFills']()

    expect(mockCancelOrder).toHaveBeenCalledTimes(2)
    expect(mockCancelOrder).toHaveBeenCalledWith('yes-order-timeout')
    expect(mockCancelOrder).toHaveBeenCalledWith('no-order-timeout')
    expect(strategy.getPendingHedges().size).toBe(0)
  })

  it('skips cancel for already-filled legs', async () => {
    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesOrderId: 'yes-order-filled',
      noOrderId: 'no-order-unfilled',
      yesPrice: 0.47,
      noPrice: 0.47,
      yesFilled: true, // YES already filled
      noFilled: false,
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now() - 60_000,
      btcPriceAtPlacement: 65000,
      replaceThreshold: 0.001,
    })

    await strategy['checkPendingFills']()

    expect(mockCancelOrder).toHaveBeenCalledTimes(1)
    expect(mockCancelOrder).toHaveBeenCalledWith('no-order-unfilled')
  })
})

// ==========================================
// CANCEL/REPLACE LOOP (Phase 2)
// ==========================================

describe('DualSideHedgeStrategy — cancel/replace', () => {
  let strategy: DualSideHedgeStrategy

  beforeEach(() => {
    strategy = new DualSideHedgeStrategy()
    strategy['_enabled'] = true
    mockPlaceBet.mockClear()
    mockCancelOrder.mockClear()
    mockPlaceBet.mockResolvedValue({ success: true, orderId: 'new-order' })
  })

  it('does nothing when price change < threshold', async () => {
    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesOrderId: 'yes-1',
      noOrderId: 'no-1',
      yesPrice: 0.47,
      noPrice: 0.47,
      yesFilled: false,
      noFilled: false,
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now(),
      btcPriceAtPlacement: 65000,
      replaceThreshold: 0.001, // 0.1%
    })

    // Price moved only 0.05% — below threshold
    await strategy['onBtcPriceUpdate'](65032)

    expect(mockCancelOrder).not.toHaveBeenCalled()
    expect(mockPlaceBet).not.toHaveBeenCalled()
  })

  it('triggers cancel/replace when price change >= threshold', async () => {
    // Mock getActiveMarket to return fresh market data
    const { btcUpDownStrategy } = await import('../BtcUpDownStrategy')
    vi.mocked(btcUpDownStrategy.getActiveMarket).mockReturnValue(makeMarket({ outcomePrices: [0.49, 0.49] }))

    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesOrderId: 'old-yes',
      noOrderId: 'old-no',
      yesPrice: 0.47,
      noPrice: 0.47,
      yesFilled: false,
      noFilled: false,
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now(),
      btcPriceAtPlacement: 65000,
      replaceThreshold: 0.001, // 0.1%
    })

    // Price moved 0.2% — above threshold
    await strategy['onBtcPriceUpdate'](65130)

    // Should cancel both old orders and place 2 new ones
    expect(mockCancelOrder).toHaveBeenCalledTimes(2)
    expect(mockCancelOrder).toHaveBeenCalledWith('old-yes')
    expect(mockCancelOrder).toHaveBeenCalledWith('old-no')
    expect(mockPlaceBet).toHaveBeenCalledTimes(2)

    // btcPriceAtPlacement should be updated
    const hedge = strategy.getPendingHedges().get('BTC')
    expect(hedge?.btcPriceAtPlacement).toBe(65130)
  })

  it('skips cancel/replace for fully filled hedges', async () => {
    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesOrderId: 'yes-1',
      noOrderId: 'no-1',
      yesPrice: 0.47,
      noPrice: 0.47,
      yesFilled: true,
      noFilled: true, // both filled
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now(),
      btcPriceAtPlacement: 65000,
      replaceThreshold: 0.001,
    })

    await strategy['onBtcPriceUpdate'](66000) // huge move

    expect(mockCancelOrder).not.toHaveBeenCalled()
  })
})

// ==========================================
// LIFECYCLE
// ==========================================

describe('DualSideHedgeStrategy — lifecycle', () => {
  it('starts with correct initial state', () => {
    const strategy = new DualSideHedgeStrategy()
    expect(strategy.name).toBe('Dual-Side Hedge')
    expect(strategy.strategyType).toBe('mechanical')
    expect(strategy.enabled).toBe(false)
    expect(strategy.status).toBe('idle')
  })

  it('stop clears pending hedges', async () => {
    const strategy = new DualSideHedgeStrategy()
    strategy.getPendingHedges().set('BTC', {
      marketId: 'test',
      asset: 'BTC',
      yesPrice: 0.49,
      noPrice: 0.49,
      yesFilled: false,
      noFilled: false,
      direction: 'up',
      confidence: 0.65,
      placedAt: Date.now(),
      btcPriceAtPlacement: 65000,
      replaceThreshold: 0.001,
    })
    expect(strategy.getPendingHedges().size).toBe(1)
    await strategy.stop()
    expect(strategy.getPendingHedges().size).toBe(0)
  })
})
