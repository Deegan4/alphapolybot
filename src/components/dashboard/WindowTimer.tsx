import React, { useEffect, useState } from 'react'

export interface ActiveWindow {
  asset: string
  windowStartMs: number
  windowEndMs: number
  windowDurationMs: number
  durationKey: string
}

interface WindowTimerProps {
  windows: ActiveWindow[]
}

const formatClock = (d: Date) => {
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m} ${ampm}`
}

const formatTimeLabel = (ms: number) => {
  const d = new Date(ms)
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m} ${ampm}`
}

const formatRemaining = (ms: number) => {
  if (ms <= 0) return '0:00'
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

const LABEL_MAP: Record<string, string> = {
  '5m': '5 MIN',
  '15m': '15 MIN',
  'hourly': '1 HR',
  '4h': '4 HR',
  'daily': 'DAILY',
}

/** Single progress bar for one window timeframe */
const WindowBar: React.FC<{ window: ActiveWindow; now: number }> = ({ window: w, now }) => {
  const total = w.windowEndMs - w.windowStartMs
  const elapsed = Math.max(0, Math.min(total, now - w.windowStartMs))
  const remaining = Math.max(0, w.windowEndMs - now)
  const progress = total > 0 ? (elapsed / total) * 100 : 0

  // Color shifts from green → yellow → red as time runs out
  const isUrgent = remaining < 30_000
  const isWarning = remaining < 60_000 && !isUrgent
  const barColor = isUrgent
    ? 'bg-red-400'
    : isWarning
      ? 'bg-yellow-400'
      : 'bg-agent-green'
  const glowClass = isUrgent ? '' : 'progress-glow'
  const labelColor = isUrgent
    ? 'text-red-400'
    : isWarning
      ? 'text-yellow-400'
      : 'text-agent-green'

  return (
    <div className="flex items-center gap-2">
      {/* Duration badge */}
      <span className={`text-[10px] font-mono font-bold w-10 text-right ${labelColor}`}>
        {LABEL_MAP[w.durationKey] ?? w.durationKey}
      </span>

      {/* Progress track */}
      <div className="w-28 h-2 bg-agent-border/60 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${barColor} ${glowClass}`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Countdown */}
      <span className={`text-[11px] font-mono font-semibold w-10 tabular-nums ${labelColor}`}>
        {formatRemaining(remaining)}
      </span>

      {/* Window range */}
      <span className="text-[10px] font-mono text-agent-text-label hidden xl:inline">
        {formatTimeLabel(w.windowStartMs)}–{formatTimeLabel(w.windowEndMs)}
      </span>
    </div>
  )
}

/**
 * Dual BTC window timer — shows progress bars for all active crypto window timeframes.
 * Green → yellow (< 60s) → red (< 30s) with countdown.
 */
export const WindowTimer: React.FC<WindowTimerProps> = ({ windows }) => {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const currentTime = formatClock(new Date(now))

  // Sort: 5m first, then 15m, then hourly, etc.
  const SORT_ORDER: Record<string, number> = { '5m': 0, '15m': 1, 'hourly': 2, '4h': 3, 'daily': 4 }
  const sorted = [...windows].sort(
    (a, b) => (SORT_ORDER[a.durationKey] ?? 9) - (SORT_ORDER[b.durationKey] ?? 9)
  )

  if (sorted.length === 0) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-3xl font-mono font-bold text-agent-green animate-text-glow">{currentTime}</span>
        <span className="text-sm font-sans text-agent-text-muted">No active window</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-4">
      <span className="text-3xl font-mono font-bold text-agent-green animate-text-glow">{currentTime}</span>
      <div className="flex flex-col gap-1">
        {sorted.map((w) => (
          <WindowBar key={w.durationKey} window={w} now={now} />
        ))}
      </div>
    </div>
  )
}
