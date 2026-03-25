import { describe, it, expect, vi, beforeEach } from 'vitest'

// ==========================================
// MOCKS  (vi.hoisted runs BEFORE module evaluation)
// ==========================================

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
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
})

// Mock LLMInteractionStore to avoid IndexedDB in tests
vi.mock('../LLMInteractionStore', () => ({
  llmInteractionStore: {
    record: vi.fn().mockReturnValue('mock-id'),
    flush: vi.fn().mockResolvedValue(undefined),
    loadAll: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  },
}))

import { OllamaService } from '../OllamaService'
import { llmInteractionStore } from '../LLMInteractionStore'
import type { Market } from '@/types'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ==========================================
// HELPERS
// ==========================================

function makeService(): OllamaService {
  return new OllamaService()
}

function makeMarket(overrides: Partial<Market> = {}): Market {
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
    endDate: '2025-12-31',
    createdAt: '2024-01-01',
    active: true,
    closed: false,
    ...overrides,
  }
}

function makeSuccessResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
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

describe('OllamaService', () => {
  let service: OllamaService

  beforeEach(() => {
    vi.clearAllMocks()
    service = makeService()
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

    it('does not send Authorization header (Ollama is local)', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson()))

      await service.analyzeMarket(makeMarket())

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers['Authorization']).toBeUndefined()
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

  describe('interaction recording', () => {
    it('records every inference in LLMInteractionStore', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse(validJson()))

      await service.analyzeMarket(makeMarket())

      expect(llmInteractionStore.record).toHaveBeenCalledTimes(1)
      const call = vi.mocked(llmInteractionStore.record).mock.calls[0][0]
      expect(call.provider).toBe('ollama')
      expect(call.promptType).toBe('prediction')
      expect(call.costUSD).toBe(0)
      expect(call.marketId).toBe('market-1')
    })
  })

  describe('circuit breaker', () => {
    it('trips after consecutive failures', async () => {
      const errorResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: { message: 'Model not loaded' } }),
      }

      mockFetch.mockResolvedValue(errorResponse)

      // Trip the circuit breaker (3 consecutive failures)
      for (let i = 0; i < 3; i++) {
        await service.analyzeMarket(makeMarket()).catch(() => {})
      }

      expect(service.isCircuitBreakerActive()).toBe(true)
    })

    it('is inactive by default', () => {
      expect(service.isCircuitBreakerActive()).toBe(false)
    })
  })

  describe('error handling', () => {
    it('throws on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'))

      await expect(service.analyzeMarket(makeMarket())).rejects.toThrow('Network error')
    })

    it('throws on HTTP 500', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: { message: 'Model crashed' } }),
      })

      await expect(service.analyzeMarket(makeMarket())).rejects.toThrow('Model crashed')
    })
  })

  describe('signal fusion', () => {
    it('boosts confidence when models agree', () => {
      const primary = { predictedOutcome: 'yes' as const, confidence: 0.7, reasoning: '', sources: [], analysisTime: 0 }
      const secondary = { predictedOutcome: 'yes' as const, confidence: 0.8, reasoning: '', sources: [], analysisTime: 0 }

      const result = OllamaService.fuseSignals(primary, secondary)
      expect(result.fusionApplied).toBe(true)
      expect(result.confidence).toBeGreaterThan(0.7)
    })

    it('penalizes confidence when models disagree', () => {
      const primary = { predictedOutcome: 'yes' as const, confidence: 0.7, reasoning: '', sources: [], analysisTime: 0 }
      const secondary = { predictedOutcome: 'no' as const, confidence: 0.8, reasoning: '', sources: [], analysisTime: 0 }

      const result = OllamaService.fuseSignals(primary, secondary)
      expect(result.fusionApplied).toBe(true)
      expect(result.confidence).toBeLessThan(0.7)
    })

    it('returns primary confidence when no secondary', () => {
      const primary = { predictedOutcome: 'yes' as const, confidence: 0.7, reasoning: '', sources: [], analysisTime: 0 }

      const result = OllamaService.fuseSignals(primary, null)
      expect(result.fusionApplied).toBe(false)
      expect(result.confidence).toBe(0.7)
    })
  })
})
