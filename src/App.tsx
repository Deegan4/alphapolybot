import React, { Suspense, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from '@/components/layout'
import { useSettingsStore, useWalletStore } from '@/stores'
import { tradingService, riskManager, positionLifecycleManager, gtcOrderManager, activityLogger } from '@/services/trading'
import { indexedDBService } from '@/services/storage'
import { strategyManager } from '@/services/strategies'
import { openRouterService } from '@/services/llm'
import { notificationService } from '@/services/notifications'
import { MatrixToastContainer } from '@/components/ui'
import { ErrorBoundary } from '@/components/ErrorBoundary'

// Lazy-load route views — Vite code-splits each into its own chunk.
// Users only download the JS for the view they navigate to.
const TradingTerminal = React.lazy(() => import('@/views/TradingTerminal'))
const PortfolioView = React.lazy(() => import('@/views/PortfolioView'))
const ActivityView = React.lazy(() => import('@/views/ActivityView'))
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

      // Auto-reconnect wallet if seed phrase is available in env
      // walletStore persists address but NOT the live ethers.Wallet instance,
      // so on page refresh we need to re-call connect() to restore balances.
      const seedPhrase = import.meta.env.VITE_WALLET_SEED_PHRASE
      if (seedPhrase && seedPhrase !== 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12') {
        const { address, proxyAddress } = useWalletStore.getState()
        // Restore proxy address into walletService before connect() so it queries the right fund source
        if (proxyAddress) {
          const { walletService } = await import('@/services/wallet')
          walletService.setProxyAddress(proxyAddress)
        }
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
            <Route path="/" element={<AppLayout />}>
              <Route index element={<TradingTerminal />} />
              <Route path="portfolio" element={<PortfolioView />} />
              <Route path="activity" element={<ActivityView />} />
              <Route path="settings" element={<SettingsView />} />
              <Route path="*" element={<NotFoundView />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
      <MatrixToastContainer />
    </ErrorBoundary>
  )
}

export default App
