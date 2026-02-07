import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { riskManager } from '@/services/trading/RiskManager'

export interface AppSettingsState {
  // Trading Mode
  dryRun: boolean

  // API Keys (stored encrypted via secureStorage in production)
  openRouterApiKey: string

  // Notifications
  enableNotifications: boolean
  enableSoundAlerts: boolean

  // Risk Management
  dailyLossLimit: number
  maxTradesPerHour: number
  consecutiveFailureLimit: number
  minBalanceForTrade: number
  riskManagementEnabled: boolean
}

interface SettingsStore extends AppSettingsState {
  // Actions
  setDryRun: (enabled: boolean) => void
  setOpenRouterApiKey: (key: string) => void
  setNotifications: (enabled: boolean) => void
  setSoundAlerts: (enabled: boolean) => void
  setDailyLossLimit: (limit: number) => void
  setMaxTradesPerHour: (limit: number) => void
  setConsecutiveFailureLimit: (limit: number) => void
  setMinBalanceForTrade: (amount: number) => void
  setRiskManagementEnabled: (enabled: boolean) => void
  resetSettings: () => void
}

const DEFAULT_SETTINGS: AppSettingsState = {
  dryRun: true, // SAFE DEFAULT: Always start in dry run mode
  openRouterApiKey: '',
  enableNotifications: true,
  enableSoundAlerts: false,
  dailyLossLimit: 10,
  maxTradesPerHour: 20,
  consecutiveFailureLimit: 5,
  minBalanceForTrade: 5,
  riskManagementEnabled: true,
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

      setDailyLossLimit: (limit: number) => {
        set({ dailyLossLimit: limit })
        riskManager.setConfig({ dailyLossLimit: limit })
      },

      setMaxTradesPerHour: (limit: number) => {
        set({ maxTradesPerHour: limit })
        riskManager.setConfig({ maxTradesPerHour: limit })
      },

      setConsecutiveFailureLimit: (limit: number) => {
        set({ consecutiveFailureLimit: limit })
        riskManager.setConfig({ consecutiveFailureLimit: limit })
      },

      setMinBalanceForTrade: (amount: number) => {
        set({ minBalanceForTrade: amount })
        riskManager.setConfig({ minBalanceForTrade: amount })
      },

      setRiskManagementEnabled: (enabled: boolean) => {
        set({ riskManagementEnabled: enabled })
        riskManager.setConfig({ enabled })
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
        dailyLossLimit: state.dailyLossLimit,
        maxTradesPerHour: state.maxTradesPerHour,
        consecutiveFailureLimit: state.consecutiveFailureLimit,
        minBalanceForTrade: state.minBalanceForTrade,
        riskManagementEnabled: state.riskManagementEnabled,
      }),
    }
  )
)
