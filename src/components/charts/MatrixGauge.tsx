import React from 'react'
import { cn } from '../../utils'
import { matrixChartTheme, getValueColor } from './shared/chartTheme'

export interface MatrixGaugeProps {
  value: number
  min?: number
  max?: number
  label?: string
  valueLabel?: string
  size?: 'sm' | 'md' | 'lg'
  showValue?: boolean
  colorByValue?: boolean
  color?: string
  trackColor?: string
  className?: string
}

const sizeConfig = {
  sm: { size: 80, strokeWidth: 6, fontSize: 'text-xs', labelSize: 'text-[10px]' },
  md: { size: 120, strokeWidth: 8, fontSize: 'text-sm', labelSize: 'text-xs' },
  lg: { size: 160, strokeWidth: 10, fontSize: 'text-lg', labelSize: 'text-sm' },
}

export const MatrixGauge: React.FC<MatrixGaugeProps> = ({
  value,
  min = 0,
  max = 100,
  label,
  valueLabel,
  size = 'md',
  showValue = true,
  colorByValue = false,
  color,
  trackColor,
  className,
}) => {
  const config = sizeConfig[size]
  const radius = (config.size - config.strokeWidth) / 2
  const circumference = radius * Math.PI // Semi-circle
  
  // Clamp value between min and max
  const clampedValue = Math.max(min, Math.min(max, value))
  const percentage = (clampedValue - min) / (max - min)
  const strokeDashoffset = circumference * (1 - percentage)

  // Determine color
  const gaugeColor = colorByValue
    ? getValueColor(value - (min + max) / 2)
    : color ?? matrixChartTheme.colors.primary

  const track = trackColor ?? matrixChartTheme.colors.grid

  return (
    <div className={cn('flex flex-col items-center', className)}>
      <svg
        width={config.size}
        height={config.size / 2 + config.strokeWidth}
        viewBox={`0 0 ${config.size} ${config.size / 2 + config.strokeWidth}`}
      >
        {/* Background track */}
        <path
          d={`M ${config.strokeWidth / 2} ${config.size / 2}
              A ${radius} ${radius} 0 0 1 ${config.size - config.strokeWidth / 2} ${config.size / 2}`}
          fill="none"
          stroke={track}
          strokeWidth={config.strokeWidth}
          strokeLinecap="round"
        />
        
        {/* Value arc */}
        <path
          d={`M ${config.strokeWidth / 2} ${config.size / 2}
              A ${radius} ${radius} 0 0 1 ${config.size - config.strokeWidth / 2} ${config.size / 2}`}
          fill="none"
          stroke={gaugeColor}
          strokeWidth={config.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{
            filter: `drop-shadow(0 0 4px ${gaugeColor}80)`,
            transition: 'stroke-dashoffset 0.5s ease-out',
          }}
        />

        {/* Center value text */}
        {showValue && (
          <text
            x={config.size / 2}
            y={config.size / 2 - 5}
            textAnchor="middle"
            fill={gaugeColor}
            className={cn('font-mono font-bold', config.fontSize)}
          >
            {valueLabel ?? `${Math.round(percentage * 100)}%`}
          </text>
        )}
      </svg>
      
      {/* Label */}
      {label && (
        <span
          className={cn(
            'mt-1 font-mono text-matrix-muted',
            config.labelSize
          )}
        >
          {label}
        </span>
      )}
    </div>
  )
}

// Circular gauge variant
export interface MatrixProgressRingProps {
  value: number
  max?: number
  size?: 'sm' | 'md' | 'lg'
  showValue?: boolean
  valueLabel?: string
  label?: string
  color?: string
  className?: string
}

const ringConfig = {
  sm: { size: 60, strokeWidth: 4, fontSize: 'text-xs', labelSize: 'text-[10px]' },
  md: { size: 80, strokeWidth: 6, fontSize: 'text-sm', labelSize: 'text-xs' },
  lg: { size: 100, strokeWidth: 8, fontSize: 'text-base', labelSize: 'text-sm' },
}

export const MatrixProgressRing: React.FC<MatrixProgressRingProps> = ({
  value,
  max = 100,
  size = 'md',
  showValue = true,
  valueLabel,
  label,
  color,
  className,
}) => {
  const config = ringConfig[size]
  const radius = (config.size - config.strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  
  const percentage = Math.min(value / max, 1)
  const strokeDashoffset = circumference * (1 - percentage)
  
  const ringColor = color ?? matrixChartTheme.colors.primary

  return (
    <div className={cn('flex flex-col items-center', className)}>
      <svg width={config.size} height={config.size} className="-rotate-90">
        {/* Background circle */}
        <circle
          cx={config.size / 2}
          cy={config.size / 2}
          r={radius}
          fill="none"
          stroke={matrixChartTheme.colors.grid}
          strokeWidth={config.strokeWidth}
        />
        
        {/* Progress circle */}
        <circle
          cx={config.size / 2}
          cy={config.size / 2}
          r={radius}
          fill="none"
          stroke={ringColor}
          strokeWidth={config.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{
            filter: `drop-shadow(0 0 4px ${ringColor}80)`,
            transition: 'stroke-dashoffset 0.5s ease-out',
          }}
        />
      </svg>
      
      {/* Center text overlay */}
      {showValue && (
        <div
          className="absolute flex items-center justify-center"
          style={{ width: config.size, height: config.size }}
        >
          <span
            className={cn('font-mono font-bold text-matrix-primary', config.fontSize)}
          >
            {valueLabel ?? `${Math.round(percentage * 100)}%`}
          </span>
        </div>
      )}
      
      {label && (
        <span className={cn('mt-1 font-mono text-matrix-muted', config.labelSize)}>
          {label}
        </span>
      )}
    </div>
  )
}
