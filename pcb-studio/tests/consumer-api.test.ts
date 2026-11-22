import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { consumerRepairPlugin } from '../server/consumer-repair.ts'
import type { ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

let handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>
const plugin = consumerRepairPlugin()
const configure = plugin.configureServer as (server: ViteDevServer) => void
configure({ middlewares: { use(fn: typeof handler) { handler = fn } } } as unknown as ViteDevServer)
async function request(path: string, body?: object) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as IncomingMessage
  req.url = '/api/consumer-repair/' + path
  req.method = body ? 'POST' : 'GET'
  let result = ''
  const res = { setHeader() {}, end(value: string) { result = value } } as unknown as ServerResponse
  await handler(req, res, () => {})
  return { status: res.statusCode, body: JSON.parse(result) }
}
test('stale revisions and invalid substitutions cannot apply', async () => {
  const a = await request('analyze', { description: 'rover motor $30' })
  assert.equal(a.status, 200)
  assert.equal((await request(`${a.body.id}/apply`, { base_revision: 99, candidate_id: 'tt-motor-148' })).status, 409)
  assert.equal((await request(`${a.body.id}/apply`, { base_revision: 0, candidate_id: 'invented' })).status, 422)
  assert.equal((await request(`${a.body.id}/summary`)).body.revision, 0)
})
test('draft requires explicit target and acknowledgement; undo preserves original', async () => {
  const s = (await request('analyze', { description: 'rover under $30', component_id: 'm3', mode: 'rehearsal' })).body
  const input = { base_revision: 0, component_id: 'm3', candidate_id: 'jga25-370-12v', intent: 'digital_preview', acknowledge_unverified: true }
  assert.equal((await request(`${s.id}/apply`, { ...input, acknowledge_unverified: false })).status, 422)
  const draft = (await request(`${s.id}/apply`, input)).body
  assert.equal(draft.revision, 1)
  assert.equal(draft.analysis_revision, 1)
  assert.equal(draft.analysis.status, 'no_solution')
  assert.equal(draft.agent_revision, 0)
  assert.equal(draft.original.devices.find((d: { id: string }) => d.id === 'm3').catalogId, 'tt-motor-148')
  assert.equal((await request(`${s.id}/summary`)).body.agent.mode, 'rehearsal')
  const undo = (await request(`${s.id}/undo`, { base_revision: 1 })).body
  assert.equal(undo.revision, 2)
  assert.deepEqual(undo.analysis.system, s.analysis.system)
})
test('late live advice cannot overwrite newer revision', async (t) => {
  const oldUrl = process.env.FORGE_HERMES_URL, oldKey = process.env.FORGE_HERMES_KEY
  process.env.FORGE_HERMES_URL = 'http://localhost:8642'; process.env.FORGE_HERMES_KEY = 'test-only'
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).endsWith('capabilities')) return new Response(JSON.stringify({ platform: 'hermes-agent' }))
    await gate
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ recommendation: null, explanation: 'late', missing_info: [] }) } }] }))
  })
  try {
    const s = (await request('analyze', { description: 'rover $30', component_id: 'm1', mode: 'live' })).body
    await request(`${s.id}/apply`, { base_revision: 0, component_id: 'm1', candidate_id: 'jga25-370-12v', intent: 'digital_preview', acknowledge_unverified: true })
    release(); await new Promise(r => setTimeout(r, 10))
    const summary = (await request(`${s.id}/summary`)).body
    assert.equal(summary.agent, null)
    assert.equal(summary.agent_state, 'discarded_stale')
  } finally {
    release()
    if (oldUrl === undefined) delete process.env.FORGE_HERMES_URL; else process.env.FORGE_HERMES_URL = oldUrl
    if (oldKey === undefined) delete process.env.FORGE_HERMES_KEY; else process.env.FORGE_HERMES_KEY = oldKey
  }
})
test('live cannot silently fall back without gateway configuration', async () => {
  const old = process.env.FORGE_HERMES_URL
  delete process.env.FORGE_HERMES_URL
  try { assert.match((await request('analyze', { description: 'rover $30', mode: 'live' })).body.error, /unavailable/) }
  finally { if (old) process.env.FORGE_HERMES_URL = old }
})
