import React, { forwardRef, useId, useState, useCallback } from 'react'
import { cn } from '../../utils'

export interface MatrixSliderProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  label?: string
  showValue?: boolean
  valueFormat?: (value: number) => string
  marks?: { value: number; label: string }[]
  onChange?: (value: number) => void
}

export const MatrixSlider = forwardRef<HTMLInputElement, MatrixSliderProps>(
  (
    {
      className,
      label,
      showValue = true,
      valueFormat,
      marks,
      onChange,
      min = 0,
      max = 100,
      step = 1,
      value,
      defaultValue,
      id,
      ...props
    },
    ref
  ) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
    
    const [internalValue, setInternalValue] = useState<number>(
      (value ?? defaultValue ?? min) as number
    )
    
    const currentValue = (value ?? internalValue) as number
    const percentage = ((currentValue - Number(min)) / (Number(max) - Number(min))) * 100

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = Number(e.target.value)
        setInternalValue(newValue)
        onChange?.(newValue)
      },
      [onChange]
    )

    const formatValue = (val: number) => {
      if (valueFormat) return valueFormat(val)
      return val.toString()
    }

    return (
      <div className={cn('w-full', className)}>
        {/* Header with label and value */}
        {(label || showValue) && (
          <div className="mb-2 flex items-center justify-between">
            {label && (
              <label
                htmlFor={inputId}
                className="text-xs font-medium uppercase tracking-wider text-matrix-muted"
              >
                {label}
              </label>
            )}
            {showValue && (
              <span className="font-mono text-sm text-matrix-primary">
                {formatValue(currentValue)}
              </span>
            )}
          </div>
        )}

        {/* Slider container */}
        <div className="relative">
          {/* Track background */}
          <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-matrix-border" />
          
          {/* Filled track */}
          <div
            className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-matrix-primary"
            style={{
              width: `${percentage}%`,
              boxShadow: '0 0 8px rgba(0, 255, 0, 0.4)',
            }}
          />

          {/* Native input */}
          <input
            ref={ref}
            type="range"
            id={inputId}
            min={min}
            max={max}
            step={step}
            value={currentValue}
            onChange={handleChange}
            className={cn(
              'relative z-10 w-full cursor-pointer appearance-none bg-transparent',
              '[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4',
              '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
              '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-matrix-primary',
              '[&::-webkit-slider-thumb]:bg-matrix-bg',
              '[&::-webkit-slider-thumb]:shadow-[0_0_10px_rgba(0,255,0,0.5)]',
              '[&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:duration-200',
              '[&::-webkit-slider-thumb]:hover:bg-matrix-primary/20',
              '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4',
              '[&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full',
              '[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-matrix-primary',
              '[&::-moz-range-thumb]:bg-matrix-bg',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
            {...props}
          />
        </div>

        {/* Marks */}
        {marks && marks.length > 0 && (
          <div className="relative mt-2 h-4">
            {marks.map((mark) => {
              const markPercentage =
                ((mark.value - Number(min)) / (Number(max) - Number(min))) * 100
              return (
                <span
                  key={mark.value}
                  className="absolute -translate-x-1/2 text-[10px] text-matrix-muted"
                  style={{ left: `${markPercentage}%` }}
                >
                  {mark.label}
                </span>
              )
            })}
          </div>
        )}
      </div>
    )
  }
)

MatrixSlider.displayName = 'MatrixSlider'
