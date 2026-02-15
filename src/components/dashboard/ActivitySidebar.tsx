import React, { useEffect, useRef, useState, useMemo } from 'react'
import { activityLogger } from '@/services/trading/ActivityLogger'
import type { ActivityItem } from '@/types'

type FilterKey = 'ALL' | 'API' | 'BTC' | 'ETH' | 'SOL' | 'XRP'

const FILTERS: FilterKey[] = ['ALL', 'API', 'BTC', 'ETH', 'SOL', 'XRP']

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
  const [showJumpBtn, setShowJumpBtn] = useState(false)
  const prevCountRef = useRef(0)

  useEffect(() => {
    return activityLogger.subscribe(() => {
      setActivities(activityLogger.getActivities({ limit: 100 }))
    })
  }, [])

  const handleScroll = () => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    // 120px threshold — generous so minor scroll jitter doesn't disable auto-scroll
    const nearBottom = scrollHeight - scrollTop - clientHeight < 120
    autoScroll.current = nearBottom
    setShowJumpBtn(!nearBottom)
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

  // Auto-scroll when new items arrive — scrolls to bottom so newest entry is visible
  useEffect(() => {
    const hasNewItems = filtered.length > prevCountRef.current
    prevCountRef.current = filtered.length

    if (!scrollRef.current) return

    // If new items arrived and auto-scroll is on, OR if the list just populated for the first time
    if ((hasNewItems && autoScroll.current) || (hasNewItems && filtered.length <= 5)) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
      })
    }
  }, [filtered])

  return (
    <div className="bg-agent-card border border-agent-border rounded-lg flex flex-col min-h-0 h-full">
      {/* Header */}
      <div className="px-4 pt-3.5 pb-2.5 border-b border-agent-border">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm">&#9889;</span>
          <span className="text-xs uppercase tracking-wider text-agent-text-muted font-sans font-medium">
            Activity
          </span>
          <span className="text-[10px] font-mono text-agent-text-label ml-auto tabular-nums">
            {filtered.length}
          </span>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-[10px] font-sans font-semibold px-2.5 py-1 rounded-full transition-colors ${
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
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-4 py-2"
        >
          {filtered.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center gap-2">
              <span className="text-2xl opacity-30">&#9889;</span>
              <span className="text-sm font-sans text-agent-text-label">No activity</span>
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((a) => (
                <div
                  key={a.id}
                  className="flex gap-2 py-1 leading-tight border-b border-agent-border/20 last:border-b-0 animate-fade-in"
                >
                  <span className="text-[11px] font-mono text-agent-text-label shrink-0 tabular-nums">
                    {formatTime(a.timestamp)}
                  </span>
                  <span className="text-[11px] shrink-0">{typeEmoji[a.type] || ''}</span>
                  <span
                    className={`text-[11px] font-mono ${typeColor[a.type] || 'text-agent-text-muted'} break-all leading-relaxed`}
                  >
                    {a.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Jump-to-latest button — appears when user scrolls away from bottom */}
        {showJumpBtn && filtered.length > 0 && (
          <button
            onClick={() => {
              autoScroll.current = true
              setShowJumpBtn(false)
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
            }}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[10px] font-mono font-semibold bg-agent-green/15 text-agent-green border border-agent-green/30 hover:bg-agent-green/25 transition-colors shadow-lg shadow-agent-bg/80 z-10"
          >
            &#x2193; Latest
          </button>
        )}
      </div>
    </div>
  )
}
