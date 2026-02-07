import React, { useState, useEffect } from 'react'
import { MatrixCard, MatrixInput, MatrixButton, MatrixToggle, MatrixSelect, MatrixBadge } from '@/components/ui'
import { useWalletStore, useSettingsStore } from '@/stores'
import { walletService } from '@/services/wallet'
import { strategyManager } from '@/services/strategies'
import { tradingService } from '@/services/trading'
import { openRouterService } from '@/services/llm'
import type { AppSettings, LLMPredictionConfig, DipArbConfig } from '@/types'
import { cn } from '@/utils/cn'

/**
 * SettingsView - Application settings and configuration
 */
export const SettingsView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'trading' | 'wallet' | 'llm' | 'dip' | 'api'>('trading')

  const tabs = [
    { id: 'trading', label: '⚡ Trading Mode' },
    { id: 'wallet', label: 'Wallet' },
    { id: 'llm', label: 'LLM Strategy' },
    { id: 'dip', label: 'Dip Arbitrage' },
    { id: 'api', label: 'API Keys' },
  ]

  return (
    <div className="h-full flex gap-4">
      {/* Sidebar */}
      <div className="w-48 space-y-1">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={cn(
              'w-full text-left px-4 py-2.5 rounded-md font-mono text-sm transition-all',
              activeTab === tab.id
                ? 'bg-matrix-primary/10 text-matrix-primary border border-matrix-primary/30'
                : 'text-matrix-text-secondary hover:text-matrix-primary hover:bg-matrix-primary/5'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1">
        {activeTab === 'trading' && <TradingModeSettings />}
        {activeTab === 'wallet' && <WalletSettings />}
        {activeTab === 'llm' && <LLMSettings />}
        {activeTab === 'dip' && <DipSettings />}
        {activeTab === 'api' && <APISettings />}
      </div>
    </div>
  )
}

/**
 * Trading Mode Settings Panel - DRY RUN TOGGLE
 */
const TradingModeSettings: React.FC = () => {
  const { dryRun, setDryRun } = useSettingsStore()
  const [confirmLive, setConfirmLive] = useState(false)

  // Sync dry run state with trading service
  useEffect(() => {
    tradingService.setConfig({ dryRun })
  }, [dryRun])

  const handleToggleDryRun = (enabled: boolean) => {
    if (!enabled) {
      // Turning OFF dry run (going live) - require confirmation
      setConfirmLive(true)
    } else {
      // Turning ON dry run - safe, no confirmation needed
      setDryRun(true)
    }
  }

  const confirmGoLive = () => {
    setDryRun(false)
    setConfirmLive(false)
  }

  return (
    <MatrixCard title="TRADING MODE" subtitle="Control whether trades are executed for real">
      <div className="space-y-6">
        {/* Main Toggle */}
        <div className={cn(
          'p-6 rounded-lg border-2 transition-all',
          dryRun 
            ? 'bg-matrix-secondary/10 border-matrix-secondary/50' 
            : 'bg-red-900/20 border-red-500/50'
        )}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className={cn(
                'text-xl font-bold font-mono',
                dryRun ? 'text-matrix-secondary' : 'text-red-500'
              )}>
                {dryRun ? '🧪 DRY RUN MODE' : '🔴 LIVE TRADING'}
              </h3>
              <p className="text-matrix-text-secondary text-sm mt-1">
                {dryRun 
                  ? 'Orders are simulated. No real money is at risk.' 
                  : 'CAUTION: Real orders will be executed with real funds!'}
              </p>
            </div>
            <MatrixToggle
              enabled={dryRun}
              onChange={handleToggleDryRun}
              size="lg"
            />
          </div>
        </div>

        {/* Confirmation Dialog */}
        {confirmLive && (
          <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-4">
            <h4 className="text-red-500 font-bold mb-2">⚠️ Enable Live Trading?</h4>
            <p className="text-matrix-text-secondary text-sm mb-4">
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
        )}

        {/* Info Box */}
        <div className="bg-matrix-bg rounded-lg p-4 space-y-3">
          <h4 className="text-matrix-primary text-sm font-mono">What happens in each mode:</h4>
          
          <div className="space-y-2">
            <div className="flex items-start gap-3">
              <MatrixBadge variant="info" size="sm">DRY RUN</MatrixBadge>
              <ul className="text-matrix-text-secondary text-xs space-y-1">
                <li>• Orders are logged but not sent to Polymarket</li>
                <li>• Token approvals are simulated</li>
                <li>• Strategy logic runs normally for testing</li>
                <li>• Activity log shows simulated trades</li>
              </ul>
            </div>
            
            <div className="flex items-start gap-3">
              <MatrixBadge variant="danger" size="sm">LIVE</MatrixBadge>
              <ul className="text-matrix-text-secondary text-xs space-y-1">
                <li>• Real orders executed on Polygon mainnet</li>
                <li>• Real USDC spent on trades</li>
                <li>• Token approvals submitted as transactions</li>
                <li>• Profits and losses are real</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Current Status */}
        <div className="text-center text-matrix-text-secondary text-sm">
          Trading service configured: <span className={dryRun ? 'text-matrix-secondary' : 'text-red-500'}>
            {dryRun ? 'DRY RUN' : 'LIVE'}
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
  const { isConnected, address, usdcBalance, ctfBalance, approvals, connect, disconnect } = useWalletStore()
  const [seedPhrase, setSeedPhrase] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleConnect = async () => {
    if (!seedPhrase.trim()) {
      setError('Please enter your seed phrase')
      return
    }

    setLoading(true)
    setError('')

    try {
      await connect(seedPhrase)
      setSeedPhrase('') // Clear sensitive data
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
    try {
      await walletService.ensureApprovals()
      // Refresh store state
      const { connect } = useWalletStore.getState()
      // State should auto-update via the service
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <MatrixCard title="WALLET CONNECTION" subtitle="Connect your Polygon wallet to trade">
      <div className="space-y-6">
        {isConnected ? (
          <>
            {/* Connected State */}
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 bg-matrix-primary rounded-full animate-pulse" />
              <span className="text-matrix-primary font-mono">Connected</span>
            </div>

            <div className="bg-matrix-bg rounded-lg p-4 space-y-3">
              <div>
                <span className="text-matrix-text-secondary text-sm">Address:</span>
                <p className="text-matrix-primary font-mono text-sm mt-1">{address}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-matrix-text-secondary text-sm">USDC Balance:</span>
                  <p className="text-matrix-primary font-mono text-lg">${usdcBalance.toFixed(2)}</p>
                </div>
                <div>
                  <span className="text-matrix-text-secondary text-sm">CTF Balance:</span>
                  <p className="text-matrix-primary font-mono text-lg">{ctfBalance.toFixed(4)}</p>
                </div>
              </div>
            </div>

            {/* Approvals */}
            <div className="space-y-3">
              <h4 className="text-matrix-text-secondary text-sm">Token Approvals</h4>
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

            <MatrixButton variant="danger" onClick={handleDisconnect}>
              Disconnect Wallet
            </MatrixButton>
          </>
        ) : (
          <>
            {/* Disconnected State */}
            <div className="bg-matrix-bg rounded-lg p-4">
              <p className="text-matrix-text-secondary text-sm mb-4">
                Enter your wallet seed phrase to connect. Your seed phrase is encrypted locally and never sent to any server.
              </p>
              <MatrixInput
                label="Seed Phrase"
                type="password"
                value={seedPhrase}
                onChange={(e) => setSeedPhrase(e.target.value)}
                placeholder="Enter your 12 or 24 word seed phrase"
                error={error}
              />
            </div>

            <div className="bg-matrix-secondary/10 border border-matrix-secondary/30 rounded-lg p-4">
              <h4 className="text-matrix-secondary text-sm font-bold mb-2">⚠️ Security Warning</h4>
              <ul className="text-matrix-text-secondary text-xs space-y-1">
                <li>• Never share your seed phrase with anyone</li>
                <li>• Only use a dedicated trading wallet</li>
                <li>• This bot has full access to your wallet funds</li>
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
 * LLM Strategy Settings
 */
const LLMSettings: React.FC = () => {
  const strategy = strategyManager.getLLMStrategy()
  const [config, setConfig] = useState<LLMPredictionConfig>(strategy.getLLMConfig())

  const handleSave = () => {
    strategy.setLLMConfig(config)
  }

  const orderTypes = [
    { value: 'FOK', label: 'Fill or Kill (FOK)' },
    { value: 'FAK', label: 'Fill and Kill (FAK)' },
    { value: 'GTC', label: 'Good Till Cancel (GTC)' },
  ]

  return (
    <MatrixCard title="LLM PREDICTION SETTINGS" subtitle="Configure AI-powered trading parameters">
      <div className="space-y-6">
        {/* Position Sizing */}
        <div>
          <h4 className="text-matrix-primary text-sm font-mono mb-3">Position Sizing</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Base Size (%)"
              type="number"
              value={(config.baseSize * 100).toString()}
              onChange={(e) => setConfig({ ...config, baseSize: parseFloat(e.target.value) / 100 })}
              hint="Percentage of capital per trade"
            />
            <MatrixInput
              label="Max Position (%)"
              type="number"
              value={(config.maxPositionSize * 100).toString()}
              onChange={(e) => setConfig({ ...config, maxPositionSize: parseFloat(e.target.value) / 100 })}
              hint="Maximum position size"
            />
            <MatrixInput
              label="Confidence Multiplier"
              type="number"
              step="0.1"
              value={config.confidenceMultiplier.toString()}
              onChange={(e) => setConfig({ ...config, confidenceMultiplier: parseFloat(e.target.value) })}
              hint="Scale position by confidence"
            />
            <MatrixInput
              label="Min Confidence"
              type="number"
              step="0.05"
              value={config.minConfidence.toString()}
              onChange={(e) => setConfig({ ...config, minConfidence: parseFloat(e.target.value) })}
              hint="Minimum to trade"
            />
          </div>
        </div>

        {/* Market Filters */}
        <div>
          <h4 className="text-matrix-primary text-sm font-mono mb-3">Market Filters</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Min Odds"
              type="number"
              step="0.05"
              value={config.minOdds.toString()}
              onChange={(e) => setConfig({ ...config, minOdds: parseFloat(e.target.value) })}
            />
            <MatrixInput
              label="Max Odds"
              type="number"
              step="0.05"
              value={config.maxOdds.toString()}
              onChange={(e) => setConfig({ ...config, maxOdds: parseFloat(e.target.value) })}
            />
            <MatrixInput
              label="Min Liquidity ($)"
              type="number"
              value={config.minLiquidity.toString()}
              onChange={(e) => setConfig({ ...config, minLiquidity: parseFloat(e.target.value) })}
            />
            <MatrixInput
              label="Max Age (hours)"
              type="number"
              value={config.maxCreatedHours.toString()}
              onChange={(e) => setConfig({ ...config, maxCreatedHours: parseFloat(e.target.value) })}
            />
          </div>
        </div>

        {/* Order Settings */}
        <div>
          <h4 className="text-matrix-primary text-sm font-mono mb-3">Order Execution</h4>
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
              value={(config.maxSlippage * 100).toString()}
              onChange={(e) => setConfig({ ...config, maxSlippage: parseFloat(e.target.value) / 100 })}
            />
          </div>
        </div>

        <MatrixButton onClick={handleSave} className="w-full">
          Save Settings
        </MatrixButton>
      </div>
    </MatrixCard>
  )
}

/**
 * Dip Arbitrage Settings
 */
const DipSettings: React.FC = () => {
  const strategy = strategyManager.getDipStrategy()
  const [config, setConfig] = useState<DipArbConfig>(strategy.getDipConfig())

  const handleSave = () => {
    strategy.setDipConfig(config)
  }

  return (
    <MatrixCard title="DIP ARBITRAGE SETTINGS" subtitle="Configure dip buying parameters">
      <div className="space-y-6">
        <div className="bg-matrix-primary/10 border border-matrix-primary/30 rounded-lg p-4">
          <h4 className="text-matrix-primary text-sm font-bold mb-2">💎 Proven Configuration</h4>
          <p className="text-matrix-text-secondary text-xs">
            These settings achieved 86% ROI in backtesting. Adjust with caution.
          </p>
        </div>

        {/* Core Settings */}
        <div>
          <h4 className="text-matrix-primary text-sm font-mono mb-3">Trade Settings</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Position Size ($)"
              type="number"
              value={config.shares.toString()}
              onChange={(e) => setConfig({ ...config, shares: parseFloat(e.target.value) })}
              hint="Amount per trade"
            />
            <MatrixInput
              label="Max Concurrent"
              type="number"
              value={config.maxConcurrentTrades.toString()}
              onChange={(e) => setConfig({ ...config, maxConcurrentTrades: parseInt(e.target.value) })}
              hint="Max simultaneous trades"
            />
          </div>
        </div>

        {/* Dip Detection */}
        <div>
          <h4 className="text-matrix-primary text-sm font-mono mb-3">Dip Detection</h4>
          <div className="grid grid-cols-2 gap-4">
            <MatrixInput
              label="Dip Threshold (%)"
              type="number"
              step="5"
              value={(config.dipThreshold * 100).toString()}
              onChange={(e) => setConfig({ ...config, dipThreshold: parseFloat(e.target.value) / 100 })}
              hint="Minimum drop to trigger"
            />
            <MatrixInput
              label="Window (ms)"
              type="number"
              step="1000"
              value={config.slidingWindowMs.toString()}
              onChange={(e) => setConfig({ ...config, slidingWindowMs: parseInt(e.target.value) })}
              hint="Detection window"
            />
            <MatrixInput
              label="Sum Target"
              type="number"
              step="0.01"
              value={config.sumTarget.toString()}
              onChange={(e) => setConfig({ ...config, sumTarget: parseFloat(e.target.value) })}
              hint="YES + NO minimum"
            />
            <MatrixInput
              label="Cooldown (ms)"
              type="number"
              step="5000"
              value={config.cooldownMs.toString()}
              onChange={(e) => setConfig({ ...config, cooldownMs: parseInt(e.target.value) })}
              hint="Between trades"
            />
          </div>
        </div>

        <MatrixButton onClick={handleSave} className="w-full">
          Save Settings
        </MatrixButton>
      </div>
    </MatrixCard>
  )
}

/**
 * API Settings
 */
const APISettings: React.FC = () => {
  const { openRouterApiKey, setOpenRouterApiKey } = useSettingsStore()
  const [openRouterKey, setOpenRouterKey] = useState(openRouterApiKey || localStorage.getItem('OPENROUTER_API_KEY') || '')
  const [tavilyKey, setTavilyKey] = useState(localStorage.getItem('TAVILY_API_KEY') || '')
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    // Save to localStorage (legacy support)
    localStorage.setItem('OPENROUTER_API_KEY', openRouterKey)
    localStorage.setItem('TAVILY_API_KEY', tavilyKey)
    
    // Save to settings store (primary storage)
    setOpenRouterApiKey(openRouterKey)
    
    // Refresh the OpenRouter service with the new API key
    openRouterService.refreshApiKey()
    
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  // Check if API key is configured
  const isOpenRouterConfigured = !!(openRouterKey && openRouterKey.length > 10)
  const isTavilyConfigured = !!(tavilyKey && tavilyKey.length > 5)

  return (
    <MatrixCard title="API KEYS" subtitle="Configure external service API keys">
      <div className="space-y-6">
        <div className="bg-matrix-bg rounded-lg p-4">
          <p className="text-matrix-text-secondary text-sm">
            API keys are stored locally in your browser. They are never sent to any external server except the respective API providers.
          </p>
        </div>

        {/* API Status */}
        <div className="bg-matrix-bg/50 rounded-lg p-4 border border-matrix-border">
          <h4 className="text-matrix-primary text-sm font-mono mb-3">API Status</h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-matrix-text-secondary text-sm">OpenRouter</span>
              <MatrixBadge variant={isOpenRouterConfigured ? 'success' : 'warning'} size="sm">
                {isOpenRouterConfigured ? '✓ Configured' : '⚠ Not Set'}
              </MatrixBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-matrix-text-secondary text-sm">Tavily (Optional)</span>
              <MatrixBadge variant={isTavilyConfigured ? 'success' : 'default'} size="sm">
                {isTavilyConfigured ? '✓ Configured' : 'Not Set'}
              </MatrixBadge>
            </div>
          </div>
        </div>

        <MatrixInput
          label="OpenRouter API Key"
          type="password"
          value={openRouterKey}
          onChange={(e) => setOpenRouterKey(e.target.value)}
          placeholder="sk-or-v1-..."
          hint="Required for LLM analysis (Claude, GPT-4, etc.)"
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
          {saved && (
            <span className="text-matrix-primary text-sm animate-pulse">
              ✓ Saved successfully
            </span>
          )}
        </div>
      </div>
    </MatrixCard>
  )
}

export default SettingsView
