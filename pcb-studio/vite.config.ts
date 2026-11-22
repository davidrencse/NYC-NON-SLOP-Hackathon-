import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import { forgeAi } from './server/index.ts'
import { verifyPlugin } from './server/verify.ts'
import { shopPlugin } from './server/shop.ts'
import { repairPlugin } from './server/repair.ts'
import { consumerRepairPlugin } from './server/consumer-repair.ts'

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

function voxelDemo(): Plugin {
  return { name: 'forge-voxel-demo', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url ?? '').split('?')[0]
      if (!path.startsWith('/voxel-demo/')) return next()
      const file = path.slice('/voxel-demo/'.length) || 'index.html'
      if (!/^(index\.html|app\.js|decision\.js|style\.css|instrument\.woff2|vendor\/three\.(core|module)\.js)$/.test(file)) { res.statusCode = 404; return res.end() }
      try {
        const data = await readFile(fileURLToPath(new URL(`../voxel-demo/${file}`, import.meta.url)))
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html')
        res.end(data)
      } catch { res.statusCode = 404; res.end() }
    })
  } }
}

export default defineConfig({
  plugins: [voxelDemo(), react(), tailwindcss(), forgeAi(), verifyPlugin(), shopPlugin(), repairPlugin(), consumerRepairPlugin(), advertiseUrl()],
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
          if (url.startsWith('/api/consumer-repair/manual')) return
          if (/^\/api\/(generate|verify|repair|shop|consumer-repair)(\/|$|\?)/.test(url)) return url
        },
      },
    },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
