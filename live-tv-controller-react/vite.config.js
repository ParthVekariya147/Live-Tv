import { defineConfig, loadEnv } from 'vite'
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

// Single shared .env at the repo root drives every service (see ../.env.example)
const ROOT_ENV_DIR = resolve(__dirname, '..')

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT_ENV_DIR, '')
  const devPort = Number(env.VITE_DEV_PORT) || 3004
  const apiProxyPort = Number(env.CONTROLLER_DEV_PORT) || 3005
  const apiProxyTarget = `http://localhost:${apiProxyPort}`
  const wsProxyTarget = `ws://localhost:${apiProxyPort}`

  return {
    plugins: [react()],
    base: './',
    envDir: ROOT_ENV_DIR,
    define: {
      __APP_NAME__: JSON.stringify('Live TV Controller'),
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_TIME__: JSON.stringify(buildTime),
      __GIT_COMMIT__: JSON.stringify(gitCommit),
    },
    server: {
      port: devPort,
      proxy: {
        // Proxy API + static video files + WebSocket to Express during development
        '/api': { target: apiProxyTarget, changeOrigin: true },
        '/videos': { target: apiProxyTarget, changeOrigin: true },
        '/ws': { target: wsProxyTarget, ws: true, changeOrigin: true },
      },
    },
  }
})
