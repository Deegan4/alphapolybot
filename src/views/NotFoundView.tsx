import React from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * NotFoundView — Matrix-themed 404 page for invalid routes.
 * Provides a clear "Return Home" action instead of a blank screen.
 */
const NotFoundView: React.FC = () => {
  const navigate = useNavigate()

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-matrix-card/80 border border-matrix-primary/20 rounded-lg p-8 text-center shadow-2xl shadow-[0_0_30px_rgba(0,255,0,0.05)]">
        {/* Glitch-style code */}
        <div className="mb-6">
          <span className="text-6xl font-bold font-mono text-matrix-primary/80 tracking-widest">
            404
          </span>
          <div className="mt-2 h-0.5 bg-gradient-to-r from-transparent via-matrix-primary to-transparent" />
        </div>

        <p className="text-matrix-primary font-mono text-sm mb-2">
          ROUTE NOT FOUND
        </p>
        <p className="text-matrix-text-secondary font-mono text-xs mb-6">
          The path you followed doesn&apos;t exist in this matrix.
        </p>

        <button
          onClick={() => navigate('/')}
          className="px-6 py-2 bg-matrix-primary/10 border border-matrix-primary/30 text-matrix-primary rounded hover:bg-matrix-primary/20 transition-colors font-mono text-sm"
        >
          Return to Terminal
        </button>
      </div>
    </div>
  )
}

export default NotFoundView
