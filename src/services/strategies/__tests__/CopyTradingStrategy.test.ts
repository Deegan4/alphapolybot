import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ==========================================
// HOISTED MOCKS — declared before vi.mock()
// ==========================================

const {
  mockSettingsState,
  mockPlaceBet,
  mockGetMarket,
  mockGetTradeHistory,
  mockPlmCount,
  mockPlmGetPositions,
} = vi.hoisted(() => ({
  mockSettingsState: {
    dryRun: true,
    followedAddress: '0x63ce342161250d705dc0b16df89036c8e5f9ba9a',
    copyTradeSize: 5,
    copyMaxConcurrent: 5,
    copyPollIntervalMs: 15000,
    copyStopLossPercent: 0.30,
    copyTakeProfitPercent: 0.50,
    copyBuysOnly: true,
  } as Record<string, unknown>,
  mockPlaceBet: vi.fn(),
  mockGetMarket: vi.fn(),
  mockGetTradeHistory: vi.fn(),
  mockPlmCount: { value: 0 },
  mockPlmGetPositions: vi.fn(),
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ ...mockSettingsState }),
  },
}))

vi.mock('@/services/trading', () => ({
  tradingService: {
    placeBet: mockPlaceBet,
  },
  positionLifecycleManager: {
    get count() { return mockPlmCount.value },
    getPositions: mockPlmGetPositions,
  },
}))

vi.mock('@/services/api', () => ({
  gammaClient: {
    getMarket: mockGetMarket,
  },
}))

vi.mock('@/services/api/DataClient', () => {
  return {
    DataClient: class {
      setWalletAddress = vi.fn()
      getTradeHistory = mockGetTradeHistory
    },
  }
})

vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: {
    logTrade: vi.fn(),
    logSystem: vi.fn(),
    logWarning: vi.fn(),
    logError: vi.fn(),
  },
}))

// ==========================================
// HELPERS
// ==========================================

function makeTrade(overrides: Partial<{
  id: string
  marketId: string
  tokenId: string
  side: 'BUY' | 'SELL'
  price: number
  size: number
  timestamp: string
}> = {}) {
  return {
    id: overrides.id ?? 'trade-1',
    marketId: overrides.marketId ?? 'market-1',
    tokenId: overrides.tokenId ?? 'token-yes-1',
    side: overrides.side ?? 'BUY',
    price: overrides.price ?? 0.55,
    size: overrides.size ?? 100,
    fee: 0.01,
    timestamp: overrides.timestamp ?? new Date(Date.now() + 5000).toISOString(),
    txHash: '0xabc',
  }
}

function makeMarket(overrides: Partial<{
  id: string
  question: string
  active: boolean
  closed: boolean
  clobTokenIds: string[]
}> = {}) {
  return {
    id: overrides.id ?? 'market-1',
    question: overrides.question ?? 'Will BTC be above $100k?',
    outcomes: ['Yes', 'No'],
    clobTokenIds: overrides.clobTokenIds ?? ['token-yes-1', 'token-no-1'],
    conditionId: 'cond-1',
    active: overrides.active ?? true,
    closed: overrides.closed ?? false,
    endDate: '2026-03-01',
    createdAt: '2026-01-01',
    volume: 1000000,
    liquidity: 50000,
    outcomePrices: [0.55, 0.45],
  }
}

// ==========================================
// TESTS
// ==========================================

describe('CopyTradingStrategy', () => {
  let CopyTradingStrategyClass: typeof import('../CopyTradingStrategy').CopyTradingStrategy
  let strategy: InstanceType<typeof CopyTradingStrategyClass>

  beforeEach(async () => {
    vi.clearAllMocks()

    // Reset hoisted mocks to defaults
    mockPlaceBet.mockResolvedValue({ success: true })
    mockGetMarket.mockResolvedValue(makeMarket())
    mockGetTradeHistory.mockResolvedValue([])
    mockPlmCount.value = 0
    mockPlmGetPositions.mockReturnValue([])
    mockSettingsState.followedAddress = '0x63ce342161250d705dc0b16df89036c8e5f9ba9a'

    // Fresh instance each test
    const mod = await import('../CopyTradingStrategy')
    CopyTradingStrategyClass = mod.CopyTradingStrategy
    strategy = new CopyTradingStrategyClass()
    await strategy.initialize()
  })

  afterEach(async () => {
    if (strategy?.enabled) {
      await strategy.disable()
    }
  })

  describe('initialization', () => {
    it('should have correct metadata', () => {
      expect(strategy.name).toBe('Copy Trading')
      expect(strategy.strategyType).toBe('copy')
      expect(strategy.description).toContain('Mirror trades')
    })

    it('should start in idle state', () => {
      expect(strategy.enabled).toBe(false)
      expect(strategy.status).toBe('idle')
    })
  })

  describe('start/stop lifecycle', () => {
    it('should set status to running on enable', async () => {
      await strategy.enable()
      expect(strategy.status).toBe('running')
      expect(strategy.enabled).toBe(true)
    })

    it('should set status to idle on disable', async () => {
      await strategy.enable()
      await strategy.disable()
      expect(strategy.status).toBe('idle')
      expect(strategy.enabled).toBe(false)
    })

    it('should set status to error if no followedAddress', async () => {
      mockSettingsState.followedAddress = ''
      await strategy.enable()
      expect(strategy.status).toBe('error')
    })
  })

  describe('trade detection and copying', () => {
    it('should detect and copy a new BUY trade', async () => {
      const trade = makeTrade({ timestamp: new Date(Date.now() + 10000).toISOString() })
      mockGetTradeHistory
        .mockResolvedValueOnce([]) // seedLastSeen
        .mockResolvedValueOnce([trade]) // first poll

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(mockPlaceBet).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'market-1' }),
        'yes',
        5,
        expect.objectContaining({
          stopLossPercent: 0.30,
          takeProfitPercent: 0.50,
        })
      )
    })

    it('should ignore SELL trades when copyBuysOnly is true', async () => {
      const trade = makeTrade({
        side: 'SELL',
        timestamp: new Date(Date.now() + 10000).toISOString(),
      })
      mockGetTradeHistory
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trade])

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('should deduplicate same trade.id', async () => {
      const trade = makeTrade({ timestamp: new Date(Date.now() + 10000).toISOString() })
      mockGetTradeHistory
        .mockResolvedValueOnce([])   // seedLastSeen
        .mockResolvedValue([trade])  // all subsequent polls

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(mockPlaceBet).toHaveBeenCalledTimes(1)
    })

    it('should skip closed markets', async () => {
      mockGetMarket.mockResolvedValue(makeMarket({ closed: true }))
      const trade = makeTrade({ timestamp: new Date(Date.now() + 10000).toISOString() })
      mockGetTradeHistory
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trade])

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('should skip inactive markets', async () => {
      mockGetMarket.mockResolvedValue(makeMarket({ active: false }))
      const trade = makeTrade({ timestamp: new Date(Date.now() + 10000).toISOString() })
      mockGetTradeHistory
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trade])

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('should respect max concurrent positions limit', async () => {
      mockPlmCount.value = 5 // at limit
      const trade = makeTrade({ timestamp: new Date(Date.now() + 10000).toISOString() })
      mockGetTradeHistory
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trade])

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('should skip if already in position on same token', async () => {
      mockPlmGetPositions.mockReturnValue([
        { tokenId: 'token-yes-1', marketId: 'market-1' },
      ])
      const trade = makeTrade({ timestamp: new Date(Date.now() + 10000).toISOString() })
      mockGetTradeHistory
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trade])

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('should resolve NO outcome from tokenId', async () => {
      const trade = makeTrade({
        tokenId: 'token-no-1',
        timestamp: new Date(Date.now() + 10000).toISOString(),
      })
      mockGetTradeHistory
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trade])

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(mockPlaceBet).toHaveBeenCalledWith(
        expect.anything(),
        'no',
        5,
        expect.anything()
      )
    })

    it('should handle API errors gracefully', async () => {
      mockGetTradeHistory
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('API timeout'))

      await strategy.enable()
      // Should not throw
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('should handle placeBet failure gracefully', async () => {
      mockPlaceBet.mockResolvedValue({ success: false, error: 'Risk check failed' })
      const trade = makeTrade({ timestamp: new Date(Date.now() + 10000).toISOString() })
      mockGetTradeHistory
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trade])

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(strategy.tradesCopied).toBe(0)
    })

    it('should increment tradesCopied on success', async () => {
      const trade = makeTrade({ timestamp: new Date(Date.now() + 10000).toISOString() })
      mockGetTradeHistory
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trade])

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(strategy.tradesCopied).toBe(1)
    })

    it('should copy multiple new trades in one poll', async () => {
      const trade1 = makeTrade({ id: 'trade-a', timestamp: new Date(Date.now() + 10000).toISOString() })
      const trade2 = makeTrade({ id: 'trade-b', marketId: 'market-2', tokenId: 'token-yes-2', timestamp: new Date(Date.now() + 11000).toISOString() })
      // Return correct market for each marketId
      mockGetMarket
        .mockResolvedValueOnce(makeMarket()) // market-1 for trade1
        .mockResolvedValueOnce(makeMarket({ id: 'market-2', clobTokenIds: ['token-yes-2', 'token-no-2'] }))
      mockGetTradeHistory
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trade1, trade2])

      await strategy.enable()
      await (strategy as unknown as { poll: () => Promise<void> }).poll()

      expect(mockPlaceBet).toHaveBeenCalledTimes(2)
    })
  })

  describe('outcome resolution', () => {
    it('should return null for unknown tokenId', () => {
      const market = makeMarket()
      const result = (strategy as unknown as {
        resolveOutcome: (tokenId: string, market: typeof market) => 'yes' | 'no' | null
      }).resolveOutcome('unknown-token', market)

      expect(result).toBeNull()
    })

    it('should return null for market with missing clobTokenIds', () => {
      const market = makeMarket({ clobTokenIds: [] })
      const result = (strategy as unknown as {
        resolveOutcome: (tokenId: string, market: typeof market) => 'yes' | 'no' | null
      }).resolveOutcome('token-yes-1', market)

      expect(result).toBeNull()
    })

    it('should resolve yes for first clobTokenId', () => {
      const market = makeMarket()
      const result = (strategy as unknown as {
        resolveOutcome: (tokenId: string, market: typeof market) => 'yes' | 'no' | null
      }).resolveOutcome('token-yes-1', market)

      expect(result).toBe('yes')
    })

    it('should resolve no for second clobTokenId', () => {
      const market = makeMarket()
      const result = (strategy as unknown as {
        resolveOutcome: (tokenId: string, market: typeof market) => 'yes' | 'no' | null
      }).resolveOutcome('token-no-1', market)

      expect(result).toBe('no')
    })
  })
})
