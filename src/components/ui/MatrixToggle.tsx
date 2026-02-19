import React from 'react'
import { motion } from 'framer-motion'
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
 * MatrixToggle - ON/OFF switch with spring-animated thumb
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
    sm: { track: 'w-8 h-4', thumb: 'w-3 h-3', offset: 16 },
    md: { track: 'w-11 h-6', thumb: 'w-5 h-5', offset: 20 },
    lg: { track: 'w-14 h-7', thumb: 'w-6 h-6', offset: 28 },
  }

  const { track, thumb, offset } = sizes[size]

  return (
    <div className="flex items-center justify-between gap-4">
      {(label || description) && (
        <div className="flex-1">
          {label && (
            <span className="text-agent-text font-mono text-sm">
              {label}
            </span>
          )}
          {description && (
            <p className="text-agent-text-muted text-xs mt-0.5">
              {description}
            </p>
          )}
        </div>
      )}
      <motion.button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={cn(
          'relative inline-flex shrink-0 cursor-pointer rounded-full',
          'border-2 border-transparent',
          'focus:outline-none focus:ring-2 focus:ring-agent-green/50 focus:ring-offset-2 focus:ring-offset-agent-bg',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          track,
          enabled
            ? 'bg-agent-green'
            : 'bg-agent-border'
        )}
        transition={{ duration: 0.2 }}
      >
        <span className="sr-only">{label ? `Toggle ${label}` : 'Toggle'}</span>
        <motion.span
          className={cn(
            'pointer-events-none inline-block rounded-full',
            'bg-agent-bg shadow-lg ring-0',
            thumb
          )}
          animate={{ x: enabled ? offset : 2 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      </motion.button>
    </div>
  )
}

export default MatrixToggle
