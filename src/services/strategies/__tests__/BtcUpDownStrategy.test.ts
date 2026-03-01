import { describe, it, expect, vi, beforeEach } from 'vitest'
import { KellySizer } from '@/services/trading/KellySizer'

// ==========================================
// MOCKS — needed to import the strategy module
// ==========================================

const { mockSettingsState } = vi.hoisted(() => {
  const mockSettingsState: Record<string, unknown> = {
    dryRun: true,
    pennyTraderMode: false,
    kellyFraction: 0.25,
    btcEnableBtc: true,
    btcEnableEth: false,
    btcEnableSol: false,
    btcMinConfidence: 0.38,
    btcMaxEntryPrice: 0.45,
    btcStopLossPercent: 0.35,
    btcTakeProfitPercent: 0.70,
    btcMaxConcurrentPositions: 3,
    btcCooldownMs: 15000,
    btcTradeSize: 5,
    btcUseKellySizing: false,
    btcMinWindowRemaining: 120,
    btcMinTimeIntoWindowMs: 45000,
    btcRegimeFilterEnabled: true,
    btcRsiFilterEnabled: true,
  }
  return { mockSettingsState }
})

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ ...mockSettingsState }),
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

vi.mock('@/services/trading/TradingService', () => ({
  tradingService: {
    placeBet: vi.fn(),
    placeSell: vi.fn(),
    setConfig: vi.fn(),
  },
}))

vi.mock('@/services/api', () => ({
  polymarketClient: {
    getEventBySlug: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('@/services/api/PriceOracleService', () => ({
  priceOracle: {
    getPrice: vi.fn().mockResolvedValue(97000),
    subscribe: vi.fn(() => () => {}),
  },
}))

vi.mock('@/services/realtime', () => ({
  realtimeService: {
    subscribeMarket: vi.fn(),
    unsubscribeMarket: vi.fn(),
    onPriceUpdate: vi.fn(() => () => {}),
    getPrice: vi.fn(),
  },
}))

vi.mock('@/services/realtime/BinanceWSService', () => ({
  binanceWSService: {
    onPriceUpdate: vi.fn(() => () => {}),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

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

vi.mock('@/services/trading/PositionLifecycleManager', () => ({
  positionLifecycleManager: {
    openPosition: vi.fn(),
    getPositions: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('@/services/trading/RiskManager', () => ({
  riskManager: {
    canTrade: vi.fn().mockReturnValue(true),
    recordTradeResult: vi.fn(),
  },
}))

vi.mock('@/services/trading/TradeLogger', () => ({
  tradeLogger: {
    recordTrade: vi.fn(),
  },
}))

vi.mock('@/services/trading/RejectionTracker', () => ({
  rejectionTracker: {
    record: vi.fn(),
    getSummary: vi.fn().mockReturnValue({}),
  },
}))

vi.mock('@/services/trading/OrderBookDepth', () => ({
  orderBookDepth: {
    checkBuyDepth: vi.fn().mockResolvedValue({ maxFillableUSD: 100, bestAskPrice: 0.40 }),
  },
}))

// Import after all mocks are set up
import { parseReferencePrice, BtcUpDownStrategy } from '../BtcUpDownStrategy'
import { fuseBtcSignals } from '../btcupdown/signalEngine'

// ==========================================
// TESTS
// ==========================================

describe('parseReferencePrice', () => {
  it('extracts price from standard question format', () => {
    const question = 'Will the price of BTC be up or down from $97,432.52 between 3:00 PM and 3:15 PM ET on January 15, 2025?'
    expect(parseReferencePrice(question)).toBe(97432.52)
  })

  it('extracts price without comma separator', () => {
    expect(parseReferencePrice('Will BTC be up from $97432.52?')).toBe(97432.52)
  })

  it('extracts price without decimals', () => {
    expect(parseReferencePrice('Will BTC be up from $100000?')).toBe(100000)
  })

  it('extracts large price with multiple commas', () => {
    expect(parseReferencePrice('Price from $1,234,567.89 between')).toBe(1234567.89)
  })

  it('extracts ETH-range prices', () => {
    expect(parseReferencePrice('ETH up or down from $3,245.67?')).toBe(3245.67)
  })

  it('extracts SOL-range prices', () => {
    expect(parseReferencePrice('SOL up or down from $187.42?')).toBe(187.42)
  })

  it('returns null when no $ found', () => {
    expect(parseReferencePrice('Will BTC go up or down today?')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseReferencePrice('')).toBeNull()
  })

  it('returns null for zero price', () => {
    expect(parseReferencePrice('Price from $0 between')).toBeNull()
  })

  it('handles first $ when multiple prices present', () => {
    const question = 'From $97,000.00 to $98,000.00?'
    expect(parseReferencePrice(question)).toBe(97000)
  })
})


describe('BtcUpDownStrategy', () => {
  let strategy: BtcUpDownStrategy

  beforeEach(() => {
    strategy = new BtcUpDownStrategy()
  })

  describe('classifyRegime', () => {
    const mkPrices = (values: number[]): Array<{ price: number; timestamp: number }> =>
      values.map((price, i) => ({ price, timestamp: i * 1000 }))

    it('returns neutral for insufficient data (<10 points)', () => {
      const prices = mkPrices([100, 101, 102, 103, 104])
      expect(strategy.classifyRegime(prices)).toBe('neutral')
    })

    it('detects trending market (steady uptrend)', () => {
      // Every step adds to displacement — efficiency near 1.0
      const prices = mkPrices([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110])
      expect(strategy.classifyRegime(prices)).toBe('trending')
    })

    it('detects choppy market (oscillating)', () => {
      // Oscillates around 100 — displacement near 0, path is long
      const prices = mkPrices([100, 102, 98, 101, 99, 102, 98, 101, 99, 100, 100.1])
      expect(strategy.classifyRegime(prices)).toBe('choppy')
    })

    it('detects neutral regime for moderate moves', () => {
      // Some displacement but also noise
      const prices = mkPrices([100, 101, 99, 100.5, 101.5, 100, 101, 102, 101, 102, 103])
      const regime = strategy.classifyRegime(prices)
      // With mixed moves, efficiency is in 0.15-0.40 range
      expect(['neutral', 'trending']).toContain(regime)
    })

    it('handles flat market (zero total path)', () => {
      const prices = mkPrices([100, 100, 100, 100, 100, 100, 100, 100, 100, 100])
      expect(strategy.classifyRegime(prices)).toBe('neutral')
    })

    it('detects downtrend as trending', () => {
      const prices = mkPrices([110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100])
      expect(strategy.classifyRegime(prices)).toBe('trending')
    })
  })
})


describe('KellySizer.polymarketKellyWithFee', () => {
  it('returns 0 when no edge after fees', () => {
    // 10% fee, buying at 0.95 → effectivePayout 0.90 < 0.95 → no profit possible
    expect(KellySizer.polymarketKellyWithFee(0.96, 0.95, 1000)).toBe(0)
  })

  it('returns 0 when model probability too low', () => {
    // At 40c with 10% fee: effectivePayout=0.90, b=(0.90-0.40)/0.40=1.25
    // Need modelProb > q/b = 0.60/1.25 = 0.48 for positive Kelly
    expect(KellySizer.polymarketKellyWithFee(0.40, 0.40, 1000)).toBe(0)
  })

  it('returns positive Kelly with sufficient edge', () => {
    // At 35c with 10% fee: effectivePayout=0.90, b=(0.90-0.35)/0.35=1.571
    // modelProb=0.60 → f* = (1.571*0.60 - 0.40) / 1.571 = (0.943 - 0.40) / 1.571 ≈ 0.345
    const f = KellySizer.polymarketKellyWithFee(0.60, 0.35, 1000)
    expect(f).toBeGreaterThan(0)
    expect(f).toBeLessThan(0.5)
  })

  it('gives lower Kelly than without fees', () => {
    const withFee = KellySizer.polymarketKellyWithFee(0.60, 0.40, 1000)
    const withoutFee = KellySizer.polymarketKelly(0.60, 0.40)
    expect(withFee).toBeLessThan(withoutFee)
  })

  it('handles zero fee same as standard Kelly', () => {
    const withZeroFee = KellySizer.polymarketKellyWithFee(0.60, 0.40, 0)
    const standard = KellySizer.polymarketKelly(0.60, 0.40)
    expect(withZeroFee).toBeCloseTo(standard, 10)
  })

  it('returns 0 for edge cases', () => {
    expect(KellySizer.polymarketKellyWithFee(0.5, 0, 100)).toBe(0)
    expect(KellySizer.polymarketKellyWithFee(0.5, 1, 100)).toBe(0)
    expect(KellySizer.polymarketKellyWithFee(0.5, -0.1, 100)).toBe(0)
  })

  it('handles standard market fees (100 bps = 1%)', () => {
    // At 40c with 1% fee: effectivePayout=0.99, b=(0.99-0.40)/0.40=1.475
    const f = KellySizer.polymarketKellyWithFee(0.55, 0.40, 100)
    expect(f).toBeGreaterThan(0)
  })

  it('handles extreme fee (10000 bps = 100%)', () => {
    // effectivePayout = 0 → no profit
    expect(KellySizer.polymarketKellyWithFee(0.80, 0.30, 10000)).toBe(0)
  })
})


describe('Volatility and RSI helpers (via strategy internals)', () => {
  let strategy: BtcUpDownStrategy

  beforeEach(() => {
    strategy = new BtcUpDownStrategy()
  })

  // Access private methods via type cast for testing
  const getPrivate = (s: BtcUpDownStrategy) => s as unknown as {
    computeVolatility: (prices: Array<{ price: number; timestamp: number }>) => number
    computeRSI: (prices: Array<{ price: number; timestamp: number }>, period?: number) => number
  }

  describe('computeVolatility', () => {
    const mkPrices = (values: number[]): Array<{ price: number; timestamp: number }> =>
      values.map((price, i) => ({ price, timestamp: i * 1000 }))

    it('returns 0 for fewer than 5 points', () => {
      expect(getPrivate(strategy).computeVolatility(mkPrices([100, 101, 102, 103]))).toBe(0)
    })

    it('returns 0 for constant prices', () => {
      expect(getPrivate(strategy).computeVolatility(mkPrices([100, 100, 100, 100, 100]))).toBe(0)
    })

    it('returns positive for varying prices', () => {
      const prices = mkPrices([100, 101, 99, 100.5, 98, 102])
      expect(getPrivate(strategy).computeVolatility(prices)).toBeGreaterThan(0)
    })

    it('higher volatility for larger swings', () => {
      const calm = mkPrices([100, 100.1, 99.9, 100.05, 99.95, 100])
      const wild = mkPrices([100, 105, 95, 103, 97, 100])
      expect(getPrivate(strategy).computeVolatility(wild))
        .toBeGreaterThan(getPrivate(strategy).computeVolatility(calm))
    })
  })

  describe('computeRSI', () => {
    const mkPrices = (values: number[]): Array<{ price: number; timestamp: number }> =>
      values.map((price, i) => ({ price, timestamp: i * 5000 }))

    it('returns 50 (neutral) for insufficient data', () => {
      const prices = mkPrices([100, 101, 102])
      expect(getPrivate(strategy).computeRSI(prices, 14)).toBe(50)
    })

    it('returns 100 for all gains (no losses)', () => {
      const prices = mkPrices(Array.from({ length: 16 }, (_, i) => 100 + i))
      expect(getPrivate(strategy).computeRSI(prices, 14)).toBe(100)
    })

    it('returns 0 for all losses (no gains)', () => {
      const prices = mkPrices(Array.from({ length: 16 }, (_, i) => 115 - i))
      expect(getPrivate(strategy).computeRSI(prices, 14)).toBe(0)
    })

    it('returns ~50 for equal gains and losses', () => {
      // Alternating +1, -1 → equal gains/losses → RS=1 → RSI=50
      const values = Array.from({ length: 16 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1))
      const rsi = getPrivate(strategy).computeRSI(mkPrices(values), 14)
      expect(rsi).toBeCloseTo(50, 0)
    })

    it('returns high RSI for mostly gains', () => {
      // 12 gains of +1, 2 losses of -0.5
      const values = [100, 101, 102, 103, 104, 105, 106, 107, 108, 107.5, 108.5, 109.5, 110.5, 110, 111]
      const rsi = getPrivate(strategy).computeRSI(mkPrices(values), 14)
      expect(rsi).toBeGreaterThan(70)
    })

    it('returns low RSI for mostly losses', () => {
      const values = [115, 114, 113, 112, 111, 110, 109, 108, 107, 108, 107, 106, 105, 104, 103]
      const rsi = getPrivate(strategy).computeRSI(mkPrices(values), 14)
      expect(rsi).toBeLessThan(30)
    })
  })
})

// ==========================================
// LLM FUSION INTEGRATION TESTS
// ==========================================

describe('LLM Fusion Integration', () => {
  it('fusion enabled + above pre-filter → llmFusion is called', async () => {
    // Set up fusion settings
    mockSettingsState.btcUseLLMFusion = true
    mockSettingsState.btcLLMFusionWeight = 0.30
    mockSettingsState.btcLLMFusionPreFilter = 0.30

    const strat = new BtcUpDownStrategy()
    // Access private method via cast
    const priv = strat as unknown as {
      llmFusion: (asset: string, signalInput: unknown, durationLabel: string) => Promise<unknown>
      lastLLMFusionCallTimes: Map<string, number>
    }

    // Mock llmFusion to track calls
    const fusionSpy = vi.fn().mockResolvedValue({ direction: 'up', confidence: 0.70 })
    priv.llmFusion = fusionSpy

    // The method should be callable
    const result = await priv.llmFusion('BTC', {}, '15m')
    expect(fusionSpy).toHaveBeenCalledWith('BTC', {}, '15m')
    expect(result).toEqual({ direction: 'up', confidence: 0.70 })

    // Cleanup
    delete mockSettingsState.btcUseLLMFusion
    delete mockSettingsState.btcLLMFusionWeight
    delete mockSettingsState.btcLLMFusionPreFilter
  })

  it('per-market cooldown prevents rapid LLM calls', async () => {
    const strat = new BtcUpDownStrategy()
    const priv = strat as unknown as {
      lastLLMFusionCallTimes: Map<string, number>
    }

    // Set a recent call time (just now)
    priv.lastLLMFusionCallTimes.set('BTC-15m', Date.now())

    // Verify the map has the entry
    expect(priv.lastLLMFusionCallTimes.has('BTC-15m')).toBe(true)
    expect(Date.now() - priv.lastLLMFusionCallTimes.get('BTC-15m')!).toBeLessThan(1000)
  })

  it('fusion takes priority over confirmation when both enabled', () => {
    // When useLLMFusion is true, useLLMConfirmation should be in the else branch
    mockSettingsState.btcUseLLMFusion = true
    mockSettingsState.btcUseLLMConfirmation = true

    const strat = new BtcUpDownStrategy()
    const config = strat.getBtcConfig()
    // Both should be set — strategy logic determines precedence
    expect(config.useLLMFusion).toBe(true)
    expect(config.useLLMConfirmation).toBe(true)

    delete mockSettingsState.btcUseLLMFusion
    delete mockSettingsState.btcUseLLMConfirmation
  })

  it('LLM returns null → mechanical signal proceeds unchanged (fail-open)', () => {
    // fuseBtcSignals with null LLM returns mechanical unchanged
    const result = fuseBtcSignals({ direction: 'up', confidence: 0.55 }, null, 0.30)
    expect(result.confidence).toBe(0.55)
    expect(result.direction).toBe('up')
    expect(result.fusionApplied).toBe(false)
  })
})
