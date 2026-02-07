import React from 'react'
import { cn } from '@/utils/cn'

interface StatItemProps {
  label: string
  value: string | number
  change?: number
  changeLabel?: string
  variant?: 'default' | 'profit' | 'loss'
}

/**
 * MatrixStatCard - Statistics display card
 */
export const MatrixStatCard: React.FC<StatItemProps> = ({
  label,
  value,
  change,
  changeLabel,
  variant = 'default',
}) => {
  const getValueColor = () => {
    if (variant === 'profit') return 'text-matrix-primary'
    if (variant === 'loss') return 'text-red-400'
    return 'text-matrix-text-primary'
  }

  const getChangeColor = () => {
    if (change === undefined) return ''
    return change >= 0 ? 'text-matrix-primary' : 'text-red-400'
  }

  const formatChange = (num: number) => {
    const sign = num >= 0 ? '+' : ''
    return `${sign}${num.toFixed(2)}%`
  }

  return (
    <div className="bg-matrix-card border border-matrix-border rounded-lg p-4">
      <p className="text-matrix-text-secondary text-xs font-mono uppercase tracking-wider">
        {label}
      </p>
      <p className={cn('text-2xl font-mono font-bold mt-1', getValueColor())}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {change !== undefined && (
        <p className={cn('text-xs font-mono mt-1', getChangeColor())}>
          {formatChange(change)} {changeLabel}
        </p>
      )}
    </div>
  )
}

/**
 * MatrixStatsGrid - Grid of stat cards
 */
export const MatrixStatsGrid: React.FC<{
  stats: Array<{
    label: string
    value: string | number
    change?: number
    changeLabel?: string
    variant?: 'default' | 'profit' | 'loss'
  }>
  columns?: 2 | 3 | 4
  className?: string
}> = ({ stats, columns = 4, className }) => {
  const gridCols = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-2 lg:grid-cols-4',
  }

  return (
    <div className={cn('grid gap-4', gridCols[columns], className)}>
      {stats.map((stat, index) => (
        <MatrixStatCard key={index} {...stat} />
      ))}
    </div>
  )
}

export default MatrixStatCard
