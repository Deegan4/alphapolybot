import React, { useRef, useState, useEffect } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'

interface ChartDataPoint {
  time: number
  balance: number
}

interface PortfolioPanelChartProps {
  data: ChartDataPoint[]
  initialBalance: number
  isFlat: boolean
}

const formatTime = (ts: number) => {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

/** Measures its own size via ResizeObserver, only renders children once dimensions are positive. */
const ChartContainer: React.FC<{ children: (w: number, h: number) => React.ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setSize({ w: Math.floor(width), h: Math.floor(height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={ref} className="flex-1 min-h-0" style={{ minHeight: 100 }}>
      {size.w > 0 && size.h > 0 ? children(size.w, size.h) : null}
    </div>
  )
}

const PortfolioPanelChart: React.FC<PortfolioPanelChartProps> = ({ data, initialBalance, isFlat }) => {
  return (
    <ChartContainer>
      {(w, h) =>
        data.length < 2 ? (
          <div className="h-full flex items-center justify-center text-agent-text-label text-[11px] font-mono">
            Collecting data...
          </div>
        ) : isFlat ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-1">
            <span className="text-lg opacity-20">📈</span>
            <span className="text-[11px] font-mono text-agent-text-label">Start trading to see your equity curve</span>
          </div>
        ) : (
          <ResponsiveContainer width={w} height={h}>
            <LineChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
              <XAxis
                dataKey="time"
                tickFormatter={formatTime}
                stroke="#1a1f2e"
                tick={{ fill: '#8b949e', fontSize: 10, fontFamily: 'Geist Mono, monospace' }}
                tickLine={false}
                axisLine={false}
                minTickGap={40}
              />
              <YAxis
                stroke="#1a1f2e"
                tick={{ fill: '#8b949e', fontSize: 10, fontFamily: 'Geist Mono, monospace' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                width={35}
              />
              {initialBalance > 0 && (
                <ReferenceLine
                  y={initialBalance}
                  stroke="#8b949e"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                />
              )}
              <Tooltip
                contentStyle={{
                  backgroundColor: 'rgba(13, 17, 23, 0.8)',
                  backdropFilter: 'blur(16px)',
                  border: '1px solid rgba(34, 197, 94, 0.1)',
                  borderRadius: '12px',
                  fontFamily: 'Geist Mono, monospace',
                  fontSize: '11px',
                }}
                labelFormatter={(ts: number) => {
                  const d = new Date(ts)
                  return d.toLocaleString(undefined, {
                    month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit', hour12: false,
                  })
                }}
                formatter={(value: number) => [`$${value.toFixed(2)}`, 'Balance']}
                labelStyle={{ color: '#8b949e' }}
                itemStyle={{ color: '#22c55e' }}
              />
              <Line
                type="monotone"
                dataKey="balance"
                stroke="#22c55e"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3, fill: '#22c55e', stroke: '#0d1117', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )
      }
    </ChartContainer>
  )
}

export default PortfolioPanelChart
