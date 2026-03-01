import React, { Suspense, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
// AppLayout is no longer used — Settings now uses SettingsLayout
import { useSettingsStore, useWalletStore } from '@/stores'
import { tradingService, riskManager, positionLifecycleManager, gtcOrderManager, activityLogger, tradeLogger } from '@/services/trading'
import { dataClient } from '@/services/api/DataClient'
import { indexedDBService } from '@/services/storage'
import { secureStorage } from '@/utils/secureStorage'
import { strategyManager } from '@/services/strategies'
import { openRouterService } from '@/services/llm'
import { notificationService } from '@/services/notifications'
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

      // Auto-reconnect wallet if credential (seed phrase or private key) is in env
      // walletStore persists address but NOT the live ethers.Wallet instance,
      // so on page refresh we need to re-call connect() to restore balances.
      const walletCred = import.meta.env.VITE_WALLET_SEED_PHRASE?.trim()
      const wordCount = walletCred ? walletCred.split(/\s+/).length : 0
      const isHexKey = walletCred && /^(0x)?[0-9a-fA-F]{64}$/.test(walletCred)
      if (walletCred && (wordCount === 12 || wordCount === 24 || isHexKey)) {
        // Auto-reconnect using wallet credential from env
        if (!useWalletStore.getState().isConnected) {
          console.log('[App] Auto-reconnecting wallet from env...')
          try {
            const success = await useWalletStore.getState().connect(walletCred)
            if (success) {
              console.log('[App] Wallet auto-reconnected — balances synced')

              // Set wallet address on dataClient so PortfolioView can fetch positions/trades
              const proxyAddress = useWalletStore.getState().proxyAddress
              const walletAddress = useWalletStore.getState().address
              if (proxyAddress || walletAddress) {
                dataClient.setWalletAddress(proxyAddress || walletAddress)
                console.log('[App] DataClient wallet address set')
              }

              // Start balance polling globally — previously lived in Header.tsx
              // which isn't rendered on the Dashboard route (DashboardLayout has no Header).
              // Services (RiskManager, strategies) read balance from any route.
              useWalletStore.getState().startPolling()

              // Connect user channel WebSocket after wallet is ready
              // Uses CLOB HMAC credentials (derived from wallet during connect)
              import('@/services/realtime').then(({ userChannelService }) => {
                userChannelService.connect().then(connected => {
                  if (connected) {
                    console.log('[App] User channel connected — push-based order updates active')
                  }
                })
              }).catch(() => {})
            } else {
              const storeError = useWalletStore.getState().error
              console.warn(`[App] Wallet auto-reconnect failed: ${storeError || 'check RPC or credentials'}`)
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
