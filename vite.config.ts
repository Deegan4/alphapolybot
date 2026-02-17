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
            const targetUrl = `wss://stream.binance.us:9443${targetPath}`

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
                // Use terminate() instead of close() — close() throws on CONNECTING sockets
                upstream.terminate()
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

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const strictCspDev = env.VITE_STRICT_CSP_DEV === 'true'

  return {
    // Strict CSP dev mode disables the React plugin to avoid react-refresh
    // preamble injection in index.html.
    plugins: strictCspDev ? [] : [react(), binanceWsProxy()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 4000,
      host: '0.0.0.0',
      open: true,
      proxy: {
        '/api/pm-us': {
          target: 'https://api.polymarket.us',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/pm-us/, ''),
          secure: true,
        },
        '/api/pm-gateway': {
          target: 'https://gateway.polymarket.us',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/pm-gateway/, ''),
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
          target: 'https://api.binance.us',
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
        // Polymarket US SDK constructs URLs via new URL('/v1/...', origin),
        // stripping any path prefix. Proxy /v1/ directly to api.polymarket.us in dev.
        '/v1/': {
          target: 'https://api.polymarket.us',
          changeOrigin: true,
          secure: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-charts': ['recharts'],
          },
        },
      },
    },
  }
})
