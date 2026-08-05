import React, { Suspense, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
// AppLayout is no longer used — Settings now uses SettingsLayout
import { useSettingsStore, useWalletStore, awaitSettingsHydration } from '@/stores'
import { tradingService, riskManager, positionLifecycleManager, gtcOrderManager, activityLogger, tradeLogger } from '@/services/trading'
import { indexedDBService } from '@/services/storage'
import { secureStorage } from '@/utils/secureStorage'
import { strategyManager } from '@/services/strategies'
import { openRouterService } from '@/services/llm'
import { notificationService } from '@/services/notifications'
import { MatrixToastContainer } from '@/components/ui'
import { ErrorBoundary } from '@/components/ErrorBoundary'

// Lazy-load route views — Vite code-splits each into its own chunk.
const DashboardView = React.lazy(() => import('@/views/DashboardView'))
const DashboardLayout = React.lazy(() => import('@/components/layout/DashboardLayout'))
const SettingsLayout = React.lazy(() => import('@/components/layout/SettingsLayout'))
const SettingsView = React.lazy(() => import('@/views/SettingsView'))
const NotFoundView = React.lazy(() => import('@/views/NotFoundView'))

/**
 * MatrixLoading — minimal loading state shown while lazy chunks download.
 * Keeps the Matrix aesthetic consistent during route transitions.
 */
const MatrixLoading: React.FC = () => (
  <div className="flex-1 flex items-center justify-center">
    <div className="text-green-500 font-mono text-sm animate-pulse">
      Loading...
    </div>
  </div>
)

/**
 * App - Main application component with routing
 */
const App: React.FC = () => {
  const dryRun = useSettingsStore((s) => s.dryRun)
  const openRouterApiKey = useSettingsStore((s) => s.openRouterApiKey)
  const gtcFallbackEnabled = useSettingsStore((s) => s.gtcFallbackEnabled)
  const gtcExpiryMinutes = useSettingsStore((s) => s.gtcExpiryMinutes)
  const initialized = useRef(false)

  // Initialize strategy manager on first load
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const initializeApp = async () => {
      console.log('[App] Initializing AlphaPolyBot...')

      // Unlock the keyring before anything reads or writes credentials.
      // Without this, secureStorage has no key and writes plaintext.
      const encryptionReady = await secureStorage.initializeDeviceKey()
      console.log(`[App] Credential encryption ${encryptionReady ? 'active (AES-256-GCM)' : 'UNAVAILABLE — storing plaintext'}`)

      // Persisted settings are encrypted, so hydration is async. Wait for it
      // before any code path reads API keys or wallet credentials.
      await awaitSettingsHydration()
      console.log('[App] Settings hydrated')

      // Sweep up cleartext API keys written by earlier versions
      const { migrateLegacyPlaintextKeys } = await import('@/utils/migrateLegacyKeys')
      await migrateLegacyPlaintextKeys()

      // Initialize IndexedDB storage first (other services persist to it)
      await indexedDBService.initialize()
      console.log('[App] IndexedDB storage initialized')

      // Hydrate activity log from storage (restores history across refreshes)
      await activityLogger.loadFromStorage()

      // Hydrate trade records from IndexedDB (restores trade history across refreshes)
      await tradeLogger.hydrate()

      // Initialize risk manager (subscribes to activity logger for error monitoring)
      riskManager.initialize()
      console.log('[App] Risk manager initialized')

      // Initialize position lifecycle manager (stop-loss / take-profit enforcement)
      // Also hydrates tracked positions from IndexedDB for crash recovery
      positionLifecycleManager.initialize()
      console.log('[App] Position lifecycle manager initialized')

      // Initialize GTC order manager (tracks pending GTD fallback orders)
      gtcOrderManager.initialize()
      console.log('[App] GTC order manager initialized')

      // Initialize notification service (subscribes to activity logger for toast/sound/browser notifications)
      notificationService.initialize()
      console.log('[App] Notification service initialized')

      // Initialize strategy manager (registers LLM + Dip Arb strategies)
      try {
        await strategyManager.initialize()
        console.log('[App] Strategy manager initialized')
      } catch (error) {
        console.error('[App] Failed to initialize strategy manager:', error)
      }

      // Hydrate Coinbase credentials from persisted settings into the singleton client.
      // Zustand persist restores store state on reload, but the CoinbaseClient singleton
      // only receives credentials via setter side-effects — so we push them here on init.
      const { coinbaseApiKey, coinbaseSecret } = useSettingsStore.getState()
      if (coinbaseApiKey && coinbaseSecret) {
        import('@/services/api/CoinbaseClient').then(({ coinbaseClient }) => {
          coinbaseClient.setCredentials(coinbaseApiKey, coinbaseSecret)
          console.log('[App] Coinbase credentials hydrated from persisted settings')
        }).catch(() => {})
      }

      // Connect RTDS for streaming crypto prices (no auth needed)
      import('@/services/realtime').then(({ rtdsService }) => {
        rtdsService.connect().then(connected => {
          if (connected) {
            rtdsService.subscribeCryptoPrices(['BTC', 'ETH', 'SOL'])
            console.log('[App] RTDS connected — streaming crypto prices')
          } else {
            console.warn('[App] RTDS connection failed — using Binance/CoinGecko fallback')
          }
        })
      }).catch(() => {})

      // Connect Binance WS for reliable real-time crypto prices (all 3 assets)
      // RTDS only reliably streams BTC; Binance covers ETH + SOL at ~1s resolution
      import('@/services/realtime/BinanceWSService').then(({ binanceWSService }) => {
        binanceWSService.connect().then(connected => {
          if (connected) {
            console.log('[App] Binance WS connected — streaming BTC/ETH/SOL')
          } else {
            console.warn('[App] Binance WS connection failed — will retry or use HTTP fallback')
          }
        })
      }).catch(() => {})

      // Start periodic auto-pruning (every 6 hours)
      // Cleans IndexedDB stores, in-memory collections, and expired localStorage
      const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
      setInterval(() => {
        indexedDBService.pruneAll().catch(() => {})
        riskManager.pruneInMemory()
        secureStorage.clearExpired().catch(() => {})
      }, PRUNE_INTERVAL_MS)
      console.log('[App] Auto-pruning scheduled (every 6h)')

      // Auto-reconnect wallet if seed phrase is available in env
      // walletStore persists address but NOT the live ethers.Wallet instance,
      // so on page refresh we need to re-call connect() to restore balances.
      const seedPhrase = import.meta.env.VITE_WALLET_SEED_PHRASE
      if (seedPhrase && seedPhrase !== 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12') {
        // Auto-reconnect using PM US credentials from env
        if (!useWalletStore.getState().isConnected) {
          console.log('[App] Auto-reconnecting wallet from env seed phrase...')
          try {
            const success = await useWalletStore.getState().connect(seedPhrase)
            if (success) {
              console.log('[App] Wallet auto-reconnected — balances synced')

              // Start balance polling globally — previously lived in Header.tsx
              // which isn't rendered on the Dashboard route (DashboardLayout has no Header).
              // Services (RiskManager, strategies) read balance from any route.
              useWalletStore.getState().startPolling()

              // Connect user channel WebSocket after wallet is ready
              // Uses polymarketUSClient credentials (Ed25519, set during wallet connect)
              import('@/services/realtime').then(({ userChannelService }) => {
                userChannelService.connect().then(connected => {
                  if (connected) {
                    console.log('[App] User channel connected — push-based order updates active')
                  }
                })
              }).catch(() => {})
            } else {
              console.warn('[App] Wallet auto-reconnect failed — check RPC or seed phrase')
            }
          } catch (err) {
            console.error('[App] Wallet auto-reconnect error:', err)
          }
        }
      }
    }

    initializeApp()

    // Cleanup polling on unmount (rare — App is root, but good hygiene)
    return () => { useWalletStore.getState().stopPolling() }
  }, [])

  // Tab lifecycle safety: warn before closing/refreshing with live strategies running
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const currentDryRun = useSettingsStore.getState().dryRun
      if (currentDryRun) return // No warning in dry-run mode — nothing at stake

      const states = strategyManager.getStates()
      const anyLive = states.some(s => s.status === 'running')
      const trackedPositions = positionLifecycleManager.count
      if (anyLive || trackedPositions > 0) {
        e.preventDefault()
        // Modern browsers ignore custom messages, but setting returnValue triggers the dialog
        e.returnValue = 'Strategies are running with real money. Are you sure you want to leave?'
      }
    }

    const handleVisibilityChange = () => {
      // No intentional throttling or warning when tab is hidden
      // SL/TP monitoring will continue at full speed as allowed by browser
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  // Sync dry run + GTC fallback state with trading service on startup and changes
  useEffect(() => {
    tradingService.setConfig({
      dryRun,
      gtcFallbackEnabled,
      gtcExpiryMs: gtcExpiryMinutes * 60 * 1000,
    })
    console.log(`[App] Trading mode: ${dryRun ? 'DRY RUN' : 'LIVE'}, GTD fallback: ${gtcFallbackEnabled ? 'ON' : 'OFF'}`)
  }, [dryRun, gtcFallbackEnabled, gtcExpiryMinutes])

  // Sync OpenRouter API key when changed in settings
  useEffect(() => {
    if (openRouterApiKey) {
      openRouterService.setApiKey(openRouterApiKey)
      console.log('[App] OpenRouter API key updated from settings')
    }
  }, [openRouterApiKey])

  return (
    <ErrorBoundary>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Suspense fallback={<MatrixLoading />}>
          <Routes>
            {/* Dashboard: full-width, no sidebar */}
            <Route path="/" element={<DashboardLayout />}>
              <Route index element={<DashboardView />} />
            </Route>
            {/* Settings: agent-themed layout, no sidebar */}
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<SettingsView />} />
            </Route>
            <Route path="*" element={<NotFoundView />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
      {/* <MatrixToastContainer /> removed to disable top-right notifications */}
    </ErrorBoundary>
  )
}

export default App
