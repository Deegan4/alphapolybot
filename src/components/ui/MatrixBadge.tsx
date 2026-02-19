import React from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/utils/cn'

interface MatrixBadgeProps {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info'
  size?: 'sm' | 'md'
  pulse?: boolean
  children: React.ReactNode
  className?: string
}

/**
 * MatrixBadge - Status badge with pop-in animation
 */
export const MatrixBadge: React.FC<MatrixBadgeProps> = ({
  variant = 'default',
  size = 'md',
  pulse = false,
  children,
  className,
}) => {
  const variants = {
    default: 'bg-agent-border/50 text-agent-text-muted border-agent-border',
    success: 'bg-agent-green/10 text-agent-green border-agent-green/30',
    warning: 'bg-agent-orange/10 text-agent-orange border-agent-orange/30',
    danger: 'bg-agent-red/10 text-agent-red border-agent-red/30',
    info: 'bg-agent-cyan/10 text-agent-cyan border-agent-cyan/30',
  }

  const sizes = {
    sm: 'px-1.5 py-0.5 text-xs',
    md: 'px-2 py-1 text-sm',
  }

  return (
    <motion.span
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 400, damping: 20 }}
      layout
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
              variant === 'success' && 'bg-agent-green',
              variant === 'warning' && 'bg-agent-orange',
              variant === 'danger' && 'bg-agent-red',
              variant === 'info' && 'bg-agent-cyan',
              variant === 'default' && 'bg-agent-text-muted'
            )}
          />
          <span
            className={cn(
              'relative inline-flex rounded-full h-2 w-2',
              variant === 'success' && 'bg-agent-green',
              variant === 'warning' && 'bg-agent-orange',
              variant === 'danger' && 'bg-agent-red',
              variant === 'info' && 'bg-agent-cyan',
              variant === 'default' && 'bg-agent-text-muted'
            )}
          />
        </span>
      )}
      {children}
    </motion.span>
  )
}

export default MatrixBadge
