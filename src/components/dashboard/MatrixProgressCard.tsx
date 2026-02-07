import React from 'react'
import { cn } from '../../utils'
import { MatrixProgressRing } from '../charts/MatrixGauge'
import { getValueColor } from '../charts/shared/chartTheme'

export interface MatrixProgressCardProps {
  title: string
  value: number
  max?: number
  subtitle?: string
  format?: 'percent' | 'fraction' | 'value'
  color?: string
  size?: 'sm' | 'md' | 'lg'
  showTrend?: boolean
  trendValue?: number
  className?: string
}

export const MatrixProgressCard: React.FC<MatrixProgressCardProps> = ({
  title,
  value,
  max = 100,
  subtitle,
  format = 'percent',
  color,
  size = 'md',
  showTrend = false,
  trendValue,
  className,
}) => {
  const percentage = Math.min((value / max) * 100, 100)

  const formatValue = (): string => {
    switch (format) {
      case 'fraction':
        return `${value}/${max}`
      case 'value':
        return value.toLocaleString()
      case 'percent':
      default:
        return `${percentage.toFixed(0)}%`
    }
  }

  const trendColor = trendValue ? getValueColor(trendValue) : undefined

  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-lg border border-matrix-border',
        'bg-matrix-card p-4 font-mono transition-all duration-200',
        'hover:border-matrix-primary/30',
        className
      )}
    >
      {/* Progress ring */}
      <div className="relative">
        <MatrixProgressRing
          value={value}
          max={max}
          size={size}
          showValue={false}
          color={color}
        />
        {/* Centered value */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-bold text-matrix-primary">
            {formatValue()}
          </span>
        </div>
      </div>

      {/* Text content */}
      <div className="flex-1">
        <p className="text-sm font-medium text-matrix-primary">{title}</p>
        {subtitle && (
          <p className="mt-0.5 text-xs text-matrix-muted">{subtitle}</p>
        )}
        {showTrend && trendValue !== undefined && (
          <div className="mt-1 flex items-center gap-1">
            <span className="text-xs" style={{ color: trendColor }}>
              {trendValue > 0 ? '+' : ''}{trendValue.toFixed(1)}%
            </span>
            <span className="text-xs text-matrix-muted">vs previous</span>
          </div>
        )}
      </div>
    </div>
  )
}
