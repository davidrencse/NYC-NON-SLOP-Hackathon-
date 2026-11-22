import type { Board, Part } from '@/data/board'
import { padsFor, routeNets } from '@/pcb/footprint'
import { catalogDigest, loadCatalog, type LoadedCatalog } from './catalog'
import { checkBoard } from './check'
import { buildBoardNets, validateNets, type NetIssue, type ProposedNet } from './netlist'
import { groundVias, isEdgeConnector, placeParts, type Edge, type PlaceHint } from './place'
import type { CatalogItem, GenEvent, GenRequest, GenStage, LlmCall, Schema } from './types'
import { mapResearchParts, requireResearchParts, researchInstructions } from './researchConstraints'
export { offlineLlm } from './offline'

/**
 * Server-side generation pipeline (loaded by server/ through Vite SSR, never
 * bundled for the browser). The LLM call is injected so this module never
 * sees the API key.
 */

export interface PipelineDeps {
  llm: LlmCall
  emit: (e: GenEvent) => void
  signal?: AbortSignal
}

export interface PipelineResult {
  board: Board
  warnings: string[]
  catalogVersion: string
  timings: Record<string, number>
}

const MAX_REPAIRS = 2
const ROLES = ['connector', 'mcu', 'ic', 'power', 'decoupling', 'passive', 'indicator', 'switch', 'other'] as const

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const s = (v: unknown, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v))

interface PlannedPart {
  ref: string
  catalogId: string
  purpose: string
  role?: PlaceHint['role']
  near?: string
  edge?: Edge
}

interface Plan {
  name: string
  summary: string
  supply: string
  parts: PlannedPart[]
}

// ---------------------------------------------------------------- schemas

function planSchema(ids: string[]): Schema {
  const idSchema: Schema = ids.length <= 600 ? { type: 'STRING', enum: ids } : { type: 'STRING' }
  return {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING', description: 'short product-style board name' },
      summary: { type: 'STRING', description: 'one or two sentences on the architecture' },
      supply: { type: 'STRING', description: 'input supply and rails, e.g. "7.4V LiPo -> 5V/3.3V"' },
      parts: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            ref: { type: 'STRING', description: 'reference designator: U1, J1, C1, R1, D1, SW1 ...' },
            catalogId: idSchema,
            purpose: { type: 'STRING' },
            role: { type: 'STRING', enum: [...ROLES] },
            near: { type: 'STRING', description: 'ref this part must sit next to (decoupling caps, pull-ups, LED resistors); empty if none' },
            edge: { type: 'STRING', enum: ['front', 'back', 'left', 'right', 'none'], description: 'board edge for connectors, else none' },
          },
          required: ['ref', 'catalogId', 'purpose', 'role'],
          propertyOrdering: ['ref', 'catalogId', 'role', 'purpose', 'near', 'edge'],
        },
      },
    },
    required: ['name', 'summary', 'supply', 'parts'],
    propertyOrdering: ['name', 'summary', 'supply', 'parts'],
  }
}

const NETS_SCHEMA: Schema = {
  type: 'OBJECT',
  properties: {
    nets: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'net name, e.g. GND, +3V3, VM, SDA, AIN1' },
          pins: { type: 'ARRAY', items: { type: 'STRING', description: 'REF.pinNumber, e.g. U1.3' } },
        },
        required: ['name', 'pins'],
        propertyOrdering: ['name', 'pins'],
      },
    },
  },
  required: ['nets'],
}

const REPLACE_SCHEMA = (ids: string[]): Schema => ({
  type: 'OBJECT',
  properties: {
    replacements: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ref: { type: 'STRING' },
          catalogId: ids.length <= 600 ? { type: 'STRING', enum: [...ids, 'DROP'] } : { type: 'STRING' },
        },
        required: ['ref', 'catalogId'],
      },
    },
  },
  required: ['replacements'],
})

// ---------------------------------------------------------------- prompts

const PLAN_SYSTEM = `You are the planning engine of Forge PCB Studio. You turn a product request into a bill of materials for a single two-layer PCB.
Rules:
- Choose parts ONLY by catalogId from the catalog provided. Never invent ids.
- Cover the whole circuit: controller, power entry and regulation suited to the loads, drivers, one connector per off-board device (motors → screw terminals, off-board sensors → headers or sensor modules), programming/USB if useful.
- Add support parts: a 100nF decoupling cap per IC (role decoupling, near = that IC), a bulk cap on motor/supply rails, I2C pull-ups, USB-C CC 5.1k resistors, a power/status LED with resistor, reset/boot buttons when the MCU needs them.
- Reference designators: U ICs/modules, J connectors, C capacitors, R resistors, D LEDs, SW switches. Unique, numbered from 1.
- Connectors get an edge (front/back/left/right); everything else edge "none". The USB connector goes on the front edge; power input on the left.
- Prefer few, real, appropriately rated parts; keep the total under 45 parts.`

const NETS_SYSTEM = `You are the schematic engine of Forge PCB Studio. Given placed parts with numbered pins, produce the complete netlist.
Rules:
- Pins are "REF.number" using ONLY the pin numbers listed for each part. Each pin appears in at most one net.
- Every net joins at least 2 pins. Include GND and all power rails; connect every IC power and ground pin.
- Decoupling caps sit between their IC's supply rail and GND. LEDs: anode via resistor to a GPIO or rail, cathode to GND.
- Tactile switches: pins 1 and 3 are one side, pins 2 and 4 the other; pressing joins the two sides. Never put both sides in the same net.
- Never tie two independent supplies together (e.g. USB VBUS and a battery rail) unless a power-path part is present.
- Connect every connector pin that has a purpose (motor outputs, sensor signals, supply). Leave unused pins out.
- Use datasheet-correct pin functions; name nets by signal (GND, +3V3, +5V, VM, SDA, SCL, PWMA, AIN1, ...).`

function digestFor(cat: LoadedCatalog, prompt: string): CatalogItem[] {
  if (cat.items.length <= 400 || !cat.search) return cat.items.slice(0, 600)
  // big catalog: keep search hits for prompt words plus a spread of common parts
  const hits = new Map<string, CatalogItem>()
  for (const w of prompt.toLowerCase().split(/[^a-z0-9+.-]+/).filter((x) => x.length > 2)) for (const i of cat.search(w).slice(0, 20)) hits.set(i.id, i)
  for (const i of cat.items) if (hits.size < 400) hits.set(i.id, i)
  return [...hits.values()]
}

function pinListing(part: Part, names: string[] | undefined): string {
  const n = padsFor(part).length
  let nm = names && names.length >= n ? names.slice(0, n) : undefined
  if (!nm) {
    if (part.kind === 'led') nm = ['A (anode)', 'K (cathode)']
    else if (part.kind === 'ecap') nm = ['+', '-']
    else if (part.kind === 'tact') nm = ['A', 'B', 'A (internally joined to 1)', 'B (internally joined to 2)']
  }
  if (!nm) return `pins 1-${n}`
  return nm.map((x, i) => `${i + 1} ${x}`).join(', ')
}

function partsBlock(parts: Part[], planned: Map<string, PlannedPart>, pinNames: Map<string, string[] | undefined>): string {
  return parts
    .map((p) => {
      const pl = planned.get(p.ref)
      return `${p.ref} = ${p.name} (${p.mpn || p.pkg}, ${p.kind}${p.value ? `, ${p.value}` : ''})${pl ? ` — ${pl.purpose}` : ''}\n   ${pinListing(p, pinNames.get(p.ref))}`
    })
    .join('\n')
}

// ---------------------------------------------------------------- helpers

function parsePlan(raw: unknown): Plan {
  const r = isRec(raw) ? raw : {}
  const parts = Array.isArray(r.parts) ? r.parts : []
  return {
    name: s(r.name, 'Generated board').slice(0, 60),
    summary: s(r.summary),
    supply: s(r.supply),
    parts: parts.filter(isRec).map((p) => ({
      ref: s(p.ref).trim().toUpperCase(),
      catalogId: s(p.catalogId).trim(),
      purpose: s(p.purpose),
      role: (ROLES as readonly string[]).includes(s(p.role)) ? (s(p.role) as PlaceHint['role']) : undefined,
      near: s(p.near).trim().toUpperCase() || undefined,
      edge: ['front', 'back', 'left', 'right'].includes(s(p.edge)) ? (s(p.edge) as Edge) : undefined,
    })),
  }
}

function parseNets(raw: unknown): ProposedNet[] {
  const r = isRec(raw) ? raw : {}
  const nets = Array.isArray(r.nets) ? r.nets : []
  return nets.filter(isRec).map((n) => ({ name: s(n.name, 'NET'), pins: Array.isArray(n.pins) ? n.pins.map((x) => s(x)) : [] }))
}

const PREFIX: Record<string, string> = { module: 'U', ssop: 'U', soic: 'U', sot223: 'U', usbc: 'J', terminal: 'J', header: 'J', ecap: 'C', tact: 'SW', led: 'D', chip: 'R' }

/** Make refs unique and well-formed; returns old→new map. */
function fixRefs(parts: { ref: string; item: CatalogItem }[]): Map<string, string> {
  const used = new Set<string>()
  const map = new Map<string, string>()
  const counters = new Map<string, number>()
  const next = (prefix: string) => {
    let n = counters.get(prefix) ?? 1
    while (used.has(`${prefix}${n}`)) n++
    counters.set(prefix, n + 1)
    return `${prefix}${n}`
  }
  for (const p of parts) {
    let ref = p.ref
    if (!/^[A-Z]{1,3}\d{1,3}$/.test(ref) || used.has(ref)) {
      const chipPrefix = /cap/i.test(p.item.category) ? 'C' : 'R'
      ref = next(p.item.kind === 'chip' ? chipPrefix : (PREFIX[p.item.kind] ?? 'U'))
    }
    used.add(ref)
    if (!map.has(p.ref)) map.set(p.ref, ref)
  }
  return map
}

function isMajor(p: Part) {
  return ['module', 'ssop', 'soic', 'sot223', 'usbc'].includes(p.kind) || (p.kind === 'terminal' && /power|input|motor/i.test(`${p.name} ${p.description}`))
}

const fmtIssues = (issues: NetIssue[]) => issues.slice(0, 40).map((i) => `- net ${i.net}${i.pin ? ` pin ${i.pin}` : ''}: ${i.problem}`).join('\n')

// ---------------------------------------------------------------- pipeline

export async function runPipeline(req: GenRequest, deps: PipelineDeps): Promise<PipelineResult> {
  const { llm, emit, signal } = deps
  const timings: Record<string, number> = {}
  const warnings: string[] = []
  const t0 = Date.now()
  let tStage = t0
  let current: GenStage = 'plan'
  const stage = (st: GenStage, message: string) => {
    timings[current] = (timings[current] ?? 0) + (Date.now() - tStage)
    tStage = Date.now()
    current = st
    emit({ type: 'stage', stage: st, message, ms: Date.now() - t0 })
  }
  const checkAbort = () => {
    if (signal?.aborted) throw new Error('aborted')
  }
  const c = req.constraints ?? {}
  const constraintText = [
    c.supply && `Supply: ${c.supply}`,
    c.maxWidth && `Max board width ${c.maxWidth} mm`,
    c.maxHeight && `Max board height ${c.maxHeight} mm`,
    c.notes && `Notes: ${c.notes}`,
  ]
    .filter(Boolean)
    .join('\n')

  // ---- 1. plan
  emit({ type: 'stage', stage: 'plan', message: 'Reading the catalog and planning the architecture', ms: 0 })
  const cat = await loadCatalog()
  const researchMapping = req.research ? mapResearchParts(req.research, cat.items.flatMap((item) => {
    try { const part = cat.makePart(item, 'U0'); return [{ id: item.id, manufacturer: part.manufacturer, mpn: part.mpn }] }
    catch { return [] }
  })) : []
  const researchText = req.research ? researchInstructions(req.research, researchMapping) : ''
  if (req.research) warnings.push(req.research.snapshot.scope)
  if (cat.source === 'fallback') warnings.push(`Using the built-in parts list (${cat.note ?? 'catalog unavailable'})`)
  else if (cat.note) warnings.push(cat.note)
  const digestItems = digestFor(cat, req.prompt)
  for (const required of researchMapping) {
    if (!digestItems.some((i) => i.id === required.catalogId)) digestItems.push(cat.byId.get(required.catalogId)!)
  }
  const ids = digestItems.map((i) => i.id)
  const planRaw = await llm({
    model: 'argon',
    system: `${PLAN_SYSTEM}\n${researchText}`,
    prompt: `Request: ${req.prompt}\n${constraintText ? `Constraints:\n${constraintText}\n` : ''}\nCatalog (id | name | category | interfaces | voltage | current | footprint | pads | description):\n${catalogDigest(digestItems)}`,
    schema: planSchema(ids),
  })
  checkAbort()
  const plan = parsePlan(planRaw)
  if (!plan.parts.length) throw new Error('The planner returned no parts')

  // ---- 2. select
  stage('select', `Plan "${plan.name}": ${plan.parts.length} parts. Matching catalog entries`)
  let unknown = plan.parts.filter((p) => !cat.byId.has(p.catalogId))
  for (let attempt = 1; unknown.length && attempt <= MAX_REPAIRS; attempt++) {
    stage('select', `Repairing ${unknown.length} unknown catalog id(s) with Claude (fast) (attempt ${attempt})`)
    const rep = await llm({
      model: 'carbon',
      system: 'Replace invalid catalog ids with the closest valid catalog id, or DROP if nothing fits. Answer only with valid ids.',
      prompt: `Invalid selections:\n${unknown.map((u) => `${u.ref}: "${u.catalogId}" (${u.purpose})`).join('\n')}\n\nCatalog:\n${catalogDigest(digestItems)}`,
      schema: REPLACE_SCHEMA(ids),
    })
    checkAbort()
    const reps = isRec(rep) && Array.isArray(rep.replacements) ? rep.replacements.filter(isRec) : []
    for (const r of reps) {
      const pp = plan.parts.find((p) => p.ref === s(r.ref).toUpperCase())
      if (pp) pp.catalogId = s(r.catalogId)
    }
    plan.parts = plan.parts.filter((p) => p.catalogId !== 'DROP')
    unknown = plan.parts.filter((p) => !cat.byId.has(p.catalogId))
  }
  if (unknown.length) {
    warnings.push(`Dropped parts with unknown catalog ids: ${unknown.map((u) => `${u.ref} (${u.catalogId})`).join(', ')}`)
    plan.parts = plan.parts.filter((p) => cat.byId.has(p.catalogId))
  }
  const refMap = fixRefs(plan.parts.map((p) => ({ ref: p.ref, item: cat.byId.get(p.catalogId)! })))
  const planned = new Map<string, PlannedPart>()
  const pinNames = new Map<string, string[] | undefined>()
  const hints: PlaceHint[] = []
  let parts: Part[] = []
  const seen = new Set<string>()
  for (const pp of plan.parts) {
    const ref = refMap.get(pp.ref) ?? pp.ref
    if (seen.has(ref)) continue
    seen.add(ref)
    const item = cat.byId.get(pp.catalogId)!
    let part: Part
    try {
      part = cat.makePart(item, ref)
    } catch (e) {
      warnings.push(`${ref}: ${(e as Error).message}`)
      continue
    }
    part.catalogId = item.id
    part.major = isMajor(part) || undefined
    parts.push(part)
    pinNames.set(ref, item.pinNames)
    const near = pp.near ? (refMap.get(pp.near) ?? pp.near) : undefined
    planned.set(ref, { ...pp, ref, near })
    hints.push({ ref, role: pp.role, near: near && near !== ref ? near : undefined, edge: pp.edge })
  }
  if (!parts.length) throw new Error('No usable parts after catalog matching')
  requireResearchParts(researchMapping, parts)
  // only hint "near" toward refs that exist
  for (const h of hints) if (h.near && !parts.some((p) => p.ref === h.near)) h.near = undefined

  // ---- 3. place
  stage('place', `Placing ${parts.length} parts (${parts.filter((p) => isEdgeConnector(p, hints.find((h) => h.ref === p.ref))).length} on the edges)`)
  const placed = placeParts(parts, hints, { maxWidth: c.maxWidth, maxHeight: c.maxHeight })
  parts = placed.parts
  emit({ type: 'stage', stage: 'place', message: `Board ${placed.width} × ${placed.height} mm, placed in ${placed.attempts} pass(es)`, ms: Date.now() - t0 })

  // ---- 4. route: argon proposes the netlist
  stage('route', 'Drafting the netlist with Claude')
  const block = partsBlock(parts, planned, pinNames)
  const netsRaw = await llm({
    model: 'argon',
    system: `${NETS_SYSTEM}\n${researchText}`,
    prompt: `Board: ${plan.name}\nRequest: ${req.prompt}\nArchitecture: ${plan.summary}\nSupply: ${plan.supply}\n\nParts and pins:\n${block}`,
    schema: NETS_SCHEMA,
  })
  checkAbort()
  let proposed = parseNets(netsRaw)

  // ---- 5. check + repair with carbon
  stage('check', `Validating ${proposed.length} nets against the footprints`)
  let v = validateNets(proposed, parts, pinNames)
  for (let attempt = 1; v.issues.length && attempt <= MAX_REPAIRS; attempt++) {
    stage('check', `${v.issues.length} netlist issue(s); repairing with Claude (fast) (attempt ${attempt})`)
    const fixed = await llm({
      model: 'carbon',
      system: `${NETS_SYSTEM}\n${researchText}\nYou are repairing an existing netlist: fix every listed issue, keep everything else unchanged, and return the COMPLETE corrected netlist.`,
      prompt: `Parts and pins:\n${block}\n\nCurrent netlist:\n${JSON.stringify({ nets: proposed })}\n\nIssues:\n${fmtIssues(v.issues)}`,
      schema: NETS_SCHEMA,
    })
    checkAbort()
    const next = parseNets(fixed)
    if (next.length) proposed = next
    v = validateNets(proposed, parts, pinNames)
  }
  if (v.issues.length) warnings.push(`Dropped ${v.issues.length} invalid net connection(s): ${v.issues.slice(0, 6).map((i) => `${i.pin ?? i.net} (${i.problem})`).join('; ')}`)

  const base = {
    name: plan.name,
    revision: 'AI-1',
    width: placed.width,
    height: placed.height,
    thickness: 1.6,
    cornerRadius: 2.5,
    holes: placed.holes,
    parts,
  }
  const nets = buildBoardNets(base, v.nets)
  const board: Board = { ...base, nets, groundVias: [] }
  if (req.research) board.researchHandoff = {
    envelope: req.research.envelope,
    partMapping: researchMapping,
    scope: req.research.snapshot.scope,
    pcbValidation: 'required',
  }
  board.groundVias = groundVias(board, routeNets(board))
  const drc = checkBoard(board)
  if (drc.errors.length) throw new Error(`Board check failed: ${drc.errors.slice(0, 5).join('; ')}`)
  warnings.push(...drc.warnings)
  emit({ type: 'stage', stage: 'check', message: `Check passed: ${parts.length} parts, ${v.nets.length} nets, ${nets.length} traces`, ms: Date.now() - t0 })
  timings[current] = (timings[current] ?? 0) + (Date.now() - tStage)
  timings.total = Date.now() - t0
  return { board, warnings, catalogVersion: `${cat.source}:${cat.version}`, timings }
}
