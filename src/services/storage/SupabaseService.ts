/**
 * Supabase Service — Durable Cloud Backend
 *
 * Persists bot data to Supabase alongside IndexedDB (dual-write).
 * Supabase is the durable backend for cross-session analytics;
 * IndexedDB remains the fast local cache for in-session reads.
 *
 * Tables: llm_interactions, trade_records, calibration_data, balance_snapshots
 *
 * Non-blocking: all writes are fire-and-forget. Network failures
 * are logged but never block bot execution.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { LLMInteraction } from '@/services/llm/LLMInteractionStore'
import type { TradeRecord } from '@/services/trading/TradeLogger'

// Row shape matching the llm_interactions table
interface LLMInteractionRow {
  id: string
  created_at: string
  provider: string
  model: string
  prompt_type: string
  system_prompt: string | null
  user_prompt: string
  temperature: number
  market_id: string | null
  market_question: string | null
  market_price: number | null
  volume_24h: number | null
  liquidity: number | null
  raw_response: string
  parsed_prediction: string | null
  parsed_confidence: number | null
  parsed_reasoning: string | null
  response_time_ms: number
  actual_outcome: string | null
  resolved_at: string | null
  pnl_usd: number | null
  was_correct: boolean | null
  exported: boolean
  client_id: string | null
}

export class SupabaseService {
  private client: SupabaseClient | null = null
  private clientId: string
  private buffer: LLMInteractionRow[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private static readonly FLUSH_INTERVAL_MS = 15_000 // 15s
  private static readonly MAX_BUFFER = 20

  constructor() {
    // Stable client ID for this browser instance
    this.clientId = this.getOrCreateClientId()
    this.init()
  }

  private init(): void {
    const url = import.meta.env.VITE_SUPABASE_URL
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY

    if (!url || !key) {
      console.log('[Supabase] No URL/key configured — training data will only persist in IndexedDB')
      return
    }

    const client = createClient(url, key)

    // Verify connectivity before committing
    Promise.resolve(
      client
        .from('balance_snapshots')
        .select('created_at', { count: 'exact', head: true })
        .limit(1)
    )
      .then(({ error }) => {
        if (error) {
          console.log('[Supabase] Connection check failed:', error.message, '— cloud sync disabled (local-only mode)')
          return
        }
        this.client = client
        this.flushTimer = setInterval(() => this.flush(), SupabaseService.FLUSH_INTERVAL_MS)
        console.log('[Supabase] Connected to training data backend')
      })
      .catch((err: unknown) => {
        console.log('[Supabase] Unreachable — cloud sync disabled (local-only mode)')
      })
  }

  get isEnabled(): boolean {
    return this.client !== null
  }

  /**
   * Buffer an LLM interaction for async write to Supabase.
   */
  recordInteraction(interaction: LLMInteraction): void {
    if (!this.client) return

    this.buffer.push(this.toRow(interaction))

    if (this.buffer.length >= SupabaseService.MAX_BUFFER) {
      this.flush()
    }
  }

  /**
   * Update an interaction with outcome data.
   */
  async recordOutcome(interactionId: string, outcome: {
    actualOutcome: string
    pnlUSD?: number
  }): Promise<void> {
    if (!this.client) return

    try {
      await this.client
        .from('llm_interactions')
        .update({
          actual_outcome: outcome.actualOutcome,
          pnl_usd: outcome.pnlUSD ?? null,
          resolved_at: new Date().toISOString(),
          was_correct: undefined, // Let the caller set this or compute it
        })
        .eq('id', interactionId)
    } catch (err) {
      console.warn('[Supabase] Outcome update failed:', err)
    }
  }

  /**
   * Load all interactions for export (bypasses browser IndexedDB).
   */
  async loadAll(opts?: {
    onlyResolved?: boolean
    onlyNew?: boolean
    limit?: number
  }): Promise<LLMInteractionRow[]> {
    if (!this.client) return []

    try {
      let query = this.client
        .from('llm_interactions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(opts?.limit ?? 10_000)

      if (opts?.onlyResolved) {
        query = query.not('actual_outcome', 'is', null)
      }
      if (opts?.onlyNew) {
        query = query.eq('exported', false)
      }

      const { data, error } = await query
      if (error) throw error
      return data ?? []
    } catch (err) {
      console.warn('[Supabase] loadAll failed:', err)
      return []
    }
  }

  /**
   * Get count of stored interactions.
   */
  async count(): Promise<number> {
    if (!this.client) return 0

    try {
      const { count, error } = await this.client
        .from('llm_interactions')
        .select('*', { count: 'exact', head: true })

      if (error) throw error
      return (count ?? 0) + this.buffer.length
    } catch {
      return this.buffer.length
    }
  }

  /**
   * Mark interactions as exported.
   */
  async markExported(ids: string[]): Promise<void> {
    if (!this.client || ids.length === 0) return

    try {
      await this.client
        .from('llm_interactions')
        .update({ exported: true })
        .in('id', ids)
    } catch (err) {
      console.warn('[Supabase] markExported failed:', err)
    }
  }

  /**
   * Flush buffered interactions to Supabase.
   */
  async flush(): Promise<void> {
    if (!this.client || this.buffer.length === 0) return

    const batch = this.buffer.splice(0)
    try {
      const { error } = await this.client
        .from('llm_interactions')
        .upsert(batch, { onConflict: 'id' })

      if (error) {
        console.warn('[Supabase] Flush failed:', error.message, '— dropped', batch.length, 'interactions')
      }
    } catch (err) {
      console.warn('[Supabase] Flush error:', err, '— dropped', batch.length, 'interactions')
    }
  }

  // ─── Trade Records ─────────────────────────────

  /**
   * Upsert a trade record (entry or exit update).
   */
  async upsertTradeRecord(record: TradeRecord): Promise<void> {
    if (!this.client) return

    try {
      const { error } = await this.client
        .from('trade_records')
        .upsert(this.tradeToRow(record), { onConflict: 'id' })

      if (error) {
        console.warn('[Supabase] Trade record upsert failed:', error.message)
      }
    } catch (err) {
      console.warn('[Supabase] Trade record error:', err)
    }
  }

  /**
   * Load trade records from Supabase.
   */
  async loadTradeRecords(opts?: {
    strategy?: string
    limit?: number
  }): Promise<TradeRecord[]> {
    if (!this.client) return []

    try {
      let query = this.client
        .from('trade_records')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(opts?.limit ?? 5000)

      if (opts?.strategy) {
        query = query.eq('strategy', opts.strategy)
      }

      const { data, error } = await query
      if (error) throw error
      return (data ?? []).map(this.rowToTrade)
    } catch (err) {
      console.warn('[Supabase] loadTradeRecords failed:', err)
      return []
    }
  }

  // ─── Calibration Data ─────────────────────────

  /**
   * Upsert calibration prediction (keyed by market_id).
   */
  async upsertCalibration(data: {
    marketId: string
    predictedProb: number
    predictedOutcome: string
    actualOutcome?: string
    resolvedAt?: number
  }): Promise<void> {
    if (!this.client) return

    try {
      const { error } = await this.client
        .from('calibration_data')
        .upsert({
          market_id: data.marketId,
          predicted_prob: data.predictedProb,
          predicted_outcome: data.predictedOutcome,
          actual_outcome: data.actualOutcome ?? null,
          resolved_at: data.resolvedAt ? new Date(data.resolvedAt).toISOString() : null,
          client_id: this.clientId,
        }, { onConflict: 'market_id' })

      if (error) {
        console.warn('[Supabase] Calibration upsert failed:', error.message)
      }
    } catch (err) {
      console.warn('[Supabase] Calibration error:', err)
    }
  }

  // ─── Balance Snapshots ────────────────────────

  /**
   * Record a balance snapshot for equity curve tracking.
   */
  async recordBalanceSnapshot(balance: number): Promise<void> {
    if (!this.client) return

    try {
      const { error } = await this.client
        .from('balance_snapshots')
        .insert({
          balance,
          client_id: this.clientId,
        })

      if (error) {
        console.warn('[Supabase] Balance snapshot failed:', error.message)
      }
    } catch (err) {
      console.warn('[Supabase] Balance snapshot error:', err)
    }
  }

  /**
   * Load balance snapshots for equity curve display.
   */
  async loadBalanceSnapshots(limit = 500): Promise<Array<{ timestamp: number; balance: number }>> {
    if (!this.client) return []

    try {
      const { data, error } = await this.client
        .from('balance_snapshots')
        .select('created_at, balance')
        .order('created_at', { ascending: true })
        .limit(limit)

      if (error) throw error
      return (data ?? []).map(r => ({
        timestamp: new Date(r.created_at).getTime(),
        balance: r.balance,
      }))
    } catch (err) {
      console.warn('[Supabase] loadBalanceSnapshots failed:', err)
      return []
    }
  }

  // ─── Lifecycle ────────────────────────────────

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  }

  // ─── Helpers ─────────────────────────────────

  private toRow(interaction: LLMInteraction): LLMInteractionRow {
    return {
      id: interaction.id,
      created_at: new Date(interaction.timestamp).toISOString(),
      provider: interaction.provider,
      model: interaction.model,
      prompt_type: interaction.promptType,
      system_prompt: interaction.systemPrompt ?? null,
      user_prompt: interaction.userPrompt,
      temperature: interaction.temperature,
      market_id: interaction.marketId ?? null,
      market_question: interaction.marketQuestion ?? null,
      market_price: interaction.marketPrice ?? null,
      volume_24h: interaction.volume24h ?? null,
      liquidity: interaction.liquidity ?? null,
      raw_response: interaction.rawResponse,
      parsed_prediction: interaction.parsedPrediction ?? null,
      parsed_confidence: interaction.parsedConfidence ?? null,
      parsed_reasoning: interaction.parsedReasoning ?? null,
      response_time_ms: interaction.responseTimeMs,
      actual_outcome: interaction.actualOutcome ?? null,
      resolved_at: interaction.resolvedAt ? new Date(interaction.resolvedAt).toISOString() : null,
      pnl_usd: interaction.pnlUSD ?? null,
      was_correct: interaction.wasCorrect ?? null,
      exported: interaction.exported ?? false,
      client_id: this.clientId,
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tradeToRow(record: TradeRecord): Record<string, any> {
    return {
      id: record.id,
      created_at: new Date(record.timestamp).toISOString(),
      market_id: record.marketId,
      condition_id: record.conditionId,
      question: record.question,
      category: record.category ?? null,
      outcomes: record.outcomes,
      strategy: record.strategy,
      side: record.side,
      outcome: record.outcome,
      model_probability: record.modelProbability ?? null,
      calibrated_probability: record.calibratedProbability ?? null,
      market_price: record.marketPrice,
      kelly_fraction: record.kellyFraction,
      kelly_bet_size: record.kellyBetSize,
      actual_bet_size: record.actualBetSize,
      bid_ask_spread: record.bidAskSpread ?? null,
      order_book_depth_usd: record.orderBookDepthUSD ?? null,
      volume_24h: record.volume24h ?? null,
      bid_ask_imbalance: record.bidAskImbalance ?? null,
      order_id: record.orderId ?? null,
      order_type: record.orderType,
      fill_price: record.fillPrice ?? null,
      filled_size: record.filledSize ?? null,
      slippage: record.slippage ?? null,
      gas_cost_usd: record.gasCostUSD ?? null,
      execution_time_ms: record.executionTimeMs ?? null,
      success: record.success,
      error: record.error ?? null,
      exit_timestamp: record.exitTimestamp ? new Date(record.exitTimestamp).toISOString() : null,
      exit_price: record.exitPrice ?? null,
      exit_reason: record.exitReason ?? null,
      pnl_usd: record.pnlUSD ?? null,
      pnl_percent: record.pnlPercent ?? null,
      hold_time_ms: record.holdTimeMs ?? null,
      arb_profit_ratio: record.arbProfitRatio ?? null,
      leg_count: record.legCount ?? null,
      merge_success: record.mergeSuccess ?? null,
      gas_price: record.gasPrice ?? null,
      dry_run: record.dryRun ?? false,
      wallet_id: record.walletId ?? null,
      client_id: this.clientId,
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rowToTrade(row: any): TradeRecord {
    return {
      id: row.id,
      timestamp: new Date(row.created_at).getTime(),
      marketId: row.market_id,
      conditionId: row.condition_id,
      question: row.question,
      category: row.category ?? undefined,
      outcomes: row.outcomes ?? [],
      strategy: row.strategy,
      side: row.side,
      outcome: row.outcome,
      modelProbability: row.model_probability ?? undefined,
      calibratedProbability: row.calibrated_probability ?? undefined,
      marketPrice: row.market_price,
      kellyFraction: row.kelly_fraction,
      kellyBetSize: row.kelly_bet_size,
      actualBetSize: row.actual_bet_size,
      bidAskSpread: row.bid_ask_spread ?? undefined,
      orderBookDepthUSD: row.order_book_depth_usd ?? undefined,
      volume24h: row.volume_24h ?? undefined,
      bidAskImbalance: row.bid_ask_imbalance ?? undefined,
      orderId: row.order_id ?? undefined,
      orderType: row.order_type,
      fillPrice: row.fill_price ?? undefined,
      filledSize: row.filled_size ?? undefined,
      slippage: row.slippage ?? undefined,
      gasCostUSD: row.gas_cost_usd ?? undefined,
      executionTimeMs: row.execution_time_ms ?? undefined,
      success: row.success,
      error: row.error ?? undefined,
      exitTimestamp: row.exit_timestamp ? new Date(row.exit_timestamp).getTime() : undefined,
      exitPrice: row.exit_price ?? undefined,
      exitReason: row.exit_reason ?? undefined,
      pnlUSD: row.pnl_usd ?? undefined,
      pnlPercent: row.pnl_percent ?? undefined,
      holdTimeMs: row.hold_time_ms ?? undefined,
      arbProfitRatio: row.arb_profit_ratio ?? undefined,
      legCount: row.leg_count ?? undefined,
      mergeSuccess: row.merge_success ?? undefined,
      gasPrice: row.gas_price ?? undefined,
      dryRun: row.dry_run ?? undefined,
      walletId: row.wallet_id ?? undefined,
    }
  }

  private getOrCreateClientId(): string {
    const key = 'alphapolybot-client-id'
    let id = localStorage.getItem(key)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(key, id)
    }
    return id
  }
}

// Singleton
export const supabaseService = new SupabaseService()
