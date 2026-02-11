import React from 'react'
import { motion } from 'framer-motion'
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
        <motion.div
          className={cn(
            'absolute top-0 left-0 border-2 border-transparent border-t-matrix-primary rounded-full',
            sizes[size]
          )}
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
        />
        {/* Glow effect */}
        <motion.div
          className={cn(
            'absolute top-0 left-0 border-2 border-transparent border-t-matrix-primary/50 rounded-full blur-sm',
            sizes[size]
          )}
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
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
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-2 h-2 bg-matrix-primary rounded-full"
          animate={{ y: [0, -6, 0] }}
          transition={{ repeat: Infinity, duration: 0.6, delay: i * 0.15, ease: 'easeInOut' }}
        />
      ))}
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
      {indeterminate ? (
        <motion.div
          className="h-full bg-gradient-to-r from-matrix-primary to-matrix-cyan"
          animate={{ x: ['-100%', '100%'] }}
          transition={{ repeat: Infinity, duration: 1.5, ease: 'easeInOut' }}
          style={{ width: '40%' }}
        />
      ) : (
        <motion.div
          className="h-full bg-gradient-to-r from-matrix-primary to-matrix-cyan"
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.3 }}
        />
      )}
    </div>
  )
}

/**
 * MatrixSkeleton - Skeleton loading placeholder with shimmer
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
        'skeleton-shimmer',
        variants[variant],
        className
      )}
    />
  )
}

export default MatrixLoading
