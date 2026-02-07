import React from 'react'
import { cn } from '@/utils/cn'

interface MatrixCardProps {
  title?: string
  subtitle?: string
  className?: string
  headerClassName?: string
  bodyClassName?: string
  children: React.ReactNode
  glow?: boolean
  variant?: 'default' | 'terminal' | 'stats'
}

/**
 * MatrixCard - Container with Matrix theme styling
 */
export const MatrixCard: React.FC<MatrixCardProps> = ({
  title,
  subtitle,
  className,
  headerClassName,
  bodyClassName,
  children,
  glow = false,
  variant = 'default',
}) => {
  const variants = {
    default: 'bg-matrix-card border-matrix-border',
    terminal: 'bg-matrix-bg border-matrix-primary/30',
    stats: 'bg-gradient-to-br from-matrix-card to-matrix-bg border-matrix-primary/20',
  }

  return (
    <div
      className={cn(
        'rounded-lg border',
        variants[variant],
        glow && 'shadow-[0_0_20px_rgba(0,255,0,0.1)]',
        className
      )}
    >
      {(title || subtitle) && (
        <div
          className={cn(
            'px-4 py-3 border-b border-matrix-border',
            headerClassName
          )}
        >
          {title && (
            <h3 className="text-matrix-primary font-mono font-semibold">
              {title}
            </h3>
          )}
          {subtitle && (
            <p className="text-matrix-text-secondary text-sm mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </div>
  )
}

export default MatrixCard
