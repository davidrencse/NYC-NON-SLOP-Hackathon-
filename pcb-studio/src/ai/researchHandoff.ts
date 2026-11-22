/** Shared handoff contract. A hash identifies inputs; it is not a truth score. */
export interface ResearchReference { researchId: string; bundleSha256: string }
export interface ResearchEnvelope {
  schema_version: 1
  bundle_sha256: string
  snapshot_json: string
}
export interface ResearchSnapshot {
  research_id: string
  kind: 'evidence_backed' | 'sample' | 'exploratory'
  brief: string
  parts: { id: string; name: string; manufacturer: string; sku: string }[]
  device_spec: { components: { catalog_id: string; quantity: number }[]; wiring: unknown; mechanical: unknown } | null
  evidence: { part_id: string; design_ready: boolean; facts: Record<string, unknown>[] }[]
  source_research: unknown
  research_verification: { status: string } | null
  scope: string
}
export interface ResearchContext {
  envelope: ResearchEnvelope
  snapshot: ResearchSnapshot
}

export function isResearchReference(value: unknown): value is ResearchReference {
  if (!value || typeof value !== 'object') return false
  const r = value as ResearchReference
  return typeof r.researchId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.researchId)
    && typeof r.bundleSha256 === 'string' && /^[0-9a-f]{64}$/.test(r.bundleSha256)
}

// Bound to the exact loaded brief, so manually starting another design drops its provenance.
let active: { prompt: string; reference: ResearchReference } | null = null
let revision = 0
let generating = false
export function activateResearch(prompt: string, reference: ResearchReference) {
  active = { prompt: prompt.trim(), reference: { ...reference } }
  revision++
}
export function researchForPrompt(prompt: string): ResearchReference | undefined {
  if (active && active.prompt !== prompt.trim()) { active = null; revision++ }
  return active ? { ...active.reference } : undefined
}

export function isBoardGenerationInFlight() { return generating }

/** Prevent overlapping handoffs and reject late results from a superseded research run. */
export function beginBoardGeneration(prompt: string) {
  if (generating) throw new Error('Finish the current board generation before starting another handoff.')
  const reference = researchForPrompt(prompt)
  const startedAt = revision
  generating = true
  return {
    reference,
    assertCurrent() {
      if (revision !== startedAt) throw new Error('Research changed during generation. Discarded the older result.')
    },
    finish() { generating = false },
  }
}

export function researchPrompt(snapshot: ResearchSnapshot): string {
  return snapshot.brief.slice(0, 2000).trim()
}

export async function loadResearch(reference: ResearchReference, signal?: AbortSignal): Promise<ResearchContext> {
  const response = await fetch(`/api/research/${reference.researchId}/engineering-handoff`, { signal, cache: 'no-store' })
  const body = await response.json() as ResearchEnvelope & { detail?: string }
  if (!response.ok) throw new Error(body.detail || 'Research handoff unavailable')
  if (body.schema_version !== 1 || body.bundle_sha256 !== reference.bundleSha256 || typeof body.snapshot_json !== 'string') {
    throw new Error('Research handoff changed. Return to research and hand it over again.')
  }
  const snapshot = JSON.parse(body.snapshot_json) as ResearchSnapshot
  if (snapshot.research_id !== reference.researchId || !snapshot.brief) throw new Error('Invalid research handoff')
  return { envelope: body, snapshot }
}
