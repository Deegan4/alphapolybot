/**
 * LLMBacktestRunner — replay LLM predictions from stored interaction history.
 *
 * Two modes:
 * 1. REPLAY: Uses stored LLMInteraction records from IndexedDB (prompt/response/outcome).
 *    This is the most accurate — replays actual LLM predictions with known outcomes.
 * 2. BASELINE: Random walk with configurable accuracy (e.g., 52% win rate).
 *    Useful for benchmarking: "does my LLM beat random?"
 *
 * Cannot re-run LLM inference on historical data (prompts reference live market state),
 * so stored interactions are the gold standard for LLM backtesting.
 */
import type {
  UnifiedTradeRecord,
  StrategyBacktestResult,
} from '@/types'
import { computeBacktestSummary } from './BacktestSummaryEngine'

export interface LLMInteractionRecord {
  timestamp: string
  promptType: string
  marketSlug: string
  marketQuestion: string
  prediction: {
    direction: string         // 'yes' | 'no' | 'up' | 'down'
    confidence: number        // 0-1
    reasoning?: string
  }
  outcome?: {
    won: boolean
    pnl: number
    entryPrice: number
    exitPrice: number
    holdTimeMs: number
  }
  exported: boolean
}

export interface LLMBacktestConfig {
  mode: 'replay' | 'baseline'
  baselineWinRate: number      // For baseline mode (default 0.52)
  baselineAvgOdds: number      // Average entry odds (default 0.50)
  minConfidence: number        // Min LLM confidence to trade (default 0.48)
  tradeSize: number            // USD per trade (default 1.0)
  takerFeeBps: number          // Fee in bps (default 0 for GTD maker)
}

const DEFAULT_CONFIG: LLMBacktestConfig = {
  mode: 'replay',
  baselineWinRate: 0.52,
  baselineAvgOdds: 0.50,
  minConfidence: 0.48,
  tradeSize: 1.0,
  takerFeeBps: 0,
}

export class LLMBacktestRunner {
  /** Replay mode: use stored LLM interactions with recorded outcomes */
  runReplay(
    interactions: LLMInteractionRecord[],
    config?: Partial<LLMBacktestConfig>,
  ): StrategyBacktestResult {
    const cfg = { ...DEFAULT_CONFIG, mode: 'replay' as const, ...config }
    const trades: UnifiedTradeRecord[] = []

    // Filter to interactions that have outcomes recorded
    const withOutcomes = interactions
      .filter(i => i.outcome && i.prediction.confidence >= cfg.minConfidence)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

    for (const interaction of withOutcomes) {
      const outcome = interaction.outcome!
      trades.push({
        timestamp: interaction.timestamp,
        strategy: 'llm-prediction',
        direction: interaction.prediction.direction,
        entryPrice: outcome.entryPrice,
        exitPrice: outcome.exitPrice,
        pnl: outcome.pnl,
        feePaid: 0, // GTD maker = 0% fees
        holdTimeMs: outcome.holdTimeMs,
        metadata: {
          marketSlug: interaction.marketSlug,
          confidence: interaction.prediction.confidence,
          promptType: interaction.promptType,
          won: outcome.won,
        },
      })
    }

    return {
      strategy: 'llm-prediction',
      strategyName: 'LLM Prediction (Replay)',
      trades,
      summary: computeBacktestSummary(trades),
      dataSource: 'snapshot-recorder',
      config: cfg,
    }
  }

  /** Baseline mode: Monte Carlo with configurable win rate */
  runBaseline(
    numTrades: number,
    config?: Partial<LLMBacktestConfig>,
  ): StrategyBacktestResult {
    const cfg = { ...DEFAULT_CONFIG, mode: 'baseline' as const, ...config }
    const feeRate = cfg.takerFeeBps / 10_000
    const trades: UnifiedTradeRecord[] = []

    // Seeded PRNG for reproducibility (simple LCG)
    let seed = 42
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff
      return seed / 0x7fffffff
    }

    const startMs = Date.now() - numTrades * 60_000 // Synthetic timestamps

    for (let i = 0; i < numTrades; i++) {
      const won = rand() < cfg.baselineWinRate
      const entryPrice = cfg.baselineAvgOdds + (rand() - 0.5) * 0.2 // ±10% variation
      const clampedEntry = Math.max(0.10, Math.min(0.90, entryPrice))

      const payout = won ? (1.0 - feeRate) : 0
      const pnl = (payout - clampedEntry) * cfg.tradeSize

      trades.push({
        timestamp: new Date(startMs + i * 60_000).toISOString(),
        strategy: 'llm-prediction',
        direction: rand() > 0.5 ? 'yes' : 'no',
        entryPrice: clampedEntry,
        exitPrice: payout,
        pnl,
        feePaid: won ? feeRate * cfg.tradeSize : 0,
        holdTimeMs: 30 * 60_000 + rand() * 60 * 60_000, // 30m-90m hold
        metadata: { baseline: true, won },
      })
    }

    return {
      strategy: 'llm-prediction',
      strategyName: 'LLM Prediction (Baseline)',
      trades,
      summary: computeBacktestSummary(trades),
      dataSource: 'synthetic',
      config: cfg,
    }
  }
}

export const llmBacktestRunner = new LLMBacktestRunner()
