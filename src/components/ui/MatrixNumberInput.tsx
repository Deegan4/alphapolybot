import React, { forwardRef, useId, useState, useCallback } from 'react'
import { cn } from '../../utils'

export interface MatrixNumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  label?: string
  error?: string
  hint?: string
  min?: number
  max?: number
  step?: number
  showControls?: boolean
  precision?: number
  prefix?: string
  suffix?: string
  onChange?: (value: number | undefined) => void
}

export const MatrixNumberInput = forwardRef<HTMLInputElement, MatrixNumberInputProps>(
  (
    {
      className,
      label,
      error,
      hint,
      min,
      max,
      step = 1,
      showControls = true,
      precision,
      prefix,
      suffix,
      onChange,
      value,
      defaultValue,
      id,
      disabled,
      ...props
    },
    ref
  ) => {
    const generatedId = useId()
    const inputId = id ?? generatedId

    const [internalValue, setInternalValue] = useState<string>(
      (value ?? defaultValue ?? '').toString()
    )

    const currentValue = value !== undefined ? value.toString() : internalValue

    const clampValue = (val: number): number => {
      let clamped = val
      if (min !== undefined) clamped = Math.max(min, clamped)
      if (max !== undefined) clamped = Math.min(max, clamped)
      if (precision !== undefined) {
        clamped = Number(clamped.toFixed(precision))
      }
      return clamped
    }

    const updateValue = useCallback(
      (newValue: number | undefined) => {
        if (newValue === undefined) {
          setInternalValue('')
          onChange?.(undefined)
        } else {
          const clamped = clampValue(newValue)
          setInternalValue(clamped.toString())
          onChange?.(clamped)
        }
      },
      [onChange, min, max, precision]
    )

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value
      setInternalValue(val)
      
      if (val === '' || val === '-') {
        onChange?.(undefined)
      } else {
        const num = parseFloat(val)
        if (!isNaN(num)) {
          onChange?.(clampValue(num))
        }
      }
    }

    const handleBlur = () => {
      if (currentValue === '' || currentValue === '-') {
        return
      }
      const num = parseFloat(currentValue)
      if (!isNaN(num)) {
        updateValue(num)
      }
    }

    const handleIncrement = () => {
      const current = parseFloat(currentValue) || 0
      updateValue(current + step)
    }

    const handleDecrement = () => {
      const current = parseFloat(currentValue) || 0
      updateValue(current - step)
    }

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
        <div className="relative flex">
          {/* Decrement button */}
          {showControls && (
            <button
              type="button"
              onClick={handleDecrement}
              disabled={disabled || (min !== undefined && parseFloat(currentValue) <= min)}
              className={cn(
                'flex h-10 w-10 items-center justify-center',
                'rounded-l border border-r-0 border-matrix-border bg-matrix-bg',
                'text-matrix-muted transition-colors',
                'hover:border-matrix-primary/50 hover:text-matrix-primary',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
            </button>
          )}

          {/* Input container */}
          <div className="relative flex-1">
            {prefix && (
              <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-matrix-muted">
                {prefix}
              </span>
            )}
            <input
              ref={ref}
              type="text"
              inputMode="decimal"
              id={inputId}
              value={currentValue}
              onChange={handleChange}
              onBlur={handleBlur}
              disabled={disabled}
              className={cn(
                'h-10 w-full border border-matrix-border bg-matrix-bg',
                'px-3 text-center font-mono text-sm text-matrix-primary',
                'placeholder:text-matrix-muted/50',
                'focus:border-matrix-primary/50 focus:outline-none',
                'focus:shadow-[0_0_10px_rgba(0,255,0,0.2)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'transition-all duration-200',
                !showControls && 'rounded',
                error && 'border-matrix-red',
                prefix && 'pl-8',
                suffix && 'pr-8',
                className
              )}
              {...props}
            />
            {suffix && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-sm text-matrix-muted">
                {suffix}
              </span>
            )}
          </div>

          {/* Increment button */}
          {showControls && (
            <button
              type="button"
              onClick={handleIncrement}
              disabled={disabled || (max !== undefined && parseFloat(currentValue) >= max)}
              className={cn(
                'flex h-10 w-10 items-center justify-center',
                'rounded-r border border-l-0 border-matrix-border bg-matrix-bg',
                'text-matrix-muted transition-colors',
                'hover:border-matrix-primary/50 hover:text-matrix-primary',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          )}
        </div>
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

MatrixNumberInput.displayName = 'MatrixNumberInput'
