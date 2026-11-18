import { create } from 'zustand'
import type { Notification } from '@/types'

const MAX_NOTIFICATIONS = 5

interface NotificationStore {
  notifications: Notification[]
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp'>) => void
  dismissNotification: (id: string) => void
  clearAll: () => void
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],

  addNotification: (notification) => {
    const entry: Notification = {
      ...notification,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    }

    set((state) => ({
      notifications: [entry, ...state.notifications].slice(0, MAX_NOTIFICATIONS),
    }))
  },

  dismissNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }))
  },

  clearAll: () => set({ notifications: [] }),
}))
