import React, { useState, useEffect, useRef } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
} from 'recharts'
import { tradeLogger } from '@/services/trading'
import { edgeTracker, type StrategyEdge } from '@/services/trading/EdgeTracker'
import type { BacktestSummary } from '@/services/trading/TradeLogger'

const STRATEGY_LABELS: Record<string, string> = {
  llm: 'LLM Predict',
  dip: 'Dip Arb',
  fw: 'ProjectFW',
  btc: 'BTC Up/Down',
  micro: 'Micro Mom.',
  mr: 'Mean Rev.',
}

/** Edge health indicator */
function EdgeBadge({ edge }: { edge: StrategyEdge }) {
  if (edge.sampleSize === 0) return <span className="text-agent-text-muted text-[10px]">—</span>
  if (!edge.isReliable) return <span className="text-yellow-400 text-[10px]">⏳ {edge.sampleSize}/20</span>
  // After fees (~2% round-trip for standard, 10% for crypto), is edge positive?
  const edgeAfterFees = (2 * edge.winRate - 1) - 0.02
  if (edgeAfterFees > 0) return <span className="text-agent-green text-[10px]">✓ Edge</span>
  return <span className="text-agent-red text-[10px]">✗ No Edge</span>
}

export const PerformancePanel: React.FC = () => {
  const [summary, setSummary] = useState<BacktestSummary>(tradeLogger.getSummary())
  const [edges, setEdges] = useState<Record<string, StrategyEdge>>({})
  const [cumulativePnl, setCumulativePnl] = useState<{ time: string; pnl: number }[]>([])

  useEffect(() => {
    const refresh = () => {
      const s = tradeLogger.getSummary()
      setSummary(s)
      setEdges(edgeTracker.getAllEdges())

      // Build cumulative P&L curve from closed trades
      const records = tradeLogger
        .getRecords()
        .filter(r => r.exitTimestamp)
        .sort((a, b) => a.timestamp - b.timestamp)

      let cum = 0
      const points = records.map(r => {
        cum += r.pnlUSD ?? 0
        const d = new Date(r.exitTimestamp!)
        return {
          time: `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
          pnl: Math.round(cum * 100) / 100,
        }
      })
      setCumulativePnl(points)
    }
    refresh()
    const id = setInterval(refresh, 10_000)
    return () => clearInterval(id)
  }, [])

  const hasData = summary.totalTrades > 0
  const strategyKeys = Object.keys(summary.byStrategy).filter(k => summary.byStrategy[k].trades > 0)

  return (
    <div className="card-base p-4 gradient-border flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wider text-agent-text-muted font-sans font-medium">
          Performance
        </h3>
        <span className="text-[10px] font-mono text-agent-text-muted">
          {summary.totalTrades} closed trade{summary.totalTrades !== 1 ? 's' : ''}
        </span>
      </div>

      {!hasData ? (
        <div className="text-center py-6 text-agent-text-muted text-xs font-mono">
          No closed trades yet — performance data will appear here
        </div>
      ) : (
        <>
          {/* Headline stats row */}
          <div className="grid grid-cols-4 gap-2">
            <StatCell
              label="Total P&L"
              value={`${summary.totalPnlUSD >= 0 ? '+' : ''}$${summary.totalPnlUSD.toFixed(2)}`}
              color={summary.totalPnlUSD >= 0 ? 'text-agent-green' : 'text-agent-red'}
            />
            <StatCell
              label="Win Rate"
              value={`${(summary.winRate * 100).toFixed(1)}%`}
              color={summary.winRate >= 0.52 ? 'text-agent-green' : summary.winRate >= 0.48 ? 'text-yellow-400' : 'text-agent-red'}
            />
            <StatCell
              label="Sharpe"
              value={summary.sharpeRatio != null ? summary.sharpeRatio.toFixed(2) : '—'}
              color={
                summary.sharpeRatio == null ? 'text-agent-text-muted'
                : summary.sharpeRatio > 1 ? 'text-agent-green'
                : summary.sharpeRatio > 0 ? 'text-yellow-400'
                : 'text-agent-red'
              }
            />
            <StatCell
              label="Max DD"
              value={`${(summary.maxDrawdownPercent * 100).toFixed(1)}%`}
              color={summary.maxDrawdownPercent < 0.1 ? 'text-agent-green' : summary.maxDrawdownPercent < 0.25 ? 'text-yellow-400' : 'text-agent-red'}
            />
          </div>

          {/* Cumulative P&L chart */}
          {cumulativePnl.length >= 2 && (
            <PnlChartContainer>
                <LineChart data={cumulativePnl} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                  <XAxis dataKey="time" hide />
                  <YAxis hide domain={['auto', 'auto']} />
                  <ReferenceLine y={0} stroke="#334155" strokeDasharray="3 3" />
                  <Tooltip
                    contentStyle={{ background: 'rgba(10, 15, 10, 0.8)', backdropFilter: 'blur(16px)', border: '1px solid rgba(34, 197, 94, 0.1)', borderRadius: '12px', fontSize: 11, fontFamily: 'monospace' }}
                    labelStyle={{ color: '#6ee7b7' }}
                    formatter={(v: number) => [`$${v.toFixed(2)}`, 'P&L']}
                  />
                  <Line
                    type="monotone"
                    dataKey="pnl"
                    stroke={cumulativePnl[cumulativePnl.length - 1]?.pnl >= 0 ? '#22c55e' : '#ef4444'}
                    strokeWidth={1.5}
                    dot={false}
                  />
                </LineChart>
            </PnlChartContainer>
          )}

          {/* Per-strategy table */}
          {strategyKeys.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="text-agent-text-muted border-b border-agent-border">
                    <th className="text-left py-1 font-normal">Strategy</th>
                    <th className="text-right py-1 font-normal">Trades</th>
                    <th className="text-right py-1 font-normal">Win%</th>
                    <th className="text-right py-1 font-normal">Avg P&L</th>
                    <th className="text-right py-1 font-normal">Total</th>
                    <th className="text-right py-1 font-normal">Edge</th>
                  </tr>
                </thead>
                <tbody>
                  {strategyKeys.map(key => {
                    const s = summary.byStrategy[key]
                    const edge = edges[key]
                    return (
                      <tr key={key} className="border-b border-agent-border/30 hover:bg-agent-border/10">
                        <td className="py-1 text-agent-text">{STRATEGY_LABELS[key] ?? key}</td>
                        <td className="py-1 text-right text-agent-text">{s.trades}</td>
                        <td className={`py-1 text-right ${s.winRate >= 0.52 ? 'text-agent-green' : s.winRate >= 0.48 ? 'text-yellow-400' : 'text-agent-red'}`}>
                          {(s.winRate * 100).toFixed(0)}%
                        </td>
                        <td className={`py-1 text-right ${s.avgPnl >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
                          {s.avgPnl >= 0 ? '+' : ''}{s.avgPnl.toFixed(2)}
                        </td>
                        <td className={`py-1 text-right ${s.totalPnl >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
                          {s.totalPnl >= 0 ? '+' : ''}${s.totalPnl.toFixed(2)}
                        </td>
                        <td className="py-1 text-right">
                          {edge ? <EdgeBadge edge={edge} /> : <span className="text-agent-text-muted">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Defers Recharts render until the container has positive dimensions */
function PnlChartContainer({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [hasSize, setHasSize] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const { width: w, height: h } = e.contentRect
      setHasSize(w > 0 && h > 0)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className="h-[100px] w-full">
      {hasSize && (
        <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
          {children as React.ReactElement}
        </ResponsiveContainer>
      )}
    </div>
  )
}

/** Compact stat cell for the headline row */
function StatCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="text-center">
      <div className="text-[10px] text-agent-text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-mono font-bold ${color}`}>{value}</div>
    </div>
  )
}
