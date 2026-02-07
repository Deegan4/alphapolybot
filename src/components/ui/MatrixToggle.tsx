import React from 'react'
import { cn } from '@/utils/cn'

interface MatrixToggleProps {
  enabled: boolean
  onChange: (enabled: boolean) => void
  label?: string
  description?: string
  disabled?: boolean
  size?: 'sm' | 'md' | 'lg'
}

/**
 * MatrixToggle - ON/OFF switch with Matrix theme
 * Used for strategy enable/disable toggles
 */
export const MatrixToggle: React.FC<MatrixToggleProps> = ({
  enabled,
  onChange,
  label,
  description,
  disabled = false,
  size = 'md',
}) => {
  const sizes = {
    sm: { track: 'w-8 h-4', thumb: 'w-3 h-3', translate: 'translate-x-4' },
    md: { track: 'w-11 h-6', thumb: 'w-5 h-5', translate: 'translate-x-5' },
    lg: { track: 'w-14 h-7', thumb: 'w-6 h-6', translate: 'translate-x-7' },
  }

  const { track, thumb, translate } = sizes[size]

  return (
    <div className="flex items-center justify-between gap-4">
      {(label || description) && (
        <div className="flex-1">
          {label && (
            <span className="text-matrix-text-primary font-mono text-sm">
              {label}
            </span>
          )}
          {description && (
            <p className="text-matrix-text-secondary text-xs mt-0.5">
              {description}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={cn(
          'relative inline-flex shrink-0 cursor-pointer rounded-full',
          'border-2 border-transparent transition-colors duration-200',
          'focus:outline-none focus:ring-2 focus:ring-matrix-primary/50 focus:ring-offset-2 focus:ring-offset-matrix-bg',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          track,
          enabled
            ? 'bg-matrix-primary shadow-[0_0_10px_rgba(0,255,0,0.5)]'
            : 'bg-matrix-border'
        )}
      >
        <span className="sr-only">Toggle</span>
        <span
          className={cn(
            'pointer-events-none inline-block rounded-full',
            'bg-matrix-bg shadow-lg ring-0 transition duration-200 ease-in-out',
            thumb,
            enabled ? translate : 'translate-x-0.5'
          )}
        />
      </button>
    </div>
  )
}

export default MatrixToggle
