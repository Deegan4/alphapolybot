import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// ==========================================
// MOCKS
// ==========================================

const mockSettings = vi.hoisted(() => ({
  moondevApiKey: 'test-key-123',
  moondevMultiExchangeLiqEnabled: true,
  moondevProximityEnabled: true,
  moondevSentimentEnabled: true,
  moondevSentimentMinZScore: 2.0,
  moondevProximityMaxDistancePct: 2.0,
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => mockSettings,
  },
}))

const mockGetAllLiquidations = vi.fn()
const mockGetPositionSnapshots = vi.fn()
const mockGetHLPSentiment = vi.fn()
const mockSetApiKey = vi.fn()

vi.mock('@/services/api/MoonDevClient', () => ({
  moonDevClient: {
    getAllLiquidations: mockGetAllLiquidations,
    getPositionSnapshots: mockGetPositionSnapshots,
    getHLPSentiment: mockGetHLPSentiment,
    setApiKey: mockSetApiKey,
  },
}))

vi.mock('@/services/trading/ActivityLogger', () => ({
  activityLogger: { logSystem: vi.fn() },
}))

// ==========================================
// MoonDevSentimentService
// ==========================================

describe('MoonDevSentimentService', () => {
  let service: InstanceType<typeof import('../MoonDevSentimentService').MoonDevSentimentService>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSettings.moondevApiKey = 'test-key-123'
    const mod = await import('../MoonDevSentimentService')
    service = new mod.MoonDevSentimentService()
  })

  afterEach(() => { service.stop() })

  it('getSentimentSignal returns neutral for unknown coin', () => {
    const sig = service.getSentimentSignal('UNKNOWN')
    expect(sig.zScore).toBe(0)
    expect(sig.direction).toBe('neutral')
    expect(sig.isExtreme).toBe(false)
  })

  it('zScore > 2.0 → bullish, isExtreme true', async () => {
    mockGetHLPSentiment.mockResolvedValue({
      timestamp: '2026-01-01', net_delta: { BTC: { value: 1000, z_score: 2.5, signal: 'bullish' } },
      overall_signal: 'bullish', confidence: 'high',
    })
    await service.start()
    const sig = service.getSentimentSignal('BTC')
    expect(sig.zScore).toBe(2.5)
    expect(sig.direction).toBe('bullish')
    expect(sig.isExtreme).toBe(true)
  })

  it('zScore < -2.0 → bearish, isExtreme true', async () => {
    mockGetHLPSentiment.mockResolvedValue({
      timestamp: '2026-01-01', net_delta: { BTC: { value: -1000, z_score: -3.5, signal: 'bearish' } },
      overall_signal: 'bearish', confidence: 'high',
    })
    await service.start()
    const sig = service.getSentimentSignal('BTC')
    expect(sig.direction).toBe('bearish')
    expect(sig.isExtreme).toBe(true)
    expect(sig.confidence).toBe('high')
  })

  it('zScore between -2 and 2 → isExtreme false', async () => {
    mockGetHLPSentiment.mockResolvedValue({
      timestamp: '2026-01-01', net_delta: { BTC: { value: 100, z_score: 1.5, signal: 'neutral' } },
      overall_signal: 'neutral', confidence: 'low',
    })
    await service.start()
    expect(service.getSentimentSignal('BTC').isExtreme).toBe(false)
  })

  it('shouldFilterTrade: true when extreme opposes direction', async () => {
    mockGetHLPSentiment.mockResolvedValue({
      timestamp: '2026-01-01', net_delta: { BTC: { value: -2000, z_score: -2.5, signal: 'bearish' } },
      overall_signal: 'bearish', confidence: 'medium',
    })
    await service.start()
    expect(service.shouldFilterTrade('BTC', 'up')).toBe(true)
    expect(service.shouldFilterTrade('BTC', 'down')).toBe(false)
  })

  it('shouldFilterTrade: false when not extreme', async () => {
    mockGetHLPSentiment.mockResolvedValue({
      timestamp: '2026-01-01', net_delta: { BTC: { value: 100, z_score: 1.0, signal: 'neutral' } },
      overall_signal: 'neutral', confidence: 'low',
    })
    await service.start()
    expect(service.shouldFilterTrade('BTC', 'up')).toBe(false)
  })

  it('handles API error gracefully', async () => {
    mockGetHLPSentiment.mockRejectedValue(new Error('API down'))
    await service.start()
    expect(service.getMetrics().pollErrors).toBe(1)
    expect(service.getSentimentSignal('BTC').direction).toBe('neutral')
  })

  it('no-op when API key is empty', async () => {
    mockSettings.moondevApiKey = ''
    await service.start()
    expect(mockGetHLPSentiment).not.toHaveBeenCalled()
    mockSettings.moondevApiKey = 'test-key-123'
  })

  it('metrics track extreme count', async () => {
    mockGetHLPSentiment.mockResolvedValue({
      timestamp: '2026-01-01',
      net_delta: {
        BTC: { value: 100, z_score: 2.5, signal: 'bullish' },
        ETH: { value: -200, z_score: -3.0, signal: 'bearish' },
        SOL: { value: 50, z_score: 0.5, signal: 'neutral' },
      },
      overall_signal: 'mixed', confidence: 'medium',
    })
    await service.start()
    expect(service.getMetrics().extremeCount).toBe(2)
  })
})

// ==========================================
// MoonDevPositionProximityService
// ==========================================

describe('MoonDevPositionProximityService', () => {
  let service: InstanceType<typeof import('../MoonDevPositionProximityService').MoonDevPositionProximityService>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSettings.moondevApiKey = 'test-key-123'
    const mod = await import('../MoonDevPositionProximityService')
    service = new mod.MoonDevPositionProximityService()
  })

  afterEach(() => { service.stop() })

  it('getNearLiquidationFuel returns zeroes when no data', () => {
    const fuel = service.getNearLiquidationFuel('long')
    expect(fuel.count).toBe(0)
    expect(fuel.totalValueUSD).toBe(0)
  })

  it('filters positions by distance correctly', async () => {
    mockGetPositionSnapshots.mockResolvedValue({
      symbol: 'BTC', count: 3,
      snapshots: [
        { symbol: 'BTC', side: 'long', position_value: 100_000, distance_pct: 0.8, entry_price: 85000, liquidation_price: 84320, current_price: 85000, leverage: 20, snapshot_time: Date.now(), user: '0x1' },
        { symbol: 'BTC', side: 'long', position_value: 50_000, distance_pct: 1.5, entry_price: 85000, liquidation_price: 83725, current_price: 85000, leverage: 10, snapshot_time: Date.now(), user: '0x2' },
        { symbol: 'BTC', side: 'short', position_value: 200_000, distance_pct: 5.0, entry_price: 85000, liquidation_price: 89250, current_price: 85000, leverage: 5, snapshot_time: Date.now(), user: '0x3' },
      ],
    })
    await service.start()
    const longFuel = service.getNearLiquidationFuel('long')
    expect(longFuel.count).toBe(2)
    expect(longFuel.totalValueUSD).toBe(150_000)
    expect(longFuel.within1PctUSD).toBe(100_000)
    expect(service.getNearLiquidationFuel('short').count).toBe(0)
  })

  it('getProximitySignal returns correct asymmetry', async () => {
    mockGetPositionSnapshots.mockResolvedValue({
      symbol: 'BTC', count: 2,
      snapshots: [
        { symbol: 'BTC', side: 'long', position_value: 300_000, distance_pct: 1.0, entry_price: 85000, liquidation_price: 84150, current_price: 85000, leverage: 20, snapshot_time: Date.now(), user: '0x1' },
        { symbol: 'BTC', side: 'short', position_value: 100_000, distance_pct: 1.0, entry_price: 85000, liquidation_price: 85850, current_price: 85000, leverage: 20, snapshot_time: Date.now(), user: '0x2' },
      ],
    })
    await service.start()
    const signal = service.getProximitySignal()
    expect(signal.longFuelUSD).toBe(300_000)
    expect(signal.shortFuelUSD).toBe(100_000)
    expect(signal.dominantRisk).toBe('long')
    expect(signal.asymmetry).toBe(3.0)
  })

  it('handles API error gracefully', async () => {
    mockGetPositionSnapshots.mockRejectedValue(new Error('timeout'))
    await service.start()
    expect(service.getMetrics().pollErrors).toBe(1)
  })
})

// ==========================================
// MoonDevLiquidationService
// ==========================================

describe('MoonDevLiquidationService', () => {
  let service: InstanceType<typeof import('../MoonDevLiquidationService').MoonDevLiquidationService>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSettings.moondevApiKey = 'test-key-123'
    const mod = await import('../MoonDevLiquidationService')
    service = new mod.MoonDevLiquidationService()
  })

  afterEach(() => { service.stop() })

  it('start/stop lifecycle', async () => {
    mockGetAllLiquidations.mockResolvedValue({ liquidations: [], count: 0 })
    expect(service.isRunning()).toBe(false)
    await service.start()
    expect(service.isRunning()).toBe(true)
    service.stop()
    expect(service.isRunning()).toBe(false)
  })

  it('filters BTC liquidations from mixed symbols', async () => {
    mockGetAllLiquidations.mockResolvedValue({
      count: 3,
      liquidations: [
        { symbol: 'BTC', side: 'long', value: 50_000, price: 85000, timestamp: Date.now(), exchange: 'binance' },
        { symbol: 'ETH', side: 'long', value: 30_000, price: 3000, timestamp: Date.now(), exchange: 'binance' },
        { symbol: 'BTCUSDT', side: 'short', value: 40_000, price: 85000, timestamp: Date.now(), exchange: 'bybit' },
      ],
    })
    await service.start()
    const summary = service.getLiquidationSummary()
    expect(summary.longVolume5m + summary.shortVolume5m).toBe(90_000)
  })

  it('computes dominant side when heavily one-sided', async () => {
    mockGetAllLiquidations.mockResolvedValue({
      count: 3,
      liquidations: [
        { symbol: 'BTC', side: 'long', value: 80_000, price: 85000, timestamp: Date.now() - 60_000, exchange: 'binance' },
        { symbol: 'BTC', side: 'long', value: 70_000, price: 85000, timestamp: Date.now() - 30_000, exchange: 'bybit' },
        { symbol: 'BTC', side: 'short', value: 20_000, price: 85000, timestamp: Date.now() - 10_000, exchange: 'okx' },
      ],
    })
    await service.start()
    expect(service.getLiquidationSummary().dominantSide).toBe('long')
  })

  it('balanced when close to even', async () => {
    mockGetAllLiquidations.mockResolvedValue({
      count: 2,
      liquidations: [
        { symbol: 'BTC', side: 'long', value: 55_000, price: 85000, timestamp: Date.now() - 60_000, exchange: 'binance' },
        { symbol: 'BTC', side: 'short', value: 50_000, price: 85000, timestamp: Date.now() - 30_000, exchange: 'bybit' },
      ],
    })
    await service.start()
    expect(service.getLiquidationSummary().dominantSide).toBe('balanced')
  })

  it('handles API error gracefully', async () => {
    mockGetAllLiquidations.mockRejectedValue(new Error('network'))
    await service.start()
    expect(service.getMetrics().pollErrors).toBe(1)
  })

  it('no-op when API key is empty', async () => {
    mockSettings.moondevApiKey = ''
    await service.start()
    expect(mockGetAllLiquidations).not.toHaveBeenCalled()
    mockSettings.moondevApiKey = 'test-key-123'
  })
})
