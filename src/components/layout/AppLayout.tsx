import React, { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { Sidebar, MobileDrawer } from './Sidebar'
import { Header } from './Header'
import { MatrixRain } from './MatrixRain'
import { PageTransition } from '@/components/ui'

/**
 * AppLayout - Main application layout with animated route transitions
 * Desktop: sidebar + header + content
 * Mobile: hamburger → drawer overlay, header + content
 */
export const AppLayout: React.FC = () => {
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div className="min-h-screen bg-matrix-bg text-matrix-text-primary">
      {/* Matrix rain background */}
      <MatrixRain opacity={0.02} />

      {/* Mobile drawer */}
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {/* Main layout */}
      <div className="relative z-10 flex h-screen">
        {/* Sidebar — hidden on mobile, visible md+ */}
        <Sidebar />

        {/* Main content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header with mobile hamburger */}
          <div className="flex items-center">
            {/* Hamburger — only on mobile */}
            <button
              className="md:hidden p-3 text-matrix-primary hover:text-matrix-cyan transition-colors"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation menu"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="flex-1">
              <Header />
            </div>
          </div>

          {/* Content with route transitions */}
          <main className="flex-1 overflow-auto p-3 sm:p-4">
            <AnimatePresence mode="wait">
              <PageTransition key={location.pathname} className="h-full">
                <Outlet />
              </PageTransition>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </div>
  )
}

export default AppLayout
