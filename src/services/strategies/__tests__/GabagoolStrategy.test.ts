import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GabagoolStrategy } from '../GabagoolStrategy'
import type { Market } from '@/types'

// ==========================================
// MOCK SETTINGS (vi.hoisted to avoid TDZ with vi.mock hoisting)
// ==========================================

const { mockSettings } = vi.hoisted(() => {
  const mockSettings: Record<string, unknown> = {
    gabagoolEnabled: true,
    gabagoolMaxExposure: 10,
    gabagoolOrderSize: 1,
    gabagoolCheapnessThreshold: 0.48,
    gabagoolMaxImbalance: 0.20,
    gabagoolMinProfitMargin: 0.98,
    gabagoolCooldownMs: 3000,
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
    getState: () => ({
      balance: 100,
      buyingPower: 100,
    }),
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


const mockPlaceBet = vi.fn().mockResolvedValue({ success: true, orderId: 'order-123' })
const mockCancelOrder = vi.fn().mockResolvedValue(true)
vi.mock('@/services/trading/TradingService', () => ({
  tradingService: {
    placeBet: (...args: unknown[]) => mockPlaceBet(...args),
    cancelOrder: (...args: unknown[]) => mockCancelOrder(...args),
  },
}))

vi.mock('@/services/realtime', () => ({
  realtimeService: {
    connect: vi.fn().mockResolvedValue(true),
    subscribeMarket: vi.fn(),
    getPrice: vi.fn().mockReturnValue(null),
    isStale: vi.fn().mockReturnValue(false),
  },
  userChannelService: {
    onTrade: vi.fn().mockReturnValue(() => {}),
    isConnected: () => true,
  },
}))

vi.mock('@/services/api/PolymarketClient', () => ({
  polymarketClient: {
    getEventBySlug: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('@/services/trading/MergeService', () => ({
  mergeService: {
    isReady: vi.fn().mockReturnValue(false),
    initialize: vi.fn(),
    computeMergeAmount: vi.fn().mockReturnValue(0n),
    merge: vi.fn().mockResolvedValue({ success: false }),
  },
}))

vi.mock('@/services/wallet/WalletService', () => ({
  walletService: {
    getWallet: vi.fn().mockReturnValue(null),
  },
}))

// Suppress console.log in tests
vi.spyOn(console, 'log').mockImplementation(() => {})

// ==========================================
// HELPERS
// ==========================================

function makeMarket(overrides?: Partial<Market>): Market {
  return {
    id: 'market-1',
    slug: 'btc-updown-15m-1700000000',
    question: 'Will BTC go up in 15 minutes?',
    outcomes: ['Up', 'Down'],
    outcomePrices: [0.50, 0.50],
    clobTokenIds: ['token-yes-1', 'token-no-1'],
    active: true,
    closed: false,
    endDate: new Date(Date.now() + 600_000).toISOString(), // 10 min from now
    createdAt: new Date().toISOString(),
    volume: 10000,
    liquidity: 5000,
    conditionId: '0xcondition123',
    ...overrides,
  }
}

function makeStrategy(): GabagoolStrategy {
  return new GabagoolStrategy()
}

function makeAccumulator(strategy: GabagoolStrategy, market: Market) {
  const acc = {
    marketId: market.id,
    market,
    conditionId: market.conditionId,
    yesTokenId: market.clobTokenIds![0],
    noTokenId: market.clobTokenIds![1],
    windowEndMs: new Date(market.endDate).getTime(),
    qtyYes: 0, qtyNo: 0,
    costYes: 0, costNo: 0,
    fills: [],
    pairCost: Infinity,
    lockedProfit: 0,
    imbalance: 0,
    pendingOrderIds: new Set<string>(),
    lastOrderTime: 0,
    totalOrders: 0,
    stopped: false,
  }
  strategy.getAccumulators().set(market.id, acc)
  return acc
}

// ==========================================
// TESTS
// ==========================================

describe('GabagoolStrategy', () => {
  let strategy: GabagoolStrategy

  beforeEach(() => {
    vi.clearAllMocks()
    mockSettings.gabagoolEnabled = true
    mockSettings.gabagoolMaxExposure = 10
    mockSettings.gabagoolOrderSize = 1
    mockSettings.gabagoolCheapnessThreshold = 0.48
    mockSettings.gabagoolMaxImbalance = 0.20
    mockSettings.gabagoolMinProfitMargin = 0.98
    mockSettings.gabagoolCooldownMs = 3000
    strategy = makeStrategy()
  })

  // ==========================================
  // LIFECYCLE
  // ==========================================

  describe('lifecycle', () => {
    it('initializes to idle', async () => {
      await strategy.initialize()
      expect(strategy.status).toBe('idle')
    })

    it('does not start when not enabled', async () => {
      // _enabled is set by enable(), not start() — calling start() directly without enable()
      await strategy.start()
      expect(strategy.status).toBe('idle')
    })

    it('starts when enabled', async () => {
      await strategy.enable()
      expect(strategy.status).toBe('running')
    })

    it('clears state on stop', async () => {
      await strategy.enable()
      const market = makeMarket()
      makeAccumulator(strategy, market)
      expect(strategy.getAccumulators().size).toBe(1)

      await strategy.stop()
      expect(strategy.getAccumulators().size).toBe(0)
      expect(strategy.status).toBe('idle')
    })
  })

  // ==========================================
  // CHEAPNESS EVALUATION (chooseSide)
  // ==========================================

  describe('chooseSide', () => {
    it('buys YES when yesAsk is cheap', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      const config = strategy.gabagoolConfig

      const result = strategy.chooseSide(acc, 0.45, 0.55, config)
      expect(result).toBe('yes')
    })

    it('buys NO when noAsk is cheap', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      const config = strategy.gabagoolConfig

      const result = strategy.chooseSide(acc, 0.55, 0.43, config)
      expect(result).toBe('no')
    })

    it('buys cheaper side when both are cheap', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      const config = strategy.gabagoolConfig

      const result = strategy.chooseSide(acc, 0.46, 0.44, config)
      expect(result).toBe('no') // 0.44 < 0.46
    })

    it('returns null when neither side is cheap', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      const config = strategy.gabagoolConfig

      const result = strategy.chooseSide(acc, 0.52, 0.53, config)
      expect(result).toBeNull()
    })

    it('never buys above hard cap (0.55)', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      // Set threshold very high but hard cap should still block
      const config = { ...strategy.gabagoolConfig, cheapnessThreshold: 0.60 }

      const result = strategy.chooseSide(acc, 0.56, 0.57, config)
      expect(result).toBeNull()
    })

    it('uses dynamic threshold based on other side avg cost', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      // Already accumulated NO at avg 0.45
      acc.qtyNo = 100
      acc.costNo = 45 // avg = 0.45

      const config = { ...strategy.gabagoolConfig, cheapnessThreshold: 0.40, minProfitMargin: 0.98 }
      // Dynamic YES threshold = 1.00 - 0.45 - (1 - 0.98) = 0.53
      // So YES at 0.50 should be bought even though 0.50 > cheapnessThreshold (0.40)
      const result = strategy.chooseSide(acc, 0.50, 0.55, config)
      expect(result).toBe('yes')
    })
  })

  // ==========================================
  // BALANCE MANAGEMENT
  // ==========================================

  describe('balance management', () => {
    it('prioritizes lagging side when imbalance exceeds threshold', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.qtyYes = 100
      acc.qtyNo = 50
      acc.costYes = 48
      acc.costNo = 23
      acc.imbalance = 0.50 // 50% imbalance, over 20% threshold
      const config = strategy.gabagoolConfig

      // NO is lagging, should buy NO even though YES is cheaper
      const result = strategy.chooseSide(acc, 0.44, 0.52, config)
      expect(result).toBe('no') // lagging side, under hard cap
    })

    it('skips if lagging side is too expensive', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.qtyYes = 100
      acc.qtyNo = 50
      acc.imbalance = 0.50
      const config = strategy.gabagoolConfig

      // NO is lagging but above hard cap
      const result = strategy.chooseSide(acc, 0.44, 0.60, config)
      expect(result).toBeNull()
    })

    it('stops when max exposure is reached', async () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.costYes = 5.0
      acc.costNo = 5.0 // total = $10 = maxExposure

      // Set up realtimeServiceRef
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).realtimeServiceRef = {
        getPrice: () => ({ ask: 0.45, bid: 0.44, mid: 0.445, spread: 0.01, timestamp: new Date() }),
        isStale: () => false,
      }

      await strategy.evaluateAndOrder(acc)
      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('respects cooldown between orders', async () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.lastOrderTime = Date.now() // just ordered

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).realtimeServiceRef = {
        getPrice: () => ({ ask: 0.45, bid: 0.44, mid: 0.445, spread: 0.01, timestamp: new Date() }),
        isStale: () => false,
      }

      await strategy.evaluateAndOrder(acc)
      expect(mockPlaceBet).not.toHaveBeenCalled()
    })
  })

  // ==========================================
  // FILL PROCESSING
  // ==========================================

  describe('fill processing', () => {
    it('updates qtyYes and costYes on YES fill', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.pendingOrderIds.add('order-yes-1')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).tokenToMarketMap.set('token-yes-1', { marketId: market.id, side: 'yes' })

      // Simulate fill
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).onFill('order-yes-1', 'token-yes-1', '0.46', '2.17')

      expect(acc.qtyYes).toBeCloseTo(2.17)
      expect(acc.costYes).toBeCloseTo(0.46 * 2.17)
      expect(acc.fills).toHaveLength(1)
      expect(acc.fills[0].side).toBe('yes')
    })

    it('updates qtyNo and costNo on NO fill', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.pendingOrderIds.add('order-no-1')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).tokenToMarketMap.set('token-no-1', { marketId: market.id, side: 'no' })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).onFill('order-no-1', 'token-no-1', '0.44', '2.27')

      expect(acc.qtyNo).toBeCloseTo(2.27)
      expect(acc.costNo).toBeCloseTo(0.44 * 2.27)
    })

    it('recomputes pairCost correctly after fills', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.pendingOrderIds.add('order-yes-1')
      acc.pendingOrderIds.add('order-no-1')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const strat = strategy as any
      strat.tokenToMarketMap.set('token-yes-1', { marketId: market.id, side: 'yes' })
      strat.tokenToMarketMap.set('token-no-1', { marketId: market.id, side: 'no' })

      // Fill YES: 10 shares @ 0.47
      strat.onFill('order-yes-1', 'token-yes-1', '0.47', '10')
      // Fill NO: 10 shares @ 0.45
      strat.onFill('order-no-1', 'token-no-1', '0.45', '10')

      // pairCost = (4.7 + 4.5) / min(10, 10) = 9.2 / 10 = 0.92
      expect(acc.pairCost).toBeCloseTo(0.92)
    })

    it('computes lockedProfit correctly', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.pendingOrderIds.add('o1')
      acc.pendingOrderIds.add('o2')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const strat = strategy as any
      strat.tokenToMarketMap.set('token-yes-1', { marketId: market.id, side: 'yes' })
      strat.tokenToMarketMap.set('token-no-1', { marketId: market.id, side: 'no' })

      // Fill YES: 100 shares @ 0.48 = $48 cost
      strat.onFill('o1', 'token-yes-1', '0.48', '100')
      // Fill NO: 100 shares @ 0.45 = $45 cost
      strat.onFill('o2', 'token-no-1', '0.45', '100')

      // lockedProfit = min(100, 100) - (48 + 45) = 100 - 93 = $7
      expect(acc.lockedProfit).toBeCloseTo(7)
    })

    it('computes imbalance correctly', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.pendingOrderIds.add('o1')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const strat = strategy as any
      strat.tokenToMarketMap.set('token-yes-1', { marketId: market.id, side: 'yes' })

      // Only YES filled — 100% imbalance
      strat.onFill('o1', 'token-yes-1', '0.45', '10')

      expect(acc.imbalance).toBeCloseTo(1.0)
    })
  })

  // ==========================================
  // PROFIT LOCK
  // ==========================================

  describe('profit lock', () => {
    it('stops buying when lockedProfit > 0', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.pendingOrderIds.add('o1')
      acc.pendingOrderIds.add('o2')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const strat = strategy as any
      strat.tokenToMarketMap.set('token-yes-1', { marketId: market.id, side: 'yes' })
      strat.tokenToMarketMap.set('token-no-1', { marketId: market.id, side: 'no' })

      // Both sides accumulate cheaply: avg_yes + avg_no < 1.00
      strat.onFill('o1', 'token-yes-1', '0.47', '100')
      strat.onFill('o2', 'token-no-1', '0.45', '100')

      expect(acc.lockedProfit).toBeGreaterThan(0)
      expect(acc.stopped).toBe(true)
    })

    it('emits profitLocked event', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.pendingOrderIds.add('o1')
      acc.pendingOrderIds.add('o2')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const strat = strategy as any
      strat.tokenToMarketMap.set('token-yes-1', { marketId: market.id, side: 'yes' })
      strat.tokenToMarketMap.set('token-no-1', { marketId: market.id, side: 'no' })

      const emitSpy = vi.fn()
      strategy.on('profitLocked', emitSpy)

      strat.onFill('o1', 'token-yes-1', '0.47', '100')
      strat.onFill('o2', 'token-no-1', '0.45', '100')

      expect(emitSpy).toHaveBeenCalledTimes(1)
      expect(emitSpy).toHaveBeenCalledWith('profitLocked', expect.objectContaining({
        profit: expect.any(Number),
        pairCost: expect.any(Number),
      }))
    })

    it('does not trigger profit lock when pair cost >= 1.00', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.pendingOrderIds.add('o1')
      acc.pendingOrderIds.add('o2')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const strat = strategy as any
      strat.tokenToMarketMap.set('token-yes-1', { marketId: market.id, side: 'yes' })
      strat.tokenToMarketMap.set('token-no-1', { marketId: market.id, side: 'no' })

      // Expensive fills: 0.52 + 0.50 = 1.02 pair cost
      strat.onFill('o1', 'token-yes-1', '0.52', '100')
      strat.onFill('o2', 'token-no-1', '0.50', '100')

      expect(acc.lockedProfit).toBeLessThanOrEqual(0)
      expect(acc.stopped).toBe(false)
    })

    it('computes profit as min(qtyYes, qtyNo) - totalCost', () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.pendingOrderIds.add('o1')
      acc.pendingOrderIds.add('o2')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const strat = strategy as any
      strat.tokenToMarketMap.set('token-yes-1', { marketId: market.id, side: 'yes' })
      strat.tokenToMarketMap.set('token-no-1', { marketId: market.id, side: 'no' })

      // Unbalanced: 80 YES @ 0.48 + 100 NO @ 0.44
      strat.onFill('o1', 'token-yes-1', '0.48', '80')
      strat.onFill('o2', 'token-no-1', '0.44', '100')

      // profit = min(80, 100) - (80*0.48 + 100*0.44) = 80 - (38.4 + 44) = 80 - 82.4 = -2.4
      expect(acc.lockedProfit).toBeCloseTo(-2.4)
    })
  })

  // ==========================================
  // WINDOW LIFECYCLE
  // ==========================================

  describe('window lifecycle', () => {
    it('stops buying near window end', async () => {
      const market = makeMarket({
        endDate: new Date(Date.now() + 60_000).toISOString(), // Only 1 min left
      })
      const acc = makeAccumulator(strategy, market)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).realtimeServiceRef = {
        getPrice: () => ({ ask: 0.45, bid: 0.44, mid: 0.445, spread: 0.01, timestamp: new Date() }),
        isStale: () => false,
      }

      await strategy.evaluateAndOrder(acc)
      expect(acc.stopped).toBe(true)
      expect(mockPlaceBet).not.toHaveBeenCalled()
    })
  })

  // ==========================================
  // ORDER PLACEMENT
  // ==========================================

  describe('order placement', () => {
    it('places GTC postOnly orders', async () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.lastOrderTime = 0 // No cooldown

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).realtimeServiceRef = {
        getPrice: (tokenId: string) => {
          if (tokenId === 'token-yes-1') return { ask: 0.45, bid: 0.44, mid: 0.445, spread: 0.01, timestamp: new Date() }
          return { ask: 0.55, bid: 0.54, mid: 0.545, spread: 0.01, timestamp: new Date() }
        },
        isStale: () => false,
      }

      await strategy.evaluateAndOrder(acc)

      expect(mockPlaceBet).toHaveBeenCalledWith(
        market,
        'yes', // YES is at 0.45 < threshold 0.48
        1, // orderSize
        expect.objectContaining({
          orderType: 'GTC',
          postOnly: true,
          strategy: 'gabagool',
          limitPrice: 0.44, // 0.45 - 0.01 offset
        }),
      )
    })

    it('uses correct limit price offset', async () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.lastOrderTime = 0

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).realtimeServiceRef = {
        getPrice: (tokenId: string) => {
          if (tokenId === 'token-no-1') return { ask: 0.43, bid: 0.42, mid: 0.425, spread: 0.01, timestamp: new Date() }
          return { ask: 0.57, bid: 0.56, mid: 0.565, spread: 0.01, timestamp: new Date() }
        },
        isStale: () => false,
      }

      await strategy.evaluateAndOrder(acc)

      expect(mockPlaceBet).toHaveBeenCalledWith(
        market,
        'no',
        1,
        expect.objectContaining({
          limitPrice: 0.42, // 0.43 - 0.01
        }),
      )
    })

    it('uses strategy tag gabagool', async () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)
      acc.lastOrderTime = 0

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).realtimeServiceRef = {
        getPrice: () => ({ ask: 0.45, bid: 0.44, mid: 0.445, spread: 0.01, timestamp: new Date() }),
        isStale: () => false,
      }

      await strategy.evaluateAndOrder(acc)

      expect(mockPlaceBet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ strategy: 'gabagool' }),
      )
    })

    it('skips order when no prices available', async () => {
      const market = makeMarket()
      const acc = makeAccumulator(strategy, market)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(strategy as any).realtimeServiceRef = {
        getPrice: () => null,
        isStale: () => false,
      }

      await strategy.evaluateAndOrder(acc)
      expect(mockPlaceBet).not.toHaveBeenCalled()
    })
  })
})
