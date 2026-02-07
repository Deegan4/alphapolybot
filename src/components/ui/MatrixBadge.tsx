import React from 'react'
import { cn } from '@/utils/cn'

interface MatrixBadgeProps {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info'
  size?: 'sm' | 'md'
  pulse?: boolean
  children: React.ReactNode
  className?: string
}

/**
 * MatrixBadge - Status badge with Matrix theme
 */
export const MatrixBadge: React.FC<MatrixBadgeProps> = ({
  variant = 'default',
  size = 'md',
  pulse = false,
  children,
  className,
}) => {
  const variants = {
    default: 'bg-matrix-border/50 text-matrix-text-secondary border-matrix-border',
    success: 'bg-matrix-primary/10 text-matrix-primary border-matrix-primary/30',
    warning: 'bg-matrix-secondary/10 text-matrix-secondary border-matrix-secondary/30',
    danger: 'bg-red-500/10 text-red-400 border-red-500/30',
    info: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  }

  const sizes = {
    sm: 'px-1.5 py-0.5 text-xs',
    md: 'px-2 py-1 text-sm',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-mono border rounded',
        variants[variant],
        sizes[size],
        className
      )}
    >
      {pulse && (
        <span className="relative flex h-2 w-2">
          <span
            className={cn(
              'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
              variant === 'success' && 'bg-matrix-primary',
              variant === 'warning' && 'bg-matrix-secondary',
              variant === 'danger' && 'bg-red-400',
              variant === 'info' && 'bg-blue-400',
              variant === 'default' && 'bg-matrix-text-secondary'
            )}
          />
          <span
            className={cn(
              'relative inline-flex rounded-full h-2 w-2',
              variant === 'success' && 'bg-matrix-primary',
              variant === 'warning' && 'bg-matrix-secondary',
              variant === 'danger' && 'bg-red-400',
              variant === 'info' && 'bg-blue-400',
              variant === 'default' && 'bg-matrix-text-secondary'
            )}
          />
        </span>
      )}
      {children}
    </span>
  )
}

export default MatrixBadge
