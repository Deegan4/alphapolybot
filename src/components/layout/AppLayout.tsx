import React from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { MatrixRain } from './MatrixRain'

/**
 * AppLayout - Main application layout with sidebar, header, and content area
 */
export const AppLayout: React.FC = () => {
  return (
    <div className="min-h-screen bg-matrix-bg text-matrix-text-primary">
      {/* Matrix rain background */}
      <MatrixRain opacity={0.03} />

      {/* Main layout */}
      <div className="relative z-10 flex h-screen">
        {/* Sidebar */}
        <Sidebar />

        {/* Main content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <Header />

          {/* Content */}
          <main className="flex-1 overflow-auto p-4">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}

export default AppLayout
