import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PositionLifecycleManager, type TrackedPosition } from '../PositionLifecycleManager'

// ==========================================
// MOCKS
// ==========================================

// Mock RealtimeService
const mockOnPriceUpdate = vi.fn(() => vi.fn()) // returns unsubscribe fn
const mockSubscribeMarket = vi.fn()
const mockUnsubscribeMarket = vi.fn()
const mockGetPrice = vi.fn()
const mockIsStale = vi.fn(() => false) // default: prices are fresh

vi.mock('@/services/realtime', () => ({
  realtimeService: {
    onPriceUpdate: (...args: unknown[]) => mockOnPriceUpdate(...args),
    subscribeMarket: (...args: unknown[]) => mockSubscribeMarket(...args),
    unsubscribeMarket: (...args: unknown[]) => mockUnsubscribeMarket(...args),
    getPrice: (...args: unknown[]) => mockGetPrice(...args),
    isStale: (...args: unknown[]) => mockIsStale(...args),
  },
}))

// Mock TradingService
const mockPlaceSell = vi.fn()
vi.mock('../TradingService', () => ({
  tradingService: {
    placeSell: (...args: unknown[]) => mockPlaceSell(...args),
  },
}))

// Mock RiskManager
const mockRecordTradeResult = vi.fn()
const mockReduceMarketExposure = vi.fn()
vi.mock('../RiskManager', () => ({
  riskManager: {
    recordTradeResult: (...args: unknown[]) => mockRecordTradeResult(...args),
    reduceMarketExposure: (...args: unknown[]) => mockReduceMarketExposure(...args),
  },
}))

// Mock ActivityLogger
vi.mock('../ActivityLogger', () => ({
  activityLogger: {
    logInfo: vi.fn(),
    logWarning: vi.fn(),
    logSell: vi.fn(),
    logError: vi.fn(),
  },
}))

// Strategies mock no longer needed — PLM no longer notifies strategy of close
// (LLMPredictionStrategy now queries PLM directly for position count)

// ==========================================
// HELPERS
// ==========================================

function makePosition(overrides: Partial<TrackedPosition> = {}): TrackedPosition {
  return {
    tokenId: 'token-abc-123',
    marketId: 'market-1',
    conditionId: 'cond-1',
    outcome: 'yes',
    question: 'Will BTC exceed $100k by end of month?',
    entryPrice: 0.50,
    size: 10,
    costBasis: 5.0,
    entryTime: Date.now(),
    stopLossPercent: 0.15,
    takeProfitPercent: 0.30,
    strategy: 'llm',
    ...overrides,
  }
}

// ==========================================
// TESTS
// ==========================================

describe('PositionLifecycleManager', () => {
  let plm: PositionLifecycleManager

  beforeEach(() => {
    vi.clearAllMocks()
    plm = new PositionLifecycleManager()
  })

  afterEach(() => {
    plm.destroy()
  })

  describe('initialize', () => {
    it('subscribes to price updates on init', () => {
      plm.initialize()
      expect(mockOnPriceUpdate).toHaveBeenCalledTimes(1)
      expect(mockOnPriceUpdate).toHaveBeenCalledWith(expect.any(Function))
    })

    it('only initializes once (idempotent)', () => {
      plm.initialize()
      plm.initialize()
      expect(mockOnPriceUpdate).toHaveBeenCalledTimes(1)
    })
  })

  describe('trackPosition', () => {
    it('stores position and subscribes to price feed', () => {
      const pos = makePosition()
      plm.trackPosition(pos)

      expect(plm.count).toBe(1)
      expect(mockSubscribeMarket).toHaveBeenCalledWith('token-abc-123')
    })

    it('tracks multiple positions', () => {
      plm.trackPosition(makePosition({ tokenId: 'a' }))
      plm.trackPosition(makePosition({ tokenId: 'b' }))
      plm.trackPosition(makePosition({ tokenId: 'c' }))

      expect(plm.count).toBe(3)
    })

    it('overwrites position with same tokenId', () => {
      plm.trackPosition(makePosition({ tokenId: 'a', entryPrice: 0.40 }))
      plm.trackPosition(makePosition({ tokenId: 'a', entryPrice: 0.60 }))

      expect(plm.count).toBe(1)
      const positions = plm.getPositions()
      expect(positions[0].entryPrice).toBe(0.60)
    })
  })

  describe('removePosition', () => {
    it('removes position and unsubscribes from price feed', () => {
      plm.trackPosition(makePosition())
      expect(plm.count).toBe(1)

      plm.removePosition('token-abc-123')
      expect(plm.count).toBe(0)
      expect(mockUnsubscribeMarket).toHaveBeenCalledWith('token-abc-123')
    })

    it('does nothing for unknown tokenId', () => {
      plm.removePosition('nonexistent')
      expect(plm.count).toBe(0)
    })
  })

  describe('getPositions', () => {
    it('returns positions with current P&L', () => {
      mockGetPrice.mockReturnValue({
        mid: 0.60, // 20% gain from 0.50 entry
        timestamp: new Date(),
      })

      plm.trackPosition(makePosition({ entryPrice: 0.50, size: 10 }))
      const positions = plm.getPositions()

      expect(positions).toHaveLength(1)
      expect(positions[0].currentPrice).toBe(0.60)
      expect(positions[0].pnlPercent).toBeCloseTo(0.20) // +20%
      expect(positions[0].pnlUsd).toBeCloseTo(1.0) // (0.60 - 0.50) * 10
      expect(positions[0].isStale).toBe(false)
    })

    it('marks position as stale when no recent price', () => {
      mockGetPrice.mockReturnValue({
        mid: 0.50,
        timestamp: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
      })

      plm.trackPosition(makePosition())
      const positions = plm.getPositions()

      expect(positions[0].isStale).toBe(true)
    })

    it('uses entry price as fallback when no price data', () => {
      mockGetPrice.mockReturnValue(null)

      plm.trackPosition(makePosition({ entryPrice: 0.50 }))
      const positions = plm.getPositions()

      expect(positions[0].currentPrice).toBe(0.50)
      expect(positions[0].pnlPercent).toBe(0)
    })
  })

  describe('stop-loss trigger', () => {
    it('triggers sell when price drops below stop-loss threshold', async () => {
      mockPlaceSell.mockResolvedValue({ success: true, orderId: 'sell-1' })
      mockGetPrice.mockReturnValue({ mid: 0.40, timestamp: new Date() })

      plm.initialize()
      plm.trackPosition(makePosition({
        entryPrice: 0.50,
        stopLossPercent: 0.15, // 15% stop-loss
        size: 10,
      }))

      // Simulate price update: 0.50 → 0.40 = -20% (exceeds -15% stop-loss)
      const priceCallback = mockOnPriceUpdate.mock.calls[0][0] as (tokenId: string, data: unknown) => void
      priceCallback('token-abc-123', { mid: 0.40, timestamp: new Date() })

      // Give async sell time to complete
      // placeSell(tokenId, size, price?, negRisk?) — price=undefined, negRisk=undefined
      await vi.waitFor(() => {
        expect(mockPlaceSell).toHaveBeenCalledWith('token-abc-123', 10, undefined, undefined)
      })
    })

    it('does NOT trigger sell within threshold', () => {
      plm.initialize()
      plm.trackPosition(makePosition({
        entryPrice: 0.50,
        stopLossPercent: 0.15,
      }))

      // Simulate price update: 0.50 → 0.45 = -10% (within -15% threshold)
      const priceCallback = mockOnPriceUpdate.mock.calls[0][0] as (tokenId: string, data: unknown) => void
      priceCallback('token-abc-123', { mid: 0.45, timestamp: new Date() })

      expect(mockPlaceSell).not.toHaveBeenCalled()
    })
  })

  describe('take-profit trigger', () => {
    it('triggers sell when price rises above take-profit threshold', async () => {
      mockPlaceSell.mockResolvedValue({ success: true, orderId: 'sell-2' })
      mockGetPrice.mockReturnValue({ mid: 0.70, timestamp: new Date() })

      plm.initialize()
      plm.trackPosition(makePosition({
        entryPrice: 0.50,
        takeProfitPercent: 0.30, // 30% take-profit
        size: 10,
      }))

      // Simulate price update: 0.50 → 0.70 = +40% (exceeds +30% take-profit)
      const priceCallback = mockOnPriceUpdate.mock.calls[0][0] as (tokenId: string, data: unknown) => void
      priceCallback('token-abc-123', { mid: 0.70, timestamp: new Date() })

      await vi.waitFor(() => {
        expect(mockPlaceSell).toHaveBeenCalledWith('token-abc-123', 10, undefined, undefined)
      })
    })
  })

  describe('sell retry logic', () => {
    it('retries failed sell up to maxSellRetries', async () => {
      vi.useFakeTimers()

      // First call fails, second succeeds
      mockPlaceSell
        .mockResolvedValueOnce({ success: false, error: 'RPC error' })
        .mockResolvedValueOnce({ success: true, orderId: 'sell-3' })
      mockGetPrice.mockReturnValue({ mid: 0.40, timestamp: new Date() })

      plm.initialize()
      plm.trackPosition(makePosition({ entryPrice: 0.50, stopLossPercent: 0.15, size: 10 }))

      // Trigger stop-loss
      const priceCallback = mockOnPriceUpdate.mock.calls[0][0] as (tokenId: string, data: unknown) => void
      priceCallback('token-abc-123', { mid: 0.40, timestamp: new Date() })

      // Wait for first (failed) sell
      await vi.advanceTimersByTimeAsync(100)
      expect(mockPlaceSell).toHaveBeenCalledTimes(1)

      // Advance past retry backoff (2s)
      await vi.advanceTimersByTimeAsync(2100)
      expect(mockPlaceSell).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })
  })

  describe('double-sell prevention', () => {
    it('prevents concurrent sell calls for the same position', async () => {
      // Sell takes 500ms to resolve
      mockPlaceSell.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({ success: true, orderId: 'sell-x' }), 500))
      )
      mockGetPrice.mockReturnValue({ mid: 0.40, timestamp: new Date() })

      plm.initialize()
      plm.trackPosition(makePosition({ entryPrice: 0.50, stopLossPercent: 0.15, size: 10 }))

      const priceCallback = mockOnPriceUpdate.mock.calls[0][0] as (tokenId: string, data: unknown) => void

      // Rapid-fire two price updates that both breach stop-loss
      priceCallback('token-abc-123', { mid: 0.40, timestamp: new Date() })
      priceCallback('token-abc-123', { mid: 0.38, timestamp: new Date() })

      // Only ONE sell call should have been made
      await vi.waitFor(() => {
        expect(mockPlaceSell).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('forceClosePosition', () => {
    it('sells and removes position', async () => {
      mockPlaceSell.mockResolvedValue({ success: true, orderId: 'manual-sell' })
      mockGetPrice.mockReturnValue({ mid: 0.55, timestamp: new Date() })

      plm.trackPosition(makePosition())
      expect(plm.count).toBe(1)

      const result = await plm.forceClosePosition('token-abc-123')
      expect(result).toBe(true)
      expect(plm.count).toBe(0)
    })

    it('returns false for unknown tokenId', async () => {
      const result = await plm.forceClosePosition('nonexistent')
      expect(result).toBe(false)
    })
  })

  describe('forceCloseAll', () => {
    it('closes all tracked positions', async () => {
      mockPlaceSell.mockResolvedValue({ success: true, orderId: 'sell' })
      mockGetPrice.mockReturnValue({ mid: 0.55, timestamp: new Date() })

      plm.trackPosition(makePosition({ tokenId: 'a' }))
      plm.trackPosition(makePosition({ tokenId: 'b' }))
      plm.trackPosition(makePosition({ tokenId: 'c' }))
      expect(plm.count).toBe(3)

      const result = await plm.forceCloseAll()
      expect(result.closed).toBe(3)
      expect(result.failed).toBe(0)
      expect(plm.count).toBe(0)
    })

    it('reports failed closes', async () => {
      mockPlaceSell
        .mockResolvedValueOnce({ success: true, orderId: 'ok' })
        .mockResolvedValueOnce({ success: false, error: 'failed' })
      mockGetPrice.mockReturnValue({ mid: 0.55, timestamp: new Date() })

      plm.trackPosition(makePosition({ tokenId: 'a' }))
      plm.trackPosition(makePosition({ tokenId: 'b' }))

      const result = await plm.forceCloseAll()
      expect(result.closed).toBe(1)
      expect(result.failed).toBe(1)
    })
  })

  describe('onChange callback', () => {
    it('fires when position is added', () => {
      const callback = vi.fn()
      plm.onChange(callback)

      plm.trackPosition(makePosition())
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith([expect.objectContaining({ tokenId: 'token-abc-123' })])
    })

    it('fires when position is removed', () => {
      const callback = vi.fn()
      mockPlaceSell.mockResolvedValue({ success: true })

      plm.trackPosition(makePosition())
      plm.onChange(callback)

      plm.removePosition('token-abc-123')
      expect(callback).toHaveBeenCalledWith([])
    })

    it('unsubscribe stops callbacks', () => {
      const callback = vi.fn()
      const unsub = plm.onChange(callback)
      unsub()

      plm.trackPosition(makePosition())
      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('RiskManager PnL reporting', () => {
    it('reports negative PnL to RiskManager on stop-loss sell', async () => {
      mockPlaceSell.mockResolvedValue({ success: true, orderId: 'sl-sell' })
      mockGetPrice.mockReturnValue({ mid: 0.40, timestamp: new Date() })

      plm.initialize()
      plm.trackPosition(makePosition({
        entryPrice: 0.50,
        stopLossPercent: 0.15,
        size: 10,
      }))

      // Trigger stop-loss: 0.50 → 0.40 = -20%
      const priceCallback = mockOnPriceUpdate.mock.calls[0][0] as (tokenId: string, data: unknown) => void
      priceCallback('token-abc-123', { mid: 0.40, timestamp: new Date() })

      await vi.waitFor(() => {
        // pnlUsd = (0.40 - 0.50) * 10 = -1.0
        expect(mockRecordTradeResult).toHaveBeenCalledWith(true, expect.closeTo(-1.0))
      })
    })

    it('reports positive PnL to RiskManager on take-profit sell', async () => {
      mockPlaceSell.mockResolvedValue({ success: true, orderId: 'tp-sell' })
      mockGetPrice.mockReturnValue({ mid: 0.70, timestamp: new Date() })

      plm.initialize()
      plm.trackPosition(makePosition({
        entryPrice: 0.50,
        takeProfitPercent: 0.30,
        size: 10,
      }))

      // Trigger take-profit: 0.50 → 0.70 = +40%
      const priceCallback = mockOnPriceUpdate.mock.calls[0][0] as (tokenId: string, data: unknown) => void
      priceCallback('token-abc-123', { mid: 0.70, timestamp: new Date() })

      await vi.waitFor(() => {
        // pnlUsd = (0.70 - 0.50) * 10 = 2.0
        expect(mockRecordTradeResult).toHaveBeenCalledWith(true, expect.closeTo(2.0))
      })
    })

    it('reports failure to RiskManager when all sell retries exhausted', async () => {
      vi.useFakeTimers()

      mockPlaceSell.mockResolvedValue({ success: false, error: 'RPC error' })
      mockGetPrice.mockReturnValue({ mid: 0.40, timestamp: new Date() })

      plm.initialize()
      plm.trackPosition(makePosition({ entryPrice: 0.50, stopLossPercent: 0.15, size: 10 }))

      // Trigger stop-loss
      const priceCallback = mockOnPriceUpdate.mock.calls[0][0] as (tokenId: string, data: unknown) => void
      priceCallback('token-abc-123', { mid: 0.40, timestamp: new Date() })

      // Advance through all 3 retries (attempt 1 + backoff 2s + attempt 2 + backoff 4s + attempt 3)
      await vi.advanceTimersByTimeAsync(100)   // attempt 1 resolves
      await vi.advanceTimersByTimeAsync(2100)  // retry backoff, attempt 2
      await vi.advanceTimersByTimeAsync(4100)  // retry backoff, attempt 3

      expect(mockRecordTradeResult).toHaveBeenCalledWith(false)

      vi.useRealTimers()
    })
  })
})
