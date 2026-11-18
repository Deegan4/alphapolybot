import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

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

  // Reserve the tip's height at the bottom of the app (see .app-viewport) so it
  // sits below the content instead of covering it.
  const boxRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const root = document.documentElement
    const box = boxRef.current
    if (!visible || !box) return
    const apply = () => root.style.setProperty('--install-hint-h', `${Math.ceil(box.getBoundingClientRect().height)}px`)
    apply()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    observer?.observe(box)
    return () => {
      observer?.disconnect()
      root.style.removeProperty('--install-hint-h')
    }
  }, [visible])

  if (!visible) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* ignore */ }
    setVisible(false)
  }

  return (
    <div
      ref={boxRef}
      data-testid="ios-install-hint"
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-agent-green/25 bg-agent-card px-3 pt-1"
      style={{ paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom, 0px))' }}
      role="status"
    >
      <div className="flex items-center gap-2 sm:max-w-md sm:mx-auto">
        <div className="text-base leading-none" aria-hidden>📱</div>
        <p className="flex-1 min-w-0 text-xs font-sans text-agent-text-muted leading-snug">
          <span className="font-semibold text-agent-text">Install the app:</span>
          {' '}tap <span className="text-agent-cyan font-medium">Share</span>
          {' '}→ <span className="text-agent-cyan font-medium">Add to Home Screen</span>
        </p>
        <button
          type="button"
          onClick={dismiss}
          className="text-agent-text-muted hover:text-agent-text min-h-[44px] min-w-[44px] -mr-1 inline-flex items-center justify-center"
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
