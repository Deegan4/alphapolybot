import React from 'react'
import { Outlet } from 'react-router-dom'

/**
 * DashboardLayout — full-width, no sidebar, muted navy theme.
 * Used for the main dashboard route. Settings uses AppLayout instead.
 */
export const DashboardLayout: React.FC = () => {
  return (
    <div className="bg-agent-bg min-h-screen text-agent-text font-mono">
      <main>
        <Outlet />
      </main>
    </div>
  )
}

export default DashboardLayout
