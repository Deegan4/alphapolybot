import React from 'react'
import { cn } from '../../../utils'

export interface LegendItem {
  value: string
  color: string
  type?: 'line' | 'square' | 'circle'
}

export interface ChartLegendProps {
  payload?: LegendItem[]
  align?: 'left' | 'center' | 'right'
  className?: string
}

export const ChartLegend: React.FC<ChartLegendProps> = ({
  payload,
  align = 'center',
  className,
}) => {
  if (!payload?.length) return null

  const alignmentClass = {
    left: 'justify-start',
    center: 'justify-center',
    right: 'justify-end',
  }[align]

  return (
    <div
      className={cn(
        'flex flex-wrap gap-4 px-2 py-1 font-mono text-xs',
        alignmentClass,
        className
      )}
    >
      {payload.map((entry, index) => (
        <div key={index} className="flex items-center gap-2">
          <LegendIcon type={entry.type ?? 'square'} color={entry.color} />
          <span className="text-matrix-muted">{entry.value}</span>
        </div>
      ))}
    </div>
  )
}

interface LegendIconProps {
  type: 'line' | 'square' | 'circle'
  color: string
}

const LegendIcon: React.FC<LegendIconProps> = ({ type, color }) => {
  switch (type) {
    case 'line':
      return (
        <div
          className="h-0.5 w-4"
          style={{ backgroundColor: color }}
        />
      )
    case 'circle':
      return (
        <div
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: color }}
        />
      )
    case 'square':
    default:
      return (
        <div
          className="h-2.5 w-2.5"
          style={{ backgroundColor: color }}
        />
      )
  }
}
