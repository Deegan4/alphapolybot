import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Shared mock contract that all ethers.Contract instances use
const mockLatestRoundData = vi.fn()
const mockDecimals = vi.fn()

vi.mock('ethers', () => {
  // Must use a class or function (not arrow) so `new` works
  function MockContract() {
    return { latestRoundData: mockLatestRoundData, decimals: mockDecimals }
  }
  function MockJsonRpcProvider() { /* noop */ }

  return {
    ethers: {
      Contract: MockContract,
      JsonRpcProvider: MockJsonRpcProvider,
    },
  }
})

// Import AFTER mocks are set up
import { ChainlinkFeedService } from '../ChainlinkFeedService'
import type { ChainlinkPrice } from '../ChainlinkFeedService'

describe('ChainlinkFeedService', () => {
  let service: ChainlinkFeedService

  beforeEach(() => {
    vi.useFakeTimers()
    mockLatestRoundData.mockReset()
    mockDecimals.mockReset()
    mockDecimals.mockResolvedValue(8)
    service = new ChainlinkFeedService()
  })

  afterEach(() => {
    service.destroy()
    vi.useRealTimers()
  })

  describe('initialization', () => {
    it('should start disconnected', () => {
      expect(service.connected).toBe(false)
    })

    it('should connect on initialize', () => {
      service.initialize()
      expect(service.connected).toBe(true)
    })

    it('should be idempotent', () => {
      service.initialize()
      service.initialize()
      expect(service.connected).toBe(true)
    })
  })

  describe('getPrice', () => {
    it('should parse latestRoundData correctly', async () => {
      mockLatestRoundData.mockResolvedValue([
        BigInt('18446744073709562381'),
        BigInt('9700000000000'),       // 97000 * 10^8
        BigInt('1708900000'),
        BigInt('1708900027'),
        BigInt('18446744073709562381'),
      ])

      service.initialize()
      const result = await service.getPrice('BTC')

      expect(result).not.toBeNull()
      expect(result!.symbol).toBe('BTC')
      expect(result!.priceUSD).toBe(97000)
      expect(result!.source).toBe('chainlink')
      expect(result!.latencyMs).toBeGreaterThanOrEqual(0)
    })

    it('should handle ETH with 8-decimal precision', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(1), BigInt('260000000000'), BigInt(1), BigInt(nowSec), BigInt(1),
      ])

      service.initialize()
      const result = await service.getPrice('ETH')
      expect(result!.priceUSD).toBe(2600)
    })

    it('should return cached price if fresh', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(1), BigInt('9700000000000'), BigInt(1), BigInt(nowSec), BigInt(1),
      ])

      service.initialize()
      await service.getPrice('BTC')
      const callCount = mockLatestRoundData.mock.calls.length

      // Second call within 2s — should hit cache
      const cached = await service.getPrice('BTC')
      expect(cached!.priceUSD).toBe(97000)
      expect(mockLatestRoundData.mock.calls.length).toBe(callCount) // no new RPC calls
    })

    it('should re-fetch after cache expires', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(1), BigInt('9700000000000'), BigInt(1), BigInt(nowSec), BigInt(1),
      ])

      service.initialize()
      await service.getPrice('BTC')
      const callCount = mockLatestRoundData.mock.calls.length

      // Advance past cache TTL (2s + buffer)
      vi.advanceTimersByTime(3000)

      mockLatestRoundData.mockResolvedValue([
        BigInt(2), BigInt('9750000000000'), BigInt(1), BigInt(nowSec + 3), BigInt(2),
      ])
      const fresh = await service.getPrice('BTC')
      expect(fresh!.priceUSD).toBe(97500)
      expect(mockLatestRoundData.mock.calls.length).toBeGreaterThan(callCount)
    })
  })

  describe('getCachedPrice', () => {
    it('should return null when nothing cached', () => {
      expect(service.getCachedPrice('BTC')).toBeNull()
    })

    it('should return null if cache is stale', async () => {
      const staleSec = Math.floor(Date.now() / 1000) - 60
      mockLatestRoundData.mockResolvedValue([
        BigInt(1), BigInt('9700000000000'), BigInt(1), BigInt(staleSec), BigInt(1),
      ])

      service.initialize()
      await service.getPrice('BTC')

      expect(service.getCachedPrice('BTC', 5000)).toBeNull()
    })

    it('should return cached price within maxAge', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(1), BigInt('9700000000000'), BigInt(1), BigInt(nowSec), BigInt(1),
      ])

      service.initialize()
      await service.getPrice('BTC')

      const cached = service.getCachedPrice('BTC', 30_000)
      expect(cached).not.toBeNull()
      expect(cached!.priceUSD).toBe(97000)
    })
  })

  describe('onPriceUpdate', () => {
    it('should invoke callback on new price', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(100), BigInt('9700000000000'), BigInt(1), BigInt(nowSec), BigInt(100),
      ])

      service.initialize()
      const received: ChainlinkPrice[] = []
      service.onPriceUpdate(p => received.push(p))

      await service.getPrice('BTC')
      expect(received.length).toBe(1)
      expect(received[0].symbol).toBe('BTC')
      expect(received[0].priceUSD).toBe(97000)
    })

    it('should NOT emit if price and roundId unchanged', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(100), BigInt('9700000000000'), BigInt(1), BigInt(nowSec), BigInt(100),
      ])

      service.initialize()
      const received: ChainlinkPrice[] = []
      service.onPriceUpdate(p => received.push(p))

      await service.getPrice('BTC')
      vi.advanceTimersByTime(3000)
      await service.getPrice('BTC')

      expect(received.length).toBe(1)
    })

    it('should emit when price changes', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData
        .mockResolvedValueOnce([BigInt(100), BigInt('9700000000000'), BigInt(1), BigInt(nowSec), BigInt(100)])
        .mockResolvedValueOnce([BigInt(101), BigInt('9750000000000'), BigInt(1), BigInt(nowSec + 2), BigInt(101)])

      service.initialize()
      const received: ChainlinkPrice[] = []
      service.onPriceUpdate(p => received.push(p))

      await service.getPrice('BTC')
      vi.advanceTimersByTime(3000)
      await service.getPrice('BTC')

      expect(received.length).toBe(2)
      expect(received[0].priceUSD).toBe(97000)
      expect(received[1].priceUSD).toBe(97500)
    })

    it('should support unsubscribe', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(100), BigInt('9700000000000'), BigInt(1), BigInt(nowSec), BigInt(100),
      ])

      service.initialize()
      const received: ChainlinkPrice[] = []
      const unsub = service.onPriceUpdate(p => received.push(p))

      await service.getPrice('BTC')
      expect(received.length).toBe(1)

      unsub()

      vi.advanceTimersByTime(3000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(101), BigInt('9800000000000'), BigInt(1), BigInt(nowSec + 3), BigInt(101),
      ])
      await service.getPrice('BTC')
      expect(received.length).toBe(1) // not notified after unsub
    })
  })

  describe('polling', () => {
    it('should start and stop polling', () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(1), BigInt('9700000000000'), BigInt(1), BigInt(nowSec), BigInt(1),
      ])

      service.startPolling(2000, ['BTC'])
      expect(service.connected).toBe(true)
      service.stopPolling()
    })

    it('should be idempotent', () => {
      mockLatestRoundData.mockResolvedValue([
        BigInt(1), BigInt('9700000000000'), BigInt(1), BigInt(Math.floor(Date.now() / 1000)), BigInt(1),
      ])

      service.startPolling(2000, ['BTC'])
      service.startPolling(2000, ['BTC'])
      service.stopPolling()
    })
  })

  describe('error handling', () => {
    it('should return null on RPC failure', async () => {
      mockLatestRoundData.mockRejectedValue(new Error('RPC timeout'))

      service.initialize()
      const result = await service.getPrice('BTC')
      expect(result).toBeNull()
    })

    it('should not throw if callback errors', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(1), BigInt('9700000000000'), BigInt(1), BigInt(nowSec), BigInt(1),
      ])

      service.initialize()
      service.onPriceUpdate(() => { throw new Error('callback boom') })

      await expect(service.getPrice('BTC')).resolves.not.toBeNull()
    })

    it('should default to 8 decimals on decimals() failure', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      mockLatestRoundData.mockResolvedValue([
        BigInt(1), BigInt('9700000000000'), BigInt(1), BigInt(nowSec), BigInt(1),
      ])
      mockDecimals.mockRejectedValue(new Error('decimals failed'))

      service.initialize()
      const result = await service.getPrice('BTC')
      expect(result!.priceUSD).toBe(97000)
    })
  })

  describe('destroy', () => {
    it('should clean up everything', () => {
      service.initialize()
      service.startPolling(2000, ['BTC'])
      service.destroy()

      expect(service.connected).toBe(false)
      expect(service.getCachedPrice('BTC')).toBeNull()
    })
  })
})
