import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MatrixCard, MatrixInput, MatrixButton, MatrixToggle, MatrixSelect, MatrixBadge, MatrixNumberInput, AnimatedCounter, MatrixSlider } from '@/components/ui'
import { useWalletStore, useSettingsStore } from '@/stores'
import { useBalanceHistoryStore } from '@/stores/balanceHistoryStore'
import { strategyManager } from '@/services/strategies'
import { llmPredictionStrategy } from '@/services/strategies/LLMPredictionStrategy'
import { projectFWStrategy } from '@/services/strategies/ProjectFWStrategy'
import { dipArbStrategy } from '@/services/strategies/DipArbStrategy'
import { tradingService, riskManager } from '@/services/trading'
import { notificationService } from '@/services/notifications/NotificationService'
import type { LLMPredictionConfig, DipArbConfig, ProjectFWConfig, WalletEntry } from '@/types'
import type { RiskManagerStatus } from '@/services/trading'
import { cn } from '@/utils/cn'

const tabContentVariants = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0, pointerEvents: 'auto' as const, transition: { duration: 0.2 } },
  exit: { opacity: 0, x: -20, pointerEvents: 'none' as const, transition: { duration: 0.15 } },
}

/**
 * SettingsView - Application settings and configuration
 */
export const SettingsView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'trading' | 'risk' | 'wallet' | 'llm' | 'dip' | 'projectfw' | 'btcupdown' | 'dualside' | 'gabagool' | 'impulse' | 'liquidation' | 'alerts' | 'api'>('trading')

  const tabs = useMemo(() => [
    { id: 'trading', label: 'Trading Mode' },
    { id: 'risk', label: 'Risk Management' },
    { id: 'wallet', label: 'Wallet' },
    { id: 'llm', label: 'LLM Strategy' },
    { id: 'dip', label: 'Dip Arbitrage' },
    { id: 'projectfw', label: 'ProjectFW Arb' },
    { id: 'btcupdown', label: 'Crypto Up/Down' },
    { id: 'dualside', label: 'Dual-Side' },
    { id: 'gabagool', label: 'Gabagool Arb' },
    { id: 'impulse', label: 'Impulse Sniper' },
    { id: 'liquidation', label: 'Liq Momentum' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'api', label: 'API Keys' },
  ], [])

  const handleTabKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tabIds = tabs.map(t => t.id)
    const currentIndex = tabIds.indexOf(activeTab)
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      const next = tabIds[(currentIndex + 1) % tabIds.length]
      setActiveTab(next as typeof activeTab)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const prev = tabIds[(currentIndex - 1 + tabIds.length) % tabIds.length]
      setActiveTab(prev as typeof activeTab)
    }
  }, [activeTab, tabs])

  const tabBarRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollIndicators = useCallback(() => {
    const el = tabBarRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 4)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
  }, [])

  useEffect(() => {
    const el = tabBarRef.current
    if (!el) return
    updateScrollIndicators()
    el.addEventListener('scroll', updateScrollIndicators, { passive: true })
    window.addEventListener('resize', updateScrollIndicators)
    return () => {
      el.removeEventListener('scroll', updateScrollIndicators)
      window.removeEventListener('resize', updateScrollIndicators)
    }
  }, [updateScrollIndicators])

  return (
    <div className="h-full flex flex-col md:flex-row gap-4">
      {/* Tab list — horizontal scroll on mobile, vertical sidebar on md+ */}
      <div className="relative md:contents">
        {/* Left fade indicator */}
        {canScrollLeft && (
          <div className="md:hidden absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-agent-bg to-transparent pointer-events-none z-10" />
        )}
        {/* Right fade indicator */}
        {canScrollRight && (
          <div className="md:hidden absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-agent-bg to-transparent pointer-events-none z-10" />
        )}
      <div
        ref={tabBarRef}
        className="flex md:flex-col md:w-48 gap-1 overflow-x-auto hide-scrollbar pb-2 md:pb-0"
        role="tablist"
        aria-label="Settings sections"
        onKeyDown={handleTabKeyDown}
      >
        {tabs.map(tab => (
          <button
            key={tab.id}
            id={`settings-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id ? 'true' : 'false'}
            aria-controls={`settings-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={cn(
              'relative whitespace-nowrap md:w-full text-left px-4 py-2.5 rounded-md font-mono text-sm transition-colors',
              activeTab === tab.id
                ? 'text-agent-green'
                : 'text-agent-text-muted hover:text-agent-green'
            )}
          >
            {activeTab === tab.id && (
              <motion.div
                layoutId="settings-tab"
                className="absolute inset-0 rounded-md bg-agent-green/10 border border-agent-green/20"
                transition={{ type: 'spring', stiffness: 350, damping: 30 }}
              />
            )}
            <span className="relative z-10">{tab.label}</span>
          </button>
        ))}
      </div>
      </div>

      {/* Content — animated tab transitions */}
      <div
        id={`settings-panel-${activeTab}`}
        className="flex-1 min-h-0 overflow-auto"
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            variants={tabContentVariants}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {activeTab === 'trading' && <TradingModeSettings />}
            {activeTab === 'risk' && <RiskManagementSettings />}
            {activeTab === 'wallet' && <><WalletSettings /><WalletRegistryPanel /></>}
            {activeTab === 'llm' && <LLMSettings />}
            {activeTab === 'dip' && <DipSettings />}
            {activeTab === 'projectfw' && <ProjectFWSettings />}
            {activeTab === 'btcupdown' && <BtcUpDownSettings />}
            {activeTab === 'dualside' && <DualSideSettings />}
            {activeTab === 'gabagool' && <GabagoolSettings />}
            {activeTab === 'impulse' && <ImpulseSniperSettings />}
            {activeTab === 'liquidation' && <LiquidationMomentumSettings />}
            {activeTab === 'alerts' && <AlertSettings />}
            {activeTab === 'api' && <APISettings />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

/**
 * Trading Mode Settings Panel - DRY RUN TOGGLE
 */
const TradingModeSettings: React.FC = () => {
  const { dryRun, setDryRun, pennyTraderMode, setPennyTraderMode, kellyFraction, setKellyFraction, paperBalance, setPaperBalance } = useSettingsStore()
  const [confirmLive, setConfirmLive] = useState(false)
  const [walletConnecting, setWalletConnecting] = useState(false)

  // Sync dry run state with trading service whenever it changes
  useEffect(() => {
    tradingService.setConfig({ dryRun })
  }, [dryRun])

  const handleToggleDryRun = (newDryRunValue: boolean) => {
    if (!newDryRunValue) {
      // Turning OFF dry run (going live) - require confirmation
      setConfirmLive(true)
    } else {
      // Turning ON dry run - stop polling but keep wallet credentials intact
      setConfirmLive(false)
      setDryRun(true)
      useWalletStore.getState().stopPolling()
      useBalanceHistoryStore.getState().resetForModeSwitch(paperBalance)
      console.log(`[Settings] Switched to dry run — polling stopped, paper balance $${paperBalance}`)
    }
  }

  const confirmGoLive = async () => {
    setDryRun(false)
    setConfirmLive(false)
    // Belt-and-suspenders: directly push to tradingService in same tick
    tradingService.setConfig({ dryRun: false })

    // Auto-connect wallet when going live (mirrors App.tsx initializeApp flow)
    if (!useWalletStore.getState().isConnected) {
      setWalletConnecting(true)
      try {
        const { secureStorage } = await import('@/utils/secureStorage')
        const walletCred = await secureStorage.get<string>('wallet_credential', true)
        const envSeed = import.meta.env.VITE_WALLET_SEED_PHRASE
        const credential = walletCred
          || (envSeed && envSeed !== 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12' ? envSeed : null)
        if (credential) {
          const success = await useWalletStore.getState().connect(credential)
          if (success) {
            console.log('[Settings] Went live — wallet connected')

            // DataClient setup (same as App.tsx)
            const { dataClient } = await import('@/services/api/DataClient')
            const proxyAddress = useWalletStore.getState().proxyAddress
            const walletAddress = useWalletStore.getState().address
            if (proxyAddress || walletAddress) {
              dataClient.setWalletAddress((proxyAddress || walletAddress)!)
            }

            useWalletStore.getState().startPolling()

            // User channel WebSocket
            import('@/services/realtime').then(({ userChannelService }) => {
              userChannelService.connect().then(connected => {
                if (connected) {
                  console.log('[Settings] User channel connected')
                }
              })
            }).catch(() => {})
          } else {
            const storeError = useWalletStore.getState().error
            console.warn(`[Settings] Wallet connect failed: ${storeError || 'check credentials'}`)
          }
        } else {
          console.warn('[Settings] No wallet credential found — configure in Wallet tab or .env')
        }
      } catch (err) {
        console.error('[Settings] Wallet auto-connect on go-live failed:', err)
      } finally {
        setWalletConnecting(false)
      }
    }
  }

  // Only show "live" appearance when actually live (not during pending confirmation)
  const isLive = !dryRun

  return (
    <MatrixCard title="TRADING MODE" subtitle="Control whether trades are executed for real" variant="glass">
      <div className="space-y-6">
        {/* Main Toggle — entire card is clickable (disabled during confirmation) */}
        <motion.div
          className={cn(
            'p-6 rounded-lg border-2 transition-all',
            confirmLive ? 'cursor-default' : 'cursor-pointer',
            isLive
              ? 'bg-red-900/20 border-red-500/50'
              : 'bg-agent-orange/10 border-agent-orange/50'
          )}
          onClick={() => !confirmLive && handleToggleDryRun(!dryRun)}
          animate={isLive ? {
            boxShadow: ['0 0 10px rgba(239,68,68,0.2)', '0 0 25px rgba(239,68,68,0.3)', '0 0 10px rgba(239,68,68,0.2)']
          } : { boxShadow: '0 0 0px transparent' }}
          transition={{ duration: 2, repeat: isLive ? Infinity : 0 }}
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className={cn(
                'text-xl font-bold font-mono',
                isLive ? 'text-red-500' : 'text-agent-orange'
              )}>
                {isLive ? 'LIVE TRADING' : 'DRY RUN MODE'}
              </h3>
              <p className="text-agent-text-muted text-sm mt-1 font-sans">
                {isLive
                  ? 'CAUTION: Real orders will be executed with real funds!'
                  : 'Orders are simulated. No real money is at risk.'}
              </p>
            </div>
            {/* Stop propagation so the card onClick doesn't double-fire */}
            <div onClick={e => e.stopPropagation()}>
              <MatrixToggle
                enabled={!isLive}
                onChange={handleToggleDryRun}
                size="lg"
                disabled={confirmLive}
              />
            </div>
          </div>
        </motion.div>

        {/* Confirmation Dialog */}
        <AnimatePresence>
          {confirmLive && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-4">
                <h4 className="text-red-500 font-bold mb-2">Enable Live Trading?</h4>
                <p className="text-agent-text-muted text-sm mb-4 font-sans">
                  This will execute real orders on Polymarket using your connected wallet.
                  Real funds will be at risk. Are you sure?
                </p>
                <div className="flex gap-3">
                  <MatrixButton
                    variant="danger"
                    onClick={confirmGoLive}
                  >
                    Yes, Go Live
                  </MatrixButton>
                  <MatrixButton
                    variant="secondary"
                    onClick={() => setConfirmLive(false)}
                  >
                    Cancel
                  </MatrixButton>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Info Box */}
        <div className="bg-agent-bg/60 rounded-lg p-4 space-y-3">
          <h4 className="text-agent-green text-sm font-mono">What happens in each mode:</h4>

          <div className="space-y-2">
            <div className="flex items-start gap-3">
              <MatrixBadge variant="info" size="sm">DRY RUN</MatrixBadge>
              <ul className="text-agent-text-muted text-xs font-sans space-y-1">
                <li>Tracked paper balance (starts at ${paperBalance.toLocaleString()})</li>
                <li>Orders are logged but not sent to Polymarket</li>
                <li>Wallet not connected — no real funds touched</li>
                <li>Strategy logic runs normally for testing</li>
              </ul>
            </div>

            <div className="flex items-start gap-3">
              <MatrixBadge variant="danger" size="sm">LIVE</MatrixBadge>
              <ul className="text-agent-text-muted text-xs font-sans space-y-1">
                <li>Real orders executed on Polymarket</li>
                <li>Real USD spent on trades</li>
                <li>Orders placed via API</li>
                <li>Profits and losses are real</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Wallet connecting indicator */}
        {walletConnecting && (
          <div className="bg-agent-orange/10 border border-agent-orange/50 rounded-lg p-3 flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-agent-orange border-t-transparent rounded-full animate-spin" />
            <span className="text-agent-orange text-sm font-mono">Connecting wallet...</span>
          </div>
        )}

        {/* Paper Balance (dry run only) */}
        {dryRun && (
          <div className="bg-agent-bg/60 rounded-lg p-4 space-y-2">
            <h4 className="text-agent-green text-sm font-mono">PAPER BALANCE</h4>
            <p className="text-agent-text-muted text-xs font-sans">
              Starting balance for simulated trading. Tracks up/down with each trade.
            </p>
            <MatrixNumberInput
              value={paperBalance}
              onChange={setPaperBalance}
              min={10}
              max={1_000_000}
              step={100}
              prefix="$"
              label="Paper Balance"
            />
          </div>
        )}

        {/* Penny Trader Mode Toggle */}
        <motion.div
          className={cn(
            'p-6 rounded-lg border-2 transition-all cursor-pointer',
            pennyTraderMode
              ? 'bg-yellow-500/10 border-yellow-500/50'
              : 'bg-agent-bg/30 border-agent-border'
          )}
          onClick={() => setPennyTraderMode(!pennyTraderMode)}
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className={cn(
                'text-xl font-bold font-mono',
                pennyTraderMode ? 'text-yellow-400' : 'text-agent-text-muted'
              )}>
                {pennyTraderMode ? 'PENNY TRADER MODE' : 'STANDARD MODE'}
              </h3>
              <p className="text-agent-text-muted text-sm mt-1 font-sans">
                {pennyTraderMode
                  ? 'All trades set to $1.00 minimum. Optimized for $5-$20 accounts.'
                  : 'Strategies use their configured trade sizes.'}
              </p>
            </div>
            <div onClick={e => e.stopPropagation()}>
              <MatrixToggle
                enabled={pennyTraderMode}
                onChange={setPennyTraderMode}
                size="lg"
              />
            </div>
          </div>
        </motion.div>

        {/* Penny Mode Details */}
        <AnimatePresence>
          {pennyTraderMode && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4">
                <h4 className="text-yellow-400 text-sm font-mono mb-2">Penny Mode Overrides:</h4>
                <ul className="text-agent-text-muted text-xs font-sans space-y-1">
                  <li>All strategies: $1.00 per trade (Polymarket minimum)</li>
                  <li>Daily loss limit: scaled to 20% of configured ($2 at default $10)</li>
                  <li>Weekly loss limit: scaled to 20% of configured ($10 at default $50)</li>
                  <li>Strategy size controls are disabled while penny mode is active</li>
                </ul>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Kelly Criterion Position Sizing */}
        <div className={`bg-agent-card/50 border border-agent-border rounded-lg p-4 ${pennyTraderMode ? 'opacity-50' : ''}`}>
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="kelly-fraction-slider" className="text-agent-text text-sm font-mono">Kelly Fraction</label>
            <span className="text-agent-green text-sm font-mono font-bold">
              {kellyFraction === 0 ? 'Off' : kellyFraction <= 0.25 ? `${(kellyFraction * 4).toFixed(0)}/4 Kelly` : `${(kellyFraction * 100).toFixed(0)}%`}
            </span>
          </div>
          <input
            id="kelly-fraction-slider"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={kellyFraction}
            onChange={(e) => setKellyFraction(parseFloat(e.target.value))}
            disabled={pennyTraderMode}
            title="Kelly Fraction"
            aria-label="Kelly Fraction"
            className="w-full h-2 bg-agent-border rounded-lg appearance-none cursor-pointer accent-agent-green disabled:cursor-not-allowed"
          />
          <div className="flex justify-between text-[10px] text-agent-text-muted mt-1 font-mono">
            <span>Off</span>
            <span>1/4</span>
            <span>1/2</span>
            <span>3/4</span>
            <span>Full</span>
          </div>
          <p className="text-agent-text-muted text-xs mt-2 font-sans">
            {pennyTraderMode
              ? 'Disabled — Penny Mode overrides all sizing to $1'
              : kellyFraction === 0
                ? 'Kelly disabled — using fixed trade sizes'
                : kellyFraction <= 0.25
                  ? 'Conservative — protects against probability miscalibration'
                  : kellyFraction <= 0.5
                    ? 'Moderate — balances growth rate and drawdown risk'
                    : 'Aggressive — maximum growth rate, high variance'}
          </p>
        </div>

        {/* Current Status */}
        <div className="text-center text-agent-text-muted text-sm font-sans">
          Trading service configured: <span className={isLive ? 'text-red-500 font-mono' : 'text-agent-orange font-mono'}>
            {isLive ? (confirmLive ? 'PENDING...' : 'LIVE') : 'DRY RUN'}
          </span>
        </div>
      </div>
    </MatrixCard>
  )
}

/**
 * Wallet Settings Panel — Connect via seed phrase or private key, derive CLOB credentials
 */
const WalletSettings: React.FC = () => {
  const { isConnected, address, proxyAddress, balance, buyingPower, lastSync, connect, disconnect } = useWalletStore()
  const [seedInput, setSeedInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle')
  const [testError, setTestError] = useState('')

  const handleConnect = async () => {
    const trimmed = seedInput.trim()
    if (!trimmed) {
      setError('Enter a seed phrase or private key')
      return
    }

    setLoading(true)
    setError('')

    try {
      const success = await connect(trimmed)
      if (success) {
        setSeedInput('')
      } else {
        const storeError = useWalletStore.getState().error
        setError(storeError || 'Failed to connect — check your credentials')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setLoading(false)
    }
  }

  const handleDisconnect = () => {
    disconnect()
    setSeedInput('')
  }

  return (
    <MatrixCard title="WALLET CONNECTION" subtitle="Connect wallet to derive CLOB trading credentials" variant="glass">
      <div className="space-y-6">
        {isConnected ? (
          <>
            {/* Connected State */}
            <div className="flex items-center gap-3">
              <motion.span
                className="w-3 h-3 bg-agent-green rounded-full"
                animate={{ opacity: [0.6, 1, 0.6] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
              <span className="text-agent-green font-mono">Connected</span>
            </div>

            <div className="bg-agent-bg/60 rounded-lg p-4 space-y-3">
              <div>
                <span className="text-agent-text-muted text-sm font-sans">Signer:</span>
                <p className="text-agent-green font-mono text-sm mt-1">{address?.slice(0, 10)}...{address?.slice(-6)}</p>
              </div>
              {proxyAddress && (
                <div>
                  <span className="text-agent-text-muted text-sm font-sans">Proxy:</span>
                  <p className="text-agent-cyan font-mono text-sm mt-1">{proxyAddress.slice(0, 10)}...{proxyAddress.slice(-6)}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-agent-text-muted text-sm font-sans">Balance:</span>
                  <p className="text-agent-green font-mono text-lg">
                    <AnimatedCounter value={balance} prefix="$" precision={2} />
                  </p>
                </div>
                <div>
                  <span className="text-agent-text-muted text-sm font-sans">Buying Power:</span>
                  <p className="text-agent-green font-mono text-lg">
                    <AnimatedCounter value={buyingPower} prefix="$" precision={2} />
                  </p>
                </div>
              </div>
              {lastSync && (
                <p className="text-agent-text-muted text-xs font-sans">
                  Last synced: {new Date(lastSync).toLocaleTimeString()}
                </p>
              )}
            </div>

            {/* Test Connection */}
            <div className="bg-agent-bg/60 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-agent-text text-sm font-bold">Test Connection</h4>
                  <p className="text-agent-text-muted text-xs">Validates CLOB credentials by fetching balance allowance</p>
                </div>
                <MatrixButton
                  size="sm"
                  loading={testStatus === 'testing'}
                  onClick={async () => {
                    setTestStatus('testing')
                    setTestError('')
                    try {
                      const { polymarketClient } = await import('@/services/api')
                      const result = await polymarketClient.validateCredentials()
                      if (result.valid) {
                        setTestStatus('pass')
                      } else {
                        setTestStatus('fail')
                        setTestError(result.error ?? 'Unknown error')
                      }
                    } catch (err) {
                      setTestStatus('fail')
                      setTestError(err instanceof Error ? err.message : 'Test failed')
                    }
                  }}
                >
                  {testStatus === 'pass' ? 'Passed' : testStatus === 'fail' ? 'Retry' : 'Test'}
                </MatrixButton>
              </div>
              {testStatus === 'pass' && (
                <div className="text-green-400 text-xs font-mono">CLOB credentials validated successfully</div>
              )}
              {testStatus === 'fail' && testError && (
                <div className="text-red-400 text-xs font-mono">{testError}</div>
              )}
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                <p className="text-red-400 text-sm font-mono">{error}</p>
              </div>
            )}

            <MatrixButton variant="danger" onClick={handleDisconnect}>
              Disconnect
            </MatrixButton>
          </>
        ) : (
          <>
            {/* Disconnected State */}
            <div className="bg-agent-bg/60 rounded-lg p-4 space-y-4">
              <p className="text-agent-text-muted text-sm font-sans">
                Enter a seed phrase (12/24 words) or private key (0x...) to derive CLOB trading credentials.
                Everything stays local — nothing is sent externally.
              </p>
              <MatrixInput
                label="Wallet Credential"
                type="password"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                placeholder="Seed phrase or private key (0x...)"
                error={error}
                hint="Use a dedicated trading wallet — never your main wallet"
              />
            </div>

            <div className="bg-agent-orange/10 border border-agent-orange/30 rounded-lg p-4">
              <h4 className="text-agent-orange text-sm font-bold mb-2">Security Notice</h4>
              <ul className="text-agent-text-muted text-xs font-sans space-y-1">
                <li>Use a dedicated trading wallet, never your main wallet</li>
                <li>Credentials stay local and are never sent to any server</li>
                <li>This bot can place and cancel orders on your behalf</li>
              </ul>
            </div>

            <MatrixButton onClick={handleConnect} loading={loading} className="w-full">
              Connect
            </MatrixButton>
          </>
        )}
      </div>
    </MatrixCard>
  )
}

/**
 * Wallet Registry — manage multiple wallets (seed phrase → address)
 */
const WalletRegistryPanel: React.FC = () => {
  const { wallets, activeWalletId, addWallet, removeWallet, setActiveWallet } = useSettingsStore()
  const { connect, disconnect } = useWalletStore()
  const [showAdd, setShowAdd] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newSeed, setNewSeed] = useState('')
  const [addError, setAddError] = useState('')
  const [switching, setSwitching] = useState(false)

  const handleAdd = async () => {
    const label = newLabel.trim() || `Wallet ${wallets.length + 1}`
    const credential = newSeed.trim()
    if (!credential) {
      setAddError('Seed phrase or private key is required')
      return
    }
    setAddError('')

    // Derive address — auto-detect private key vs seed phrase
    let address: string
    try {
      const { ethers } = await import('ethers')
      const { WalletService } = await import('@/services/wallet/WalletService')
      const isKey = WalletService.isPrivateKey(credential)
      const wallet = isKey
        ? new ethers.Wallet(credential.startsWith('0x') ? credential : `0x${credential}`)
        : ethers.Wallet.fromPhrase(credential)
      address = wallet.address
    } catch {
      setAddError('Invalid seed phrase or private key')
      return
    }

    const id = crypto.randomUUID()
    const entry: WalletEntry = { id, label, address }

    // Store credential in secureStorage (encrypted)
    try {
      const { secureStorage } = await import('@/utils/secureStorage')
      await secureStorage.set(`wallet-seed-${id}`, credential, { encrypt: true })
    } catch {
      setAddError('Failed to store credentials securely')
      return
    }

    addWallet(entry)
    setNewLabel('')
    setNewSeed('')
    setShowAdd(false)
  }

  const handleSwitch = async (wallet: WalletEntry) => {
    if (wallet.id === activeWalletId) return
    setSwitching(true)
    try {
      // Load seed from secure storage and connect
      const { secureStorage } = await import('@/utils/secureStorage')
      const storedSeed = await secureStorage.get(`wallet-seed-${wallet.id}`)
      const seed = typeof storedSeed === 'string' ? storedSeed : ''
      if (seed) {
        const success = await connect(seed)
        if (success) {
          setActiveWallet(wallet.id)
        }
      }
    } finally {
      setSwitching(false)
    }
  }

  const handleRemove = (walletId: string) => {
    if (walletId === activeWalletId) {
      disconnect()
    }
    removeWallet(walletId)
  }

  if (wallets.length === 0 && !showAdd) {
    return (
      <MatrixCard title="WALLET REGISTRY" subtitle="Manage multiple trading wallets" variant="glass">
        <div className="text-center py-6">
          <p className="text-agent-text-muted text-sm font-sans mb-4">
            Save multiple wallets to switch between them quickly. Credentials are encrypted locally.
          </p>
          <MatrixButton onClick={() => setShowAdd(true)} size="sm">
            Add Wallet
          </MatrixButton>
        </div>
      </MatrixCard>
    )
  }

  return (
    <MatrixCard title="WALLET REGISTRY" subtitle="Manage multiple trading wallets" variant="glass">
      <div className="space-y-3">
        {wallets.map(w => (
          <div
            key={w.id}
            className={`flex items-center justify-between gap-3 rounded-lg p-3 border transition-colors ${
              w.id === activeWalletId
                ? 'bg-agent-green/10 border-agent-green/30'
                : 'bg-agent-bg/40 border-agent-border/50 hover:border-agent-green/20'
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${w.id === activeWalletId ? 'bg-agent-green animate-pulse' : 'bg-agent-text-label'}`} />
                <span className="text-sm font-mono text-agent-text truncate">{w.label}</span>
                {w.id === activeWalletId && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-agent-green/20 text-agent-green">ACTIVE</span>
                )}
              </div>
              <span className="text-xs font-mono text-agent-text-muted ml-4">{w.address.slice(0, 10)}...{w.address.slice(-6)}</span>
            </div>
            <div className="flex items-center gap-2">
              {w.id !== activeWalletId && (
                <MatrixButton size="sm" onClick={() => handleSwitch(w)} loading={switching}>
                  Switch
                </MatrixButton>
              )}
              <button
                onClick={() => handleRemove(w.id)}
                className="text-agent-text-muted hover:text-red-400 transition-colors p-1"
                title="Remove wallet"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
        ))}

        {showAdd ? (
          <div className="bg-agent-bg/60 rounded-lg p-4 border border-agent-cyan/30 space-y-3">
            <MatrixInput label="Label" type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="e.g. Trading Bot #2" />
            <MatrixInput label="Wallet Credential" type="password" value={newSeed} onChange={e => setNewSeed(e.target.value)} placeholder="Seed phrase or private key (0x...)" error={addError} />
            <div className="flex gap-2">
              <MatrixButton onClick={handleAdd} size="sm" variant="primary">Save Wallet</MatrixButton>
              <MatrixButton onClick={() => { setShowAdd(false); setAddError('') }} size="sm" variant="ghost">Cancel</MatrixButton>
            </div>
          </div>
        ) : (
          <MatrixButton onClick={() => setShowAdd(true)} size="sm" variant="ghost" className="w-full">
            + Add Another Wallet
          </MatrixButton>
        )}
      </div>
    </MatrixCard>
  )
}

/**
 * GTD Fallback Settings — write-through to settingsStore (no Save button needed)
 */
const GtdFallbackSettings: React.FC = () => {
  const { gtcFallbackEnabled, gtcExpiryMinutes, setGtcFallbackEnabled, setGtcExpiryMinutes } = useSettingsStore()

  return (
    <div>
      <h4 className="text-agent-green text-sm font-mono mb-3">Order Execution</h4>
      <div className="space-y-3">
        <MatrixToggle
          label="GTD Fallback"
          description="When FOK fails (no liquidity), resubmit as a limit order with server-side expiry"
          enabled={gtcFallbackEnabled}
          onChange={setGtcFallbackEnabled}
        />
        {gtcFallbackEnabled && (
          <MatrixSlider
            label="GTD Expiry"
            min={1}
            max={15}
            step={1}
            value={gtcExpiryMinutes}
            onChange={setGtcExpiryMinutes}
            valueFormat={(v) => `${v} min`}
          />
        )}
      </div>
      <p className="text-agent-text-muted text-xs mt-2 font-sans">
        GTD orders sit on the book until filled or expired. Saves wasted LLM analysis on illiquid markets.
      </p>
    </div>
  )
}

/**
 * LLM Strategy Settings
 */
const LLMSettings: React.FC = () => {
  const strategy = llmPredictionStrategy
  const [config, setConfig] = useState<LLMPredictionConfig>(strategy.getLLMConfig())
  const [saved, setSaved] = useState(false)
  const {
    pennyTraderMode,
    cryptoLLMEnabled, setCryptoLLMEnabled,
    cryptoModel, setCryptoModel,
    cryptoScanIntervalMs, setCryptoScanIntervalMs,
    cryptoMinConfidence, setCryptoMinConfidence,
    ollamaBaseUrl, setOllamaBaseUrl,
    ollamaModel, setOllamaModel,
    ollamaSecondaryModel, setOllamaSecondaryModel,
  } = useSettingsStore()

  const [trainingCount, setTrainingCount] = useState(0)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    import('@/services/llm/LLMInteractionStore').then(m => {
      m.llmInteractionStore.count().then(setTrainingCount)
    })
  }, [])

  // Safe number parsers — reject NaN from empty/invalid inputs
  const safeFloat = (val: string, fallback: number) => {
    const n = parseFloat(val)
    return isNaN(n) ? fallback : n
  }

  const handleSave = () => {
    strategy.setLLMConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  const orderTypes = [
    { value: 'FOK', label: 'Fill or Kill (FOK)' },
    { value: 'FAK', label: 'Fill and Kill (FAK)' },
    { value: 'GTC', label: 'Good Till Cancel (GTC)' },
  ]

  return (
    <MatrixCard title="LLM PREDICTION SETTINGS" subtitle="Configure AI-powered trading parameters" variant="glass">
      <div className="space-y-6">
        {/* LLM Provider — Ollama Only */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Ollama Configuration</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Ollama Base URL"
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
              hint="Default: http://localhost:11434/v1"
              placeholder="http://localhost:11434/v1"
            />
            <MatrixInput
              label="Primary Model"
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
              hint="e.g. deepseek-r1:latest, llama3.1"
              placeholder="deepseek-r1:latest"
            />
            <MatrixInput
              label="Secondary Model (Signal Fusion)"
              value={ollamaSecondaryModel}
              onChange={(e) => setOllamaSecondaryModel(e.target.value)}
              hint="Used for LLM signal fusion and confirmation"
              placeholder="llama3.1:latest"
            />
          </div>
          <p className="text-agent-text-muted text-xs mt-2 font-sans">
            Uses your local Ollama instance. No API key required. Models stored on Samsung 1TB.
          </p>
        </div>

        {/* Position Sizing */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Position Sizing</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Base Size (%)"
              type="number"
              value={(config.baseSize * 100).toFixed(1)}
              onChange={(e) => setConfig({ ...config, baseSize: safeFloat(e.target.value, config.baseSize * 100) / 100 })}
              hint="Percentage of capital per trade"
            />
            <MatrixInput
              label="Max Position (%)"
              type="number"
              value={(config.maxPositionSize * 100).toFixed(1)}
              onChange={(e) => setConfig({ ...config, maxPositionSize: safeFloat(e.target.value, config.maxPositionSize * 100) / 100 })}
              hint="Maximum position size"
            />
            <MatrixInput
              label="Max Trade Size ($)"
              type="number"
              step="1"
              value={pennyTraderMode ? '1.00' : config.maxTradeSize.toString()}
              onChange={(e) => setConfig({ ...config, maxTradeSize: safeFloat(e.target.value, config.maxTradeSize) })}
              hint={pennyTraderMode ? 'Overridden to $1.00 by Penny Mode' : 'Hard dollar cap per trade'}
              disabled={pennyTraderMode}
            />
            <MatrixInput
              label="Confidence Multiplier"
              type="number"
              step="0.1"
              value={config.confidenceMultiplier.toString()}
              onChange={(e) => setConfig({ ...config, confidenceMultiplier: safeFloat(e.target.value, config.confidenceMultiplier) })}
              hint="Scale position by confidence"
            />
            <MatrixInput
              label="Min Confidence"
              type="number"
              step="0.05"
              value={config.minConfidence.toString()}
              onChange={(e) => setConfig({ ...config, minConfidence: safeFloat(e.target.value, config.minConfidence) })}
              hint="Minimum to trade"
            />
          </div>
        </div>

        {/* Market Filters */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Market Filters</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Min Odds"
              type="number"
              step="0.05"
              value={config.minOdds.toString()}
              onChange={(e) => setConfig({ ...config, minOdds: safeFloat(e.target.value, config.minOdds) })}
            />
            <MatrixInput
              label="Max Odds"
              type="number"
              step="0.05"
              value={config.maxOdds.toString()}
              onChange={(e) => setConfig({ ...config, maxOdds: safeFloat(e.target.value, config.maxOdds) })}
            />
            <MatrixInput
              label="Min Liquidity ($)"
              type="number"
              value={config.minLiquidity.toString()}
              onChange={(e) => setConfig({ ...config, minLiquidity: safeFloat(e.target.value, config.minLiquidity) })}
            />
            <MatrixInput
              label="Max Age (hours)"
              type="number"
              value={config.maxCreatedHours.toString()}
              onChange={(e) => setConfig({ ...config, maxCreatedHours: safeFloat(e.target.value, config.maxCreatedHours) })}
            />
          </div>
        </div>

        {/* Order Settings */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Order Execution</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixSelect
              label="Order Type"
              value={config.orderType}
              onChange={(e) => setConfig({ ...config, orderType: e.target.value as 'FOK' | 'FAK' | 'GTC' })}
              options={orderTypes}
            />
            <MatrixInput
              label="Max Slippage (%)"
              type="number"
              step="0.5"
              value={(config.maxSlippage * 100).toFixed(1)}
              onChange={(e) => setConfig({ ...config, maxSlippage: safeFloat(e.target.value, config.maxSlippage * 100) / 100 })}
            />
          </div>
        </div>

        {/* GTD Fallback */}
        <GtdFallbackSettings />

        {/* Stop-Loss / Take-Profit */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Stop-Loss / Take-Profit</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixSlider
              label="Stop-Loss"
              min={5}
              max={50}
              step={1}
              value={Math.round(config.stopLossPercent * 100)}
              onChange={(v) => setConfig({ ...config, stopLossPercent: v / 100 })}
              valueFormat={(v) => `${v}%`}
            />
            <MatrixSlider
              label="Take-Profit"
              min={5}
              max={100}
              step={1}
              value={Math.round(config.takeProfitPercent * 100)}
              onChange={(v) => setConfig({ ...config, takeProfitPercent: v / 100 })}
              valueFormat={(v) => `${v}%`}
            />
          </div>
          <p className="text-agent-text-muted text-xs mt-2 font-sans">
            Positions auto-close when thresholds are breached. Changes apply to new positions only.
          </p>
        </div>

        {/* Crypto LLM Mode */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Crypto LLM Mode</h4>
          <MatrixToggle
            label="Enable Crypto LLM"
            enabled={cryptoLLMEnabled}
            onChange={setCryptoLLMEnabled}
          />
          <p className="text-agent-text-muted text-xs mt-2 mb-3 font-sans">
            Dedicated scan loop for crypto prediction markets. Uses BinanceWS live data for enriched analysis.
          </p>
          {cryptoLLMEnabled && (
            <div className="grid grid-cols-2 gap-4 mt-3">
              <MatrixInput
                label="Crypto Model"
                value={cryptoModel}
                onChange={(e) => setCryptoModel(e.target.value)}
                hint="Leave empty to use default"
                placeholder="Same as default"
              />
              <MatrixInput
                label="Scan Interval (sec)"
                type="number"
                step="5"
                value={(cryptoScanIntervalMs / 1000).toString()}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (!isNaN(v)) setCryptoScanIntervalMs(Math.max(10, v) * 1000)
                }}
                hint="Min 10 seconds"
              />
              <MatrixSlider
                label="Min Confidence"
                min={40}
                max={80}
                step={1}
                value={Math.round(cryptoMinConfidence * 100)}
                onChange={(v) => setCryptoMinConfidence(v / 100)}
                valueFormat={(v) => `${v}%`}
              />
            </div>
          )}
        </div>

        {/* Training Data Export */}
        <div className="bg-black/30 border border-green-900/30 rounded-lg p-4">
          <h4 className="text-green-400 font-mono text-sm mb-3">Training Data Pipeline</h4>
          <p className="text-green-600 text-xs mb-3">{trainingCount} interactions recorded</p>
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 bg-green-900/30 border border-green-700/50 rounded text-green-400 text-xs hover:bg-green-900/50 disabled:opacity-50"
              disabled={exporting || trainingCount === 0}
              onClick={async () => {
                setExporting(true)
                try {
                  const { trainingDataExporter } = await import('@/services/llm/TrainingDataExporter')
                  const { jsonl, stats } = await trainingDataExporter.exportAll()
                  trainingDataExporter.downloadJsonl(jsonl)
                  console.log('[Training] Exported:', stats)
                } finally {
                  setExporting(false)
                }
              }}
            >
              {exporting ? 'Exporting...' : 'Export JSONL'}
            </button>
          </div>
          <p className="text-green-700 text-xs mt-2">
            Exports ChatML JSONL for fine-tuning. Run: bash scripts/finetune.sh
          </p>
        </div>

        <MatrixButton onClick={handleSave} className="w-full">
          {saved ? 'Settings Saved' : 'Save Settings'}
        </MatrixButton>
      </div>
    </MatrixCard>
  )
}

/**
 * Dip Arbitrage Settings
 */
/**
 * ProjectFW Arbitrage Settings
 */
const ProjectFWSettings: React.FC = () => {
  const strategy = projectFWStrategy
  const { pennyTraderMode, fwEnableCrossMarket, fwCrossMarketBudgetUSD } = useSettingsStore()

  // Hydrate config from strategy defaults, overriding cross-market fields from persisted store
  const [config, setConfig] = useState<ProjectFWConfig>(() => {
    const base = strategy.getFWConfig()
    return {
      ...base,
      enableCrossMarket: fwEnableCrossMarket,
      crossMarketBudgetUSD: fwCrossMarketBudgetUSD,
    }
  })
  const [saved, setSaved] = useState(false)

  const safeFloat = (val: string, fallback: number) => {
    const n = parseFloat(val)
    return isNaN(n) ? fallback : n
  }
  const safeInt = (val: string, fallback: number) => {
    const n = parseInt(val)
    return isNaN(n) ? fallback : n
  }

  const handleSave = () => {
    strategy.setFWConfig(config)
    // Persist cross-market settings to Zustand store for reload survival
    useSettingsStore.getState().setFwEnableCrossMarket(config.enableCrossMarket ?? false)
    useSettingsStore.getState().setFwCrossMarketBudgetUSD(config.crossMarketBudgetUSD ?? 0.50)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <MatrixCard title="PROJECTFW ARBITRAGE" subtitle="Frank-Wolfe optimized spread arbitrage" variant="glass">
      <div className="space-y-6">
        <div className="bg-agent-green/10 border border-agent-green/30 rounded-lg p-4">
          <h4 className="text-agent-green text-sm font-bold mb-2 font-mono">Bregman Projection Arbitrage</h4>
          <p className="text-agent-text-muted text-xs font-sans">
            Detects price incoherence via KL divergence and computes optimal trade bundles
            with guaranteed profit bounds using the Frank-Wolfe algorithm.
          </p>
        </div>

        {/* Algorithm Parameters */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Algorithm Parameters</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixSlider
              label="Alpha (Approximation Ratio)"
              min={10}
              max={90}
              step={5}
              value={Math.round(config.alpha * 100)}
              onChange={(v) => setConfig({ ...config, alpha: v / 100 })}
              valueFormat={(v) => `${v}%`}
            />
            <MatrixInput
              label="Convergence Threshold"
              type="number"
              step="0.001"
              value={config.epsilonD.toString()}
              onChange={(e) => setConfig({ ...config, epsilonD: safeFloat(e.target.value, config.epsilonD) })}
              hint="Stop when F(mu) below this"
            />
            <MatrixInput
              label="Max Iterations"
              type="number"
              value={config.maxIterations.toString()}
              onChange={(e) => setConfig({ ...config, maxIterations: safeInt(e.target.value, config.maxIterations) })}
              hint="FW loop iterations per solve"
            />
            <MatrixInput
              label="Initial Contraction"
              type="number"
              step="0.01"
              value={config.epsilon0.toString()}
              onChange={(e) => setConfig({ ...config, epsilon0: safeFloat(e.target.value, config.epsilon0) })}
              hint="Initial epsilon for contraction"
            />
          </div>
        </div>

        {/* Trade Settings */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Trade Settings</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Trade Size ($)"
              type="number"
              value={pennyTraderMode ? '1.00' : config.tradeSize.toString()}
              onChange={(e) => setConfig({ ...config, tradeSize: safeFloat(e.target.value, config.tradeSize) })}
              hint={pennyTraderMode ? 'Overridden to $1.00 by Penny Mode' : 'USDC per arb bundle'}
              disabled={pennyTraderMode}
            />
            <MatrixInput
              label="Min Profit (bps)"
              type="number"
              value={config.minProfitBps.toString()}
              onChange={(e) => setConfig({ ...config, minProfitBps: safeInt(e.target.value, config.minProfitBps) })}
              hint="After fees, 100 = 1%"
            />
            <MatrixInput
              label="Max Concurrent"
              type="number"
              value={config.maxConcurrentArbs.toString()}
              onChange={(e) => setConfig({ ...config, maxConcurrentArbs: safeInt(e.target.value, config.maxConcurrentArbs) })}
              hint="Simultaneous arb bundles"
            />
            <MatrixInput
              label="Scan Interval (ms)"
              type="number"
              step="5000"
              value={config.scanIntervalMs.toString()}
              onChange={(e) => setConfig({ ...config, scanIntervalMs: safeInt(e.target.value, config.scanIntervalMs) })}
              hint="Periodic scan frequency"
            />
            <MatrixInput
              label="Cooldown (ms)"
              type="number"
              step="10000"
              value={config.cooldownMs.toString()}
              onChange={(e) => setConfig({ ...config, cooldownMs: safeInt(e.target.value, config.cooldownMs) })}
              hint="Per-market cooldown"
            />
          </div>
        </div>

        {/* Fee Model */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Fee Model</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Taker Fee (bps)"
              type="number"
              value={config.takerFeeBps.toString()}
              onChange={(e) => setConfig({ ...config, takerFeeBps: safeInt(e.target.value, config.takerFeeBps) })}
              hint="Per leg, 200 = 2%"
            />
            <MatrixInput
              label="Gas Est. ($)"
              type="number"
              step="0.01"
              value={config.gasEstimateUSD.toString()}
              onChange={(e) => setConfig({ ...config, gasEstimateUSD: safeFloat(e.target.value, config.gasEstimateUSD) })}
              hint="Estimated gas per tx"
            />
          </div>
        </div>

        {/* Market Filters */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Market Filters</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Min Liquidity ($)"
              type="number"
              value={config.minLiquidity.toString()}
              onChange={(e) => setConfig({ ...config, minLiquidity: safeInt(e.target.value, config.minLiquidity) })}
              hint="Minimum market liquidity"
            />
            <MatrixInput
              label="Min Volume 24h ($)"
              type="number"
              value={config.minVolume24h.toString()}
              onChange={(e) => setConfig({ ...config, minVolume24h: safeInt(e.target.value, config.minVolume24h) })}
              hint="Minimum 24h volume"
            />
          </div>
        </div>

        {/* Stop-Loss / Take-Profit */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Stop-Loss / Take-Profit</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixSlider
              label="Stop-Loss"
              min={5}
              max={50}
              step={1}
              value={Math.round(config.stopLossPercent * 100)}
              onChange={(v) => setConfig({ ...config, stopLossPercent: v / 100 })}
              valueFormat={(v) => `${v}%`}
            />
            <MatrixSlider
              label="Take-Profit"
              min={5}
              max={50}
              step={1}
              value={Math.round(config.takeProfitPercent * 100)}
              onChange={(v) => setConfig({ ...config, takeProfitPercent: v / 100 })}
              valueFormat={(v) => `${v}%`}
            />
          </div>
          <p className="text-agent-text-muted text-xs mt-2 font-sans">
            Applied to fallback positions when merge fails.
          </p>
        </div>

        {/* Multi-Outcome Toggle */}
        <div className="flex items-center justify-between p-3 bg-agent-bg/50 rounded-lg border border-agent-border">
          <div>
            <span className="text-agent-text text-sm font-mono">Multi-Outcome Events</span>
            <p className="text-agent-text-muted text-xs font-sans">
              Scan events with multiple related markets (experimental)
            </p>
          </div>
          <MatrixToggle
            enabled={config.enableMultiOutcome}
            onChange={(v) => setConfig({ ...config, enableMultiOutcome: v })}
          />
        </div>

        {/* Cross-Market Analysis */}
        <div className="mt-6 pt-6 border-t border-agent-green/20">
          <div className="flex items-center justify-between p-3 bg-agent-bg/50 rounded-lg border border-agent-border">
            <div>
              <span className="text-agent-text text-sm font-mono">Cross-Market Analysis (BETA)</span>
              <p className="text-agent-text-muted text-xs font-sans">
                AI-powered mutex detection between related markets
              </p>
            </div>
            <MatrixToggle
              enabled={config.enableCrossMarket}
              onChange={(v) => setConfig({ ...config, enableCrossMarket: v })}
            />
          </div>

          {config.enableCrossMarket && (
            <CrossMarketDetails config={config} setConfig={setConfig} />
          )}
        </div>

        <MatrixButton onClick={handleSave} className="w-full">
          {saved ? 'Settings Saved' : 'Save Settings'}
        </MatrixButton>
      </div>
    </MatrixCard>
  )
}

/**
 * Cross-Market Analysis Details — shown when enableCrossMarket is toggled on.
 * Displays LLM budget tracking and advanced settings.
 */
const CrossMarketDetails: React.FC<{
  config: ProjectFWConfig
  setConfig: (c: ProjectFWConfig) => void
}> = ({ config, setConfig }) => {
  const [budget] = useState({ dailyBudgetUSD: 0, dailySpendUSD: 0, callCountToday: 0 })
  const [showAdvanced, setShowAdvanced] = useState(false)

  const spentPct = budget.dailyBudgetUSD > 0
    ? Math.min(100, (budget.dailySpendUSD / budget.dailyBudgetUSD) * 100)
    : 0

  return (
    <div className="mt-3 pl-4 space-y-3 border-l-2 border-agent-green/30">
      <p className="text-agent-text-muted text-xs font-sans">
        Uses AI to detect mutually exclusive markets within events and validates arbitrage
        opportunities against cross-market constraints. Separate daily budget from LLM prediction.
        Currently validation-only mode.
      </p>

      {/* Budget Bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-agent-orange">
            Cross-Market Budget: ${budget.dailySpendUSD.toFixed(2)} / ${budget.dailyBudgetUSD.toFixed(2)}
          </span>
          <span className="text-agent-text-muted">
            {budget.callCountToday} calls
          </span>
        </div>
        <progress
          className="cross-market-budget-progress"
          value={spentPct}
          max={100}
          aria-label="Cross-market budget usage"
        />
      </div>

      {/* Advanced Settings Toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-sm text-agent-green hover:text-agent-orange transition-colors font-mono cursor-pointer"
      >
        {showAdvanced ? '- Hide' : '+ Show'} Advanced Settings
      </button>

      {showAdvanced && (
        <div className="space-y-4 pl-2">
          <MatrixSlider
            label="Min Mutex Confidence"
            min={50}
            max={95}
            step={5}
            value={Math.round((config.mutexConfidenceThreshold ?? 0.75) * 100)}
            onChange={(v) => setConfig({ ...config, mutexConfidenceThreshold: v / 100 })}
            valueFormat={(v) => `${v}%`}
          />
          <MatrixSlider
            label="Cache TTL (minutes)"
            min={15}
            max={120}
            step={15}
            value={Math.round((config.crossMarketCacheTTL ?? 3600000) / 60000)}
            onChange={(v) => setConfig({ ...config, crossMarketCacheTTL: v * 60000 })}
            valueFormat={(v) => `${v}m`}
          />
          <MatrixInput
            label="Daily LLM Budget ($)"
            type="number"
            step="0.10"
            value={(config.crossMarketBudgetUSD ?? 0.50).toString()}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              if (!isNaN(v)) setConfig({ ...config, crossMarketBudgetUSD: v })
            }}
            hint="Separate from prediction budget"
          />
          <MatrixInput
            label="Min Event Liquidity ($)"
            type="number"
            value={(config.minEventLiquidity ?? 10000).toString()}
            onChange={(e) => {
              const v = parseInt(e.target.value)
              if (!isNaN(v)) setConfig({ ...config, minEventLiquidity: v })
            }}
            hint="Skip low-liquidity events"
          />
        </div>
      )}
    </div>
  )
}

/**
 * Dip Arbitrage Settings
 */
const DipSettings: React.FC = () => {
  const strategy = dipArbStrategy
  const [config, setConfig] = useState<DipArbConfig>(strategy.getDipConfig())
  const [saved, setSaved] = useState(false)
  const { pennyTraderMode } = useSettingsStore()

  // Safe number parsers — reject NaN from empty/invalid inputs
  const safeFloat = (val: string, fallback: number) => {
    const n = parseFloat(val)
    return isNaN(n) ? fallback : n
  }
  const safeInt = (val: string, fallback: number) => {
    const n = parseInt(val)
    return isNaN(n) ? fallback : n
  }

  const handleSave = () => {
    strategy.setDipConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <MatrixCard title="DIP ARBITRAGE SETTINGS" subtitle="Configure dip buying parameters" variant="glass">
      <div className="space-y-6">
        <div className="bg-agent-green/10 border border-agent-green/30 rounded-lg p-4">
          <h4 className="text-agent-green text-sm font-bold mb-2 font-mono">Proven Configuration</h4>
          <p className="text-agent-text-muted text-xs font-sans">
            These settings achieved 86% ROI in backtesting. Adjust with caution.
          </p>
        </div>

        {/* Core Settings */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Trade Settings</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Position Size ($)"
              type="number"
              value={pennyTraderMode ? '1.00' : config.shares.toString()}
              onChange={(e) => setConfig({ ...config, shares: safeFloat(e.target.value, config.shares) })}
              hint={pennyTraderMode ? 'Overridden to $1.00 by Penny Mode' : 'Amount per trade'}
              disabled={pennyTraderMode}
            />
            <MatrixInput
              label="Max Concurrent"
              type="number"
              value={(config.maxConcurrentTrades ?? 3).toString()}
              onChange={(e) => setConfig({ ...config, maxConcurrentTrades: safeInt(e.target.value, config.maxConcurrentTrades ?? 3) })}
              hint="Max simultaneous trades"
            />
          </div>
        </div>

        {/* Dip Detection */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Dip Detection</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Dip Threshold (%)"
              type="number"
              step="5"
              value={(config.dipThreshold * 100).toFixed(1)}
              onChange={(e) => setConfig({ ...config, dipThreshold: safeFloat(e.target.value, config.dipThreshold * 100) / 100 })}
              hint="Minimum drop to trigger"
            />
            <MatrixInput
              label="Window (ms)"
              type="number"
              step="1000"
              value={config.slidingWindowMs.toString()}
              onChange={(e) => setConfig({ ...config, slidingWindowMs: safeInt(e.target.value, config.slidingWindowMs) })}
              hint="Detection window"
            />
            <MatrixInput
              label="Sum Target"
              type="number"
              step="0.01"
              value={config.sumTarget.toString()}
              onChange={(e) => setConfig({ ...config, sumTarget: safeFloat(e.target.value, config.sumTarget) })}
              hint="YES + NO minimum"
            />
            <MatrixInput
              label="Cooldown (ms)"
              type="number"
              step="5000"
              value={(config.cooldownMs ?? 30000).toString()}
              onChange={(e) => setConfig({ ...config, cooldownMs: safeInt(e.target.value, config.cooldownMs ?? 30000) })}
              hint="Between trades"
            />
          </div>
        </div>

        {/* Stop-Loss / Take-Profit (Fallback Positions) */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Stop-Loss / Take-Profit</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixSlider
              label="Stop-Loss"
              min={5}
              max={50}
              step={1}
              value={Math.round((config.stopLossPercent ?? 0.20) * 100)}
              onChange={(v) => setConfig({ ...config, stopLossPercent: v / 100 })}
              valueFormat={(v) => `${v}%`}
            />
            <MatrixSlider
              label="Take-Profit"
              min={5}
              max={50}
              step={1}
              value={Math.round((config.takeProfitPercent ?? 0.10) * 100)}
              onChange={(v) => setConfig({ ...config, takeProfitPercent: v / 100 })}
              valueFormat={(v) => `${v}%`}
            />
          </div>
          <p className="text-agent-text-muted text-xs mt-2 font-sans">
            Applied to fallback positions when Leg 2 or merge fails.
          </p>
        </div>

        <MatrixButton onClick={handleSave} className="w-full">
          {saved ? 'Settings Saved' : 'Save Settings'}
        </MatrixButton>
      </div>
    </MatrixCard>
  )
}


/**
 * Alert Settings — Telegram & Discord
 */
const AlertSettings: React.FC = () => {
  const {
    telegramBotToken, setTelegramBotToken,
    telegramChatId, setTelegramChatId,
    discordWebhookUrl, setDiscordWebhookUrl,
    alertOnTrade, setAlertOnTrade,
    alertOnError, setAlertOnError,
  } = useSettingsStore()

  const [tgToken, setTgToken] = useState(telegramBotToken)
  const [tgChatId, setTgChatId] = useState(telegramChatId)
  const [dcWebhook, setDcWebhook] = useState(discordWebhookUrl)
  const [testResult, setTestResult] = useState<string | null>(null)

  const handleSave = () => {
    setTelegramBotToken(tgToken.trim())
    setTelegramChatId(tgChatId.trim())
    setDiscordWebhookUrl(dcWebhook.trim())
    setTestResult('Saved')
    setTimeout(() => setTestResult(null), 2000)
  }

  const handleTestTelegram = async () => {
    if (!tgToken || !tgChatId) { setTestResult('Enter token + chat ID first'); return }
    setTestResult('Sending...')
    const ok = await notificationService.sendTelegram(tgToken.trim(), tgChatId.trim(), 'AlphaPolyBot test alert')
    setTestResult(ok ? 'Telegram OK' : 'Telegram failed — check token/chat ID')
    setTimeout(() => setTestResult(null), 4000)
  }

  const handleTestDiscord = async () => {
    if (!dcWebhook) { setTestResult('Enter webhook URL first'); return }
    setTestResult('Sending...')
    const ok = await notificationService.sendDiscord(dcWebhook.trim(), '**AlphaPolyBot** — test alert')
    setTestResult(ok ? 'Discord OK' : 'Discord failed — check webhook URL')
    setTimeout(() => setTestResult(null), 4000)
  }

  return (
    <MatrixCard title="ALERTS" subtitle="Telegram & Discord push notifications for trades and errors" variant="glass">
      <div className="space-y-6">
        {/* Event toggles */}
        <div className="bg-agent-bg/40 rounded-lg p-4 border border-agent-border/50">
          <h4 className="text-agent-green text-sm font-mono mb-3">Alert Events</h4>
          <div className="space-y-3">
            <MatrixToggle
              label="Trades & Sells"
              enabled={alertOnTrade}
              onChange={setAlertOnTrade}
              description="Push when a trade is placed or position closed"
            />
            <MatrixToggle
              label="Errors & Warnings"
              enabled={alertOnError}
              onChange={setAlertOnError}
              description="Push on strategy errors and risk warnings"
            />
          </div>
        </div>

        {/* Telegram */}
        <div className="bg-agent-bg/40 rounded-lg p-4 border border-agent-border/50">
          <h4 className="text-agent-green text-sm font-mono mb-3">Telegram</h4>
          <div className="space-y-3">
            <MatrixInput
              label="Bot Token"
              type="password"
              value={tgToken}
              onChange={(e) => setTgToken(e.target.value)}
              placeholder="123456:ABC..."
              hint="Create via @BotFather on Telegram"
            />
            <MatrixInput
              label="Chat ID"
              value={tgChatId}
              onChange={(e) => setTgChatId(e.target.value)}
              placeholder="-100..."
              hint="Your user/group/channel ID"
            />
            <MatrixButton size="sm" variant="secondary" onClick={handleTestTelegram}>
              Test Telegram
            </MatrixButton>
          </div>
        </div>

        {/* Discord */}
        <div className="bg-agent-bg/40 rounded-lg p-4 border border-agent-border/50">
          <h4 className="text-agent-green text-sm font-mono mb-3">Discord</h4>
          <div className="space-y-3">
            <MatrixInput
              label="Webhook URL"
              type="password"
              value={dcWebhook}
              onChange={(e) => setDcWebhook(e.target.value)}
              placeholder="https://discord.com/api/webhooks/..."
              hint="Server Settings → Integrations → Webhooks"
            />
            <MatrixButton size="sm" variant="secondary" onClick={handleTestDiscord}>
              Test Discord
            </MatrixButton>
          </div>
        </div>

        {/* Save + status */}
        <div className="flex items-center gap-4">
          <MatrixButton onClick={handleSave}>Save Alert Settings</MatrixButton>
          <AnimatePresence>
            {testResult && (
              <motion.span
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className={`text-sm font-mono ${testResult.includes('OK') || testResult === 'Saved' ? 'text-agent-green' : testResult.includes('failed') ? 'text-agent-red' : 'text-agent-text-muted'}`}
              >
                {testResult}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </MatrixCard>
  )
}

/**
 * API Settings
 */
const APISettings: React.FC = () => {
  const {
    polyBacktestApiKey, setPolyBacktestApiKey,
    relayerApiKey, setRelayerApiKey,
  } = useSettingsStore()
  const isWalletConnected = useWalletStore(s => s.isConnected)
  const [tavilyKey, setTavilyKey] = useState('')
  const [polyBacktestKey, setPolyBacktestKey] = useState(polyBacktestApiKey || '')
  const [relayerKey, setRelayerKey] = useState(relayerApiKey || '')
  const [saved, setSaved] = useState(false)

  // Hydrate Tavily key from secureStorage on mount
  useEffect(() => {
    import('@/utils/secureStorage').then(m => m.secureStorage.get<string>('tavily_api_key', true)).then(key => {
      if (key) setTavilyKey(key)
    }).catch(() => {})
  }, [])

  const handleSave = () => {
    import('@/utils/secureStorage').then(m => m.secureStorage.set('tavily_api_key', tavilyKey, { encrypt: true })).catch(() => {})
    setPolyBacktestApiKey(polyBacktestKey.trim())
    setRelayerApiKey(relayerKey.trim())

    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  const isTavilyConfigured = !!(tavilyKey && tavilyKey.length > 5)
  const isPolyBacktestConfigured = !!(polyBacktestKey && polyBacktestKey.length > 5)
  const isRelayerConfigured = !!(relayerKey && relayerKey.length > 5)
  const isWalletConfigured = isWalletConnected

  return (
    <MatrixCard title="API KEYS" subtitle="Configure external service API keys" variant="glass">
      <div className="space-y-6">
        <div className="bg-agent-bg/60 rounded-lg p-4">
          <p className="text-agent-text-muted text-sm font-sans">
            API keys are stored locally in your browser. They are never sent to any external server except the respective API providers.
          </p>
        </div>

        {/* API Status */}
        <div className="bg-agent-bg/40 rounded-lg p-4 border border-agent-border/50">
          <h4 className="text-agent-green text-sm font-mono mb-3">API Status</h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-agent-text-muted text-sm font-sans">Tavily (Optional)</span>
              <MatrixBadge variant={isTavilyConfigured ? 'success' : 'default'} size="sm">
                {isTavilyConfigured ? 'Configured' : 'Not Set'}
              </MatrixBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text-muted text-sm font-sans">PolyBacktest (Optional)</span>
              <MatrixBadge variant={isPolyBacktestConfigured ? 'success' : 'default'} size="sm">
                {isPolyBacktestConfigured ? 'Configured' : 'Not Set'}
              </MatrixBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text-muted text-sm font-sans">Relayer (Optional)</span>
              <MatrixBadge variant={isRelayerConfigured ? 'success' : 'default'} size="sm">
                {isRelayerConfigured ? 'Configured' : 'Not Set'}
              </MatrixBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text-muted text-sm font-sans">Wallet</span>
              <MatrixBadge variant={isWalletConfigured ? 'success' : 'warning'} size="sm">
                {isWalletConfigured ? 'Connected' : 'Not Connected'}
              </MatrixBadge>
            </div>
          </div>
        </div>

        {/* Wallet — CLOB credentials derived from wallet seed phrase */}
        <div className="bg-agent-bg/40 rounded-lg p-4 border border-agent-border/50">
          <h4 className="text-agent-green text-sm font-mono mb-2">Polymarket CLOB</h4>
          <p className="text-agent-text-muted text-xs font-sans">
            CLOB trading credentials are derived from your wallet seed phrase in the <strong>Wallet Connection</strong> panel above.
          </p>
        </div>

        <MatrixInput
          label="Tavily API Key (Optional)"
          type="password"
          value={tavilyKey}
          onChange={(e) => setTavilyKey(e.target.value)}
          placeholder="tvly-..."
          hint="For web search augmentation"
        />

        <MatrixInput
          label="PolyBacktest API Key (Optional)"
          type="password"
          value={polyBacktestKey}
          onChange={(e) => setPolyBacktestKey(e.target.value)}
          placeholder="pb-..."
          hint="For Crypto Up/Down backtesting and historical enrichment"
        />

        <MatrixInput
          label="Polymarket Relayer API Key (Optional)"
          type="password"
          value={relayerKey}
          onChange={(e) => setRelayerKey(e.target.value)}
          placeholder="Enter relayer API key..."
          hint="Enables gasless merges for Gabagool — no MATIC needed. Not persisted across reloads."
        />

        <div className="flex items-center gap-4">
          <MatrixButton onClick={handleSave}>
            Save API Keys
          </MatrixButton>
          <AnimatePresence>
            {saved && (
              <motion.span
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="text-agent-green text-sm font-mono"
              >
                Saved successfully
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </MatrixCard>
  )
}

/**
 * Risk Management Settings Panel
 */
const RiskManagementSettings: React.FC = () => {
  const {
    riskManagementEnabled, setRiskManagementEnabled,
    dailyLossLimit, setDailyLossLimit,
    weeklyLossLimit, setWeeklyLossLimit,
    maxTradesPerHour, setMaxTradesPerHour,
    consecutiveFailureLimit, setConsecutiveFailureLimit,
    minBalanceForTrade, setMinBalanceForTrade,
    aggressiveMode, setAggressiveMode,
  } = useSettingsStore()

  const [confirmAggressive, setConfirmAggressive] = useState(false)

  const [status, setStatus] = useState<RiskManagerStatus>(riskManager.getStatus())

  // Poll live status every 2 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setStatus(riskManager.getStatus())
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  return (
    <MatrixCard title="RISK MANAGEMENT" subtitle="Circuit breaker and trade safety limits" variant="glass">
      <div className="space-y-6">
        {/* Emergency Stop Banner */}
        <AnimatePresence>
          {status.emergencyStopped && (
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-red-900/20 border-2 border-red-500/50 rounded-lg p-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-red-500 font-bold font-mono">EMERGENCY STOP ACTIVE</h4>
                  <p className="text-red-400 text-sm mt-1 font-sans">{status.emergencyReason}</p>
                </div>
                <MatrixButton
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    riskManager.resetEmergencyStop()
                    setStatus(riskManager.getStatus())
                  }}
                >
                  Reset
                </MatrixButton>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Aggressive Mode Toggle */}
        <motion.div
          className={cn(
            'p-4 rounded-lg border-2 transition-all',
            aggressiveMode
              ? 'bg-amber-900/20 border-amber-500/50'
              : 'bg-agent-bg/60 border-agent-border'
          )}
        >
          <div
            className="flex items-center justify-between cursor-pointer"
            onClick={() => {
              if (aggressiveMode) {
                setAggressiveMode(false)
                setConfirmAggressive(false)
              } else {
                setConfirmAggressive(true)
              }
            }}
          >
            <div>
              <div className="flex items-center gap-2">
                <h4 className={cn(
                  'font-mono text-sm font-bold',
                  aggressiveMode ? 'text-amber-400' : 'text-agent-text-muted'
                )}>
                  AGGRESSIVE MODE
                </h4>
                {aggressiveMode && (
                  <MatrixBadge variant="warning" size="sm">ACTIVE</MatrixBadge>
                )}
              </div>
              <p className="text-agent-text-muted text-xs mt-1 font-sans">
                {aggressiveMode
                  ? 'Relaxed limits for maximum throughput. Higher risk, higher reward.'
                  : 'Batch-relax risk limits for faster trading. Requires separate dry run toggle.'}
              </p>
            </div>
            <div onClick={e => e.stopPropagation()}>
              <MatrixToggle
                enabled={aggressiveMode}
                onChange={(v) => {
                  if (!v) {
                    setAggressiveMode(false)
                    setConfirmAggressive(false)
                  } else {
                    setConfirmAggressive(true)
                  }
                }}
              />
            </div>
          </div>

          <AnimatePresence>
            {confirmAggressive && !aggressiveMode && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-3 pt-3 border-t border-amber-500/30 space-y-3">
                  <p className="text-amber-300 text-xs font-mono">This will change:</p>
                  <ul className="text-agent-text-muted text-xs font-sans space-y-1">
                    <li>Penny Trader Mode: <span className="text-red-400">OFF</span></li>
                    <li>Kelly Fraction: 0.25 → <span className="text-amber-400">0.40</span></li>
                    <li>Daily Loss Limit: $4 → <span className="text-amber-400">$25</span></li>
                    <li>Weekly Loss Limit: $20 → <span className="text-amber-400">$100</span></li>
                    <li>Max Trades/Hour: 20 → <span className="text-amber-400">40</span></li>
                    <li>Failure Limit: 5 → <span className="text-amber-400">8</span></li>
                    <li>Micro Min Signal: 40% → <span className="text-amber-400">30%</span></li>
                    <li>FW Min Profit: 50 bps → <span className="text-amber-400">30 bps</span></li>
                  </ul>
                  <p className="text-amber-300/70 text-xs font-sans">
                    Does NOT change Dry Run — you must toggle that separately.
                  </p>
                  <div className="flex gap-3">
                    <MatrixButton
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        setAggressiveMode(true)
                        setConfirmAggressive(false)
                      }}
                    >
                      Enable Aggressive
                    </MatrixButton>
                    <MatrixButton
                      variant="secondary"
                      size="sm"
                      onClick={() => setConfirmAggressive(false)}
                    >
                      Cancel
                    </MatrixButton>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Master Toggle */}
        <div
          className="flex items-center justify-between p-4 rounded-lg bg-agent-bg/60 cursor-pointer"
          onClick={() => setRiskManagementEnabled(!riskManagementEnabled)}
        >
          <div>
            <h4 className="text-agent-green font-mono text-sm">Enable Risk Management</h4>
            <p className="text-agent-text-muted text-xs mt-1 font-sans">
              When disabled, all safety checks are bypassed
            </p>
          </div>
          <div onClick={e => e.stopPropagation()}>
            <MatrixToggle
              enabled={riskManagementEnabled}
              onChange={setRiskManagementEnabled}
            />
          </div>
        </div>

        {/* Limit Controls */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Safety Limits</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Daily Loss Limit"
              value={dailyLossLimit}
              onChange={setDailyLossLimit}
              prefix="$"
              min={1}
              max={1000}
              step={5}
              disabled={!riskManagementEnabled}
              hint="Max loss in rolling 24h window"
            />
            <MatrixNumberInput
              label="Weekly Loss Limit"
              value={weeklyLossLimit}
              onChange={setWeeklyLossLimit}
              prefix="$"
              min={5}
              max={5000}
              step={10}
              disabled={!riskManagementEnabled}
              hint="Max loss in rolling 7-day window"
            />
            <MatrixNumberInput
              label="Max Trades / Hour"
              value={maxTradesPerHour}
              onChange={setMaxTradesPerHour}
              min={1}
              max={100}
              step={1}
              disabled={!riskManagementEnabled}
              hint="Rolling 60min window"
            />
            <MatrixNumberInput
              label="Consecutive Failure Limit"
              value={consecutiveFailureLimit}
              onChange={setConsecutiveFailureLimit}
              min={1}
              max={20}
              step={1}
              disabled={!riskManagementEnabled}
              hint="Triggers emergency stop"
            />
            <MatrixNumberInput
              label="Min Balance to Trade"
              value={minBalanceForTrade}
              onChange={setMinBalanceForTrade}
              prefix="$"
              min={1}
              max={500}
              step={1}
              disabled={!riskManagementEnabled}
              hint="Below this, trades are blocked"
            />
          </div>
        </div>

        {/* Live Status */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Live Status</h4>
          <div className="bg-agent-bg/60 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-agent-text-muted text-sm font-sans">Trades Last Hour</span>
              <span className="text-agent-green font-mono text-sm">
                <AnimatedCounter value={status.tradesLastHour} precision={0} /> / {status.config.maxTradesPerHour}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text-muted text-sm font-sans">P&L (24h)</span>
              <span className={cn(
                'font-mono text-sm',
                status.pnlLast24h >= 0 ? 'text-agent-green' : 'text-red-400'
              )}>
                <AnimatedCounter value={status.pnlLast24h} prefix={status.pnlLast24h >= 0 ? '+$' : '$'} precision={2} />
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text-muted text-sm font-sans">P&L (7d)</span>
              <span className={cn(
                'font-mono text-sm',
                status.pnlLast7d >= 0 ? 'text-agent-green' : 'text-red-400'
              )}>
                <AnimatedCounter value={status.pnlLast7d} prefix={status.pnlLast7d >= 0 ? '+$' : '$'} precision={2} />
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text-muted text-sm font-sans">Consecutive Failures</span>
              <span className={cn(
                'font-mono text-sm',
                status.consecutiveFailures > 0 ? 'text-agent-orange' : 'text-agent-green'
              )}>
                <AnimatedCounter value={status.consecutiveFailures} precision={0} /> / {status.config.consecutiveFailureLimit}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text-muted text-sm font-sans">Status</span>
              <MatrixBadge
                variant={status.emergencyStopped ? 'danger' : riskManagementEnabled ? 'success' : 'warning'}
                size="sm"
              >
                {status.emergencyStopped ? 'STOPPED' : riskManagementEnabled ? 'Active' : 'Disabled'}
              </MatrixBadge>
            </div>
          </div>
        </div>
      </div>
    </MatrixCard>
  )
}

/**
 * Crypto Up/Down Settings Panel
 */
const BtcUpDownSettings: React.FC = () => {
  const {
    pennyTraderMode,
    btcEnableBtc, setBtcEnableBtc,
    btcEnableEth, setBtcEnableEth,
    btcEnableSol, setBtcEnableSol,
    btcEnableXrp,
    btcEnable5m, setBtcEnable5m,
    btcEnable15m, setBtcEnable15m,
    btcEnableHourly, setBtcEnableHourly,
    btcEnable4h, setBtcEnable4h,
    btcEnableDaily, setBtcEnableDaily,
    btcTradeSize, setBtcTradeSize,
    btcUseKellySizing, setBtcUseKellySizing,
    btcMinConfidence, setBtcMinConfidence,
    btcMaxEntryPrice, setBtcMaxEntryPrice,
    btcMinEdgeOverMarket, setBtcMinEdgeOverMarket,
    btcMinWindowRemaining, setBtcMinWindowRemaining,
    btcStopLossPercent, setBtcStopLossPercent,
    btcTakeProfitPercent, setBtcTakeProfitPercent,
    btcMinTimeIntoWindowMs, setBtcMinTimeIntoWindowMs,
    btcRegimeFilterEnabled, setBtcRegimeFilterEnabled,
    btcRsiFilterEnabled, setBtcRsiFilterEnabled,
    btcUseLLMConfirmation, setBtcUseLLMConfirmation,
    btcLLMModel, setBtcLLMModel,
    btcUseLLMFusion, setBtcUseLLMFusion,
    btcLLMFusionWeight, setBtcLLMFusionWeight,
    btcLLMFusionPreFilter, setBtcLLMFusionPreFilter,
    btcFiveMinMakerMode, setBtcFiveMinMakerMode,
    btcFifteenMinMakerMode, setBtcFifteenMinMakerMode,
    btcHourlyMakerMode, setBtcHourlyMakerMode,
    btcFourHourMakerMode, setBtcFourHourMakerMode,
    btcEarlyExitEnabled, setBtcEarlyExitEnabled,
    btcEarlyExitTPPercent, setBtcEarlyExitTPPercent,
  } = useSettingsStore()

  const [saved, setSaved] = useState(false)
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagResult, setDiagResult] = useState<string | null>(null)

  const handleSave = () => {
    // Settings already persisted via Zustand — this is a UX confirmation
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <MatrixCard title="CRYPTO UP/DOWN STRATEGY" subtitle="Resolution-hold on cheap outcomes using multi-factor signals" variant="glass">
      <div className="space-y-6">
        {/* Asset Toggles */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Enabled Assets</h4>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">Bitcoin (BTC)</span>
              <MatrixToggle enabled={btcEnableBtc} onChange={setBtcEnableBtc} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">Ethereum (ETH)</span>
              <MatrixToggle enabled={btcEnableEth} onChange={setBtcEnableEth} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">Solana (SOL)</span>
              <MatrixToggle enabled={btcEnableSol} onChange={setBtcEnableSol} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">XRP</span>
              <MatrixToggle
                enabled={btcEnableXrp}
                onChange={(value) => useSettingsStore.setState({ btcEnableXrp: value })}
              />
            </div>
          </div>
        </div>

        {/* Duration Toggles */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Window Durations</h4>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">5 Minute</span>
              <MatrixToggle enabled={btcEnable5m} onChange={setBtcEnable5m} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">15 Minute</span>
              <MatrixToggle enabled={btcEnable15m} onChange={setBtcEnable15m} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">Hourly</span>
              <MatrixToggle enabled={btcEnableHourly} onChange={setBtcEnableHourly} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">4 Hour</span>
              <MatrixToggle enabled={btcEnable4h} onChange={setBtcEnable4h} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">Daily</span>
              <MatrixToggle enabled={btcEnableDaily} onChange={setBtcEnableDaily} />
            </div>
          </div>
        </div>

        {/* Maker Mode Toggles */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Maker Mode (0% Fees)</h4>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">5 Minute</span>
              <MatrixToggle enabled={btcFiveMinMakerMode} onChange={setBtcFiveMinMakerMode} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">15 Minute</span>
              <MatrixToggle enabled={btcFifteenMinMakerMode} onChange={setBtcFifteenMinMakerMode} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">Hourly</span>
              <MatrixToggle enabled={btcHourlyMakerMode} onChange={setBtcHourlyMakerMode} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">4 Hour</span>
              <MatrixToggle enabled={btcFourHourMakerMode} onChange={setBtcFourHourMakerMode} />
            </div>
          </div>
        </div>

        {/* Position Sizing */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Position Sizing</h4>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-agent-text font-sans text-sm">Use Kelly Criterion</span>
              <MatrixToggle enabled={btcUseKellySizing} onChange={setBtcUseKellySizing} />
            </div>
            {!btcUseKellySizing && (
              <MatrixInput
                label="Fixed Trade Size ($)"
                type="number"
                value={pennyTraderMode ? '1.00' : btcTradeSize.toString()}
                onChange={(e) => {
                  const n = parseFloat(e.target.value)
                  if (!isNaN(n)) setBtcTradeSize(n)
                }}
                hint={pennyTraderMode ? 'Overridden to $1.00 by Penny Mode' : 'USDC per bet'}
                disabled={pennyTraderMode}
              />
            )}
          </div>
        </div>

        {/* Entry Filters */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Entry Filters</h4>
          <div className="space-y-4">
            <MatrixSlider
              label="Min Confidence"
              value={btcMinConfidence}
              onChange={setBtcMinConfidence}
              min={0.20}
              max={0.80}
              step={0.02}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <MatrixSlider
              label="Max Entry Price"
              value={btcMaxEntryPrice}
              onChange={setBtcMaxEntryPrice}
              min={0.20}
              max={0.70}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}\u00a2`}
            />
            <MatrixSlider
              label="Min Edge Over Market"
              value={btcMinEdgeOverMarket}
              onChange={setBtcMinEdgeOverMarket}
              min={0.00}
              max={0.25}
              step={0.01}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <MatrixInput
              label="Min Window Remaining (seconds)"
              type="number"
              value={btcMinWindowRemaining.toString()}
              onChange={(e) => {
                const n = parseInt(e.target.value)
                if (!isNaN(n)) setBtcMinWindowRemaining(n)
              }}
              hint="Minimum seconds left in window to enter"
            />
            <MatrixInput
              label="Min Time Into Window (seconds)"
              type="number"
              value={Math.round(btcMinTimeIntoWindowMs / 1000).toString()}
              onChange={(e) => {
                const n = parseInt(e.target.value)
                if (!isNaN(n)) setBtcMinTimeIntoWindowMs(n * 1000)
              }}
              hint="Wait this long into window before trading"
            />
          </div>
        </div>

        {/* Signal Filters */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Signal Filters</h4>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-agent-text font-sans text-sm">Regime Filter</span>
                <p className="text-agent-text-muted text-xs font-sans">Skip choppy/mean-reverting markets</p>
              </div>
              <MatrixToggle enabled={btcRegimeFilterEnabled} onChange={setBtcRegimeFilterEnabled} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-agent-text font-sans text-sm">RSI Filter</span>
                <p className="text-agent-text-muted text-xs font-sans">Reduce confidence on overbought/oversold</p>
              </div>
              <MatrixToggle enabled={btcRsiFilterEnabled} onChange={setBtcRsiFilterEnabled} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-agent-text font-sans text-sm">LLM Signal Fusion</span>
                <p className="text-agent-text-muted text-xs font-sans">
                  Independent LLM prediction fused with mechanical signal (via Ollama)
                </p>
              </div>
              <MatrixToggle
                enabled={btcUseLLMFusion}
                onChange={setBtcUseLLMFusion}
              />
            </div>
            {btcUseLLMFusion && (
              <div className="space-y-3 pl-2 border-l border-agent-green/20">
                <MatrixSlider
                  label="LLM Weight"
                  value={btcLLMFusionWeight}
                  onChange={setBtcLLMFusionWeight}
                  min={0.10}
                  max={0.50}
                  step={0.05}
                  valueFormat={(v: number) => `${(v * 100).toFixed(0)}% LLM / ${((1 - v) * 100).toFixed(0)}% mechanical`}
                />
                <MatrixSlider
                  label="Pre-filter Threshold"
                  value={btcLLMFusionPreFilter}
                  onChange={setBtcLLMFusionPreFilter}
                  min={0.20}
                  max={0.50}
                  step={0.05}
                  valueFormat={(v: number) => `${(v * 100).toFixed(0)}% min confidence to call LLM`}
                />
              </div>
            )}
            {!btcUseLLMFusion && (
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-agent-text font-sans text-sm">LLM Confirmation (legacy)</span>
                  <p className="text-agent-text-muted text-xs font-sans">
                    AI verifies every signal before trading (via Ollama)
                  </p>
                </div>
                <MatrixToggle
                  enabled={btcUseLLMConfirmation}
                  onChange={setBtcUseLLMConfirmation}
                />
              </div>
            )}
            {(btcUseLLMFusion || btcUseLLMConfirmation) && (
              <MatrixSelect
                label="LLM Model"
                value={btcLLMModel}
                onChange={(e) => setBtcLLMModel(e.target.value)}
                options={[
                  { value: 'plutus', label: 'Plutus (Recommended — crypto-focused 8B)' },
                  { value: 'qwen3', label: 'Qwen3 8B (reasoning, general purpose)' },
                  { value: 'deepseek-r1', label: 'DeepSeek R1 8B (chain-of-thought reasoning)' },
                ]}
                hint="Local Ollama models — plutus is optimized for crypto trading analysis"
              />
            )}
          </div>
        </div>

        {/* Exit Strategy */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Exit Strategy</h4>

          {/* Early Exit Mode — primary toggle */}
          <div className={`rounded-lg p-4 mb-4 ${btcEarlyExitEnabled ? 'bg-agent-green/5 border border-agent-green/20' : 'bg-agent-bg-secondary/50 border border-agent-border/20'}`}>
            <MatrixToggle
              label="Early Exit Mode"
              description="Sell for profit before resolution (taker fees apply on exit)"
              enabled={btcEarlyExitEnabled}
              onChange={setBtcEarlyExitEnabled}
            />
            {btcEarlyExitEnabled && (
              <div className="mt-3 pl-1">
                <MatrixSlider
                  label="Take Profit Target (net)"
                  value={btcEarlyExitTPPercent}
                  onChange={setBtcEarlyExitTPPercent}
                  min={0.05}
                  max={0.50}
                  step={0.01}
                  valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
                />
                <p className="text-agent-text-muted text-xs mt-1">Net profit target after taker fee. PLM adds fee on top automatically.</p>
              </div>
            )}
            {!btcEarlyExitEnabled && (
              <p className="text-agent-text-label text-[10px] font-mono mt-2">
                Default: hold to resolution ($0 or $1 payout). Enable to take profits early.
              </p>
            )}
          </div>

          {/* Emergency SL/TP — secondary, dimmed when early exit is on */}
          <div className={btcEarlyExitEnabled ? 'opacity-50' : ''}>
            <p className="text-agent-text-muted text-[10px] font-mono mb-2 uppercase tracking-wider">
              Emergency Stops {btcEarlyExitEnabled && '(overridden by early exit)'}
            </p>
            <div className="space-y-3">
              <MatrixSlider
                label="Stop Loss"
                value={btcStopLossPercent}
                onChange={setBtcStopLossPercent}
                min={0.15}
                max={0.95}
                step={0.05}
                valueFormat={(v: number) => v >= 0.95 ? 'OFF (hold to resolution)' : `${(v * 100).toFixed(0)}%`}
              />
              <MatrixSlider
                label="Take Profit"
                value={btcTakeProfitPercent}
                onChange={setBtcTakeProfitPercent}
                min={0.20}
                max={0.95}
                step={0.05}
                valueFormat={(v: number) => v >= 0.95 ? 'OFF (hold to resolution)' : `${(v * 100).toFixed(0)}%`}
              />
            </div>
          </div>
        </div>

        {/* Diagnose Markets */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Market Diagnostics</h4>
          <MatrixButton
            variant="secondary"
            size="sm"
            loading={diagnosing}
            onClick={async () => {
              setDiagnosing(true)
              setDiagResult(null)
              try {
                const { polymarketClient } = await import('@/services/api')
                const nowSec = Math.floor(Date.now() / 1000)
                const window15m = Math.floor(nowSec / 900) * 900
                const slugs = [
                  { asset: 'BTC', slug: `btc-updown-15m-${window15m}`, dur: '15m' },
                  { asset: 'ETH', slug: `eth-updown-15m-${window15m}`, dur: '15m' },
                  { asset: 'SOL', slug: `sol-updown-15m-${window15m}`, dur: '15m' },
                  { asset: 'XRP', slug: `xrp-updown-15m-${window15m}`, dur: '15m' },
                ]
                const results: string[] = []
                for (const { asset, slug, dur } of slugs) {
                  try {
                    const event = await polymarketClient.getEventBySlug(slug)
                    const activeMarkets = event?.markets?.filter((m: { active: boolean; closed: boolean }) => m.active && !m.closed) || []
                    if (activeMarkets.length > 0) {
                      const prices = activeMarkets.map((m: { lastTradePrice?: number; outcomePrices?: number[] }) => m.lastTradePrice || m.outcomePrices?.[0] || 0)
                      results.push(`${asset} ${dur}: ${activeMarkets.length} mkt (${prices.map((p: number) => `${(Number(p) * 100).toFixed(0)}c`).join('/')})`)
                    }
                  } catch { /* skip failed lookups */ }
                }
                setDiagResult(results.length > 0
                  ? results.join(' | ')
                  : 'No Up/Down markets active right now (between windows?)')
              } catch (e) {
                setDiagResult(`Error: ${e instanceof Error ? e.message : 'unknown'}`)
              } finally {
                setDiagnosing(false)
              }
            }}
          >
            Diagnose Markets
          </MatrixButton>
          {diagResult && (
            <p className={`text-xs font-mono mt-2 ${diagResult.startsWith('Error') ? 'text-red-400' : 'text-agent-text-muted'}`}>
              {diagResult}
            </p>
          )}
        </div>

        {/* Info */}
        <div className="bg-agent-bg/60 rounded-lg p-4 space-y-2">
          <h4 className="text-agent-green text-sm font-mono">How It Works</h4>
          <ul className="text-agent-text-muted text-xs space-y-1 font-sans">
            <li>Resolution-hold: buys directional outcomes, holds to binary payout ($0 or $0.90 after 10% fee)</li>
            <li>5-factor signal: momentum, velocity, time decay, value bet, order flow (BinanceWS 1s feed)</li>
            <li>Regime filter skips choppy markets; RSI filter avoids chasing extended moves</li>
            <li>Reference price parsed from market question text for accurate signals</li>
            <li>Need &gt;56% accuracy at 50c entry to overcome 10% crypto fee</li>
          </ul>
        </div>

        <MatrixButton onClick={handleSave} className="w-full">
          {saved ? 'Settings Saved' : 'Save Settings'}
        </MatrixButton>
      </div>
    </MatrixCard>
  )
}

/**
 * Gabagool Accumulator Settings Panel
 */
/**
 * Dual-Side Hedge Settings Panel
 */
const DualSideSettings: React.FC = () => {
  const {
    dualSideEnabled, setDualSideEnabled,
    dualSideTradeSize, setDualSideTradeSize,
    dualSideBiasRatio, setDualSideBiasRatio,
    dualSideMakerOnly, setDualSideMakerOnly,
    dualSideMaxCombinedAsk, setDualSideMaxCombinedAsk,
    dualSideRequireBothLegs, setDualSideRequireBothLegs,
  } = useSettingsStore()

  return (
    <MatrixCard title="DUAL-SIDE HEDGE" subtitle="Maker-only YES+NO orders with directional bias on crypto binary markets" variant="glass">
      <div className="space-y-6">
        <div className="bg-agent-cyan/10 border border-agent-cyan/30 rounded-lg p-4">
          <h4 className="text-agent-cyan text-sm font-bold mb-2 font-mono">How It Works</h4>
          <p className="text-agent-text-muted text-xs font-sans">
            Places maker-only limit orders on both YES and NO sides of a binary market, weighted by a
            directional bias from BTC signal. Both legs earn 0% maker fees. Profits from the spread
            between combined entry cost and $1.00 resolution payout.
          </p>
        </div>

        {/* Enable Toggle */}
        <div className="flex items-center justify-between p-4 bg-agent-bg-secondary/50 rounded-lg">
          <div>
            <h4 className="text-agent-green text-sm font-mono">Enable Strategy</h4>
            <p className="text-agent-text-muted text-xs font-sans">Activate dual-side hedging</p>
          </div>
          <MatrixToggle enabled={dualSideEnabled} onChange={setDualSideEnabled} />
        </div>

        {/* Order Settings */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Order Settings</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Trade Size ($)"
              value={dualSideTradeSize}
              onChange={setDualSideTradeSize}
              min={0.5} max={20} step={0.5}
              hint="USDC per leg"
            />
            <div>
              <MatrixSlider
                label="Bias Ratio"
                value={dualSideBiasRatio}
                onChange={setDualSideBiasRatio}
                min={0.30}
                max={0.70}
                step={0.05}
                valueFormat={(v: number) => `${Math.round(v * 100)}/${Math.round((1 - v) * 100)}`}
              />
              <p className="text-[10px] text-agent-text-muted mt-1">YES/NO split (50/50 = neutral)</p>
            </div>
          </div>
        </div>

        {/* Entry Thresholds */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Entry Thresholds</h4>
          <MatrixSlider
            label="Max Combined Ask"
            value={dualSideMaxCombinedAsk}
            onChange={setDualSideMaxCombinedAsk}
            min={0.95}
            max={1.02}
            step={0.005}
            valueFormat={(v: number) => `$${v.toFixed(3)}`}
          />
          <p className="text-[10px] text-agent-text-muted mt-1">Only enter when YES ask + NO ask &lt; this value</p>
        </div>

        {/* Execution */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Execution</h4>
          <div className="space-y-3">
            <MatrixToggle
              label="Maker Only"
              description="Only fill as maker (0% fees, may not fill)"
              enabled={dualSideMakerOnly}
              onChange={setDualSideMakerOnly}
            />
            <MatrixToggle
              label="Require Both Legs"
              description="Only enter when both YES and NO orders can fill"
              enabled={dualSideRequireBothLegs}
              onChange={setDualSideRequireBothLegs}
            />
          </div>
        </div>
      </div>
    </MatrixCard>
  )
}

/**
 * Gabagool Accumulator Settings Panel
 */
const GabagoolSettings: React.FC = () => {
  const {
    gabagoolEnabled, setGabagoolEnabled,
    gabagoolMaxExposure, setGabagoolMaxExposure,
    gabagoolOrderSize, setGabagoolOrderSize,
    gabagoolCheapnessThreshold, setGabagoolCheapnessThreshold,
    gabagoolMaxImbalance, setGabagoolMaxImbalance,
    gabagoolMinProfitMargin, setGabagoolMinProfitMargin,
    gabagoolCooldownMs, setGabagoolCooldownMs,
    gabagoolDurations, setGabagoolDurations,
    gabagoolDepthAwareSizing, setGabagoolDepthAwareSizing,
    gabagoolAdaptiveCheapness, setGabagoolAdaptiveCheapness,
    gabagoolFillRateFeedback, setGabagoolFillRateFeedback,
    gabagoolSpreadMinWidth, setGabagoolSpreadMinWidth,
  } = useSettingsStore()

  const toggleDuration = useCallback((d: '15m' | '1h' | '4h') => {
    const current = gabagoolDurations || ['1h']
    if (current.includes(d)) {
      if (current.length > 1) setGabagoolDurations(current.filter(x => x !== d))
    } else {
      setGabagoolDurations([...current, d])
    }
  }, [gabagoolDurations, setGabagoolDurations])

  return (
    <MatrixCard title="GABAGOOL ACCUMULATOR" subtitle="Direction-agnostic accumulation merge arb on BTC markets" variant="glass">
      <div className="space-y-6">
        <div className="bg-agent-cyan/10 border border-agent-cyan/30 rounded-lg p-4">
          <h4 className="text-agent-cyan text-sm font-bold mb-2 font-mono">How It Works</h4>
          <p className="text-agent-text-muted text-xs font-sans">
            Buys whichever side (YES or NO) is temporarily cheap across the window.
            Locks profit when avg_YES + avg_NO &lt; $1.00. Maker-only orders (0% fees).
            Supports 15m, 1h, and 4h windows simultaneously.
          </p>
        </div>

        {/* Enable Toggle */}
        <div className="flex items-center justify-between p-4 bg-agent-bg-secondary/50 rounded-lg">
          <div>
            <h4 className="text-agent-green text-sm font-mono">Enable Strategy</h4>
            <p className="text-agent-text-muted text-xs font-sans">Activate accumulation arbitrage</p>
          </div>
          <MatrixToggle enabled={gabagoolEnabled} onChange={setGabagoolEnabled} />
        </div>

        {/* Window Durations */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Window Durations</h4>
          <div className="flex gap-3">
            {(['15m', '1h', '4h'] as const).map(d => (
              <button
                key={d}
                onClick={() => toggleDuration(d)}
                className={cn(
                  'px-4 py-2 rounded-lg font-mono text-sm border transition-all',
                  (gabagoolDurations || ['1h']).includes(d)
                    ? 'bg-agent-green/20 border-agent-green text-agent-green'
                    : 'bg-agent-bg-secondary/50 border-agent-text-muted/20 text-agent-text-muted',
                )}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="text-agent-text-muted text-xs font-sans mt-1">
            4h = most accumulation time, 1h = balanced, 15m = fast windows
          </p>
        </div>

        {/* Sizing */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Position Sizing</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Max Exposure / Window ($)"
              value={gabagoolMaxExposure}
              onChange={setGabagoolMaxExposure}
              min={1} max={100} step={1}
              hint="Total USDC per window"
            />
            <MatrixNumberInput
              label="Order Size ($)"
              value={gabagoolOrderSize}
              onChange={setGabagoolOrderSize}
              min={0.5} max={20} step={0.5}
              hint="USDC per individual order"
            />
          </div>
        </div>

        {/* Cheapness & Balance */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Entry Thresholds</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Cheapness Threshold"
              value={gabagoolCheapnessThreshold}
              onChange={setGabagoolCheapnessThreshold}
              min={0.30} max={0.55} step={0.01}
              hint="Max ask price to buy (e.g. 0.48 = 48¢)"
            />
            <MatrixNumberInput
              label="Max Imbalance"
              value={gabagoolMaxImbalance}
              onChange={setGabagoolMaxImbalance}
              min={0.05} max={0.50} step={0.05}
              hint="Max qty imbalance before rebalancing"
            />
          </div>
        </div>

        {/* Profit & Timing */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Profit & Timing</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Target Pair Cost"
              value={gabagoolMinProfitMargin}
              onChange={setGabagoolMinProfitMargin}
              min={0.90} max={0.999} step={0.005}
              hint="Max combined cost per pair (< $1.00)"
            />
            <MatrixNumberInput
              label="Cooldown (ms)"
              value={gabagoolCooldownMs}
              onChange={setGabagoolCooldownMs}
              min={1000} max={15000} step={500}
              hint="Min time between orders"
            />
          </div>
        </div>

        {/* Advanced Features */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Advanced Features</h4>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 bg-agent-bg-secondary/30 rounded-lg">
              <div>
                <span className="text-agent-text text-sm font-mono">Adaptive Cheapness</span>
                <p className="text-agent-text-muted text-xs font-sans">Widen threshold when ask sum &lt; 95¢</p>
              </div>
              <MatrixToggle enabled={gabagoolAdaptiveCheapness} onChange={setGabagoolAdaptiveCheapness} />
            </div>
            <div className="flex items-center justify-between p-3 bg-agent-bg-secondary/30 rounded-lg">
              <div>
                <span className="text-agent-text text-sm font-mono">Depth-Aware Sizing</span>
                <p className="text-agent-text-muted text-xs font-sans">Scale order size to book liquidity</p>
              </div>
              <MatrixToggle enabled={gabagoolDepthAwareSizing} onChange={setGabagoolDepthAwareSizing} />
            </div>
            <div className="flex items-center justify-between p-3 bg-agent-bg-secondary/30 rounded-lg">
              <div>
                <span className="text-agent-text text-sm font-mono">Fill-Rate Feedback</span>
                <p className="text-agent-text-muted text-xs font-sans">Auto-adjust limit offset from fill speed</p>
              </div>
              <MatrixToggle enabled={gabagoolFillRateFeedback} onChange={setGabagoolFillRateFeedback} />
            </div>
            <MatrixNumberInput
              label="Min Spread Width"
              value={gabagoolSpreadMinWidth}
              onChange={setGabagoolSpreadMinWidth}
              min={0} max={0.10} step={0.005}
              hint="Skip if bid-ask spread tighter than this (0 = disabled)"
            />
          </div>
        </div>
      </div>
    </MatrixCard>
  )
}

/**
 * Impulse Sniper Settings Panel
 */
const ImpulseSniperSettings: React.FC = () => {
  const {
    impulseEnabled, setImpulseEnabled,
    impulseThreshold,
    impulseConfirmationMs, setImpulseConfirmationMs,
    impulseSnapbackPct, setImpulseSnapbackPct,
    impulseTradeSize, setImpulseTradeSize,
    impulseCooldownMs, setImpulseCooldownMs,
    impulsePreferredDuration, setImpulsePreferredDuration,
    impulseOrderMode, setImpulseOrderMode,
    impulseMaxAskPrice, setImpulseMaxAskPrice,
    impulseAggressiveMode, setImpulseAggressiveMode,
    impulseLookbackSeconds, setImpulseLookbackSeconds,
    impulseAssets, setImpulseAssets,
    impulseThresholdETH, setImpulseThresholdETH,
    impulseThresholdSOL, setImpulseThresholdSOL,
    impulseThresholdXRP, setImpulseThresholdXRP,
    impulseStopLossPct, setImpulseStopLossPct,
    impulseTakeProfitPct,
    impulseVpinFilter,
  } = useSettingsStore()

  return (
    <MatrixCard title="IMPULSE SNIPER" subtitle="Latency arb on stale Polymarket odds after crypto impulse moves" variant="glass">
      <div className="space-y-6">
        <div className="bg-agent-cyan/10 border border-agent-cyan/30 rounded-lg p-4">
          <h4 className="text-agent-cyan text-sm font-bold mb-2 font-mono">How It Works</h4>
          <p className="text-agent-text-muted text-xs font-sans">
            Monitors BinanceWS 24/7 for sharp crypto price moves (BTC, ETH, SOL, XRP). When an impulse
            is confirmed (no snapback within {impulseConfirmationMs}ms), buys the directionally-correct
            Polymarket outcome before market makers reprice. Vol-aware thresholds, EdgeTracker circuit
            breaker, and optional VPIN toxicity filter protect against adverse selection.
          </p>
        </div>

        {/* Enable Toggle */}
        <div className="flex items-center justify-between p-4 bg-agent-bg-secondary/50 rounded-lg">
          <div>
            <h4 className="text-agent-green text-sm font-mono">Enable Strategy</h4>
            <p className="text-agent-text-muted text-xs font-sans">Activate impulse latency arbitrage</p>
          </div>
          <MatrixToggle enabled={impulseEnabled} onChange={setImpulseEnabled} />
        </div>

        {/* Aggressive Mode Toggle */}
        <div className="flex items-center justify-between p-4 bg-agent-bg-secondary/50 rounded-lg">
          <div>
            <h4 className="text-agent-green text-sm font-mono">Aggressive Mode</h4>
            <p className="text-agent-text-muted text-xs font-sans">Lower threshold to 100pts (more trades, smaller edge)</p>
          </div>
          <MatrixToggle enabled={impulseAggressiveMode} onChange={setImpulseAggressiveMode} />
        </div>

        {/* Asset Selection */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Tracked Assets</h4>
          <div className="grid grid-cols-4 gap-3">
            {(['BTC', 'ETH', 'SOL', 'XRP'] as const).map((asset) => {
              const isActive = impulseAssets.includes(asset)
              return (
                <button
                  key={asset}
                  onClick={() => {
                    if (isActive) {
                      if (impulseAssets.length > 1) {
                        setImpulseAssets(impulseAssets.filter(a => a !== asset))
                      }
                    } else {
                      setImpulseAssets([...impulseAssets, asset])
                    }
                  }}
                  className={`px-3 py-2 rounded border text-sm font-mono transition-all ${
                    isActive
                      ? 'bg-agent-green/20 border-agent-green text-agent-green'
                      : 'bg-agent-bg-secondary/50 border-agent-green/20 text-agent-text-muted hover:border-agent-green/50'
                  }`}
                >
                  {asset}
                </button>
              )
            })}
          </div>
          <p className="text-agent-text-muted text-xs mt-2 font-sans">At least one asset required. BTC threshold uses main setting above.</p>
        </div>

        {/* Per-Asset Thresholds */}
        {impulseAssets.length > 1 && (
          <div>
            <h4 className="text-agent-green text-sm font-mono mb-3">Per-Asset Thresholds ($)</h4>
            <div className="grid grid-cols-3 gap-4">
              {impulseAssets.includes('ETH') && (
                <MatrixNumberInput
                  label="ETH Threshold"
                  value={impulseThresholdETH}
                  onChange={setImpulseThresholdETH}
                  min={5} max={100} step={1}
                  hint="Min ETH USD move"
                />
              )}
              {impulseAssets.includes('SOL') && (
                <MatrixNumberInput
                  label="SOL Threshold"
                  value={impulseThresholdSOL}
                  onChange={setImpulseThresholdSOL}
                  min={0.5} max={20} step={0.5}
                  hint="Min SOL USD move"
                />
              )}
              {impulseAssets.includes('XRP') && (
                <MatrixNumberInput
                  label="XRP Threshold"
                  value={impulseThresholdXRP}
                  onChange={setImpulseThresholdXRP}
                  min={0.01} max={1} step={0.01}
                  hint="Min XRP USD move"
                />
              )}
            </div>
          </div>
        )}

        {/* VPIN Toxicity Filter */}
        <div className="flex items-center justify-between p-4 bg-agent-bg-secondary/50 rounded-lg">
          <div>
            <h4 className="text-agent-green text-sm font-mono">VPIN Toxicity Filter</h4>
            <p className="text-agent-text-muted text-xs font-sans">Skip trades when informed flow detected (VPIN &gt; threshold)</p>
          </div>
          <MatrixToggle
            enabled={impulseVpinFilter}
            onChange={(value) => useSettingsStore.setState({ impulseVpinFilter: value })}
          />
        </div>

        {/* Stop Loss / Take Profit */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Position Exits</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Stop Loss (%)"
              value={impulseStopLossPct * 100}
              onChange={(v) => setImpulseStopLossPct(v / 100)}
              min={5} max={50} step={5}
              hint="Auto-sell if loss exceeds this %"
            />
            <MatrixNumberInput
              label="Take Profit (%)"
              value={impulseTakeProfitPct * 100}
              onChange={(v) => useSettingsStore.setState({ impulseTakeProfitPct: v / 100 })}
              min={10} max={100} step={10}
              hint="Auto-sell if gain exceeds this %"
            />
          </div>
        </div>

        {/* Impulse Detection */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Impulse Detection</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Threshold ($)"
              value={impulseThreshold}
              onChange={(v) => useSettingsStore.setState({ impulseThreshold: v })}
              min={50} max={500} step={25}
              hint="Min BTC USD move to trigger"
            />
            <MatrixNumberInput
              label="Lookback (seconds)"
              value={impulseLookbackSeconds}
              onChange={setImpulseLookbackSeconds}
              min={1} max={10} step={1}
              hint="Compare price vs N seconds ago"
            />
          </div>
        </div>

        {/* Confirmation */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Confirmation</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Confirmation Delay (ms)"
              value={impulseConfirmationMs}
              onChange={setImpulseConfirmationMs}
              min={200} max={3000} step={100}
              hint="Wait this long for snapback check"
            />
            <MatrixNumberInput
              label="Snapback Abort (%)"
              value={impulseSnapbackPct}
              onChange={setImpulseSnapbackPct}
              min={0.20} max={0.80} step={0.05}
              hint="Abort if price retraces > this %"
            />
          </div>
        </div>

        {/* Execution */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Execution</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Trade Size ($)"
              value={impulseTradeSize}
              onChange={setImpulseTradeSize}
              min={1} max={50} step={1}
              hint="USDC per impulse trade"
            />
            <MatrixNumberInput
              label="Max Ask Price"
              value={impulseMaxAskPrice}
              onChange={setImpulseMaxAskPrice}
              min={0.40} max={0.80} step={0.01}
              hint="Skip if outcome already above this"
            />
          </div>
          <div className="grid grid-cols-2 gap-4 mt-4">
            <MatrixNumberInput
              label="Cooldown (ms)"
              value={impulseCooldownMs}
              onChange={setImpulseCooldownMs}
              min={1000} max={60000} step={1000}
              hint="Min time between trades"
            />
            <div>
              <label htmlFor="impulse-preferred-duration" className="block text-agent-text-muted text-xs font-mono mb-1">Preferred Duration</label>
              <select
                id="impulse-preferred-duration"
                aria-label="Preferred Duration"
                title="Preferred Duration"
                value={impulsePreferredDuration}
                onChange={(e) => setImpulsePreferredDuration(e.target.value as '15m' | '1h' | '4h')}
                className="w-full bg-agent-bg-secondary border border-agent-green/30 rounded px-3 py-2 text-agent-green text-sm font-mono focus:border-agent-green focus:outline-none"
              >
                <option value="1h">1 Hour (recommended)</option>
                <option value="4h">4 Hour</option>
                <option value="15m">15 Min (10% fee!)</option>
              </select>
              <p className="text-agent-text-muted text-xs mt-1 font-sans">1h = best fee/edge balance</p>
            </div>
          </div>
          <div className="mt-4">
            <div>
              <label htmlFor="impulse-order-mode" className="block text-agent-text-muted text-xs font-mono mb-1">Order Mode</label>
              <select
                id="impulse-order-mode"
                aria-label="Order Mode"
                title="Order Mode"
                value={impulseOrderMode}
                onChange={(e) => setImpulseOrderMode(e.target.value as 'fok' | 'gtd')}
                className="w-full bg-agent-bg-secondary border border-agent-green/30 rounded px-3 py-2 text-agent-green text-sm font-mono focus:border-agent-green focus:outline-none"
              >
                <option value="fok">FOK (instant fill, taker fee)</option>
                <option value="gtd">GTD (30s limit, maker fill attempt)</option>
              </select>
              <p className="text-agent-text-muted text-xs mt-1 font-sans">FOK = fastest execution for latency arb</p>
            </div>
          </div>
        </div>
      </div>
    </MatrixCard>
  )
}

const LiquidationMomentumSettings: React.FC = () => {
  const {
    liqEnabled, setLiqEnabled,
    liqMinThresholdUSD, setLiqMinThresholdUSD,
    liqMaxThresholdUSD, setLiqMaxThresholdUSD,
    liqWindowMs, setLiqWindowMs,
    liqCooldownMs, setLiqCooldownMs,
    liqTradeSize, setLiqTradeSize,
    liqMaxAskPrice, setLiqMaxAskPrice,
    liqOrderExpiryMs, setLiqOrderExpiryMs,
    liqStopLossPct, setLiqStopLossPct,
    liqTakeProfitPct, setLiqTakeProfitPct,
    liqPreferredDuration, setLiqPreferredDuration,
  } = useSettingsStore()

  return (
    <MatrixCard title="LIQUIDATION MOMENTUM" subtitle="Hyperliquid liquidation cascades → Polymarket 5m binary trades" variant="glass">
      <div className="space-y-6">
        <div className="bg-agent-cyan/10 border border-agent-cyan/30 rounded-lg p-4">
          <h4 className="text-agent-cyan text-sm font-bold mb-2 font-mono">How It Works</h4>
          <p className="text-agent-text-muted text-xs font-sans">
            Monitors BTC liquidation events on Hyperliquid via WebSocket. When long liquidations cascade
            ($25K–$100K), buys DOWN on the 5-minute Polymarket binary. When short liquidations cascade,
            buys UP. GTD maker-only orders (0% fees).
          </p>
        </div>

        {/* Enable Toggle */}
        <div className="flex items-center justify-between p-4 bg-agent-bg-secondary/50 rounded-lg">
          <div>
            <h4 className="text-agent-green text-sm font-mono">Enable Strategy</h4>
            <p className="text-agent-text-muted text-xs font-sans">Activate liquidation momentum trading</p>
          </div>
          <MatrixToggle enabled={liqEnabled} onChange={setLiqEnabled} />
        </div>

        {/* Liquidation Thresholds */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Liquidation Thresholds</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Min Threshold ($)"
              value={liqMinThresholdUSD}
              onChange={setLiqMinThresholdUSD}
              min={1000} max={500_000} step={5000}
              hint="Min liq volume to trigger signal"
            />
            <MatrixNumberInput
              label="Max Threshold ($)"
              value={liqMaxThresholdUSD}
              onChange={setLiqMaxThresholdUSD}
              min={10_000} max={1_000_000} step={10_000}
              hint="Above this = too chaotic, skip"
            />
          </div>
        </div>

        {/* Window & Cooldown */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Timing</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Accumulation Window (s)"
              value={liqWindowMs / 1000}
              onChange={(v) => setLiqWindowMs(v * 1000)}
              min={10} max={300} step={10}
              hint="Rolling window to sum liquidation volume"
            />
            <MatrixNumberInput
              label="Cooldown (s)"
              value={liqCooldownMs / 1000}
              onChange={(v) => setLiqCooldownMs(v * 1000)}
              min={10} max={600} step={10}
              hint="Min time between trades"
            />
          </div>
        </div>

        {/* Order Parameters */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Order Parameters</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Trade Size ($)"
              value={liqTradeSize}
              onChange={setLiqTradeSize}
              min={1} max={50} step={0.5}
              hint="USDC per trade"
            />
            <MatrixNumberInput
              label="Max Ask Price"
              value={liqMaxAskPrice}
              onChange={setLiqMaxAskPrice}
              min={0.30} max={0.70} step={0.01}
              hint="Skip if outcome already above this"
            />
            <MatrixNumberInput
              label="Order Expiry (s)"
              value={liqOrderExpiryMs / 1000}
              onChange={(v) => setLiqOrderExpiryMs(v * 1000)}
              min={10} max={120} step={5}
              hint="GTD order time-to-live"
            />
          </div>
        </div>

        {/* SL/TP */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Stop Loss / Take Profit</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixNumberInput
              label="Stop Loss (%)"
              value={liqStopLossPct * 100}
              onChange={(v) => setLiqStopLossPct(v / 100)}
              min={5} max={95} step={5}
              hint="SL percentage for positions"
            />
            <MatrixNumberInput
              label="Take Profit (%)"
              value={liqTakeProfitPct * 100}
              onChange={(v) => setLiqTakeProfitPct(v / 100)}
              min={10} max={95} step={5}
              hint="TP percentage for positions"
            />
          </div>
        </div>

        {/* Preferred Duration */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Market Window</h4>
          <div>
            <label htmlFor="liq-duration" className="block text-agent-text-muted text-xs font-mono mb-1">Preferred Duration</label>
            <select
              id="liq-duration"
              aria-label="Preferred Duration"
              title="Preferred Duration"
              value={liqPreferredDuration}
              onChange={(e) => setLiqPreferredDuration(e.target.value as '5m' | '15m')}
              className="w-full bg-agent-bg-secondary border border-agent-green/30 rounded px-3 py-2 text-agent-green text-sm font-mono focus:border-agent-green focus:outline-none"
            >
              <option value="5m">5 Min (recommended — tightest window)</option>
              <option value="15m">15 Min (fallback)</option>
            </select>
            <p className="text-agent-text-muted text-xs mt-1 font-sans">5m = tightest alignment with liquidation momentum decay</p>
          </div>
        </div>
      </div>
    </MatrixCard>
  )
}

export default SettingsView
