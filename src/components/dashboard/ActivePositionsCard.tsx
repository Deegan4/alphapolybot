import React, { useEffect, useState } from 'react'
import { positionLifecycleManager } from '@/services/trading'
import type { PositionStatus } from '@/services/trading/PositionLifecycleManager'

export const ActivePositionsCard: React.FC = () => {
  const [positions, setPositions] = useState<PositionStatus[]>([])
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set())
  const [confirmAction, setConfirmAction] = useState<{ slug: string; type: 'close' | 'abandon' } | null>(null)
  const [confirmBulk, setConfirmBulk] = useState<'closeAll' | 'cleanStale' | null>(null)

  useEffect(() => {
    const tick = () => setPositions(positionLifecycleManager.getPositions())
    tick()
    const id = setInterval(tick, 2000)
    return () => clearInterval(id)
  }, [])

  const staleCount = positions.filter(p => p.isStale).length

  const handleClose = async (slug: string) => {
    setConfirmAction(null)
    setClosingIds(prev => new Set(prev).add(slug))
    try {
      await positionLifecycleManager.forceClosePosition(slug)
    } finally {
      setClosingIds(prev => { const next = new Set(prev); next.delete(slug); return next })
    }
  }

  const handleAbandon = (slug: string) => {
    setConfirmAction(null)
    positionLifecycleManager.abandonPosition(slug)
  }

  const handleCloseAll = async () => {
    setConfirmBulk(null)
    const ids = positions.map(p => p.marketSlug)
    setClosingIds(new Set(ids))
    try {
      await positionLifecycleManager.forceCloseAll()
    } finally {
      setClosingIds(new Set())
    }
  }

  const handleCleanStale = () => {
    setConfirmBulk(null)
    for (const p of positions.filter(p => p.isStale)) {
      positionLifecycleManager.abandonPosition(p.marketSlug)
    }
  }

  return (
    <div className="card-base p-4 flex flex-col min-h-0">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm">&#127919;</span>
        <span className="text-xs uppercase tracking-wider text-agent-text-muted font-sans font-medium">
          Active Positions
        </span>
        {positions.length > 0 && (
          <span className="text-xs font-mono text-agent-green bg-agent-green/10 px-2 py-0.5 rounded-full">
            {positions.length}
          </span>
        )}

        {/* Bulk actions */}
        {positions.length > 0 && (
          <div className="flex items-center gap-1.5 ml-auto">
            {confirmBulk ? (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-agent-red font-mono">
                  {confirmBulk === 'closeAll' ? 'Sell all?' : `Drop ${staleCount} stale?`}
                </span>
                <button
                  onClick={confirmBulk === 'closeAll' ? handleCloseAll : handleCleanStale}
                  className="text-[10px] font-mono font-bold text-white bg-agent-red/80 hover:bg-agent-red px-1.5 py-0.5 rounded"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmBulk(null)}
                  className="text-[10px] font-mono text-agent-text-muted hover:text-agent-text px-1 py-0.5"
                >
                  No
                </button>
              </div>
            ) : (
              <>
                {staleCount > 0 && (
                  <button
                    onClick={() => setConfirmBulk('cleanStale')}
                    className="text-[10px] font-mono text-agent-orange border border-agent-orange/30 px-1.5 py-0.5 rounded hover:bg-agent-orange/10 transition-colors"
                    title="Abandon all stale positions (write off)"
                  >
                    Clean {staleCount} Stale
                  </button>
                )}
                <button
                  onClick={() => setConfirmBulk('closeAll')}
                  className="text-[10px] font-mono text-agent-red border border-agent-red/30 px-1.5 py-0.5 rounded hover:bg-agent-red/10 transition-colors"
                  title="Force sell all positions"
                >
                  Close All
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
        {positions.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-2">
            <span className="text-2xl opacity-30">&#127919;</span>
            <span className="text-sm font-sans text-agent-text-label">No active positions</span>
            <span className="text-xs font-sans text-agent-text-label/60">Waiting for edge signal...</span>
          </div>
        ) : (
          positions.map((pos) => {
            const holdMins = Math.round((Date.now() - pos.entryTime) / 60_000)
            const action = confirmAction && confirmAction.slug === pos.marketSlug ? confirmAction : null

            return (
              <div
                key={pos.marketSlug}
                className="group flex items-center justify-between bg-agent-elevated/40 rounded-md px-3 py-2 transition-colors hover:bg-agent-elevated/60"
              >
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-sm font-mono text-agent-text truncate max-w-[140px]">
                      {pos.outcome || pos.marketSlug.slice(0, 8)}
                    </span>
                    <span className="text-[10px] font-mono text-agent-cyan/50 px-1">
                      {pos.strategy?.toUpperCase() || '?'}
                    </span>
                    {pos.isStale && (
                      <span className="text-[10px] font-mono text-agent-orange bg-agent-orange/10 px-1 rounded" title="No live price data">
                        STALE
                      </span>
                    )}
                  </div>
                  <span className="text-xs font-sans text-agent-text-muted">
                    {holdMins < 60 ? `${holdMins}m` : `${(holdMins / 60).toFixed(1)}h`} · {pos.size.toFixed(1)} shares @ {(pos.entryPrice * 100).toFixed(1)}¢
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {/* PnL display */}
                  <div className="text-right">
                    <div className="text-[11px] font-mono text-agent-text-muted">
                      ${(pos.size * pos.currentPrice).toFixed(2)}
                    </div>
                    <div
                      className={`text-xs font-mono font-semibold ${
                        pos.isStale
                          ? (pos.pnlPercent >= 0 ? 'text-agent-green/50' : 'text-agent-red/50')
                          : (pos.pnlPercent >= 0 ? 'text-agent-green' : 'text-agent-red')
                      }`}
                    >
                      {pos.pnlPercent >= 0 ? '+' : ''}{(pos.pnlPercent * 100).toFixed(1)}%
                    </div>
                    <div
                      className={`text-[11px] font-mono ${
                        pos.isStale
                          ? (pos.pnlUsd >= 0 ? 'text-agent-green/50' : 'text-agent-red/50')
                          : (pos.pnlUsd >= 0 ? 'text-agent-green' : 'text-agent-red')
                      }`}
                    >
                      {pos.pnlUsd >= 0 ? '+' : ''}${pos.pnlUsd.toFixed(2)}
                    </div>
                  </div>

                  {/* Per-position actions */}
                  <div className="flex flex-col items-end gap-0.5 w-12">
                    {action ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => action.type === 'close'
                            ? handleClose(pos.marketSlug)
                            : handleAbandon(pos.marketSlug)}
                          className="text-[9px] font-mono font-bold text-white bg-agent-red/80 hover:bg-agent-red px-1 py-0.5 rounded"
                        >
                          {action.type === 'close' ? 'Sell' : 'Drop'}
                        </button>
                        <button
                          onClick={() => setConfirmAction(null)}
                          className="text-[9px] font-mono text-agent-text-muted hover:text-agent-text px-0.5 py-0.5"
                        >
                          X
                        </button>
                      </div>
                    ) : closingIds.has(pos.marketSlug) ? (
                      <span className="text-[9px] font-mono text-agent-orange animate-pulse">Selling...</span>
                    ) : (
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => setConfirmAction({ slug: pos.marketSlug, type: 'close' })}
                          className="text-[9px] font-mono text-agent-red hover:text-red-300 px-1 py-0.5 rounded hover:bg-agent-red/10"
                          title="Force sell this position"
                        >
                          Close
                        </button>
                        <button
                          onClick={() => setConfirmAction({ slug: pos.marketSlug, type: 'abandon' })}
                          className="text-[9px] font-mono text-agent-orange hover:text-orange-300 px-1 py-0.5 rounded hover:bg-agent-orange/10"
                          title="Remove without selling (write off)"
                        >
                          Drop
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
