import React from 'react'
import { cn } from '../../utils'
import { getValueColor } from '../charts/shared/chartTheme'

export interface MatrixMetricCardProps {
  label: string
  value: string | number
  previousValue?: number
  format?: 'number' | 'currency' | 'percent'
  precision?: number
  trend?: 'up' | 'down' | 'neutral'
  trendValue?: number
  icon?: React.ReactNode
  footer?: React.ReactNode
  className?: string
}

export const MatrixMetricCard: React.FC<MatrixMetricCardProps> = ({
  label,
  value,
  previousValue,
  format = 'number',
  precision = 2,
  trend,
  trendValue,
  icon,
  footer,
  className,
}) => {
  // Format the value
  const formatValue = (val: string | number): string => {
    if (typeof val === 'string') return val
    
    switch (format) {
      case 'currency':
        return `$${val.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision })}`
      case 'percent':
        return `${val.toFixed(precision)}%`
      default:
        return val.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: precision })
    }
  }

  // Calculate trend if not provided
  const calculatedTrend = trend ?? (
    previousValue !== undefined && typeof value === 'number'
      ? value > previousValue ? 'up' : value < previousValue ? 'down' : 'neutral'
      : undefined
  )

  const calculatedTrendValue = trendValue ?? (
    previousValue !== undefined && typeof value === 'number' && previousValue !== 0
      ? ((value - previousValue) / Math.abs(previousValue)) * 100
      : undefined
  )

  const trendColor = calculatedTrend === 'up' 
    ? getValueColor(1) 
    : calculatedTrend === 'down' 
      ? getValueColor(-1) 
      : undefined

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-lg border border-matrix-border',
        'bg-matrix-card p-6 font-mono transition-all duration-300',
        'hover:border-matrix-primary/40 hover:shadow-[0_0_20px_rgba(0,255,0,0.15)]',
        className
      )}
    >
      {/* Background glow effect */}
      <div className="absolute inset-0 bg-gradient-to-br from-matrix-primary/5 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />

      <div className="relative">
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-matrix-muted">
            {label}
          </span>
          {icon && (
            <span className="text-matrix-muted transition-colors group-hover:text-matrix-primary">
              {icon}
            </span>
          )}
        </div>

        {/* Main value */}
        <div className="mt-2">
          <span className="text-3xl font-bold text-matrix-primary">
            {formatValue(value)}
          </span>
        </div>

        {/* Trend indicator */}
        {calculatedTrend && (
          <div className="mt-2 flex items-center gap-2">
            <span className="flex items-center gap-1" style={{ color: trendColor }}>
              {calculatedTrend === 'up' && (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              )}
              {calculatedTrend === 'down' && (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              )}
              {calculatedTrendValue !== undefined && (
                <span className="text-sm font-medium">
                  {calculatedTrendValue > 0 ? '+' : ''}{calculatedTrendValue.toFixed(1)}%
                </span>
              )}
            </span>
            {previousValue !== undefined && (
              <span className="text-xs text-matrix-muted">
                vs {formatValue(previousValue)}
              </span>
            )}
          </div>
        )}

        {/* Footer */}
        {footer && (
          <div className="mt-4 border-t border-matrix-border pt-3 text-xs text-matrix-muted">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
