import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const strictCspDev = env.VITE_STRICT_CSP_DEV === 'true'

  return {
    // Strict CSP dev mode disables the React plugin to avoid react-refresh
    // preamble injection in index.html.
    plugins: strictCspDev ? [] : [react()],
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
        '/api/clob': {
          target: 'https://clob.polymarket.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/clob/, ''),
          secure: true,
        },
        '/api/gamma': {
          target: 'https://gamma-api.polymarket.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/gamma/, ''),
          secure: true,
        },
        '/api/polygon-rpc2': {
          target: 'https://1rpc.io/matic',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/polygon-rpc2/, ''),
          secure: true,
        },
        '/api/polygon-rpc': {
          target: 'https://polygon-bor-rpc.publicnode.com',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/polygon-rpc/, ''),
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
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-ethers': ['ethers'],
            'vendor-charts': ['recharts'],
          },
        },
      },
    },
  }
})
