import React, { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/utils/cn'
import { useNotificationStore } from '@/stores/notificationStore'
import type { Notification, NotificationType } from '@/types'

// ==========================================
// SINGLE TOAST
// ==========================================

const typeStyles: Record<NotificationType, { border: string; icon: string; text: string }> = {
  trade: { border: 'border-agent-green/50', icon: '⚡', text: 'text-agent-green' },
  success: { border: 'border-agent-green/50', icon: '✓', text: 'text-agent-green' },
  error: { border: 'border-red-500/50', icon: '✕', text: 'text-red-400' },
  warning: { border: 'border-agent-orange/50', icon: '⚠', text: 'text-agent-orange' },
  info: { border: 'border-agent-cyan/50', icon: 'ℹ', text: 'text-agent-cyan' },
}

interface MatrixToastProps {
  notification: Notification
  onDismiss: (id: string) => void
}

const MatrixToast: React.FC<MatrixToastProps> = ({ notification, onDismiss }) => {
  const style = typeStyles[notification.type] ?? typeStyles.info

  useEffect(() => {
    if (!notification.autoClose) return
    const timer = setTimeout(
      () => onDismiss(notification.id),
      notification.duration ?? 4000
    )
    return () => clearTimeout(timer)
  }, [notification.id, notification.autoClose, notification.duration, onDismiss])

  return (
    <motion.div
      initial={{ x: 100, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 100, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      className={cn(
        'w-full sm:w-80 border rounded-lg p-3 shadow-lg',
        'bg-agent-card/60 backdrop-blur-md border-agent-border/50',
        style.border
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn('text-sm mt-0.5', style.text)}>{style.icon}</span>
        <div className="flex-1 min-w-0">
          <p className={cn('text-xs font-mono font-bold', style.text)}>
            {notification.title}
          </p>
          <p className="text-xs text-agent-text-muted font-sans mt-0.5 truncate">
            {notification.message}
          </p>
        </div>
        <button
          onClick={() => onDismiss(notification.id)}
          className="text-agent-text-muted hover:text-agent-green text-xs p-1 transition-colors"
        >
          ✕
        </button>
      </div>
    </motion.div>
  )
}

// ==========================================
// TOAST CONTAINER
// ==========================================

export const MatrixToastContainer: React.FC = () => {
  const { notifications, dismissNotification } = useNotificationStore()

  return (
    <div className="fixed top-4 right-2 sm:right-4 z-50 space-y-2 max-w-[calc(100vw-1rem)] sm:max-w-sm">
      <AnimatePresence>
        {notifications.map((n) => (
          <MatrixToast key={n.id} notification={n} onDismiss={dismissNotification} />
        ))}
      </AnimatePresence>
    </div>
  )
}
