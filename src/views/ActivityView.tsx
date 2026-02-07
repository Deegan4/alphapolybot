import React, { useEffect, useState } from 'react'
import { MatrixCard, MatrixBadge, MatrixButton } from '@/components/ui'
import { activityLogger, type ActivityEntry } from '@/services/trading/ActivityLogger'
import { cn } from '@/utils/cn'

/**
 * ActivityView - Full activity log and analytics
 */
export const ActivityView: React.FC = () => {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [filter, setFilter] = useState<ActivityEntry['type'] | 'all'>('all')
  const [stats, setStats] = useState(activityLogger.getStats())

  // Subscribe to activity updates
  useEffect(() => {
    const unsubscribe = activityLogger.subscribe(setEntries)
    setStats(activityLogger.getStats())
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

  const filters: Array<{ value: ActivityEntry['type'] | 'all'; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'trade', label: 'Trades' },
    { value: 'analysis', label: 'Analysis' },
    { value: 'scan', label: 'Scans' },
    { value: 'error', label: 'Errors' },
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
      <div className="grid grid-cols-5 gap-4">
        <StatCard label="Total Events" value={stats.total} />
        <StatCard label="Trades" value={stats.trades} variant="success" />
        <StatCard label="Analysis" value={stats.analysis} variant="info" />
        <StatCard label="Scans" value={stats.scans} variant="warning" />
        <StatCard label="Errors" value={stats.errors} variant="danger" />
      </div>

      {/* Main content */}
      <MatrixCard 
        title="ACTIVITY LOG" 
        subtitle={`${filteredEntries.length} entries`}
        className="flex-1 flex flex-col min-h-0"
      >
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-4 pb-4 border-b border-matrix-border">
          {/* Filters */}
          <div className="flex items-center gap-2">
            {filters.map(f => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'px-3 py-1 text-xs font-mono rounded transition-all',
                  filter === f.value
                    ? 'bg-matrix-primary/20 text-matrix-primary border border-matrix-primary/30'
                    : 'text-matrix-text-secondary hover:text-matrix-primary hover:bg-matrix-primary/10'
                )}
              >
                {f.label}
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
              <p>No activity to display</p>
              <p className="text-xs mt-1">Activity will appear as the bot runs</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredEntries.map((entry) => (
                <ActivityEntryRow key={entry.id} entry={entry} />
              ))}
            </div>
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
    info: 'text-blue-400',
    warning: 'text-matrix-secondary',
    danger: 'text-red-400',
  }

  return (
    <div className="bg-matrix-card border border-matrix-border rounded-lg p-4">
      <p className="text-matrix-text-secondary text-xs font-mono uppercase tracking-wider">
        {label}
      </p>
      <p className={cn('text-2xl font-mono font-bold mt-1', colors[variant])}>
        {value}
      </p>
    </div>
  )
}

/**
 * Activity Entry Row Component
 */
const ActivityEntryRow: React.FC<{ entry: ActivityEntry }> = ({ entry }) => {
  const [expanded, setExpanded] = useState(false)

  const getTypeStyles = () => {
    switch (entry.type) {
      case 'trade': return { color: 'text-matrix-primary', bg: 'bg-matrix-primary/10', border: 'border-matrix-primary/30' }
      case 'analysis': return { color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30' }
      case 'scan': return { color: 'text-matrix-secondary', bg: 'bg-matrix-secondary/10', border: 'border-matrix-secondary/30' }
      case 'error': return { color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30' }
      case 'system': return { color: 'text-matrix-text-secondary', bg: 'bg-matrix-border/50', border: 'border-matrix-border' }
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
              entry.type === 'trade' ? 'success' :
              entry.type === 'analysis' ? 'info' :
              entry.type === 'scan' ? 'warning' :
              entry.type === 'error' ? 'danger' : 'default'
            }
            size="sm"
          >
            {entry.type.toUpperCase()}
          </MatrixBadge>
          <p className={cn('text-sm font-mono', styles.color)}>
            {entry.message}
          </p>
        </div>
        <span className="text-matrix-text-secondary text-xs whitespace-nowrap ml-4">
          {new Date(entry.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {/* Expanded details */}
      {expanded && entry.data && (
        <div className="mt-3 pt-3 border-t border-matrix-border/50">
          <pre className="text-xs text-matrix-text-secondary font-mono overflow-auto">
            {JSON.stringify(entry.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

export default ActivityView
