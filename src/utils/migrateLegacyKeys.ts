/**
 * Legacy Key Migration
 *
 * Earlier versions wrote API keys straight into localStorage under bare names
 * (`OPENROUTER_API_KEY`, `TAVILY_API_KEY`). Those cleartext copies survive an
 * upgrade, so encrypting new writes alone would leave the old secret sitting
 * in the clear forever.
 *
 * This moves each one into encrypted storage and removes the plaintext copy.
 * Run once at startup, after settings hydration.
 */

import { useSettingsStore } from '@/stores/settingsStore'
import { secureStorage } from './secureStorage'

const LEGACY_OPENROUTER = 'OPENROUTER_API_KEY'
const LEGACY_TAVILY = 'TAVILY_API_KEY'

export async function migrateLegacyPlaintextKeys(): Promise<number> {
  let migrated = 0

  try {
    const openRouter = localStorage.getItem(LEGACY_OPENROUTER)
    if (openRouter) {
      // Only adopt it if the store has nothing — the store is authoritative.
      if (!useSettingsStore.getState().openRouterApiKey) {
        useSettingsStore.getState().setOpenRouterApiKey(openRouter)
      }
      localStorage.removeItem(LEGACY_OPENROUTER)
      migrated++
    }

    const tavily = localStorage.getItem(LEGACY_TAVILY)
    if (tavily) {
      if (!(await secureStorage.get<string>('tavily-api-key', true))) {
        await secureStorage.set('tavily-api-key', tavily, { encrypt: true })
      }
      localStorage.removeItem(LEGACY_TAVILY)
      migrated++
    }

    if (migrated > 0) {
      console.log(`[Migration] Moved ${migrated} plaintext API key(s) into encrypted storage`)
    }
  } catch (error) {
    console.error('[Migration] Failed to migrate legacy keys:', error)
  }

  return migrated
}
