import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'

interface WindowTimerProps {
  windowStartMs: number | null
  windowEndMs: number | null
  windowDurationMs?: number | null
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

type Timeframe = '5m' | '15m'

/** Segmented toggle for switching between 5m and 15m market windows */
const TimeframeSelector: React.FC = () => {
  const enable5m = useSettingsStore((s) => s.btcEnable5m)
  const _enable15m = useSettingsStore((s) => s.btcEnable15m)
  const setBtcEnable5m = useSettingsStore((s) => s.setBtcEnable5m)
  const setBtcEnable15m = useSettingsStore((s) => s.setBtcEnable15m)

  // Determine which is the "active display" timeframe
  const active: Timeframe = enable5m ? '5m' : '15m'

  const select = (tf: Timeframe) => {
    if (tf === '5m') {
      setBtcEnable5m(true)
      setBtcEnable15m(false)
    } else {
      setBtcEnable5m(false)
      setBtcEnable15m(true)
    }
  }

  return (
    <div className="flex items-center rounded-md border border-agent-border/60 overflow-hidden">
      {(['5m', '15m'] as Timeframe[]).map((tf) => (
        <button
          key={tf}
          onClick={() => select(tf)}
          className={`px-2.5 py-1 text-[11px] font-mono font-bold transition-all ${
            active === tf
              ? 'bg-agent-cyan/15 text-agent-cyan border-agent-cyan/30'
              : 'text-agent-text-label hover:text-agent-text hover:bg-agent-card/50'
          }`}
        >
          {tf}
        </button>
      ))}
    </div>
  )
}

/**
 * BTC window timer with progress bar and timeframe selector.
 * Shows current time, timeframe toggle (5m/15m), progress bar, and window range.
 */
export const WindowTimer: React.FC<WindowTimerProps> = ({ windowStartMs, windowEndMs, windowDurationMs }) => {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const currentTime = formatClock(new Date(now))

  if (!windowStartMs || !windowEndMs) {
    return (
      <div className="flex items-center gap-3">
        <span className="text-3xl font-mono font-bold text-agent-green">{currentTime}</span>
        <TimeframeSelector />
        <span className="text-sm font-sans text-agent-text-muted">No active window</span>
      </div>
    )
  }

  const total = windowEndMs - windowStartMs
  const elapsed = Math.max(0, Math.min(total, now - windowStartMs))
  const progress = total > 0 ? (elapsed / total) * 100 : 0

  return (
    <div className="flex items-center gap-3">
      <span className="text-3xl font-mono font-bold text-agent-green">{currentTime}</span>
      <TimeframeSelector />
      <div className="flex flex-col gap-0.5">
        {/* Progress bar */}
        <div className="w-44 h-2.5 bg-agent-border rounded-full overflow-hidden">
          <div
            className="h-full bg-agent-green rounded-full transition-all duration-1000"
            style={{ width: `${progress}%` }}
          />
        </div>
        {/* Window range label */}
        <span className="text-xs font-sans text-agent-text-muted">
          {windowDurationMs && (
            <span className="text-agent-cyan font-semibold mr-1.5">
              {windowDurationMs <= 300_000 ? '5m' : windowDurationMs <= 900_000 ? '15m' : 'hourly'}
            </span>
          )}
          {formatTimeLabel(windowStartMs)} — {formatTimeLabel(windowEndMs)}
        </span>
      </div>
    </div>
  )
}
