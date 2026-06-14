import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 3003,
    proxy: {
      // Proxy API + static video files + WebSocket to Express during development
      '/api': { target: 'http://localhost:3004', changeOrigin: true },
      '/videos': { target: 'http://localhost:3004', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3004', ws: true, changeOrigin: true },
    },
  },
})
