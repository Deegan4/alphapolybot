import React, { useEffect, useState } from 'react'
import { positionLifecycleManager } from '@/services/trading'
import type { PositionStatus } from '@/services/trading/PositionLifecycleManager'

export const ActivePositionsCard: React.FC = () => {
  const [positions, setPositions] = useState<PositionStatus[]>([])

  useEffect(() => {
    const tick = () => setPositions(positionLifecycleManager.getPositions())
    tick()
    const id = setInterval(tick, 2000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="bg-agent-card border border-agent-border rounded-sm p-3 flex flex-col min-h-0">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm">&#127919;</span>
        <span className="text-[10px] uppercase tracking-wider text-agent-text-muted font-mono">
          Active Positions
        </span>
        {positions.length > 0 && (
          <span className="text-[10px] font-mono text-agent-green bg-agent-green/10 px-1.5 py-0.5 rounded-full">
            {positions.length}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-1.5 min-h-0">
        {positions.length === 0 ? (
          <div className="h-full flex items-center justify-center text-agent-text-label text-xs font-mono text-center px-4">
            No active positions — waiting for edge signal...
          </div>
        ) : (
          positions.map((pos) => {
            const holdMins = Math.round((Date.now() - pos.entryTime) / 60_000)

            return (
              <div
                key={pos.tokenId}
                className="flex items-center justify-between bg-agent-elevated/50 rounded px-2.5 py-1.5"
              >
                <div className="flex flex-col">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] font-mono text-agent-text truncate max-w-[140px]">
                      {pos.outcome || pos.tokenId.slice(0, 8)}
                    </span>
                    {pos.isStale && (
                      <span className="text-[8px] font-mono text-agent-orange bg-agent-orange/10 px-1 rounded" title="No live price data">
                        STALE
                      </span>
                    )}
                  </div>
                  <span className="text-[9px] font-mono text-agent-text-muted">
                    {holdMins < 60 ? `${holdMins}m` : `${(holdMins / 60).toFixed(1)}h`} · ${pos.entryPrice.toFixed(3)}
                  </span>
                </div>
                <div className="text-right">
                  <div
                    className={`text-[10px] font-mono font-semibold ${
                      pos.isStale ? 'text-agent-text-muted' : pos.pnlPercent >= 0 ? 'text-agent-green' : 'text-agent-red'
                    }`}
                  >
                    {pos.isStale ? '--' : `${pos.pnlPercent >= 0 ? '+' : ''}${(pos.pnlPercent * 100).toFixed(1)}%`}
                  </div>
                  <div
                    className={`text-[9px] font-mono ${
                      pos.isStale ? 'text-agent-text-muted' : pos.pnlUsd >= 0 ? 'text-agent-green' : 'text-agent-red'
                    }`}
                  >
                    {pos.isStale ? '--' : `${pos.pnlUsd >= 0 ? '+' : ''}$${pos.pnlUsd.toFixed(2)}`}
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
