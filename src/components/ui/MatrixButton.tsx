import React from 'react'
import { cn } from '@/utils/cn'

interface MatrixButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  children: React.ReactNode
}

/**
 * MatrixButton - Neon-styled button with Matrix theme
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
    relative font-mono font-medium
    transition-all duration-200
    border border-matrix-primary/30
    disabled:opacity-50 disabled:cursor-not-allowed
    focus:outline-none focus:ring-2 focus:ring-matrix-primary/50
  `

  const variants = {
    primary: `
      bg-matrix-primary/10 text-matrix-primary
      hover:bg-matrix-primary/20 hover:border-matrix-primary/50
      hover:shadow-[0_0_15px_rgba(0,255,0,0.3)]
      active:bg-matrix-primary/30
    `,
    secondary: `
      bg-matrix-secondary/10 text-matrix-secondary
      border-matrix-secondary/30
      hover:bg-matrix-secondary/20 hover:border-matrix-secondary/50
      hover:shadow-[0_0_15px_rgba(255,165,0,0.3)]
      active:bg-matrix-secondary/30
    `,
    danger: `
      bg-red-500/10 text-red-400
      border-red-500/30
      hover:bg-red-500/20 hover:border-red-500/50
      hover:shadow-[0_0_15px_rgba(239,68,68,0.3)]
      active:bg-red-500/30
    `,
    ghost: `
      bg-transparent text-matrix-text-secondary
      border-transparent
      hover:bg-matrix-primary/10 hover:text-matrix-primary
      hover:border-matrix-primary/30
    `,
  }

  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  }

  return (
    <button
      className={cn(baseStyles, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <span className="animate-spin">◌</span>
          <span>{children}</span>
        </span>
      ) : (
        children
      )}
    </button>
  )
}

export default MatrixButton
