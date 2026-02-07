import React, { useId } from 'react'
import { cn } from '../../utils'

export interface RadioOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

export interface MatrixRadioGroupProps {
  name: string
  options: RadioOption[]
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  label?: string
  orientation?: 'horizontal' | 'vertical'
  error?: string
  className?: string
}

export const MatrixRadioGroup: React.FC<MatrixRadioGroupProps> = ({
  name,
  options,
  value,
  defaultValue,
  onChange,
  label,
  orientation = 'vertical',
  error,
  className,
}) => {
  const groupId = useId()

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange?.(e.target.value)
  }

  return (
    <div className={className}>
      {label && (
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-matrix-muted">
          {label}
        </p>
      )}
      <div
        className={cn(
          'flex gap-3',
          orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap'
        )}
        role="radiogroup"
        aria-label={label}
      >
        {options.map((option) => {
          const optionId = `${groupId}-${option.value}`
          const isChecked = value !== undefined 
            ? value === option.value 
            : undefined

          return (
            <div
              key={option.value}
              className={cn(
                'flex items-start gap-3',
                option.disabled && 'opacity-50'
              )}
            >
              <div className="relative flex items-center">
                <input
                  type="radio"
                  id={optionId}
                  name={name}
                  value={option.value}
                  checked={isChecked}
                  defaultChecked={defaultValue === option.value}
                  onChange={handleChange}
                  disabled={option.disabled}
                  className="peer sr-only"
                />
                <div
                  className={cn(
                    'flex h-5 w-5 cursor-pointer items-center justify-center',
                    'rounded-full border border-matrix-border bg-matrix-bg',
                    'transition-all duration-200',
                    'peer-focus:border-matrix-primary/50 peer-focus:shadow-[0_0_10px_rgba(0,255,0,0.2)]',
                    'peer-checked:border-matrix-primary',
                    'peer-disabled:cursor-not-allowed'
                  )}
                >
                  {/* Radio dot */}
                  <div
                    className={cn(
                      'h-2 w-2 rounded-full bg-matrix-primary',
                      'scale-0 transition-transform peer-checked:scale-100'
                    )}
                    style={{
                      transform: isChecked ? 'scale(1)' : 'scale(0)',
                      boxShadow: isChecked ? '0 0 6px rgba(0, 255, 0, 0.6)' : 'none',
                    }}
                  />
                </div>
              </div>
              <div className="flex flex-col">
                <label
                  htmlFor={optionId}
                  className={cn(
                    'cursor-pointer font-mono text-sm text-matrix-primary',
                    option.disabled && 'cursor-not-allowed'
                  )}
                >
                  {option.label}
                </label>
                {option.description && (
                  <span className="font-mono text-xs text-matrix-muted">
                    {option.description}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {error && (
        <p className="mt-1 text-xs text-matrix-red">{error}</p>
      )}
    </div>
  )
}
