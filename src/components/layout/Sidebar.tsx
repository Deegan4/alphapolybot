import React from 'react'
import { NavLink } from 'react-router-dom'
import { cn } from '@/utils/cn'
import { useWalletStore } from '@/stores'

interface NavItem {
  label: string
  path: string
  icon: React.ReactNode
}

const navItems: NavItem[] = [
  {
    label: 'Terminal',
    path: '/',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    label: 'Portfolio',
    path: '/portfolio',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    label: 'Activity',
    path: '/activity',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  {
    label: 'Settings',
    path: '/settings',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
]

/**
 * Sidebar - Main navigation sidebar
 */
export const Sidebar: React.FC = () => {
  const { isConnected, address, usdcBalance } = useWalletStore()

  const formatAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`
  }

  return (
    <aside className="w-64 bg-matrix-card border-r border-matrix-border flex flex-col h-full">
      {/* Logo */}
      <div className="p-4 border-b border-matrix-border">
        <h1 className="text-matrix-primary font-mono text-xl font-bold flex items-center gap-2">
          <span className="text-2xl">◆</span>
          <span>ALPHA<span className="text-matrix-secondary">POLY</span>BOT</span>
        </h1>
        <p className="text-matrix-text-secondary text-xs mt-1">
          Polymarket LLM Trading Bot
        </p>
      </div>

      {/* Wallet Status */}
      <div className="p-4 border-b border-matrix-border">
        <div className="text-xs text-matrix-text-secondary uppercase tracking-wider mb-2">
          Wallet Status
        </div>
        {isConnected ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 bg-matrix-primary rounded-full animate-pulse" />
              <span className="text-matrix-primary text-sm font-mono">Connected</span>
            </div>
            <div className="text-matrix-text-secondary text-xs font-mono">
              {address ? formatAddress(address) : 'Unknown'}
            </div>
            <div className="bg-matrix-bg rounded px-2 py-1.5">
              <span className="text-matrix-text-secondary text-xs">Balance: </span>
              <span className="text-matrix-primary font-mono">
                ${usdcBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-red-500 rounded-full" />
            <span className="text-red-400 text-sm font-mono">Not Connected</span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2">
        <ul className="space-y-1">
          {navItems.map((item) => (
            <li key={item.path}>
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-md font-mono text-sm transition-all',
                    isActive
                      ? 'bg-matrix-primary/10 text-matrix-primary border border-matrix-primary/30'
                      : 'text-matrix-text-secondary hover:text-matrix-primary hover:bg-matrix-primary/5'
                  )
                }
              >
                {item.icon}
                <span>{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Version */}
      <div className="p-4 border-t border-matrix-border">
        <div className="text-matrix-text-secondary text-xs font-mono">
          v1.0.0 • Matrix Theme
        </div>
      </div>
    </aside>
  )
}

export default Sidebar
