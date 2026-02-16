import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'
import type {
  PolyBacktestMarketsResponse,
  PolyBacktestSnapshotsResponse,
  PolyBacktestHealthResponse,
  PolyBacktestMarket,
  PolyBacktestSnapshot,
} from '@/types'

// Mock axios before importing PolyBacktestClient
vi.mock('axios', () => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    defaults: { headers: { common: {} } },
    interceptors: {
      response: { use: vi.fn() },
      request: { use: vi.fn() },
    },
  }
  return {
    default: {
      create: vi.fn(() => mockAxiosInstance),
    },
  }
})

// ==========================================
// FIXTURES
// ==========================================

const mockMarket: PolyBacktestMarket = {
  market_id: 'mkt-001',
  slug: 'btc-updown-15m-1707926400',
  market_type: '15m',
  start_time: '2024-02-14T20:00:00Z',
  end_time: '2024-02-14T20:15:00Z',
  btc_price_start: 52000,
  btc_price_end: 52100,
  winner: 'up',
  condition_id: '0xabc',
  clob_token_up: 'tok-up',
  clob_token_down: 'tok-down',
  final_volume: 5000,
  final_liquidity: 2000,
}

const mockSnapshot: PolyBacktestSnapshot = {
  id: 'snap-001',
  time: '2024-02-14T20:05:00Z',
  btc_price: 52050,
  price_up: 0.55,
  price_down: 0.45,
  orderbook_up: null,
  orderbook_down: null,
}

const mockMarketsResponse: PolyBacktestMarketsResponse = {
  markets: [mockMarket],
  total: 1,
  limit: 50,
  offset: 0,
}

const mockSnapshotsResponse: PolyBacktestSnapshotsResponse = {
  market: mockMarket,
  snapshots: [mockSnapshot],
  total: 1,
  limit: 1000,
  offset: 0,
}

const mockHealthResponse: PolyBacktestHealthResponse = {
  status: 'ok',
}

// ==========================================
// TEST SUITE
// ==========================================

describe('PolyBacktestClient', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockAxiosInstance: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any

  beforeEach(async () => {
    vi.clearAllMocks()

    // Get the mock axios instance
    mockAxiosInstance = (axios.create as ReturnType<typeof vi.fn>).mock.results[0]?.value
    if (!mockAxiosInstance) {
      // Force creation
      const { PolyBacktestClient } = await import('../PolyBacktestClient')
      client = new PolyBacktestClient()
      mockAxiosInstance = (axios.create as ReturnType<typeof vi.fn>).mock.results[0]?.value
    } else {
      const { PolyBacktestClient } = await import('../PolyBacktestClient')
      client = new PolyBacktestClient()
      mockAxiosInstance = (axios.create as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
    }

    mockAxiosInstance.get.mockReset()
    mockAxiosInstance.defaults = { headers: { common: {} } }
  })

  // ==========================================
  // CONSTRUCTION
  // ==========================================

  it('creates axios instance with correct base URL', () => {
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: '/api/polybacktest',
      }),
    )
  })

  // ==========================================
  // API KEY MANAGEMENT
  // ==========================================

  it('setApiKey sets X-API-Key header', () => {
    client.setApiKey('my-test-key')
    expect(mockAxiosInstance.defaults.headers.common['X-API-Key']).toBe('my-test-key')
  })

  it('setApiKey with empty string removes header', () => {
    mockAxiosInstance.defaults.headers.common['X-API-Key'] = 'old-key'
    client.setApiKey('')
    expect(mockAxiosInstance.defaults.headers.common['X-API-Key']).toBeUndefined()
  })

  it('hasApiKey returns true when key is set', () => {
    mockAxiosInstance.defaults.headers.common['X-API-Key'] = 'key123'
    expect(client.hasApiKey()).toBe(true)
  })

  it('hasApiKey returns false when no key', () => {
    delete mockAxiosInstance.defaults.headers.common['X-API-Key']
    expect(client.hasApiKey()).toBe(false)
  })

  // ==========================================
  // HEALTH
  // ==========================================

  it('health() calls GET /health', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: mockHealthResponse })
    const result = await client.health()
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/health', undefined)
    expect(result).toEqual(mockHealthResponse)
  })

  // ==========================================
  // MARKETS
  // ==========================================

  it('getMarkets() calls GET /v1/markets with params', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: mockMarketsResponse })
    const result = await client.getMarkets({ market_type: '15m', limit: 10 })
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/markets', {
      params: { market_type: '15m', limit: 10 },
    })
    expect(result).toEqual(mockMarketsResponse)
  })

  it('getMarket() calls GET /v1/markets/:id', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: mockMarket })
    const result = await client.getMarket('mkt-001')
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/markets/mkt-001', undefined)
    expect(result).toEqual(mockMarket)
  })

  it('getMarketBySlug() URL-encodes the slug', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: mockMarket })
    await client.getMarketBySlug('btc-updown-15m-1707926400')
    expect(mockAxiosInstance.get).toHaveBeenCalledWith(
      '/v1/markets/by-slug/btc-updown-15m-1707926400',
      undefined,
    )
  })

  // ==========================================
  // SNAPSHOTS
  // ==========================================

  it('getSnapshots() calls GET /v1/markets/:id/snapshots', async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: mockSnapshotsResponse })
    const result = await client.getSnapshots('mkt-001', { limit: 100, include_orderbook: true })
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/markets/mkt-001/snapshots', {
      params: { limit: 100, include_orderbook: true },
    })
    expect(result.snapshots).toHaveLength(1)
  })

  it('getSnapshotAt() calls correct endpoint', async () => {
    const snapshotResp = { market: mockMarket, snapshots: [mockSnapshot] }
    mockAxiosInstance.get.mockResolvedValueOnce({ data: snapshotResp })
    const result = await client.getSnapshotAt('mkt-001', '2024-02-14T20:05:00Z')
    expect(mockAxiosInstance.get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/markets/mkt-001/snapshot-at/'),
      undefined,
    )
    expect(result).toEqual(mockSnapshot)
  })

  it('getSnapshotAt() returns null on 404', async () => {
    const err = new Error('Not found')
    ;(err as Error & { status: number }).status = 404
    mockAxiosInstance.get.mockRejectedValueOnce(err)
    const result = await client.getSnapshotAt('mkt-001', '9999-01-01T00:00:00Z')
    expect(result).toBeNull()
  })

  // ==========================================
  // AUTO-PAGINATION
  // ==========================================

  it('getAllSnapshots() auto-paginates', async () => {
    // Page 1: 2 of 3 total
    const page1: PolyBacktestSnapshotsResponse = {
      market: mockMarket,
      snapshots: [
        { ...mockSnapshot, id: 'snap-001' },
        { ...mockSnapshot, id: 'snap-002' },
      ],
      total: 3,
      limit: 1000,
      offset: 0,
    }
    // Page 2: 1 remaining
    const page2: PolyBacktestSnapshotsResponse = {
      market: mockMarket,
      snapshots: [{ ...mockSnapshot, id: 'snap-003' }],
      total: 3,
      limit: 1000,
      offset: 2,
    }

    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 })

    const result = await client.getAllSnapshots('mkt-001', false)
    expect(result).toHaveLength(3)
    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2)
  })

  it('getAllSnapshots() calls onProgress', async () => {
    const page: PolyBacktestSnapshotsResponse = {
      market: mockMarket,
      snapshots: [mockSnapshot],
      total: 1,
      limit: 1000,
      offset: 0,
    }
    mockAxiosInstance.get.mockResolvedValueOnce({ data: page })

    const onProgress = vi.fn()
    await client.getAllSnapshots('mkt-001', false, onProgress)
    expect(onProgress).toHaveBeenCalledWith(1, 1)
  })

  it('getResolvedMarkets() auto-paginates', async () => {
    const page1: PolyBacktestMarketsResponse = {
      markets: [mockMarket],
      total: 2,
      limit: 100,
      offset: 0,
    }
    const page2: PolyBacktestMarketsResponse = {
      markets: [{ ...mockMarket, market_id: 'mkt-002' }],
      total: 2,
      limit: 100,
      offset: 1,
    }
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 })

    const result = await client.getResolvedMarkets('15m')
    expect(result).toHaveLength(2)
    // First call should have resolved=true filter
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/v1/markets', {
      params: expect.objectContaining({ resolved: true, market_type: '15m' }),
    })
  })
})
