import React from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { MatrixRain } from './MatrixRain'
import { PageTransition } from '@/components/ui'

/**
 * AppLayout - Main application layout with animated route transitions
 */
export const AppLayout: React.FC = () => {
  const location = useLocation()

  return (
    <div className="min-h-screen bg-matrix-bg text-matrix-text-primary">
      {/* Matrix rain background */}
      <MatrixRain opacity={0.02} />

      {/* Main layout */}
      <div className="relative z-10 flex h-screen">
        {/* Sidebar */}
        <Sidebar />

        {/* Main content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <Header />

          {/* Content with route transitions */}
          <main className="flex-1 overflow-auto p-4">
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
