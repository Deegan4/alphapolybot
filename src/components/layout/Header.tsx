import React, { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useWalletStore, useSettingsStore } from '@/stores'
import { strategyManager } from '@/services/strategies'
import { MatrixBadge } from '@/components/ui'
import { cn } from '@/utils/cn'

/**
 * Header - Glass header with gradient border and breathing live indicator
 */
export const Header: React.FC = () => {
  const { isConnected, syncBalances } = useWalletStore()
  const { dryRun, pennyTraderMode } = useSettingsStore()
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
  // Fire immediately on connect, then every 30s
  useEffect(() => {
    if (!isConnected) return
    syncBalances()
    const interval = setInterval(syncBalances, 30000)
    return () => clearInterval(interval)
  }, [isConnected, syncBalances])

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: true,
      hour: 'numeric',
      minute: '2-digit',
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
    <header className="h-14 bg-matrix-card/80 backdrop-blur-sm flex items-center justify-between px-4 relative">
      {/* Gradient bottom border */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-matrix-primary/50 to-transparent" />

      {/* Left - Status */}
      <div className="flex items-center gap-4">
        {/* DRY RUN / LIVE Badge */}
        {dryRun ? (
          <MatrixBadge variant="info" size="sm">
            DRY RUN
          </MatrixBadge>
        ) : (
          <MatrixBadge variant="danger" size="sm" pulse>
            LIVE
          </MatrixBadge>
        )}

        {pennyTraderMode && (
          <MatrixBadge variant="warning" size="sm">PENNY</MatrixBadge>
        )}

        <div className="flex items-center gap-2">
          <span className="text-matrix-text-muted font-sans text-sm">Status:</span>
          {isConnected ? (
            <MatrixBadge variant="success" pulse>ONLINE</MatrixBadge>
          ) : (
            <MatrixBadge variant="danger">OFFLINE</MatrixBadge>
          )}
        </div>

        {activeStrategies.length > 0 && (
          <motion.div className="flex items-center gap-2" layout>
            <span className="text-matrix-text-muted font-sans text-sm">Active:</span>
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
          </motion.div>
        )}
      </div>

      {/* Center - Live indicator */}
      <div className="flex items-center gap-2">
        <motion.div
          className={cn(
            'w-2 h-2 rounded-full',
            isConnected ? 'bg-matrix-primary' : 'bg-matrix-border'
          )}
          animate={isConnected ? {
            boxShadow: ['0 0 4px #00ff00', '0 0 12px #00ff00', '0 0 4px #00ff00'],
          } : {}}
          transition={{ duration: 2, repeat: Infinity }}
        />
        <span className="text-matrix-text-secondary text-sm font-mono">
          {isConnected ? (dryRun ? 'SIMULATING' : 'LIVE') : 'DISCONNECTED'}
        </span>
      </div>

      {/* Right - Clock */}
      <div className="flex items-center gap-4 text-right">
        <div>
          <div className="text-matrix-primary font-mono text-sm font-bold tabular-nums terminal-text">
            {formatTime(time)}
          </div>
          <div className="text-matrix-text-muted font-sans text-xs">
            {formatDate(time)}
          </div>
        </div>
        <div className="text-matrix-cyan/30 text-lg">◇</div>
      </div>
    </header>
  )
}

export default Header
