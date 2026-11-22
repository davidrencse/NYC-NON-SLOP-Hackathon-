import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { loadEnv, runnerImport, type Plugin } from 'vite'
import { callClaude, CLAUDE_TIERS, resolveClaudeKey } from './claude.ts'
import { verifyCertificate } from './verify.ts'
import type { Certificate } from '../src/verify/types.ts'
import type { Board as BoardData } from '../src/data/board.ts'
import { readJson, sendJson } from './http.ts'

interface FootprintMod {
  bodyFor(p: unknown): { w: number; h: number; height: number }
  routeNets(b: unknown): { net: string; width: number; layer: 'top' | 'bottom'; points: [number, number][] }[]
}

const REPAIR_SCHEMA = {
  type: 'OBJECT',
  properties: {
    width: { type: 'NUMBER', description: 'optional expanded board width in mm if needed for outline/overlap' },
    height: { type: 'NUMBER', description: 'optional expanded board height in mm if needed for outline/overlap' },
    partMoves: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ref: { type: 'STRING' },
          x: { type: 'NUMBER' },
          y: { type: 'NUMBER' },
        },
        required: ['ref', 'x', 'y'],
      },
    },
    netEdits: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER', description: '0-based index into board.nets' },
          layer: { type: 'STRING', enum: ['top', 'bottom'] },
          width: { type: 'NUMBER' },
        },
        required: ['index'],
      },
    },
    rationale: { type: 'STRING', description: 'concise engineering explanation of how the failed Lean constraints were fixed' },
  },
  required: ['rationale'],
}

function segDistSq(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): number {
  const orient = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const onSeg = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.min(p[0], r[0]) <= q[0] + 1e-6 &&
    q[0] <= Math.max(p[0], r[0]) + 1e-6 &&
    Math.min(p[1], r[1]) <= q[1] + 1e-6 &&
    q[1] <= Math.max(p[1], r[1]) + 1e-6

  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  if (
    ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
  ) {
    return 0
  }
  if (Math.abs(o1) < 1e-6 && onSeg(a, c, b)) return 0
  if (Math.abs(o2) < 1e-6 && onSeg(a, d, b)) return 0
  if (Math.abs(o3) < 1e-6 && onSeg(c, a, d)) return 0
  if (Math.abs(o4) < 1e-6 && onSeg(c, b, d)) return 0

  const ptSegSq = (p: [number, number], u: [number, number], v: [number, number]) => {
    const dx = v[0] - u[0]
    const dy = v[1] - u[1]
    const lenSq = dx * dx + dy * dy
    if (lenSq < 1e-9) return (p[0] - u[0]) ** 2 + (p[1] - u[1]) ** 2
    const t = Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / lenSq))
    const px = u[0] + t * dx
    const py = u[1] + t * dy
    return (p[0] - px) ** 2 + (p[1] - py) ** 2
  }
  return Math.min(ptSegSq(a, c, d), ptSegSq(b, c, d), ptSegSq(c, a, b), ptSegSq(d, a, b))
}

const canonicalNet = (n: string) => (n === 'VM' ? 'VIN' : n)

function stabilizeGeometryAndClearances(board: BoardData, fp: FootprintMod): string[] {
  const notes: string[] = []
  const halfW = board.width / 2
  const halfH = board.height / 2

  // 1. Clamp out-of-bounds parts
  for (const p of board.parts) {
    const body = fp.bodyFor(p)
    const rotQuarter = Math.round(p.rot / 90) % 2 !== 0
    const bw = rotQuarter ? body.h : body.w
    const bh = rotQuarter ? body.w : body.h
    const edgeAllow = p.kind === 'usbc' ? 0.9 : -0.6
    const maxX = halfW - bw / 2 + (p.kind === 'usbc' ? 0 : edgeAllow)
    const maxY = halfH - bh / 2 + edgeAllow
    const nx = Math.max(-(halfW - bw / 2 - 0.6), Math.min(maxX, p.x))
    const ny = Math.max(-(halfH - bh / 2 - 0.6), Math.min(maxY, p.y))
    if (Math.abs(nx - p.x) > 0.05 || Math.abs(ny - p.y) > 0.05) {
      p.x = +nx.toFixed(2)
      p.y = +ny.toFixed(2)
      notes.push(`Clamped ${p.ref} inside board outline (${p.x}, ${p.y} mm)`)
    }
  }

  // 2. Enforce IPC-2221 minimum widths on power & motor nets
  for (const net of board.nets) {
    const minW =
      /^(VIN|VM)$/i.test(net.name)
        ? 0.8
        : /^([AO|BO|CO|DO][12])$/i.test(net.name)
        ? 0.6
        : /^(\+?3V3|VBUS|\+?5V)$/i.test(net.name)
        ? 0.4
        : 0.25
    if ((net.width ?? 0.35) < minW) {
      net.width = minW
      notes.push(`Widened ${net.name} trace to ${minW} mm for IPC-2221 ampacity`)
    }
  }

  // 3. Resolve same-layer trace clearance violations via layer separation & perimeter bypass
  const traceConflicts = (b: BoardData): [number, number][] => {
    const routed = fp.routeNets(b)
    const pairs: [number, number][] = []
    for (let i = 0; i < routed.length; i++) {
      for (let j = i + 1; j < routed.length; j++) {
        const ti = routed[i]
        const tj = routed[j]
        if (ti.layer !== tj.layer) continue
        if (canonicalNet(ti.net) === canonicalNet(tj.net)) continue
        const req = (ti.width + tj.width) / 2 + 0.135
        const reqSq = req * req
        let hit = false
        for (let si = 0; si < ti.points.length - 1 && !hit; si++) {
          for (let sj = 0; sj < tj.points.length - 1 && !hit; sj++) {
            if (segDistSq(ti.points[si], ti.points[si + 1], tj.points[sj], tj.points[sj + 1]) < reqSq) {
              hit = true
            }
          }
        }
        if (hit) pairs.push([i, j])
      }
    }
    return pairs
  }

  let conflicts = traceConflicts(board)
  if (conflicts.length > 0) {
    // Greedy 2-layer coloring + waypoint detours for crossings on both layers
    for (let pass = 0; pass < 12 && conflicts.length > 0; pass++) {
      const counts = new Map<number, number>()
      for (const [i, j] of conflicts) {
        counts.set(i, (counts.get(i) ?? 0) + 1)
        counts.set(j, (counts.get(j) ?? 0) + 1)
      }
      const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      const target = board.nets[worst]
      const prevLayer = target.layer ?? 'top'
      target.layer = prevLayer === 'top' ? 'bottom' : 'top'
      const afterFlip = traceConflicts(board)
      if (afterFlip.length < conflicts.length) {
        conflicts = afterFlip
        notes.push(`Moved ${target.name} (${target.path.join('→')}) to ${target.layer} copper`)
        continue
      }
      // Flip back and try clean perimeter bypass waypoint
      target.layer = prevLayer
      const candidateVias: [number, number][][] = [
        [[0, -28.2]],
        [[-11, 28.2], [11, 28.2]],
        [[-31, -24], [-14, -24]],
        [[-31, 23], [-17, 23]],
        [[17, 23], [31, 23]],
        [[-20, -10]],
        [[20, -10]],
      ]
      let improved = false
      const origVia = target.via
      for (const layerTry of [prevLayer, prevLayer === 'top' ? 'bottom' : 'top'] as const) {
        for (const viaTry of candidateVias) {
          target.layer = layerTry
          target.via = viaTry
          const nextC = traceConflicts(board)
          if (nextC.length < conflicts.length) {
            conflicts = nextC
            notes.push(`Rerouted ${target.name} (${target.path.join('→')}) via (${viaTry[0].join(', ')}) on ${layerTry}`)
            improved = true
            break
          }
        }
        if (improved) break
      }
      if (!improved) {
        target.layer = prevLayer
        target.via = origVia
        break
      }
    }
  }
  return notes
}

function nextRevisionTag(rev: string): string {
  const m = /^(.*?)(\d+)$/.exec(rev)
  if (m) return `${m[1]}${Number(m[2]) + 1}`
  return `${rev}.1`
}

export function repairPlugin(): Plugin {
  let env: Record<string, string | undefined> = process.env
  let root = process.cwd()

  return {
    name: 'forge-repair',
    configResolved(config) {
      root = config.root
      const parentEnv = loadEnv(config.mode, path.resolve(config.root, '..'), ['GEMINI_', 'FORGE_'])
      const localEnv = loadEnv(config.mode, config.envDir || config.root, ['GEMINI_', 'FORGE_'])
      env = { ...parentEnv, ...localEnv, ...process.env }
    },
    configureServer(server) {
      const verifyDir = path.join(server.config.root, 'verify')

      server.middlewares.use('/api/repair', async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
        try {
          const body = await readJson(req)
          const inputBoard = body.board as BoardData | undefined
          if (!inputBoard || !Array.isArray(inputBoard.parts) || !Array.isArray(inputBoard.nets)) {
            return sendJson(res, 400, { error: 'expected { board }' })
          }

          const toLeanMod = (await server.ssrLoadModule('/src/verify/toLean.ts')) as {
            buildCertificate(b: unknown): Certificate
          }
          const fpMod = (await server.ssrLoadModule('/src/pcb/footprint.ts')) as FootprintMod

          const initialCert = toLeanMod.buildCertificate(inputBoard)
          const initialVer = await verifyCertificate(initialCert, verifyDir, 60_000)
          if (initialVer.status === 'passed') {
            return sendJson(res, 200, {
              repaired: true,
              attempts: 0,
              actor: 'lean',
              rationale: 'All 15 Lean 4 theorems already pass.',
              board: inputBoard,
              verification: initialVer,
            })
          }

          const working: BoardData = JSON.parse(JSON.stringify(inputBoard))
          const failedTheorems = initialVer.theorems.filter((t) => !t.ok)
          const apiKey = resolveClaudeKey(env)
          let aiRationale = ''
          let actor: 'claude' | 'deterministic_solver' = 'deterministic_solver'

          if (apiKey) {
            try {
              const model = CLAUDE_TIERS.argon.model
              const promptSummary = {
                boardSize: { width: working.width, height: working.height },
                failedTheorems: failedTheorems.map((t) => ({ name: t.name, statement: t.statement, error: t.error })),
                diagnostics: (initialVer.diagnostics ?? []).slice(0, 25),
                parts: working.parts.map((p) => ({ ref: p.ref, kind: p.kind, x: p.x, y: p.y, rot: p.rot })),
                nets: working.nets.map((n, index) => ({
                  index,
                  name: n.name,
                  path: n.path,
                  layer: n.layer ?? 'top',
                  width: n.width ?? 0.35,
                })),
              }
              const patch = (await callClaude(apiKey, {
                model,
                effort: 'medium',
                system:
                  'You are Forge PCB Studio autonomous Lean 4 repair engineer. Given failed formal PCB theorems and diagnostics, ' +
                  'propose minimal partMoves, netEdits (switching crossing traces between top and bottom copper or widening traces for ampacity), ' +
                  'or board outline adjustments to satisfy all JLCPCB 2-layer and electrical rules. Never remove parts or nets.',
                prompt: JSON.stringify(promptSummary),
                schema: REPAIR_SCHEMA,
                temperature: 0.2,
                timeoutMs: 90_000,
              })) as {
                width?: number
                height?: number
                partMoves?: { ref: string; x: number; y: number }[]
                netEdits?: { index: number; layer?: 'top' | 'bottom'; width?: number }[]
                rationale?: string
              }

              actor = 'claude'
              if (typeof patch.width === 'number' && patch.width >= working.width && patch.width <= 160) {
                working.width = Math.round(patch.width)
              }
              if (typeof patch.height === 'number' && patch.height >= working.height && patch.height <= 140) {
                working.height = Math.round(patch.height)
              }
              for (const mv of patch.partMoves ?? []) {
                const target = working.parts.find((p) => p.ref === mv.ref)
                if (target && Number.isFinite(mv.x) && Number.isFinite(mv.y)) {
                  target.x = +mv.x.toFixed(2)
                  target.y = +mv.y.toFixed(2)
                }
              }
              for (const ne of patch.netEdits ?? []) {
                const net = working.nets[ne.index]
                if (!net) continue
                if (ne.layer === 'top' || ne.layer === 'bottom') net.layer = ne.layer
                if (typeof ne.width === 'number' && ne.width >= 0.15 && ne.width <= 2.5) {
                  net.width = +ne.width.toFixed(2)
                }
              }
              aiRationale = patch.rationale ?? ''
            } catch {
              /* fall through to deterministic routing/bounds repair if the Claude call times out */
            }
          }

          const geoNotes = stabilizeGeometryAndClearances(working, fpMod)
          working.revision = nextRevisionTag(working.revision)

          const nextCert = toLeanMod.buildCertificate(working)
          const nextVer = await verifyCertificate(nextCert, verifyDir, 60_000)
          const summaryNotes = [
            aiRationale,
            geoNotes.length ? `Applied ${geoNotes.length} DRC/layer adjustments (${geoNotes.slice(0, 3).join('; ')}).` : '',
          ]
            .filter(Boolean)
            .join(' ')

          return sendJson(res, 200, {
            repaired: nextVer.status === 'passed',
            attempts: 1,
            actor,
            rationale: summaryNotes || 'Adjusted copper layers and clearances and re-verified in Lean 4.',
            board: working,
            verification: nextVer,
          })
        } catch (e) {
          return sendJson(res, 500, {
            error: e instanceof Error ? e.message : String(e),
          })
        }
      })
    },
    configurePreviewServer(server) {
      const verifyDir = path.join(root, 'verify')
      server.middlewares.use('/api/repair', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
        try {
          const body = await readJson(req)
          const inputBoard = body.board as BoardData | undefined
          if (!inputBoard) return sendJson(res, 400, { error: 'expected { board }' })
          const { module: toLeanMod } = await runnerImport<{ buildCertificate(b: unknown): Certificate }>(
            path.join(root, '/src/verify/toLean.ts'),
            { configFile: false, root, logLevel: 'error', resolve: { alias: { '@': path.join(root, 'src') } } },
          )
          const { module: fpMod } = await runnerImport<FootprintMod>(
            path.join(root, '/src/pcb/footprint.ts'),
            { configFile: false, root, logLevel: 'error', resolve: { alias: { '@': path.join(root, 'src') } } },
          )
          const working: BoardData = JSON.parse(JSON.stringify(inputBoard))
          const notes = stabilizeGeometryAndClearances(working, fpMod)
          working.revision = nextRevisionTag(working.revision)
          const cert = toLeanMod.buildCertificate(working)
          const verification = await verifyCertificate(cert, verifyDir, 60_000)
          return sendJson(res, 200, {
            repaired: verification.status === 'passed',
            attempts: 1,
            actor: 'deterministic_solver',
            rationale: notes.join('; ') || 'Repaired board clearances.',
            board: working,
            verification,
          })
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    },
  }
}
