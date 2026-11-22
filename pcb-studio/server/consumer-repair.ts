import { randomUUID } from 'node:crypto'
import type { Plugin } from 'vite'
import { defaultSystem, alternativesFor, type SystemDesign } from '../src/data/system.ts'
import { readJson, sendJson } from './http.ts'

const warnings = [
  'Reported broken motor is not a verified diagnosis; inspect wiring, driver and power first.',
  'Full rover remains unverified: board clearance/all_rules failures, disconnected copper islands, thermal model limited to 7.4 V despite 12 V label.',
  'Mounting, shaft, stall current, installation and physical safety require independent verification.',
]
export function analyze(input: Record<string, unknown>, system = structuredClone(defaultSystem)) {
  if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 4000) throw new Error('description required (1–4000 characters)')
  if (!/rover/i.test(input.description)) throw new Error('Only the supported Rover R1 template is available')
  const budget = input.budget ?? Number(input.description.match(/\$\s*(\d+(?:\.\d+)?)/)?.[1] ?? NaN)
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) throw new Error('Provide an explicit nonnegative USD budget')
  if (input.preserve_appearance !== undefined && typeof input.preserve_appearance !== 'boolean') throw new Error('preserve_appearance must be boolean')
  const device = system.devices.find(d => d.id === (input.component_id ?? 'm1'))
  if (!device || device.bus !== 'motor') throw new Error('Select a supported motor component_id')
  const candidates = alternativesFor(device).map(a => {
    const price = a.item.pricing[0]?.unit ?? null
    const electrical = a.item.voltage.min <= device.rail && a.item.voltage.max >= device.rail
    return { candidate_id: a.item.id, component_id: device.id, specs: a.item,
      changes: `${device.catalogId} → ${a.item.id}`, compatibility: electrical ? 'partial' : 'rejected',
      appearance: a.current ? 'same catalog geometry; actual fit unverified' : 'unverified',
      known_cost: price, currency: 'USD', price_kind: 'catalog_not_live_quote', within_known_budget: price === null ? null : price <= budget,
      unknown_costs: ['shipping', 'tax', 'labor'], eligible: false,
      explanation: { hypothesis: 'Replacement may help only if motor failure is independently confirmed', priorities: ['budget', 'preserve appearance'], reasons: a.reasons, rejected: [...a.warnings, ...(electrical ? [] : [`${device.rail} V rail exceeds supported voltage range`])], alternative_preferable: 'Same part preserves nominal geometry; other motors may require mounts and drivetrain changes' },
      evidence: [{ kind: 'curated_catalog', source: 'src/data/catalog/peripherals.ts', component_id: a.item.id }], unresolved: warnings }
  })
  return { goals: { description: input.description, budget, currency: 'USD', preserve_appearance: input.preserve_appearance ?? /appearance|original|preserv/i.test(input.description) }, component_id: device.id,
    component_selection: input.component_id ? 'user_selected' : 'm1 hypothesis; ask which motor', system, candidates,
    status: 'no_solution', recommendation: null, verification: 'unverified', unresolved: warnings,
    progress: ['template_loaded', 'catalog_checked', 'no_supported_verified_solution'], mode: 'deterministic', agent: null }
}
type Analysis = ReturnType<typeof analyze>
const sessions = new Map<string, { id: string; revision: number; analysis: Analysis; history: SystemDesign[] }>()

export async function hermes(analysis: Analysis) {
  const url = process.env.FORGE_HERMES_URL
  const key = process.env.FORGE_HERMES_KEY
  if (!url || !key) throw new Error('Hermes Agent gateway unavailable: configure FORGE_HERMES_URL and FORGE_HERMES_KEY; no model-only fallback')
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const caps = await fetch(`${url}/v1/capabilities`, { headers, signal: AbortSignal.timeout(3000) }).then(r => r.json()) as { platform?: string }
  if (caps.platform !== 'hermes-agent') throw new Error('Endpoint is not a Hermes Agent gateway')
  const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, signal: AbortSignal.timeout(30000), body: JSON.stringify({ model: 'hermes-agent', stream: false, messages: [
    { role: 'system', content: 'Compare only supplied FORGE facts. Prose is advisory, never engineering evidence. Return JSON {recommendation:null,explanation:string,missing_info:string[]}. No physical safety claims. Do not execute external tools or modify files.' },
    { role: 'user', content: JSON.stringify(analysis) },
  ] }) })
  if (!response.ok) throw new Error(`Hermes HTTP ${response.status}`)
  const body = await response.json() as { id?: string; choices?: { finish_reason?: string; message: { content: string } }[] }
  const choice = body.choices?.[0]
  if (choice?.finish_reason !== 'stop') throw new Error('Hermes did not complete')
  const result = JSON.parse(choice.message.content)
  if (result.recommendation !== null || typeof result.explanation !== 'string' || !Array.isArray(result.missing_info) || !result.missing_info.every((x: unknown) => typeof x === 'string')) throw new Error('Invalid Hermes structured response')
  return { ...result, evidence_kind: 'agent_prose_not_engineering_evidence', execution_id: body.id }
}

export function consumerRepairPlugin(): Plugin {
  return { name: 'forge-consumer-repair', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = req.url?.split('?')[0] ?? ''
      if (!path.startsWith('/api/consumer-repair') || path === '/api/consumer-repair/manual') return next()
      const started = performance.now()
      try {
        if (req.method === 'GET' && path.endsWith('/demo')) return sendJson(res, 200, { template: defaultSystem, mode: 'scripted_request_real_catalog_checks', request: { description: 'My little rover has a broken motor. Repair under $30 and preserve original appearance.' } })
        if (req.method === 'POST' && path.endsWith('/analyze')) {
          const input = await readJson(req, 16000)
          if (input.mode !== undefined && !['live', 'deterministic'].includes(String(input.mode))) throw new Error('Invalid mode')
          const analysis = analyze(input)
          const agent = input.mode === 'live' ? await hermes(analysis) : null
          const id = randomUUID()
          if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!)
          const session = { id, revision: 0, analysis, history: [] }
          sessions.set(id, session)
          return sendJson(res, 200, { ...session, agent, elapsed_ms: performance.now() - started })
        }
        const [, id, action] = path.match(/^\/api\/consumer-repair\/([^/]+)\/(options|summary|apply|undo)$/) ?? []
        const session = sessions.get(id)
        if (!session) return sendJson(res, 404, { error: 'Session not found; reload template after restart' })
        if (req.method === 'GET' && ['options', 'summary'].includes(action)) return sendJson(res, 200, session)
        if (req.method === 'POST' && ['apply', 'undo'].includes(action)) {
          const input = await readJson(req, 2000)
          if (input.base_revision !== session.revision) return sendJson(res, 409, { error: 'Stale base_revision; reload summary' })
          // No current catalog candidate has sufficient evidence to permit a safe substitution.
          return sendJson(res, 422, { error: action === 'undo' ? 'No applied revision to undo' : 'No eligible substitution; resolve electrical and mechanical evidence first' })
        }
        sendJson(res, 405, { error: 'Method not allowed' })
      } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : 'Consumer repair failed' }) }
    })
  } }
}
