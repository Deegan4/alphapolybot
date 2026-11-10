import React, { useEffect, useState } from 'react'
import { strategyManager } from '@/services/strategies'
import type { LiveSignalRow } from '@/services/strategies/MicrostructureMomentumStrategy'
import {
  signalRecorder, thresholdReport, exitRuleReport, holdoutSuggestion, exitGridReport, realTradeSummary, simulateTrades, samplesToCsv,
  SIGNAL_HORIZON_MS, MIN_TRADES_TO_SUGGEST, MIN_HOLDOUT_TRADES,
  type ThresholdRow, type ExitRules, type HoldoutResult, type ExitGridCell,
} from '@/services/trading/SignalRecorder'
import { useSettingsStore } from '@/stores'
import { tradeLogger } from '@/services/trading'
import { cn } from '@/utils/cn'

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`

/**
 * MicroSignalPanel — live order-book signals for the Microstructure Momentum
 * strategy, and what entering at each signal threshold would have returned
 * (after spread and fees) over the recorded samples.
 */
export const MicroSignalPanel: React.FC = () => {
  const [rows, setRows] = useState<LiveSignalRow[]>([])
  const [threshold, setThreshold] = useState(0.4)
  const [report, setReport] = useState<ThresholdRow[]>([])
  const [exitReport, setExitReport] = useState<ThresholdRow[]>([])
  const [rules, setRules] = useState<ExitRules | null>(null)
  const [holdout, setHoldout] = useState<HoldoutResult | null>(null)
  const [grid, setGrid] = useState<ExitGridCell[][]>([])
  const [compare, setCompare] = useState<{ real: ReturnType<typeof realTradeSummary>; simN: number; simGross: number } | null>(null)
  const [mode, setMode] = useState<'exits' | 'fixed'>('exits')
  const [counts, setCounts] = useState({ total: 0, resolved: 0 })

  useEffect(() => {
    const tick = () => {
      const strategy = strategyManager.getMicroMomentumStrategy()
      setRows(strategy.getLiveSignals())
      setThreshold(strategy.getEntryThreshold())
      const samples = signalRecorder.getSamples()
      const exitRules = strategy.getExitRules()
      setReport(thresholdReport(samples))
      setExitReport(exitRuleReport(samples, exitRules))
      setRules(exitRules)
      setHoldout(holdoutSuggestion(samples, exitRules))
      const current = strategy.getEntryThreshold()
      setGrid(exitGridReport(samples, current, exitRules))
      if (samples.length > 0) {
        const since = samples.reduce((min, x) => Math.min(min, x.t), Infinity)
        const sim = simulateTrades(samples, current, exitRules)
        setCompare({
          real: realTradeSummary(tradeLogger.getRecords(), since),
          simN: sim.length,
          simGross: sim.length ? sim.reduce((sum, t) => sum + t.gross, 0) / sim.length : 0,
        })
      } else {
        setCompare(null)
      }
      setCounts(signalRecorder.getCounts())
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  const setMicroMinCompositeSignal = useSettingsStore((st) => st.setMicroMinCompositeSignal)
  const holdMin = Math.round(SIGNAL_HORIZON_MS / 60_000)
  const shown = mode === 'exits' ? exitReport : report

  const downloadCsv = () => {
    const blob = new Blob([samplesToCsv(signalRecorder.getSamples())], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `micro-signals-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-lg border border-agent-border/50 bg-agent-bg/40 p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-agent-green text-sm font-mono">Microstructure signals</h3>
        <span className="text-[10px] font-mono text-agent-text-muted">entry at ±{threshold.toFixed(2)}</span>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs font-sans text-agent-text-muted">
          No live signals. Start the Microstructure Momentum strategy; signals appear after a few order-book updates per market.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-agent-text-muted text-left">
                <th className="font-normal py-1">Market</th>
                <th className="font-normal text-right">Signal</th>
                <th className="font-normal text-right">Imbalance</th>
                <th className="font-normal text-right">Trade flow</th>
                <th className="font-normal text-right">Confidence</th>
                <th className="font-normal text-right">Depth from</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const strength = Math.abs(r.composite)
                return (
                  <tr key={r.slug}>
                    <td className="py-0.5 max-w-[16rem] truncate" title={r.question}>{r.question}</td>
                    <td className={cn('text-right', strength >= threshold ? 'text-agent-green font-bold' : strength >= threshold * 0.75 ? 'text-agent-orange' : '')}>
                      {signed(r.composite)}
                    </td>
                    <td className="text-right">{signed(r.imbalance)}</td>
                    <td className="text-right">{r.tradeFlow == null ? '—' : signed(r.tradeFlow)}</td>
                    <td className="text-right">{Math.round(r.confidence * 100)}%</td>
                    <td className="text-right text-agent-text-muted">{r.fullBook ? 'full book' : 'level counts'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2 mt-4 mb-1">
        <h4 className="text-agent-green text-xs font-mono">If entered at each threshold</h4>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <button onClick={() => setMode('exits')} className={cn(mode === 'exits' ? 'text-agent-green' : 'text-agent-text-muted hover:text-agent-green')}>
            strategy exits
          </button>
          <button onClick={() => setMode('fixed')} className={cn(mode === 'fixed' ? 'text-agent-green' : 'text-agent-text-muted hover:text-agent-green')}>
            {holdMin}-minute hold
          </button>
          <button onClick={downloadCsv} disabled={counts.total === 0} className="text-agent-text-muted hover:text-agent-green disabled:opacity-40">
            export CSV
          </button>
          <button
            onClick={() => { signalRecorder.clear(); setReport([]); setExitReport([]); setHoldout(null); setGrid([]); setCompare(null); setCounts({ total: 0, resolved: 0 }) }}
            className="text-agent-text-muted hover:text-agent-green"
          >
            clear samples
          </button>
        </div>
      </div>
      {counts.total === 0 ? (
        <p className="text-xs font-sans text-agent-text-muted">
          No samples recorded yet. The strategy records every tracked market on each scan, in dry run too.
        </p>
      ) : shown.every(r => r.n === 0) ? (
        <p className="text-xs font-sans text-agent-text-muted">
          {counts.total} samples recorded; no outcomes yet. {mode === 'exits'
            ? 'A simulated trade counts once it hits the stop-loss, take-profit or hold limit.'
            : `Outcomes appear ${holdMin} minutes after each sample.`}
        </p>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-agent-text-muted text-left">
              <th className="font-normal py-1">Signal at least</th>
              <th className="font-normal text-right">{mode === 'exits' ? 'Trades' : 'Samples'}</th>
              <th className="font-normal text-right">Profitable</th>
              <th className="font-normal text-right">Avg before fees</th>
              <th className="font-normal text-right">Avg after fees</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(row => (
              <tr key={row.threshold} className={cn(Math.abs(row.threshold - threshold) < 1e-9 && 'text-agent-cyan')}>
                <td className="py-0.5">±{row.threshold.toFixed(1)}</td>
                <td className="text-right">{row.n}</td>
                <td className="text-right">{row.n ? `${Math.round(row.winRate * 100)}%` : '—'}</td>
                <td className="text-right">{row.n ? pct(row.avgGross) : '—'}</td>
                <td className={cn('text-right', row.n > 0 && (row.avgNet > 0 ? 'text-agent-green' : 'text-agent-orange'))}>{row.n ? pct(row.avgNet) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {mode === 'exits' && counts.total > 0 && (
        <div className="mt-2 text-xs font-sans">
          {holdout ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-agent-text">
                Best on the first two-thirds of the data: ±{holdout.train.threshold.toFixed(1)} ({pct(holdout.train.avgNet)} after fees over {holdout.train.n} trades).{' '}
                {holdout.test.n === 0
                  ? 'No trades yet in the last third to check it against.'
                  : `On the last third, which was not used to pick it: ${pct(holdout.test.avgNet)} over ${holdout.test.n} trades.`}
              </span>
              {!holdout.confirmed ? (
                <span className="text-agent-orange">
                  {holdout.test.n < MIN_HOLDOUT_TRADES ? `Needs ${MIN_HOLDOUT_TRADES} held-out trades before it can be applied.` : 'It did not hold up, so it is not offered.'}
                </span>
              ) : Math.abs(holdout.train.threshold - threshold) > 1e-9 ? (
                <button
                  onClick={() => { setMicroMinCompositeSignal(holdout.train.threshold); setThreshold(holdout.train.threshold) }}
                  className="text-[10px] font-mono font-bold text-agent-cyan border border-agent-cyan/30 hover:bg-agent-cyan/10 rounded px-2 py-0.5"
                >
                  Apply ±{holdout.train.threshold.toFixed(1)}
                </button>
              ) : (
                <span className="text-agent-text-muted">Already in use.</span>
              )}
            </div>
          ) : (
            <span className="text-agent-text-muted">
              No suggestion yet: a threshold needs at least {MIN_TRADES_TO_SUGGEST} simulated trades and a positive average after fees on the first two-thirds of the data.
            </span>
          )}
        </div>
      )}

      {mode === 'exits' && compare && (compare.real.n > 0 || compare.simN > 0) && (
        <div className="mt-4">
          <h4 className="text-agent-green text-xs font-mono mb-1">Replay vs logged trades at ±{threshold.toFixed(1)} (before fees)</h4>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-agent-text-muted text-left">
                <th className="font-normal py-1">Source</th>
                <th className="font-normal text-right">Trades</th>
                <th className="font-normal text-right">Profitable</th>
                <th className="font-normal text-right">Avg return</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-0.5">Replay on recorded prices</td>
                <td className="text-right">{compare.simN}</td>
                <td className="text-right text-agent-text-muted">—</td>
                <td className="text-right">{compare.simN ? pct(compare.simGross) : '—'}</td>
              </tr>
              <tr>
                <td className="py-0.5">Logged trades{compare.real.dryRun > 0 ? ` (${compare.real.dryRun} dry run)` : ''}</td>
                <td className="text-right">{compare.real.n}</td>
                <td className="text-right">{compare.real.n ? `${Math.round(compare.real.winRate * 100)}%` : '—'}</td>
                <td className="text-right">{compare.real.n ? pct(compare.real.avgPnl) : '—'}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-agent-text-muted text-[11px] font-sans mt-1">
            The replay enters every qualifying signal; the strategy also applies its depth, trade-flow and position-limit checks, so expect fewer logged trades. A large gap in average return means the replay is not a good stand-in.
          </p>
        </div>
      )}

      {mode === 'exits' && grid.some(r => r.some(c => c.n > 0)) && (
        <div className="mt-4">
          <h4 className="text-agent-green text-xs font-mono mb-1">Stop-loss and take-profit levels at ±{threshold.toFixed(1)} (average after fees, trades)</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-agent-text-muted text-left">
                  <th className="font-normal py-1">Stop-loss</th>
                  {grid[0].map(c => (
                    <th key={c.takeProfitPercent} className="font-normal text-right">TP {Math.round(c.takeProfitPercent * 100)}%</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map(row => (
                  <tr key={row[0].stopLossPercent}>
                    <td className="py-0.5">{Math.round(row[0].stopLossPercent * 100)}%</td>
                    {row.map(c => {
                      const current = rules != null && Math.abs(c.stopLossPercent - rules.stopLossPercent) < 1e-9 && Math.abs(c.takeProfitPercent - rules.takeProfitPercent) < 1e-9
                      return (
                        <td key={c.takeProfitPercent} className={cn('text-right', current && 'underline', c.n > 0 && (c.avgNet > 0 ? 'text-agent-green' : 'text-agent-orange'))}>
                          {c.n ? `${pct(c.avgNet)} (${c.n})` : '—'}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-agent-text-muted text-[11px] font-sans mt-1">
            Your current levels are underlined when they are on the grid. This compares 20 combinations on the same data, so the best cell is partly luck; change levels in Settings only on a clear, well-sampled difference.
          </p>
        </div>
      )}

      <p className="text-agent-text-muted text-[11px] font-sans mt-2">
        {mode === 'exits' && rules
          ? `Replays the strategy's exits on the recorded prices: ${Math.round(rules.stopLossPercent * 100)}% stop-loss, ${Math.round(rules.takeProfitPercent * 100)}% take-profit, ${Math.round(rules.maxHoldMs / 60_000)}-minute limit, one trade per market at a time. Buys at the ask, sells at the bid, taker fees both ways. Prices are sampled once per scan, so fast moves between scans are missed.`
          : `Assumes buying at the ask and selling at the bid ${holdMin} minutes later, with taker fees both ways. Samples overlap, so read this as a rough guide (${counts.resolved} of ${counts.total} samples have an outcome).`}
      </p>
    </div>
  )
}
