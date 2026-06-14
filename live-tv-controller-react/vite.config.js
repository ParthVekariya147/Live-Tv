import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

const buildTime = new Date().toISOString().slice(0, 16).replace('T', ' ')

let gitCommit = 'unknown'
try {
  gitCommit = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim()
} catch { }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_NAME__: JSON.stringify('Live TV Controller'),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
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
