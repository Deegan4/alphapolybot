import React from 'react'
import { cn } from '../../utils'
import { MatrixSparkline } from '../charts/MatrixSparkline'
import { getValueColor } from '../charts/shared/chartTheme'

export interface MatrixStatWidgetProps {
  title: string
  value: string | number
  subtitle?: string
  change?: number
  changeLabel?: string
  sparklineData?: number[]
  icon?: React.ReactNode
  variant?: 'default' | 'success' | 'warning' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const variantStyles = {
  default: {
    border: 'border-matrix-border',
    glow: '',
    accent: 'text-matrix-primary',
  },
  success: {
    border: 'border-matrix-primary/50',
    glow: 'shadow-[0_0_10px_rgba(0,255,0,0.2)]',
    accent: 'text-matrix-primary',
  },
  warning: {
    border: 'border-matrix-orange/50',
    glow: 'shadow-[0_0_10px_rgba(255,165,0,0.2)]',
    accent: 'text-matrix-orange',
  },
  danger: {
    border: 'border-matrix-red/50',
    glow: 'shadow-[0_0_10px_rgba(255,0,64,0.2)]',
    accent: 'text-matrix-red',
  },
}

const sizeStyles = {
  sm: {
    padding: 'p-3',
    title: 'text-xs',
    value: 'text-lg',
    subtitle: 'text-[10px]',
    sparklineHeight: 24,
  },
  md: {
    padding: 'p-4',
    title: 'text-xs',
    value: 'text-2xl',
    subtitle: 'text-xs',
    sparklineHeight: 32,
  },
  lg: {
    padding: 'p-5',
    title: 'text-sm',
    value: 'text-3xl',
    subtitle: 'text-sm',
    sparklineHeight: 40,
  },
}

export const MatrixStatWidget: React.FC<MatrixStatWidgetProps> = ({
  title,
  value,
  subtitle,
  change,
  changeLabel,
  sparklineData,
  icon,
  variant = 'default',
  size = 'md',
  className,
}) => {
  const variantStyle = variantStyles[variant]
  const sizeStyle = sizeStyles[size]

  const changeColor = change !== undefined ? getValueColor(change) : undefined
  const changePrefix = change !== undefined && change > 0 ? '+' : ''

  return (
    <div
      className={cn(
        'rounded-lg border bg-matrix-card font-mono transition-all duration-200',
        'hover:border-matrix-primary/30',
        variantStyle.border,
        variantStyle.glow,
        sizeStyle.padding,
        className
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          {/* Title */}
          <p className={cn('uppercase tracking-wider text-matrix-muted', sizeStyle.title)}>
            {title}
          </p>

          {/* Value */}
          <p className={cn('font-bold', variantStyle.accent, sizeStyle.value)}>
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>

          {/* Change indicator */}
          {change !== undefined && (
            <div className="mt-1 flex items-center gap-1">
              <span className={sizeStyle.subtitle} style={{ color: changeColor }}>
                {changePrefix}{change.toFixed(2)}%
              </span>
              {changeLabel && (
                <span className={cn('text-matrix-muted', sizeStyle.subtitle)}>
                  {changeLabel}
                </span>
              )}
            </div>
          )}

          {/* Subtitle */}
          {subtitle && !change && (
            <p className={cn('mt-1 text-matrix-muted', sizeStyle.subtitle)}>
              {subtitle}
            </p>
          )}
        </div>

        {/* Icon */}
        {icon && (
          <div className={cn('text-matrix-muted', variantStyle.accent)}>
            {icon}
          </div>
        )}
      </div>

      {/* Sparkline */}
      {sparklineData && sparklineData.length > 0 && (
        <div className="mt-3">
          <MatrixSparkline
            data={sparklineData}
            height={sizeStyle.sparklineHeight}
            colorByTrend
          />
        </div>
      )}
    </div>
  )
}
