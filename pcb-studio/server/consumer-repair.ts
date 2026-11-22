import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Plugin } from 'vite'
import { defaultSystem, alternativesFor, type SystemDesign } from '../src/data/system.ts'
import { readJson, sendJson } from './http.ts'

const warnings = [
  'Reported broken motor is not a verified diagnosis; inspect wiring, driver and power first.',
  'Full rover remains unverified: board clearance/all_rules failures, disconnected copper islands, thermal model limited to 7.4 V despite 12 V label.',
  'Mounting, shaft, stall current, installation and physical safety require independent verification.',
]
const priorityNames = ['original_appearance', 'affordability', 'performance', 'sentimental_value']
function preferences(input: Record<string, unknown>) {
  const priorities = input.priorities ?? []
  if (!Array.isArray(priorities) || priorities.length > 4 || new Set(priorities).size !== priorities.length || !priorities.every(p => priorityNames.includes(p))) throw new Error('priorities must be unique supported preservation choices')
  return priorities as string[]
}
function preferenceNotes(priorities: string[], original: boolean, price: number | null, budget: boolean | null) {
  return priorities.map(p => p === 'performance' ? 'Performance: impossible to recommend an improvement without torque/speed under load, stall current and driver evidence.'
    : p === 'affordability' ? `Affordability: catalog unit ${price === null ? 'unknown' : `$${price}`}; known subtotal ${budget ? 'within' : 'not confirmed within'} budget; delivered total unknown. Lower known cost is investigated first, never safety approval.`
    : p === 'sentimental_value' ? `Sentimental value: retain the original assembly and prefer minimal reversible investigation${original ? '; original catalog geometry retained' : '; candidate changes original geometry'}. No personal history inferred.`
    : `Original appearance: ${original ? 'original catalog geometry retained' : 'cannot preserve original catalog geometry with this candidate'}; physical fit remains unverified.`)
}
export function analyze(input: Record<string, unknown>, system = structuredClone(defaultSystem)) {
  const priorities = preferences(input)
  if (input.decision_kind !== undefined && !['prototype_change', 'repair_change'].includes(String(input.decision_kind))) throw new Error('Unsupported decision_kind')
  const prototype = input.decision_kind === 'prototype_change' || input.decision_kind === 'repair_change'
  const unresolved = prototype ? ['Prototype comparison only; no failed component or repair diagnosis is inferred.', ...warnings.slice(1)] : warnings
  if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 4000) throw new Error('description required (1–4000 characters)')
  if (!/rover/i.test(input.description)) throw new Error('Only the supported Rover R1 template is available')
  if (input.budget === undefined && (input.description.match(/\$\s*\d/g)?.length ?? 0) !== 1) throw new Error('Provide one unambiguous USD budget')
  const budget = input.budget ?? Number(input.description.match(/\$\s*(\d+(?:\.\d+)?)/)?.[1] ?? NaN)
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) throw new Error('Provide an explicit nonnegative USD budget')
  if (input.preserve_appearance !== undefined && typeof input.preserve_appearance !== 'boolean') throw new Error('preserve_appearance must be boolean')
  const preserve = input.preserve_appearance ?? (priorities.includes('original_appearance') || /appearance|original|preserv/i.test(input.description))
  const exclusive = input.budget_exclusive ?? /under|below|less than/i.test(input.description)
  if (typeof exclusive !== 'boolean') throw new Error('budget_exclusive must be boolean')
  const quantity = input.quantity ?? 1
  if (!Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 4) throw new Error('quantity must be 1–4')
  const device = system.devices.find(d => d.id === (input.component_id ?? 'm1'))
  if (!device || device.bus !== 'motor') throw new Error('Select a supported motor component_id')
  const candidates = alternativesFor(device).map(a => {
    const price = a.item.pricing[0]?.unit ?? null
    const electrical = a.item.voltage.min <= device.rail && a.item.voltage.max >= device.rail
    return { candidate_id: a.item.id, component_id: device.id, specs: a.item,
      changes: `${device.catalogId} → ${a.item.id}`, compatibility: electrical ? 'partial' : 'rejected',
      appearance: a.item.id === 'tt-motor-148' ? 'matches original template catalog geometry; actual fit unverified' : 'differs from original template catalog geometry; appearance unverified',
      known_cost: price, currency: 'USD', price_kind: 'catalog_not_live_quote', within_known_budget: price === null ? null : exclusive ? price * Number(quantity) < budget : price * Number(quantity) <= budget,
      cost: { unit: price, quantity, known_subtotal: price === null ? null : price * Number(quantity), total: null, currency: 'USD', total_within_budget: null }, preview_eligible: true,
      unknown_costs: ['shipping', 'tax', 'labor'], eligible: false,
      explanation: { hypothesis: prototype ? 'Explore a component change in the original rover digital draft; physical suitability remains unknown' : 'Replacement may help only if motor failure is independently confirmed', priorities: ['budget', ...(preserve ? ['preserve appearance'] : [])], reasons: a.reasons.map(r => r.startsWith('Runs on') ? `Nominal rail in catalog range only; PWM/driver conditions unknown` : r), rejected: [...a.warnings, ...(electrical ? [] : [`${device.rail} V rail exceeds supported voltage range`])], alternative_preferable: 'Same part preserves nominal geometry; other motors may require mounts and drivetrain changes' },
      evidence: [{ kind: 'curated_catalog', source: 'src/data/catalog/peripherals.ts', component_id: a.item.id }], unresolved }
  })
  const comparison = candidates.map(c => {
    const original = c.candidate_id === 'tt-motor-148'
    const score = priorities.reduce((n, p) => n + (p === 'affordability' ? c.known_cost ?? 1000000 : ['sentimental_value', 'original_appearance'].includes(p) ? original ? 0 : 100 : 0), 0)
    return { ...c, preference_notes: preferenceNotes(priorities, original, c.known_cost, c.within_known_budget), investigation_score: score }
  }).sort((a, b) => a.investigation_score - b.investigation_score)
  return { priorities, comparison_purpose: 'investigation_order_not_physical_recommendation', next_steps: ['Do not purchase or install from this preview. Inspect wiring, power and driver before diagnosing a failed motor.', 'Measure motor rail under load and obtain exact driver peak-current/PWM ratings.', 'Obtain manufacturer motor torque/speed curves, stall current, shaft and mount drawings; verify fit and original appearance.', 'Resolve full-board clearance, disconnected copper and thermal limitations; obtain shipping/tax and mounting costs, then reassess.'], goals: { description: input.description, budget, currency: 'USD', preserve_appearance: preserve, budget_exclusive: exclusive, quantity }, component_id: device.id,
    component_selection: input.component_id ? 'user_selected' : 'm1 hypothesis; ask which motor', target_confirmed: Boolean(input.component_id), system, candidates: comparison,
    status: 'no_solution', recommendation: null, verification: 'unverified', unresolved,
    progress: ['template_loaded', 'catalog_checked', 'no_supported_verified_solution'], mode: 'deterministic', agent: null }
}
export type Analysis = ReturnType<typeof analyze>
export type Candidate = Analysis['candidates'][number]
export function repairPlan(session: Session) {
  const a = session.analysis
  const selectedId = a.system.devices.find(d => d.id === a.component_id)!.catalogId
  const selected = a.candidates.find(c => c.candidate_id === selectedId)!
  return { title: 'Rover R1 — investigation and digital change plan, not installation instructions', revision: session.revision, analysis_revision: session.analysis_revision, intent: session.goals.decision_kind ?? 'legacy_repair', description: a.goals.description, goals: a.goals, priorities: a.priorities, component_id: a.component_id,
    physical_recommendation: null, decision: 'NO verified physical replacement; incompatible, insufficiently documented or total cost unknown.', design_status: session.design_status,
    original_part: session.original.devices.find(d => d.id === a.component_id)!.catalogId, selected_draft_part: selectedId, selected_parts: [{ id: selectedId, cost: selected.cost, price_kind: selected.price_kind, specs: selected.specs, evidence: selected.evidence }],
    alternatives: a.candidates.map(c => ({ id: c.candidate_id, compatibility: c.compatibility, physical_eligible: c.eligible, known_subtotal: c.cost.known_subtotal, within_known_budget: c.within_known_budget, reasons: c.explanation, preferences: c.preference_notes })),
    warnings: a.unresolved, next_steps: a.next_steps, history: session.history.map(h => ({ revision: h.revision, action: h.action })), agent_advice_is_not_evidence: true }
}
export type Advice = { recommendation: null; explanation: string; missing_info: string[]; evidence_kind: string; execution_id?: string; mode: string }
export type Session = { design_status: 'digital_preview_unverified'; physical_repair_approved: false; id: string; revision: number; analysis_revision: number; analysis: Analysis; original: SystemDesign; undo_stack: SystemDesign[]; history: { revision: number; action: string; system: SystemDesign }[]; agent: Advice | null; agent_revision: number | null; agent_state: string; agent_error?: string; goals: Record<string, unknown> }
const sessions = new Map<string, Session>()
class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
const scripted: Advice = { recommendation: null, explanation: 'SCRIPTED REHEARSAL: compare a digital draft only. TT/N20 nominal voltage mismatch; JGA25 fit and driver remain unknown. Do not buy or install.', missing_info: ['confirmed diagnosis', 'exact driver and mounting evidence'], evidence_kind: 'scripted_advice_not_evidence', mode: 'rehearsal' }

let activeAgents = 0
async function updateAdvice(session: Session) {
  activeAgents++
  const revision = session.revision
  session.agent_state = 'running'
  try {
    const advice = await hermes(session.analysis)
    if (session.revision !== revision || sessions.get(session.id) !== session) return
    session.agent = { ...advice, mode: 'live' }
    session.agent_revision = revision
    session.agent_state = 'completed'
  } catch (error) {
    if (session.revision !== revision) return
    session.agent_state = 'failed'
    session.agent_error = error instanceof Error && (error.name === 'TimeoutError' || error.message === 'provider_timeout') ? 'provider_timeout:504' : 'provider_failed:502'
  } finally { activeAgents-- }
}

export async function hermes(analysis: Analysis) {
  if (process.env.FORGE_HERMES_PYTHON && process.env.FORGE_HERMES_SOURCE) {
    if (!process.env.ANTHROPIC_API_KEY) throw new ApiError(503, 'provider_unavailable', 'ANTHROPIC_API_KEY required for native Hermes')
    const data = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.env.FORGE_HERMES_PYTHON!, [fileURLToPath(new URL('../../scripts/consumer-hermes.py', import.meta.url))], { timeout: 45000, maxBuffer: 100000, env: process.env }, (error, stdout) => {
        if (error) reject(new Error(error.killed ? 'provider_timeout' : 'Hermes native execution failed; inspect sanitized live check'))
        else resolve(stdout)
      })
      child.stdin?.end(JSON.stringify(analysis))
    })
    const output = JSON.parse(data)
    const advice = output.advice
    if (advice?.recommendation !== null || typeof advice.explanation !== 'string' || !Array.isArray(advice.missing_info) || !advice.missing_info.every((v: unknown) => typeof v === 'string') || !output.execution?.tools?.length) throw new Error('Invalid Hermes structured response')
    return { ...advice, execution: output.execution, evidence_kind: 'agent_prose_not_engineering_evidence' }
  }
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
        if (req.method === 'GET' && path === '/api/consumer-repair/demo') return sendJson(res, 200, { template: defaultSystem, mode: 'scripted_request_real_catalog_checks', request: { description: 'My little rover has a broken motor. Repair under $30 and preserve original appearance.' } })
        if (req.method === 'POST' && path === '/api/consumer-repair/analyze') {
          const input = await readJson(req, 16000)
          if (input.mode !== undefined && !['live', 'deterministic', 'rehearsal'].includes(String(input.mode))) throw new Error('Invalid mode')
          if (input.mode === 'live' && !(process.env.FORGE_HERMES_PYTHON && process.env.FORGE_HERMES_SOURCE && process.env.ANTHROPIC_API_KEY) && (!process.env.FORGE_HERMES_URL || !process.env.FORGE_HERMES_KEY)) throw new ApiError(503, 'provider_unavailable', 'Hermes Agent gateway unavailable; configure FORGE_HERMES_URL and FORGE_HERMES_KEY')
          if (input.mode === 'live' && activeAgents >= 2) throw new ApiError(503, 'provider_busy', 'Two Hermes calls are active; retry later')
          const analysis = analyze(input)
          const id = randomUUID()
          if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!)
          const session: Session = { design_status: 'digital_preview_unverified', physical_repair_approved: false, id, revision: 0, analysis_revision: 0, analysis, original: structuredClone(defaultSystem), history: [], undo_stack: [], agent: input.mode === 'rehearsal' ? structuredClone(scripted) : null, agent_revision: input.mode === 'rehearsal' ? 0 : null, agent_state: input.mode === 'live' ? 'queued' : 'not_requested', goals: input }
          sessions.set(id, session)
          if (input.mode === 'live') void updateAdvice(session)
          return sendJson(res, input.mode === 'live' ? 202 : 200, { ...session, elapsed_ms: performance.now() - started })
        }
        const [, id, action] = path.match(/^\/api\/consumer-repair\/([^/]+)\/(options|summary|apply|undo|plan)$/) ?? []
        const session = sessions.get(id)
        if (!session) return sendJson(res, 404, { error: 'Session not found; reload template after restart', code: 'session_not_found' })
        if (req.method === 'GET' && ['options', 'summary'].includes(action)) return sendJson(res, 200, session)
        if (req.method === 'POST' && ['apply', 'undo', 'plan'].includes(action)) {
          const input = await readJson(req, 2000)
          if (input.base_revision !== session.revision) return sendJson(res, 409, { error: 'Stale base_revision; reload summary', code: 'stale_revision' })
          if (action === 'plan') return sendJson(res, 200, repairPlan(session))
          if (session.history.length >= 32) throw new ApiError(422, 'history_limit', 'Session history full; create a new comparison')
          let system = structuredClone(session.analysis.system)
          if (action === 'undo') {
            const previous = session.undo_stack.pop()
            if (!previous) throw new ApiError(422, 'nothing_to_undo', 'No active draft to undo')
            system = previous
          } else {
            if (input.intent !== 'digital_preview' || input.acknowledge_unverified !== true) throw new ApiError(422, 'acknowledgement_required', 'Physical repair blocked. Explicit digital_preview and acknowledge_unverified=true required')
            if (!session.analysis.target_confirmed || input.component_id !== session.analysis.component_id) throw new ApiError(422, 'target_required', 'Explicitly select the affected motor during analysis and action')
            const candidate = session.analysis.candidates.find(c => c.candidate_id === input.candidate_id)
            if (!candidate) throw new ApiError(422, 'invalid_substitution', 'Candidate is not in this revision analysis')
            session.undo_stack.push(structuredClone(session.analysis.system))
            system.devices.find(d => d.id === input.component_id)!.catalogId = candidate.candidate_id
          }
          session.history.push({ revision: session.revision, action: action === 'undo' ? 'undo' : 'apply_preview', system: structuredClone(session.analysis.system) })
          session.revision++
          session.analysis = analyze(session.goals, system)
          session.analysis_revision = session.revision
          session.agent_state = session.agent_state === 'running' ? 'discarded_stale' : 'stale'
          return sendJson(res, 200, { ...session, design_status: 'digital_preview_unverified', physical_repair_approved: false })
        }
        sendJson(res, 405, { error: 'Method not allowed', code: 'method_not_allowed' })
      } catch (error) { sendJson(res, error instanceof ApiError ? error.status : 400, { error: error instanceof Error ? error.message : 'Consumer repair failed', code: error instanceof ApiError ? error.code : 'invalid_request' }) }
    })
  } }
}
