import React, { useRef, useState, useEffect } from 'react'
import {
  AreaChart as RechartsAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { cn } from '../../utils'
import {
  matrixChartTheme,
  defaultAxisProps,
  defaultGridProps,
  seriesColors,
  getValueColor,
} from './shared/chartTheme'
import { ChartTooltip } from './shared/ChartTooltip'

export interface AreaChartDataPoint {
  [key: string]: string | number
}

export interface AreaConfig {
  dataKey: string
  name?: string
  color?: string
  fillOpacity?: number
  strokeWidth?: number
}

export interface MatrixAreaChartProps {
  data: AreaChartDataPoint[]
  areas: AreaConfig[]
  xAxisKey: string
  height?: number
  showGrid?: boolean
  showLegend?: boolean
  showTooltip?: boolean
  stacked?: boolean
  xAxisFormatter?: (value: string) => string
  yAxisFormatter?: (value: number) => string
  tooltipFormatter?: (value: number, name: string) => string
  colorByValue?: boolean
  className?: string
}

export const MatrixAreaChart: React.FC<MatrixAreaChartProps> = ({
  data,
  areas,
  xAxisKey,
  height = 300,
  showGrid = true,
  showLegend = true,
  showTooltip = true,
  stacked = false,
  xAxisFormatter,
  yAxisFormatter,
  tooltipFormatter,
  colorByValue = false,
  className,
}) => {
  // If colorByValue is enabled, determine color based on last data point
  const getAreaColor = (area: AreaConfig, index: number) => {
    if (colorByValue && data.length > 0) {
      const lastValue = data[data.length - 1][area.dataKey]
      if (typeof lastValue === 'number') {
        return getValueColor(lastValue)
      }
    }
    return area.color ?? seriesColors[index % seriesColors.length]
  }

  // Defer Recharts render until container has positive dimensions (prevents -1×-1 warning)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hasSize, setHasSize] = useState(false)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const { width: w, height: h } = e.contentRect
      setHasSize(w > 0 && h > 0)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={containerRef} className={cn('w-full', className)} style={{ minHeight: height }}>
      {hasSize && <ResponsiveContainer width="100%" height={height} minWidth={1} minHeight={1}>
        <RechartsAreaChart
          data={data}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        >
          <defs>
            {areas.map((area, index) => {
              const color = getAreaColor(area, index)
              return (
                <linearGradient
                  key={`gradient-${area.dataKey}`}
                  id={`gradient-${area.dataKey}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              )
            })}
          </defs>
          {showGrid && <CartesianGrid {...defaultGridProps} />}
          <XAxis
            dataKey={xAxisKey}
            {...defaultAxisProps}
            tickFormatter={xAxisFormatter}
          />
          <YAxis
            {...defaultAxisProps}
            tickFormatter={yAxisFormatter}
          />
          {showTooltip && (
            <Tooltip
              content={<ChartTooltip formatter={tooltipFormatter} />}
              cursor={{
                stroke: matrixChartTheme.colors.primary,
                strokeOpacity: 0.3,
              }}
            />
          )}
          {showLegend && (
            <Legend
              wrapperStyle={{
                fontFamily: matrixChartTheme.fonts.family,
                fontSize: matrixChartTheme.fonts.size.sm,
              }}
            />
          )}
          {areas.map((area, index) => {
            const color = getAreaColor(area, index)
            return (
              <Area
                key={area.dataKey}
                type="monotone"
                dataKey={area.dataKey}
                name={area.name ?? area.dataKey}
                stroke={color}
                strokeWidth={area.strokeWidth ?? 2}
                fill={`url(#gradient-${area.dataKey})`}
                fillOpacity={area.fillOpacity ?? 1}
                stackId={stacked ? 'stack' : undefined}
              />
            )
          })}
        </RechartsAreaChart>
      </ResponsiveContainer>}
    </div>
  )
}
