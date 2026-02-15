import React, { useRef, useState, useEffect } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { useWalletStore } from '@/stores'
import { useBalanceHistoryStore } from '@/stores/balanceHistoryStore'
import { tradeLogger, positionLifecycleManager } from '@/services/trading'
import type { BacktestSummary } from '@/services/trading/TradeLogger'

export const PortfolioPanel: React.FC = () => {
  const balance = useWalletStore((s) => s.usdcBalance)
  const snapshots = useBalanceHistoryStore((s) => s.snapshots)
  const initialBalance = useBalanceHistoryStore((s) => s.initialBalance)
  const simulatedBalance = useBalanceHistoryStore((s) => s.simulatedBalance)
  const [summary, setSummary] = useState<BacktestSummary>(tradeLogger.getSummary())
  const [unrealizedPnl, setUnrealizedPnl] = useState(0)

  useEffect(() => {
    const tick = () => {
      setSummary(tradeLogger.getSummary())
      setUnrealizedPnl(positionLifecycleManager.getUnrealizedPnl().totalUsd)
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  const displayBalance = simulatedBalance > 0 ? simulatedBalance : balance
  // Total PnL = realized (closed trades) + unrealized (open positions)
  const todayPnl = summary.totalPnlUSD + unrealizedPnl

  const data = snapshots.map((s) => ({
    time: s.timestamp,
    balance: s.balance,
  }))

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Portfolio Value card */}
      <div className="bg-agent-card border border-agent-border rounded-lg p-4 gradient-border">
        <div className="text-xs uppercase tracking-wider text-agent-text-muted font-sans font-medium mb-1">
          Portfolio Value
        </div>
        <div className="text-3xl font-mono font-bold text-agent-text">
          ${displayBalance.toFixed(2)}
        </div>
        <div className={`text-sm font-mono mt-1 ${todayPnl >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
          {todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)} today
        </div>
      </div>

      {/* Equity Curve card */}
      <div className="bg-agent-card border border-agent-border rounded-lg p-4 flex-1 flex flex-col min-h-0">
        <div className="text-xs uppercase tracking-wider text-agent-text-muted font-sans font-medium mb-2">
          Equity Curve
        </div>

        <ChartContainer>
          {(w, h) =>
            data.length < 2 ? (
              <div className="h-full flex items-center justify-center text-agent-text-label text-sm font-mono">
                Collecting data...
              </div>
            ) : (
              <ResponsiveContainer width={w} height={h}>
                <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                  <XAxis
                    dataKey="time"
                    tickFormatter={formatTime}
                    stroke="#1a1f2e"
                    tick={{ fill: '#8b949e', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={40}
                  />
                  <YAxis
                    stroke="#1a1f2e"
                    tick={{ fill: '#8b949e', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                    width={40}
                  />
                  {initialBalance > 0 && (
                    <ReferenceLine
                      y={initialBalance}
                      stroke="#8b949e"
                      strokeDasharray="4 4"
                      strokeWidth={1}
                    />
                  )}
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0d1117',
                      border: '1px solid #1a1f2e',
                      borderRadius: '8px',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: '12px',
                    }}
                    labelFormatter={(ts: number) => {
                      const d = new Date(ts)
                      return d.toLocaleString(undefined, {
                        month: 'short', day: 'numeric',
                        hour: '2-digit', minute: '2-digit', hour12: false,
                      })
                    }}
                    formatter={(value: number) => [`$${value.toFixed(2)}`, 'Balance']}
                    labelStyle={{ color: '#8b949e' }}
                    itemStyle={{ color: '#22c55e' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="balance"
                    stroke="#22c55e"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={{ r: 3, fill: '#22c55e', stroke: '#0d1117', strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )
          }
        </ChartContainer>
      </div>

      {/* Quick stats */}
      <div className="bg-agent-card border border-agent-border rounded-lg p-3.5">
        <div className="grid grid-cols-2 gap-3 text-sm font-mono">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans">Win Rate</div>
            <div className={`font-semibold ${summary.winRate >= 0.5 ? 'text-agent-green' : summary.totalTrades > 0 ? 'text-agent-red' : 'text-agent-text'}`}>
              {summary.totalTrades > 0 ? `${Math.round(summary.winRate * 100)}%` : '--'}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans">Trades</div>
            <div className="font-semibold text-agent-text">{summary.totalTrades}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans">Avg P&L</div>
            <div className={`font-semibold ${summary.avgPnlPerTrade >= 0 ? 'text-agent-green' : 'text-agent-red'}`}>
              {summary.totalTrades > 0 ? `${summary.avgPnlPerTrade >= 0 ? '+' : ''}$${summary.avgPnlPerTrade.toFixed(2)}` : '--'}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-agent-text-muted font-sans">Max DD</div>
            <div className="font-semibold text-agent-red">
              {summary.maxDrawdownPercent > 0 ? `-${summary.maxDrawdownPercent.toFixed(1)}%` : '--'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Measures its own size via ResizeObserver, only renders children once dimensions are positive. */
const ChartContainer: React.FC<{ children: (w: number, h: number) => React.ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setSize({ w: Math.floor(width), h: Math.floor(height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={ref} className="flex-1 min-h-0" style={{ minHeight: 100 }}>
      {size.w > 0 && size.h > 0 ? children(size.w, size.h) : null}
    </div>
  )
}
