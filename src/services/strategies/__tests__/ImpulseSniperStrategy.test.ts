/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Market } from '@/types'

// ==========================================
// MOCK SETTINGS (vi.hoisted to avoid TDZ with vi.mock hoisting)
// ==========================================

const { mockSettings } = vi.hoisted(() => {
  const mockSettings: Record<string, unknown> = {
    impulseEnabled: true,
    impulseThreshold: 200,
    impulseConfirmationMs: 1000,
    impulseSnapbackPct: 0.50,
    impulseTradeSize: 5,
    impulseCooldownMs: 10_000,
    impulsePreferredDuration: '1h',
    impulseOrderMode: 'fok',
    impulseMaxAskPrice: 0.65,
    impulseAggressiveMode: false,
    impulseLookbackSeconds: 3,
    impulseAssets: ['BTC'],
    impulseThresholdETH: 15,
    impulseThresholdSOL: 1.5,
    impulseThresholdXRP: 0.05,
    impulseStopLossPct: 0.20,
    impulseTakeProfitPct: 0.50,
    impulseVpinFilter: false,
    vpinToxicityThreshold: 0.7,
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

const mockOnPriceUpdate = vi.fn().mockReturnValue(() => {})
const mockOnConnectionChange = vi.fn().mockReturnValue(() => {})
vi.mock('@/services/realtime/BinanceWSService', () => ({
  binanceWSService: {
    onPriceUpdate: (...args: unknown[]) => mockOnPriceUpdate(...args),
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
  },
}))

vi.mock('@/services/trading/DynamicFeeService', () => ({
  dynamicFeeService: {
    computeTakerFeeBps: vi.fn().mockReturnValue(100), // 1% fee
  },
}))

const mockShouldTrade = vi.fn().mockReturnValue({ allowed: true })
vi.mock('@/services/trading/EdgeTracker', () => ({
  edgeTracker: {
    shouldTrade: (...args: unknown[]) => mockShouldTrade(...args),
    getStrategyEdge: vi.fn().mockReturnValue({ winRate: 0.5, sampleSize: 0, isReliable: false }),
  },
}))

const mockGetVPIN = vi.fn().mockReturnValue(0)
vi.mock('@/services/trading/VPINService', () => ({
  vpinService: {
    getVPIN: (...args: unknown[]) => mockGetVPIN(...args),
  },
}))

vi.mock('@/services/trading/AvellanedaStoikovPricer', () => ({
  AvellanedaStoikovPricer: {
    estimateVolatility: vi.fn().mockReturnValue({ annualized: 0.65, window: 0.01, isReliable: true }),
  },
}))

// Prevent BtcUpDownStrategy singleton from initializing
vi.mock('../BtcUpDownStrategy', () => ({
  ASSET_SLUG_PATTERNS: {
    BTC: { '5m': 'btc-updown-5m-', '15m': 'btc-updown-15m-', '4h': 'btc-updown-4h-' },
    ETH: { '5m': 'eth-updown-5m-', '15m': 'eth-updown-15m-', '4h': 'eth-updown-4h-' },
    SOL: { '5m': 'sol-updown-5m-', '15m': 'sol-updown-15m-', '4h': 'sol-updown-4h-' },
    XRP: { '5m': 'xrp-updown-5m-', '15m': 'xrp-updown-15m-', '4h': 'xrp-updown-4h-' },
  },
  buildHourlySlug: vi.fn().mockReturnValue('bitcoin-up-or-down-february-28-2026-1pm-et'),
  btcUpDownStrategy: {
    on: vi.fn().mockReturnValue(() => {}),
    emit: vi.fn(),
  },
}))

import { ImpulseSniperStrategy } from '../ImpulseSniperStrategy'

// ==========================================
// HELPERS
// ==========================================

function createTestMarket(overrides?: Partial<Market>): Market {
  return {
    id: 'market-1',
    question: 'Will BTC be up or down?',
    slug: 'btc-updown-test',
    active: true,
    closed: false,
    outcomes: ['Up', 'Down'],
    outcomePrices: ['0.50', '0.50'],
    clobTokenIds: ['token-yes', 'token-no'],
    conditionId: 'cond-1',
    endDateIso: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  } as Market
}

type CryptoAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP'

/** Simulate N seconds of stable price ticks for a given asset */
function fillPriceBuffer(strategy: ImpulseSniperStrategy, price: number, count: number, startTs?: number, asset: CryptoAsset = 'BTC'): void {
  const ts = startTs ?? Date.now() - count * 1000
  for (let i = 0; i < count; i++) {
    (strategy as any).onPriceTick(asset, price, ts + i * 1000)
  }
}

/** Simulate an impulse: stable price, then sudden jump */
function simulateImpulse(
  strategy: ImpulseSniperStrategy,
  basePrice: number,
  impulsePrice: number,
  stableTicks = 10,
  asset: CryptoAsset = 'BTC',
): void {
  const baseTs = Date.now() - (stableTicks + 1) * 1000
  // Fill with stable price
  for (let i = 0; i < stableTicks; i++) {
    (strategy as any).onPriceTick(asset, basePrice, baseTs + i * 1000)
  }
  // Impulse tick
  (strategy as any).onPriceTick(asset, impulsePrice, baseTs + stableTicks * 1000)
}

function resetMockSettings(): void {
  Object.assign(mockSettings, {
    impulseEnabled: true,
    impulseThreshold: 200,
    impulseConfirmationMs: 1000,
    impulseSnapbackPct: 0.50,
    impulseTradeSize: 5,
    impulseCooldownMs: 10_000,
    impulsePreferredDuration: '1h',
    impulseOrderMode: 'fok',
    impulseMaxAskPrice: 0.65,
    impulseAggressiveMode: false,
    impulseLookbackSeconds: 3,
    impulseAssets: ['BTC'],
    impulseThresholdETH: 15,
    impulseThresholdSOL: 1.5,
    impulseThresholdXRP: 0.05,
    impulseStopLossPct: 0.20,
    impulseTakeProfitPct: 0.50,
    impulseVpinFilter: false,
    vpinToxicityThreshold: 0.7,
  })
}

// ==========================================
// TESTS
// ==========================================

describe('ImpulseSniperStrategy', () => {
  let strategy: ImpulseSniperStrategy

  beforeEach(() => {
    vi.useFakeTimers()
    strategy = new ImpulseSniperStrategy()
    // Set to running state for detection tests
    ;(strategy as any)._status = 'running'
    ;(strategy as any)._enabled = true
    mockPlaceBet.mockClear()
    mockGetPrice.mockClear()
    mockOnPriceUpdate.mockClear()
    mockOnConnectionChange.mockClear()
    mockShouldTrade.mockClear()
    mockShouldTrade.mockReturnValue({ allowed: true })
    mockGetVPIN.mockClear()
    mockGetVPIN.mockReturnValue(0)

    resetMockSettings()
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(strategy as any).priceBuffers.clear()
    ;(strategy as any).clearPendingConfirmation()
  })

  // ==========================================
  // IMPULSE DETECTION
  // ==========================================

  describe('Impulse Detection', () => {
    it('does not detect impulse when buffer too short', () => {
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      ;(strategy as any).onPriceTick('BTC', 97000, Date.now())
      ;(strategy as any).onPriceTick('BTC', 97300, Date.now() + 1000)
      expect(emitSpy).not.toHaveBeenCalledWith('impulseDetected', expect.anything())
    })

    it('does not detect impulse when delta below threshold', () => {
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      fillPriceBuffer(strategy, 97000, 10)
      // Move only $100 — below default $200 threshold
      ;(strategy as any).onPriceTick('BTC', 97100, Date.now())
      expect(emitSpy).not.toHaveBeenCalledWith('impulseDetected', expect.anything())
    })

    it('detects UP impulse when price rises >= threshold', () => {
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 97000, 97250)
      expect(emitSpy).toHaveBeenCalledWith('impulseDetected', expect.objectContaining({
        asset: 'BTC',
        direction: 'up',
        magnitude: 250,
      }))
    })

    it('detects DOWN impulse when price drops >= threshold', () => {
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 97000, 96750)
      expect(emitSpy).toHaveBeenCalledWith('impulseDetected', expect.objectContaining({
        asset: 'BTC',
        direction: 'down',
        magnitude: 250,
      }))
    })

    it('aggressive mode uses lower threshold', () => {
      mockSettings.impulseAggressiveMode = true
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 97000, 97120) // $120 move — below 200 but above 100
      expect(emitSpy).toHaveBeenCalledWith('impulseDetected', expect.objectContaining({
        direction: 'up',
        magnitude: 120,
      }))
    })

    it('custom lookback seconds changes comparison window', () => {
      mockSettings.impulseLookbackSeconds = 5
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      const baseTs = Date.now() - 15_000
      // Fill 12 ticks of stable price
      for (let i = 0; i < 12; i++) {
        (strategy as any).onPriceTick('BTC', 97000, baseTs + i * 1000)
      }
      // Gradual rise over last 3s (below threshold per-3s, but above per-5s window)
      (strategy as any).onPriceTick('BTC', 97080, baseTs + 12_000)
      ;(strategy as any).onPriceTick('BTC', 97140, baseTs + 13_000)
      ;(strategy as any).onPriceTick('BTC', 97210, baseTs + 14_000)
      // At 5s lookback, comparing to 97000 → delta 210 > 200 ✓
      expect(emitSpy).toHaveBeenCalledWith('impulseDetected', expect.objectContaining({
        direction: 'up',
      }))
    })

    it('does not double-detect while pending confirmation exists', () => {
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 97000, 97300) // first impulse
      expect(emitSpy).toHaveBeenCalledWith('impulseDetected', expect.anything())
      emitSpy.mockClear()

      // Second impulse while pending — should be skipped
      ;(strategy as any).onPriceTick('BTC', 97500, Date.now())
      expect(emitSpy).not.toHaveBeenCalledWith('impulseDetected', expect.anything())
    })

    it('cooldown prevents detection after recent trade', () => {
      (strategy as any).lastTradeTimes.set('BTC', Date.now()) // just traded
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 97000, 97300)
      expect(emitSpy).not.toHaveBeenCalledWith('impulseDetected', expect.anything())
    })

    it('skips detection when status is not running', () => {
      (strategy as any)._status = 'idle'
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 97000, 97300)
      expect(emitSpy).not.toHaveBeenCalledWith('impulseDetected', expect.anything())
    })

    it('filters assets in BinanceWS subscription callback', async () => {
      // The asset filter is in start()'s onPriceUpdate callback, not in onPriceTick itself.
      // Verify that start() registers a callback that checks impulseAssets.
      mockSettings.impulseAssets = ['BTC']
      ;(strategy as any)._status = 'idle'
      await strategy.start()

      // The callback registered with onPriceUpdate should filter non-BTC
      const callback = mockOnPriceUpdate.mock.calls[0]?.[0]
      expect(callback).toBeDefined()
      // ETH update should be silently ignored (no priceBuffer entry for ETH)
      callback({ symbol: 'ETH', priceUSD: 3520, timestamp: Date.now() })
      expect((strategy as any).priceBuffers.has('ETH')).toBe(false)

      await strategy.stop()
    })
  })

  // ==========================================
  // MULTI-ASSET DETECTION
  // ==========================================

  describe('Multi-Asset Detection', () => {
    it('detects ETH impulse with per-asset threshold', () => {
      mockSettings.impulseAssets = ['BTC', 'ETH']
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 3500, 3520, 10, 'ETH') // $20 move > $15 ETH threshold
      expect(emitSpy).toHaveBeenCalledWith('impulseDetected', expect.objectContaining({
        asset: 'ETH',
        direction: 'up',
        magnitude: 20,
      }))
    })

    it('detects SOL impulse with per-asset threshold', () => {
      mockSettings.impulseAssets = ['SOL']
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 180, 178, 10, 'SOL') // $2 move > $1.50 SOL threshold
      expect(emitSpy).toHaveBeenCalledWith('impulseDetected', expect.objectContaining({
        asset: 'SOL',
        direction: 'down',
        magnitude: 2,
      }))
    })

    it('detects XRP impulse with per-asset threshold', () => {
      mockSettings.impulseAssets = ['XRP']
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 2.50, 2.56, 10, 'XRP') // $0.06 > $0.05 XRP threshold
      expect(emitSpy).toHaveBeenCalledWith('impulseDetected', expect.objectContaining({
        asset: 'XRP',
        direction: 'up',
        magnitude: expect.closeTo(0.06, 2),
      }))
    })

    it('per-asset cooldowns are independent', () => {
      mockSettings.impulseAssets = ['BTC', 'ETH']
      ;(strategy as any).lastTradeTimes.set('BTC', Date.now()) // BTC on cooldown
      const emitSpy = vi.spyOn(strategy as any, 'emit')

      // BTC impulse — should be blocked by cooldown
      simulateImpulse(strategy, 97000, 97300, 10, 'BTC')
      expect(emitSpy).not.toHaveBeenCalledWith('impulseDetected', expect.anything())

      // ETH impulse — no cooldown, should detect
      simulateImpulse(strategy, 3500, 3520, 10, 'ETH')
      expect(emitSpy).toHaveBeenCalledWith('impulseDetected', expect.objectContaining({
        asset: 'ETH',
      }))
    })

    it('per-asset price buffers are isolated', () => {
      mockSettings.impulseAssets = ['BTC', 'ETH']

      // Fill BTC buffer with stable prices
      fillPriceBuffer(strategy, 97000, 10, undefined, 'BTC')
      // Fill ETH buffer with different prices
      fillPriceBuffer(strategy, 3500, 10, undefined, 'ETH')

      const btcBuffer = (strategy as any).priceBuffers.get('BTC')
      const ethBuffer = (strategy as any).priceBuffers.get('ETH')
      expect(btcBuffer.length).toBe(10)
      expect(ethBuffer.length).toBe(10)
      expect(btcBuffer[0].price).toBe(97000)
      expect(ethBuffer[0].price).toBe(3500)
    })
  })

  // ==========================================
  // CONFIRMATION
  // ==========================================

  describe('Confirmation Logic', () => {
    it('confirms impulse when no snapback within confirmation window', () => {
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 97000, 97300)
      expect(emitSpy).toHaveBeenCalledWith('impulseDetected', expect.anything())

      // Price holds during confirmation period
      ;(strategy as any).onPriceTick('BTC', 97280, Date.now() + 500) // slight retrace OK

      vi.advanceTimersByTime(1000) // trigger confirmation
      expect(emitSpy).toHaveBeenCalledWith('impulseConfirmed', expect.objectContaining({
        direction: 'up',
      }))
    })

    it('aborts when snapback > snapbackPct of magnitude', () => {
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 97000, 97300) // $300 up impulse

      // Price retraces 60% (180 of 300) — above 50% threshold
      ;(strategy as any).onPriceTick('BTC', 97120, Date.now() + 500)

      vi.advanceTimersByTime(1000)
      expect(emitSpy).toHaveBeenCalledWith('impulseSkipped', expect.objectContaining({
        reason: 'snapback',
      }))
      expect(emitSpy).not.toHaveBeenCalledWith('impulseConfirmed', expect.anything())
    })

    it('barely-within snapback still confirms (exact boundary)', () => {
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 97000, 97300) // $300 up impulse

      // Price retraces exactly 50% (150 of 300) — at boundary
      ;(strategy as any).onPriceTick('BTC', 97150, Date.now() + 500)

      vi.advanceTimersByTime(1000)
      // 150/300 = 0.50, not > 0.50, so should confirm
      expect(emitSpy).toHaveBeenCalledWith('impulseConfirmed', expect.anything())
    })

    it('clears pending confirmation on stop()', async () => {
      simulateImpulse(strategy, 97000, 97300)
      expect((strategy as any).pendingConfirmation).not.toBeNull()

      await strategy.stop()
      expect((strategy as any).pendingConfirmation).toBeNull()
      expect((strategy as any).confirmationTimer).toBeNull()
    })

    it('aborts if no price data at confirmation time', () => {
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      simulateImpulse(strategy, 97000, 97300)

      // Clear buffer to simulate no data
      ;(strategy as any).priceBuffers.clear()

      vi.advanceTimersByTime(1000)
      expect(emitSpy).toHaveBeenCalledWith('impulseSkipped', expect.objectContaining({
        reason: 'no_price_data',
      }))
    })
  })

  // ==========================================
  // MARKET SELECTION
  // ==========================================

  describe('Market Selection', () => {
    it('selects 1h market when preferred and available', () => {
      const market = createTestMarket()
      ;(strategy as any).cachedMarkets.set('BTC:1h', {
        market,
        yesTokenId: 'token-yes',
        noTokenId: 'token-no',
        windowEndMs: Date.now() + 3600_000,
        durationKey: '1h',
      })

      const result = (strategy as any).findBestMarket('BTC', '1h')
      expect(result).not.toBeNull()
      expect(result.durationKey).toBe('1h')
    })

    it('falls back to 4h when 1h unavailable', () => {
      const market = createTestMarket()
      ;(strategy as any).cachedMarkets.set('BTC:4h', {
        market,
        yesTokenId: 'token-yes',
        noTokenId: 'token-no',
        windowEndMs: Date.now() + 14400_000,
        durationKey: '4h',
      })

      const result = (strategy as any).findBestMarket('BTC', '1h')
      expect(result).not.toBeNull()
      expect(result.durationKey).toBe('4h')
    })

    it('returns null when no active markets', () => {
      const result = (strategy as any).findBestMarket('BTC', '1h')
      expect(result).toBeNull()
    })

    it('skips expired markets', () => {
      const market = createTestMarket()
      ;(strategy as any).cachedMarkets.set('BTC:1h', {
        market,
        yesTokenId: 'token-yes',
        noTokenId: 'token-no',
        windowEndMs: Date.now() + 30_000, // expires in 30s — less than 60s minimum
        durationKey: '1h',
      })

      const result = (strategy as any).findBestMarket('BTC', '1h')
      expect(result).toBeNull()
    })

    it('finds market for ETH asset separately from BTC', () => {
      (strategy as any).cachedMarkets.set('ETH:1h', {
        market: createTestMarket({ id: 'eth-market-1', question: 'Will ETH be up or down?' }),
        yesTokenId: 'eth-yes',
        noTokenId: 'eth-no',
        windowEndMs: Date.now() + 3600_000,
        durationKey: '1h',
      })

      expect((strategy as any).findBestMarket('BTC', '1h')).toBeNull()
      expect((strategy as any).findBestMarket('ETH', '1h')).not.toBeNull()
    })
  })

  // ==========================================
  // TRADE EXECUTION
  // ==========================================

  describe('Trade Execution', () => {
    function setupMarketAndPrice(askPrice = 0.50, asset: CryptoAsset = 'BTC'): void {
      const market = createTestMarket()
      ;(strategy as any).cachedMarkets.set(`${asset}:1h`, {
        market,
        yesTokenId: 'token-yes',
        noTokenId: 'token-no',
        windowEndMs: Date.now() + 3600_000,
        durationKey: '1h',
      })
      ;(strategy as any).realtimeServiceRef = {
        subscribeMarket: vi.fn(),
        getPrice: vi.fn().mockReturnValue({ bid: askPrice - 0.01, ask: askPrice, mid: askPrice - 0.005, spread: 0.01, timestamp: new Date() }),
      }
    }

    it('places FOK order on confirmed UP impulse', async () => {
      setupMarketAndPrice(0.50)
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'market-1' }),
        'yes', // UP → buy YES
        5,     // trade size
        expect.objectContaining({
          orderType: 'FOK',
          strategy: 'impulse',
          stopLossPercent: 0.20,
          takeProfitPercent: 0.50,
        }),
      )
    })

    it('places FOK order on confirmed DOWN impulse', async () => {
      setupMarketAndPrice(0.50)
      ;(strategy as any).realtimeServiceRef.getPrice = vi.fn().mockReturnValue({
        bid: 0.49, ask: 0.50, mid: 0.495, spread: 0.01, timestamp: new Date(),
      })
      const impulse: any = { asset: 'BTC', direction: 'down', magnitude: 250, startPrice: 97000, endPrice: 96750, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).toHaveBeenCalledWith(
        expect.anything(),
        'no', // DOWN → buy NO
        5,
        expect.objectContaining({ orderType: 'FOK' }),
      )
    })

    it('respects maxAskPrice — skips when ask too high', async () => {
      setupMarketAndPrice(0.70) // above 0.65 max
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith('impulseSkipped', expect.objectContaining({
        reason: 'ask_too_high',
      }))
    })

    it('skips when emergency stopped', async () => {
      setupMarketAndPrice(0.50)
      const { riskManager } = await import('@/services/trading/RiskManager')
      ;(riskManager as any).emergencyStopped = true

      const emitSpy = vi.spyOn(strategy as any, 'emit')
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }
      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith('impulseSkipped', expect.objectContaining({
        reason: 'emergency_stopped',
      }))

      // Clean up
      ;(riskManager as any).emergencyStopped = false
    })

    it('GTD order mode uses limit price', async () => {
      mockSettings.impulseOrderMode = 'gtd'
      setupMarketAndPrice(0.50)
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).toHaveBeenCalledWith(
        expect.anything(),
        'yes',
        5,
        expect.objectContaining({
          orderType: 'GTD',
          limitPrice: 0.50,
          gtdExpiryMs: 30_000,
        }),
      )
    })

    it('sets lastTradeTime for the correct asset after successful trade', async () => {
      setupMarketAndPrice(0.50)
      const before = Date.now()
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect((strategy as any).lastTradeTimes.get('BTC')).toBeGreaterThanOrEqual(before)
    })

    it('skips when no market found', async () => {
      (strategy as any).realtimeServiceRef = { subscribeMarket: vi.fn(), getPrice: vi.fn() }
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith('impulseSkipped', expect.objectContaining({
        reason: 'no_market',
      }))
    })

    it('handles placeBet failure gracefully', async () => {
      setupMarketAndPrice(0.50)
      mockPlaceBet.mockResolvedValueOnce({ success: false, error: 'insufficient balance' })
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(emitSpy).toHaveBeenCalledWith('impulseSkipped', expect.objectContaining({
        reason: 'order_failed',
      }))
    })

    it('passes SL/TP to placeBet options', async () => {
      mockSettings.impulseStopLossPct = 0.15
      mockSettings.impulseTakeProfitPct = 0.40
      setupMarketAndPrice(0.50)
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          stopLossPercent: 0.15,
          takeProfitPercent: 0.40,
        }),
      )
    })
  })

  // ==========================================
  // EDGE TRACKER CIRCUIT BREAKER
  // ==========================================

  describe('EdgeTracker Circuit Breaker', () => {
    function setupMarketAndPrice(): void {
      const market = createTestMarket()
      ;(strategy as any).cachedMarkets.set('BTC:1h', {
        market,
        yesTokenId: 'token-yes',
        noTokenId: 'token-no',
        windowEndMs: Date.now() + 3600_000,
        durationKey: '1h',
      })
      ;(strategy as any).realtimeServiceRef = {
        subscribeMarket: vi.fn(),
        getPrice: vi.fn().mockReturnValue({ bid: 0.49, ask: 0.50, mid: 0.495, spread: 0.01, timestamp: new Date() }),
      }
    }

    it('blocks trade when EdgeTracker returns not allowed', async () => {
      setupMarketAndPrice()
      mockShouldTrade.mockReturnValue({ allowed: false, reason: 'blocked: negative Kelly after 20 trades' })
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith('impulseSkipped', expect.objectContaining({
        reason: 'edge_tracker_blocked',
      }))
    })

    it('calls EdgeTracker with strategy=impulse and correct feeBps', async () => {
      setupMarketAndPrice()
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockShouldTrade).toHaveBeenCalledWith('impulse', expect.any(Number))
    })
  })

  // ==========================================
  // VPIN TOXICITY FILTER
  // ==========================================

  describe('VPIN Toxicity Filter', () => {
    function setupMarketAndPrice(): void {
      const market = createTestMarket()
      ;(strategy as any).cachedMarkets.set('BTC:1h', {
        market,
        yesTokenId: 'token-yes',
        noTokenId: 'token-no',
        windowEndMs: Date.now() + 3600_000,
        durationKey: '1h',
      })
      ;(strategy as any).realtimeServiceRef = {
        subscribeMarket: vi.fn(),
        getPrice: vi.fn().mockReturnValue({ bid: 0.49, ask: 0.50, mid: 0.495, spread: 0.01, timestamp: new Date() }),
      }
    }

    it('skips trade when VPIN > toxicity threshold and filter enabled', async () => {
      mockSettings.impulseVpinFilter = true
      mockGetVPIN.mockReturnValue(0.85) // above 0.7 threshold
      setupMarketAndPrice()
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith('impulseSkipped', expect.objectContaining({
        reason: 'vpin_toxic',
      }))
    })

    it('allows trade when VPIN below threshold', async () => {
      mockSettings.impulseVpinFilter = true
      mockGetVPIN.mockReturnValue(0.3) // below 0.7 threshold
      setupMarketAndPrice()
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).toHaveBeenCalled()
    })

    it('ignores VPIN check when filter disabled', async () => {
      mockSettings.impulseVpinFilter = false
      mockGetVPIN.mockReturnValue(0.99) // very toxic but filter off
      setupMarketAndPrice()
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).toHaveBeenCalled()
    })
  })

  // ==========================================
  // POSITION AWARENESS
  // ==========================================

  describe('Position Awareness', () => {
    function setupMarketAndPrice(): void {
      const market = createTestMarket()
      ;(strategy as any).cachedMarkets.set('BTC:1h', {
        market,
        yesTokenId: 'token-yes',
        noTokenId: 'token-no',
        windowEndMs: Date.now() + 3600_000,
        durationKey: '1h',
      })
      ;(strategy as any).realtimeServiceRef = {
        subscribeMarket: vi.fn(),
        getPrice: vi.fn().mockReturnValue({ bid: 0.49, ask: 0.50, mid: 0.495, spread: 0.01, timestamp: new Date() }),
      }
    }

    it('skips when same-direction position exists on market', async () => {
      setupMarketAndPrice()
      ;(strategy as any).activePositionMarkets.add('market-1:up')
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith('impulseSkipped', expect.objectContaining({
        reason: 'position_exists',
      }))
    })

    it('allows opposite-direction trade on same market', async () => {
      setupMarketAndPrice()
      ;(strategy as any).activePositionMarkets.add('market-1:up') // existing UP position

      const impulse: any = { asset: 'BTC', direction: 'down', magnitude: 250, startPrice: 97000, endPrice: 96750, detectedAt: Date.now() }
      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).toHaveBeenCalled()
    })

    it('clears position tracking on stop()', async () => {
      (strategy as any).activePositionMarkets.add('market-1:up')
      await strategy.stop()
      expect((strategy as any).activePositionMarkets.size).toBe(0)
    })
  })

  // ==========================================
  // CLOB STALE-ODDS DETECTION
  // ==========================================

  describe('CLOB Stale-Odds Detection', () => {
    it('returns false when not enough CLOB history', () => {
      const result = (strategy as any).hasClobAlreadyMoved('token-yes', 'up')
      expect(result).toBe(false)
    })

    it('returns true when ask rose 1.5+ cents (repricing detected)', () => {
      const history = [
        { ask: 0.50, timestamp: Date.now() - 4000 },
        { ask: 0.505, timestamp: Date.now() - 3000 },
        { ask: 0.51, timestamp: Date.now() - 2000 },
        { ask: 0.52, timestamp: Date.now() - 1000 }, // +2c from reference entry
      ]
      ;(strategy as any).clobAskHistory.set('token-yes', history)

      const result = (strategy as any).hasClobAlreadyMoved('token-yes', 'up')
      expect(result).toBe(true)
    })

    it('returns true when ask dropped 1.5+ cents (liquidity pulled)', () => {
      const history = [
        { ask: 0.52, timestamp: Date.now() - 4000 },
        { ask: 0.51, timestamp: Date.now() - 3000 },
        { ask: 0.505, timestamp: Date.now() - 2000 },
        { ask: 0.50, timestamp: Date.now() - 1000 }, // -2c from reference
      ]
      ;(strategy as any).clobAskHistory.set('token-yes', history)

      const result = (strategy as any).hasClobAlreadyMoved('token-yes', 'down')
      expect(result).toBe(true)
    })

    it('returns false when ask moved less than 1.5 cents', () => {
      const history = [
        { ask: 0.50, timestamp: Date.now() - 4000 },
        { ask: 0.50, timestamp: Date.now() - 3000 },
        { ask: 0.505, timestamp: Date.now() - 2000 },
        { ask: 0.51, timestamp: Date.now() - 1000 }, // +1c from reference
      ]
      ;(strategy as any).clobAskHistory.set('token-yes', history)

      const result = (strategy as any).hasClobAlreadyMoved('token-yes', 'up')
      expect(result).toBe(false)
    })
  })

  // ==========================================
  // STALENESS GUARD
  // ==========================================

  describe('Staleness Guard', () => {
    function setupMarketAndPrice(askPrice = 0.50): void {
      const market = createTestMarket()
      ;(strategy as any).cachedMarkets.set('BTC:1h', {
        market,
        yesTokenId: 'token-yes',
        noTokenId: 'token-no',
        windowEndMs: Date.now() + 3600_000,
        durationKey: '1h',
      })
      ;(strategy as any).realtimeServiceRef = {
        subscribeMarket: vi.fn(),
        getPrice: vi.fn().mockReturnValue({ bid: askPrice - 0.01, ask: askPrice, mid: askPrice - 0.005, spread: 0.01, timestamp: new Date() }),
      }
    }

    it('skips trade when impulse is stale (too much time elapsed)', async () => {
      setupMarketAndPrice(0.50)
      const emitSpy = vi.spyOn(strategy as any, 'emit')
      // detectedAt is 5 seconds ago — well past confirmation + 1.5s budget
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() - 5000 }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).not.toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith('impulseSkipped', expect.objectContaining({
        reason: 'stale_impulse',
      }))
    })

    it('allows trade when impulse is fresh', async () => {
      setupMarketAndPrice(0.50)
      // detectedAt is just now — within staleness budget
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }

      await (strategy as any).executeTrade(impulse)

      expect(mockPlaceBet).toHaveBeenCalled()
    })
  })

  // ==========================================
  // VOL-ADJUSTED THRESHOLD
  // ==========================================

  describe('Vol-Adjusted Threshold', () => {
    it('returns base threshold when buffer too short', () => {
      const buffer = Array.from({ length: 10 }, (_, i) => ({ price: 97000, timestamp: Date.now() - (10 - i) * 1000 }))
      const result = (strategy as any).applyVolAdjustedThreshold(200, buffer)
      expect(result).toBe(200)
    })

    it('raises threshold in choppy/noisy market', () => {
      // Mix of small and large changes creates high coefficient of variation
      // Pattern: mostly small moves with occasional large spikes
      const prices = [97000]
      for (let i = 1; i < 30; i++) {
        const spike = i % 5 === 0 ? (i % 2 === 0 ? 200 : -200) : (i % 2 === 0 ? 2 : -2)
        prices.push(prices[i - 1] + spike)
      }
      const buffer = prices.map((price, i) => ({
        price,
        timestamp: Date.now() - (30 - i) * 1000,
      }))
      const result = (strategy as any).applyVolAdjustedThreshold(200, buffer)
      expect(result).toBeGreaterThan(200)
    })

    it('returns base threshold in normal volatility', () => {
      // Steady uptrend — moderate, consistent changes
      const buffer = Array.from({ length: 30 }, (_, i) => ({
        price: 97000 + i * 5,
        timestamp: Date.now() - (30 - i) * 1000,
      }))
      const result = (strategy as any).applyVolAdjustedThreshold(200, buffer)
      expect(result).toBe(200)
    })
  })

  // ==========================================
  // METRICS
  // ==========================================

  describe('Metrics', () => {
    it('tracks detected count', () => {
      simulateImpulse(strategy, 97000, 97300)
      expect(strategy.getImpulseMetrics().detected).toBe(1)
    })

    it('tracks confirmed count', () => {
      simulateImpulse(strategy, 97000, 97300)
      ;(strategy as any).onPriceTick('BTC', 97290, Date.now() + 500)
      vi.advanceTimersByTime(1000)
      expect(strategy.getImpulseMetrics().confirmed).toBe(1)
    })

    it('tracks aborted count on snapback', () => {
      simulateImpulse(strategy, 97000, 97300)
      ;(strategy as any).onPriceTick('BTC', 97000, Date.now() + 500) // full snapback
      vi.advanceTimersByTime(1000)
      expect(strategy.getImpulseMetrics().aborted).toBe(1)
    })

    it('tracks skip reasons', async () => {
      // No market cached → should record no_market skip
      (strategy as any).realtimeServiceRef = { subscribeMarket: vi.fn(), getPrice: vi.fn() }
      const impulse: any = { asset: 'BTC', direction: 'up', magnitude: 250, startPrice: 97000, endPrice: 97250, detectedAt: Date.now() }
      await (strategy as any).executeTrade(impulse)

      const metrics = strategy.getImpulseMetrics()
      expect(metrics.skippedReasons['no_market']).toBe(1)
    })

    it('returns a snapshot (not a reference)', () => {
      const m1 = strategy.getImpulseMetrics()
      simulateImpulse(strategy, 97000, 97300)
      const m2 = strategy.getImpulseMetrics()
      expect(m1.detected).toBe(0) // original snapshot unchanged
      expect(m2.detected).toBe(1)
    })
  })

  // ==========================================
  // LIFECYCLE
  // ==========================================

  describe('Lifecycle', () => {
    it('start() subscribes to BinanceWS', async () => {
      (strategy as any)._status = 'idle' // reset from beforeEach 'running'
      await strategy.start()
      expect(mockOnPriceUpdate).toHaveBeenCalled()
      expect(mockOnConnectionChange).toHaveBeenCalled()
      await strategy.stop()
    })

    it('stop() unsubscribes and clears state', async () => {
      (strategy as any)._status = 'idle'
      await strategy.start()
      // Populate some state
      ;(strategy as any).priceBuffers.set('BTC', [{ price: 97000, timestamp: Date.now() }])
      ;(strategy as any).activePositionMarkets.add('test')
      ;(strategy as any).lastTradeTimes.set('BTC', Date.now())

      await strategy.stop()

      expect((strategy as any).priceBuffers.size).toBe(0)
      expect((strategy as any).cachedMarkets.size).toBe(0)
      expect((strategy as any).activePositionMarkets.size).toBe(0)
      expect((strategy as any).lastTradeTimes.size).toBe(0)
      expect((strategy as any)._status).toBe('idle')
    })

    it('does not start when not enabled', async () => {
      (strategy as any)._enabled = false
      ;(strategy as any)._status = 'idle'
      await strategy.start()
      expect((strategy as any)._status).toBe('idle')
      expect(mockOnPriceUpdate).not.toHaveBeenCalled()
    })

    it('idempotent start (calling start twice does not duplicate)', async () => {
      (strategy as any)._status = 'idle'
      await strategy.start()
      const firstCallCount = mockOnPriceUpdate.mock.calls.length
      await strategy.start() // second call — already running, should skip
      expect(mockOnPriceUpdate.mock.calls.length).toBe(firstCallCount)
      await strategy.stop()
    })
  })

  // ==========================================
  // EDGE CASES
  // ==========================================

  describe('Edge Cases', () => {
    it('price buffer trims to 60s', () => {
      const baseTs = Date.now() - 70_000
      for (let i = 0; i < 70; i++) {
        (strategy as any).onPriceTick('BTC', 97000, baseTs + i * 1000)
      }
      const buffer = (strategy as any).priceBuffers.get('BTC')
      expect(buffer.length).toBeLessThanOrEqual(61)
    })

    it('findClosestEntry returns null for empty buffer', () => {
      const result = (strategy as any).findClosestEntry([], Date.now())
      expect(result).toBeNull()
    })

    it('findClosestEntry rejects entries too far from target', () => {
      const buffer = [
        { price: 97000, timestamp: Date.now() - 10_000 },
        { price: 97000, timestamp: Date.now() - 9_000 },
        { price: 97000, timestamp: Date.now() - 8_000 },
        { price: 97000, timestamp: Date.now() - 7_000 },
        { price: 97000, timestamp: Date.now() - 6_000 },
      ]
      // Target 1s ago — all entries are 6+ seconds old
      const result = (strategy as any).findClosestEntry(buffer, Date.now() - 1000)
      expect(result).toBeNull()
    })
  })
})
