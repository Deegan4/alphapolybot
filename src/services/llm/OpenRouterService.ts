import type { Market, PredictionResult, AnalysisRecord, LLMConfig } from '@/types'
import type { MarketDependency, DependencyType } from '@/services/strategies/projectfw/crossmarket/types'
import { formatContextForPrompt, formatCryptoDataForPrompt, type MarketContext } from './MarketContextBuilder'

/**
 * OpenRouter LLM Service
 * Provides AI-powered market analysis with web search capabilities
 * 
 * API Key Resolution Order:
 * 1. Constructor parameter (explicit)
 * 2. Settings store (user-configured via UI)
 * 3. localStorage (legacy/backup)
 * 4. Environment variable (VITE_OPENROUTER_API_KEY)
 */
export class OpenRouterService {
  private apiKey: string
  private baseUrl = import.meta.env.VITE_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
  private analysisHistory: AnalysisRecord[] = []

  // Cost tracking — partitioned daily budget enforcement
  private budgets: Record<string, { limit: number; spent: number; calls: number; lastReset: string }> = {
    prediction:  { limit: 1.00, spent: 0, calls: 0, lastReset: '' },
    crossMarket: { limit: 0.50, spent: 0, calls: 0, lastReset: '' },
    premium:     { limit: 0.50, spent: 0, calls: 0, lastReset: '' },
  }
  private totalSpendUSD = 0               // Lifetime spend across all buckets (session only)

  private config: LLMConfig = {
    provider: 'openrouter',
    model: 'meta-llama/llama-3.1-70b-instruct',
    temperature: 0.3,
    maxTokens: 400,
    webSearchEnabled: false,
  }

  constructor(apiKey?: string) {
    this.apiKey = this.resolveApiKey(apiKey)
  }

  /**
   * Resolve API key from multiple sources
   */
  private resolveApiKey(explicitKey?: string): string {
    // 1. Explicit parameter takes priority
    if (explicitKey) return explicitKey
    
    // 2. Check settings store (persisted user config)
    try {
      const settingsData = localStorage.getItem('alphapolybot-settings')
      if (settingsData) {
        const parsed = JSON.parse(settingsData)
        if (parsed?.state?.openRouterApiKey) {
          return parsed.state.openRouterApiKey
        }
      }
    } catch (e) {
      console.warn('[OpenRouterService] Failed to read settings store:', e)
    }
    
    // 3. Legacy localStorage key
    const legacyKey = localStorage.getItem('OPENROUTER_API_KEY')
    if (legacyKey) return legacyKey
    
    // 4. Environment variable
    return import.meta.env.VITE_OPENROUTER_API_KEY || ''
  }

  /**
   * Refresh API key from all sources (call after settings change)
   */
  refreshApiKey(): void {
    this.apiKey = this.resolveApiKey()
    console.log('[OpenRouterService] API key refreshed:', this.apiKey ? 'configured' : 'not set')
  }

  /**
   * Set API key
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey
  }

  /**
   * Update LLM configuration
   */
  setConfig(config: Partial<LLMConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * Analyze a market and predict the outcome
   */
  async analyzeMarket(market: Market, context?: MarketContext): Promise<PredictionResult> {
    const startTime = Date.now()

    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured')
    }

    // Daily budget enforcement (prediction bucket)
    this.maybeResetBucket('prediction')
    const predBudget = this.budgets.prediction
    if (predBudget.spent >= predBudget.limit) {
      throw new Error(
        `Daily LLM budget exhausted: $${predBudget.spent.toFixed(2)} / $${predBudget.limit.toFixed(2)} ` +
        `(${predBudget.calls} calls today). Resets at midnight.`
      )
    }

    try {
      const prompt = this.buildAnalysisPrompt(market, context)

      // Premium model tiering: use expensive model for high-quality markets
      let modelOverride: string | undefined
      let budgetBucket = 'prediction'
      const premiumModel = this.config.premiumModel
      const premiumThreshold = this.config.premiumModelThreshold ?? 25
      if (premiumModel && context?.qualityScore != null && context.qualityScore >= premiumThreshold) {
        this.maybeResetBucket('premium')
        const premBudget = this.budgets.premium
        if (premBudget.spent < premBudget.limit) {
          modelOverride = premiumModel
          budgetBucket = 'premium'
        }
      }

      const response = await this.callOpenRouter(prompt, modelOverride)

      // Track cost from API response
      this.recordCost(response.cost, budgetBucket)

      const result = this.parsePrediction(response.message)
      
      result.analysisTime = Date.now() - startTime

      // Store analysis for tracking
      const record: AnalysisRecord = {
        id: crypto.randomUUID(),
        marketId: market.id,
        marketQuestion: market.question,
        prediction: result,
        timestamp: new Date(),
      }
      this.analysisHistory.push(record)

      // Keep history limited to last 200 records
      if (this.analysisHistory.length > 200) {
        this.analysisHistory = this.analysisHistory.slice(-200)
      }

      return result
    } catch (error) {
      console.error('LLM analysis failed:', error)
      
      // Return low-confidence fallback
      return {
        predictedOutcome: 'yes',
        confidence: 0.1,
        reasoning: `Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        sources: [],
        analysisTime: Date.now() - startTime,
      }
    }
  }

  /**
   * Analyze a crypto prediction market using real-time BinanceWS data.
   * Uses crypto-specific prompt template with live price/volume data.
   */
  async analyzeCryptoMarket(market: Market, context?: MarketContext, cryptoModel?: string): Promise<PredictionResult> {
    const startTime = Date.now()

    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured')
    }

    this.maybeResetBucket('prediction')
    const predBudget = this.budgets.prediction
    if (predBudget.spent >= predBudget.limit) {
      throw new Error(`Daily LLM budget exhausted: $${predBudget.spent.toFixed(2)} / $${predBudget.limit.toFixed(2)}`)
    }

    try {
      const prompt = this.buildCryptoPrompt(market, context)
      const modelOverride = cryptoModel || undefined
      const response = await this.callOpenRouter(prompt, modelOverride)
      this.recordCost(response.cost, 'prediction')
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
      console.error('Crypto LLM analysis failed:', error)
      return {
        predictedOutcome: 'yes',
        confidence: 0.1,
        reasoning: `Crypto analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        sources: [],
        analysisTime: Date.now() - startTime,
      }
    }
  }

  /**
   * Get a second opinion from a different model for signal fusion.
   * Used selectively on borderline or high-stakes trades.
   * Returns null if budget exhausted or API fails (non-blocking).
   */
  async getSecondOpinion(market: Market, context?: MarketContext): Promise<PredictionResult | null> {
    // Budget check (uses prediction bucket)
    this.maybeResetBucket('prediction')
    const predBudget = this.budgets.prediction
    if (predBudget.spent >= predBudget.limit * 0.8) {
      // Within 80% of budget — skip second opinion to conserve
      return null
    }

    // Use a different model for diversity
    const baseSecondaryModel = this.config.model.includes('llama')
      ? 'google/gemma-2-9b-it'       // If primary is Llama, use Gemma
      : 'meta-llama/llama-3.1-70b-instruct' // Otherwise use Llama
    const secondaryModel = this.config.webSearchEnabled
      ? `${baseSecondaryModel}:online`
      : baseSecondaryModel

    try {
      const prompt = this.buildAnalysisPrompt(market, context)
      const body: Record<string, unknown> = {
        model: secondaryModel,
        messages: [
          { role: 'system', content: this.config.webSearchEnabled
            ? 'Market analyst with web research. Use search results to make informed predictions. JSON only.'
            : 'Market analyst. JSON only.' },
          { role: 'user', content: prompt },
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.webSearchEnabled ? 600 : this.config.maxTokens,
      }
      if (this.config.webSearchEnabled) {
        body.plugins = [{ id: 'web', max_results: 3 }]
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': window.location.origin,
          'X-Title': 'AlphaPolyBot - Signal Fusion',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) return null

      const data = await response.json()
      if (!data.choices?.[0]?.message) return null

      // Record cost
      let cost = 0
      if (data.usage?.total_cost != null) {
        cost = data.usage.total_cost
      } else if (data.usage) {
        cost = (data.usage.prompt_tokens ?? 0) / 1000 * 0.00059 +
               (data.usage.completion_tokens ?? 0) / 1000 * 0.00079
        if (this.config.webSearchEnabled) {
          cost += 0.012 // Exa search cost
        }
      }
      this.recordCost(cost, 'prediction')

      return this.parsePrediction(data.choices[0].message)
    } catch {
      return null
    }
  }

  /**
   * Analyze a crypto signal for the BTC Up/Down strategy.
   * Takes a pre-built prompt (strategy builds it with signal context).
   * Returns confirmation/adjustment or null on any failure (fail-open).
   * Uses prediction budget bucket (~$0.002/call at Llama 3.1 70B rates).
   */
  async analyzeCryptoSignal(prompt: string): Promise<{
    confirm: boolean
    adjustment: number  // -20 to +20 confidence adjustment
    reasoning: string
  } | null> {
    if (!this.apiKey) return null

    // Budget check (prediction bucket)
    this.maybeResetBucket('prediction')
    const predBudget = this.budgets.prediction
    if (predBudget.spent >= predBudget.limit) return null

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': window.location.origin,
          'X-Title': 'AlphaPolyBot - Crypto Signal Confirmation',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: 'Crypto signal analyst. Confirm or reject trading signals. JSON only.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 200,
        }),
      })

      if (!response.ok) return null

      const data = await response.json()
      if (!data.choices?.[0]?.message?.content) return null

      // Record cost
      let cost = 0
      if (data.usage?.total_cost != null) {
        cost = data.usage.total_cost
      } else if (data.usage) {
        cost = (data.usage.prompt_tokens ?? 0) / 1000 * 0.00059 +
               (data.usage.completion_tokens ?? 0) / 1000 * 0.00079
      }
      this.recordCost(cost, 'prediction')

      // Parse response — expect {"confirm": true/false, "confidence_adjustment": -20 to +20, "reasoning": "..."}
      const content = data.choices[0].message.content
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0])
      return {
        confirm: Boolean(parsed.confirm),
        adjustment: Math.max(-20, Math.min(20, Number(parsed.confidence_adjustment) || 0)),
        reasoning: String(parsed.reasoning || '').slice(0, 200),
      }
    } catch {
      return null // Fail-open: any error means proceed with mechanical signal
    }
  }

  /**
   * Fuse primary and secondary predictions into a consensus confidence.
   * Agreement boosts confidence, disagreement reduces it.
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
      // Agreement: geometric mean of confidences (boost if both confident)
      const fused = Math.sqrt(primary.confidence * secondary.confidence)
      // Slight upward adjustment for agreement
      return { confidence: Math.min(0.95, fused * 1.1), fusionApplied: true }
    } else {
      // Disagreement: penalize primary confidence proportional to secondary's strength
      const penalty = secondary.confidence * 0.5 // up to 50% reduction
      return { confidence: Math.max(0.05, primary.confidence * (1 - penalty)), fusionApplied: true }
    }
  }

  /**
   * Build the analysis prompt
   */
  private buildAnalysisPrompt(market: Market, context?: MarketContext): string {
    const odds = market.outcomePrices || [0.5, 0.5]
    const desc = market.description
      ? `\nContext: ${market.description.substring(0, 150)}`
      : ''

    // Build market signals section from context (if available)
    let signalsSection = ''
    if (context) {
      signalsSection = formatContextForPrompt(context)
    }

    // When web search is enabled, use an expanded prompt that instructs the LLM
    // to research the topic using injected search results before predicting.
    if (this.config.webSearchEnabled) {
      const today = new Date().toISOString().slice(0, 10)
      return `You are a prediction market analyst. Today is ${today}. Research this question using web search results, then predict the outcome.

MARKET: "${market.question}"
- ${market.outcomes?.[0] || 'Yes'}: ${(odds[0] * 100).toFixed(1)}% current odds
- ${market.outcomes?.[1] || 'No'}: ${(odds[1] * 100).toFixed(1)}% current odds
- Volume: $${market.volume?.toLocaleString() || '?'}, Liquidity: $${market.liquidity?.toLocaleString() || '?'}${desc}${signalsSection}

Instructions:
1. Search for the latest news, polls, expert analysis, or data relevant to this question
2. Assess whether the current market odds are accurate or mispriced
3. If you find strong evidence for one side, predict that side with high confidence
4. If evidence is mixed or insufficient, respond with low confidence

Respond ONLY with JSON:
{"prediction":"yes|no","confidence":0-100,"reasoning":"2-3 sentences citing evidence found","sources":["url1","url2"]}`
    }

    return `Predict this market outcome. Respond ONLY with JSON.

Q: "${market.question}"
- ${market.outcomes?.[0] || 'Yes'}: ${(odds[0] * 100).toFixed(1)}%
- ${market.outcomes?.[1] || 'No'}: ${(odds[1] * 100).toFixed(1)}%
- Vol: $${market.volume?.toLocaleString() || '?'}, Liq: $${market.liquidity?.toLocaleString() || '?'}${desc}${signalsSection}

{"prediction":"yes|no","confidence":0-100,"reasoning":"1 sentence"}`
  }

  /**
   * Build crypto-specific analysis prompt with live BinanceWS data.
   */
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

  /**
   * Call OpenRouter API
   * Returns the message content and cost info for budget tracking.
   */
  private async callOpenRouter(prompt: string, modelOverride?: string): Promise<{ message: { content: string; annotations?: Array<{ type: string; url?: string; title?: string }> }; cost: number }> {
    // When web search is enabled, append :online to model slug and add plugins config
    const baseModel = modelOverride || this.config.model
    const model = this.config.webSearchEnabled
      ? `${baseModel}:online`
      : baseModel

    const body: Record<string, unknown> = {
      model,
      messages: [
        {
          role: 'system',
          content: this.config.webSearchEnabled
            ? 'Market analyst with web research. Use search results to make informed predictions. JSON only.'
            : 'Market analyst. JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: this.config.temperature,
      max_tokens: this.config.webSearchEnabled ? 600
        : modelOverride ? 600  // Premium models get larger output budget
        : this.config.maxTokens,
    }

    // Add web search plugin config for result count control
    if (this.config.webSearchEnabled) {
      body.plugins = [{ id: 'web', max_results: 3 }]
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'AlphaPolyBot - Polymarket LLM Trading',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`OpenRouter API error: ${response.status} - ${errorData.error?.message || response.statusText}`)
    }

    const data = await response.json()

    if (!data.choices?.[0]?.message) {
      throw new Error('Invalid response from OpenRouter')
    }

    // Extract cost: OpenRouter returns usage.total_cost (in USD) when available.
    // Fall back to token-count estimate: ~$0.00059 per 1K input + $0.00079 per 1K output (Llama 3.1 70B rates).
    // When web search is enabled, add Exa search cost: $0.004 per result × 3 results = $0.012.
    let cost = 0
    if (data.usage?.total_cost != null) {
      cost = data.usage.total_cost
    } else if (data.usage) {
      const inputTokens = data.usage.prompt_tokens ?? 0
      const outputTokens = data.usage.completion_tokens ?? 0
      cost = (inputTokens / 1000) * 0.00059 + (outputTokens / 1000) * 0.00079
      if (this.config.webSearchEnabled) {
        cost += 0.012 // Exa search: $0.004/result × 3 results
      }
    }

    return { message: data.choices[0].message, cost }
  }

  /**
   * Parse the LLM response into a prediction
   */
  private parsePrediction(response: { content: string; annotations?: Array<{ type: string; url?: string; title?: string }> }): PredictionResult {
    const content = response.content || ''

    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/)

      if (!jsonMatch) {
        throw new Error('No JSON found in response')
      }

      const parsed = JSON.parse(jsonMatch[0])

      // Validate and normalize the response
      const prediction = String(parsed.prediction).toLowerCase()
      if (prediction !== 'yes' && prediction !== 'no') {
        throw new Error(`Invalid prediction: ${prediction}`)
      }

      const confidence = Number(parsed.confidence)
      if (isNaN(confidence) || confidence < 0 || confidence > 100) {
        throw new Error(`Invalid confidence: ${parsed.confidence}`)
      }

      // Merge sources from JSON response and OpenRouter web search annotations
      const jsonSources: string[] = Array.isArray(parsed.sources) ? parsed.sources.map(String) : []
      const annotationSources: string[] = (response.annotations || [])
        .filter(a => a.type === 'url_citation' && a.url)
        .map(a => a.url as string)
      const allSources = [...new Set([...jsonSources, ...annotationSources])]

      return {
        predictedOutcome: prediction as 'yes' | 'no',
        confidence: confidence / 100, // Convert to 0-1 scale
        reasoning: String(parsed.reasoning || 'No reasoning provided'),
        sources: allSources,
        analysisTime: 0,
      }
    } catch (parseError) {
      console.error('Failed to parse LLM response:', parseError)
      console.error('Raw response:', content)
      
      // Try to extract prediction from natural language
      const lowerContent = content.toLowerCase()
      const predictedOutcome = lowerContent.includes('prediction: yes') || 
                              lowerContent.includes('"yes"') ||
                              lowerContent.includes('likely to be yes')
        ? 'yes' : 'no'

      return {
        predictedOutcome,
        confidence: 0.3, // Low confidence for fallback
        reasoning: content.substring(0, 500) || 'Failed to parse structured response',
        sources: [],
        analysisTime: 0,
      }
    }
  }

  // ==========================================
  // COST TRACKING
  // ==========================================

  /**
   * Record cost for a completed API call to a specific budget bucket
   */
  private recordCost(cost: number, bucket: string = 'prediction'): void {
    const b = this.budgets[bucket]
    if (b) {
      b.spent += cost
      b.calls++
    }
    this.totalSpendUSD += cost
  }

  /**
   * Reset a budget bucket's counters if it's a new day
   */
  private maybeResetBucket(bucket: string): void {
    const b = this.budgets[bucket]
    if (!b) return
    const today = new Date().toISOString().slice(0, 10)
    if (today !== b.lastReset) {
      b.spent = 0
      b.calls = 0
      b.lastReset = today
    }
  }

  /**
   * Set daily LLM budget for a bucket (called from settings UI)
   */
  setDailyBudget(budgetUSD: number, bucket: string = 'prediction'): void {
    const b = this.budgets[bucket]
    if (b) {
      b.limit = Math.max(0, budgetUSD)
    }
  }

  /**
   * Get daily budget for a bucket
   */
  getDailyBudget(bucket: string = 'prediction'): number {
    return this.budgets[bucket]?.limit ?? 0
  }

  /**
   * Get cost tracking statistics for a budget bucket (for UI display).
   * Defaults to 'prediction' for backward compatibility.
   */
  getCostStats(bucket: string = 'prediction'): {
    dailySpendUSD: number
    dailyBudgetUSD: number
    dailyRemaining: number
    callCountToday: number
    totalSpendUSD: number
    budgetExhausted: boolean
  } {
    this.maybeResetBucket(bucket)
    const b = this.budgets[bucket] ?? { limit: 0, spent: 0, calls: 0, lastReset: '' }
    return {
      dailySpendUSD: b.spent,
      dailyBudgetUSD: b.limit,
      dailyRemaining: Math.max(0, b.limit - b.spent),
      callCountToday: b.calls,
      totalSpendUSD: this.totalSpendUSD,
      budgetExhausted: b.spent >= b.limit,
    }
  }

  // ==========================================
  // CROSS-MARKET DEPENDENCY CLASSIFICATION
  // ==========================================

  /**
   * Classify pairwise dependencies between markets using LLM.
   * Batches pairs into a single prompt for cost efficiency.
   * Charges to the 'crossMarket' budget bucket.
   */
  async classifyDependencies(
    pairs: Array<{ marketA: Market; marketB: Market }>,
  ): Promise<MarketDependency[]> {
    if (pairs.length === 0) return []

    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured')
    }

    // Budget enforcement (crossMarket bucket)
    this.maybeResetBucket('crossMarket')
    const cmBudget = this.budgets.crossMarket
    if (cmBudget.spent >= cmBudget.limit) {
      throw new Error(
        `Cross-market LLM budget exhausted: $${cmBudget.spent.toFixed(2)} / $${cmBudget.limit.toFixed(2)} ` +
        `(${cmBudget.calls} calls today). Resets at midnight.`,
      )
    }

    const prompt = this.buildDependencyPrompt(pairs)

    try {
      const response = await this.callOpenRouter(prompt)
      this.recordCost(response.cost, 'crossMarket')

      return this.parseDependencyResponse(response.message.content, pairs)
    } catch (error) {
      console.error('[OpenRouterService] Dependency classification failed:', error)
      return []
    }
  }

  /**
   * Build the batch dependency classification prompt.
   * Designed for structured JSON output with high classification accuracy.
   */
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

  /**
   * Parse the LLM response for dependency classification.
   */
  private parseDependencyResponse(
    content: string,
    pairs: Array<{ marketA: Market; marketB: Market }>,
  ): MarketDependency[] {
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.error('[OpenRouterService] No JSON array found in dependency response')
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
      console.error('[OpenRouterService] Failed to parse dependency response:', error)
      return []
    }
  }

  // ==========================================
  // ANALYSIS HISTORY
  // ==========================================

  /**
   * Get analysis history
   */
  getAnalysisHistory(): AnalysisRecord[] {
    return [...this.analysisHistory].sort((a, b) => 
      b.timestamp.getTime() - a.timestamp.getTime()
    )
  }

  /**
   * Get prediction accuracy (for resolved markets)
   */
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

  /**
   * Update actual outcome for an analysis record (for tracking accuracy)
   */
  setActualOutcome(marketId: string, outcome: 'yes' | 'no'): void {
    const record = this.analysisHistory.find(h => h.marketId === marketId)
    if (record) {
      record.actualOutcome = outcome
    }
  }

  /**
   * Get performance metrics
   */
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

// Export singleton instance
export const openRouterService = new OpenRouterService()
