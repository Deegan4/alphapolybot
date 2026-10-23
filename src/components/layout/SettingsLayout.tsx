import React from 'react'
import { Outlet, Link } from 'react-router-dom'

/**
 * SettingsLayout — agent-themed wrapper for /settings.
 * No sidebar, no header, no MatrixRain. Just a back arrow + title bar.
 */
export const SettingsLayout: React.FC = () => {
  return (
    <div className="bg-agent-bg app-viewport text-agent-text font-mono flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-agent-border">
        <Link
          to="/"
          className="text-agent-text-muted hover:text-agent-text transition-colors p-2 -ml-2 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
          title="Back to Dashboard"
          aria-label="Back to Dashboard"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h1 className="text-sm font-mono font-bold text-agent-text tracking-wider uppercase">
          Settings
        </h1>
      </div>

      {/* Content */}
      <main className="flex-1 overflow-auto p-4">
        <Outlet />
      </main>
    </div>
  )
}

export default SettingsLayout
