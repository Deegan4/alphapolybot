/**
 * BacktestOrchestrator — run backtests across all 7 strategies and aggregate results.
 *
 * Coordinates data fetching, per-strategy runners, and result aggregation.
 * BTC-related strategies (Crypto Up/Down, Dual-Side, Gabagool, Impulse) use either:
 *   - PolyBacktest API (paid, higher fidelity with orderbook depth)
 *   - FreeDataAdapter (free, uses Gamma + CLOB prices-history + Binance klines)
 * Non-BTC strategies (DipArb, ProjectFW) use recorded snapshots from IndexedDB.
 * LLM Prediction uses stored interaction history or baseline simulation.
 */
import type {
  BacktestStrategyType,
  StrategyBacktestResult,
  MultiStrategyBacktestResult,
  PolyBacktestMarketType,
  PolyBacktestMarket,
  PolyBacktestSnapshot,
  UnifiedTradeRecord,
} from '@/types'
import { backtestRunner } from '../strategies/btcupdown/BacktestRunner'
import { polyBacktestClient } from '../api/PolyBacktestClient'
import { freeDataAdapter } from './FreeDataAdapter'
import { dualSideBacktestRunner } from './DualSideBacktestRunner'
import { gabagoolBacktestRunner } from './GabagoolBacktestRunner'
import { impulseBacktestRunner } from './ImpulseBacktestRunner'
import { dipArbBacktestRunner } from './DipArbBacktestRunner'
import { projectFWBacktestRunner } from './ProjectFWBacktestRunner'
import { llmBacktestRunner } from './LLMBacktestRunner'
import { snapshotRecorder } from './SnapshotRecorder'
import { computeBacktestSummary, pearsonCorrelation } from './BacktestSummaryEngine'

export interface OrchestratorConfig {
  strategies: BacktestStrategyType[]
  marketType: PolyBacktestMarketType
  maxMarkets: number
  apiKey: string
  signal?: AbortSignal
  onProgress?: (strategy: string, progress: number, label: string) => void
  // Per-strategy config overrides
  btcConfig?: Record<string, unknown>
  dipArbConfig?: Record<string, unknown>
  fwConfig?: Record<string, unknown>
  dualSideConfig?: Record<string, unknown>
  gabagoolConfig?: Record<string, unknown>
  impulseConfig?: Record<string, unknown>
  llmConfig?: Record<string, unknown>
}

const ALL_STRATEGIES: BacktestStrategyType[] = [
  'btc-updown', 'dip-arb', 'project-fw', 'dual-side',
  'gabagool', 'impulse-sniper', 'llm-prediction',
]

export class BacktestOrchestrator {
  async run(config: OrchestratorConfig): Promise<MultiStrategyBacktestResult> {
    const strategies = config.strategies.length > 0 ? config.strategies : ALL_STRATEGIES
    const results: StrategyBacktestResult[] = []

    // Configure API key for PolyBacktest
    if (config.apiKey) polyBacktestClient.setApiKey(config.apiKey)
    const hasPaidApi = polyBacktestClient.hasApiKey()

    // BTC-related strategies share the same market data
    const btcStrategies = strategies.filter(s =>
      ['btc-updown', 'dual-side', 'gabagool', 'impulse-sniper'].includes(s)
    )

    if (btcStrategies.length > 0) {
      if (hasPaidApi) {
        await this.runBtcStrategiesPaid(config, strategies, btcStrategies, results)
      } else {
        await this.runBtcStrategiesFree(config, strategies, btcStrategies, results)
      }
    }

    // DipArb — uses recorded snapshots
    if (strategies.includes('dip-arb')) {
      config.signal?.throwIfAborted()
      config.onProgress?.('dip-arb', 0, 'Loading recorded snapshots...')
      try {
        await snapshotRecorder.open()
        const now = new Date()
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        const snapshots = await snapshotRecorder.getByTimeRange(
          weekAgo.toISOString(), now.toISOString(),
        )
        config.onProgress?.('dip-arb', 50, `${snapshots.length} snapshots`)
        results.push(dipArbBacktestRunner.run(snapshots, config.dipArbConfig))
        config.onProgress?.('dip-arb', 100, 'Done')
      } catch {
        config.onProgress?.('dip-arb', 100, 'No recorded data — start snapshot recorder first')
      }
    }

    // ProjectFW — uses recorded snapshots
    if (strategies.includes('project-fw')) {
      config.signal?.throwIfAborted()
      config.onProgress?.('project-fw', 0, 'Loading recorded snapshots...')
      try {
        await snapshotRecorder.open()
        const now = new Date()
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        const snapshots = await snapshotRecorder.getByTimeRange(
          weekAgo.toISOString(), now.toISOString(),
        )
        config.onProgress?.('project-fw', 50, `${snapshots.length} snapshots`)
        results.push(projectFWBacktestRunner.run(snapshots, config.fwConfig))
        config.onProgress?.('project-fw', 100, 'Done')
      } catch {
        config.onProgress?.('project-fw', 100, 'No recorded data — start snapshot recorder first')
      }
    }

    // LLM Prediction — baseline mode (replay mode requires interaction store data)
    if (strategies.includes('llm-prediction')) {
      config.signal?.throwIfAborted()
      config.onProgress?.('llm-prediction', 0, 'Running LLM baseline...')
      results.push(llmBacktestRunner.runBaseline(200, config.llmConfig))
      config.onProgress?.('llm-prediction', 100, 'Done')
    }

    // Build correlation matrix
    const correlationMatrix = this.buildCorrelationMatrix(results)

    // Combine all trades for unified summary
    const allTrades = results.flatMap(r => r.trades)
    allTrades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

    return {
      strategies: results,
      combined: computeBacktestSummary(allTrades),
      correlationMatrix,
      runTimestamp: new Date().toISOString(),
    }
  }

  // ==========================================
  // PAID API PATH (PolyBacktest)
  // ==========================================

  private async runBtcStrategiesPaid(
    config: OrchestratorConfig,
    strategies: BacktestStrategyType[],
    btcStrategies: BacktestStrategyType[],
    results: StrategyBacktestResult[],
  ): Promise<void> {
    // Fetch BTC market data once, share across strategies
    config.onProgress?.('data', 0, `Discovering ${config.marketType} markets...`)
    config.signal?.throwIfAborted()
    let btcMarkets = await polyBacktestClient.getResolvedMarkets(config.marketType, config.signal)
    btcMarkets = btcMarkets.slice(0, config.maxMarkets)
    config.onProgress?.('data', 100, `Found ${btcMarkets.length} markets`)

    // Run Crypto Up/Down (its own batch runner)
    if (strategies.includes('btc-updown')) {
      await this.runBtcUpDownPaid(config, results)
    }

    // Run shared-snapshot strategies
    await this.runSharedSnapshotStrategies(
      config, strategies, btcStrategies, btcMarkets, results,
      (market, signal) => polyBacktestClient.getAllSnapshots(market.market_id, true, undefined, signal),
      'polybacktest',
    )
  }

  private async runBtcUpDownPaid(
    config: OrchestratorConfig,
    results: StrategyBacktestResult[],
  ): Promise<void> {
    config.signal?.throwIfAborted()
    config.onProgress?.('btc-updown', 0, 'Running Crypto Up/Down...')

    const btcResults = await backtestRunner.runBatch(config.marketType, {
      signal: config.signal,
      maxMarkets: config.maxMarkets,
      config: config.btcConfig as Record<string, never>,
      onProgress: (i, total) => {
        config.onProgress?.('btc-updown', Math.round((i / total) * 100), `Market ${i}/${total}`)
      },
    })

    const btcTrades: UnifiedTradeRecord[] = btcResults.flatMap(r =>
      r.trades.map(t => ({
        timestamp: t.snapshotTime,
        strategy: 'btc-updown' as const,
        direction: t.direction,
        entryPrice: t.entryPrice,
        exitPrice: t.pnl > 0 ? t.entryPrice + t.pnl : 0,
        pnl: t.pnl,
        feePaid: t.entryPrice * 0.10,
        holdTimeMs: t.holdTimeMs,
        metadata: { confidence: t.confidence, btcPrice: t.btcPriceAtEntry },
      }))
    )

    results.push({
      strategy: 'btc-updown',
      strategyName: 'Crypto Up/Down',
      trades: btcTrades,
      summary: computeBacktestSummary(btcTrades),
      dataSource: 'polybacktest',
      config: config.btcConfig ?? {},
    })
  }

  // ==========================================
  // FREE API PATH (Gamma + CLOB + Binance)
  // ==========================================

  private async runBtcStrategiesFree(
    config: OrchestratorConfig,
    strategies: BacktestStrategyType[],
    btcStrategies: BacktestStrategyType[],
    results: StrategyBacktestResult[],
  ): Promise<void> {
    config.onProgress?.('data', 0, `Discovering ${config.marketType} markets (free API)...`)
    config.signal?.throwIfAborted()

    const btcMarkets = await freeDataAdapter.getResolvedMarkets(
      config.marketType, config.maxMarkets, config.signal,
    )
    config.onProgress?.('data', 100, `Found ${btcMarkets.length} markets (free)`)

    if (btcMarkets.length === 0) {
      config.onProgress?.('data', 100, 'No resolved markets found — try a different market type')
      return
    }

    // Crypto Up/Down also uses shared snapshots in free mode (no separate batch runner)
    await this.runSharedSnapshotStrategies(
      config, strategies, btcStrategies, btcMarkets, results,
      (market, signal) => freeDataAdapter.getSnapshots(market, signal),
      'synthetic',
    )
  }

  // ==========================================
  // SHARED SNAPSHOT RUNNER (works with both paid & free data)
  // ==========================================

  private async runSharedSnapshotStrategies(
    config: OrchestratorConfig,
    strategies: BacktestStrategyType[],
    btcStrategies: BacktestStrategyType[],
    btcMarkets: PolyBacktestMarket[],
    results: StrategyBacktestResult[],
    fetchSnapshots: (market: PolyBacktestMarket, signal?: AbortSignal) => Promise<PolyBacktestSnapshot[]>,
    dataSource: 'polybacktest' | 'synthetic',
  ): Promise<void> {
    const needsSnapshots = btcStrategies.some(s =>
      // In free mode, btc-updown also goes through shared snapshots
      dataSource === 'synthetic' ? true : s !== 'btc-updown'
    )
    if (!needsSnapshots) return

    for (let i = 0; i < btcMarkets.length; i++) {
      const market = btcMarkets[i]
      config.signal?.throwIfAborted()
      config.onProgress?.('snapshots', Math.round((i / btcMarkets.length) * 100),
        `Fetching snapshots ${i + 1}/${btcMarkets.length}...`)

      const snapshots = await fetchSnapshots(market, config.signal)
      if (snapshots.length === 0) continue

      // Crypto Up/Down (free mode only — paid mode uses its own batch runner)
      if (dataSource === 'synthetic' && strategies.includes('btc-updown')) {
        this.runStrategyOnMarket('btc-updown', 'Crypto Up/Down', dataSource,
          () => dualSideBacktestRunner.run(market, snapshots, {
            ...config.btcConfig,
            // Override to single-direction mode for Crypto Up/Down simulation
            biasRatio: 1.0,
            minSignalConfidence: 0.35,
          }),
          results)
      }

      // Dual-Side
      if (strategies.includes('dual-side')) {
        this.runStrategyOnMarket('dual-side', 'Dual-Side Hedge', dataSource,
          () => dualSideBacktestRunner.run(market, snapshots, config.dualSideConfig),
          results)
      }

      // Gabagool
      if (strategies.includes('gabagool')) {
        this.runStrategyOnMarket('gabagool', 'Gabagool Accumulator', dataSource,
          () => gabagoolBacktestRunner.run(market, snapshots, config.gabagoolConfig),
          results)
      }

      // Impulse Sniper
      if (strategies.includes('impulse-sniper')) {
        this.runStrategyOnMarket('impulse-sniper', 'Impulse Sniper', dataSource,
          () => impulseBacktestRunner.run(market, snapshots, config.impulseConfig),
          results)
      }
    }

    // Recompute summaries for accumulated multi-market results
    const sharedStrategies = ['dual-side', 'gabagool', 'impulse-sniper']
    if (dataSource === 'synthetic') sharedStrategies.push('btc-updown')
    for (const r of results) {
      if (sharedStrategies.includes(r.strategy)) {
        r.summary = computeBacktestSummary(r.trades)
      }
    }
  }

  /** Run a strategy on a single market — accumulate into existing result or create new one. */
  private runStrategyOnMarket(
    strategy: BacktestStrategyType,
    strategyName: string,
    dataSource: 'polybacktest' | 'synthetic',
    runFn: () => StrategyBacktestResult,
    results: StrategyBacktestResult[],
  ): void {
    const result = runFn()
    const existing = results.find(r => r.strategy === strategy)
    if (existing) {
      existing.trades.push(...result.trades)
    } else {
      result.strategyName = strategyName
      result.dataSource = dataSource
      results.push(result)
    }
  }

  // ==========================================
  // CORRELATION MATRIX
  // ==========================================

  private buildCorrelationMatrix(
    results: StrategyBacktestResult[],
  ): Record<string, Record<string, number>> {
    const matrix: Record<string, Record<string, number>> = {}

    for (const a of results) {
      matrix[a.strategy] = {}
      for (const b of results) {
        if (a.strategy === b.strategy) {
          matrix[a.strategy][b.strategy] = 1.0
        } else {
          const pnlA = a.trades.map(t => t.pnl)
          const pnlB = b.trades.map(t => t.pnl)
          matrix[a.strategy][b.strategy] = pearsonCorrelation(pnlA, pnlB)
        }
      }
    }

    return matrix
  }
}

export const backtestOrchestrator = new BacktestOrchestrator()
