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
        .slice(0, 8)
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
    <div className="card-base px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs uppercase tracking-wider text-agent-text-muted font-sans font-medium">
          Recent Trades
        </span>
        {trades.length > 0 && (
          <span className="text-xs font-mono text-agent-text-muted bg-agent-elevated/40 px-1.5 py-0.5 rounded-full">
            {trades.length}
          </span>
        )}
      </div>

      {trades.length === 0 ? (
        <div className="text-center py-2">
          <span className="text-xs font-sans text-agent-text-label/60">No closed trades yet</span>
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-0.5">
          {trades.map((t) => {
            const isWin = (t.pnlUSD ?? 0) >= 0
            return (
              <div
                key={t.id}
                className={`flex-shrink-0 rounded-md px-3 py-2 border transition-colors min-w-[130px] ${
                  isWin
                    ? 'bg-agent-green/5 border-agent-green/20'
                    : 'bg-agent-red/5 border-agent-red/20'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
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
                <span className="text-[10px] font-sans text-agent-text-muted mt-0.5 block">
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
