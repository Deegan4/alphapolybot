import React, { useEffect, useRef } from 'react'

/**
 * MatrixRain - Animated background effect
 * Digital rain animation inspired by The Matrix
 *
 * Uses requestAnimationFrame (not setInterval) and pauses when the tab is
 * hidden to avoid wasting CPU/GPU and leaking memory from offscreen draws.
 */
export const MatrixRain: React.FC<{ opacity?: number }> = ({ opacity = 0.05 }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas size
    const resizeCanvas = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resizeCanvas()
    window.addEventListener('resize', resizeCanvas)

    // Matrix characters (katakana + numbers)
    const chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789'
    const charArray = chars.split('')

    // Column setup
    const fontSize = 14
    let columns = Math.floor(canvas.width / fontSize)
    let drops: number[] = []

    // Initialize drops
    const initDrops = () => {
      columns = Math.floor(canvas.width / fontSize)
      drops = new Array(columns)
      for (let i = 0; i < columns; i++) {
        drops[i] = Math.random() * -100
      }
    }
    initDrops()

    // Reinitialize drops on resize so columns stay in sync with canvas width
    const handleResize = () => {
      resizeCanvas()
      initDrops()
    }
    window.removeEventListener('resize', resizeCanvas)
    window.addEventListener('resize', handleResize)

    // Animation via rAF, throttled to ~20 FPS
    let rafId = 0
    let lastFrame = 0
    let paused = document.hidden
    const FRAME_INTERVAL = 50 // ms between frames (~20 FPS)

    const draw = (now: number) => {
      rafId = requestAnimationFrame(draw)

      if (paused) return
      if (now - lastFrame < FRAME_INTERVAL) return
      lastFrame = now

      // Semi-transparent black to create fade effect
      ctx.fillStyle = 'rgba(0, 10, 0, 0.05)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Green text
      ctx.fillStyle = `rgba(0, 255, 0, ${opacity * 5})`
      ctx.font = `${fontSize}px monospace`

      for (let i = 0; i < drops.length; i++) {
        const char = charArray[Math.floor(Math.random() * charArray.length)]
        ctx.fillText(char, i * fontSize, drops[i] * fontSize)

        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
          drops[i] = 0
        }
        drops[i]++
      }
    }

    rafId = requestAnimationFrame(draw)

    // Pause/resume on tab visibility change
    const onVisibility = () => {
      paused = document.hidden
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', handleResize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [opacity])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-0"
      style={{ opacity }}
    />
  )
}

export default MatrixRain
