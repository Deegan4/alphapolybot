import React from 'react'
import { cn } from '@/utils/cn'

interface MatrixSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  options: Array<{ value: string; label: string }>
}

/**
 * MatrixSelect - Dropdown select with Matrix theme styling
 */
export const MatrixSelect: React.FC<MatrixSelectProps> = ({
  label,
  error,
  hint,
  options,
  className,
  ...props
}) => {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-matrix-text-secondary text-sm font-mono mb-1.5">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          className={cn(
            'w-full bg-matrix-bg border border-matrix-border rounded-md',
            'px-4 py-2 pr-10 font-mono text-sm text-matrix-text-primary',
            'appearance-none cursor-pointer',
            'focus:outline-none focus:border-matrix-primary/50',
            'focus:shadow-[0_0_10px_rgba(0,255,0,0.2)]',
            'transition-all duration-200',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            error && 'border-red-500/50 focus:border-red-500/70',
            className
          )}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {/* Custom arrow */}
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-matrix-text-secondary pointer-events-none">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
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

export default MatrixSelect
