import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 4000,
    host: true,
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
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
