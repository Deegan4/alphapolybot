import React, { useEffect, useRef, useState } from 'react'
import { strategyManager, type StrategyState } from '@/services/strategies'
import { useSettingsStore } from '@/stores'

interface StrategyDropdownProps {
  onClose: () => void
}

/** Short display labels for each strategy */
const SHORT_NAMES: Record<string, string> = {
  'llm-prediction': 'LLM',
  'btc-updown': 'BTC Up/Down',
  'micro-momentum': 'Micro Mom',
  'project-fw': 'FW Arb',
  'dip-arb': 'Dip Arb',
}

/** Subtitle descriptions for each strategy */
const SUBTITLES: Record<string, string> = {
  'llm-prediction': 'AI analysis',
  'btc-updown': '15-min crypto',
  'micro-momentum': 'Order flow',
  'project-fw': 'Spread arb (rare)',
  'dip-arb': 'Dip arb (rare)',
}

/** Display order — most likely to trade first */
const STRATEGY_ORDER = ['llm-prediction', 'btc-updown', 'micro-momentum', 'project-fw', 'dip-arb']

const STATUS_DOT: Record<string, string> = {
  running: 'bg-agent-green',
  idle: 'bg-agent-text-label',
  paused: 'bg-agent-orange',
  error: 'bg-agent-red',
}

export const StrategyDropdown: React.FC<StrategyDropdownProps> = ({ onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [strategies, setStrategies] = useState<StrategyState[]>(strategyManager.getStates())
  const [toggling, setToggling] = useState<string | null>(null)
  const dryRun = useSettingsStore((s) => s.dryRun)

  // Subscribe to real-time strategy state changes
  useEffect(() => {
    return strategyManager.subscribe(setStrategies)
  }, [])

  // Click-outside-to-close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Delay listener to avoid instant close from the same click that opened us
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handler)
    }
  }, [onClose])

  const handleToggle = async (id: string) => {
    setToggling(id)
    try {
      await strategyManager.toggleStrategy(id)
    } catch (err) {
      console.error(`Failed to toggle ${id}:`, err)
    } finally {
      setToggling(null)
    }
  }

  const handleStartAll = async () => {
    setToggling('all')
    try {
      for (const s of strategies) {
        if (!s.enabled) await strategyManager.enableStrategy(s.id)
      }
    } catch (err) {
      console.error('Failed to start all:', err)
    } finally {
      setToggling(null)
    }
  }

  const handleStopAll = async () => {
    setToggling('all')
    try {
      await strategyManager.stopAll()
    } catch (err) {
      console.error('Failed to stop all:', err)
    } finally {
      setToggling(null)
    }
  }

  const anyRunning = strategies.some((s) => s.enabled)
  const allRunning = strategies.every((s) => s.enabled)

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-2 w-64 bg-agent-card border border-agent-border rounded-md shadow-xl z-50 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-agent-border">
        <span className="text-[10px] uppercase tracking-wider text-agent-text-muted font-mono font-semibold">
          Strategies
        </span>
        <button
          onClick={allRunning ? handleStopAll : handleStartAll}
          disabled={toggling === 'all'}
          className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded transition-colors ${
            allRunning
              ? 'text-agent-red hover:bg-agent-red/10'
              : 'text-agent-green hover:bg-agent-green/10'
          } disabled:opacity-50`}
        >
          {toggling === 'all' ? '...' : allRunning ? 'Stop All' : anyRunning ? 'Start All' : 'Start All'}
        </button>
      </div>

      {/* Strategy rows */}
      <div className="py-1">
        {[...strategies].sort((a, b) => {
          const ai = STRATEGY_ORDER.indexOf(a.id)
          const bi = STRATEGY_ORDER.indexOf(b.id)
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
        }).map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between px-3 py-1.5 hover:bg-agent-elevated/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[s.status] || STATUS_DOT.idle}`} />
              <div className="flex flex-col">
                <span className="text-xs font-mono text-agent-text leading-tight">
                  {SHORT_NAMES[s.id] || s.name}
                </span>
                {SUBTITLES[s.id] && (
                  <span className="text-[9px] font-mono text-agent-text-muted leading-tight">
                    {SUBTITLES[s.id]}
                  </span>
                )}
              </div>
              {s.status === 'error' && (
                <span className="text-[8px] font-mono text-agent-red">ERR</span>
              )}
            </div>

            {/* Toggle switch */}
            <button
              onClick={() => handleToggle(s.id)}
              disabled={toggling !== null}
              className={`relative w-8 h-4 rounded-full transition-colors ${
                s.enabled ? 'bg-agent-green/30' : 'bg-agent-elevated'
              } disabled:opacity-50`}
              title={s.enabled ? `Disable ${s.name}` : `Enable ${s.name}`}
            >
              <span
                className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${
                  s.enabled ? 'left-[18px] bg-agent-green' : 'left-0.5 bg-agent-text-label'
                }`}
              />
            </button>
          </div>
        ))}
      </div>

      {/* Dry run notice */}
      {dryRun && (
        <div className="px-3 py-1.5 border-t border-agent-border">
          <span className="text-[9px] font-mono text-agent-cyan">
            DRY RUN mode — no real trades
          </span>
        </div>
      )}
    </div>
  )
}
