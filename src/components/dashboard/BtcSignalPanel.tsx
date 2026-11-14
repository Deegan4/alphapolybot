import React, { useEffect, useState } from 'react'
import { strategyManager } from '@/services/strategies'
import {
  btcSignalRecorder, confidenceReport, confidenceHoldout, MIN_WINDOWS_TO_SUGGEST, MIN_HOLDOUT_WINDOWS,
  type ConfidenceRow, type ConfidenceHoldout,
} from '@/services/trading/BtcSignalRecorder'
import { useSettingsStore } from '@/stores'
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
  const [holdout, setHoldout] = useState<ConfidenceHoldout | null>(null)
  const [sources, setSources] = useState({ exchange: 0, spot: 0, disagreed: 0 })
  const setBtcMinConfidence = useSettingsStore((st) => st.setBtcMinConfidence)

  useEffect(() => {
    const tick = () => {
      const l = strategyManager.getBtcUpDownStrategy().getEntryLimits()
      setLimits(l)
      setRows(confidenceReport(btcSignalRecorder.getSamples(), undefined, { minPrice: l.minEntryPrice, maxPrice: l.maxEntryPrice }))
      setCounts(btcSignalRecorder.getCounts())
      setHoldout(confidenceHoldout(btcSignalRecorder.getSamples(), undefined, { minPrice: l.minEntryPrice, maxPrice: l.maxEntryPrice }))
      setSources(btcSignalRecorder.getSourceCounts())
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
          <button onClick={() => { btcSignalRecorder.clear(); setRows([]); setHoldout(null); setSources({ exchange: 0, spot: 0, disagreed: 0 }); setCounts({ total: 0, resolved: 0 }) }} className="hover:text-agent-green">
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
      {counts.resolved > 0 && (
        <div className="mt-2 text-xs font-sans">
          {holdout ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-agent-text">
                Best on the first two-thirds of windows: {Math.round(holdout.train.minConfidence * 100)}% ({pct(holdout.train.avgNet)} after fees over {holdout.train.n} windows).{' '}
                {holdout.test.n === 0
                  ? 'No later windows yet to check it against.'
                  : `On the later windows, which were not used to pick it: ${pct(holdout.test.avgNet)} over ${holdout.test.n}.`}
              </span>
              {!holdout.confirmed ? (
                <span className="text-agent-orange">
                  {holdout.test.n < MIN_HOLDOUT_WINDOWS ? `Needs ${MIN_HOLDOUT_WINDOWS} held-out windows before it can be applied.` : 'It did not hold up, so it is not offered.'}
                </span>
              ) : Math.abs(holdout.train.minConfidence - limits.minConfidence) > 1e-9 ? (
                <button
                  onClick={() => { setBtcMinConfidence(holdout.train.minConfidence); setLimits(l => ({ ...l, minConfidence: holdout.train.minConfidence })) }}
                  className="text-[10px] font-mono font-bold text-agent-cyan border border-agent-cyan/30 hover:bg-agent-cyan/10 rounded px-2 py-0.5"
                >
                  Apply {Math.round(holdout.train.minConfidence * 100)}%
                </button>
              ) : (
                <span className="text-agent-text-muted">Already in use.</span>
              )}
            </div>
          ) : (
            <span className="text-agent-text-muted">
              No suggestion yet: a confidence level needs at least {MIN_WINDOWS_TO_SUGGEST} windows and a positive average after fees on the first two-thirds of the data.
            </span>
          )}
        </div>
      )}
      <p className="text-agent-text-muted text-[11px] font-sans mt-2">
        Each window is entered once, at its first signal at or above the confidence and inside your entry-price limits ({Math.round(limits.minEntryPrice * 100)}¢–{Math.round(limits.maxEntryPrice * 100)}¢), then held to resolution with the taker fee on entry. Results: {sources.exchange} windows settled by the exchange, {sources.spot} provisional from the bot's spot price (replaced when the exchange settles){sources.disagreed > 0 ? `, ${sources.disagreed} where the two disagreed` : ''}. Signals are recorded before the optional LLM check ({counts.resolved} of {counts.total} have a result).
      </p>
    </div>
  )
}
