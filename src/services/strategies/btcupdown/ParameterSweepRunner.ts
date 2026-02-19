/**
 * ParameterSweepRunner — grid search over BTC Up/Down strategy parameters.
 *
 * Takes a parameter grid (Record<string, number[]>), computes the cartesian product,
 * runs BacktestRunner.runBatch() for each combination against the same market type,
 * returns results ranked by Sharpe ratio.
 */
import { BacktestRunner } from './BacktestRunner'
import type { BtcUpDownConfig, BacktestSummary, PolyBacktestMarketType } from '@/types'

// ==========================================
// TYPES
// ==========================================

/** Map of param name → array of values to sweep */
export type ParameterGrid = Record<string, number[]>

export interface SweepResult {
  params: Partial<BtcUpDownConfig>
  summary: BacktestSummary
  /** Ranking metric (Sharpe by default, falls back to totalPnl) */
  score: number
}

export interface SweepOptions {
  /** Market type for batch runs */
  marketType: PolyBacktestMarketType
  /** Max markets per batch */
  maxMarkets?: number
  /** Base config (non-swept params like regimeFilterEnabled) */
  config?: Partial<BtcUpDownConfig>
  /** Grid of parameters to sweep */
  grid: ParameterGrid
  /** Progress callback: (completed, total) */
  onProgress?: (completed: number, total: number) => void
  /** Cancellation */
  signal?: AbortSignal
}

// ==========================================
// HELPERS
// ==========================================

/** Compute cartesian product of parameter arrays */
function cartesianProduct(grid: ParameterGrid): Partial<BtcUpDownConfig>[] {
  const keys = Object.keys(grid)
  if (keys.length === 0) return [{}]

  const values = keys.map(k => grid[k])
  const combos: Partial<BtcUpDownConfig>[] = []

  function recurse(depth: number, current: Record<string, number>) {
    if (depth === keys.length) {
      combos.push({ ...current } as Partial<BtcUpDownConfig>)
      return
    }
    for (const val of values[depth]) {
      current[keys[depth]] = val
      recurse(depth + 1, current)
    }
  }

  recurse(0, {})
  return combos
}

// ==========================================
// RUNNER
// ==========================================

export class ParameterSweepRunner {
  private runner = new BacktestRunner()

  /**
   * Run a grid search over the given parameters.
   * Each combo runs a full batch across the specified marketType.
   * Returns results ranked best-to-worst by Sharpe ratio (or totalPnl if Sharpe is null).
   */
  async sweep(options: SweepOptions): Promise<SweepResult[]> {
    const combos = cartesianProduct(options.grid)
    const total = combos.length
    const results: SweepResult[] = []

    for (let i = 0; i < combos.length; i++) {
      options.signal?.throwIfAborted()

      const params = combos[i]
      const mergedConfig = {
        ...options.config,
        ...params,
      }

      try {
        const batchResults = await this.runner.runBatch(options.marketType, {
          config: mergedConfig,
          maxMarkets: options.maxMarkets ?? 50,
          signal: options.signal,
        })

        const summary = this.runner.aggregateResults(batchResults)
        const score = summary.sharpeRatio ?? summary.totalPnl
        results.push({ params, summary, score })
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err
        console.warn(`[ParameterSweep] Combo ${i + 1}/${total} failed:`, (err as Error).message)
      }

      options.onProgress?.(i + 1, total)
    }

    // Sort best → worst by score
    results.sort((a, b) => b.score - a.score)
    return results
  }

  /** Utility: count total combinations for a grid */
  static countCombinations(grid: ParameterGrid): number {
    return Object.values(grid).reduce((acc, arr) => acc * arr.length, 1)
  }

  /** Utility: generate range array [min, min+step, ..., max] */
  static range(min: number, max: number, step: number): number[] {
    const result: number[] = []
    for (let v = min; v <= max + step * 0.001; v += step) {
      result.push(Math.round(v * 10000) / 10000) // avoid float artifacts
    }
    return result
  }
}

export const parameterSweepRunner = new ParameterSweepRunner()
