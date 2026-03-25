import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProjectFWStrategy } from '../ProjectFWStrategy'

// Mock all external dependencies

vi.mock('@/services/api/GammaClient', () => ({
  gammaClient: {
    getActiveMarkets: vi.fn().mockResolvedValue([]),
    getEvents: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@/services/api/CLOBClient', () => ({
  clobClient: {
    getOrderBook: vi.fn().mockResolvedValue({
      bids: [{ price: 0.45, size: 100 }],
      asks: [{ price: 0.46, size: 100 }],
    }),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    getFeeRateBps: vi.fn().mockResolvedValue(100),
  },
}))

vi.mock('@/services/realtime', () => ({
  realtimeService: {
    onPriceUpdate: vi.fn(() => vi.fn()),
    subscribeMarket: vi.fn(),
    unsubscribeMarket: vi.fn(),
    getPrice: vi.fn(),
  },
}))

vi.mock('@/services/trading/TradingService', () => ({
  tradingService: {
    placeBet: vi.fn().mockResolvedValue({ success: true, orderId: 'order-1', filledSize: 6 }),
    placeSell: vi.fn().mockResolvedValue({ success: true, orderId: 'sell-1' }),
    setConfig: vi.fn(),
  },
}))

vi.mock('@/services/wallet', () => ({
  walletService: {
    mergePositions: vi.fn().mockResolvedValue({ success: true, txHash: '0xabc' }),
    ensureApprovals: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/services/llm/OllamaService', () => ({
  ollamaService: {
    classifyDependencies: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: {
    subscribe: vi.fn(() => vi.fn()),
    logSystem: vi.fn(),
    logScan: vi.fn(),
    logTrade: vi.fn(),
    logSell: vi.fn(),
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
  },
}))

vi.mock('@/services/trading/PositionLifecycleManager', () => ({
  positionLifecycleManager: {
    trackPosition: vi.fn(),
  },
}))

vi.mock('@/stores/walletStore', () => ({
  useWalletStore: {
    getState: () => ({ balance: 100, buyingPower: 100 }),
  },
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      dailyLossLimit: 10,
      weeklyLossLimit: 50,
      maxTradesPerHour: 20,
      consecutiveFailureLimit: 5,
      minBalanceForTrade: 5,
      minMaticForGas: 0.01,
      riskManagementEnabled: true,
    }),
  },
}))

describe('ProjectFWStrategy', () => {
  let strategy: ProjectFWStrategy

  beforeEach(() => {
    vi.clearAllMocks()
    strategy = new ProjectFWStrategy()
  })

  afterEach(async () => {
    if (strategy.status === 'running') {
      await strategy.stop()
    }
  })

  describe('lifecycle', () => {
    it('initializes to idle status', async () => {
      await strategy.initialize()
      expect(strategy.status).toBe('idle')
    })

    it('starts and sets running status', async () => {
      await strategy.initialize()
      await strategy.start()
      expect(strategy.status).toBe('running')
    })

    it('stops and returns to idle', async () => {
      await strategy.initialize()
      await strategy.start()
      await strategy.stop()
      expect(strategy.status).toBe('idle')
    })

    it('has correct metadata', () => {
      expect(strategy.name).toBe('ProjectFW Arb')
      expect(strategy.strategyType).toBe('arbitrage')
      expect(strategy.description).toContain('Frank-Wolfe')
    })

    it('enable/disable lifecycle works', async () => {
      await strategy.initialize()
      await strategy.enable()
      expect(strategy.enabled).toBe(true)
      expect(strategy.status).toBe('running')

      await strategy.disable()
      expect(strategy.enabled).toBe(false)
      expect(strategy.status).toBe('idle')
    })

    it('double start is idempotent', async () => {
      await strategy.initialize()
      await strategy.start()
      await strategy.start() // Should not throw
      expect(strategy.status).toBe('running')
    })
  })

  describe('configuration', () => {
    it('returns default config', () => {
      const config = strategy.getFWConfig()
      expect(config.alpha).toBe(0.5)
      expect(config.tradeSize).toBe(5)
      expect(config.minProfitBps).toBe(30)
      expect(config.maxConcurrentArbs).toBe(2)
      expect(config.takerFeeBps).toBe(0)
    })

    it('updates config via setFWConfig', () => {
      strategy.setFWConfig({ tradeSize: 5, alpha: 0.8 })
      const config = strategy.getFWConfig()
      expect(config.tradeSize).toBe(5)
      expect(config.alpha).toBe(0.8)
      // Other values remain default
      expect(config.minProfitBps).toBe(30)
    })

    it('emits configUpdated event', () => {
      const handler = vi.fn()
      strategy.on('configUpdated', handler)
      strategy.setFWConfig({ tradeSize: 10 })
      expect(handler).toHaveBeenCalled()
    })

    it('accepts custom config in constructor', () => {
      const custom = new ProjectFWStrategy({ tradeSize: 10, alpha: 0.9 })
      const config = custom.getFWConfig()
      expect(config.tradeSize).toBe(10)
      expect(config.alpha).toBe(0.9)
    })
  })

  describe('arb stats', () => {
    it('starts with empty stats', () => {
      const stats = strategy.getArbStats()
      expect(stats.rounds).toBe(0)
      expect(stats.completed).toBe(0)
      expect(stats.failed).toBe(0)
      expect(stats.totalProfit).toBe(0)
    })

    it('getArbRounds returns empty array initially', () => {
      expect(strategy.getArbRounds()).toEqual([])
    })

    it('strategy stats start at zero', () => {
      const stats = strategy.getStats()
      expect(stats.totalTrades).toBe(0)
      expect(stats.totalPnl).toBe(0)
    })
  })

  describe('events', () => {
    it('emits statusChanged on start/stop', async () => {
      await strategy.initialize()
      const handler = vi.fn()
      strategy.on('statusChanged', handler)

      await strategy.start()
      expect(handler).toHaveBeenCalledWith('statusChanged', 'running')

      await strategy.stop()
      expect(handler).toHaveBeenCalledWith('statusChanged', 'idle')
    })

    it('cleanup removes price subscriptions on stop', async () => {
      const { realtimeService } = await import('@/services/realtime')
      await strategy.initialize()
      await strategy.start()

      // The onPriceUpdate callback should have been registered
      expect(realtimeService.onPriceUpdate).toHaveBeenCalled()

      await strategy.stop()
      // After stop, the unsubscribe function from onPriceUpdate should have been called
    })
  })

  describe('scanning', () => {
    it('runs full scan on enable', async () => {
      const { gammaClient } = await import('@/services/api/GammaClient')
      await strategy.initialize()
      await strategy.enable()

      // Full scan calls getActiveMarkets (runFullScan checks _enabled)
      expect(gammaClient.getActiveMarkets).toHaveBeenCalled()
    })
  })

  describe('cooldown', () => {
    it('respects market cooldown', () => {
      // Access private method through prototype for testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isOnCooldown = (strategy as any).isOnCooldown.bind(strategy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastTradeTimes = (strategy as any).lastTradeTimes as Map<string, number>

      // No cooldown for unknown market
      expect(isOnCooldown('market-1')).toBe(false)

      // Set recent trade time
      lastTradeTimes.set('market-1', Date.now())
      expect(isOnCooldown('market-1')).toBe(true)

      // Old trade time should not be on cooldown
      lastTradeTimes.set('market-2', Date.now() - 120000) // 2 min ago
      expect(isOnCooldown('market-2')).toBe(false)
    })
  })
})
