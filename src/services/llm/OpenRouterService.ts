import type { Market, PredictionResult, AnalysisRecord, LLMConfig } from '@/types'

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
  private baseUrl = 'https://openrouter.ai/api/v1'
  private analysisHistory: AnalysisRecord[] = []
  
  private config: LLMConfig = {
    provider: 'openrouter',
    model: 'anthropic/claude-3.5-sonnet',
    temperature: 0.3,
    maxTokens: 1500,
    webSearchEnabled: true,
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
  async analyzeMarket(market: Market): Promise<PredictionResult> {
    const startTime = Date.now()

    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured')
    }

    try {
      const prompt = this.buildAnalysisPrompt(market)
      const response = await this.callOpenRouter(prompt)
      const result = this.parsePrediction(response)
      
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
   * Build the analysis prompt
   */
  private buildAnalysisPrompt(market: Market): string {
    const odds = market.outcomePrices || [0.5, 0.5]
    
    return `You are an expert market analyst with access to real-time information and web search capabilities. Analyze this prediction market and predict which outcome is more likely to occur.

Market Question: "${market.question}"

Current Odds:
- ${market.outcomes?.[0] || 'Yes'}: ${(odds[0] * 100).toFixed(1)}%
- ${market.outcomes?.[1] || 'No'}: ${(odds[1] * 100).toFixed(1)}%

Market Context:
- Created: ${new Date(market.createdAt).toLocaleDateString()}
- Volume: $${market.volume?.toLocaleString() || 'Unknown'}
- Liquidity: $${market.liquidity?.toLocaleString() || 'Unknown'}
${market.description ? `- Description: ${market.description.substring(0, 500)}` : ''}
${market.resolutionSource ? `- Resolution Source: ${market.resolutionSource}` : ''}

Instructions:
1. Search for relevant real-world information, news, and data related to this question
2. Analyze current market sentiment and odds
3. Consider timing and recency of information
4. Provide a clear prediction with confidence level (0-100%)
5. Explain your reasoning with specific evidence
6. List your sources

IMPORTANT: Respond ONLY with valid JSON in this exact format:
{
  "prediction": "yes",
  "confidence": 75,
  "reasoning": "Detailed explanation here with specific evidence...",
  "sources": ["Source 1", "Source 2", "Source 3"]
}

The prediction field must be either "yes" or "no".
The confidence field must be a number between 0 and 100.`
  }

  /**
   * Call OpenRouter API
   */
  private async callOpenRouter(prompt: string): Promise<{ content: string }> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'AlphaPolyBot - Polymarket LLM Trading',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: 'system',
            content: 'You are a professional market analyst with web search capabilities. Always respond with valid JSON only, no additional text.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(`OpenRouter API error: ${response.status} - ${errorData.error?.message || response.statusText}`)
    }

    const data = await response.json()
    
    if (!data.choices?.[0]?.message) {
      throw new Error('Invalid response from OpenRouter')
    }

    return data.choices[0].message
  }

  /**
   * Parse the LLM response into a prediction
   */
  private parsePrediction(response: { content: string }): PredictionResult {
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

      return {
        predictedOutcome: prediction as 'yes' | 'no',
        confidence: confidence / 100, // Convert to 0-1 scale
        reasoning: String(parsed.reasoning || 'No reasoning provided'),
        sources: Array.isArray(parsed.sources) ? parsed.sources.map(String) : [],
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
