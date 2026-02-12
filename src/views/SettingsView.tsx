import React, { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MatrixCard, MatrixInput, MatrixButton, MatrixToggle, MatrixSelect, MatrixBadge, MatrixNumberInput, AnimatedCounter, MatrixSlider } from '@/components/ui'
import { useWalletStore, useSettingsStore } from '@/stores'
import { strategyManager } from '@/services/strategies'
import { tradingService, riskManager } from '@/services/trading'
import { openRouterService } from '@/services/llm'
import { clobClient } from '@/services/api/CLOBClient'
import type { AppSettings, LLMPredictionConfig, DipArbConfig, ProjectFWConfig } from '@/types'
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
  const [activeTab, setActiveTab] = useState<'trading' | 'risk' | 'wallet' | 'llm' | 'dip' | 'projectfw' | 'btcupdown' | 'micro' | 'api'>('trading')

  const tabs = [
    { id: 'trading', label: 'Trading Mode' },
    { id: 'risk', label: 'Risk Management' },
    { id: 'wallet', label: 'Wallet' },
    { id: 'llm', label: 'LLM Strategy' },
    { id: 'dip', label: 'Dip Arbitrage' },
    { id: 'projectfw', label: 'ProjectFW Arb' },
    { id: 'btcupdown', label: 'BTC Up/Down' },
    { id: 'micro', label: 'Micro Momentum' },
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
            {activeTab === 'wallet' && <WalletSettings />}
            {activeTab === 'llm' && <LLMSettings />}
            {activeTab === 'dip' && <DipSettings />}
            {activeTab === 'projectfw' && <ProjectFWSettings />}
            {activeTab === 'btcupdown' && <BtcUpDownSettings />}
            {activeTab === 'micro' && <MicroMomentumSettings />}
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
                <li>Token approvals are simulated</li>
                <li>Strategy logic runs normally for testing</li>
                <li>Activity log shows simulated trades</li>
              </ul>
            </div>

            <div className="flex items-start gap-3">
              <MatrixBadge variant="danger" size="sm">LIVE</MatrixBadge>
              <ul className="text-agent-text-muted text-xs font-sans space-y-1">
                <li>Real orders executed on Polygon mainnet</li>
                <li>Real USDC spent on trades</li>
                <li>Token approvals submitted as transactions</li>
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
  const { isConnected, address, proxyAddress, usdcBalance, balance, approvals, connect, disconnect, setProxyAddress } = useWalletStore()
  const [seedPhrase, setSeedPhrase] = useState('')
  const [proxyInput, setProxyInput] = useState(proxyAddress || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleConnect = async () => {
    if (!seedPhrase.trim()) {
      setError('Please enter your seed phrase or private key')
      return
    }

    setLoading(true)
    setError('')

    try {
      const success = await connect(seedPhrase)
      if (success) {
        setSeedPhrase('') // Clear sensitive data
      } else {
        // Pull error from store — walletService sets it on failure
        const storeError = useWalletStore.getState().error
        setError(storeError || 'Failed to connect wallet')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setLoading(false)
    }
  }

  const handleDisconnect = async () => {
    disconnect()
  }

  const handleApprove = async () => {
    setLoading(true)
    setError('')
    try {
      // Call walletService directly to get detailed error info
      const { walletService } = await import('@/services/wallet')
      const result = await walletService.ensureApprovals()
      // Sync approval state to store
      const state = walletService.getState()
      useWalletStore.setState({ approvals: state.approvals })
      if (!result.success) {
        setError(result.error ?? 'Token approval failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <MatrixCard title="WALLET CONNECTION" subtitle="Connect your Polygon wallet to trade" variant="glass">
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
                <span className="text-agent-text-muted text-sm font-sans">Signer (EOA):</span>
                <p className="text-agent-green font-mono text-sm mt-1">{address}</p>
              </div>
              {proxyAddress && (
                <div>
                  <span className="text-agent-text-muted text-sm font-sans">Polymarket Proxy (Funder):</span>
                  <p className="text-agent-orange font-mono text-sm mt-1">{proxyAddress}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-agent-text-muted text-sm font-sans">USDC Balance:</span>
                  <p className="text-agent-green font-mono text-lg">
                    <AnimatedCounter value={usdcBalance} prefix="$" precision={2} />
                  </p>
                </div>
                <div>
                  <span className="text-agent-text-muted text-sm font-sans">MATIC Balance:</span>
                  <p className="text-agent-green font-mono text-lg">
                    <AnimatedCounter value={balance} precision={4} />
                  </p>
                </div>
              </div>
            </div>

            {/* Low-MATIC gas warning */}
            {balance < 0.05 && balance > 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                <p className="text-yellow-400 text-sm font-mono">
                  Low MATIC: {balance.toFixed(4)} — approvals and trades need ~0.01-0.05 MATIC for gas
                </p>
              </div>
            )}
            {balance === 0 && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                <p className="text-red-400 text-sm font-mono">
                  No MATIC for gas — send POL/MATIC to your wallet before approving or trading
                </p>
              </div>
            )}

            {/* Approvals */}
            <div className="space-y-3">
              <h4 className="text-agent-text-muted text-sm font-sans">Token Approvals</h4>
              <div className="flex items-center gap-4">
                <MatrixBadge variant={approvals.usdc ? 'success' : 'warning'}>
                  USDC: {approvals.usdc ? 'Approved' : 'Not Approved'}
                </MatrixBadge>
                <MatrixBadge variant={approvals.ctf ? 'success' : 'warning'}>
                  CTF: {approvals.ctf ? 'Approved' : 'Not Approved'}
                </MatrixBadge>
              </div>
              {(!approvals.usdc || !approvals.ctf) && (
                <MatrixButton onClick={handleApprove} loading={loading} size="sm">
                  Approve Tokens
                </MatrixButton>
              )}
            </div>

            {/* Error display for connected state (approve failures, etc.) */}
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                <p className="text-red-400 text-sm font-mono">{error}</p>
              </div>
            )}

            <MatrixButton variant="danger" onClick={handleDisconnect}>
              Disconnect Wallet
            </MatrixButton>
          </>
        ) : (
          <>
            {/* Disconnected State */}
            <div className="bg-agent-bg/60 rounded-lg p-4 space-y-4">
              <p className="text-agent-text-muted text-sm font-sans">
                Enter your seed phrase or private key to connect. Credentials stay local and are never sent to any server.
              </p>
              <MatrixInput
                label="Seed Phrase or Private Key"
                type="password"
                value={seedPhrase}
                onChange={(e) => setSeedPhrase(e.target.value)}
                placeholder="12/24 words or hex private key"
                error={error}
              />
              <MatrixInput
                label="Polymarket Proxy Address (auto-computed)"
                value={proxyInput}
                onChange={(e) => {
                  setProxyInput(e.target.value)
                  // Manual override — only use if auto-compute is wrong
                  const val = e.target.value.trim()
                  setProxyAddress(/^0x[0-9a-fA-F]{40}$/.test(val) ? val : null)
                }}
                placeholder="Auto-computed on connect (leave blank)"
                hint="Auto-computed from your signer via CREATE2. Leave blank unless you need a manual override."
              />
            </div>

            <div className="bg-agent-orange/10 border border-agent-orange/30 rounded-lg p-4">
              <h4 className="text-agent-orange text-sm font-bold mb-2">Security Warning</h4>
              <ul className="text-agent-text-muted text-xs font-sans space-y-1">
                <li>Never share your seed phrase with anyone</li>
                <li>Only use a dedicated trading wallet</li>
                <li>This bot has full access to your wallet funds</li>
              </ul>
            </div>

            <MatrixButton onClick={handleConnect} loading={loading} className="w-full">
              Connect Wallet
            </MatrixButton>
          </>
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
  const { pennyTraderMode, llmWebSearchEnabled, setLlmWebSearchEnabled } = useSettingsStore()

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
    btcTradeSize, setBtcTradeSize,
    btcUseKellySizing, setBtcUseKellySizing,
    btcMinConfidence, setBtcMinConfidence,
    btcMaxEntryPrice, setBtcMaxEntryPrice,
    btcMinWindowRemaining, setBtcMinWindowRemaining,
    btcStopLossPercent, setBtcStopLossPercent,
    btcTakeProfitPercent, setBtcTakeProfitPercent,
  } = useSettingsStore()

  const [diagnosing, setDiagnosing] = useState(false)
  const [diagResult, setDiagResult] = useState<string | null>(null)

  return (
    <MatrixCard title="BTC UP/DOWN STRATEGY" subtitle="15-minute binary markets on crypto price direction" variant="glass">
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
              min={0.50}
              max={0.90}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <MatrixSlider
              label="Max Entry Price"
              value={btcMaxEntryPrice}
              onChange={setBtcMaxEntryPrice}
              min={0.30}
              max={0.90}
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
              hint="Minimum seconds left in 15-min window to enter"
            />
          </div>
        </div>

        {/* Risk Management */}
        <div>
          <h4 className="text-agent-green text-sm font-mono mb-3">Risk Management</h4>
          <div className="space-y-4">
            <MatrixSlider
              label="Stop Loss"
              value={btcStopLossPercent}
              onChange={setBtcStopLossPercent}
              min={0.10}
              max={0.50}
              step={0.05}
              valueFormat={(v: number) => `${(v * 100).toFixed(0)}%`}
            />
            <MatrixSlider
              label="Take Profit"
              value={btcTakeProfitPercent}
              onChange={setBtcTakeProfitPercent}
              min={0.10}
              max={0.50}
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
                const { gammaClient } = await import('@/services/api/GammaClient')
                const all = await gammaClient.getActiveMarkets()
                const check = (name: string) => all.filter(m => {
                  const q = m.question.toUpperCase()
                  return q.includes(name) && (q.includes('UP') || q.includes('DOWN'))
                }).length
                setDiagResult(`BTC: ${check('BITCOIN')}, ETH: ${check('ETHEREUM')}, SOL: ${check('SOLANA')} Up/Down markets (${all.length} total active)`)
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
            <li>Scans for active 15-min "Up or Down" markets via Gamma search API</li>
            <li>Fetches live crypto price from Binance (CoinGecko fallback)</li>
            <li>computeSignal() determines direction and confidence</li>
            <li>Positions auto-exit after 14 min (1-min buffer before resolution)</li>
            <li>Edit <code className="text-agent-cyan">BtcUpDownStrategy.ts</code> to customize signal logic</li>
          </ul>
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
    clobApiKey, setClobApiKey,
    clobSecret, setClobSecret,
    clobPassphrase, setClobPassphrase,
  } = useSettingsStore()
  const [openRouterKey, setOpenRouterKey] = useState(openRouterApiKey || localStorage.getItem('OPENROUTER_API_KEY') || '')
  const [llmModel, setLlmModel] = useState(localStorage.getItem('OPENROUTER_MODEL') || 'meta-llama/llama-3.1-70b-instruct')
  const [tavilyKey, setTavilyKey] = useState(localStorage.getItem('TAVILY_API_KEY') || '')
  const [clobKey, setClobKey] = useState(clobApiKey || '')
  const [clobSec, setClobSec] = useState(clobSecret || '')
  const [clobPass, setClobPass] = useState(clobPassphrase || '')
  const [saved, setSaved] = useState(false)
  const [credTestStatus, setCredTestStatus] = useState<'idle' | 'testing' | 'success' | 'fail'>('idle')
  const [credTestMsg, setCredTestMsg] = useState('')
  const [deriving, setDeriving] = useState(false)

  const { isConnected, syncBalances } = useWalletStore()

  const handleSave = () => {
    // Save to localStorage (legacy support)
    localStorage.setItem('OPENROUTER_API_KEY', openRouterKey)
    localStorage.setItem('TAVILY_API_KEY', tavilyKey)

    // Save to settings store (primary storage)
    setOpenRouterApiKey(openRouterKey)
    setClobApiKey(clobKey.trim())
    setClobSecret(clobSec.trim())
    setClobPassphrase(clobPass.trim())

    // Apply model selection
    localStorage.setItem('OPENROUTER_MODEL', llmModel)
    openRouterService.setConfig({ model: llmModel })

    // Refresh the OpenRouter service with the new API key
    openRouterService.refreshApiKey()

    // Hot-load CLOB creds into the live client if wallet is already connected
    const trimKey = clobKey.trim()
    const trimSec = clobSec.trim()
    const trimPass = clobPass.trim()
    if (trimKey && trimSec && trimPass) {
      clobClient.setCredentials({ key: trimKey, secret: trimSec, passphrase: trimPass })
      console.log('[Settings] CLOB API credentials applied to live client')

      // Refresh balances so the sidebar updates immediately
      if (isConnected) {
        syncBalances()
      }
    }

    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  // Check if API key is configured
  const isOpenRouterConfigured = !!(openRouterKey && openRouterKey.length > 10)
  const isTavilyConfigured = !!(tavilyKey && tavilyKey.length > 5)
  const isClobConfigured = !!(clobKey && clobSec && clobPass)

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
              <span className="text-agent-text-muted text-sm font-sans">Polymarket CLOB</span>
              <MatrixBadge variant={isClobConfigured ? 'success' : 'warning'} size="sm">
                {isClobConfigured ? 'Configured' : 'Not Set'}
              </MatrixBadge>
            </div>
          </div>
        </div>

        {/* Polymarket CLOB API Credentials */}
        <div className="bg-agent-bg/40 rounded-lg p-4 border border-agent-border/50">
          <h4 className="text-agent-green text-sm font-mono mb-2">Polymarket CLOB API (Builder Codes)</h4>
          <p className="text-agent-text-muted text-xs font-sans mb-4">
            Get these from polymarket.com/settings → Builder Codes → Create New.
            Required for live trading. Reconnect wallet after saving.
          </p>
          <div className="space-y-4">
            <MatrixInput
              label="API Key"
              type="password"
              value={clobKey}
              onChange={(e) => setClobKey(e.target.value)}
              placeholder="019c3fd9-4855-..."
              hint="UUID format from Builder Codes"
            />
            <MatrixInput
              label="Secret"
              type="password"
              value={clobSec}
              onChange={(e) => setClobSec(e.target.value)}
              placeholder="WHubhrw7rQ00..."
              hint="Base64-encoded HMAC secret"
            />
            <MatrixInput
              label="Passphrase"
              type="password"
              value={clobPass}
              onChange={(e) => setClobPass(e.target.value)}
              placeholder="6c430cc17b04..."
              hint="Hex string passphrase"
            />
          </div>
          <div className="flex gap-2 mt-3">
            <MatrixButton
              variant="secondary"
              size="sm"
              disabled={!isConnected || deriving}
              onClick={async () => {
                setDeriving(true)
                try {
                  const { clobClient } = await import('@/services/api')
                  const creds = await clobClient.deriveApiKey()
                  if (creds) {
                    setClobKey(creds.key)
                    setClobSec(creds.secret)
                    setClobPass(creds.passphrase)
                    setClobApiKey(creds.key)
                    setClobSecret(creds.secret)
                    setClobPassphrase(creds.passphrase)
                    setCredTestStatus('success')
                    setCredTestMsg('Credentials derived and saved')
                  } else {
                    setCredTestStatus('fail')
                    setCredTestMsg('Derive failed — this wallet may not be registered with Polymarket')
                  }
                } catch (err) {
                  setCredTestStatus('fail')
                  setCredTestMsg(err instanceof Error ? err.message : 'Derive failed')
                } finally {
                  setDeriving(false)
                }
              }}
            >
              {deriving ? 'Deriving...' : 'Derive from Wallet'}
            </MatrixButton>
            <MatrixButton
              variant="secondary"
              size="sm"
              disabled={!isConnected || !clobKey || !clobSec || !clobPass || credTestStatus === 'testing'}
              onClick={async () => {
                setCredTestStatus('testing')
                try {
                  const { clobClient } = await import('@/services/api')
                  const trimKey = clobKey.trim()
                  const trimSec = clobSec.trim()
                  const trimPass = clobPass.trim()
                  if (trimKey && trimSec && trimPass) {
                    clobClient.setCredentials({ key: trimKey, secret: trimSec, passphrase: trimPass })
                  }
                  const result = await clobClient.validateCredentials()
                  if (result.valid) {
                    setCredTestStatus('success')
                    setCredTestMsg('Credentials are valid')
                  } else {
                    setCredTestStatus('fail')
                    setCredTestMsg(result.error || 'Validation failed')
                  }
                } catch (err) {
                  setCredTestStatus('fail')
                  setCredTestMsg(err instanceof Error ? err.message : 'Test failed')
                }
              }}
            >
              {credTestStatus === 'testing' ? 'Testing...' : 'Test Credentials'}
            </MatrixButton>
          </div>
          {credTestStatus !== 'idle' && credTestStatus !== 'testing' && (
            <p className={`text-xs font-sans mt-2 ${credTestStatus === 'success' ? 'text-agent-green' : 'text-agent-red'}`}>
              {credTestMsg}
            </p>
          )}
          {!isConnected && (
            <p className="text-agent-text-muted text-xs font-sans mt-2">
              Connect wallet first to derive or test credentials.
            </p>
          )}
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
    minMaticForGas, setMinMaticForGas,
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
            <MatrixNumberInput
              label="Min MATIC for Gas"
              value={minMaticForGas}
              onChange={(v) => v !== undefined && setMinMaticForGas(v)}
              min={0.001}
              max={1}
              step={0.005}
              disabled={!riskManagementEnabled}
              hint="MATIC needed for on-chain gas fees"
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
