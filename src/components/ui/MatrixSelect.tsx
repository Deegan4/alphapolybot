import React from 'react'
import { cn } from '@/utils/cn'

interface MatrixSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  options: Array<{ value: string; label: string }>
}

/**
 * MatrixSelect - Dropdown select with agent theme styling
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
        <label className="block text-agent-text-muted text-sm font-mono mb-1.5">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          className={cn(
            'w-full bg-agent-bg border border-agent-border rounded-md',
            'px-4 py-2 pr-10 font-mono text-sm text-agent-text',
            'appearance-none cursor-pointer',
            'focus:outline-none focus:border-agent-green/50',
            'focus:ring-1 focus:ring-agent-green/30',
            'transition-all duration-200',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            error && 'border-agent-red/50 focus:border-agent-red/70',
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
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-agent-text-muted pointer-events-none">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
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

export default MatrixSelect
