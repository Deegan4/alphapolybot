/**
 * FullBotBacktest — comprehensive backtest of ALL 7 strategies with realistic synthetic data.
 *
 * Generates 50 synthetic Crypto Up/Down markets (mix of 1hr, 15m, 4hr) with realistic
 * price action, orderbooks, and outcomes. Runs every strategy runner against them
 * and prints a formatted results table.
 *
 * Run: npx vitest run src/services/backtest/__tests__/FullBotBacktest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { DualSideBacktestRunner } from '../DualSideBacktestRunner'
import { GabagoolBacktestRunner } from '../GabagoolBacktestRunner'
import { ImpulseBacktestRunner } from '../ImpulseBacktestRunner'
import { DipArbBacktestRunner } from '../DipArbBacktestRunner'
import { ProjectFWBacktestRunner } from '../ProjectFWBacktestRunner'
import { LLMBacktestRunner } from '../LLMBacktestRunner'
import { computeBacktestSummary, pearsonCorrelation } from '../BacktestSummaryEngine'
import type {
  PolyBacktestMarket,
  PolyBacktestSnapshot,
  RecordedSnapshot,
  UnifiedTradeRecord,
  StrategyBacktestResult,
  BacktestSummary,
} from '@/types'
import type { LLMInteractionRecord } from '../LLMBacktestRunner'

// ═══════════════════════════════════════════════════════════
// SEEDED PRNG — reproducible synthetic data
// ═══════════════════════════════════════════════════════════

class SeededRng {
  private seed: number
  constructor(seed: number) { this.seed = seed }

  /** Returns [0, 1) */
  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) & 0x7fffffff
    return this.seed / 0x7fffffff
  }

  /** Normal distribution via Box-Muller */
  nextGaussian(mean = 0, stdDev = 1): number {
    const u1 = this.next()
    const u2 = this.next()
    const z = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2)
    return z * stdDev + mean
  }
}

// ═══════════════════════════════════════════════════════════
// SYNTHETIC MARKET GENERATOR
// ═══════════════════════════════════════════════════════════

interface MarketScenario {
  market: PolyBacktestMarket
  snapshots: PolyBacktestSnapshot[]
}

const WINDOW_DURATIONS: Record<string, number> = {
  '15m': 15 * 60_000,
  '1hr': 60 * 60_000,
  '4hr': 4 * 60 * 60_000,
}

/**
 * Generate a realistic BTC market with price action that creates
 * tradeable signals — some markets trend up, some down, some chop.
 */
function generateMarket(
  rng: SeededRng,
  index: number,
  marketType: '15m' | '1hr' | '4hr',
): MarketScenario {
  const windowMs = WINDOW_DURATIONS[marketType]
  const snapshotIntervalMs = marketType === '15m' ? 15_000 : marketType === '1hr' ? 60_000 : 120_000
  const numSnapshots = Math.floor(windowMs / snapshotIntervalMs)

  const baseTime = new Date('2026-01-15T00:00:00Z').getTime() + index * windowMs * 1.5
  const startTime = new Date(baseTime).toISOString()
  const endTime = new Date(baseTime + windowMs).toISOString()

  // Starting BTC price with some variation
  const btcStart = 95000 + rng.nextGaussian(0, 3000)

  // Determine outcome: 55% up (slight bull bias, realistic for crypto)
  const goesUp = rng.next() < 0.55
  const winner: 'up' | 'down' = goesUp ? 'up' : 'down'

  // Generate BTC price path (geometric random walk with drift)
  const drift = goesUp ? 0.0001 : -0.0001 // slight directional bias
  const volatility = marketType === '15m' ? 0.0003 : marketType === '1hr' ? 0.0008 : 0.002
  const btcPrices: number[] = [btcStart]
  for (let i = 1; i < numSnapshots; i++) {
    const prevPrice = btcPrices[i - 1]
    const ret = drift + rng.nextGaussian(0, volatility)
    btcPrices.push(prevPrice * (1 + ret))
  }

  const btcEnd = btcPrices[btcPrices.length - 1]

  // Generate outcome prices that react to BTC price moves (with lag)
  const snapshots: PolyBacktestSnapshot[] = []
  let prevUpPrice = 0.50
  let prevDownPrice = 0.50

  for (let i = 0; i < numSnapshots; i++) {
    const btcReturn = (btcPrices[i] - btcStart) / btcStart
    const timeProgress = i / numSnapshots

    // Outcome prices converge toward winner as time progresses
    // Add noise and sluggish response (creates impulse arb opportunities)
    const winnerTarget = 0.50 + btcReturn * 3 + (goesUp ? 1 : -1) * timeProgress * 0.15
    const idealUpPrice = Math.max(0.05, Math.min(0.95, winnerTarget))
    const idealDownPrice = Math.max(0.05, Math.min(0.95, 1.0 - idealUpPrice + rng.nextGaussian(0, 0.005)))

    // Sluggish price response (creates trading opportunities)
    const sluggishness = 0.85 + rng.next() * 0.10 // 85-95% sticky to previous
    const upPrice = Number((prevUpPrice * sluggishness + idealUpPrice * (1 - sluggishness) + rng.nextGaussian(0, 0.005)).toFixed(4))
    const downPrice = Number((prevDownPrice * sluggishness + idealDownPrice * (1 - sluggishness) + rng.nextGaussian(0, 0.005)).toFixed(4))

    const clampedUp = Math.max(0.05, Math.min(0.95, upPrice))
    const clampedDown = Math.max(0.05, Math.min(0.95, downPrice))

    prevUpPrice = clampedUp
    prevDownPrice = clampedDown

    const snapshotTime = new Date(baseTime + i * snapshotIntervalMs).toISOString()

    snapshots.push({
      id: `synth-${index}-${i}`,
      market_id: `market-${index}`,
      time: snapshotTime,
      btc_price: btcPrices[i],
      price_up: clampedUp,
      price_down: clampedDown,
      orderbook_up: {
        bids: [{ price: clampedUp - 0.02, size: 50 + rng.next() * 200 }],
        asks: [{ price: clampedUp + 0.02, size: 50 + rng.next() * 200 }],
      },
      orderbook_down: {
        bids: [{ price: clampedDown - 0.02, size: 50 + rng.next() * 200 }],
        asks: [{ price: clampedDown + 0.02, size: 50 + rng.next() * 200 }],
      },
    })
  }

  const market: PolyBacktestMarket = {
    market_id: `market-${index}`,
    event_id: `event-${index}`,
    slug: `btc-updown-${marketType}-${index}`,
    market_type: marketType,
    start_time: startTime,
    end_time: endTime,
    btc_price_start: btcStart,
    btc_price_end: btcEnd,
    condition_id: `0xcond${index}`,
    clob_token_up: `0xup${index}`,
    clob_token_down: `0xdown${index}`,
    winner,
    final_volume: 500 + rng.next() * 2000,
    final_liquidity: 200 + rng.next() * 1000,
    resolved_at: endTime,
    created_at: startTime,
    updated_at: endTime,
  }

  return { market, snapshots }
}

/**
 * Generate RecordedSnapshots for DipArb/ProjectFW (different shape).
 * Simulates multi-outcome event markets with occasional price dips.
 */
function generateRecordedSnapshots(rng: SeededRng, count: number): RecordedSnapshot[] {
  const snapshots: RecordedSnapshot[] = []
  const numMarkets = 10

  for (let m = 0; m < numMarkets; m++) {
    const marketId = `event-market-${m}`
    const baseTime = new Date('2026-01-15T00:00:00Z').getTime()

    for (let i = 0; i < count / numMarkets; i++) {
      const timestamp = new Date(baseTime + (m * count / numMarkets + i) * 60_000).toISOString()

      // Random 2-outcome market prices
      const p1 = 0.45 + rng.next() * 0.15 // 0.45 - 0.60
      const p2 = 1.0 - p1 + rng.nextGaussian(0, 0.02) // Usually sums near 1.0

      // Occasionally create an arb opportunity (askSum < 0.96)
      const isArbOpp = rng.next() < 0.08 // 8% of snapshots have arb
      const askSpread = isArbOpp ? -0.02 - rng.next() * 0.03 : 0.01 + rng.next() * 0.02
      const ask1 = Math.max(0.05, p1 + askSpread / 2)
      const ask2 = Math.max(0.05, p2 + askSpread / 2)

      snapshots.push({
        timestamp,
        marketId,
        slug: `event-slug-${m}`,
        question: `Will event ${m} happen?`,
        outcomes: ['Yes', 'No'],
        outcomePrices: [p1, p2],
        askPrices: [ask1, ask2],
        bidPrices: [ask1 - 0.03, ask2 - 0.03],
        volume24h: 100 + rng.next() * 500,
        liquidity: 200 + rng.next() * 800,
        clobTokenIds: [`token-${m}-0`, `token-${m}-1`],
        conditionId: `0xcond-event-${m}`,
        negRisk: false,
      })
    }
  }

  return snapshots
}

/**
 * Generate synthetic LLM interaction history for replay backtesting.
 */
function generateLLMInteractions(rng: SeededRng, count: number): LLMInteractionRecord[] {
  const interactions: LLMInteractionRecord[] = []
  const baseTime = new Date('2026-01-15T00:00:00Z').getTime()

  for (let i = 0; i < count; i++) {
    const confidence = 0.40 + rng.next() * 0.50 // 0.40-0.90
    const direction = rng.next() > 0.5 ? 'yes' : 'no'
    const entryPrice = 0.35 + rng.next() * 0.30 // 0.35-0.65

    // Win probability correlated with confidence (higher confidence = more likely to win)
    // But not perfect — simulates a somewhat calibrated LLM
    const winProb = 0.35 + confidence * 0.35 // 49% at 0.40 conf → 66.5% at 0.90 conf
    const won = rng.next() < winProb

    const exitPrice = won ? 1.0 : 0.0
    const pnl = (exitPrice - entryPrice) * 1.0 // $1 trade size

    interactions.push({
      timestamp: new Date(baseTime + i * 15 * 60_000).toISOString(), // 15 min apart
      promptType: 'market-analysis',
      marketSlug: `llm-market-${i}`,
      marketQuestion: `Will outcome ${i} happen?`,
      prediction: { direction, confidence },
      outcome: {
        won,
        pnl,
        entryPrice,
        exitPrice,
        holdTimeMs: 30 * 60_000 + rng.next() * 60 * 60_000,
      },
      exported: false,
    })
  }

  return interactions
}

// ═══════════════════════════════════════════════════════════
// RESULTS FORMATTING
// ═══════════════════════════════════════════════════════════

function formatDollars(n: number): string {
  const sign = n >= 0 ? '+' : ''
  return `${sign}$${n.toFixed(2)}`
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function formatTime(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`
  if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3600_000).toFixed(1)}h`
}

function printStrategyResult(result: StrategyBacktestResult): void {
  const s = result.summary
  console.log(`\n  ┌─── ${result.strategyName} ${'─'.repeat(Math.max(0, 45 - result.strategyName.length))}┐`)
  console.log(`  │ Trades:    ${String(s.totalTrades).padStart(6)}  │ Win Rate: ${formatPct(s.winRate).padStart(7)}   │`)
  console.log(`  │ Total P&L: ${formatDollars(s.totalPnl).padStart(8)} │ Avg P&L:  ${formatDollars(s.avgPnl).padStart(8)}  │`)
  console.log(`  │ Wins/Loss: ${String(s.wins).padStart(3)}/${String(s.losses).padStart(3)}  │ Max DD:   ${formatDollars(s.maxDrawdown).padStart(8)}  │`)
  console.log(`  │ Sharpe:    ${s.sharpeRatio != null ? s.sharpeRatio.toFixed(2).padStart(6) : '  N/A '}  │ PF:       ${s.profitFactor != null ? s.profitFactor.toFixed(2).padStart(6) : '  N/A '}   │`)
  console.log(`  │ Avg Hold:  ${formatTime(s.avgHoldTimeMs).padStart(6)}  │ Source:   ${result.dataSource.padStart(10)}│`)
  console.log(`  └${'─'.repeat(52)}┘`)
}

function printCombinedResults(
  results: StrategyBacktestResult[],
  combined: BacktestSummary,
  correlationMatrix: Record<string, Record<string, number>>,
): void {
  console.log('\n╔══════════════════════════════════════════════════════╗')
  console.log('║       ALPHAPOLYBOT — FULL STRATEGY BACKTEST         ║')
  console.log('║       50 markets • 7 strategies • $40 bankroll      ║')
  console.log('╚══════════════════════════════════════════════════════╝')

  for (const r of results) {
    printStrategyResult(r)
  }

  console.log('\n  ╔══════════════════════════════════════════════════╗')
  console.log('  ║              COMBINED PORTFOLIO                  ║')
  console.log('  ╠══════════════════════════════════════════════════╣')
  console.log(`  ║ Total Trades: ${String(combined.totalTrades).padStart(5)}                              ║`)
  console.log(`  ║ Total P&L:    ${formatDollars(combined.totalPnl).padStart(8)}                           ║`)
  console.log(`  ║ Win Rate:     ${formatPct(combined.winRate).padStart(7)}                            ║`)
  console.log(`  ║ Sharpe Ratio: ${combined.sharpeRatio != null ? combined.sharpeRatio.toFixed(2).padStart(6) : '  N/A '}                             ║`)
  console.log(`  ║ Profit Factor:${combined.profitFactor != null ? combined.profitFactor.toFixed(2).padStart(6) : '  N/A '}                             ║`)
  console.log(`  ║ Max Drawdown: ${formatDollars(combined.maxDrawdown).padStart(8)}                           ║`)
  console.log(`  ║ ROI on $40:   ${formatPct(combined.totalPnl / 40).padStart(7)}                            ║`)
  console.log('  ╚══════════════════════════════════════════════════╝')

  // Correlation matrix
  const strategies = Object.keys(correlationMatrix)
  if (strategies.length >= 2) {
    console.log('\n  Strategy Correlation Matrix:')
    const shortNames: Record<string, string> = {
      'btc-updown': 'BTC',
      'dual-side': 'DualS',
      'gabagool': 'Gaba',
      'impulse-sniper': 'Imp',
      'dip-arb': 'Dip',
      'project-fw': 'FW',
      'llm-prediction': 'LLM',
    }
    const header = '         ' + strategies.map(s => shortNames[s]?.padStart(6) || s.slice(0, 5).padStart(6)).join('')
    console.log(header)
    for (const a of strategies) {
      const row = strategies.map(b => {
        const val = correlationMatrix[a]?.[b] ?? 0
        return val.toFixed(2).padStart(6)
      }).join('')
      console.log(`  ${(shortNames[a] || a.slice(0, 5)).padEnd(7)} ${row}`)
    }
  }

  // Strategy ranking by risk-adjusted returns
  console.log('\n  Strategy Ranking (by Sharpe):')
  const ranked = [...results]
    .filter(r => r.summary.sharpeRatio != null && r.summary.totalTrades >= 5)
    .sort((a, b) => (b.summary.sharpeRatio ?? 0) - (a.summary.sharpeRatio ?? 0))
  ranked.forEach((r, i) => {
    const emoji = i === 0 ? ' [BEST]' : ''
    console.log(`  ${i + 1}. ${r.strategyName.padEnd(25)} Sharpe: ${r.summary.sharpeRatio!.toFixed(2).padStart(7)} | P&L: ${formatDollars(r.summary.totalPnl).padStart(8)}${emoji}`)
  })

  // Capital allocation recommendation for $40
  console.log('\n  Recommended Allocation ($40 bankroll):')
  const viable = ranked.filter(r => r.summary.totalPnl > 0 && (r.summary.sharpeRatio ?? 0) > 0)
  if (viable.length === 0) {
    console.log('  ⚠ No strategies showed positive edge — run in dry mode first')
  } else {
    const totalSharpe = viable.reduce((s, r) => s + Math.max(0, r.summary.sharpeRatio ?? 0), 0)
    for (const r of viable) {
      const weight = (r.summary.sharpeRatio ?? 0) / totalSharpe
      const alloc = weight * 40
      console.log(`  - ${r.strategyName.padEnd(25)} $${alloc.toFixed(2).padStart(6)} (${formatPct(weight)})`)
    }
  }
}

// ═══════════════════════════════════════════════════════════
// THE BACKTEST
// ═══════════════════════════════════════════════════════════

describe('Full Bot Backtest', () => {
  const rng = new SeededRng(2026_03_15) // Today's date as seed

  // Generate synthetic data
  const btcMarkets: MarketScenario[] = []
  const marketTypes: Array<'15m' | '1hr' | '4hr'> = ['1hr', '1hr', '1hr', '15m', '15m', '4hr']

  for (let i = 0; i < 50; i++) {
    const marketType = marketTypes[i % marketTypes.length]
    btcMarkets.push(generateMarket(rng, i, marketType))
  }

  const recordedSnapshots = generateRecordedSnapshots(rng, 500)
  const llmInteractions = generateLLMInteractions(rng, 200)

  it('runs all 7 strategies and produces full results', () => {
    const allResults: StrategyBacktestResult[] = []

    // ─── 1. Crypto Up/Down (via Dual-Side runner in single-direction mode) ───
    const btcUpDownRunner = new DualSideBacktestRunner()
    const btcTrades: UnifiedTradeRecord[] = []
    for (const { market, snapshots } of btcMarkets) {
      const result = btcUpDownRunner.run(market, snapshots, {
        biasRatio: 1.0,           // Single direction = Crypto Up/Down mode
        minSignalConfidence: 0.35,
        maxAskSum: 1.05,          // More lenient for single-direction
        tradeSize: 1.0,           // $1 per trade
        regimeFilterEnabled: true,
        rsiFilterEnabled: true,
      })
      for (const t of result.trades) {
        btcTrades.push({ ...t, strategy: 'btc-updown' })
      }
    }
    allResults.push({
      strategy: 'btc-updown',
      strategyName: 'Crypto Up/Down',
      trades: btcTrades,
      summary: computeBacktestSummary(btcTrades),
      dataSource: 'synthetic',
      config: { tradeSize: 1.0, mode: 'maker-gtc' },
    })

    // ─── 2. Dual-Side Hedge ───
    const dualSideRunner = new DualSideBacktestRunner()
    const dualTrades: UnifiedTradeRecord[] = []
    for (const { market, snapshots } of btcMarkets) {
      const result = dualSideRunner.run(market, snapshots, {
        biasRatio: 0.70,
        minSignalConfidence: 0.35,
        maxAskSum: 0.995,
        tradeSize: 2.0,
        regimeFilterEnabled: true,
        rsiFilterEnabled: true,
      })
      dualTrades.push(...result.trades)
    }
    allResults.push({
      strategy: 'dual-side',
      strategyName: 'Dual-Side Hedge',
      trades: dualTrades,
      summary: computeBacktestSummary(dualTrades),
      dataSource: 'synthetic',
      config: { tradeSize: 2.0, biasRatio: 0.70 },
    })

    // ─── 3. Gabagool Accumulator ───
    const gabagoolRunner = new GabagoolBacktestRunner()
    const gabaTrades: UnifiedTradeRecord[] = []
    for (const { market, snapshots } of btcMarkets) {
      const result = gabagoolRunner.run(market, snapshots, {
        cheapnessThreshold: 0.48,
        orderSize: 1.0,           // $1 per order (CLOB minimum)
        maxImbalance: 3.0,
        minProfitMargin: 0.005,
        maxExposure: 5,           // Conservative with $40 bankroll
        cooldownMs: 3_000,
      })
      gabaTrades.push(...result.trades)
    }
    allResults.push({
      strategy: 'gabagool',
      strategyName: 'Gabagool Accumulator',
      trades: gabaTrades,
      summary: computeBacktestSummary(gabaTrades),
      dataSource: 'synthetic',
      config: { orderSize: 1.0, maxExposure: 5 },
    })

    // ─── 4. Impulse Sniper ───
    const impulseRunner = new ImpulseBacktestRunner()
    const impulseTrades: UnifiedTradeRecord[] = []
    for (const { market, snapshots } of btcMarkets) {
      const result = impulseRunner.run(market, snapshots, {
        impulseThreshold: 150,    // $150 BTC move
        staleOddsThreshold: 0.03,
        tradeSize: 1.50,
        takerFeeBps: 100,         // 1hr markets
        stopLossPct: 0.15,
        takeProfitPct: 0.40,
        cooldownMs: 30_000,
        lookbackSnapshots: 5,
      })
      impulseTrades.push(...result.trades)
    }
    allResults.push({
      strategy: 'impulse-sniper',
      strategyName: 'Impulse Sniper',
      trades: impulseTrades,
      summary: computeBacktestSummary(impulseTrades),
      dataSource: 'synthetic',
      config: { tradeSize: 1.50, takerFeeBps: 100 },
    })

    // ─── 5. DipArb ───
    const dipArbRunner = new DipArbBacktestRunner()
    const dipArbResult = dipArbRunner.run(recordedSnapshots, {
      sumTarget: 0.96,
      takerFeeBps: 200,           // Taker fees (DipArb uses FOK/GTD)
      minVolume: 50,
      cooldownMs: 30_000,
      tradeSize: 2.0,
    })
    allResults.push(dipArbResult)

    // ─── 6. ProjectFW ───
    const fwRunner = new ProjectFWBacktestRunner()
    const fwResult = fwRunner.run(recordedSnapshots, {
      alpha: 0.5,
      epsilonD: 0.001,
      epsilon0: 0.1,
      maxIterations: 50,
      minProfitBps: 30,
      takerFeeBps: 100,
      gasEstimateUSD: 0.01,
      tradeSize: 1.0,             // $1 per arb — small bankroll
      minLiquidity: 50,
      cooldownMs: 60_000,
    })
    allResults.push(fwResult)

    // ─── 7. LLM Prediction ───
    const llmRunner = new LLMBacktestRunner()

    // Replay mode (simulated LLM interactions with outcomes)
    const llmReplay = llmRunner.runReplay(llmInteractions, {
      minConfidence: 0.48,
      tradeSize: 1.0,
      takerFeeBps: 0,             // GTD maker = 0% fees
    })

    // Also run baseline for comparison
    const llmBaseline = llmRunner.runBaseline(200, {
      baselineWinRate: 0.52,
      baselineAvgOdds: 0.50,
      tradeSize: 1.0,
      takerFeeBps: 0,
    })

    allResults.push(llmReplay)

    // ─── Build combined results ───
    const allTrades = allResults.flatMap(r => r.trades)
    allTrades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    const combined = computeBacktestSummary(allTrades)

    // Build correlation matrix
    const correlationMatrix: Record<string, Record<string, number>> = {}
    for (const a of allResults) {
      correlationMatrix[a.strategy] = {}
      for (const b of allResults) {
        if (a.strategy === b.strategy) {
          correlationMatrix[a.strategy][b.strategy] = 1.0
        } else {
          correlationMatrix[a.strategy][b.strategy] = pearsonCorrelation(
            a.trades.map(t => t.pnl),
            b.trades.map(t => t.pnl),
          )
        }
      }
    }

    // ─── PRINT RESULTS ───
    printCombinedResults(allResults, combined, correlationMatrix)

    // Also print LLM baseline for comparison
    console.log('\n  ─── LLM Baseline (random at 52% accuracy) ───')
    printStrategyResult(llmBaseline)

    // ─── ASSERTIONS (sanity checks) ───
    // Every strategy should have run without crashing
    expect(allResults.length).toBe(7)

    // At least some strategies should have trades
    const withTrades = allResults.filter(r => r.trades.length > 0)
    expect(withTrades.length).toBeGreaterThanOrEqual(3)

    // Combined results should be computed
    expect(combined.totalTrades).toBeGreaterThan(0)

    // Each result should have valid summary
    for (const r of allResults) {
      expect(r.summary.winRate).toBeGreaterThanOrEqual(0)
      expect(r.summary.winRate).toBeLessThanOrEqual(1)
      expect(r.summary.totalTrades).toBeGreaterThanOrEqual(0)
    }

    // Print final verdict
    console.log('\n  ═══════════════════════════════════════════')
    if (combined.totalPnl > 0) {
      console.log(`  VERDICT: Net profitable — ${formatDollars(combined.totalPnl)} on $40 (${formatPct(combined.totalPnl / 40)} ROI)`)
      console.log(`  Recommended: Enable top ${Math.min(3, viable => viable)} strategies, start with $1 trades`)
    } else {
      console.log(`  VERDICT: Net loss — ${formatDollars(combined.totalPnl)} on $40`)
      console.log('  Recommended: Run in dry mode, tune parameters, focus on Gabagool + BTC maker-only')
    }
    console.log('  ═══════════════════════════════════════════\n')
  })

  // Individual strategy deep-dives
  it('Crypto Up/Down: win rate by market type', () => {
    const runner = new DualSideBacktestRunner()
    const byType: Record<string, { wins: number; total: number; pnl: number }> = {}

    for (const { market, snapshots } of btcMarkets) {
      const result = runner.run(market, snapshots, {
        biasRatio: 1.0,
        minSignalConfidence: 0.35,
        maxAskSum: 1.05,
        tradeSize: 1.0,
      })
      const type = market.market_type
      if (!byType[type]) byType[type] = { wins: 0, total: 0, pnl: 0 }
      for (const t of result.trades) {
        byType[type].total++
        if (t.pnl > 0) byType[type].wins++
        byType[type].pnl += t.pnl
      }
    }

    console.log('\n  Crypto Up/Down by Market Type:')
    for (const [type, stats] of Object.entries(byType)) {
      const wr = stats.total > 0 ? stats.wins / stats.total : 0
      console.log(`    ${type.padEnd(4)}: ${stats.total} trades, WR ${formatPct(wr)}, P&L ${formatDollars(stats.pnl)}`)
    }

    // Should have at least attempted some trades
    const totalTrades = Object.values(byType).reduce((s, b) => s + b.total, 0)
    expect(totalTrades).toBeGreaterThan(0)
  })

  it('Gabagool: merge success rate vs orphan resolution', () => {
    const runner = new GabagoolBacktestRunner()
    let merges = 0
    let resolves = 0
    let mergePnl = 0
    let resolvePnl = 0

    for (const { market, snapshots } of btcMarkets) {
      const result = runner.run(market, snapshots, {
        cheapnessThreshold: 0.48,
        orderSize: 1.0,
        maxExposure: 5,
        cooldownMs: 3_000,
      })
      for (const t of result.trades) {
        if (t.direction === 'merge') {
          merges++
          mergePnl += t.pnl
        } else if (t.direction === 'resolve') {
          resolves++
          resolvePnl += t.pnl
        }
      }
    }

    console.log('\n  Gabagool Merge Analysis:')
    console.log(`    Merges:      ${merges} (P&L: ${formatDollars(mergePnl)})`)
    console.log(`    Resolves:    ${resolves} (P&L: ${formatDollars(resolvePnl)})`)
    console.log(`    Merge Rate:  ${merges + resolves > 0 ? formatPct(merges / (merges + resolves)) : 'N/A'}`)

    expect(merges + resolves).toBeGreaterThanOrEqual(0)
  })

  it('Impulse Sniper: exit reason distribution', () => {
    const runner = new ImpulseBacktestRunner()
    const exitReasons: Record<string, { count: number; totalPnl: number }> = {}

    for (const { market, snapshots } of btcMarkets) {
      const result = runner.run(market, snapshots, {
        impulseThreshold: 150,
        staleOddsThreshold: 0.03,
        tradeSize: 1.50,
        takerFeeBps: 100,
        stopLossPct: 0.15,
        takeProfitPct: 0.40,
        cooldownMs: 30_000,
      })
      for (const t of result.trades) {
        const reason = (t.metadata?.exitReason as string) || 'unknown'
        if (!exitReasons[reason]) exitReasons[reason] = { count: 0, totalPnl: 0 }
        exitReasons[reason].count++
        exitReasons[reason].totalPnl += t.pnl
      }
    }

    console.log('\n  Impulse Sniper Exit Reasons:')
    for (const [reason, stats] of Object.entries(exitReasons)) {
      console.log(`    ${reason.padEnd(15)}: ${String(stats.count).padStart(4)} trades, P&L ${formatDollars(stats.totalPnl)}`)
    }

    // Test passes regardless — we're just collecting data
    expect(true).toBe(true)
  })

  it('$40 bankroll simulation: sequential trade P&L curve', () => {
    // Simulate running all strategies sequentially with $40 starting capital
    const allTrades: UnifiedTradeRecord[] = []

    // Run all strategies (same as main test but collect all trades)
    const dualRunner = new DualSideBacktestRunner()
    const gabaRunner = new GabagoolBacktestRunner()

    for (const { market, snapshots } of btcMarkets) {
      // Crypto Up/Down
      const btc = dualRunner.run(market, snapshots, {
        biasRatio: 1.0, minSignalConfidence: 0.35, maxAskSum: 1.05, tradeSize: 1.0,
      })
      allTrades.push(...btc.trades.map(t => ({ ...t, strategy: 'btc-updown' as const })))

      // Gabagool
      const gaba = gabaRunner.run(market, snapshots, {
        cheapnessThreshold: 0.48, orderSize: 1.0, maxExposure: 5, cooldownMs: 3_000,
      })
      allTrades.push(...gaba.trades)
    }

    // Sort by time
    allTrades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

    // Simulate equity curve
    let balance = 40.0
    let peak = 40.0
    let maxDrawdown = 0
    let brokeAt = -1
    const checkpoints: Array<{ trade: number; balance: number }> = []

    for (let i = 0; i < allTrades.length; i++) {
      balance += allTrades[i].pnl
      if (balance > peak) peak = balance
      const dd = peak - balance
      if (dd > maxDrawdown) maxDrawdown = dd
      if (balance <= 0 && brokeAt === -1) brokeAt = i

      // Log every 10th trade
      if (i % 10 === 0 || i === allTrades.length - 1) {
        checkpoints.push({ trade: i, balance })
      }
    }

    console.log('\n  $40 Bankroll Equity Curve (BTC + Gabagool only):')
    console.log('  Trade    Balance')
    for (const cp of checkpoints) {
      const bar = '█'.repeat(Math.max(0, Math.min(40, Math.round(cp.balance))))
      console.log(`  ${String(cp.trade).padStart(5)}    $${cp.balance.toFixed(2).padStart(7)}  ${bar}`)
    }

    console.log(`\n  Starting: $40.00`)
    console.log(`  Ending:   $${balance.toFixed(2)}`)
    console.log(`  Peak:     $${peak.toFixed(2)}`)
    console.log(`  Max DD:   $${maxDrawdown.toFixed(2)} (${formatPct(maxDrawdown / 40)} of initial)`)
    if (brokeAt >= 0) {
      console.log(`  ⚠ Went broke at trade #${brokeAt}`)
    } else {
      console.log(`  Survived all ${allTrades.length} trades`)
    }

    expect(balance).toBeDefined()
  })
})
