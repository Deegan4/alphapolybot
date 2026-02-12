import React, { forwardRef } from 'react'
import { cn } from '@/utils/cn'

interface MatrixInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
}

/**
 * MatrixInput - Text input with agent theme styling
 */
export const MatrixInput = forwardRef<HTMLInputElement, MatrixInputProps>(
  ({ label, error, hint, leftIcon, rightIcon, className, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-agent-text-muted text-sm font-mono mb-1.5">
            {label}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-agent-text-muted">
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            className={cn(
              'w-full bg-agent-bg border border-agent-border rounded-md',
              'px-4 py-2 font-mono text-sm text-agent-text',
              'placeholder:text-agent-text-muted/50',
              'focus:outline-none focus:border-agent-green/50',
              'focus:ring-1 focus:ring-agent-green/30',
              'transition-all duration-200',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              leftIcon && 'pl-10',
              rightIcon && 'pr-10',
              error && 'border-agent-red/50 focus:border-agent-red/70',
              className
            )}
            {...props}
          />
          {rightIcon && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-agent-text-muted">
              {rightIcon}
            </div>
          )}
        </div>
        {error && (
          <p className="mt-1.5 text-xs text-agent-red font-mono">{error}</p>
        )}
        {hint && !error && (
          <p className="mt-1.5 text-xs text-agent-text-muted font-mono">
            {hint}
          </p>
        )}
      </div>
    )
  }
)

MatrixInput.displayName = 'MatrixInput'

export default MatrixInput
