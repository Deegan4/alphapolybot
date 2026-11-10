import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { WebSocketServer, WebSocket as WS } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'

// Outbound connections from the dev server honour HTTPS_PROXY (corporate
// proxies, cloud sandboxes). Without it they go direct, as before.
const upstreamAgent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined

// Plugin to proxy Binance WebSocket via a WS-to-WS bridge with auto-reconnect.
// Vite's built-in ws:true proxy doesn't reliably handle upgrades because
// Vite's HMR handler intercepts them first. This plugin creates a WebSocketServer
// that handles /ws/binance/* upgrades and bridges to Binance's stream endpoint.
// When the upstream drops (Binance periodically closes idle connections), the proxy
// transparently reconnects without tearing down the client-side WebSocket.
function binanceWsProxy(): Plugin {
  return {
    name: 'binance-ws-proxy',
    configureServer(server) {
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
                // terminate() on a socket that is still connecting emits 'error';
                // with no listener that crashes the whole dev server
                upstream.on('error', () => {})
                // Use terminate() instead of close() — close() throws on CONNECTING sockets
                upstream.terminate()
                upstream = null
              }
            }

            function connectUpstream() {
              if (clientClosed) return
              cleanupUpstream()

              upstream = new WS(targetUrl, { agent: upstreamAgent })

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

// Bridge for the Polymarket US WebSockets. The exchange authenticates them
// with request headers, which a browser WebSocket cannot send, so the browser
// connects here with the signed handshake in the query string (key id,
// timestamp, signature: never the secret) and this opens the real connection
// with those values as headers, relaying messages both ways.
function pmUsWsBridge(): Plugin {
  const ALLOWED_PATHS = new Set(['/v1/ws/markets', '/v1/ws/private'])
  return {
    name: 'pm-us-ws-bridge',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true })

      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith('/ws/pm-us/')) return
        const url = new URL(req.url, 'http://localhost')
        const path = url.pathname.replace(/^\/ws\/pm-us/, '')
        const keyId = url.searchParams.get('k')
        const timestamp = url.searchParams.get('t')
        const signature = url.searchParams.get('s')
        if (!ALLOWED_PATHS.has(path) || !keyId || !timestamp || !signature) {
          socket.destroy()
          return
        }

        wss.handleUpgrade(req, socket, head, (clientWs) => {
          const upstream = new WS(`wss://api.polymarket.us${path}`, {
            headers: { 'X-PM-Access-Key': keyId, 'X-PM-Timestamp': timestamp, 'X-PM-Signature': signature },
            agent: upstreamAgent,
          })
          const queued: Array<{ data: import('ws').RawData; isBinary: boolean }> = []
          const closeClient = (code: number, reason: string) => {
            if (clientWs.readyState === WS.OPEN) clientWs.close(code, reason.slice(0, 120))
          }

          upstream.on('open', () => {
            for (const m of queued.splice(0)) upstream.send(m.data, { binary: m.isBinary })
          })
          upstream.on('message', (data, isBinary) => {
            if (clientWs.readyState === WS.OPEN) clientWs.send(data, { binary: isBinary })
          })
          upstream.on('unexpected-response', (_req, res) => {
            console.error(`[PM US WS Bridge] ${path} refused: HTTP ${res.statusCode}`)
            closeClient(1011, `exchange refused the connection (HTTP ${res.statusCode})`)
          })
          upstream.on('error', (err) => {
            console.error(`[PM US WS Bridge] ${path} upstream error:`, err.message)
            closeClient(1011, `upstream error: ${err.message}`)
          })
          upstream.on('close', () => closeClient(1000, 'upstream closed'))

          clientWs.on('message', (data, isBinary) => {
            if (upstream.readyState === WS.OPEN) upstream.send(data, { binary: isBinary })
            else if (upstream.readyState === WS.CONNECTING) queued.push({ data, isBinary })
          })
          const dropUpstream = () => {
            upstream.removeAllListeners()
            upstream.on('error', () => {})
            upstream.terminate()
          }
          clientWs.on('close', dropUpstream)
          clientWs.on('error', dropUpstream)
        })
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
    plugins: strictCspDev ? [pmUsWsBridge()] : [react(), binanceWsProxy(), pmUsWsBridge()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 4000,
      host: '0.0.0.0',
      open: !process.env.HTTPS_PROXY && !process.env.CI,
      proxy: {
        '/api/pm-us': {
          target: 'https://api.polymarket.us',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/pm-us/, ''),
          secure: true,
          agent: upstreamAgent,
        },
        '/api/pm-gateway': {
          target: 'https://gateway.polymarket.us',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/pm-gateway/, ''),
          secure: true,
          agent: upstreamAgent,
        },
        '/api/coinbase': {
          target: 'https://api.coinbase.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/coinbase/, ''),
          secure: true,
          agent: upstreamAgent,
        },
        '/api/polybacktest': {
          target: 'https://api.polybacktest.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/polybacktest/, ''),
          secure: true,
          agent: upstreamAgent,
        },
        '/api/binance': {
          target: 'https://api.binance.us',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/binance/, ''),
          secure: true,
          agent: upstreamAgent,
        },
        '/api/coingecko': {
          target: 'https://api.coingecko.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/coingecko/, ''),
          secure: true,
          agent: upstreamAgent,
        },
        // Polymarket US SDK constructs URLs via new URL('/v1/...', origin),
        // stripping any path prefix, so both hosts arrive here as /v1/*.
        // Public market data lives on the gateway; the api host answers those
        // paths with 401 "Missing required API key headers" when unsigned.
        '^/v1/(events|markets|market|search|series|sports)(/|\\?|$)': {
          target: 'https://gateway.polymarket.us',
          changeOrigin: true,
          secure: true,
          agent: upstreamAgent,
        },
        // Everything else (account, orders, portfolio) is authenticated.
        '/v1/': {
          target: 'https://api.polymarket.us',
          changeOrigin: true,
          secure: true,
          agent: upstreamAgent,
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
