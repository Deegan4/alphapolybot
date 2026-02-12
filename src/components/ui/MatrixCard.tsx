import React from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/utils/cn'

interface MatrixCardProps {
  title?: string
  subtitle?: string
  className?: string
  headerClassName?: string
  bodyClassName?: string
  children: React.ReactNode
  glow?: boolean
  hover?: boolean
  variant?: 'default' | 'terminal' | 'stats' | 'glass' | 'gradient'
}

/**
 * MatrixCard - Container with agent theme styling
 * Variants: default, terminal, stats, glass, gradient
 */
export const MatrixCard: React.FC<MatrixCardProps> = ({
  title,
  subtitle,
  className,
  headerClassName,
  bodyClassName,
  children,
  glow = false,
  hover = false,
  variant = 'default',
}) => {
  const variants = {
    default: 'bg-agent-card border-agent-border',
    terminal: 'bg-agent-bg border-agent-green/30',
    stats: 'bg-agent-card border-agent-border',
    glass: 'bg-agent-card/60 backdrop-blur-md border border-agent-border/50',
    gradient: 'bg-agent-card/80 backdrop-blur-sm border border-agent-border',
  }

  const content = (
    <>
      {(title || subtitle) && (
        <div
          className={cn(
            'px-4 py-3 border-b border-agent-border/50',
            headerClassName
          )}
        >
          {title && (
            <h3 className="text-agent-text font-mono font-semibold">
              {title}
            </h3>
          )}
          {subtitle && (
            <p className="text-agent-text-muted font-sans text-sm mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </>
  )

  const classes = cn(
    'rounded-lg',
    variant !== 'glass' && variant !== 'gradient' && 'border',
    variants[variant],
    className
  )

  if (hover) {
    return (
      <motion.div
        className={classes}
        whileHover={{ scale: 1.01, y: -2 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      >
        {content}
      </motion.div>
    )
  }

  return <div className={classes}>{content}</div>
}

export default MatrixCard
