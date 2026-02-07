import React from 'react'
import { cn } from '@/utils/cn'

interface MatrixLoadingProps {
  size?: 'sm' | 'md' | 'lg'
  text?: string
  className?: string
}

/**
 * MatrixLoading - Animated loading indicator with Matrix theme
 */
export const MatrixLoading: React.FC<MatrixLoadingProps> = ({
  size = 'md',
  text,
  className,
}) => {
  const sizes = {
    sm: 'w-4 h-4',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
  }

  return (
    <div className={cn('flex flex-col items-center justify-center gap-3', className)}>
      <div className="relative">
        {/* Outer ring */}
        <div
          className={cn(
            'border-2 border-matrix-primary/20 rounded-full',
            sizes[size]
          )}
        />
        {/* Animated arc */}
        <div
          className={cn(
            'absolute top-0 left-0 border-2 border-transparent border-t-matrix-primary rounded-full animate-spin',
            sizes[size]
          )}
        />
        {/* Glow effect */}
        <div
          className={cn(
            'absolute top-0 left-0 border-2 border-transparent border-t-matrix-primary/50 rounded-full animate-spin blur-sm',
            sizes[size]
          )}
          style={{ animationDuration: '1s' }}
        />
      </div>
      {text && (
        <span className="text-matrix-text-secondary font-mono text-sm animate-pulse">
          {text}
        </span>
      )}
    </div>
  )
}

/**
 * MatrixLoadingDots - Typing indicator style loading
 */
export const MatrixLoadingDots: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <span className="w-2 h-2 bg-matrix-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-2 h-2 bg-matrix-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-2 h-2 bg-matrix-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
    </div>
  )
}

/**
 * MatrixLoadingBar - Progress bar style loading
 */
export const MatrixLoadingBar: React.FC<{ progress?: number; className?: string }> = ({
  progress,
  className,
}) => {
  const indeterminate = progress === undefined

  return (
    <div className={cn('w-full h-1 bg-matrix-border rounded-full overflow-hidden', className)}>
      <div
        className={cn(
          'h-full bg-matrix-primary transition-all duration-300',
          indeterminate && 'animate-matrix-loading'
        )}
        style={!indeterminate ? { width: `${progress}%` } : undefined}
      />
    </div>
  )
}

/**
 * MatrixSkeleton - Skeleton loading placeholder
 */
export const MatrixSkeleton: React.FC<{
  className?: string
  variant?: 'text' | 'circular' | 'rectangular'
}> = ({ className, variant = 'text' }) => {
  const variants = {
    text: 'h-4 rounded',
    circular: 'rounded-full',
    rectangular: 'rounded-md',
  }

  return (
    <div
      className={cn(
        'bg-matrix-border/50 animate-pulse',
        variants[variant],
        className
      )}
    />
  )
}

export default MatrixLoading
