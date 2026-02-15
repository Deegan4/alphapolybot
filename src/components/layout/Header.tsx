import React, { useEffect, useState, memo } from 'react'
import { motion } from 'framer-motion'
import { useWalletStore, useSettingsStore } from '@/stores'
import { strategyManager } from '@/services/strategies'
import { MatrixBadge } from '@/components/ui'
import { cn } from '@/utils/cn'

/**
 * HeaderClock — isolated clock component so 1s ticks don't re-render the entire header
 */
const HeaderClock = memo(() => {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const formatTime = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

  const formatDate = (date: Date) =>
    date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <div>
      <div className="text-matrix-primary font-mono text-sm font-bold tabular-nums terminal-text">
        {formatTime(time)}
      </div>
      <div className="text-matrix-text-muted font-sans text-xs">
        {formatDate(time)}
      </div>
    </div>
  )
})
HeaderClock.displayName = 'HeaderClock'

/**
 * Header - Glass header with gradient border and breathing live indicator
 */
export const Header: React.FC = () => {
  const { isConnected, startPolling, stopPolling } = useWalletStore()
  const { dryRun, pennyTraderMode } = useSettingsStore()
  const [strategies, setStrategies] = useState(strategyManager.getStates())

  // Subscribe to strategy updates
  useEffect(() => {
    return strategyManager.subscribe(setStrategies)
  }, [])

  // Start/stop centralized balance polling based on connection state
  useEffect(() => {
    if (!isConnected) return
    startPolling()
    return () => stopPolling()
  }, [isConnected, startPolling, stopPolling])

  const activeStrategies = strategies.filter(s => s.enabled)

  return (
    <header className="h-14 bg-matrix-card/80 backdrop-blur-sm flex items-center justify-between px-4 relative">
      {/* Gradient bottom border */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-matrix-primary/50 to-transparent" />

      {/* Left - Status */}
      <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto hide-scrollbar">
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
          <span className="text-matrix-text-muted font-sans text-sm hidden sm:inline">Status:</span>
          {isConnected ? (
            <MatrixBadge variant="success" pulse>ONLINE</MatrixBadge>
          ) : (
            <MatrixBadge variant="danger">OFFLINE</MatrixBadge>
          )}
        </div>

        {activeStrategies.length > 0 && (
          <motion.div className="hidden md:flex items-center gap-2" layout>
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
        <HeaderClock />
        <div className="text-matrix-cyan/30 text-lg hidden sm:block">◇</div>
      </div>
    </header>
  )
}

export default Header
