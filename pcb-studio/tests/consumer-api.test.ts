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
test('live cannot silently fall back without gateway configuration', async () => {
  const old = process.env.FORGE_HERMES_URL
  delete process.env.FORGE_HERMES_URL
  try { assert.match((await request('analyze', { description: 'rover $30', mode: 'live' })).body.error, /unavailable/) }
  finally { if (old) process.env.FORGE_HERMES_URL = old }
})
