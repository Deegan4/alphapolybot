import React, { useEffect, useState } from 'react'

interface WindowTimerProps {
  windowStartMs: number | null
  windowEndMs: number | null
}

const formatClock = (d: Date) =>
  `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`

const formatTimeLabel = (ms: number) => {
  const d = new Date(ms)
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m} ${ampm}`
}

/**
 * 15-minute BTC window timer with progress bar.
 * Shows current time in green, progress bar, and window start/end times.
 */
export const WindowTimer: React.FC<WindowTimerProps> = ({ windowStartMs, windowEndMs }) => {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const currentTime = formatClock(new Date(now))

  if (!windowStartMs || !windowEndMs) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-2xl font-mono font-bold text-agent-green">{currentTime}</span>
        <span className="text-xs font-mono text-agent-text-muted">No active window</span>
      </div>
    )
  }

  const total = windowEndMs - windowStartMs
  const elapsed = Math.max(0, Math.min(total, now - windowStartMs))
  const progress = total > 0 ? (elapsed / total) * 100 : 0

  return (
    <div className="flex items-center gap-3">
      <span className="text-2xl font-mono font-bold text-agent-green">{currentTime}</span>
      <div className="flex flex-col gap-0.5">
        {/* Progress bar */}
        <div className="w-32 h-1.5 bg-agent-border rounded-full overflow-hidden">
          <div
            className="h-full bg-agent-green rounded-full transition-all duration-1000"
            style={{ width: `${progress}%` }}
          />
        </div>
        {/* Window range label */}
        <span className="text-[10px] font-mono text-agent-text-muted">
          {formatTimeLabel(windowStartMs)} — {formatTimeLabel(windowEndMs)}
        </span>
      </div>
    </div>
  )
}
