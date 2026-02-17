import React, { useEffect, useState } from 'react'
import { tradeLogger } from '@/services/trading'
import type { TradeRecord } from '@/services/trading/TradeLogger'

export const RecentTradesGrid: React.FC = () => {
  const [trades, setTrades] = useState<TradeRecord[]>([])

  useEffect(() => {
    const tick = () => {
      const records = tradeLogger.getRecords(100)
      const closed = records
        .filter((r) => r.exitTimestamp != null && r.pnlUSD != null)
        .sort((a, b) => b.exitTimestamp! - a.exitTimestamp!)
        .slice(0, 4)
      setTrades(closed)
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  const stratLabel = (r: TradeRecord): string => {
    if (r.strategy === 'btc') {
      const asset = r.question?.match(/\b(BTC|ETH|SOL)\b/i)?.[1]?.toUpperCase() ?? 'BTC'
      const dir = r.outcome?.toLowerCase().includes('up') ? 'UP' : 'DOWN'
      return `${asset} ${dir}`
    }
    if (r.strategy === 'dip') return 'DIP'
    if (r.strategy === 'fw') return 'FW'
    if (r.strategy === 'llm') return 'LLM'
    if (r.strategy === 'micro') return 'MICRO'
    return r.strategy.toUpperCase()
  }

  const timeAgo = (ts: number): string => {
    const mins = Math.round((Date.now() - ts) / 60_000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    if (mins < 1440) return `${(mins / 60).toFixed(0)}h ago`
    return `${(mins / 1440).toFixed(0)}d ago`
  }

  return (
    <div className="card-base p-4 flex flex-col min-h-0">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm">&#128200;</span>
        <span className="text-xs uppercase tracking-wider text-agent-text-muted font-sans font-medium">
          Recent Trades
        </span>
      </div>

      {trades.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 gap-2">
          <span className="text-2xl opacity-30">&#128200;</span>
          <span className="text-sm font-sans text-agent-text-label">No closed trades yet</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 flex-1 min-h-0">
          {trades.map((t) => {
            const isWin = (t.pnlUSD ?? 0) >= 0
            return (
              <div
                key={t.id}
                className={`flex flex-col justify-between rounded-md px-3 py-2.5 border transition-colors ${
                  isWin
                    ? 'bg-agent-green/5 border-agent-green/20 hover:bg-agent-green/10'
                    : 'bg-agent-red/5 border-agent-red/20 hover:bg-agent-red/10'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-sans font-semibold text-agent-text">
                    {stratLabel(t)}
                  </span>
                  <span
                    className={`text-xs font-mono font-bold tabular-nums ${
                      isWin ? 'text-agent-green' : 'text-agent-red'
                    }`}
                  >
                    {isWin ? '+' : ''}${(t.pnlUSD ?? 0).toFixed(2)}
                  </span>
                </div>
                <span className="text-xs font-sans text-agent-text-muted mt-0.5">
                  {timeAgo(t.exitTimestamp!)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
