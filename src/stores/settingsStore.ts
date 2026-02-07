import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AppSettingsState {
  // Trading Mode
  dryRun: boolean
  
  // API Keys (stored encrypted via secureStorage in production)
  openRouterApiKey: string
  
  // Notifications
  enableNotifications: boolean
  enableSoundAlerts: boolean
}

interface SettingsStore extends AppSettingsState {
  // Actions
  setDryRun: (enabled: boolean) => void
  setOpenRouterApiKey: (key: string) => void
  setNotifications: (enabled: boolean) => void
  setSoundAlerts: (enabled: boolean) => void
  resetSettings: () => void
}

const DEFAULT_SETTINGS: AppSettingsState = {
  dryRun: true, // SAFE DEFAULT: Always start in dry run mode
  openRouterApiKey: '',
  enableNotifications: true,
  enableSoundAlerts: false,
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,

      setDryRun: (enabled: boolean) => {
        console.log(`[Settings] Dry run mode ${enabled ? 'ENABLED' : 'DISABLED'}`)
        set({ dryRun: enabled })
      },

      setOpenRouterApiKey: (key: string) => {
        set({ openRouterApiKey: key })
      },

      setNotifications: (enabled: boolean) => {
        set({ enableNotifications: enabled })
      },

      setSoundAlerts: (enabled: boolean) => {
        set({ enableSoundAlerts: enabled })
      },

      resetSettings: () => {
        set(DEFAULT_SETTINGS)
      },
    }),
    {
      name: 'alphapolybot-settings',
      partialize: (state) => ({
        dryRun: state.dryRun,
        openRouterApiKey: state.openRouterApiKey,
        enableNotifications: state.enableNotifications,
        enableSoundAlerts: state.enableSoundAlerts,
      }),
    }
  )
)
