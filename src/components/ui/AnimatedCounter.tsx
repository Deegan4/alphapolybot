import { useEffect, useRef } from 'react'
import { useSpring, useMotionValue, useTransform, motion } from 'framer-motion'
import { cn } from '@/utils/cn'

interface AnimatedCounterProps {
  value: number
  prefix?: string
  suffix?: string
  precision?: number
  duration?: number
  className?: string
  colorBySign?: boolean
}

/**
 * AnimatedCounter - Smoothly animated number display
 * Uses framer-motion springs for fluid value transitions
 */
export const AnimatedCounter: React.FC<AnimatedCounterProps> = ({
  value,
  prefix = '',
  suffix = '',
  precision = 2,
  duration = 0.6,
  className,
  colorBySign = false,
}) => {
  const motionValue = useMotionValue(0)
  const spring = useSpring(motionValue, {
    stiffness: 100,
    damping: 20,
    duration,
  })

  const display = useTransform(spring, (current) => {
    return `${prefix}${current.toFixed(precision)}${suffix}`
  })

  const isFirst = useRef(true)

  useEffect(() => {
    if (isFirst.current) {
      // Jump to initial value without animation
      motionValue.set(value)
      isFirst.current = false
    } else {
      motionValue.set(value)
    }
  }, [value, motionValue])

  return (
    <motion.span
      className={cn(
        'tabular-nums font-mono',
        colorBySign && value >= 0 && 'text-matrix-primary',
        colorBySign && value < 0 && 'text-red-400',
        className
      )}
    >
      {display}
    </motion.span>
  )
}

export default AnimatedCounter
