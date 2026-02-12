import React, { useEffect, useRef, useState, useMemo } from 'react'
import { activityLogger } from '@/services/trading/ActivityLogger'
import type { ActivityItem } from '@/types'

type FilterKey = 'ALL' | 'API' | 'BTC' | 'ETH' | 'SOL'

const FILTERS: FilterKey[] = ['ALL', 'API', 'BTC', 'ETH', 'SOL']

const typeEmoji: Record<string, string> = {
  trade: '\u{1F4B0}',
  sell: '\u{1F4B8}',
  analysis: '\u{1F9E0}',
  scan: '\u{1F50D}',
  error: '\u{26A0}\uFE0F',
  warning: '\u{1F7E1}',
  info: '\u{2139}\uFE0F',
  system: '\u{2699}\uFE0F',
}

const typeColor: Record<string, string> = {
  trade: 'text-agent-green',
  sell: 'text-agent-green',
  analysis: 'text-agent-cyan',
  scan: 'text-agent-orange',
  error: 'text-agent-red',
  warning: 'text-agent-orange',
  info: 'text-agent-text-muted',
  system: 'text-agent-text-label',
}

const formatTime = (ts: Date | number) => {
  const d = ts instanceof Date ? ts : new Date(ts)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export const ActivitySidebar: React.FC = () => {
  const [activities, setActivities] = useState<ActivityItem[]>(
    activityLogger.getActivities({ limit: 100 })
  )
  const [filter, setFilter] = useState<FilterKey>('ALL')
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScroll = useRef(true)

  useEffect(() => {
    return activityLogger.subscribe(() => {
      setActivities(activityLogger.getActivities({ limit: 100 }))
      if (autoScroll.current) {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
        })
      }
    })
  }, [])

  const handleScroll = () => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    autoScroll.current = scrollHeight - scrollTop - clientHeight < 60
  }

  const filtered = useMemo(() => {
    const chronological = [...activities].reverse()
    if (filter === 'ALL') return chronological
    if (filter === 'API') {
      return chronological.filter(
        (a) => a.type === 'scan' || a.type === 'analysis'
      )
    }
    // Asset filter — match keyword in message
    const keyword = filter
    return chronological.filter(
      (a) => a.message.toUpperCase().includes(keyword)
    )
  }, [activities, filter])

  return (
    <div className="bg-agent-card border border-agent-border rounded-sm flex flex-col min-h-0 h-full">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-agent-border">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm">&#9889;</span>
          <span className="text-[10px] uppercase tracking-wider text-agent-text-muted font-mono">
            Activity
          </span>
          <span className="text-[9px] font-mono text-agent-text-label ml-auto">
            {filtered.length}
          </span>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-[9px] font-mono font-semibold px-2 py-0.5 rounded-full transition-colors ${
                filter === f
                  ? 'bg-agent-green/15 text-agent-green border border-agent-green/30'
                  : 'text-agent-text-muted hover:text-agent-text'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable log */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 min-h-0"
      >
        {filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-agent-text-label text-xs font-mono">
            No activity
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((a) => (
              <div key={a.id} className="flex gap-2 py-0.5 leading-tight">
                <span className="text-[10px] font-mono text-agent-text-label shrink-0 tabular-nums">
                  {formatTime(a.timestamp)}
                </span>
                <span className="text-[10px] shrink-0">{typeEmoji[a.type] || ''}</span>
                <span
                  className={`text-[10px] font-mono ${typeColor[a.type] || 'text-agent-text-muted'} break-all leading-relaxed`}
                >
                  {a.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
