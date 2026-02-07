import React from 'react'
import {
  LineChart as RechartsLineChart,
  Line,
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
} from './shared/chartTheme'
import { ChartTooltip } from './shared/ChartTooltip'

export interface LineChartDataPoint {
  [key: string]: string | number
}

export interface LineConfig {
  dataKey: string
  name?: string
  color?: string
  strokeWidth?: number
  dot?: boolean
  dashed?: boolean
}

export interface MatrixLineChartProps {
  data: LineChartDataPoint[]
  lines: LineConfig[]
  xAxisKey: string
  height?: number
  showGrid?: boolean
  showLegend?: boolean
  showTooltip?: boolean
  xAxisFormatter?: (value: string) => string
  yAxisFormatter?: (value: number) => string
  tooltipFormatter?: (value: number, name: string) => string
  className?: string
}

export const MatrixLineChart: React.FC<MatrixLineChartProps> = ({
  data,
  lines,
  xAxisKey,
  height = 300,
  showGrid = true,
  showLegend = true,
  showTooltip = true,
  xAxisFormatter,
  yAxisFormatter,
  tooltipFormatter,
  className,
}) => {
  return (
    <div className={cn('w-full', className)}>
      <ResponsiveContainer width="100%" height={height}>
        <RechartsLineChart
          data={data}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        >
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
          {lines.map((line, index) => (
            <Line
              key={line.dataKey}
              type="monotone"
              dataKey={line.dataKey}
              name={line.name ?? line.dataKey}
              stroke={line.color ?? seriesColors[index % seriesColors.length]}
              strokeWidth={line.strokeWidth ?? 2}
              dot={line.dot ?? false}
              strokeDasharray={line.dashed ? '5 5' : undefined}
              activeDot={{
                r: 4,
                fill: line.color ?? seriesColors[index % seriesColors.length],
                stroke: matrixChartTheme.colors.background,
                strokeWidth: 2,
              }}
            />
          ))}
        </RechartsLineChart>
      </ResponsiveContainer>
    </div>
  )
}
