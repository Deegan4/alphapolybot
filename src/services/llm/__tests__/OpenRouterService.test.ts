import { describe, it, expect, vi, beforeEach } from 'vitest'

// ==========================================
// MOCKS  (vi.hoisted runs BEFORE module evaluation)
// ==========================================

// Provide a minimal localStorage before OpenRouterService's module-level
// singleton fires its constructor (which calls localStorage.getItem).
// vi.hoisted() is guaranteed to run before any import.
vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorageMock = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size },
    key: (_index: number) => null as string | null,
  }
  // @ts-expect-error — globalThis.localStorage is read-only in types
  globalThis.localStorage = localStorageMock
})

// OpenRouterService class (not the singleton) — we construct our own instances.
// The module-level singleton will call localStorage during import; the mock above covers it.
import { OpenRouterService } from '../OpenRouterService'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ==========================================
// HELPERS
// ==========================================

function makeService(apiKey = 'test-api-key'): OpenRouterService {
  return new OpenRouterService(apiKey)
}

function makeMarket(overrides = {}) {
  return {
    id: 'market-1',
    question: 'Will BTC exceed $100k?',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.65, 0.35],
    clobTokenIds: ['token-yes', 'token-no'],
    conditionId: 'cond-1',
    slug: 'btc-100k',
    volume: 50000,
    liquidity: 10000,
    createdAt: '2024-01-01',
    active: true,
    closed: false,
    ...overrides,
  }
}

function makeSuccessResponse(content: string, cost?: number) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: cost != null ? { total_cost: cost } : undefined,
    }),
  }
}

function validJson(overrides = {}) {
  return JSON.stringify({
    prediction: 'yes',
    confidence: 80,
    reasoning: 'Test reasoning',
    sources: ['Source A'],
    ...overrides,
  })
}

// ==========================================
// TESTS
// ==========================================

describe('OpenRouterService', () => {
  let service: OpenRouterService

  beforeEach(() => {
    vi.clearAllMocks()
    service = makeService()
  })

  describe('API key management', () => {
    it('uses explicit API key from constructor', () => {
      const svc = new OpenRouterService('explicit-key')
      expect(() => svc.setApiKey('new-key')).not.toThrow()
    })

    it('throws if API key is empty on analyzeMarket', async () => {
      const svc = new OpenRouterService('')
      await expect(svc.analyzeMarket(makeMarket())).rejects.toThrow('API key not configured')
    })
  })

  describe('response parsing', () => {
    it('parses valid JSON prediction response', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson({
        prediction: 'yes',
        confidence: 75,
        reasoning: 'BTC has strong momentum',
        sources: ['CoinDesk', 'Bloomberg'],
      })))

      const result = await service.analyzeMarket(makeMarket())
      expect(result.predictedOutcome).toBe('yes')
      expect(result.confidence).toBeCloseTo(0.75)
      expect(result.reasoning).toContain('strong momentum')
      expect(result.sources).toEqual(['CoinDesk', 'Bloomberg'])
    })

    it('parses JSON embedded in markdown code block', async () => {
      const content = '```json\n{"prediction": "no", "confidence": 60, "reasoning": "test", "sources": []}\n```'
      mockFetch.mockResolvedValue(makeSuccessResponse(content))

      const result = await service.analyzeMarket(makeMarket())
      expect(result.predictedOutcome).toBe('no')
      expect(result.confidence).toBeCloseTo(0.60)
    })

    it('falls back to low confidence on non-JSON response', async () => {
      // The fallback parser checks for 'prediction: yes', '"yes"', or 'likely to be yes'
      const content = 'My prediction: yes, this market will resolve positively.'
      mockFetch.mockResolvedValue(makeSuccessResponse(content))

      const result = await service.analyzeMarket(makeMarket())
      expect(result.confidence).toBe(0.3)
      expect(result.predictedOutcome).toBe('yes')
    })

    it('returns "no" when natural language leans negative', async () => {
      const content = 'Based on the data, this outcome is unlikely.'
      mockFetch.mockResolvedValue(makeSuccessResponse(content))

      const result = await service.analyzeMarket(makeMarket())
      expect(result.predictedOutcome).toBe('no')
    })

    it('handles invalid confidence gracefully', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(
        JSON.stringify({ prediction: 'yes', confidence: -10, reasoning: 'bad', sources: [] })
      ))

      const result = await service.analyzeMarket(makeMarket())
      expect(result.confidence).toBe(0.3)
    })

    it('handles missing prediction field', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(
        JSON.stringify({ confidence: 80, reasoning: 'test', sources: [] })
      ))

      const result = await service.analyzeMarket(makeMarket())
      expect(result.confidence).toBe(0.3)
    })
  })

  describe('cost tracking', () => {
    it('tracks cost from API response', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson(), 0.0045))

      await service.analyzeMarket(makeMarket())
      const stats = service.getCostStats()

      expect(stats.dailySpendUSD).toBeCloseTo(0.0045)
      expect(stats.callCountToday).toBe(1)
      expect(stats.totalSpendUSD).toBeCloseTo(0.0045)
    })

    it('accumulates cost across multiple calls', async () => {
      mockFetch
        .mockResolvedValueOnce(makeSuccessResponse(validJson(), 0.003))
        .mockResolvedValueOnce(makeSuccessResponse(validJson(), 0.005))
        .mockResolvedValueOnce(makeSuccessResponse(validJson(), 0.002))

      await service.analyzeMarket(makeMarket())
      await service.analyzeMarket(makeMarket())
      await service.analyzeMarket(makeMarket())

      const stats = service.getCostStats()
      expect(stats.dailySpendUSD).toBeCloseTo(0.01)
      expect(stats.callCountToday).toBe(3)
    })

    it('enforces daily budget limit', async () => {
      service.setDailyBudget(0.005)
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson(), 0.005))

      await service.analyzeMarket(makeMarket())
      await expect(service.analyzeMarket(makeMarket())).rejects.toThrow('budget exhausted')
    })

    it('reports budget exhausted in stats', async () => {
      service.setDailyBudget(0.001)
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson(), 0.002))
      await service.analyzeMarket(makeMarket())

      const stats = service.getCostStats()
      expect(stats.budgetExhausted).toBe(true)
      expect(stats.dailyRemaining).toBe(0)
    })

    it('setDailyBudget clamps to zero minimum', () => {
      service.setDailyBudget(-5)
      expect(service.getDailyBudget()).toBe(0)
    })
  })

  describe('prompt building', () => {
    it('includes market question in API call', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson()))

      await service.analyzeMarket(makeMarket({ question: 'Will ETH reach $5k?' }))

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.messages[1].content).toContain('Will ETH reach $5k?')
    })

    it('includes market odds in API call', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson()))

      await service.analyzeMarket(makeMarket({ outcomePrices: [0.72, 0.28] }))

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.messages[1].content).toContain('72.0%')
    })

    it('sends correct Authorization header', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson()))

      await service.analyzeMarket(makeMarket())

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers['Authorization']).toBe('Bearer test-api-key')
    })
  })

  describe('analysis history', () => {
    it('stores analyses in history', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson()))

      await service.analyzeMarket(makeMarket({ id: 'a' }))
      await service.analyzeMarket(makeMarket({ id: 'b' }))

      expect(service.getAnalysisHistory()).toHaveLength(2)
    })

    it('tracks prediction accuracy', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson({ prediction: 'yes' })))

      await service.analyzeMarket(makeMarket({ id: 'mkt-1' }))
      service.setActualOutcome('mkt-1', 'yes')

      const accuracy = service.getPredictionAccuracy()
      expect(accuracy.correct).toBe(1)
      expect(accuracy.total).toBe(1)
    })

    it('reports empty metrics when no history', () => {
      const metrics = service.getPerformanceMetrics()
      expect(metrics.totalAnalyses).toBe(0)
      expect(metrics.accuracyRate).toBeNull()
    })
  })

  describe('error handling', () => {
    it('returns low-confidence fallback on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'))

      const result = await service.analyzeMarket(makeMarket())
      expect(result.confidence).toBe(0.1)
      expect(result.reasoning).toContain('Network error')
    })

    it('returns low-confidence fallback on HTTP 429', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ error: { message: 'Rate limited' } }),
      })

      const result = await service.analyzeMarket(makeMarket())
      expect(result.confidence).toBe(0.1)
      expect(result.reasoning).toContain('Rate limited')
    })
  })
})
