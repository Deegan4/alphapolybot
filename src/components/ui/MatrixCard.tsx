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
 * MatrixCard - Container with Matrix theme styling
 * Variants: default, terminal, stats, glass (glassmorphism), gradient (green-to-cyan border)
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
    default: 'bg-matrix-card border-matrix-border',
    terminal: 'bg-matrix-bg border-matrix-primary/30',
    stats: 'bg-gradient-to-br from-matrix-card to-matrix-bg border-matrix-primary/20',
    glass: 'glass-card',
    gradient: 'gradient-border bg-matrix-card/80 backdrop-blur-sm border border-transparent',
  }

  const content = (
    <>
      {(title || subtitle) && (
        <div
          className={cn(
            'px-4 py-3 border-b border-matrix-border/50',
            headerClassName
          )}
        >
          {title && (
            <h3 className="text-matrix-primary font-mono font-semibold">
              {title}
            </h3>
          )}
          {subtitle && (
            <p className="text-matrix-text-secondary font-sans text-sm mt-0.5">
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
    glow && 'shadow-[0_0_20px_rgba(0,255,0,0.1)]',
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
