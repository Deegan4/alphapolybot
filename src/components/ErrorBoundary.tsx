import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

interface ErrorBoundaryProps {
  children: ReactNode
}

/**
 * ErrorBoundary — Catches unhandled React rendering errors.
 *
 * Wraps the route tree in App.tsx. When a component throws during render,
 * this catches it and shows a Matrix-themed fallback instead of a white screen.
 * Also logs to ActivityLogger for the audit trail.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo)

    // Log to ActivityLogger (dynamic import avoids circular dep risk)
    import('@/services/trading/ActivityLogger').then(({ activityLogger }) => {
      activityLogger.logError(`UI crash: ${error.message}`, {
        stack: error.stack?.substring(0, 500),
        componentStack: errorInfo.componentStack?.substring(0, 500),
      })
    }).catch(() => {})
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-black flex items-center justify-center p-4">
          <div className="max-w-lg w-full bg-gray-900/80 border border-red-500/30 rounded-lg p-8 text-center shadow-2xl shadow-red-500/10">
            {/* Glitch effect title */}
            <div className="mb-6">
              <h1 className="text-3xl font-bold text-red-400 font-mono tracking-wider">
                SYSTEM FAILURE
              </h1>
              <div className="mt-2 h-0.5 bg-gradient-to-r from-transparent via-red-500 to-transparent" />
            </div>

            {/* Error message */}
            <p className="text-green-400 font-mono text-sm mb-4">
              Something went wrong in the Matrix.
            </p>

            {this.state.error && (
              <pre className="text-red-300/70 text-xs font-mono bg-black/50 rounded p-3 mb-6 max-h-32 overflow-auto text-left border border-red-500/10">
                {this.state.error.message}
              </pre>
            )}

            {/* Actions */}
            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 bg-green-500/10 border border-green-500/30 text-green-400 rounded hover:bg-green-500/20 transition-colors font-mono text-sm"
              >
                Try Again
              </button>
              <button
                onClick={this.handleReload}
                className="px-4 py-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded hover:bg-red-500/20 transition-colors font-mono text-sm"
              >
                Reload Page
              </button>
            </div>

            <p className="text-gray-600 text-xs font-mono mt-6">
              If this persists, check Activity Log for details
            </p>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
