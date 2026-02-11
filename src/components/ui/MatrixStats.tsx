import React from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/utils/cn'

interface StatItemProps {
  label: string
  value: string | number
  change?: number
  changeLabel?: string
  variant?: 'default' | 'profit' | 'loss'
}

const staggerContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
}

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
}

/**
 * MatrixStatCard - Statistics display card with hover lift
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
    <motion.div
      className="bg-matrix-card/80 backdrop-blur-sm border border-matrix-border/50 rounded-lg p-4 shadow-elevation-1"
      whileHover={{ scale: 1.02, y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      <p className="text-matrix-text-muted font-sans text-xs uppercase tracking-wider">
        {label}
      </p>
      <p className={cn('text-2xl font-mono font-bold mt-1 tabular-nums', getValueColor())}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {change !== undefined && (
        <p className={cn('text-xs font-mono mt-1 tabular-nums', getChangeColor())}>
          {formatChange(change)} {changeLabel}
        </p>
      )}
    </motion.div>
  )
}

/**
 * MatrixStatsGrid - Grid of stat cards with staggered entrance
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
    <motion.div
      className={cn('grid gap-4', gridCols[columns], className)}
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
    >
      {stats.map((stat, index) => (
        <motion.div key={index} variants={fadeUp}>
          <MatrixStatCard {...stat} />
        </motion.div>
      ))}
    </motion.div>
  )
}

export default MatrixStatCard
