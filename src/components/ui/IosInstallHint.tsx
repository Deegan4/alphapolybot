import React, { useEffect, useState } from 'react'

const DISMISS_KEY = 'apb:ios-install-dismissed'

function isIosSafari(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome/.test(ua)
  return isIOS && isSafari
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches
}

/**
 * One-time tip for iPhone Safari users: how to Add to Home Screen.
 * Hidden once dismissed, once already installed, or on non-iOS browsers.
 */
export const IosInstallHint: React.FC = () => {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return
    } catch { /* ignore */ }
    if (isStandalone()) return
    if (!isIosSafari()) return
    setVisible(true)
  }, [])

  if (!visible) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* ignore */ }
    setVisible(false)
  }

  return (
    <div
      className="fixed inset-x-3 z-[60] rounded-xl border border-agent-green/25 bg-agent-card/95 backdrop-blur-md shadow-lg px-3 py-3 sm:max-w-md sm:mx-auto"
      style={{ bottom: 'max(1rem, calc(env(safe-area-inset-bottom, 0px) + 0.75rem))' }}
      role="status"
    >
      <div className="flex items-start gap-3">
        <div className="text-agent-green text-lg leading-none mt-0.5" aria-hidden>📱</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-sans font-semibold text-agent-text">
            Install AlphaPolyBot on your iPhone
          </p>
          <p className="mt-1 text-xs font-sans text-agent-text-muted leading-relaxed">
            Tap <span className="text-agent-cyan font-medium">Share</span>
            {' '}→ <span className="text-agent-cyan font-medium">Add to Home Screen</span>
            {' '}for a full-screen trading app.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="text-agent-text-muted hover:text-agent-text min-h-[44px] min-w-[44px] -mr-1 -mt-1 inline-flex items-center justify-center"
          aria-label="Dismiss"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default IosInstallHint
