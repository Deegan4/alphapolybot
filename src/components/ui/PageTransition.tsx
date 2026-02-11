import React, { forwardRef } from 'react'
import { motion } from 'framer-motion'

const pageVariants = {
  initial: { opacity: 0 },
  animate: {
    opacity: 1,
    pointerEvents: 'auto' as const,
    transition: { duration: 0.2, ease: 'easeOut' },
  },
  exit: {
    opacity: 0,
    pointerEvents: 'none' as const,
    transition: { duration: 0.1 },
  },
}

/**
 * PageTransition - Wrapper for route transitions
 * Uses forwardRef for compatibility with AnimatePresence mode="wait"
 */
export const PageTransition = forwardRef<
  HTMLDivElement,
  { children: React.ReactNode; className?: string }
>(({ children, className }, ref) => (
  <motion.div
    ref={ref}
    variants={pageVariants}
    initial="initial"
    animate="animate"
    exit="exit"
    className={className}
  >
    {children}
  </motion.div>
))

PageTransition.displayName = 'PageTransition'

export default PageTransition
