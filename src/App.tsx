import React, { useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from '@/components/layout'
import { TradingTerminal, PortfolioView, ActivityView, SettingsView } from '@/views'
import { useSettingsStore } from '@/stores'
import { tradingService } from '@/services/trading'
import { strategyManager } from '@/services/strategies'
import { openRouterService } from '@/services/llm'

/**
 * App - Main application component with routing
 */
const App: React.FC = () => {
  const { dryRun, openRouterApiKey } = useSettingsStore()
  const initialized = useRef(false)

  // Initialize strategy manager on first load
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const initializeApp = async () => {
      console.log('[App] Initializing AlphaPolyBot...')
      
      // Initialize strategy manager (registers LLM + Dip Arb strategies)
      try {
        await strategyManager.initialize()
        console.log('[App] Strategy manager initialized')
      } catch (error) {
        console.error('[App] Failed to initialize strategy manager:', error)
      }
    }

    initializeApp()
  }, [])

  // Sync dry run state with trading service on startup and changes
  useEffect(() => {
    tradingService.setConfig({ dryRun })
    console.log(`[App] Trading mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`)
  }, [dryRun])

  // Sync OpenRouter API key when changed in settings
  useEffect(() => {
    if (openRouterApiKey) {
      openRouterService.setApiKey(openRouterApiKey)
      console.log('[App] OpenRouter API key updated from settings')
    }
  }, [openRouterApiKey])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<TradingTerminal />} />
          <Route path="portfolio" element={<PortfolioView />} />
          <Route path="activity" element={<ActivityView />} />
          <Route path="settings" element={<SettingsView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
