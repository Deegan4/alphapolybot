import React, { Suspense, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
// AppLayout is no longer used — Settings now uses SettingsLayout
import { useSettingsStore, useWalletStore } from '@/stores'
import { tradingService, riskManager, positionLifecycleManager, gtcOrderManager, activityLogger } from '@/services/trading'
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
  const { dryRun, openRouterApiKey, gtcFallbackEnabled, gtcExpiryMinutes } = useSettingsStore()
  const initialized = useRef(false)

  // Initialize strategy manager on first load
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const initializeApp = async () => {
      console.log('[App] Initializing AlphaPolyBot...')

      // Initialize IndexedDB storage first (other services persist to it)
      await indexedDBService.initialize()
      console.log('[App] IndexedDB storage initialized')

      // Hydrate activity log from storage (restores history across refreshes)
      await activityLogger.loadFromStorage()

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
        secureStorage.clearExpired()
      }, PRUNE_INTERVAL_MS)
      console.log('[App] Auto-pruning scheduled (every 6h)')

      // Auto-reconnect wallet if seed phrase is available in env
      // walletStore persists address but NOT the live ethers.Wallet instance,
      // so on page refresh we need to re-call connect() to restore balances.
      const seedPhrase = import.meta.env.VITE_WALLET_SEED_PHRASE
      if (seedPhrase && seedPhrase !== 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12') {
        const { address } = useWalletStore.getState()
        // NOTE: connect() now auto-computes the correct proxy via CREATE2.
        // Do NOT restore a persisted proxyAddress here — it may be stale/wrong.
        if (!useWalletStore.getState().isConnected || address) {
          console.log('[App] Auto-reconnecting wallet from env seed phrase...')
          try {
            const success = await useWalletStore.getState().connect(seedPhrase)
            if (success) {
              console.log('[App] Wallet auto-reconnected — balances synced')

              // Connect user channel WebSocket after wallet is ready
              // Requires CLOB API credentials (derived from wallet)
              import('@/services/api').then(({ clobClient }) => {
                import('@/services/realtime').then(({ userChannelService }) => {
                  const creds = clobClient.getCredentials()
                  if (creds) {
                    userChannelService.setAuth({
                      apiKey: creds.key,
                      secret: creds.secret,
                      passphrase: creds.passphrase,
                    })
                    userChannelService.connect().then(connected => {
                      if (connected) {
                        console.log('[App] User channel connected — push-based order updates active')
                      }
                    })
                  } else {
                    console.log('[App] CLOB credentials not available — user channel skipped')
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
      if (document.visibilityState !== 'hidden') return
      const currentDryRun = useSettingsStore.getState().dryRun
      if (currentDryRun) return

      const states = strategyManager.getStates()
      const anyLive = states.some(s => s.status === 'running')
      if (anyLive) {
        // Fire-and-forget toast warning via activity logger
        activityLogger.logWarning('Tab hidden — WebSocket connections may degrade. SL/TP monitoring continues but may be slower.')
      }
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
      <MatrixToastContainer />
    </ErrorBoundary>
  )
}

export default App
