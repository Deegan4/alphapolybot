import React from 'react'
import { Outlet } from 'react-router-dom'

/**
 * DashboardLayout — full-width, no sidebar, muted navy theme.
 * Used for the main dashboard route. Settings uses AppLayout instead.
 */
export const DashboardLayout: React.FC = () => {
  return (
    <div className="bg-agent-bg app-viewport text-agent-text font-mono overflow-hidden">
      <Outlet />
    </div>
  )
}

export default DashboardLayout
