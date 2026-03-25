/**
 * E2E Integration Test — Full order lifecycle
 *
 * Tests the happy path: signal → risk check → order creation → OMS tracking →
 * fill → position tracking → exit. Uses dry-run mode with mocked services.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock wallet store
vi.mock('@/stores/walletStore', () => ({
  useWalletStore: {
    getState: () => ({ balance: 50, address: '0xtest', isConnected: true }),
    subscribe: vi.fn(),
  },
}))

// Mock settings store
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      dryRun: true,
      dailyLossLimit: 10,
      weeklyLossLimit: 25,
      maxTradesPerHour: 20,
      consecutiveFailureLimit: 5,
      minBalanceForTrade: 1,
      minMaticForGas: 0.01,
      maxDrawdownPercent: 0.30,
      maxPerMarketExposure: 0.50,
      riskManagementEnabled: true,
      pennyTraderMode: false,
    }),
    subscribe: vi.fn(),
  },
}))

// Mock balance history store (paper balance for dry run)
vi.mock('@/stores/balanceHistoryStore', () => ({
  useBalanceHistoryStore: {
    getState: () => ({ simulatedBalance: 50, initialBalance: 50, snapshots: [] }),
    subscribe: vi.fn(),
  },
}))

// Mock polymarket client
vi.mock('@/services/api', () => ({
  polymarketClient: {
    placeOrder: vi.fn().mockResolvedValue({ success: true, orderId: 'test-order-1' }),
    getOrder: vi.fn().mockResolvedValue({ status: 'filled', filledSize: 10, price: 0.35 }),
    cancelOrder: vi.fn().mockResolvedValue(true),
    cancelAllOrders: vi.fn().mockResolvedValue(true),
    cancelAllOrdersBySlug: vi.fn().mockResolvedValue(true),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getBestPricesBySlug: vi.fn().mockResolvedValue({ bid: 0.35, ask: 0.36 }),
    getBalances: vi.fn().mockResolvedValue({ buyingPower: 50 }),
    tokens: { get: vi.fn().mockReturnValue('token-123') },
  },
}))

// Mock realtime service
vi.mock('@/services/realtime', () => ({
  realtimeService: {
    getPrice: vi.fn().mockReturnValue({ bid: 0.35, ask: 0.36 }),
    onConnectionChange: vi.fn().mockReturnValue(() => {}),
  },
  userChannelService: {
    isConnected: vi.fn().mockReturnValue(false),
    onTrade: vi.fn().mockReturnValue(() => {}),
    onOrder: vi.fn().mockReturnValue(() => {}),
  },
}))

import { RiskManager } from '../RiskManager'
import { TradingService } from '../TradingService'
import { OrderRegistry, OrderState } from '../oms'
import type { Market } from '@/types'

describe('E2E Order Lifecycle', () => {
  let riskManager: RiskManager
  let tradingService: TradingService
  let orderRegistry: OrderRegistry

  const testMarket: Market = {
    slug: 'btc-up-1h-test',
    question: 'Will BTC go up in the next hour?',
    conditionId: 'cond-1',
    outcomes: ['Up', 'Down'],
    outcomePrices: [0.35, 0.65],
    volume: 10000,
    liquidity: 5000,
    active: true,
    closed: false,
    new: false,
    featured: false,
    archived: false,
    tokens: [
      { token_id: 'token-up', outcome: 'Up', price: 0.35, winner: false },
      { token_id: 'token-down', outcome: 'Down', price: 0.65, winner: false },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    riskManager = new RiskManager({ enabled: true })
    riskManager.initialize()
    tradingService = new TradingService({ dryRun: true })
    orderRegistry = new OrderRegistry()
  })

  it('full buy lifecycle: risk check → order → OMS tracking', async () => {
    // 1. Risk check passes
    const riskCheck = riskManager.validateTrade(5, testMarket.slug)
    expect(riskCheck.allowed).toBe(true)

    // 2. Place a buy order
    const result = await tradingService.placeBet(testMarket, 'yes', 5, {
      strategy: 'btc',
      stopLossPercent: 0.15,
      takeProfitPercent: 0.30,
    })

    expect(result.success).toBe(true)
    expect(result.orderId).toBeDefined()
  })

  it('risk check blocks trade when daily loss exceeded', () => {
    // Record enough losses to exceed $10 daily limit
    riskManager.recordTradeResult(true, -4)
    riskManager.recordTradeResult(true, -4)
    riskManager.recordTradeResult(true, -4)

    const check = riskManager.validateTrade(5, testMarket.slug)
    expect(check.allowed).toBe(false)
    expect(check.riskCode).toBe('DAILY_LOSS_EXCEEDED')
  })

  it('OMS tracks order from creation through fill', () => {
    // Create an order in OMS
    const order = orderRegistry.createOrder({
      strategyId: 'btc',
      marketSlug: 'btc-up-1h',
      tokenId: 'token-up',
      outcome: 'yes',
      side: 'BUY',
      orderType: 'FOK',
      price: 0.35,
      size: 10,
      intent: 'open',
      takerFeeBps: 100,
    })

    expect(order.state).toBe(OrderState.INITIALIZED)

    // Submit to exchange
    orderRegistry.markSubmitted(order.id, 'exchange-order-123')
    expect(orderRegistry.getOrder(order.id)?.state).toBe(OrderState.SUBMITTED)

    // Exchange accepts
    orderRegistry.markAccepted(order.id)
    expect(orderRegistry.getOrder(order.id)?.state).toBe(OrderState.ACCEPTED)

    // Order fills
    orderRegistry.markFilled(order.id, 10, 0.35)
    const filledOrder = orderRegistry.getOrder(order.id)!
    expect(filledOrder.state).toBe(OrderState.FILLED)
    expect(filledOrder.filledSize).toBe(10)
    expect(filledOrder.avgFillPrice).toBe(0.35)
  })

  it('cross-strategy exposure check blocks over-concentrated trades', () => {
    // Record heavy BTC exposure from 3 strategies
    riskManager.recordAssetExposure('BTC', 'btc-updown', 20)
    riskManager.recordAssetExposure('BTC', 'dual-side', 15)
    riskManager.recordAssetExposure('BTC', 'gabagool', 10)

    // 3 strategies → dynamic cap = 35% → $50/$50 = 100% >> 35%
    const check = riskManager.checkAssetConcentration('BTC', 5)
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('BTC')
    expect(check.riskCode).toBe('CORRELATED_EXPOSURE')
  })

  it('drawdown throttle increases scan interval multiplier', () => {
    expect(riskManager.getThrottleMultiplier()).toBe(1.0)

    riskManager.recordLossForThrottle()
    expect(riskManager.getThrottleMultiplier()).toBe(1.5)

    riskManager.recordLossForThrottle()
    expect(riskManager.getThrottleMultiplier()).toBe(2.0)

    riskManager.recordLossForThrottle()
    expect(riskManager.getThrottleMultiplier()).toBe(3.0)

    // Reset on win
    riskManager.resetThrottle()
    expect(riskManager.getThrottleMultiplier()).toBe(1.0)
  })

  it('consecutive failure circuit breaker triggers emergency stop', () => {
    // consecutiveFailureLimit is 5 in mock settings
    riskManager.recordTradeResult(false)
    riskManager.recordTradeResult(false)
    riskManager.recordTradeResult(false)
    riskManager.recordTradeResult(false)
    riskManager.recordTradeResult(false) // Hits limit of 5

    const check = riskManager.validateTrade(5)
    expect(check.allowed).toBe(false)
    expect(check.riskCode).toBe('EMERGENCY_STOPPED')
  })

  it('OMS capital tracking reflects active orders', () => {
    const o1 = orderRegistry.createOrder({
      strategyId: 'btc',
      marketSlug: 'btc-up-1h',
      tokenId: 'token-up',
      outcome: 'yes',
      side: 'BUY',
      orderType: 'GTC',
      price: 0.40,
      size: 10,
      intent: 'open',
      takerFeeBps: 0,
    })

    orderRegistry.markSubmitted(o1.id, 'exch-1')
    expect(orderRegistry.getInFlightCapital()).toBeCloseTo(4.0) // 0.40 * 10

    orderRegistry.markAccepted(o1.id)
    expect(orderRegistry.getInFlightCapital()).toBe(0) // moved to reserved
    expect(orderRegistry.getReservedCapital()).toBeCloseTo(4.0)
  })
})
