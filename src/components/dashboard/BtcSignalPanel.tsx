import React, { useEffect, useState } from 'react'
import { strategyManager } from '@/services/strategies'
import { btcSignalRecorder, confidenceReport, type ConfidenceRow } from '@/services/trading/BtcSignalRecorder'
import { cn } from '@/utils/cn'

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`

/**
 * BtcSignalPanel — how recorded Up/Down signals resolved, by confidence
 * level, entering each window once and holding to resolution.
 */
export const BtcSignalPanel: React.FC = () => {
  const [rows, setRows] = useState<ConfidenceRow[]>([])
  const [counts, setCounts] = useState({ total: 0, resolved: 0 })
  const [limits, setLimits] = useState({ minConfidence: 0, minEntryPrice: 0, maxEntryPrice: 1 })

  useEffect(() => {
    const tick = () => {
      const l = strategyManager.getBtcUpDownStrategy().getEntryLimits()
      setLimits(l)
      setRows(confidenceReport(btcSignalRecorder.getSamples(), undefined, { minPrice: l.minEntryPrice, maxPrice: l.maxEntryPrice }))
      setCounts(btcSignalRecorder.getCounts())
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="rounded-lg border border-agent-border/50 bg-agent-bg/40 p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-agent-green text-sm font-mono">Crypto Up/Down signals</h3>
        <div className="flex items-center gap-3 text-[10px] font-mono text-agent-text-muted">
          <span>entry at {Math.round(limits.minConfidence * 100)}% confidence</span>
          <button onClick={() => { btcSignalRecorder.clear(); setRows([]); setCounts({ total: 0, resolved: 0 }) }} className="hover:text-agent-green">
            clear samples
          </button>
        </div>
      </div>
      {counts.resolved === 0 ? (
        <p className="text-xs font-sans text-agent-text-muted">
          {counts.total === 0
            ? 'No signals recorded yet. The Up/Down strategy records every signal it computes, in dry run too.'
            : `${counts.total} signals recorded; results appear when their windows end.`}
        </p>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-agent-text-muted text-left">
              <th className="font-normal py-1">Confidence at least</th>
              <th className="font-normal text-right">Windows</th>
              <th className="font-normal text-right">Won</th>
              <th className="font-normal text-right">Avg entry price</th>
              <th className="font-normal text-right">Avg after fees</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.minConfidence} className={cn(Math.abs(row.minConfidence - limits.minConfidence) < 1e-9 && 'text-agent-cyan')}>
                <td className="py-0.5">{Math.round(row.minConfidence * 100)}%</td>
                <td className="text-right">{row.n}</td>
                <td className="text-right">{row.n ? `${Math.round(row.winRate * 100)}%` : '—'}</td>
                <td className="text-right">{row.n ? `${Math.round(row.avgPrice * 100)}¢` : '—'}</td>
                <td className={cn('text-right', row.n > 0 && (row.avgNet > 0 ? 'text-agent-green' : 'text-agent-orange'))}>{row.n ? pct(row.avgNet) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-agent-text-muted text-[11px] font-sans mt-2">
        Each window is entered once, at its first signal at or above the confidence and inside your entry-price limits ({Math.round(limits.minEntryPrice * 100)}¢–{Math.round(limits.maxEntryPrice * 100)}¢), then held to resolution with the taker fee on entry. Winners are judged from the bot's own spot price just after the window ends, which can differ from the exchange's settlement on a near-tie. Signals are recorded before the optional LLM check ({counts.resolved} of {counts.total} have a result).
      </p>
    </div>
  )
}
