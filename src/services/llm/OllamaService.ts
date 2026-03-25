/**
 * Ollama LLM Service
 *
 * Local-only LLM provider using Ollama (localhost:11434).
 * No API keys, no cloud, no cost tracking.
 *
 * Every inference is recorded via LLMInteractionStore for fine-tuning.
 */
import type { Market, PredictionResult, AnalysisRecord, LLMConfig } from '@/types'
import type { MarketDependency, DependencyType } from '@/services/strategies/projectfw/crossmarket/types'
import { formatContextForPrompt, formatCryptoDataForPrompt, type MarketContext } from './MarketContextBuilder'
import { llmInteractionStore, type LLMInteraction } from './LLMInteractionStore'

export class OllamaService {
  private analysisHistory: AnalysisRecord[] = []

  // Circuit breaker — stop spamming when Ollama server is down.
  private consecutiveFailures = 0
  private circuitOpenAt = 0
  private static readonly FAILURE_THRESHOLD = 3
  private static readonly COOLDOWN_MS = 5 * 60 * 1000  // 5 minutes

  private config: LLMConfig = {
    provider: 'ollama',
    model: 'plutus',
    temperature: 0.3,
    maxTokens: 400,
    secondaryModel: '',
  }

  // Resolve base URL + model from settings at call time
  private getSettings(): { baseUrl: string; model: string; secondaryModel: string } {
    try {
      const raw = localStorage.getItem('alphapolybot-settings')
      if (raw) {
        const parsed = JSON.parse(raw)
        const s = parsed?.state
        return {
          baseUrl: s?.ollamaBaseUrl || '/api/ollama/v1',
          model: s?.ollamaModel || 'plutus',
          secondaryModel: s?.ollamaSecondaryModel || '',
        }
      }
    } catch { /* ignore */ }
    return { baseUrl: '/api/ollama/v1', model: 'plutus', secondaryModel: '' }
  }

  /**
   * Update LLM configuration
   */
  setConfig(config: Partial<LLMConfig>): void {
    this.config = { ...this.config, ...config }
  }

  // ==========================================
  // MARKET ANALYSIS
  // ==========================================

  async analyzeMarket(market: Market, context?: MarketContext): Promise<PredictionResult> {
    const startTime = Date.now()

    try {
      const prompt = this.buildAnalysisPrompt(market, context)
      const response = await this.callOllama(prompt, undefined, {
        interactionMeta: {
          promptType: 'prediction' as const,
          marketId: market.id,
          marketQuestion: market.question,
          marketPrice: market.outcomePrices?.[0],
          volume24h: market.volume,
          liquidity: market.liquidity,
        },
      })

      const result = this.parsePrediction(response.message)
      result.analysisTime = Date.now() - startTime

      const record: AnalysisRecord = {
        id: crypto.randomUUID(),
        marketId: market.id,
        marketQuestion: market.question,
        prediction: result,
        timestamp: new Date(),
      }
      this.analysisHistory.push(record)
      if (this.analysisHistory.length > 200) {
        this.analysisHistory = this.analysisHistory.slice(-200)
      }

      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('LLM analysis failed:', msg)
      throw error
    }
  }

  async analyzeCryptoMarket(market: Market, context?: MarketContext, cryptoModel?: string): Promise<PredictionResult> {
    const startTime = Date.now()

    try {
      const prompt = this.buildCryptoPrompt(market, context)
      const response = await this.callOllama(prompt, cryptoModel, {
        interactionMeta: {
          promptType: 'crypto' as const,
          marketId: market.id,
          marketQuestion: market.question,
          marketPrice: market.outcomePrices?.[0],
          volume24h: market.volume,
          liquidity: market.liquidity,
        },
      })

      const result = this.parsePrediction(response.message)
      result.analysisTime = Date.now() - startTime

      const record: AnalysisRecord = {
        id: crypto.randomUUID(),
        marketId: market.id,
        marketQuestion: market.question,
        prediction: result,
        timestamp: new Date(),
      }
      this.analysisHistory.push(record)
      if (this.analysisHistory.length > 200) {
        this.analysisHistory = this.analysisHistory.slice(-200)
      }

      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('Crypto LLM analysis failed:', msg)
      throw error
    }
  }

  // ==========================================
  // SECOND OPINION (signal fusion)
  // ==========================================

  async getSecondOpinion(market: Market, context?: MarketContext): Promise<PredictionResult | null> {
    const { secondaryModel } = this.getSettings()
    if (!secondaryModel) return null  // No secondary model configured

    try {
      const prompt = this.buildAnalysisPrompt(market, context)
      const response = await this.callOllama(prompt, secondaryModel, {
        systemPrompt: 'Market analyst. JSON only.',
        interactionMeta: {
          promptType: 'prediction' as const,
          marketId: market.id,
          marketQuestion: market.question,
          marketPrice: market.outcomePrices?.[0],
        },
      })

      if (!response.message.content) return null
      return this.parsePrediction(response.message)
    } catch {
      return null
    }
  }

  /**
   * Check if the circuit breaker is currently active (Ollama server unreachable).
   */
  isCircuitBreakerActive(): boolean {
    if (this.circuitOpenAt <= 0) return false
    const elapsed = Date.now() - this.circuitOpenAt
    if (elapsed >= OllamaService.COOLDOWN_MS) {
      this.circuitOpenAt = 0
      this.consecutiveFailures = 0
      return false
    }
    return true
  }

  // ==========================================
  // CRYPTO SIGNAL ANALYSIS (Crypto Up/Down)
  // ==========================================

  async analyzeCryptoSignal(prompt: string, model?: string): Promise<{
    confirm: boolean
    adjustment: number
    reasoning: string
  } | null> {
    if (this.isCircuitBreakerActive()) return null

    try {
      const response = await this.callOllama(prompt, model, {
        systemPrompt: 'Crypto signal analyst. Confirm or reject trading signals. JSON only.',
        temperature: 0.2,
        interactionMeta: { promptType: 'signal-confirmation' as const },
      })

      // Strip <think>...</think> blocks from reasoning models
      let content = response.message.content
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        console.warn('[analyzeCryptoSignal] No JSON in response:', content.slice(0, 200))
        return null
      }

      const parsed = JSON.parse(jsonMatch[0])
      return {
        confirm: Boolean(parsed.confirm),
        adjustment: Math.max(-20, Math.min(20, Number(parsed.confidence_adjustment) || 0)),
        reasoning: String(parsed.reasoning || '').slice(0, 200),
      }
    } catch (error) {
      console.warn('[analyzeCryptoSignal] Failed:', error instanceof Error ? error.message : error)
      return null
    }
  }

  async predictCryptoDirection(prompt: string, model?: string): Promise<{
    direction: 'up' | 'down'
    confidence: number
    reasoning: string
  } | null> {
    if (this.isCircuitBreakerActive()) return null

    try {
      const response = await this.callOllama(prompt, model, {
        systemPrompt: 'Crypto direction predictor. Predict whether the price will go up or down. JSON only.',
        temperature: 0.2,
        interactionMeta: { promptType: 'direction' as const },
      })

      let content = response.message.content
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0])
      const dir = String(parsed.direction).toLowerCase()
      if (dir !== 'up' && dir !== 'down') return null

      const conf = Number(parsed.confidence)
      if (isNaN(conf) || conf < 0 || conf > 100) return null

      return {
        direction: dir as 'up' | 'down',
        confidence: Math.max(0, Math.min(1, conf / 100)),
        reasoning: String(parsed.reasoning || '').slice(0, 200),
      }
    } catch (error) {
      console.warn('[predictCryptoDirection] Failed:', error instanceof Error ? error.message : error)
      return null
    }
  }

  /**
   * Fuse primary and secondary predictions into a consensus confidence.
   */
  static fuseSignals(
    primary: PredictionResult,
    secondary: PredictionResult | null,
  ): { confidence: number; fusionApplied: boolean } {
    if (!secondary) {
      return { confidence: primary.confidence, fusionApplied: false }
    }

    const sameOutcome = primary.predictedOutcome === secondary.predictedOutcome

    if (sameOutcome) {
      const fused = Math.sqrt(primary.confidence * secondary.confidence)
      return { confidence: Math.min(0.95, fused * 1.1), fusionApplied: true }
    } else {
      const penalty = secondary.confidence * 0.5
      return { confidence: Math.max(0.05, primary.confidence * (1 - penalty)), fusionApplied: true }
    }
  }

  // ==========================================
  // CROSS-MARKET DEPENDENCY CLASSIFICATION
  // ==========================================

  async classifyDependencies(
    pairs: Array<{ marketA: Market; marketB: Market }>,
  ): Promise<MarketDependency[]> {
    if (pairs.length === 0) return []

    const prompt = this.buildDependencyPrompt(pairs)

    try {
      const response = await this.callOllama(prompt, undefined, {
        interactionMeta: { promptType: 'dependency' as const },
      })
      return this.parseDependencyResponse(response.message.content, pairs)
    } catch (error) {
      console.error('[OllamaService] Dependency classification failed:', error)
      return []
    }
  }

  // ==========================================
  // CORE API CALL
  // ==========================================

  private async callOllama(prompt: string, modelOverride?: string, opts?: {
    systemPrompt?: string
    temperature?: number
    maxTokens?: number
    interactionMeta?: Partial<Pick<LLMInteraction,
      'promptType' | 'marketId' | 'marketQuestion' | 'marketPrice' | 'volume24h' | 'liquidity'
    >>
  }): Promise<{ message: { content: string } }> {
    const startTime = Date.now()
    const { baseUrl, model: settingsModel } = this.getSettings()

    // Circuit breaker check
    if (this.circuitOpenAt > 0) {
      const elapsed = Date.now() - this.circuitOpenAt
      if (elapsed < OllamaService.COOLDOWN_MS) {
        const remainMin = Math.ceil((OllamaService.COOLDOWN_MS - elapsed) / 60_000)
        throw new Error(`Ollama server unreachable — retrying in ${remainMin}m`)
      }
      this.circuitOpenAt = 0
      this.consecutiveFailures = 0
      console.log('[OllamaService] Cooldown expired, retrying')
    }

    const model = modelOverride || settingsModel
    const isReasoningModel = model.includes('deepseek-r1') || model.includes('o1') || model.includes('o3')
    const systemPrompt = opts?.systemPrompt ?? 'Market analyst. JSON only.'

    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: opts?.temperature ?? this.config.temperature,
      max_tokens: isReasoningModel ? 4000 : (opts?.maxTokens ?? this.config.maxTokens),
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))

      // Trip circuit breaker after consecutive failures
      this.consecutiveFailures++
      if (this.consecutiveFailures >= OllamaService.FAILURE_THRESHOLD) {
        this.circuitOpenAt = Date.now()
        const cooldownMin = OllamaService.COOLDOWN_MS / 60_000
        console.error(`[OllamaService] Ollama failed ${this.consecutiveFailures}× — circuit breaker tripped for ${cooldownMin}m`)
      }

      throw new Error(`Ollama API error: ${response.status} - ${errorData.error?.message || response.statusText}`)
    }

    const data = await response.json()

    // Reset circuit breaker on success
    if (this.consecutiveFailures > 0) {
      this.consecutiveFailures = 0
    }

    if (!data.choices?.[0]?.message) {
      throw new Error('Invalid response from Ollama')
    }

    const responseContent = data.choices[0].message.content
    const responseTimeMs = Date.now() - startTime

    // Record interaction for training data pipeline
    const meta = opts?.interactionMeta
    llmInteractionStore.record({
      provider: 'ollama',
      model,
      promptType: meta?.promptType || 'prediction',
      systemPrompt,
      userPrompt: prompt,
      temperature: opts?.temperature ?? this.config.temperature,
      rawResponse: responseContent,
      parsedPrediction: undefined,  // Populated by caller after parsing
      parsedConfidence: undefined,
      parsedReasoning: undefined,
      responseTimeMs,
      costUSD: 0,
      marketId: meta?.marketId,
      marketQuestion: meta?.marketQuestion,
      marketPrice: meta?.marketPrice,
      volume24h: meta?.volume24h,
      liquidity: meta?.liquidity,
    })

    return { message: data.choices[0].message }
  }

  // ==========================================
  // PROMPT BUILDERS
  // ==========================================

  private buildAnalysisPrompt(market: Market, context?: MarketContext): string {
    const odds = market.outcomePrices || [0.5, 0.5]
    const desc = market.description
      ? `\nContext: ${market.description.substring(0, 150)}`
      : ''

    let signalsSection = ''
    if (context) {
      signalsSection = formatContextForPrompt(context)
    }

    return `Predict this market outcome. Respond ONLY with JSON.

Q: "${market.question}"
- ${market.outcomes?.[0] || 'Yes'}: ${(odds[0] * 100).toFixed(1)}%
- ${market.outcomes?.[1] || 'No'}: ${(odds[1] * 100).toFixed(1)}%
- Vol: $${market.volume?.toLocaleString() || '?'}, Liq: $${market.liquidity?.toLocaleString() || '?'}${desc}${signalsSection}

{"prediction":"yes|no","confidence":0-100,"reasoning":"1 sentence"}`
  }

  private buildCryptoPrompt(market: Market, context?: MarketContext): string {
    const odds = market.outcomePrices || [0.5, 0.5]
    const today = new Date().toISOString().slice(0, 10)

    const cryptoDataSection = formatCryptoDataForPrompt(market)
    let signalsSection = ''
    if (context) {
      signalsSection = formatContextForPrompt(context)
    }

    return `You are a crypto prediction market analyst. Today is ${today}.

MARKET: "${market.question}" (Polymarket crypto category)
- ${market.outcomes?.[0] || 'Yes'}: ${(odds[0] * 100).toFixed(1)}% | ${market.outcomes?.[1] || 'No'}: ${(odds[1] * 100).toFixed(1)}%
- Vol: $${market.volume?.toLocaleString() || '?'}, Liq: $${market.liquidity?.toLocaleString() || '?'}${cryptoDataSection}${signalsSection}

Analyze whether current crypto conditions favor YES or NO.
Consider: price momentum, volatility regime, volume trends, and whether the market odds reflect current conditions.
If volatility is high, give lower confidence. If momentum strongly aligns with one outcome, increase confidence.

Respond ONLY with JSON:
{"prediction":"yes|no","confidence":0-100,"reasoning":"2-3 sentences analyzing crypto data"}`
  }

  private buildDependencyPrompt(
    pairs: Array<{ marketA: Market; marketB: Market }>,
  ): string {
    const pairList = pairs
      .map((p, i) => `${i + 1}. A:"${p.marketA.question}" B:"${p.marketB.question}"`)
      .join('\n')

    return `Classify market pair relationships. JSON array only.

Types: mutex (at most one YES), conditional (A→B), complementary (exactly one YES), independent

${pairList}

[{"pair":1,"type":"mutex|conditional|complementary|independent","confidence":0-100,"reasoning":"<10 words"}]`
  }

  // ==========================================
  // RESPONSE PARSERS
  // ==========================================

  private parsePrediction(response: { content: string }): PredictionResult {
    const content = response.content || ''

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON found in response')

      const parsed = JSON.parse(jsonMatch[0])

      const prediction = String(parsed.prediction).toLowerCase()
      if (prediction !== 'yes' && prediction !== 'no') {
        throw new Error(`Invalid prediction: ${prediction}`)
      }

      const confidence = Number(parsed.confidence)
      if (isNaN(confidence) || confidence < 0 || confidence > 100) {
        throw new Error(`Invalid confidence: ${parsed.confidence}`)
      }

      const jsonSources: string[] = Array.isArray(parsed.sources) ? parsed.sources.map(String) : []

      return {
        predictedOutcome: prediction as 'yes' | 'no',
        confidence: confidence / 100,
        reasoning: String(parsed.reasoning || 'No reasoning provided'),
        sources: jsonSources,
        analysisTime: 0,
      }
    } catch (parseError) {
      console.error('Failed to parse LLM response:', parseError)
      console.error('Raw response:', content)

      const lowerContent = content.toLowerCase()
      const predictedOutcome = lowerContent.includes('prediction: yes') ||
                              lowerContent.includes('"yes"') ||
                              lowerContent.includes('likely to be yes')
        ? 'yes' : 'no'

      return {
        predictedOutcome,
        confidence: 0.3,
        reasoning: content.substring(0, 500) || 'Failed to parse structured response',
        sources: [],
        analysisTime: 0,
      }
    }
  }

  private parseDependencyResponse(
    content: string,
    pairs: Array<{ marketA: Market; marketB: Market }>,
  ): MarketDependency[] {
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.error('[OllamaService] No JSON array found in dependency response')
        return []
      }

      const parsed: Array<{
        pair: number
        type: string
        confidence: number
        reasoning: string
      }> = JSON.parse(jsonMatch[0])

      const validTypes: DependencyType[] = ['independent', 'mutex', 'conditional', 'complementary']
      const now = Date.now()

      return parsed
        .filter(item => {
          const idx = item.pair - 1
          return idx >= 0 && idx < pairs.length && validTypes.includes(item.type as DependencyType)
        })
        .map(item => {
          const idx = item.pair - 1
          return {
            marketIdA: pairs[idx].marketA.id,
            marketIdB: pairs[idx].marketB.id,
            type: item.type as DependencyType,
            confidence: Math.max(0, Math.min(1, item.confidence / 100)),
            reasoning: item.reasoning || '',
            classifiedAt: now,
          }
        })
    } catch (error) {
      console.error('[OllamaService] Failed to parse dependency response:', error)
      return []
    }
  }

  // ==========================================
  // ANALYSIS HISTORY
  // ==========================================

  getAnalysisHistory(): AnalysisRecord[] {
    return [...this.analysisHistory].sort((a, b) =>
      b.timestamp.getTime() - a.timestamp.getTime()
    )
  }

  getPredictionAccuracy(): {
    correct: number
    total: number
    accuracy: number
  } {
    const resolved = this.analysisHistory.filter(h => h.actualOutcome)
    const correct = resolved.filter(h =>
      h.prediction.predictedOutcome === h.actualOutcome
    ).length

    return {
      correct,
      total: resolved.length,
      accuracy: resolved.length > 0 ? correct / resolved.length : 0,
    }
  }

  setActualOutcome(marketId: string, outcome: 'yes' | 'no'): void {
    const record = this.analysisHistory.find(h => h.marketId === marketId)
    if (record) {
      record.actualOutcome = outcome
    }
  }

  getPerformanceMetrics(): {
    totalAnalyses: number
    averageConfidence: number
    averageResponseTime: number
    accuracyRate: number | null
  } {
    const history = this.analysisHistory

    if (history.length === 0) {
      return {
        totalAnalyses: 0,
        averageConfidence: 0,
        averageResponseTime: 0,
        accuracyRate: null,
      }
    }

    const totalConfidence = history.reduce((sum, h) => sum + h.prediction.confidence, 0)
    const totalTime = history.reduce((sum, h) => sum + h.prediction.analysisTime, 0)
    const accuracy = this.getPredictionAccuracy()

    return {
      totalAnalyses: history.length,
      averageConfidence: totalConfidence / history.length,
      averageResponseTime: totalTime / history.length,
      accuracyRate: accuracy.total > 0 ? accuracy.accuracy : null,
    }
  }
}

// Singleton
export const ollamaService = new OllamaService()
