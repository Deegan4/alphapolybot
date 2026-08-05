import React, { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MatrixCard, MatrixInput, MatrixButton, MatrixToggle, MatrixSelect, MatrixBadge, MatrixNumberInput, AnimatedCounter, MatrixSlider } from '@/components/ui'
import { useWalletStore, useSettingsStore } from '@/stores'
import { strategyManager } from '@/services/strategies'
import { tradingService, riskManager } from '@/services/trading'
import { openRouterService } from '@/services/llm'
import { notificationService } from '@/services/notifications/NotificationService'
import type { AppSettings, LLMPredictionConfig, DipArbConfig, ProjectFWConfig, WalletEntry } from '@/types'
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
  const [activeTab, setActiveTab] = useState<'trading' | 'risk' | 'wallet' | 'llm' | 'dip' | 'projectfw' | 'btcupdown' | 'micro' | 'meanrev' | 'alerts' | 'api'>('trading')

  const tabs = [
    { id: 'trading', label: 'Trading Mode' },
    { id: 'risk', label: 'Risk Management' },
    { id: 'wallet', label: 'Wallet' },
    { id: 'llm', label: 'LLM Strategy' },
    { id: 'dip', label: 'Dip Arbitrage' },
    { id: 'projectfw', label: 'ProjectFW Arb' },
    { id: 'btcupdown', label: 'BTC Up/Down' },
    { id: 'micro', label: 'Micro Momentum' },
    { id: 'meanrev', label: 'Mean Reversion' },
    { id: 'copytrading', label: 'Copy Trading' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'api', label: 'API Keys' },
  ]

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

  return (
    <div className="h-full flex flex-col md:flex-row gap-4">
      {/* Tab list — horizontal scroll on mobile, vertical sidebar on md+ */}
      <div
        className="flex md:flex-col md:w-48 gap-1 overflow-x-auto hide-scrollbar pb-2 md:pb-0"
        role="tablist"
        aria-label="Settings sections"
        onKeyDown={handleTabKeyDown}
      >
        {tabs.map(tab => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
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

      {/* Content — animated tab transitions */}
      <div className="flex-1 min-h-0 overflow-auto" role="tabpanel" aria-label={tabs.find(t => t.id === activeTab)?.label}>
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
            {activeTab === 'micro' && <MicroMomentumSettings />}
            {activeTab === 'meanrev' && <MeanReversionSettings />}
            {activeTab === 'copytrading' && <CopyTradingSettings />}
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
  const { dryRun, setDryRun, pennyTraderMode, setPennyTraderMode, kellyFraction, setKellyFraction } = useSettingsStore()
  const [confirmLive, setConfirmLive] = useState(false)

  // Sync dry run state with trading service whenever it changes
  useEffect(() => {
    tradingService.setConfig({ dryRun })
  }, [dryRun])

  const handleToggleDryRun = (newDryRunValue: boolean) => {
    if (!newDryRunValue) {
      // Turning OFF dry run (going live) - require confirmation
      setConfirmLive(true)
    } else {
      // Turning ON dry run - safe, no confirmation needed
      setConfirmLive(false)
      setDryRun(true)
    }
  }

  const confirmGoLive = () => {
    setDryRun(false)
    setConfirmLive(false)
    // Belt-and-suspenders: directly push to tradingService in same tick
    tradingService.setConfig({ dryRun: false })
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
                <li>Orders are logged but not sent to Polymarket</li>
                <li>API calls are simulated</li>
                <li>Strategy logic runs normally for testing</li>
                <li>Activity log shows simulated trades</li>
              </ul>
            </div>

            <div className="flex items-start gap-3">
              <MatrixBadge variant="danger" size="sm">LIVE</MatrixBadge>
              <ul className="text-agent-text-muted text-xs font-sans space-y-1">
                <li>Real orders executed on Polymarket US</li>
                <li>Real USD spent on trades</li>
                <li>Orders placed via API</li>
                <li>Profits and losses are real</li>
              </ul>
            </div>
          </div>
        </div>

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
            <span className="text-agent-text text-sm font-mono">Kelly Fraction</span>
            <span className="text-agent-green text-sm font-mono font-bold">
              {kellyFraction === 0 ? 'Off' : kellyFraction <= 0.25 ? `${(kellyFraction * 4).toFixed(0)}/4 Kelly` : `${(kellyFraction * 100).toFixed(0)}%`}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={kellyFraction}
            onChange={(e) => setKellyFraction(parseFloat(e.target.value))}
            disabled={pennyTraderMode}
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
 * Wallet Settings Panel
 */
const WalletSettings: React.FC = () => {
  const { isConnected, keyId, balance, buyingPower, lastSync, connect, disconnect } = useWalletStore()
  const { pmUsKeyId, pmUsSecretKey, setPmUsKeyId, setPmUsSecretKey } = useSettingsStore()
  const [keyIdInput, setKeyIdInput] = useState(pmUsKeyId || '')
  const [secretInput, setSecretInput] = useState(pmUsSecretKey || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle')
  const [testError, setTestError] = useState('')

  const handleConnect = async () => {
    const trimKey = keyIdInput.trim()
    const trimSecret = secretInput.trim()
    if (!trimKey || !trimSecret) {
      setError('Both Key ID and Secret Key are required')
      return
    }

    setLoading(true)
    setError('')

    try {
      // Save to settings store first
      setPmUsKeyId(trimKey)
      setPmUsSecretKey(trimSecret)

      const success = await connect(trimKey, trimSecret)
      if (success) {
        setSecretInput('') // Clear sensitive data from local state
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
    setPmUsKeyId('')
    setPmUsSecretKey('')
    setKeyIdInput('')
    setSecretInput('')
  }

  return (
    <MatrixCard title="POLYMARKET US CONNECTION" subtitle="Connect with your PM US API credentials" variant="glass">
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
                <span className="text-agent-text-muted text-sm font-sans">Key ID:</span>
                <p className="text-agent-green font-mono text-sm mt-1">{keyId?.slice(0, 12)}...</p>
              </div>
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
                  <p className="text-agent-text-muted text-xs">Validates API credentials by fetching account balance</p>
                </div>
                <MatrixButton
                  size="sm"
                  loading={testStatus === 'testing'}
                  onClick={async () => {
                    setTestStatus('testing')
                    setTestError('')
                    try {
                      const { polymarketUSClient } = await import('@/services/api')
                      const result = await polymarketUSClient.validateCredentials()
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
                <div className="text-green-400 text-xs font-mono">API credentials validated successfully</div>
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
                Enter your Polymarket US API credentials. Get them from{' '}
                <a href="https://polymarket.us/developer" target="_blank" rel="noopener noreferrer"
                   className="text-agent-cyan underline">polymarket.us/developer</a>.
                Credentials stay local and are never sent to any external server.
              </p>
              <MatrixInput
                label="Key ID"
                type="text"
                value={keyIdInput}
                onChange={(e) => setKeyIdInput(e.target.value)}
                placeholder="e.g. abc123-def456-..."
                hint="UUID from the developer portal"
              />
              <MatrixInput
                label="Secret Key"
                type="password"
                value={secretInput}
                onChange={(e) => setSecretInput(e.target.value)}
                placeholder="Base64-encoded Ed25519 secret"
                error={error}
                hint="Ed25519 private key — stored locally only"
              />
            </div>

            <div className="bg-agent-orange/10 border border-agent-orange/30 rounded-lg p-4">
              <h4 className="text-agent-orange text-sm font-bold mb-2">Security Notice</h4>
              <ul className="text-agent-text-muted text-xs font-sans space-y-1">
                <li>Never share your secret key with anyone</li>
                <li>Only use a dedicated trading API key</li>
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
 * Wallet Registry — manage multiple PM US wallets
 */
const WalletRegistryPanel: React.FC = () => {
  const { wallets, activeWalletId, addWallet, removeWallet, setActiveWallet, renameWallet } = useSettingsStore()
  const { connect, disconnect } = useWalletStore()
  const [showAdd, setShowAdd] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newKeyId, setNewKeyId] = useState('')
  const [newSecret, setNewSecret] = useState('')
  const [addError, setAddError] = useState('')
  const [switching, setSwitching] = useState(false)

  const handleAdd = async () => {
    const label = newLabel.trim() || `Wallet ${wallets.length + 1}`
    const keyId = newKeyId.trim()
    const secret = newSecret.trim()
    if (!keyId || !secret) {
      setAddError('Key ID and Secret Key are required')
      return
    }
    setAddError('')

    const id = crypto.randomUUID()
    const entry: WalletEntry = { id, label, keyId }

    // Store secret in secureStorage (encrypted)
    try {
      const { secureStorage } = await import('@/utils/secureStorage')
      await secureStorage.set(`wallet-secret-${id}`, secret, { encrypt: true })
    } catch {
      setAddError('Failed to store credentials securely')
      return
    }

    addWallet(entry)
    setNewLabel('')
    setNewKeyId('')
    setNewSecret('')
    setShowAdd(false)
  }

  const handleSwitch = async (wallet: WalletEntry) => {
    if (wallet.id === activeWalletId) return
    setSwitching(true)
    try {
      const { walletService } = await import('@/services/wallet')
      const success = await walletService.switchWallet(wallet)
      if (success) {
        setActiveWallet(wallet.id)
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
      <MatrixCard title="WALLET REGISTRY" subtitle="Manage multiple PM US wallets" variant="glass">
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
    <MatrixCard title="WALLET REGISTRY" subtitle="Manage multiple PM US wallets" variant="glass">
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
              <span className="text-xs font-mono text-agent-text-muted ml-4">{w.keyId.slice(0, 12)}...</span>
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
            <MatrixInput label="Key ID" type="text" value={newKeyId} onChange={e => setNewKeyId(e.target.value)} placeholder="UUID from polymarket.us/developer" />
            <MatrixInput label="Secret Key" type="password" value={newSecret} onChange={e => setNewSecret(e.target.value)} placeholder="Base64 Ed25519 secret" error={addError} />
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
  const strategy = strategyManager.getLLMStrategy()
  const [config, setConfig] = useState<LLMPredictionConfig>(strategy.getLLMConfig())
  const [saved, setSaved] = useState(false)
  const {
    pennyTraderMode,
    llmWebSearchEnabled, setLlmWebSearchEnabled,
    llmPremiumModel, setLlmPremiumModel,
    llmPremiumThreshold, setLlmPremiumThreshold,
    llmPremiumBudgetUSD, setLlmPremiumBudgetUSD,
    cryptoLLMEnabled, setCryptoLLMEnabled,
    cryptoModel, setCryptoModel,
    cryptoScanIntervalMs, setCryptoScanIntervalMs,
    cryptoMinConfidence, setCryptoMinConfidence,
  } = useSettingsStore()

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

        {/* Web Search */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Web Search</h4>
          <MatrixToggle
            label="Enable Web Search"
            enabled={llmWebSearchEnabled}
            onChange={setLlmWebSearchEnabled}
          />
          <p className="text-agent-text-muted text-xs mt-2 font-sans">
            When enabled, the LLM researches current news and data before predicting (~$0.013/call vs $0.001 without).
          </p>
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

        {/* Premium Model Tiering */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Premium Model</h4>
          <p className="text-agent-text-muted text-xs mb-3 font-sans">
            Use a premium model for high-quality markets (quality score above threshold). Leave empty to disable.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Premium Model"
              value={llmPremiumModel}
              onChange={(e) => setLlmPremiumModel(e.target.value)}
              hint="e.g. openai/gpt-4o"
              placeholder="openai/gpt-4o"
            />
            <MatrixInput
              label="Daily Budget ($)"
              type="number"
              step="0.10"
              value={llmPremiumBudgetUSD.toString()}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (!isNaN(v)) setLlmPremiumBudgetUSD(Math.max(0.10, Math.min(5.0, v)))
              }}
              hint="$0.10 – $5.00"
            />
          </div>
          <div className="mt-3">
            <MatrixSlider
              label="Quality Threshold"
              min={15}
              max={40}
              step={1}
              value={llmPremiumThreshold}
              onChange={setLlmPremiumThreshold}
              valueFormat={(v) => `${v} pts`}
            />
            <p className="text-agent-text-muted text-xs mt-1 font-sans">
              Markets scoring above this threshold use the premium model. ~$0.007/call for GPT-4o.
            </p>
          </div>
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
  const strategy = strategyManager.getProjectFWStrategy()
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
  const [budget, setBudget] = useState(openRouterService.getCostStats('crossMarket'))
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Poll budget stats every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setBudget(openRouterService.getCostStats('crossMarket'))
    }, 5000)
    return () => clearInterval(interval)
  }, [])

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
        <div className="h-1.5 bg-black/50 rounded-full overflow-hidden">
          <div
            className="h-full bg-agent-orange transition-all duration-300 rounded-full"
            style={{ width: `${spentPct}%` }}
          />
        </div>
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
  const strategy = strategyManager.getDipStrategy()
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
 * Microstructure Momentum Settings Panel
 */
const MicroMomentumSettings: React.FC = () => {
  const {
    pennyTraderMode,
    microMinCompositeSignal, setMicroMinCompositeSignal,
    microMinSignalConfidence, setMicroMinSignalConfidence,
    microMaxSpreadFraction, setMicroMaxSpreadFraction,
    microTradeSize, setMicroTradeSize,
    microStopLossPercent, setMicroStopLossPercent,
    microTakeProfitPercent, setMicroTakeProfitPercent,
  } = useSettingsStore()

  return (
    <MatrixCard title="MICRO MOMENTUM STRATEGY" subtitle="Order flow-based directional trading using bid/ask imbalance" variant="glass">
      <div className="space-y-6">
        {/* Info */}
        <div className="bg-agent-green/10 border border-agent-green/30 rounded-lg p-4">
          <h4 className="text-agent-green text-sm font-bold mb-2 font-mono">Mechanical Order Flow</h4>
          <p className="text-agent-text-muted text-xs font-sans">
            Trades based on MicrostructureAnalyzer signals: bid/ask imbalance, spread dynamics,
            and composite order flow direction. No LLM required. Short holds (30min max).
          </p>
        </div>

        {/* Signal Thresholds */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Signal Thresholds</h4>
          <div className="space-y-4">
            <MatrixSlider
              label="Min Composite Signal"
              value={microMinCompositeSignal}
              onChange={setMicroMinCompositeSignal}
              min={0.20}
              max={0.80}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <p className="text-agent-text-muted text-xs font-sans -mt-2">
              Minimum |compositeSignal| to trigger a trade. Lower = more trades, higher = more selective.
            </p>

            <MatrixSlider
              label="Min Signal Confidence"
              value={microMinSignalConfidence}
              onChange={setMicroMinSignalConfidence}
              min={0.30}
              max={0.80}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <p className="text-agent-text-muted text-xs font-sans -mt-2">
              Data quality threshold. Higher requires more order book snapshots for confirmation.
            </p>

            <MatrixSlider
              label="Max Spread Fraction"
              value={microMaxSpreadFraction}
              onChange={setMicroMaxSpreadFraction}
              min={0.02}
              max={0.15}
              step={0.01}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <p className="text-agent-text-muted text-xs font-sans -mt-2">
              Reject illiquid markets with spreads wider than this.
            </p>
          </div>
        </div>

        {/* Position Sizing */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Position Sizing</h4>
          <MatrixInput
            label="Trade Size ($)"
            type="number"
            value={pennyTraderMode ? '1.00' : microTradeSize.toString()}
            onChange={(e) => {
              const n = parseFloat(e.target.value)
              if (!isNaN(n)) setMicroTradeSize(n)
            }}
            hint={pennyTraderMode ? 'Overridden to $1.00 by Penny Mode' : 'Max USDC per trade (Kelly may size smaller)'}
            disabled={pennyTraderMode}
          />
        </div>

        {/* Risk Management */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Risk Management</h4>
          <div className="space-y-4">
            <MatrixSlider
              label="Stop Loss"
              value={microStopLossPercent}
              onChange={setMicroStopLossPercent}
              min={0.05}
              max={0.30}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <MatrixSlider
              label="Take Profit"
              value={microTakeProfitPercent}
              onChange={setMicroTakeProfitPercent}
              min={0.10}
              max={0.50}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
          </div>
          <p className="text-agent-text-muted text-xs mt-2 font-sans">
            Tighter SL/TP than other strategies — these are momentum scalps with 30-min max hold.
          </p>
        </div>

        {/* How It Works */}
        <div className="bg-agent-bg/60 rounded-lg p-4 space-y-2">
          <h4 className="text-agent-green text-sm font-mono">How It Works</h4>
          <ul className="text-agent-text-muted text-xs space-y-1 font-sans">
            <li>Subscribes to WebSocket feeds for top markets by volume</li>
            <li>MicrostructureAnalyzer computes composite signal from bid/ask imbalance</li>
            <li>Positive signal (more bids) → BUY YES; Negative (more asks) → BUY NO</li>
            <li>Kelly-sized positions with order book depth verification</li>
            <li>PLM enforces SL/TP + 30-min hard exit (momentum trades don't "come back")</li>
            <li>Max 3 concurrent positions to limit exposure</li>
          </ul>
        </div>
      </div>
    </MatrixCard>
  )
}

/**
 * BTC Up/Down Settings Panel
 */
const BtcUpDownSettings: React.FC = () => {
  const {
    pennyTraderMode,
    btcEnableBtc, setBtcEnableBtc,
    btcEnableEth, setBtcEnableEth,
    btcEnableSol, setBtcEnableSol,
    btcEnableXrp, setBtcEnableXrp,
    btcEnable5m, setBtcEnable5m,
    btcEnable15m, setBtcEnable15m,
    btcEnableHourly, setBtcEnableHourly,
    btcEnableDaily, setBtcEnableDaily,
    btcTradeSize, setBtcTradeSize,
    btcUseKellySizing, setBtcUseKellySizing,
    btcMinConfidence, setBtcMinConfidence,
    btcMaxEntryPrice, setBtcMaxEntryPrice,
    btcMinWindowRemaining, setBtcMinWindowRemaining,
    btcStopLossPercent, setBtcStopLossPercent,
    btcTakeProfitPercent, setBtcTakeProfitPercent,
    btcMinTimeIntoWindowMs, setBtcMinTimeIntoWindowMs,
    btcRegimeFilterEnabled, setBtcRegimeFilterEnabled,
    btcRsiFilterEnabled, setBtcRsiFilterEnabled,
    btcUseLLMConfirmation, setBtcUseLLMConfirmation,
    btcLLMModel, setBtcLLMModel,
    openRouterApiKey,
  } = useSettingsStore()

  // OpenRouter key may live in store, localStorage, or env var
  const hasOpenRouterKey = !!(openRouterApiKey || import.meta.env.VITE_OPENROUTER_API_KEY)

  const [diagnosing, setDiagnosing] = useState(false)
  const [diagResult, setDiagResult] = useState<string | null>(null)

  return (
    <MatrixCard title="BTC UP/DOWN STRATEGY" subtitle="15m & 9PM binary markets on crypto price direction" variant="glass">
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
              <MatrixToggle enabled={btcEnableXrp} onChange={setBtcEnableXrp} />
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
              <span className="text-agent-text font-sans text-sm">Daily</span>
              <MatrixToggle enabled={btcEnableDaily} onChange={setBtcEnableDaily} />
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
                <span className="text-agent-text font-sans text-sm">LLM Confirmation</span>
                <p className="text-agent-text-muted text-xs font-sans">
                  {hasOpenRouterKey
                    ? 'AI verifies every signal before trading (~$0.002/call)'
                    : 'Requires OpenRouter API key (set in API Keys tab)'}
                </p>
              </div>
              <MatrixToggle
                enabled={btcUseLLMConfirmation}
                onChange={setBtcUseLLMConfirmation}
                disabled={!hasOpenRouterKey}
              />
            </div>
            {btcUseLLMConfirmation && (
              <MatrixSelect
                label="LLM Model"
                value={btcLLMModel}
                onChange={(e) => setBtcLLMModel(e.target.value)}
                options={[
                  { value: 'deepseek/deepseek-r1', label: 'DeepSeek R1 (Recommended — reasoning, ~$0.003/call)' },
                  { value: 'google/gemini-flash-1.5', label: 'Gemini 1.5 Flash (~$0.0002/call)' },
                  { value: 'meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B (~$0.0003/call)' },
                  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini (~$0.0004/call)' },
                  { value: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (~$0.006/call)' },
                ]}
                hint="Reasoning models (DeepSeek R1) work best for signal confirmation"
              />
            )}
          </div>
        </div>

        {/* Risk Management */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Risk Management</h4>
          <p className="text-agent-text-muted text-xs font-sans mb-3">Resolution-hold strategy: wide stops, hold to binary payout</p>
          <div className="space-y-4">
            <MatrixSlider
              label="Stop Loss"
              value={btcStopLossPercent}
              onChange={setBtcStopLossPercent}
              min={0.15}
              max={0.60}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <MatrixSlider
              label="Take Profit"
              value={btcTakeProfitPercent}
              onChange={setBtcTakeProfitPercent}
              min={0.20}
              max={1.00}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
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
                const { polymarketUSClient } = await import('@/services/api')
                // Use the same slug-based discovery the actual strategy uses
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
                    const event = await polymarketUSClient.getEventBySlug(slug)
                    const activeMarkets = event?.markets?.filter((m: { active: boolean; closed: boolean }) => m.active && !m.closed) || []
                    if (activeMarkets.length > 0) {
                      // US API: each market in event is a single outcome with its own price
                      const prices = activeMarkets.map((m: any) => m.lastTradePrice || m.outcomePrices?.[0] || 0)
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
      </div>
    </MatrixCard>
  )
}

/**
 * Mean Reversion Settings Panel — Coinbase Spot Crypto
 */
const MeanReversionSettings: React.FC = () => {
  const {
    coinbaseApiKey, setCoinbaseApiKey,
    coinbaseSecret, setCoinbaseSecret,
    mrEnableBtc, setMrEnableBtc,
    mrEnableEth, setMrEnableEth,
    mrEnableSol, setMrEnableSol,
    mrLookbackPeriod, setMrLookbackPeriod,
    mrEntryZScore, setMrEntryZScore,
    mrExitZScore, setMrExitZScore,
    mrTradeSize, setMrTradeSize,
    mrStopLossPercent, setMrStopLossPercent,
    mrTakeProfitPercent, setMrTakeProfitPercent,
  } = useSettingsStore()

  const [localKey, setLocalKey] = useState(coinbaseApiKey)
  const [localSecret, setLocalSecret] = useState(coinbaseSecret)
  const [saved, setSaved] = useState(false)

  const handleSaveCreds = () => {
    setCoinbaseApiKey(localKey.trim())
    setCoinbaseSecret(localSecret.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  const hasCredentials = !!(coinbaseApiKey && coinbaseSecret)

  return (
    <MatrixCard title="MEAN REVERSION STRATEGY" subtitle="Spot crypto trading via Coinbase (Bollinger Bands / Z-score)" variant="glass">
      <div className="space-y-6">
        {/* Info */}
        <div className="bg-agent-green/10 border border-agent-green/30 rounded-lg p-4">
          <h4 className="text-agent-green text-sm font-bold mb-2 font-mono">Coinbase Spot Trading</h4>
          <p className="text-agent-text-muted text-xs font-sans">
            Buys oversold dips (Z-score below threshold) and sells when price reverts to the mean.
            Uses BinanceWS for real-time price signals and Coinbase Advanced Trade for execution.
            Trades BTC-USD, ETH-USD, SOL-USD spot pairs.
          </p>
        </div>

        {/* Coinbase Credentials */}
        <div className="bg-agent-bg/40 rounded-lg p-4 border border-agent-border/50">
          <h4 className="text-agent-green text-sm font-mono mb-3">Coinbase Credentials</h4>
          <div className="space-y-3">
            <MatrixInput
              label="API Key"
              type="password"
              value={localKey}
              onChange={(e) => setLocalKey(e.target.value)}
              hint="From coinbase.com/settings/api — enable 'Trade' permission only"
            />
            <MatrixInput
              label="API Secret"
              type="password"
              value={localSecret}
              onChange={(e) => setLocalSecret(e.target.value)}
              hint="Base64-encoded secret from Coinbase"
            />
            <div className="flex items-center gap-3">
              <MatrixButton onClick={handleSaveCreds} variant="primary" size="sm">
                {saved ? 'Saved!' : 'Save Credentials'}
              </MatrixButton>
              <MatrixBadge variant={hasCredentials ? 'success' : 'warning'} size="sm">
                {hasCredentials ? 'Configured' : 'Not Set'}
              </MatrixBadge>
            </div>
          </div>
        </div>

        {/* Asset Toggles */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Enabled Assets</h4>
          <div className="space-y-3">
            <MatrixToggle label="BTC-USD" enabled={mrEnableBtc} onChange={setMrEnableBtc} />
            <MatrixToggle label="ETH-USD" enabled={mrEnableEth} onChange={setMrEnableEth} />
            <MatrixToggle label="SOL-USD" enabled={mrEnableSol} onChange={setMrEnableSol} />
          </div>
          <p className="text-agent-text-muted text-xs mt-2 font-sans">
            Toggle which assets the strategy trades. All disabled by default — enable after configuring credentials.
          </p>
        </div>

        {/* Signal Parameters */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Signal Parameters</h4>
          <div className="space-y-4">
            <MatrixSlider
              label="Lookback Period"
              value={mrLookbackPeriod}
              onChange={setMrLookbackPeriod}
              min={10}
              max={50}
              step={5}
              valueFormat={(v: number) => `${v} ticks`}
            />
            <p className="text-agent-text-muted text-xs font-sans -mt-2">
              Rolling window size for mean/stddev calculation. Larger = smoother, slower to react.
            </p>

            <MatrixSlider
              label="Entry Z-Score"
              value={mrEntryZScore}
              onChange={setMrEntryZScore}
              min={1.0}
              max={3.0}
              step={0.25}
              valueFormat={(v: number) => `${v.toFixed(2)}σ`}
            />
            <p className="text-agent-text-muted text-xs font-sans -mt-2">
              Buy when Z-score drops below -this value (oversold). Higher = more selective, fewer trades.
            </p>

            <MatrixSlider
              label="Exit Z-Score"
              value={mrExitZScore}
              onChange={setMrExitZScore}
              min={0.0}
              max={1.5}
              step={0.25}
              valueFormat={(v: number) => `${v.toFixed(2)}σ`}
            />
            <p className="text-agent-text-muted text-xs font-sans -mt-2">
              Sell when Z-score rises above this (mean reversion complete). Lower = exit earlier.
            </p>
          </div>
        </div>

        {/* Position Sizing */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Position Sizing</h4>
          <MatrixInput
            label="Trade Size ($)"
            type="number"
            value={mrTradeSize.toString()}
            onChange={(e) => {
              const n = parseFloat(e.target.value)
              if (!isNaN(n) && n >= 1) setMrTradeSize(n)
            }}
            hint="USD amount per trade (Coinbase min ~$1)"
          />
        </div>

        {/* Risk Management */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Risk Management</h4>
          <div className="space-y-4">
            <MatrixSlider
              label="Stop Loss"
              value={mrStopLossPercent}
              onChange={setMrStopLossPercent}
              min={0.01}
              max={0.10}
              step={0.005}
              valueFormat={(v: number) => `${(v * 100).toFixed(1)}%`}
            />
            <MatrixSlider
              label="Take Profit"
              value={mrTakeProfitPercent}
              onChange={setMrTakeProfitPercent}
              min={0.005}
              max={0.05}
              step={0.005}
              valueFormat={(v: number) => `${(v * 100).toFixed(1)}%`}
            />
          </div>
          <p className="text-agent-text-muted text-xs mt-2 font-sans">
            Tight SL/TP for mean reversion — positions exit when price reverts or hits limits. Max hold: 1 hour.
          </p>
        </div>

        {/* How It Works */}
        <div className="bg-agent-bg/60 rounded-lg p-4 space-y-2">
          <h4 className="text-agent-green text-sm font-mono">How It Works</h4>
          <ul className="text-agent-text-muted text-xs space-y-1 font-sans">
            <li>Streams BTC/ETH/SOL prices from Binance WebSocket (~1s updates)</li>
            <li>Computes rolling mean, stddev, and Z-score (Bollinger Bands)</li>
            <li>Z-score below -{mrEntryZScore.toFixed(1)}σ = BUY (oversold dip)</li>
            <li>Z-score above +{mrExitZScore.toFixed(1)}σ or SL/TP hit = SELL</li>
            <li>Executes market orders on Coinbase Advanced Trade (USD spot pairs)</li>
            <li>RiskManager circuit breaker enforces daily loss limits</li>
          </ul>
        </div>
      </div>
    </MatrixCard>
  )
}

/**
 * Copy Trading Settings Panel
 */
const CopyTradingSettings: React.FC = () => {
  const {
    followedAddress,
    copyTradeSize, setCopyTradeSize,
    copyMaxConcurrent, setCopyMaxConcurrent,
    copyPollIntervalMs, setCopyPollIntervalMs,
    copyStopLossPercent, setCopyStopLossPercent,
    copyTakeProfitPercent, setCopyTakeProfitPercent,
    copyBuysOnly, setCopyBuysOnly,
  } = useSettingsStore()

  return (
    <MatrixCard title="COPY TRADING" subtitle="Mirror trades from a followed Polymarket trader" variant="glass">
      <div className="space-y-6">
        {!followedAddress && (
          <div className="bg-agent-bg/60 rounded-lg p-4">
            <p className="text-agent-orange text-xs font-mono">
              No trader followed — paste an address in the Follow Trader panel (left sidebar) first.
            </p>
          </div>
        )}

        {followedAddress && (
          <div className="bg-agent-bg/60 rounded-lg p-3">
            <p className="text-agent-text-muted text-xs font-mono">
              Following: <span className="text-agent-cyan">{followedAddress.slice(0, 8)}...{followedAddress.slice(-4)}</span>
            </p>
          </div>
        )}

        {/* Position Sizing */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Position Sizing</h4>
          <div className="space-y-4">
            <MatrixSlider
              label="Trade Size"
              value={copyTradeSize}
              onChange={setCopyTradeSize}
              min={1}
              max={25}
              step={1}
              valueFormat={(v: number) => `$${v}`}
            />
            <p className="text-agent-text-muted text-xs font-sans -mt-2">
              USD amount per copied trade. RiskManager daily loss limit still applies.
            </p>
            <MatrixSlider
              label="Max Concurrent Positions"
              value={copyMaxConcurrent}
              onChange={setCopyMaxConcurrent}
              min={1}
              max={20}
              step={1}
              valueFormat={(v: number) => `${v}`}
            />
          </div>
        </div>

        {/* Polling */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Polling</h4>
          <MatrixSlider
            label="Poll Interval"
            value={copyPollIntervalMs / 1000}
            onChange={(v: number) => setCopyPollIntervalMs(v * 1000)}
            min={5}
            max={60}
            step={5}
            valueFormat={(v: number) => `${v}s`}
          />
          <p className="text-agent-text-muted text-xs font-sans mt-1">
            How often to check for new trades from the followed wallet. Lower = faster copies, more API calls.
          </p>
        </div>

        {/* Risk Management */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Risk Management</h4>
          <div className="space-y-4">
            <MatrixSlider
              label="Stop Loss"
              value={copyStopLossPercent}
              onChange={setCopyStopLossPercent}
              min={0.10}
              max={0.95}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <MatrixSlider
              label="Take Profit"
              value={copyTakeProfitPercent}
              onChange={setCopyTakeProfitPercent}
              min={0.10}
              max={0.95}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
          </div>
          <p className="text-agent-text-muted text-xs mt-2 font-sans">
            PLM monitors copied positions and auto-exits on SL/TP. These are separate from the whale's exit logic.
          </p>
        </div>

        {/* Behavior */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Behavior</h4>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={copyBuysOnly}
              onChange={(e) => setCopyBuysOnly(e.target.checked)}
              className="accent-agent-green"
            />
            <span className="text-agent-text text-xs font-mono">BUYs only (exits managed by PLM)</span>
          </label>
          <p className="text-agent-text-muted text-xs mt-1 font-sans">
            When enabled, only BUY trades are copied. Sell/exit decisions are handled by stop-loss and take-profit.
          </p>
        </div>

        {/* How It Works */}
        <div className="bg-agent-bg/60 rounded-lg p-4 space-y-2">
          <h4 className="text-agent-green text-sm font-mono">How It Works</h4>
          <ul className="text-agent-text-muted text-xs space-y-1 font-sans">
            <li>Polls the followed trader's trade history every {copyPollIntervalMs / 1000}s via Data API</li>
            <li>Detects new BUY trades and mirrors them at ${copyTradeSize} per trade</li>
            <li>PLM tracks each position with {(copyStopLossPercent * 100).toFixed(0)}% SL / {(copyTakeProfitPercent * 100).toFixed(0)}% TP</li>
            <li>RiskManager circuit breaker enforces daily loss limits</li>
            <li>Max {copyMaxConcurrent} concurrent copied positions</li>
          </ul>
        </div>
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
    openRouterApiKey, setOpenRouterApiKey,
    pmUsKeyId, pmUsSecretKey,
    polyBacktestApiKey, setPolyBacktestApiKey,
  } = useSettingsStore()
  const [openRouterKey, setOpenRouterKey] = useState(openRouterApiKey || '')
  // Model choice isn't a secret — plain localStorage is fine for it.
  const [llmModel, setLlmModel] = useState(localStorage.getItem('OPENROUTER_MODEL') || 'meta-llama/llama-3.1-70b-instruct')
  const [tavilyKey, setTavilyKey] = useState('')
  const [polyBacktestKey, setPolyBacktestKey] = useState(polyBacktestApiKey || '')
  const [saved, setSaved] = useState(false)

  // Tavily has no slot in the settings store, so it lives in secureStorage
  // (encrypted) and loads asynchronously.
  useEffect(() => {
    let cancelled = false
    import('@/utils/secureStorage')
      .then(({ secureStorage }) => secureStorage.get<string>('tavily-api-key', true))
      .then((key) => { if (!cancelled && key) setTavilyKey(key) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const handleSave = () => {
    // Credentials go to the encrypted settings store — never plain localStorage.
    setOpenRouterApiKey(openRouterKey)
    setPolyBacktestApiKey(polyBacktestKey.trim())

    import('@/utils/secureStorage')
      .then(({ secureStorage }) => secureStorage.set('tavily-api-key', tavilyKey, { encrypt: true }))
      .catch(() => {})

    // Apply model selection
    localStorage.setItem('OPENROUTER_MODEL', llmModel)
    openRouterService.setConfig({ model: llmModel })

    // Refresh the OpenRouter service with the new API key
    openRouterService.refreshApiKey()

    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  // Check if API key is configured
  const isOpenRouterConfigured = !!(openRouterKey && openRouterKey.length > 10)
  const isTavilyConfigured = !!(tavilyKey && tavilyKey.length > 5)
  const isPolyBacktestConfigured = !!(polyBacktestKey && polyBacktestKey.length > 5)
  const isPmUsConfigured = !!(pmUsKeyId && pmUsSecretKey)

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
              <span className="text-agent-text-muted text-sm font-sans">OpenRouter</span>
              <MatrixBadge variant={isOpenRouterConfigured ? 'success' : 'warning'} size="sm">
                {isOpenRouterConfigured ? 'Configured' : 'Not Set'}
              </MatrixBadge>
            </div>
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
              <span className="text-agent-text-muted text-sm font-sans">Polymarket US</span>
              <MatrixBadge variant={isPmUsConfigured ? 'success' : 'warning'} size="sm">
                {isPmUsConfigured ? 'Configured' : 'Not Set'}
              </MatrixBadge>
            </div>
          </div>
        </div>

        {/* Polymarket US Credentials — managed in Wallet Connection panel */}
        <div className="bg-agent-bg/40 rounded-lg p-4 border border-agent-border/50">
          <h4 className="text-agent-green text-sm font-mono mb-2">Polymarket US API</h4>
          <p className="text-agent-text-muted text-xs font-sans">
            PM US credentials (Key ID + Secret Key) are configured in the <strong>Wallet Connection</strong> panel above.
          </p>
        </div>

        <MatrixInput
          label="OpenRouter API Key"
          type="password"
          value={openRouterKey}
          onChange={(e) => setOpenRouterKey(e.target.value)}
          placeholder="sk-or-v1-..."
          hint="Required for LLM analysis"
        />

        <MatrixSelect
          label="LLM Model"
          value={llmModel}
          onChange={(e) => setLlmModel(e.target.value)}
          options={[
            { value: 'meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B (Recommended — ~$0.0003/call)' },
            { value: 'google/gemini-flash-1.5', label: 'Gemini 1.5 Flash (~$0.0002/call)' },
            { value: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (~$0.006/call)' },
            { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini (~$0.0004/call)' },
          ]}
          hint="Cheaper models reduce 402 errors. Llama 3.1 70B is 10× cheaper than Claude."
        />

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
          hint="For BTC Up/Down backtesting and historical enrichment"
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
              onChange={(v) => v !== undefined && setDailyLossLimit(v)}
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
              onChange={(v) => v !== undefined && setWeeklyLossLimit(v)}
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
              onChange={(v) => v !== undefined && setMaxTradesPerHour(v)}
              min={1}
              max={100}
              step={1}
              disabled={!riskManagementEnabled}
              hint="Rolling 60min window"
            />
            <MatrixNumberInput
              label="Consecutive Failure Limit"
              value={consecutiveFailureLimit}
              onChange={(v) => v !== undefined && setConsecutiveFailureLimit(v)}
              min={1}
              max={20}
              step={1}
              disabled={!riskManagementEnabled}
              hint="Triggers emergency stop"
            />
            <MatrixNumberInput
              label="Min Balance to Trade"
              value={minBalanceForTrade}
              onChange={(v) => v !== undefined && setMinBalanceForTrade(v)}
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

export default SettingsView
