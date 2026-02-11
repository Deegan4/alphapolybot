import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MatrixCard, MatrixBadge, MatrixButton, AnimatedCounter } from '@/components/ui'
import { activityLogger } from '@/services/trading/ActivityLogger'
import type { ActivityItem, ActivityType } from '@/types'
import { cn } from '@/utils/cn'

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
}

const itemVariants = {
  hidden: { opacity: 0, x: 20 },
  show: { opacity: 1, x: 0, transition: { type: 'spring', stiffness: 300, damping: 25 } },
}

/**
 * ActivityView - Full activity log and analytics
 */
export const ActivityView: React.FC = () => {
  const [entries, setEntries] = useState<ActivityItem[]>([])
  const [filter, setFilter] = useState<ActivityType | 'all'>('all')
  const [stats, setStats] = useState(activityLogger.getStats())

  // Subscribe to activity updates — callback receives single item, so refresh full list
  useEffect(() => {
    setEntries(activityLogger.getActivities({ limit: 500 }))
    const unsubscribe = activityLogger.subscribe(() => {
      setEntries(activityLogger.getActivities({ limit: 500 }))
      setStats(activityLogger.getStats())
    })
    return unsubscribe
  }, [])

  // Update stats periodically
  useEffect(() => {
    const interval = setInterval(() => {
      setStats(activityLogger.getStats())
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  const filteredEntries = filter === 'all'
    ? entries
    : entries.filter(e => e.type === filter)

  const filters: Array<{ value: ActivityType | 'all'; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'trade', label: 'Trades' },
    { value: 'sell', label: 'Sells' },
    { value: 'analysis', label: 'Analysis' },
    { value: 'scan', label: 'Scans' },
    { value: 'error', label: 'Errors' },
    { value: 'warning', label: 'Warnings' },
    { value: 'system', label: 'System' },
  ]

  const handleClear = () => {
    activityLogger.clear()
  }

  const handleExport = () => {
    const data = JSON.stringify(entries, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `activity-log-${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Stats Row */}
      <motion.div
        className="grid grid-cols-5 gap-4"
        initial="hidden"
        animate="show"
        variants={containerVariants}
      >
        <StatCard label="Total Events" value={stats.total} />
        <StatCard label="Trades" value={stats.byType.trade + stats.byType.sell} variant="success" />
        <StatCard label="Analysis" value={stats.byType.analysis} variant="info" />
        <StatCard label="Scans" value={stats.byType.scan} variant="warning" />
        <StatCard label="Errors" value={stats.byType.error} variant="danger" />
      </motion.div>

      {/* Main content */}
      <MatrixCard
        title="ACTIVITY LOG"
        subtitle={`${filteredEntries.length} entries`}
        variant="glass"
        className="flex-1 flex flex-col min-h-0"
      >
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4 pb-4 border-b border-matrix-border/50">
          {/* Filters — sliding indicator */}
          <div className="flex items-center gap-1 relative">
            {filters.map(f => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'relative px-3 py-1 text-xs font-mono rounded transition-colors z-10',
                  filter === f.value
                    ? 'text-matrix-primary'
                    : 'text-matrix-text-secondary hover:text-matrix-primary'
                )}
              >
                {filter === f.value && (
                  <motion.div
                    layoutId="activity-filter"
                    className="absolute inset-0 bg-matrix-primary/15 border border-matrix-primary/30 rounded"
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                  />
                )}
                <span className="relative z-10">{f.label}</span>
              </button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <MatrixButton variant="ghost" size="sm" onClick={handleExport}>
              Export
            </MatrixButton>
            <MatrixButton variant="danger" size="sm" onClick={handleClear}>
              Clear
            </MatrixButton>
          </div>
        </div>

        {/* Activity List */}
        <div className="flex-1 overflow-auto">
          {filteredEntries.length === 0 ? (
            <div className="text-center py-12 text-matrix-text-secondary">
              <div className="text-4xl mb-4 opacity-30">◇</div>
              <p className="font-sans">No activity to display</p>
              <p className="text-xs mt-1 font-sans">Activity will appear as the bot runs</p>
            </div>
          ) : (
            <motion.div
              className="space-y-2"
              variants={containerVariants}
              initial="hidden"
              animate="show"
              key={filter}
            >
              {filteredEntries.map((entry) => (
                <motion.div key={entry.id} variants={itemVariants}>
                  <ActivityEntryRow entry={entry} />
                </motion.div>
              ))}
            </motion.div>
          )}
        </div>
      </MatrixCard>
    </div>
  )
}

/**
 * Stat Card Component
 */
const StatCard: React.FC<{
  label: string
  value: number
  variant?: 'default' | 'success' | 'info' | 'warning' | 'danger'
}> = ({ label, value, variant = 'default' }) => {
  const colors = {
    default: 'text-matrix-text-primary',
    success: 'text-matrix-primary',
    info: 'text-matrix-cyan',
    warning: 'text-matrix-secondary',
    danger: 'text-red-400',
  }

  const glowColors = {
    default: '',
    success: 'shadow-[0_0_15px_rgba(0,255,0,0.08)]',
    info: 'shadow-[0_0_15px_rgba(0,255,255,0.08)]',
    warning: 'shadow-[0_0_15px_rgba(255,255,0,0.08)]',
    danger: 'shadow-[0_0_15px_rgba(239,68,68,0.08)]',
  }

  return (
    <motion.div
      variants={itemVariants}
      className={cn(
        'bg-matrix-card/80 backdrop-blur-sm border border-matrix-border/50 rounded-lg p-4',
        glowColors[variant]
      )}
      whileHover={{ scale: 1.02, y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      <p className="text-matrix-text-secondary text-xs font-sans uppercase tracking-wider">
        {label}
      </p>
      <p className={cn('text-2xl font-mono font-bold mt-1', colors[variant])}>
        <AnimatedCounter value={value} precision={0} />
      </p>
    </motion.div>
  )
}

/**
 * Activity Entry Row Component
 */
const ActivityEntryRow: React.FC<{ entry: ActivityItem }> = ({ entry }) => {
  const [expanded, setExpanded] = useState(false)

  const getTypeStyles = () => {
    switch (entry.type) {
      case 'trade':
      case 'sell':     return { color: 'text-matrix-primary', bg: 'bg-matrix-primary/10', border: 'border-matrix-primary/30' }
      case 'analysis': return { color: 'text-matrix-cyan', bg: 'bg-matrix-cyan/10', border: 'border-matrix-cyan/30' }
      case 'scan':     return { color: 'text-matrix-secondary', bg: 'bg-matrix-secondary/10', border: 'border-matrix-secondary/30' }
      case 'error':    return { color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30' }
      case 'warning':  return { color: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30' }
      case 'info':     return { color: 'text-matrix-cyan', bg: 'bg-matrix-cyan/10', border: 'border-matrix-cyan/30' }
      case 'system':
      default:         return { color: 'text-matrix-text-secondary', bg: 'bg-matrix-border/50', border: 'border-matrix-border' }
    }
  }

  const styles = getTypeStyles()

  return (
    <div
      className={cn(
        'border rounded-lg p-3 cursor-pointer transition-all',
        styles.bg,
        styles.border,
        expanded && 'ring-1 ring-matrix-primary/30'
      )}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <MatrixBadge
            variant={
              entry.type === 'trade' || entry.type === 'sell' ? 'success' :
              entry.type === 'analysis' || entry.type === 'info' ? 'info' :
              entry.type === 'scan' ? 'warning' :
              entry.type === 'error' ? 'danger' :
              entry.type === 'warning' ? 'warning' : 'default'
            }
            size="sm"
          >
            {entry.type.toUpperCase()}
          </MatrixBadge>
          <p className={cn('text-sm font-mono', styles.color)}>
            {entry.message}
          </p>
        </div>
        <span className="text-matrix-text-secondary text-xs whitespace-nowrap ml-4 font-sans">
          {new Date(entry.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {/* Expanded details with AnimatePresence */}
      <AnimatePresence>
        {expanded && entry.data && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 pt-3 border-t border-matrix-border/50">
              <pre className="text-xs text-matrix-text-secondary font-mono overflow-auto">
                {JSON.stringify(entry.data, null, 2)}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default ActivityView
