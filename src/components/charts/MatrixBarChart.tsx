import React, { useRef, useState, useEffect } from 'react'
import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
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

export interface BarChartDataPoint {
  [key: string]: string | number
}

export interface BarConfig {
  dataKey: string
  name?: string
  color?: string
  stackId?: string
}

export interface MatrixBarChartProps {
  data: BarChartDataPoint[]
  bars: BarConfig[]
  xAxisKey: string
  height?: number
  showGrid?: boolean
  showLegend?: boolean
  showTooltip?: boolean
  layout?: 'horizontal' | 'vertical'
  barSize?: number
  colorByValue?: boolean
  xAxisFormatter?: (value: string) => string
  yAxisFormatter?: (value: number) => string
  tooltipFormatter?: (value: number, name: string) => string
  className?: string
}

export const MatrixBarChart: React.FC<MatrixBarChartProps> = ({
  data,
  bars,
  xAxisKey,
  height = 300,
  showGrid = true,
  showLegend = true,
  showTooltip = true,
  layout = 'horizontal',
  barSize,
  colorByValue = false,
  xAxisFormatter,
  yAxisFormatter,
  tooltipFormatter,
  className,
}) => {
  const isVertical = layout === 'vertical'

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
        <RechartsBarChart
          data={data}
          layout={layout}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        >
          {showGrid && <CartesianGrid {...defaultGridProps} />}
          {isVertical ? (
            <>
              <XAxis
                type="number"
                {...defaultAxisProps}
                tickFormatter={yAxisFormatter}
              />
              <YAxis
                type="category"
                dataKey={xAxisKey}
                {...defaultAxisProps}
                tickFormatter={xAxisFormatter}
                width={80}
              />
            </>
          ) : (
            <>
              <XAxis
                dataKey={xAxisKey}
                {...defaultAxisProps}
                tickFormatter={xAxisFormatter}
              />
              <YAxis
                {...defaultAxisProps}
                tickFormatter={yAxisFormatter}
              />
            </>
          )}
          {showTooltip && (
            <Tooltip
              content={<ChartTooltip formatter={tooltipFormatter} />}
              cursor={{
                fill: matrixChartTheme.colors.primary,
                fillOpacity: 0.1,
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
          {bars.map((bar, index) => (
            <Bar
              key={bar.dataKey}
              dataKey={bar.dataKey}
              name={bar.name ?? bar.dataKey}
              fill={bar.color ?? seriesColors[index % seriesColors.length]}
              stackId={bar.stackId}
              barSize={barSize}
              radius={[2, 2, 0, 0]}
            >
              {colorByValue &&
                data.map((entry, cellIndex) => {
                  const value = entry[bar.dataKey]
                  const color = typeof value === 'number' 
                    ? getValueColor(value)
                    : bar.color ?? seriesColors[index % seriesColors.length]
                  return <Cell key={`cell-${cellIndex}`} fill={color} />
                })}
            </Bar>
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>}
    </div>
  )
}
