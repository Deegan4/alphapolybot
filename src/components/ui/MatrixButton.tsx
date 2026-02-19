import React from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/utils/cn'

interface MatrixButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  children: React.ReactNode
}

/**
 * MatrixButton - Agent-styled button with press animation
 */
export const MatrixButton: React.FC<MatrixButtonProps> = ({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...props
}) => {
  const baseStyles = `
    relative font-mono font-medium rounded-md
    transition-all duration-200
    border border-agent-green/30
    disabled:opacity-50 disabled:cursor-not-allowed
    focus:outline-none focus:ring-2 focus:ring-agent-green/50
  `

  const variants = {
    primary: `
      bg-agent-green/10 text-agent-green
      hover:bg-agent-green/20 hover:border-agent-green/50
      active:bg-agent-green/30
    `,
    secondary: `
      bg-agent-orange/10 text-agent-orange
      border-agent-orange/30
      hover:bg-agent-orange/20 hover:border-agent-orange/50
      active:bg-agent-orange/30
    `,
    danger: `
      bg-agent-red/10 text-agent-red
      border-agent-red/30
      hover:bg-agent-red/20 hover:border-agent-red/50
      active:bg-agent-red/30
    `,
    ghost: `
      bg-transparent text-agent-text-muted
      border-transparent
      hover:bg-agent-green/10 hover:text-agent-green
      hover:border-agent-green/30
    `,
  }

  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  }

  const isDisabled = disabled || loading

  return (
    <motion.button
      className={cn(baseStyles, variants[variant], sizes[size], className)}
      disabled={isDisabled}
      whileTap={!isDisabled ? { scale: 0.97 } : undefined}
      whileHover={!isDisabled ? { scale: 1.02 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      {...(props as any)}
    >
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <motion.span
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
            className="inline-block"
          >
            ◌
          </motion.span>
          <span>{children}</span>
        </span>
      ) : (
        children
      )}
    </motion.button>
  )
}

export default MatrixButton
