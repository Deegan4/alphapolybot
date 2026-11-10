import React, { useEffect, useState } from 'react'
import { strategyManager } from '@/services/strategies'
import type { LiveSignalRow } from '@/services/strategies/MicrostructureMomentumStrategy'
import { signalRecorder, thresholdReport, SIGNAL_HORIZON_MS, type ThresholdRow } from '@/services/trading/SignalRecorder'
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
  const [counts, setCounts] = useState({ total: 0, resolved: 0 })

  useEffect(() => {
    const tick = () => {
      const strategy = strategyManager.getMicroMomentumStrategy()
      setRows(strategy.getLiveSignals())
      setThreshold(strategy.getEntryThreshold())
      setReport(thresholdReport(signalRecorder.getSamples()))
      setCounts(signalRecorder.getCounts())
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

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

      <div className="flex items-baseline justify-between mt-4 mb-1">
        <h4 className="text-agent-green text-xs font-mono">
          If entered at each threshold ({Math.round(SIGNAL_HORIZON_MS / 60_000)}-minute hold)
        </h4>
        <button
          onClick={() => { signalRecorder.clear(); setReport([]); setCounts({ total: 0, resolved: 0 }) }}
          className="text-[10px] font-mono text-agent-text-muted hover:text-agent-green"
        >
          clear samples
        </button>
      </div>
      {counts.resolved === 0 ? (
        <p className="text-xs font-sans text-agent-text-muted">
          {counts.total === 0
            ? 'No samples recorded yet. The strategy records every tracked market on each scan, in dry run too.'
            : `${counts.total} samples recorded; outcomes appear ${Math.round(SIGNAL_HORIZON_MS / 60_000)} minutes after each one.`}
        </p>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-agent-text-muted text-left">
              <th className="font-normal py-1">Signal at least</th>
              <th className="font-normal text-right">Samples</th>
              <th className="font-normal text-right">Profitable</th>
              <th className="font-normal text-right">Avg before fees</th>
              <th className="font-normal text-right">Avg after fees</th>
            </tr>
          </thead>
          <tbody>
            {report.map(row => (
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
      <p className="text-agent-text-muted text-[11px] font-sans mt-2">
        Returns assume buying at the ask and selling at the bid {Math.round(SIGNAL_HORIZON_MS / 60_000)} minutes later, with taker fees both ways. Samples are taken every scan and overlap, so read this as a rough guide ({counts.resolved} of {counts.total} samples have an outcome).
      </p>
    </div>
  )
}
