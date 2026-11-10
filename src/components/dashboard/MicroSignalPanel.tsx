import React, { useEffect, useState } from 'react'
import { strategyManager } from '@/services/strategies'
import type { LiveSignalRow } from '@/services/strategies/MicrostructureMomentumStrategy'
import {
  signalRecorder, thresholdReport, exitRuleReport, suggestThreshold, samplesToCsv,
  SIGNAL_HORIZON_MS, MIN_TRADES_TO_SUGGEST, type ThresholdRow, type ExitRules,
} from '@/services/trading/SignalRecorder'
import { useSettingsStore } from '@/stores'
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
      setCounts(signalRecorder.getCounts())
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  const setMicroMinCompositeSignal = useSettingsStore((st) => st.setMicroMinCompositeSignal)
  const holdMin = Math.round(SIGNAL_HORIZON_MS / 60_000)
  const shown = mode === 'exits' ? exitReport : report
  const suggestion = suggestThreshold(exitReport)

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
            onClick={() => { signalRecorder.clear(); setReport([]); setExitReport([]); setCounts({ total: 0, resolved: 0 }) }}
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
          {suggestion ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-agent-text">
                Best so far: ±{suggestion.threshold.toFixed(1)} ({pct(suggestion.avgNet)} average after fees over {suggestion.n} simulated trades).
              </span>
              {Math.abs(suggestion.threshold - threshold) > 1e-9 ? (
                <button
                  onClick={() => { setMicroMinCompositeSignal(suggestion.threshold); setThreshold(suggestion.threshold) }}
                  className="text-[10px] font-mono font-bold text-agent-cyan border border-agent-cyan/30 hover:bg-agent-cyan/10 rounded px-2 py-0.5"
                >
                  Apply ±{suggestion.threshold.toFixed(1)}
                </button>
              ) : (
                <span className="text-agent-text-muted">Already in use.</span>
              )}
            </div>
          ) : (
            <span className="text-agent-text-muted">
              No suggestion yet: a threshold needs at least {MIN_TRADES_TO_SUGGEST} simulated trades and a positive average after fees.
            </span>
          )}
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
