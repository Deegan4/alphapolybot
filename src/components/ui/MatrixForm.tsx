import React from 'react'
import { cn } from '../../utils'

export interface FormField {
  name: string
  label?: string
  error?: string
}

export interface MatrixFormProps extends React.FormHTMLAttributes<HTMLFormElement> {
  children: React.ReactNode
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void
}

export const MatrixForm: React.FC<MatrixFormProps> = ({
  children,
  onSubmit,
  className,
  ...props
}) => {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    onSubmit?.(e)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn('space-y-4', className)}
      {...props}
    >
      {children}
    </form>
  )
}

export interface MatrixFieldGroupProps {
  label?: string
  description?: string
  error?: string
  required?: boolean
  children: React.ReactNode
  className?: string
}

export const MatrixFieldGroup: React.FC<MatrixFieldGroupProps> = ({
  label,
  description,
  error,
  required,
  children,
  className,
}) => {
  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <div>
          <label className="text-xs font-medium uppercase tracking-wider text-matrix-muted">
            {label}
            {required && <span className="ml-1 text-matrix-red">*</span>}
          </label>
          {description && (
            <p className="mt-0.5 text-xs text-matrix-muted/70">{description}</p>
          )}
        </div>
      )}
      {children}
      {error && <p className="text-xs text-matrix-red">{error}</p>}
    </div>
  )
}

export interface MatrixFormRowProps {
  children: React.ReactNode
  columns?: 1 | 2 | 3 | 4
  className?: string
}

export const MatrixFormRow: React.FC<MatrixFormRowProps> = ({
  children,
  columns = 2,
  className,
}) => {
  const gridCols = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
  }

  return (
    <div className={cn('grid gap-4', gridCols[columns], className)}>
      {children}
    </div>
  )
}

export interface MatrixFormActionsProps {
  children: React.ReactNode
  align?: 'left' | 'center' | 'right' | 'between'
  className?: string
}

export const MatrixFormActions: React.FC<MatrixFormActionsProps> = ({
  children,
  align = 'right',
  className,
}) => {
  const alignClass = {
    left: 'justify-start',
    center: 'justify-center',
    right: 'justify-end',
    between: 'justify-between',
  }

  return (
    <div
      className={cn(
        'flex items-center gap-3 border-t border-matrix-border pt-4',
        alignClass[align],
        className
      )}
    >
      {children}
    </div>
  )
}

export interface MatrixFormSectionProps {
  title?: string
  description?: string
  children: React.ReactNode
  collapsible?: boolean
  defaultCollapsed?: boolean
  className?: string
}

export const MatrixFormSection: React.FC<MatrixFormSectionProps> = ({
  title,
  description,
  children,
  collapsible = false,
  defaultCollapsed = false,
  className,
}) => {
  const [isCollapsed, setIsCollapsed] = React.useState(defaultCollapsed)

  return (
    <div
      className={cn(
        'rounded-lg border border-matrix-border bg-matrix-card p-4',
        className
      )}
    >
      {title && (
        <div
          className={cn(
            'flex items-center justify-between',
            collapsible && 'cursor-pointer',
            (children && !isCollapsed) && 'mb-4'
          )}
          onClick={() => collapsible && setIsCollapsed(!isCollapsed)}
        >
          <div>
            <h3 className="font-mono text-sm font-medium text-matrix-primary">
              {title}
            </h3>
            {description && (
              <p className="mt-0.5 text-xs text-matrix-muted">{description}</p>
            )}
          </div>
          {collapsible && (
            <svg
              className={cn(
                'h-4 w-4 text-matrix-muted transition-transform',
                isCollapsed && '-rotate-90'
              )}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          )}
        </div>
      )}
      {(!collapsible || !isCollapsed) && (
        <div className="space-y-4">{children}</div>
      )}
    </div>
  )
}
