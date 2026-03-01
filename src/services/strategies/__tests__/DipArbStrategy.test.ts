import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Market } from '@/types'
import type { DipEvent } from '../DipDetector'

// ==========================================
// MOCKS
// ==========================================

// Mock tradingService
const mockPlaceBet = vi.fn()
const mockPlaceSell = vi.fn()
vi.mock('@/services/trading/TradingService', () => ({
  tradingService: {
    placeBet: (...args: unknown[]) => mockPlaceBet(...args),
    placeSell: (...args: unknown[]) => mockPlaceSell(...args),
    setConfig: vi.fn(),
  },
}))

// Mock walletService (dynamic import for merge init)
vi.mock('@/services/wallet', () => ({
  walletService: {
    getWallet: vi.fn().mockReturnValue({ address: '0xtest' }),
    ensureApprovals: vi.fn().mockResolvedValue(true),
    subscribe: vi.fn(),
  },
}))

// Mock MergeService (dynamic import used by DipArb for on-chain merge)
const mockMerge = vi.fn()
const mockComputeMergeAmount = vi.fn().mockReturnValue(1000000n) // $1.00 in USDC.e units
vi.mock('@/services/trading/MergeService', () => ({
  mergeService: {
    isReady: vi.fn().mockReturnValue(true),
    initialize: vi.fn(),
    merge: (...args: unknown[]) => mockMerge(...args),
    computeMergeAmount: (...args: unknown[]) => mockComputeMergeAmount(...args),
  },
}))

// Mock gammaClient
const mockGetMarket = vi.fn()
vi.mock('@/services/api/GammaClient', () => ({
  gammaClient: {
    getCryptoMarkets: vi.fn().mockResolvedValue([]),
    getMarket: (...args: unknown[]) => mockGetMarket(...args),
  },
}))

// Mock clobClient (used by DipArb for getOrderBook + dynamic import for getFeeRateBps)
const mockClobClient = {
  getOrderBook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
  getFeeRateBps: vi.fn().mockResolvedValue(100),
}
vi.mock('@/services/api/CLOBClient', () => ({
  clobClient: mockClobClient,
}))

// Mock barrel (dynamic import('@/services/api') used in PLM tracking paths)
vi.mock('@/services/api', () => ({
  clobClient: mockClobClient,
  gammaClient: {
    getCryptoMarkets: vi.fn().mockResolvedValue([]),
    getMarket: (...args: unknown[]) => mockGetMarket(...args),
  },
  polymarketClient: { hasCredentials: vi.fn().mockReturnValue(true) },
}))

// Mock realtimeService
vi.mock('@/services/realtime', () => ({
  realtimeService: {
    subscribeMarket: vi.fn(),
    unsubscribeMarket: vi.fn(),
    onPriceUpdate: vi.fn(() => () => {}),
    getPrice: vi.fn(),
  },
}))

// Mock activityLogger
vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: {
    logSystem: vi.fn(),
    logScan: vi.fn(),
    logTrade: vi.fn(),
    logSell: vi.fn(),
    logError: vi.fn(),
    logWarning: vi.fn(),
    logInfo: vi.fn(),
    logAnalysis: vi.fn(),
  },
}))

// Mock walletStore (imported by DipArbStrategy for Kelly sizing)
vi.mock('@/stores/walletStore', () => ({
  useWalletStore: {
    getState: vi.fn(() => ({
      balance: 100,
      buyingPower: 100,
    })),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}))

// Mock PLM (dynamic import used by strategy)
const mockTrackPosition = vi.fn()
vi.mock('@/services/trading/PositionLifecycleManager', () => ({
  positionLifecycleManager: {
    trackPosition: (...args: unknown[]) => mockTrackPosition(...args),
  },
}))

// Mock gas oracle (imported by DipArbStrategy for arb gas checks)
vi.mock('@/services/trading/GasOracle', () => ({
  gasOracle: {
    estimateCostUSD: vi.fn().mockResolvedValue(0.001), // negligible gas
    getEstimate: vi.fn().mockResolvedValue({ gasPrice: 30, maxFeePerGas: 50, maxPriorityFeePerGas: 30, timestamp: Date.now() }),
    isGasTooExpensive: vi.fn().mockReturnValue(false),
  },
}))

// Mock trade logger (imported by DipArbStrategy for backtest logging)
vi.mock('@/services/trading/TradeLogger', () => ({
  tradeLogger: {
    logEntry: vi.fn(),
    logExit: vi.fn(),
    getSummary: vi.fn().mockReturnValue({ totalTrades: 0 }),
  },
}))

// Mock orderBookDepth (imported by DipArbStrategy for depth-capped sizing)
const mockCheckBuyDepth = vi.fn()
vi.mock('@/services/trading/OrderBookDepth', () => ({
  orderBookDepth: {
    checkBuyDepth: (...args: unknown[]) => mockCheckBuyDepth(...args),
    checkSellDepth: vi.fn().mockResolvedValue({ sufficient: true, maxFillableUSD: 1000 }),
    getMaxFillableSize: vi.fn().mockResolvedValue(1000),
  },
}))

// ==========================================
// HELPERS
// ==========================================

function createTestMarket(overrides?: Partial<Market>): Market {
  return {
    id: 'market-001',
    slug: 'btc-above-100k-315pm',
    question: 'Will BTC be above $100k at 3:15 PM UTC?',
    outcomes: ['Yes', 'No'],
    clobTokenIds: ['token-yes-001', 'token-no-001'],
    conditionId: '0xabcdef1234567890',
    active: true,
    closed: false,
    endDate: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min from now
    createdAt: new Date().toISOString(),
    volume: 10000,
    volume24hr: 5000,
    liquidity: 8000,
    outcomePrices: [0.35, 0.60], // YES=35¢, NO=60¢, total=95¢
    ...overrides,
  }
}

function createDipEvent(overrides?: Partial<DipEvent>): DipEvent {
  const market = createTestMarket()
  return {
    market,
    tokenId: 'token-yes-001',
    outcome: 'yes' as const,
    previousPrice: 0.55,
    currentPrice: 0.35,
    dipPercent: 0.36, // 36% drop
    timestamp: Date.now(),
    windowMs: 10000,
    ...overrides,
  }
}

// ==========================================
// TESTS
// ==========================================

describe('DipArbStrategy', () => {
  let strategy: InstanceType<typeof import('../DipArbStrategy').DipArbStrategy>
  let dipCallback: ((event: DipEvent) => void) | null = null

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })

    // Default: placeBet succeeds
    mockPlaceBet.mockResolvedValue({
      success: true,
      orderId: 'order-123',
      txHash: '0x' + '0'.repeat(64),
      filledSize: 10,
      avgPrice: 0.35,
    })

    // Default: merge succeeds
    mockMerge.mockResolvedValue({
      success: true,
      txHash: '0xmerge123',
    })

    // Default: getMarket returns same prices (no slippage)
    mockGetMarket.mockImplementation((marketId: string) =>
      Promise.resolve(createTestMarket({ id: marketId }))
    )

    // Default: sufficient depth for both legs
    mockCheckBuyDepth.mockResolvedValue({
      sufficient: true,
      maxFillableUSD: 1000,
      availableLiquidity: 1000,
      estimatedFillPrice: 0.35,
      estimatedSlippage: 0.001,
      bestPrice: 0.35,
    })

    // Import fresh instance each test
    const { DipArbStrategy } = await import('../DipArbStrategy')
    strategy = new DipArbStrategy()

    // Capture the dip callback when initialize() is called
    // The strategy creates a DipDetector internally, so we need to
    // trigger the callback via the public interface

    // Since handleDipEvent is private and only callable through the
    // DipDetector's onDip callback, and DipDetector is created internally,
    // we'll test through the strategy's internal method by accessing it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dipCallback = (event: DipEvent) => (strategy as any).handleDipEvent(event)

    await strategy.initialize()
    // Mark as running so handleDipEvent doesn't bail
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(strategy as any)._enabled = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(strategy as any)._status = 'running'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ==========================================
  // TWO-LEG EXECUTION
  // ==========================================

  describe('two-leg arbitrage', () => {
    it('executes both legs and merges when sum < $1', async () => {
      const event = createDipEvent()

      await dipCallback!(event)

      // Leg 1: Buy YES — Kelly: arbKelly(0.05)=0.10, sizeBet(0.20, 100, 0.10) = $2
      expect(mockPlaceBet).toHaveBeenCalledTimes(2)
      expect(mockPlaceBet).toHaveBeenNthCalledWith(1, event.market, 'yes', 2, { skipGtcFallback: true, orderType: 'GTD', gtdExpiryMs: 120_000 })

      // Leg 2: Buy NO
      expect(mockPlaceBet).toHaveBeenNthCalledWith(2, event.market, 'no', 2, { skipGtcFallback: true, orderType: 'GTD', gtdExpiryMs: 120_000 })

      // Merge positions (conditionId + bigint USDC.e units from computeMergeAmount)
      expect(mockMerge).toHaveBeenCalledWith(
        event.market.conditionId,
        expect.any(BigInt)
      )

      // Arb round should be recorded
      const rounds = strategy.getArbRounds()
      expect(rounds).toHaveLength(1)
      expect(rounds[0].leg1Executed).toBe(true)
      expect(rounds[0].leg2Executed).toBe(true)
      expect(rounds[0].leg1TokenId).toBe('token-yes-001')
      expect(rounds[0].leg2TokenId).toBe('token-no-001')
    })

    it('records profit in arb round after successful merge', async () => {
      const event = createDipEvent()

      await dipCallback!(event)

      const rounds = strategy.getArbRounds()
      expect(rounds[0].profit).toBeGreaterThan(0)
    })

    it('sells leg 1 back when leg 2 fails', async () => {
      mockPlaceBet
        .mockResolvedValueOnce({ success: true, orderId: 'leg1', filledSize: 10 }) // Leg 1 OK
        .mockResolvedValueOnce({ success: false, error: 'Insufficient liquidity' }) // Leg 2 fails

      mockPlaceSell.mockResolvedValue({ success: true, orderId: 'sell-back' })

      const event = createDipEvent()
      await dipCallback!(event)

      // Should try to sell leg 1 back (placeSell now takes slug, outcome, shares)
      expect(mockPlaceSell).toHaveBeenCalledWith('btc-above-100k-315pm', 'yes', 10)

      // Merge should NOT be called
      expect(mockMerge).not.toHaveBeenCalled()

      // Round should show leg 2 failed
      const rounds = strategy.getArbRounds()
      expect(rounds[0].leg1Executed).toBe(true)
      expect(rounds[0].leg2Executed).toBe(false)
    })

    it('tracks position with PLM when fallback sell also fails', async () => {
      mockPlaceBet
        .mockResolvedValueOnce({ success: true, orderId: 'leg1', filledSize: 10 })
        .mockResolvedValueOnce({ success: false, error: 'Insufficient liquidity' })

      mockPlaceSell.mockResolvedValue({ success: false, error: 'No buyers' })

      const event = createDipEvent()
      await dipCallback!(event)

      // Should have tried to sell
      expect(mockPlaceSell).toHaveBeenCalled()

      // PLM tracks via dynamic import().then() — flush microtasks
      await new Promise(r => setTimeout(r, 0))
      await vi.advanceTimersByTimeAsync(0)
      // Dynamic import + .then() needs multiple microtask flushes
      await new Promise(r => setTimeout(r, 0))

      expect(mockTrackPosition).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenId: 'token-yes-001',
          outcome: 'yes',
          strategy: 'dip',
        })
      )
    })

    it('skips when leg 1 fails', async () => {
      mockPlaceBet.mockResolvedValue({ success: false, error: 'Risk check failed' })

      const event = createDipEvent()
      await dipCallback!(event)

      // Only 1 call (leg 1), no leg 2 attempt
      expect(mockPlaceBet).toHaveBeenCalledTimes(1)
      expect(mockMerge).not.toHaveBeenCalled()
    })

    it('aborts Leg 2 and sells Leg 1 when prices move (slippage protection)', async () => {
      // After Leg 1, complement price rises so total >= $1
      mockGetMarket.mockResolvedValue(
        createTestMarket({
          outcomePrices: [0.35, 0.68], // 35¢ + 68¢ = 103¢ — arb gone
        })
      )

      mockPlaceSell.mockResolvedValue({ success: true, orderId: 'sell-slippage' })

      const event = createDipEvent() // YES=35¢, NO=60¢ originally
      await dipCallback!(event)

      // Leg 1 should execute (uses original price)
      expect(mockPlaceBet).toHaveBeenCalledTimes(1)
      expect(mockPlaceBet).toHaveBeenCalledWith(event.market, 'yes', 2, { skipGtcFallback: true, orderType: 'GTD', gtdExpiryMs: 120_000 })

      // Leg 2 should NOT execute — slippage check aborted
      // Instead, Leg 1 should be sold back (placeSell now takes slug, outcome, shares)
      expect(mockPlaceSell).toHaveBeenCalledWith('btc-above-100k-315pm', 'yes', 10)

      // Merge should NOT be called
      expect(mockMerge).not.toHaveBeenCalled()

      // Round recorded as leg2 failed
      const rounds = strategy.getArbRounds()
      expect(rounds).toHaveLength(1)
      expect(rounds[0].leg1Executed).toBe(true)
      expect(rounds[0].leg2Executed).toBe(false)
    })

    it('proceeds with Leg 2 when prices still valid after recheck', async () => {
      // After Leg 1, prices haven't moved much — still profitable
      mockGetMarket.mockResolvedValue(
        createTestMarket({
          outcomePrices: [0.36, 0.61], // 36¢ + 61¢ = 97¢ — still arb
        })
      )

      const event = createDipEvent()
      await dipCallback!(event)

      // Both legs should execute
      expect(mockPlaceBet).toHaveBeenCalledTimes(2)
      // Merge should be called
      expect(mockMerge).toHaveBeenCalled()
    })

    it('proceeds with original price when slippage check API fails', async () => {
      // API error during recheck — should fall through to Leg 2 with original price
      mockGetMarket.mockRejectedValue(new Error('API timeout'))

      const event = createDipEvent()
      await dipCallback!(event)

      // Both legs should still execute (best effort)
      expect(mockPlaceBet).toHaveBeenCalledTimes(2)
      expect(mockMerge).toHaveBeenCalled()
    })

    it('tracks both positions when merge fails', async () => {
      mockMerge.mockResolvedValue({ success: false, error: 'Gas estimation failed' })

      const event = createDipEvent()
      // Start the arb (don't await yet — it will block on merge retries)
      const arbPromise = dipCallback!(event)

      // Advance through merge retry backoffs: 2s + 4s + 8s = 14s total
      await vi.advanceTimersByTimeAsync(15000)
      await arbPromise

      // Both legs executed
      expect(mockPlaceBet).toHaveBeenCalledTimes(2)

      // Merge attempted 3 times (with retry)
      expect(mockMerge).toHaveBeenCalledTimes(3)

      // PLM tracks via dynamic import().then() — flush microtasks
      await new Promise(r => setTimeout(r, 0))
      await vi.advanceTimersByTimeAsync(0)
      await new Promise(r => setTimeout(r, 0))

      expect(mockTrackPosition).toHaveBeenCalledTimes(2)
      expect(mockTrackPosition).toHaveBeenCalledWith(
        expect.objectContaining({ tokenId: 'token-yes-001', outcome: 'yes' })
      )
      expect(mockTrackPosition).toHaveBeenCalledWith(
        expect.objectContaining({ tokenId: 'token-no-001', outcome: 'no' })
      )
    })
  })

  // ==========================================
  // VALIDATION & GUARDS
  // ==========================================

  describe('validation', () => {
    it('skips when strategy is not running', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (strategy as any)._status = 'idle'

      await dipCallback!(createDipEvent())
      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('skips when strategy is not enabled', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (strategy as any)._enabled = false

      await dipCallback!(createDipEvent())
      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('skips when max concurrent trades reached', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (strategy as any).activeTrades = 3

      await dipCallback!(createDipEvent())
      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('skips when YES + NO >= $1 (no arb opportunity)', async () => {
      const event = createDipEvent({
        market: createTestMarket({
          outcomePrices: [0.55, 0.50], // 105¢ total — no arb
        }),
        currentPrice: 0.55,
      })

      await dipCallback!(event)
      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('skips when market has fewer than 2 clobTokenIds', async () => {
      const event = createDipEvent({
        market: createTestMarket({ clobTokenIds: ['only-one'] }),
      })

      await dipCallback!(event)
      expect(mockPlaceBet).not.toHaveBeenCalled()
    })

    it('enforces cooldown between trades on same market', async () => {
      const event = createDipEvent()

      // First trade
      await dipCallback!(event)
      expect(mockPlaceBet).toHaveBeenCalledTimes(2)

      // Reset mock and try immediately — should be blocked by cooldown
      mockPlaceBet.mockClear()
      await dipCallback!(event)
      expect(mockPlaceBet).not.toHaveBeenCalled()

      // Advance past cooldown (30s default)
      await vi.advanceTimersByTimeAsync(31000)

      await dipCallback!(event)
      expect(mockPlaceBet).toHaveBeenCalledTimes(2) // Both legs again
    })
  })

  // ==========================================
  // STATS & CONFIG
  // ==========================================

  describe('stats and config', () => {
    it('getArbStats returns correct counts', async () => {
      // Execute a successful round
      await dipCallback!(createDipEvent())

      const stats = strategy.getArbStats()
      expect(stats.rounds).toBe(1)
      expect(stats.completed).toBe(1)
      expect(stats.failed).toBe(0)
      expect(stats.totalProfit).toBeGreaterThan(0)
    })

    it('getArbStats counts failed rounds', async () => {
      mockPlaceBet.mockResolvedValue({ success: false, error: 'fail' })

      await dipCallback!(createDipEvent())

      const stats = strategy.getArbStats()
      expect(stats.rounds).toBe(1)
      expect(stats.completed).toBe(0)
      expect(stats.failed).toBe(1)
    })

    it('getDipConfig returns config copy', () => {
      const config = strategy.getDipConfig()
      expect(config.shares).toBe(5)
      expect(config.sumTarget).toBe(0.96)
      expect(config.dipThreshold).toBe(0.05)
    })

    it('setDipConfig updates config', () => {
      strategy.setDipConfig({ shares: 5, dipThreshold: 0.25 })
      const config = strategy.getDipConfig()
      expect(config.shares).toBe(5)
      expect(config.dipThreshold).toBe(0.25)
    })
  })

  // ==========================================
  // COMPLEMENT OUTCOME LOGIC
  // ==========================================

  describe('complement outcome', () => {
    it('buys NO when YES dips', async () => {
      const event = createDipEvent({ outcome: 'yes' })
      await dipCallback!(event)

      // Leg 1 = YES, Leg 2 = NO
      expect(mockPlaceBet).toHaveBeenNthCalledWith(1, event.market, 'yes', 2, { skipGtcFallback: true, orderType: 'GTD', gtdExpiryMs: 120_000 })
      expect(mockPlaceBet).toHaveBeenNthCalledWith(2, event.market, 'no', 2, { skipGtcFallback: true, orderType: 'GTD', gtdExpiryMs: 120_000 })
    })

    it('buys YES when NO dips', async () => {
      const market = createTestMarket({
        outcomePrices: [0.60, 0.35], // YES=60¢, NO=35¢
      })
      const event = createDipEvent({
        market,
        outcome: 'no',
        tokenId: 'token-no-001',
        currentPrice: 0.35,
        previousPrice: 0.55,
      })

      await dipCallback!(event)

      // Leg 1 = NO, Leg 2 = YES
      expect(mockPlaceBet).toHaveBeenNthCalledWith(1, market, 'no', 2, { skipGtcFallback: true, orderType: 'GTD', gtdExpiryMs: 120_000 })
      expect(mockPlaceBet).toHaveBeenNthCalledWith(2, market, 'yes', 2, { skipGtcFallback: true, orderType: 'GTD', gtdExpiryMs: 120_000 })
    })
  })
})
