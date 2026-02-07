import React, { forwardRef, useId } from 'react'
import { cn } from '../../utils'

export interface MatrixTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  hint?: string
}

export const MatrixTextarea = forwardRef<HTMLTextAreaElement, MatrixTextareaProps>(
  ({ className, label, error, hint, id, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="mb-1 block text-xs font-medium uppercase tracking-wider text-matrix-muted"
          >
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          className={cn(
            'min-h-[100px] w-full resize-y rounded border border-matrix-border',
            'bg-matrix-bg px-3 py-2 font-mono text-sm text-matrix-primary',
            'placeholder:text-matrix-muted/50',
            'focus:border-matrix-primary/50 focus:outline-none',
            'focus:shadow-[0_0_10px_rgba(0,255,0,0.2)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'transition-all duration-200',
            error && 'border-matrix-red focus:border-matrix-red focus:shadow-[0_0_10px_rgba(255,0,64,0.2)]',
            className
          )}
          {...props}
        />
        {(error || hint) && (
          <p
            className={cn(
              'mt-1 text-xs',
              error ? 'text-matrix-red' : 'text-matrix-muted'
            )}
          >
            {error ?? hint}
          </p>
        )}
      </div>
    )
  }
)

MatrixTextarea.displayName = 'MatrixTextarea'
