import React, { useMemo, useRef, useState, useEffect } from 'react'
import {
  LineChart,
  Line,
  ResponsiveContainer,
  YAxis,
} from 'recharts'
import { cn } from '../../utils'
import { matrixChartTheme, getValueColor } from './shared/chartTheme'

export interface SparklineDataPoint {
  value: number
}

export interface MatrixSparklineProps {
  data: (number | SparklineDataPoint)[]
  width?: number | string
  height?: number
  color?: string
  colorByTrend?: boolean
  strokeWidth?: number
  showDot?: boolean
  className?: string
}

export const MatrixSparkline: React.FC<MatrixSparklineProps> = ({
  data,
  width = '100%',
  height = 30,
  color,
  colorByTrend = true,
  strokeWidth = 1.5,
  showDot = false,
  className,
}) => {
  // Normalize data to always have {value} format
  const normalizedData = useMemo(() => {
    return data.map((point) =>
      typeof point === 'number' ? { value: point } : point
    )
  }, [data])

  // Calculate trend color based on first and last values
  const trendColor = useMemo(() => {
    if (!colorByTrend || normalizedData.length < 2) {
      return color ?? matrixChartTheme.colors.primary
    }
    const first = normalizedData[0].value
    const last = normalizedData[normalizedData.length - 1].value
    return getValueColor(last - first)
  }, [normalizedData, colorByTrend, color])

  // Get min/max for Y axis domain
  const [minValue, maxValue] = useMemo(() => {
    const values = normalizedData.map((d) => d.value)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const padding = (max - min) * 0.1 || 1
    return [min - padding, max + padding]
  }, [normalizedData])

  // Track whether the container has positive dimensions before rendering Recharts.
  // ResponsiveContainer measures via ResizeObserver and computes (width - 1, height - 1).
  // If the container is 0×0 (hidden tab, collapsed flex, initial layout), that yields -1×-1
  // which triggers the "width(-1) and height(-1) should be greater than 0" warning.
  const containerRef = useRef<HTMLDivElement>(null)
  const [hasSize, setHasSize] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const check = () => {
      const { width: w, height: h } = el.getBoundingClientRect()
      setHasSize(w > 0 && h > 0)
    }

    // Initial check
    check()

    // Watch for resize (tab becoming visible, flex layout completing, etc.)
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (normalizedData.length === 0) {
    return null
  }

  return (
    <div ref={containerRef} className={cn('block overflow-hidden', className)} style={{ width, height, minWidth: 2, minHeight: 2 }}>
      {hasSize && (
        <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
          <LineChart data={normalizedData}>
            <YAxis domain={[minValue, maxValue]} hide />
            <Line
              type="monotone"
              dataKey="value"
              stroke={trendColor}
              strokeWidth={strokeWidth}
              dot={showDot ? { r: 2, fill: trendColor } : false}
              activeDot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
