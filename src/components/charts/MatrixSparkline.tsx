import React, { useMemo, useRef, useState, useEffect } from 'react'
import {
  LineChart,
  Line,
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

  // Measure actual pixel dimensions via ResizeObserver instead of ResponsiveContainer.
  // ResponsiveContainer internally subtracts 1 from measured dims, yielding -1×-1 when
  // the container is 0×0 during flex layout settling — causing console spam.
  const containerRef = useRef<HTMLDivElement>(null)
  const [measuredWidth, setMeasuredWidth] = useState(0)
  const [measuredHeight, setMeasuredHeight] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const measure = () => {
      const { width: w, height: h } = el.getBoundingClientRect()
      setMeasuredWidth(Math.floor(w))
      setMeasuredHeight(Math.floor(h))
    }

    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (normalizedData.length === 0) {
    return null
  }

  return (
    <div ref={containerRef} className={cn('block overflow-hidden', className)} style={{ width, height, minWidth: 2, minHeight: 2 }}>
      {measuredWidth > 0 && measuredHeight > 0 && (
        <LineChart width={measuredWidth} height={measuredHeight} data={normalizedData}>
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
      )}
    </div>
  )
}
