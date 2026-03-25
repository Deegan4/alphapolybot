import React, { Suspense, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
// AppLayout is no longer used — Settings now uses SettingsLayout
import { useSettingsStore, useWalletStore } from '@/stores'
import { secureStorage } from '@/utils/secureStorage'
import { ErrorBoundary } from '@/components/ErrorBoundary'

// tradingService and indexedDBService are lazy-loaded inside useEffect to keep
// the initial bundle small. They pull in ethers.js (~381kB) and the full
// API/trading chain which are only needed after first render.

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
// Module-level refs populated after lazy init — used by beforeunload handler
let _strategyManager: Awaited<typeof import('@/services/strategies/StrategyManager')>['strategyManager'] | null = null
let _plm: Awaited<typeof import('@/services/trading/PositionLifecycleManager')>['positionLifecycleManager'] | null = null

const App: React.FC = () => {
  const dryRun = useSettingsStore((s) => s.dryRun)
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
      const { indexedDBService } = await import('@/services/storage')
      await indexedDBService.initialize()
      console.log('[App] IndexedDB storage initialized')

      // Dynamically import non-critical services to keep main bundle small.
      // These are only needed during initialization, not at module load time.
      const [
        { activityLogger },
        { tradeLogger },
        { riskManager },
        { positionLifecycleManager },
        { gtcOrderManager },
        { notificationService },
        { strategyManager },
      ] = await Promise.all([
        import('@/services/trading/ActivityLogger'),
        import('@/services/trading/TradeLogger'),
        import('@/services/trading/RiskManager'),
        import('@/services/trading/PositionLifecycleManager'),
        import('@/services/trading/GtcOrderManager'),
        import('@/services/notifications/NotificationService'),
        import('@/services/strategies/StrategyManager'),
      ])

      // Hydrate activity log from storage (restores history across refreshes)
      await activityLogger.loadFromStorage()

      // Hydrate trade records from IndexedDB (restores trade history across refreshes)
      await tradeLogger.hydrate()

      // Initialize risk manager (subscribes to activity logger for error monitoring)
      riskManager.initialize()
      console.log('[App] Risk manager initialized')

      // Initialize position lifecycle manager (stop-loss / take-profit enforcement)
      positionLifecycleManager.initialize()
      console.log('[App] Position lifecycle manager initialized')

      // Initialize GTC order manager (tracks pending GTD fallback orders)
      gtcOrderManager.initialize()
      console.log('[App] GTC order manager initialized')

      // Initialize notification service
      notificationService.initialize()
      console.log('[App] Notification service initialized')

      // Capture refs for beforeunload handler
      _strategyManager = strategyManager
      _plm = positionLifecycleManager

      // Initialize strategy manager (lazy-loads all 8 strategies in parallel)
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
      const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
      setInterval(() => {
        import('@/services/storage').then(({ indexedDBService: idb }) => idb.pruneAll()).catch(() => {})
        riskManager.pruneInMemory()
        secureStorage.clearExpired()
      }, PRUNE_INTERVAL_MS)
      console.log('[App] Auto-pruning scheduled (every 6h)')

      // Initialize secureStorage with a derived passphrase
      const storagePassphrase = `alphapolybot-${navigator.userAgent.slice(0, 32)}-${location.origin}`
      await secureStorage.initialize(storagePassphrase)
      console.log('[App] SecureStorage initialized (AES-GCM encryption active)')

      // Hydrate secrets from secureStorage into Zustand
      const [savedPolyBacktestKey, savedTelegramToken, savedDiscordUrl] = await Promise.all([
        secureStorage.get<string>('polybacktest_api_key', true),
        secureStorage.get<string>('telegram_bot_token', true),
        secureStorage.get<string>('discord_webhook_url', true),
      ])
      const settings = useSettingsStore.getState()
      if (savedPolyBacktestKey && !settings.polyBacktestApiKey) settings.setPolyBacktestApiKey(savedPolyBacktestKey)
      if (savedTelegramToken && !settings.telegramBotToken) settings.setTelegramBotToken(savedTelegramToken)
      if (savedDiscordUrl && !settings.discordWebhookUrl) settings.setDiscordWebhookUrl(savedDiscordUrl)

      // Auto-reconnect wallet — only in live mode (dry run uses paper balance)
      const isDryRun = useSettingsStore.getState().dryRun
      const walletCred = await secureStorage.get<string>('wallet_credential', true)
      const envSeed = import.meta.env.VITE_WALLET_SEED_PHRASE
      const credential = walletCred
        || (envSeed && envSeed !== 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12' ? envSeed : null)
      if (isDryRun) {
        console.log(`[App] Dry run mode — skipping wallet connect, using paper balance`)
      } else if (credential) {
        // Always re-derive credentials on page load. Zustand persists isConnected=true
        // but in-memory wallet signer + CLOB HMAC creds are lost on refresh.
        console.log(`[App] ${useWalletStore.getState().isConnected ? 'Re-deriving credentials' : 'Auto-reconnecting wallet'} from ${walletCred ? 'secureStorage' : 'env'}...`)
        try {
          const success = await useWalletStore.getState().connect(credential)
          if (success) {
            console.log('[App] Wallet auto-reconnected — balances synced')

            const { dataClient } = await import('@/services/api/DataClient')
            const proxyAddress = useWalletStore.getState().proxyAddress
            const walletAddress = useWalletStore.getState().address
            if (proxyAddress || walletAddress) {
              dataClient.setWalletAddress((proxyAddress || walletAddress)!)
              console.log('[App] DataClient wallet address set')
            }

            useWalletStore.getState().startPolling()

            // Connect user channel WebSocket after wallet is ready
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

    initializeApp()

    // Cleanup polling on unmount (rare — App is root, but good hygiene)
    return () => { useWalletStore.getState().stopPolling() }
  }, [])

  // Tab lifecycle safety: warn before closing/refreshing with live strategies running.
  // Uses module-level refs populated during initializeApp().
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const currentDryRun = useSettingsStore.getState().dryRun
      if (currentDryRun || !_strategyManager) return

      const states = _strategyManager.getStates()
      const anyLive = states.some(s => s.status === 'running')
      const trackedPositions = _plm?.count ?? 0
      if (anyLive || trackedPositions > 0) {
        e.preventDefault()
        e.returnValue = 'Strategies are running with real money. Are you sure you want to leave?'
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // Sync dry run + GTC fallback state with trading service on startup and changes
  useEffect(() => {
    import('@/services/trading/TradingService').then(({ tradingService }) => {
      tradingService.setConfig({
        dryRun,
        gtcFallbackEnabled,
        gtcExpiryMs: gtcExpiryMinutes * 60 * 1000,
      })
      console.log(`[App] Trading mode: ${dryRun ? 'DRY RUN' : 'LIVE'}, GTD fallback: ${gtcFallbackEnabled ? 'ON' : 'OFF'}`)
    })
  }, [dryRun, gtcFallbackEnabled, gtcExpiryMinutes])

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
