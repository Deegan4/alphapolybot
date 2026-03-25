/**
 * Training Data Exporter
 *
 * Transforms trading data into ChatML JSONL format for fine-tuning
 * local LLMs (MLX, LLaMA-Factory, Ollama). See scripts/finetune.sh.
 *
 * Data sources:
 * 1. LLMInteractionStore — full prompt→response→outcome triples (highest fidelity)
 * 2. TradeRecords + CalibrationData — joined trade history (legacy/fallback)
 *
 * Output: JSONL where each line is a ChatML conversation:
 * {"messages": [{"role":"system","content":"..."}, {"role":"user","content":"..."}, {"role":"assistant","content":"..."}]}
 */

import type { LLMInteraction } from './LLMInteractionStore'
import type { TradeRecord } from '@/services/trading/TradeLogger'

// ChatML conversation format (OpenAI-compatible)
export interface ChatMLEntry {
  messages: Array<{
    role: 'system' | 'user' | 'assistant'
    content: string
  }>
}

export interface ExportStats {
  totalRecords: number
  withOutcomes: number
  correct: number
  incorrect: number
  byPromptType: Record<string, number>
  byStrategy: Record<string, number>
  dateRange: { earliest: number; latest: number }
}

// The system prompt baked into every training example
const TRADING_SYSTEM_PROMPT = `You are a quantitative trading analyst for Polymarket prediction markets.
You output ONLY valid JSON — no markdown, no explanation, no preamble.

You analyze binary outcome markets (YES/NO) and produce calibrated probability estimates.
Your output directly drives real-money trades.

Key rules:
- Prices ARE implied probabilities (65¢ YES = market thinks 65% likely)
- Edge = (your probability - market price). Need >3% edge to overcome fees.
- Your confidence MUST reflect actual probability, not conviction strength.
- When uncertain, output 45-55%. Bias toward 50% when unsure.
- NEVER output >85% unless virtually certain. NEVER <20%.`

export class TrainingDataExporter {

  /**
   * Export LLM interactions as ChatML JSONL.
   * This is the highest-fidelity data source — contains actual prompts and responses.
   *
   * @param onlyResolved - If true, only include interactions with known outcomes (for supervised learning)
   * @param onlyCorrect - If true, only include correct predictions (for behavior cloning)
   */
  async exportFromInteractions(opts?: {
    onlyResolved?: boolean
    onlyCorrect?: boolean
    onlyNew?: boolean  // Only unexported interactions
  }): Promise<{ jsonl: string; stats: ExportStats }> {
    const { llmInteractionStore } = await import('./LLMInteractionStore')

    let interactions: LLMInteraction[]
    if (opts?.onlyResolved) {
      interactions = await llmInteractionStore.loadResolved()
    } else {
      interactions = await llmInteractionStore.loadAll()
    }

    if (opts?.onlyNew) {
      interactions = interactions.filter(i => !i.exported)
    }

    if (opts?.onlyCorrect) {
      interactions = interactions.filter(i => i.wasCorrect === true)
    }

    const entries: ChatMLEntry[] = []
    const stats = this.initStats()

    for (const interaction of interactions) {
      const entry = this.interactionToChatML(interaction)
      if (entry) {
        entries.push(entry)
        this.updateStats(stats, interaction)
      }
    }

    stats.totalRecords = entries.length
    const jsonl = entries.map(e => JSON.stringify(e)).join('\n')

    // Mark as exported
    if (entries.length > 0) {
      const ids = interactions.map(i => i.id)
      await llmInteractionStore.markExported(ids)
    }

    return { jsonl, stats }
  }

  /**
   * Export trade records as ChatML JSONL.
   * Reconstructs approximate prompts from trade record fields.
   * Lower fidelity than interaction export but works with historical data.
   */
  async exportFromTradeRecords(opts?: {
    strategy?: string
    onlyClosed?: boolean
    onlyProfitable?: boolean
  }): Promise<{ jsonl: string; stats: ExportStats }> {
    const { indexedDBService } = await import('@/services/storage/SupabaseService')

    let records = await indexedDBService.loadTradeRecords(10_000)
    const calibrationData = await indexedDBService.loadCalibrationData()

    // Build lookup: marketId → calibration prediction
    const calMap = new Map(calibrationData.map(c => [c.marketId, c]))

    if (opts?.strategy) {
      records = records.filter(r => r.strategy === opts.strategy)
    }
    if (opts?.onlyClosed) {
      records = records.filter(r => r.exitTimestamp != null)
    }
    if (opts?.onlyProfitable) {
      records = records.filter(r => (r.pnlUSD ?? 0) > 0)
    }

    const entries: ChatMLEntry[] = []
    const stats = this.initStats()

    for (const record of records) {
      const cal = calMap.get(record.marketId)
      const entry = this.tradeRecordToChatML(record, cal)
      if (entry) {
        entries.push(entry)
        this.updateStatsFromTrade(stats, record)
      }
    }

    stats.totalRecords = entries.length
    const jsonl = entries.map(e => JSON.stringify(e)).join('\n')
    return { jsonl, stats }
  }

  /**
   * Export combined dataset — interactions first, then fill gaps from trade records.
   */
  async exportAll(opts?: { onlyResolved?: boolean }): Promise<{ jsonl: string; stats: ExportStats }> {
    const { jsonl: interactionJsonl, stats: iStats } = await this.exportFromInteractions({
      onlyResolved: opts?.onlyResolved,
    })

    const { jsonl: tradeJsonl, stats: tStats } = await this.exportFromTradeRecords({
      onlyClosed: true,
    })

    // Merge stats
    const mergedStats: ExportStats = {
      totalRecords: iStats.totalRecords + tStats.totalRecords,
      withOutcomes: iStats.withOutcomes + tStats.withOutcomes,
      correct: iStats.correct + tStats.correct,
      incorrect: iStats.incorrect + tStats.incorrect,
      byPromptType: { ...iStats.byPromptType },
      byStrategy: { ...tStats.byStrategy },
      dateRange: {
        earliest: Math.min(iStats.dateRange.earliest || Infinity, tStats.dateRange.earliest || Infinity),
        latest: Math.max(iStats.dateRange.latest || 0, tStats.dateRange.latest || 0),
      },
    }

    const parts = [interactionJsonl, tradeJsonl].filter(Boolean)
    return { jsonl: parts.join('\n'), stats: mergedStats }
  }

  /**
   * Export from Supabase backend (works from any client, not just the browser that collected the data).
   */
  async exportFromSupabase(opts?: {
    onlyResolved?: boolean
    onlyNew?: boolean
    onlyCorrect?: boolean
  }): Promise<{ jsonl: string; stats: ExportStats }> {
    const { supabaseService } = await import('@/services/storage/SupabaseService')
    if (!supabaseService.isEnabled) {
      return { jsonl: '', stats: this.initStats() }
    }

    const rows = await supabaseService.loadAll({
      onlyResolved: opts?.onlyResolved,
      onlyNew: opts?.onlyNew,
    })

    // Convert rows back to LLMInteraction shape for reuse of existing conversion logic
    let interactions: LLMInteraction[] = rows.map(r => ({
      id: r.id,
      timestamp: new Date(r.created_at).getTime(),
      provider: 'ollama' as const,
      model: r.model,
      promptType: r.prompt_type as LLMInteraction['promptType'],
      systemPrompt: r.system_prompt ?? undefined,
      userPrompt: r.user_prompt,
      temperature: r.temperature,
      marketId: r.market_id ?? undefined,
      marketQuestion: r.market_question ?? undefined,
      marketPrice: r.market_price ?? undefined,
      volume24h: r.volume_24h ?? undefined,
      liquidity: r.liquidity ?? undefined,
      rawResponse: r.raw_response,
      parsedPrediction: r.parsed_prediction ?? undefined,
      parsedConfidence: r.parsed_confidence ?? undefined,
      parsedReasoning: r.parsed_reasoning ?? undefined,
      responseTimeMs: r.response_time_ms,
      costUSD: 0,
      actualOutcome: r.actual_outcome ?? undefined,
      resolvedAt: r.resolved_at ? new Date(r.resolved_at).getTime() : undefined,
      pnlUSD: r.pnl_usd ?? undefined,
      wasCorrect: r.was_correct ?? undefined,
      exported: r.exported,
    }))

    if (opts?.onlyCorrect) {
      interactions = interactions.filter(i => i.wasCorrect === true)
    }

    const entries: ChatMLEntry[] = []
    const stats = this.initStats()

    for (const interaction of interactions) {
      const entry = this.interactionToChatML(interaction)
      if (entry) {
        entries.push(entry)
        this.updateStats(stats, interaction)
      }
    }

    stats.totalRecords = entries.length
    const jsonl = entries.map(e => JSON.stringify(e)).join('\n')

    // Mark as exported in Supabase
    if (entries.length > 0) {
      const ids = interactions.map(i => i.id)
      await supabaseService.markExported(ids)
    }

    return { jsonl, stats }
  }

  /**
   * Trigger a browser download of the JSONL file.
   */
  downloadJsonl(jsonl: string, filename?: string): void {
    const name = filename || `polytrader-training-${new Date().toISOString().slice(0, 10)}.jsonl`
    const blob = new Blob([jsonl], { type: 'application/jsonl' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  // ─── ChatML conversion ─────────────────────────────────

  private interactionToChatML(interaction: LLMInteraction): ChatMLEntry | null {
    if (!interaction.userPrompt || !interaction.rawResponse) return null

    const systemContent = interaction.systemPrompt || TRADING_SYSTEM_PROMPT

    // Build the ideal response — if we have outcome data, construct the
    // "correct" response the model SHOULD have given
    let assistantContent: string
    if (interaction.wasCorrect !== undefined && interaction.actualOutcome) {
      // Supervised: use the correct answer as the target
      assistantContent = this.buildIdealResponse(interaction)
    } else {
      // Self-play: use the model's original response (for SFT on model behavior)
      assistantContent = interaction.rawResponse
    }

    return {
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: interaction.userPrompt },
        { role: 'assistant', content: assistantContent },
      ],
    }
  }

  private tradeRecordToChatML(
    record: TradeRecord,
    cal?: { predictedProb: number; predictedOutcome: string; actualOutcome?: string }
  ): ChatMLEntry | null {
    // Only LLM strategy records have meaningful prediction context
    if (record.strategy !== 'llm' && !record.modelProbability) return null

    const userPrompt = this.reconstructPrompt(record)
    const assistantContent = this.reconstructResponse(record, cal)

    return {
      messages: [
        { role: 'system', content: TRADING_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: assistantContent },
      ],
    }
  }

  /**
   * Build the "ideal" response — what the model should have predicted
   * given the actual outcome. This is the supervised learning target.
   */
  private buildIdealResponse(interaction: LLMInteraction): string {
    const outcome = interaction.actualOutcome || interaction.parsedPrediction || 'yes'
    // Scale confidence based on correctness:
    // Correct predictions → boost confidence slightly
    // Wrong predictions → flip the prediction and set appropriate confidence
    let confidence: number
    if (interaction.wasCorrect) {
      confidence = Math.min(95, Math.max(55, interaction.parsedConfidence ?? 60))
    } else {
      // Flip — the model should have predicted the other side
      confidence = Math.min(85, Math.max(55, 100 - (interaction.parsedConfidence ?? 50)))
    }

    const reasoning = interaction.wasCorrect
      ? (interaction.parsedReasoning || 'Market conditions supported this outcome.')
      : `Market resolved to ${outcome}. Initial assessment was incorrect.`

    if (interaction.promptType === 'signal-confirmation') {
      return JSON.stringify({
        confirm: interaction.wasCorrect,
        confidence_adjustment: interaction.wasCorrect ? 5 : -10,
        reasoning,
      })
    }

    if (interaction.promptType === 'direction') {
      return JSON.stringify({
        direction: outcome,
        confidence,
        reasoning,
      })
    }

    return JSON.stringify({
      prediction: outcome,
      confidence,
      reasoning,
    })
  }

  private reconstructPrompt(record: TradeRecord): string {
    const yesPrice = record.marketPrice
    const noPrice = 1 - record.marketPrice

    return `Predict this market outcome. Respond ONLY with JSON.

Q: "${record.question}"
- ${record.outcomes?.[0] || 'Yes'}: ${(yesPrice * 100).toFixed(1)}%
- ${record.outcomes?.[1] || 'No'}: ${(noPrice * 100).toFixed(1)}%
- Vol: $${record.volume24h?.toLocaleString() || '?'}${record.category ? `, Category: ${record.category}` : ''}

{"prediction":"yes|no","confidence":0-100,"reasoning":"1 sentence"}`
  }

  private reconstructResponse(
    record: TradeRecord,
    cal?: { predictedProb: number; predictedOutcome: string; actualOutcome?: string }
  ): string {
    // If we have calibration data with actual outcome, build ideal response
    if (cal?.actualOutcome) {
      const wasCorrect = cal.predictedOutcome === cal.actualOutcome
      const confidence = wasCorrect
        ? Math.min(90, Math.max(55, cal.predictedProb * 100))
        : Math.min(85, Math.max(55, (1 - cal.predictedProb) * 100))

      return JSON.stringify({
        prediction: cal.actualOutcome,
        confidence: Math.round(confidence),
        reasoning: wasCorrect
          ? 'Market signals aligned with this outcome.'
          : `Market resolved to ${cal.actualOutcome}.`,
      })
    }

    // Fallback: use model's original prediction from trade record
    const prediction = record.outcome?.toLowerCase().includes('yes') ? 'yes' : 'no'
    const confidence = Math.round((record.modelProbability ?? 0.5) * 100)

    // If trade closed profitably, reinforce the prediction
    if (record.pnlUSD != null) {
      const wasProfitable = record.pnlUSD > 0
      return JSON.stringify({
        prediction: wasProfitable ? prediction : (prediction === 'yes' ? 'no' : 'yes'),
        confidence: wasProfitable
          ? Math.min(85, Math.max(55, confidence))
          : Math.min(80, Math.max(50, 100 - confidence)),
        reasoning: wasProfitable
          ? 'Trade was profitable, prediction aligned with market resolution.'
          : 'Trade resulted in loss.',
      })
    }

    return JSON.stringify({ prediction, confidence, reasoning: 'Based on market analysis.' })
  }

  // ─── Stats helpers ─────────────────────────────────────

  private initStats(): ExportStats {
    return {
      totalRecords: 0,
      withOutcomes: 0,
      correct: 0,
      incorrect: 0,
      byPromptType: {},
      byStrategy: {},
      dateRange: { earliest: Infinity, latest: 0 },
    }
  }

  private updateStats(stats: ExportStats, interaction: LLMInteraction): void {
    if (interaction.actualOutcome) {
      stats.withOutcomes++
      if (interaction.wasCorrect) stats.correct++
      else stats.incorrect++
    }
    const pt = interaction.promptType || 'unknown'
    stats.byPromptType[pt] = (stats.byPromptType[pt] || 0) + 1
    if (interaction.timestamp < stats.dateRange.earliest) stats.dateRange.earliest = interaction.timestamp
    if (interaction.timestamp > stats.dateRange.latest) stats.dateRange.latest = interaction.timestamp
  }

  private updateStatsFromTrade(stats: ExportStats, record: TradeRecord): void {
    if (record.exitTimestamp) {
      stats.withOutcomes++
      if ((record.pnlUSD ?? 0) > 0) stats.correct++
      else stats.incorrect++
    }
    const strat = record.strategy || 'unknown'
    stats.byStrategy[strat] = (stats.byStrategy[strat] || 0) + 1
    if (record.timestamp < stats.dateRange.earliest) stats.dateRange.earliest = record.timestamp
    if (record.timestamp > stats.dateRange.latest) stats.dateRange.latest = record.timestamp
  }
}

// Singleton
export const trainingDataExporter = new TrainingDataExporter()
