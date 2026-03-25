import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { WebSocketServer, WebSocket as WS } from 'ws'

// Plugin to proxy Binance WebSocket via a WS-to-WS bridge with auto-reconnect.
// Vite's built-in ws:true proxy doesn't reliably handle upgrades because
// Vite's HMR handler intercepts them first. This plugin creates a WebSocketServer
// that handles /ws/binance/* upgrades and bridges to Binance's stream endpoint.
// When the upstream drops (Binance periodically closes idle connections), the proxy
// transparently reconnects without tearing down the client-side WebSocket.
function binanceWsProxy() {
  return {
    name: 'binance-ws-proxy',
    configureServer(server: { httpServer: import('http').Server | null }) {
      const wss = new WebSocketServer({ noServer: true })

      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (req.url?.startsWith('/ws/binance')) {
          wss.handleUpgrade(req, socket, head, (clientWs) => {
            const targetPath = req.url!.replace(/^\/ws\/binance/, '')
            const targetUrl = `wss://stream.binance.com:9443${targetPath}`

            let upstream: WS | null = null
            let pingInterval: ReturnType<typeof setInterval> | null = null
            let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
            let reconnectAttempts = 0
            const MAX_RECONNECT_ATTEMPTS = 8
            let clientClosed = false

            function cleanupUpstream() {
              if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
              if (upstream) {
                upstream.removeAllListeners()
                // Attach a no-op error handler so terminate() doesn't crash the process
                upstream.on('error', () => {})
                try { upstream.terminate() } catch { /* already closing */ }
                upstream = null
              }
            }

            function connectUpstream() {
              if (clientClosed) return
              cleanupUpstream()

              upstream = new WS(targetUrl)

              upstream.on('open', () => {
                console.log('[Binance WS Proxy] Connected to upstream:', targetUrl.slice(0, 80))
                reconnectAttempts = 0
                pingInterval = setInterval(() => {
                  if (upstream?.readyState === WS.OPEN) upstream.ping()
                }, 15_000)
              })

              upstream.on('message', (data, isBinary) => {
                if (clientWs.readyState === WS.OPEN) {
                  clientWs.send(data, { binary: isBinary })
                }
              })

              upstream.on('close', (code, reason) => {
                if (clientClosed) return
                console.log(`[Binance WS Proxy] Upstream closed: code=${code} reason=${reason || ''}. Auto-reconnecting...`)
                if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
                scheduleReconnect()
              })

              upstream.on('error', (err) => {
                if (clientClosed) return
                console.error('[Binance WS Proxy] Upstream error:', err.message)
                // close event will fire after error, triggering reconnect
              })
            }

            function scheduleReconnect() {
              if (clientClosed || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                  console.error('[Binance WS Proxy] Max reconnect attempts reached, closing client')
                  if (clientWs.readyState === WS.OPEN) clientWs.close()
                }
                return
              }
              const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30_000)
              reconnectAttempts++
              console.log(`[Binance WS Proxy] Reconnecting upstream in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
              reconnectTimeout = setTimeout(connectUpstream, delay)
            }

            // Forward client → upstream messages
            clientWs.on('message', (data, isBinary) => {
              if (upstream?.readyState === WS.OPEN) {
                upstream.send(data, { binary: isBinary })
              }
            })

            // Client disconnected — tear everything down
            clientWs.on('close', () => {
              clientClosed = true
              if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null }
              cleanupUpstream()
            })

            clientWs.on('error', () => {
              clientClosed = true
              if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null }
              cleanupUpstream()
            })

            // Initial connection
            connectUpstream()
          })
        }
      })
    },
  }
}

// Plugin to proxy Hyperliquid WebSocket (same pattern as binanceWsProxy).
function hyperliquidWsProxy() {
  return {
    name: 'hyperliquid-ws-proxy',
    configureServer(server: { httpServer: import('http').Server | null }) {
      const wss = new WebSocketServer({ noServer: true })

      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (req.url?.startsWith('/ws/hyperliquid')) {
          wss.handleUpgrade(req, socket, head, (clientWs) => {
            const targetUrl = 'wss://api.hyperliquid.xyz/ws'

            let upstream: WS | null = null
            let pingInterval: ReturnType<typeof setInterval> | null = null
            let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
            let reconnectAttempts = 0
            const MAX_RECONNECT_ATTEMPTS = 8
            let clientClosed = false
            const pendingMessages: { data: unknown; isBinary: boolean }[] = []

            function cleanupUpstream() {
              if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
              if (upstream) {
                upstream.removeAllListeners()
                upstream.on('error', () => {})
                try { upstream.terminate() } catch { /* already closing */ }
                upstream = null
              }
            }

            function connectUpstream() {
              if (clientClosed) return
              cleanupUpstream()

              upstream = new WS(targetUrl)

              upstream.on('open', () => {
                console.log('[Hyperliquid WS Proxy] Connected to upstream')
                reconnectAttempts = 0
                // Flush any messages that arrived before upstream was ready
                for (const msg of pendingMessages) {
                  upstream!.send(msg.data as Parameters<WS['send']>[0], { binary: msg.isBinary })
                }
                pendingMessages.length = 0
                pingInterval = setInterval(() => {
                  if (upstream?.readyState === WS.OPEN) upstream.ping()
                }, 15_000)
              })

              upstream.on('message', (data, isBinary) => {
                if (clientWs.readyState === WS.OPEN) {
                  clientWs.send(data, { binary: isBinary })
                }
              })

              upstream.on('close', (code, reason) => {
                if (clientClosed) return
                console.log(`[Hyperliquid WS Proxy] Upstream closed: code=${code} reason=${reason || ''}. Auto-reconnecting...`)
                if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
                scheduleReconnect()
              })

              upstream.on('error', (err) => {
                if (clientClosed) return
                console.error('[Hyperliquid WS Proxy] Upstream error:', err.message)
              })
            }

            function scheduleReconnect() {
              if (clientClosed || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                  console.error('[Hyperliquid WS Proxy] Max reconnect attempts reached, closing client')
                  if (clientWs.readyState === WS.OPEN) clientWs.close()
                }
                return
              }
              const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30_000)
              reconnectAttempts++
              console.log(`[Hyperliquid WS Proxy] Reconnecting upstream in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
              reconnectTimeout = setTimeout(connectUpstream, delay)
            }

            clientWs.on('message', (data, isBinary) => {
              if (upstream?.readyState === WS.OPEN) {
                upstream.send(data, { binary: isBinary })
              } else {
                // Buffer messages until upstream is ready (subscription race fix)
                pendingMessages.push({ data, isBinary })
              }
            })

            clientWs.on('close', () => {
              clientClosed = true
              pendingMessages.length = 0
              if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null }
              cleanupUpstream()
            })

            clientWs.on('error', () => {
              clientClosed = true
              pendingMessages.length = 0
              if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null }
              cleanupUpstream()
            })

            connectUpstream()
          })
        }
      })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const strictCspDev = env.VITE_STRICT_CSP_DEV === 'true'

  return {
    // Strict CSP dev mode disables the React plugin to avoid react-refresh
    // preamble injection in index.html.
    plugins: strictCspDev ? [] : [react(), binanceWsProxy(), hyperliquidWsProxy()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 4000,
      host: 'localhost',
      open: true,
      proxy: {
        '/api/clob': {
          target: 'https://clob.polymarket.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/clob/, ''),
          secure: true,
        },
        '/api/coinbase': {
          target: 'https://api.coinbase.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/coinbase/, ''),
          secure: true,
        },
        '/api/polybacktest': {
          target: 'https://api.polybacktest.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/polybacktest/, ''),
          secure: true,
        },
        '/api/gamma': {
          target: 'https://gamma-api.polymarket.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/gamma/, ''),
          secure: true,
        },
        '/api/binance': {
          target: 'https://api.binance.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/binance/, ''),
          secure: true,
        },
        '/api/coingecko': {
          target: 'https://api.coingecko.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/coingecko/, ''),
          secure: true,
        },
        '/api/ollama': {
          target: 'http://localhost:11434',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/ollama/, ''),
          secure: false,
        },
        '/api/moondev': {
          target: 'https://api.moondev.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/moondev/, ''),
          secure: true,
        },
        '/api/cryptocom': {
          target: 'https://api.crypto.com/exchange/v1/public',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/cryptocom/, ''),
          secure: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      // Disable Vite's JS-based modulepreload polyfill — it blocks script execution
      // while fetching all transitive deps upfront. Modern browsers handle native
      // modulepreload natively, and for older ones the waterfall is actually faster
      // than blocking the main thread with the polyfill.
      modulePreload: { polyfill: false },
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Ethers.js (~450 kB) with its own crypto, ABI coder, ENS resolver.
            if (id.includes('node_modules/ethers') || id.includes('node_modules/@adraffy/ens-normalize') || id.includes('node_modules/aes-js')) {
              return 'vendor-ethers'
            }
            // D3 ecosystem — used by Recharts but large enough to cache separately
            if (id.includes('node_modules/d3-')) {
              return 'vendor-d3'
            }
            // Recharts core + supporting libs
            if (id.includes('node_modules/recharts') || id.includes('node_modules/es-toolkit') || id.includes('node_modules/@reduxjs/toolkit')) {
              return 'vendor-charts'
            }
            // Framer Motion — only needed for Settings page transitions
            if (id.includes('node_modules/framer-motion') || id.includes('node_modules/motion-dom') || id.includes('node_modules/motion-utils')) {
              return 'vendor-motion'
            }
            // React DOM + scheduler — stable, rarely changes, great cache hit rate
            if (id.includes('node_modules/react-dom') || id.includes('node_modules/scheduler')) {
              return 'vendor-react'
            }
            // Supabase — only needed for cloud storage features
            if (id.includes('node_modules/@supabase')) {
              return 'vendor-supabase'
            }
          },
        },
      },
    },
  }
})
