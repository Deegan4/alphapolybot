import React from 'react'
import {
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieLabelRenderProps,
} from 'recharts'
import { cn } from '../../utils'
import { matrixChartTheme, seriesColors } from './shared/chartTheme'
import { ChartTooltip } from './shared/ChartTooltip'

export interface PieChartDataPoint {
  name: string
  value: number
  color?: string
}

export interface MatrixPieChartProps {
  data: PieChartDataPoint[]
  height?: number
  innerRadius?: number
  outerRadius?: number
  showLegend?: boolean
  showTooltip?: boolean
  showLabels?: boolean
  labelType?: 'name' | 'value' | 'percent'
  tooltipFormatter?: (value: number, name: string) => string
  className?: string
}

export const MatrixPieChart: React.FC<MatrixPieChartProps> = ({
  data,
  height = 300,
  innerRadius = 0,
  outerRadius = 80,
  showLegend = true,
  showTooltip = true,
  showLabels = false,
  labelType = 'percent',
  tooltipFormatter,
  className,
}) => {
  const total = data.reduce((sum, item) => sum + item.value, 0)

  const renderLabel = (props: PieLabelRenderProps): string => {
    const { name, value, percent } = props
    
    switch (labelType) {
      case 'name':
        return String(name ?? '')
      case 'value':
        return typeof value === 'number' ? value.toLocaleString() : String(value ?? '')
      case 'percent':
      default:
        return `${((percent ?? 0) * 100).toFixed(0)}%`
    }
  }

  return (
    <div className={cn('w-full', className)}>
      <ResponsiveContainer width="100%" height={height}>
        <RechartsPieChart>
          {showTooltip && (
            <Tooltip
              content={
                <ChartTooltip
                  formatter={
                    tooltipFormatter ??
                    ((value) => {
                      const percent = total > 0 ? ((value / total) * 100).toFixed(1) : 0
                      return `${value.toLocaleString()} (${percent}%)`
                    })
                  }
                />
              }
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
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={innerRadius}
            outerRadius={outerRadius}
            paddingAngle={2}
            dataKey="value"
            nameKey="name"
            label={showLabels ? renderLabel : undefined}
            labelLine={showLabels}
            stroke={matrixChartTheme.colors.background}
            strokeWidth={2}
          >
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.color ?? seriesColors[index % seriesColors.length]}
                style={{
                  filter: `drop-shadow(0 0 4px ${entry.color ?? seriesColors[index % seriesColors.length]}40)`,
                }}
              />
            ))}
          </Pie>
        </RechartsPieChart>
      </ResponsiveContainer>
    </div>
  )
}

// Donut chart is just a pie chart with inner radius
export const MatrixDonutChart: React.FC<MatrixPieChartProps> = (props) => {
  return <MatrixPieChart {...props} innerRadius={props.innerRadius ?? 50} />
}
