import React, { forwardRef, useId } from 'react'
import { cn } from '../../utils'

export interface MatrixCheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string
  description?: string
}

export const MatrixCheckbox = forwardRef<HTMLInputElement, MatrixCheckboxProps>(
  ({ className, label, description, id, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId

    return (
      <div className={cn('flex items-start gap-3', className)}>
        <div className="relative flex items-center">
          <input
            ref={ref}
            type="checkbox"
            id={inputId}
            className="peer sr-only"
            {...props}
          />
          <div
            className={cn(
              'flex h-5 w-5 cursor-pointer items-center justify-center',
              'rounded border border-matrix-border bg-matrix-bg',
              'transition-all duration-200',
              'peer-focus:border-matrix-primary/50 peer-focus:shadow-[0_0_10px_rgba(0,255,0,0.2)]',
              'peer-checked:border-matrix-primary peer-checked:bg-matrix-primary/20',
              'peer-disabled:cursor-not-allowed peer-disabled:opacity-50'
            )}
          >
            {/* Checkmark */}
            <svg
              className={cn(
                'h-3 w-3 text-matrix-primary opacity-0 transition-opacity',
                'peer-checked:opacity-100'
              )}
              style={{ opacity: props.checked ? 1 : 0 }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        </div>
        {(label || description) && (
          <div className="flex flex-col">
            {label && (
              <label
                htmlFor={inputId}
                className="cursor-pointer font-mono text-sm text-matrix-primary"
              >
                {label}
              </label>
            )}
            {description && (
              <span className="font-mono text-xs text-matrix-muted">
                {description}
              </span>
            )}
          </div>
        )}
      </div>
    )
  }
)

MatrixCheckbox.displayName = 'MatrixCheckbox'
