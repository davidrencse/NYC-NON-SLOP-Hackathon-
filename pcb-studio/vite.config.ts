import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { forgeAi } from './server/index.ts'
import { verifyPlugin } from './server/verify.ts'
import { shopPlugin } from './server/shop.ts'
import { repairPlugin } from './server/repair.ts'

const RESEARCH = process.env.FORGE_RESEARCH_URL ?? 'http://127.0.0.1:8000'

// The research page opened on its own (:8000) hands a finished brief to this studio.
// Vite takes another port when 5173 is busy, so write the real address where the
// research server can read it (forge_research/studio.py, pcb_url).
function advertiseUrl(): Plugin {
  return {
    name: 'forge-advertise-url',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address()
        if (!address || typeof address === 'string') return
        void writeFile(fileURLToPath(new URL('./dev-url.local', import.meta.url)), `http://localhost:${address.port}/\n`).catch(() => {})
      })
    },
  }
}

// One app: `npm run dev` also starts the research server (FastAPI on :8000) unless one
// is already answering, and stops it when Vite exits.
function researchServer(): Plugin {
  let child: ChildProcess | null = null
  return {
    name: 'forge-research-server',
    apply: 'serve',
    async configureServer() {
      if (process.env.FORGE_RESEARCH_URL) return
      const up = await fetch(`${RESEARCH}/api/session`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false)
      if (up) return
      const env = { ...process.env }
      delete env.ANTHROPIC_BASE_URL
      child = spawn('uv', ['run', '--locked', '--python', '3.12', 'python', '-m', 'forge_research.studio'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
      })
      child.on('error', (e) => console.error(`[forge] research server failed to start: ${e.message}`))
      const stop = () => { child?.kill('SIGTERM'); child = null }
      process.once('exit', stop)
      process.once('SIGINT', () => { stop(); process.exit(130) })
      process.once('SIGTERM', () => { stop(); process.exit(143) })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), forgeAi(), verifyPlugin(), shopPlugin(), repairPlugin(), advertiseUrl(), researchServer()],
  // The research swarm (forge_research FastAPI) runs on :8000. Its page is shown in the
  // Research tab under /research; its own /api and /static paths are forwarded too.
  // /api/generate and /api/verify are served by the plugins above and never reach it.
  server: {
    headers: { 'Cache-Control': 'no-store' },
    // Poll so edits from another process show up even when inotify misses them.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/research': {
        target: RESEARCH,
        rewrite: (p) => p.replace(/^\/research/, '') || '/',
        timeout: 0,
        proxyTimeout: 0,
      },
      '/static': { target: RESEARCH, timeout: 0, proxyTimeout: 0 },
      // PCB routes stay on this dev server. Everything else under /api is the research studio.
      '/api': {
        target: RESEARCH,
        timeout: 0,
        proxyTimeout: 0,
        bypass(req) {
          const url = req.url ?? ''
          if (/^\/api\/(generate|verify|repair|shop|chassis|chat)(\/|$|\?)/.test(url)) return url
        },
      },
    },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
