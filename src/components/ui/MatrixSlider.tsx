import React, { forwardRef, useId, useState, useCallback, useRef, useEffect } from 'react'
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
    const isDragging = useRef(false)

    // Sync from parent prop when NOT dragging (idle updates from store)
    useEffect(() => {
      if (!isDragging.current && value != null) {
        setInternalValue(value as number)
      }
    }, [value])

    // While dragging, use internalValue for instant feedback;
    // when idle, prefer the parent prop to stay in sync with the store
    const currentValue = isDragging.current ? internalValue : (value ?? internalValue) as number
    const percentage = ((currentValue - Number(min)) / (Number(max) - Number(min))) * 100

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = Number(e.target.value)
        isDragging.current = true
        setInternalValue(newValue)
        onChange?.(newValue)
      },
      [onChange]
    )

    const handlePointerUp = useCallback(() => {
      isDragging.current = false
    }, [])

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
                className="text-xs font-medium uppercase tracking-wider text-agent-text-label"
              >
                {label}
              </label>
            )}
            {showValue && (
              <span className="font-mono text-sm text-agent-green">
                {formatValue(currentValue)}
              </span>
            )}
          </div>
        )}

        {/* Slider container */}
        <div className="relative">
          {/* Track background */}
          <div className="pointer-events-none absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-agent-border" />

          {/* Filled track */}
          <div
            className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-agent-green"
            style={{ width: `${percentage}%` }}
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
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className={cn(
              'relative z-10 w-full cursor-pointer appearance-none bg-transparent',
              '[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4',
              '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
              '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-agent-green',
              '[&::-webkit-slider-thumb]:bg-agent-bg',
              '[&::-webkit-slider-thumb]:hover:bg-agent-green/20',
              '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4',
              '[&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full',
              '[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-agent-green',
              '[&::-moz-range-thumb]:bg-agent-bg',
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
                  className="absolute -translate-x-1/2 text-[10px] text-agent-text-label"
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
