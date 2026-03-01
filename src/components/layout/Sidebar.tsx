import React from 'react'
import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
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
 * SidebarContent — the inner content, reused in both desktop and mobile drawer
 */
const SidebarContent: React.FC<{ onNavigate?: () => void }> = ({ onNavigate }) => {
  const { isConnected, address, balance, buyingPower } = useWalletStore()

  const formatAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`
  }

  return (
    <>
      {/* Logo */}
      <div className="p-4 border-b border-matrix-border/30">
        <h1 className="font-mono text-xl font-bold flex items-center gap-2">
          <span className="text-2xl bg-gradient-to-r from-matrix-primary to-matrix-cyan bg-clip-text text-transparent">◆</span>
          <span>
            <span className="bg-gradient-to-r from-matrix-primary to-matrix-cyan bg-clip-text text-transparent">ALPHA</span>
            <span className="text-matrix-secondary">POLY</span>
            <span className="text-matrix-primary">BOT</span>
          </span>
        </h1>
        <p className="text-matrix-text-muted font-sans text-xs mt-1">
          Polymarket LLM Trading Bot
        </p>
      </div>

      {/* Wallet Status */}
      <div className="p-4 border-b border-matrix-border/30">
        <div className="text-xs text-matrix-text-muted font-sans uppercase tracking-wider mb-2">
          Wallet Status
        </div>
        {isConnected ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <motion.span
                className="w-2 h-2 bg-matrix-primary rounded-full"
                animate={{
                  boxShadow: ['0 0 4px #00ff00', '0 0 10px #00ff00', '0 0 4px #00ff00'],
                }}
                transition={{ duration: 2, repeat: Infinity }}
              />
              <span className="text-matrix-primary text-sm font-mono">Connected</span>
            </div>
            <div className="text-matrix-text-secondary text-xs font-mono">
              {address ? formatAddress(address) : 'Not connected'}
            </div>
            <div className="gradient-border bg-matrix-bg rounded px-2 py-1.5">
              <span className="text-matrix-text-muted text-xs font-sans">Balance: </span>
              <span className="text-matrix-primary font-mono tabular-nums">
                ${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div className="text-matrix-text-muted text-[10px] font-mono">
              Buying Power: ${buyingPower.toFixed(2)}
            </div>
            {balance === 0 && (
              <div className="text-yellow-400/80 text-[10px] font-sans leading-tight">
                No funds found. Fund your account at polymarket.com.
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-red-500 rounded-full" />
            <span className="text-red-400 text-sm font-mono">Not Connected</span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2" aria-label="Main navigation">
        <ul className="space-y-1">
          {navItems.map((item) => (
            <li key={item.path}>
              <NavLink
                to={item.path}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'relative flex items-center gap-3 px-3 py-2.5 rounded-md font-mono text-sm transition-colors',
                    isActive
                      ? 'text-matrix-primary'
                      : 'text-matrix-text-secondary hover:text-matrix-primary'
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.div
                        layoutId="sidebar-active"
                        className="absolute inset-0 rounded-md bg-matrix-primary/10 border border-matrix-primary/20"
                        transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                      />
                    )}
                    <span className="relative z-10">{item.icon}</span>
                    <span className="relative z-10">{item.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Version */}
      <div className="p-4 border-t border-matrix-border/30">
        <div className="h-px bg-gradient-to-r from-transparent via-matrix-primary/30 to-transparent mb-3" />
        <div className="text-matrix-text-muted text-xs font-sans">
          v1.0.0
        </div>
      </div>
    </>
  )
}

/**
 * Sidebar - Desktop: fixed left column. Mobile: hidden (uses MobileDrawer from AppLayout).
 */
export const Sidebar: React.FC = () => {
  return (
    <aside className="hidden md:flex w-64 glass-card border-r border-matrix-border/30 flex-col h-full">
      <SidebarContent />
    </aside>
  )
}

/**
 * MobileDrawer - Slide-over nav for small screens
 */
export const MobileDrawer: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  return (
    <>
      {/* Backdrop */}
      {open && (
        <motion.div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        />
      )}

      {/* Drawer panel */}
      <motion.aside
        className="fixed top-0 left-0 bottom-0 w-64 glass-card border-r border-matrix-border/30 flex flex-col z-50 md:hidden"
        initial={{ x: '-100%' }}
        animate={{ x: open ? 0 : '-100%' }}
        transition={{ type: 'spring', stiffness: 350, damping: 30 }}
      >
        <SidebarContent onNavigate={onClose} />
      </motion.aside>
    </>
  )
}

export default Sidebar
