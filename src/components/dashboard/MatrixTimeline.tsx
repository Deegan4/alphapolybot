import React from 'react'
import { cn } from '../../utils'
import { matrixChartTheme } from '../charts/shared/chartTheme'

export interface TimelineItem {
  id: string
  title: string
  description?: string
  timestamp: string | Date
  type?: 'default' | 'success' | 'warning' | 'error' | 'info'
  icon?: React.ReactNode
  meta?: React.ReactNode
}

export interface MatrixTimelineProps {
  items: TimelineItem[]
  maxItems?: number
  showTimestamp?: boolean
  timestampFormat?: (date: Date) => string
  onItemClick?: (item: TimelineItem) => void
  emptyMessage?: string
  className?: string
}

const typeStyles = {
  default: {
    dot: 'bg-matrix-muted',
    line: 'bg-matrix-border',
    text: 'text-matrix-primary',
  },
  success: {
    dot: 'bg-matrix-primary',
    line: 'bg-matrix-primary/30',
    text: 'text-matrix-primary',
  },
  warning: {
    dot: 'bg-matrix-orange',
    line: 'bg-matrix-orange/30',
    text: 'text-matrix-orange',
  },
  error: {
    dot: 'bg-matrix-red',
    line: 'bg-matrix-red/30',
    text: 'text-matrix-red',
  },
  info: {
    dot: 'bg-cyan-400',
    line: 'bg-cyan-400/30',
    text: 'text-cyan-400',
  },
}

const defaultTimestampFormat = (date: Date): string => {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  
  return date.toLocaleDateString()
}

export const MatrixTimeline: React.FC<MatrixTimelineProps> = ({
  items,
  maxItems,
  showTimestamp = true,
  timestampFormat = defaultTimestampFormat,
  onItemClick,
  emptyMessage = 'No activity',
  className,
}) => {
  const displayItems = maxItems ? items.slice(0, maxItems) : items

  if (displayItems.length === 0) {
    return (
      <div className={cn('py-8 text-center font-mono text-sm text-matrix-muted', className)}>
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className={cn('font-mono', className)}>
      {displayItems.map((item, index) => {
        const style = typeStyles[item.type ?? 'default']
        const isLast = index === displayItems.length - 1
        const date = typeof item.timestamp === 'string' 
          ? new Date(item.timestamp) 
          : item.timestamp

        return (
          <div
            key={item.id}
            className={cn(
              'relative flex gap-4 pb-4',
              onItemClick && 'cursor-pointer'
            )}
            onClick={() => onItemClick?.(item)}
          >
            {/* Timeline line and dot */}
            <div className="flex flex-col items-center">
              {/* Dot */}
              <div
                className={cn(
                  'relative z-10 flex h-3 w-3 items-center justify-center rounded-full',
                  style.dot
                )}
                style={{
                  boxShadow: `0 0 8px ${style.dot.includes('primary') ? matrixChartTheme.colors.primary : style.dot.includes('orange') ? matrixChartTheme.colors.secondary : style.dot.includes('red') ? matrixChartTheme.colors.loss : 'transparent'}`,
                }}
              >
                {item.icon && (
                  <span className="absolute -left-0.5 -top-0.5">
                    {item.icon}
                  </span>
                )}
              </div>
              
              {/* Line */}
              {!isLast && (
                <div className={cn('w-0.5 flex-1', style.line)} />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 pb-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className={cn('text-sm font-medium', style.text)}>
                    {item.title}
                  </p>
                  {item.description && (
                    <p className="mt-0.5 text-xs text-matrix-muted">
                      {item.description}
                    </p>
                  )}
                </div>
                {showTimestamp && (
                  <span className="shrink-0 text-xs text-matrix-muted">
                    {timestampFormat(date)}
                  </span>
                )}
              </div>
              {item.meta && (
                <div className="mt-2">{item.meta}</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
