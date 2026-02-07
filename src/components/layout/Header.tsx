import React, { useEffect, useState } from 'react'
import { useWalletStore, useSettingsStore } from '@/stores'
import { strategyManager } from '@/services/strategies'
import { MatrixBadge } from '@/components/ui'
import { cn } from '@/utils/cn'

/**
 * Header - Top navigation bar
 */
export const Header: React.FC = () => {
  const { isConnected, syncBalances } = useWalletStore()
  const { dryRun } = useSettingsStore()
  const [time, setTime] = useState(new Date())
  const [strategies, setStrategies] = useState(strategyManager.getStates())

  // Update clock
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Subscribe to strategy updates
  useEffect(() => {
    return strategyManager.subscribe(setStrategies)
  }, [])

  // Refresh balances periodically when connected
  useEffect(() => {
    if (!isConnected) return
    const interval = setInterval(syncBalances, 30000)
    return () => clearInterval(interval)
  }, [isConnected, syncBalances])

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  }

  const activeStrategies = strategies.filter(s => s.enabled)

  return (
    <header className="h-14 bg-matrix-card border-b border-matrix-border flex items-center justify-between px-4">
      {/* Left - Status */}
      <div className="flex items-center gap-4">
        {/* DRY RUN / LIVE Badge - Always visible */}
        {dryRun ? (
          <MatrixBadge variant="info" size="sm" className="animate-pulse">
            🧪 DRY RUN
          </MatrixBadge>
        ) : (
          <MatrixBadge variant="danger" size="sm" pulse>
            🔴 LIVE
          </MatrixBadge>
        )}

        <div className="flex items-center gap-2">
          <span className="text-matrix-text-secondary text-sm">Status:</span>
          {isConnected ? (
            <MatrixBadge variant="success" pulse>ONLINE</MatrixBadge>
          ) : (
            <MatrixBadge variant="danger">OFFLINE</MatrixBadge>
          )}
        </div>

        {activeStrategies.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-matrix-text-secondary text-sm">Active:</span>
            {activeStrategies.map(s => (
              <MatrixBadge
                key={s.name}
                variant={s.status === 'running' ? 'success' : 'warning'}
                size="sm"
                pulse={s.status === 'running'}
              >
                {s.name}
              </MatrixBadge>
            ))}
          </div>
        )}
      </div>

      {/* Center - Live indicator */}
      <div className="flex items-center gap-2">
        <div className={cn(
          'w-2 h-2 rounded-full',
          isConnected ? 'bg-matrix-primary animate-pulse' : 'bg-matrix-border'
        )} />
        <span className="text-matrix-text-secondary text-sm font-mono">
          {isConnected ? (dryRun ? 'SIMULATING' : 'LIVE') : 'DISCONNECTED'}
        </span>
      </div>

      {/* Right - Clock */}
      <div className="flex items-center gap-4 text-right">
        <div>
          <div className="text-matrix-primary font-mono text-sm font-bold">
            {formatTime(time)}
          </div>
          <div className="text-matrix-text-secondary text-xs">
            {formatDate(time)}
          </div>
        </div>
        <div className="text-matrix-primary/50 text-lg">◇</div>
      </div>
    </header>
  )
}

export default Header
