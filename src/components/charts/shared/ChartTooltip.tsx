import React from 'react'
import { matrixChartTheme, getValueColor } from './chartTheme'

export interface TooltipPayload {
  name: string
  value: number
  color?: string
  dataKey?: string
  payload?: Record<string, unknown>
}

export interface ChartTooltipProps {
  active?: boolean
  payload?: TooltipPayload[]
  label?: string
  formatter?: (value: number, name: string) => string
  labelFormatter?: (label: string) => string
  showValue?: boolean
  valuePrefix?: string
  valueSuffix?: string
}

export const ChartTooltip: React.FC<ChartTooltipProps> = ({
  active,
  payload,
  label,
  formatter,
  labelFormatter,
  showValue = true,
  valuePrefix = '',
  valueSuffix = '',
}) => {
  if (!active || !payload?.length) return null

  const formattedLabel = labelFormatter ? labelFormatter(label ?? '') : label

  return (
    <div
      className="rounded border border-matrix-border bg-matrix-bg p-3 font-mono text-xs"
      style={{
        boxShadow: matrixChartTheme.glow.primary,
      }}
    >
      {formattedLabel && (
        <p className="mb-2 text-matrix-muted">{formattedLabel}</p>
      )}
      <div className="space-y-1">
        {payload.map((entry, index) => {
          const value = formatter
            ? formatter(entry.value, entry.name)
            : `${valuePrefix}${entry.value.toLocaleString()}${valueSuffix}`
          
          const color = entry.color ?? getValueColor(entry.value)
          
          return (
            <div key={index} className="flex items-center justify-between gap-4">
              <span style={{ color }}>{entry.name}</span>
              {showValue && (
                <span className="font-semibold" style={{ color }}>
                  {value}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
