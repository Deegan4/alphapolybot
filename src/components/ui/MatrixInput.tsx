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
 * MatrixInput - Text input with Matrix theme styling
 */
export const MatrixInput = forwardRef<HTMLInputElement, MatrixInputProps>(
  ({ label, error, hint, leftIcon, rightIcon, className, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-matrix-text-secondary text-sm font-mono mb-1.5">
            {label}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-matrix-text-secondary">
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            className={cn(
              'w-full bg-matrix-bg border border-matrix-border rounded-md',
              'px-4 py-2 font-mono text-sm text-matrix-text-primary',
              'placeholder:text-matrix-text-secondary/50',
              'focus:outline-none focus:border-matrix-primary/50',
              'focus:shadow-[0_0_10px_rgba(0,255,0,0.2)]',
              'transition-all duration-200',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              leftIcon && 'pl-10',
              rightIcon && 'pr-10',
              error && 'border-red-500/50 focus:border-red-500/70',
              className
            )}
            {...props}
          />
          {rightIcon && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-matrix-text-secondary">
              {rightIcon}
            </div>
          )}
        </div>
        {error && (
          <p className="mt-1.5 text-xs text-red-400 font-mono">{error}</p>
        )}
        {hint && !error && (
          <p className="mt-1.5 text-xs text-matrix-text-secondary font-mono">
            {hint}
          </p>
        )}
      </div>
    )
  }
)

MatrixInput.displayName = 'MatrixInput'

export default MatrixInput
