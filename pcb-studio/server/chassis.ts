// POST /api/chassis: Claude designs the mechanical body for any product as a list
// of primitive solids. The studio renders them with three.js. No recipe per product.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { callClaude, CLAUDE_TIERS, resolveClaudeKey } from './claude.ts'
import { readJson, sendJson } from './http.ts'
import { hasBuiltInBody } from '../src/data/bodyPolicy.ts'

const SHAPES = ['box', 'cyl', 'ring', 'sphere'] as const
const MATS = ['metal', 'plastic', 'rubber', 'carbon', 'clear'] as const

const SYSTEM = `You are a mechanical designer. Model the physical body of the requested product as primitive solids for a 3D viewer.
Units are millimetres. y is up. The product is centred on the origin. Real-world proportions.
A custom PCB lies flat, centred at the origin, at the given height. Listed catalog devices already have existing catalog meshes at the given positions; do not duplicate or redesign them. Add custom mechanical peripherals (guides, handles, brackets, tooling) when the brief calls for them. Build the body around them: do not bury the PCB inside a closed solid, leave the top open or use 'clear' covers.
Shapes:
- box: size = [width x, height y, depth z]
- cyl: size = [radius, height, 0], axis along y before rotation
- ring: size = [ring radius, tube radius, 0], lies in the x-y plane (faces z) before rotation
- sphere: size = [radius, 0, 0]
rot is [x, y, z] in degrees. Set spin true only for parts that rotate in use (rotors, wheels, fans).
Model what makes the product recognisable: frame, shell walls, arms, wheels, legs, lenses, straps, handles, nozzles. Prefer 12 to 32 parts, maximum 60. Omit unnecessary detail. Keep everything within 400 mm of the origin.`

const num3 = { type: 'ARRAY', items: { type: 'NUMBER' }, minItems: 3, maxItems: 3 }
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    parts: {
      type: 'ARRAY',
      maxItems: 60,
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          shape: { type: 'STRING', enum: [...SHAPES] },
          size: num3,
          pos: num3,
          rot: num3,
          mat: { type: 'STRING', enum: [...MATS] },
          spin: { type: 'BOOLEAN' },
        },
        required: ['shape', 'size', 'pos', 'mat'],
      },
    },
  },
  required: ['parts'],
}

const vec = (v: unknown, limit: number): [number, number, number] | null => {
  if (!Array.isArray(v) || v.length < 3) return null
  const out = v.slice(0, 3).map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(-limit, Math.min(limit, n)) : NaN))
  return out.some(Number.isNaN) ? null : (out as [number, number, number])
}

/** Keep only well-formed parts, so a bad model answer can never break the viewer. */
export function cleanParts(raw: unknown) {
  const list = Array.isArray((raw as { parts?: unknown })?.parts) ? (raw as { parts: unknown[] }).parts : []
  const parts = []
  for (const p of list.slice(0, 120) as Record<string, unknown>[]) {
    const shape = SHAPES.find((s) => s === p?.shape)
    const mat = MATS.find((m) => m === p?.mat)
    const size = vec(p?.size, 800)
    const pos = vec(p?.pos, 600)
    if (!shape || !mat || !size || !pos || size[0] <= 0) continue
    if (shape !== 'sphere' && size[1] <= 0) continue
    if (shape === 'box' && size[2] <= 0) continue
    if (shape === 'ring' && size[1] >= size[0]) continue
    parts.push({ shape, mat, size, pos, rot: vec(p?.rot, 360) ?? undefined, spin: p?.spin === true || undefined })
  }
  return parts
}

export function chassisHandler(env: () => Record<string, string | undefined>, log: (m: string) => void) {
  type Result = { parts: ReturnType<typeof cleanParts>; reason?: string }
  // Bound memory and reuse successes only. Include credentials to isolate callers.
  const cache = new Map<string, { result: Result; expires: number }>()
  const pending = new Map<string, Promise<Result>>()
  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now()
    res.setHeader('cache-control', 'no-store')
    const reply = (result: Result, source: string) => {
      res.setHeader('server-timing', `chassis;dur=${(performance.now() - started).toFixed(1)}`)
      res.setHeader('x-forge-chassis-cache', source)
      return sendJson(res, 200, result)
    }
    if (req.method !== 'POST') return sendJson(res, 405, { type: 'error', message: 'Use POST' })
    let body: Record<string, unknown>
    try {
      body = (await readJson(req)) as Record<string, unknown>
    } catch (e) {
      return sendJson(res, 400, { type: 'error', message: (e as Error).message })
    }
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 2000) : ''
    if (!prompt) return sendJson(res, 400, { type: 'error', message: 'prompt is required' })
    // Preserve built-ins even for callers outside the studio UI.
    if (hasBuiltInBody(prompt)) return sendJson(res, 200, { parts: [], reason: 'built-in' })
    const sent = req.headers['x-claude-key'] ?? req.headers['x-gemini-key']
    const apiKey = (typeof sent === 'string' && /^sk-ant-[\w-]{20,200}$/.test(sent) ? sent : '') || resolveClaudeKey(env())
    if (!apiKey) return sendJson(res, 200, { parts: [], reason: 'no-key' })
    const layout = typeof body.layout === 'string' ? body.layout.slice(0, 3000) : ''
    const config = env()
    const model = config.FORGE_CLAUDE_CHASSIS_MODEL || CLAUDE_TIERS.carbon.model
    const key = createHash('sha256').update(JSON.stringify([apiKey, model, prompt, layout])).digest('hex')
    const hit = cache.get(key)
    if (hit && hit.expires > Date.now()) return reply(hit.result, 'hit')
    cache.delete(key)
    const existing = pending.get(key)
    if (existing) return reply(await existing, 'shared')
    if (pending.size >= 3) return reply({ parts: [], reason: 'busy' }, 'miss')
    const job = (async (): Promise<Result> => {
      try {
        // One attempt within a total deadline: retries must not leave previews waiting minutes.
        const raw = await callClaude(apiKey, { model, effort: 'low', system: SYSTEM, prompt: `Product: ${prompt}\n\n${layout}`, schema: SCHEMA, timeoutMs: 55_000, signal: AbortSignal.timeout(55_000), maxAttempts: 1 })
        const parts = cleanParts(raw)
        log(`chassis: ${parts.length} parts`)
        const result = { parts, ...(parts.length ? {} : { reason: 'invalid-geometry' }) }
        if (parts.length) {
          if (cache.size >= 128) cache.delete(cache.keys().next().value!)
          cache.set(key, { result, expires: Date.now() + 30 * 60_000 })
        }
        return result
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        log(`chassis failed (${why})`)
        return { parts: [], reason: why.slice(0, 200) }
      }
    })()
    pending.set(key, job)
    try {
      return reply(await job, 'miss')
    } finally {
      pending.delete(key)
    }
  }
}
