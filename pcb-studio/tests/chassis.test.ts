import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { chassisHandler, cleanParts } from '../server/chassis.ts'
import { hasBuiltInBody } from '../src/data/bodyPolicy.ts'
import { CONCEPT_LABELS } from '../src/data/concepts.ts'

const customBrief = 'Build an automated origami folding rig with articulated paper guides'
const validPart = { shape: 'box', mat: 'metal', size: [120, 4, 160], pos: [0, -2, 0] }

function claudeReply(text: string) {
  return new Response(JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function request(prompt: string, key = 'sk-ant-test-key-for-unit-tests-only', handler = chassisHandler(() => ({ ANTHROPIC_API_KEY: key }), () => {}), layout = '') {
  const req = Readable.from([Buffer.from(JSON.stringify({ prompt, layout }))]) as IncomingMessage
  req.method = 'POST'
  req.headers = {}
  let result: Record<string, unknown> = {}
  const res = {
    setHeader() {},
    end(body: string) { result = JSON.parse(body) },
  } as unknown as ServerResponse
  await handler(req, res)
  return { status: res.statusCode, body: result }
}

test('all bundled models and procedural families bypass generation', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Built-ins must never call Claude') })
  for (const brief of [...CONCEPT_LABELS, 'EMG wristband', '4WD rover', 'hexacopter', 'smart glasses', 'coffee machine', 'desk lamp', '3D printer']) {
    assert.equal(hasBuiltInBody(brief), true, brief)
    assert.deepEqual(await request(brief), { status: 200, body: { parts: [], reason: 'built-in' } }, brief)
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('an unmatched brief uses Claude and returns validated custom geometry', async (t) => {
  assert.equal(hasBuiltInBody(customBrief), false)
  const fetch = t.mock.method(globalThis, 'fetch', async () => claudeReply(JSON.stringify({ parts: [validPart] })))
  const result = await request(customBrief)
  assert.equal(result.status, 200)
  assert.equal((result.body.parts as unknown[]).length, 1)
  assert.equal(fetch.mock.callCount(), 1)
})

test('invalid solids are discarded before reaching the renderer', () => {
  assert.equal(cleanParts({ parts: [null, {}, validPart,
    { ...validPart, size: [20, -3, 4] },
    { ...validPart, size: [20, 3, 0] },
    { ...validPart, shape: 'ring', size: [10, 20, 0] },
    { ...validPart, pos: [NaN, 0, 0] },
  ] }).length, 1)
})

test('unusable answers report an explicit fallback', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => claudeReply('{"parts":[]}'))
  assert.equal((await request(customBrief)).body.reason, 'invalid-geometry')
})

const key = 'sk-ant-test-key-for-unit-tests-only'
const answer = () => claudeReply(JSON.stringify({ parts: [validPart] }))

test('repeated designs and simultaneous requests need only one inference call', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fetch = t.mock.method(globalThis, 'fetch', async () => { await gate; return answer() })
  const handler = chassisHandler(() => ({ ANTHROPIC_API_KEY: key }), () => {})
  const first = request(customBrief, key, handler)
  const second = request(customBrief, key, handler)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetch.mock.callCount(), 1)
  release()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.deepEqual(await request(customBrief, key, handler), a)
  assert.equal(fetch.mock.callCount(), 1)
  await request(customBrief, key, handler, 'moved sensor to x=40')
  assert.equal(fetch.mock.callCount(), 2, 'changed layouts must generate fresh geometry')
})

test('custom bodies use the fast model and fail promptly without retries', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    assert.ok(options.signal)
    return new Response('{}', { status: 503 })
  })
  const handler = chassisHandler(() => ({ ANTHROPIC_API_KEY: key, FORGE_CLAUDE_CHASSIS_MODEL: 'fast-test-model' }), () => {})
  const result = await request(customBrief, key, handler)
  assert.equal((result.body.parts as unknown[]).length, 0)
  assert.equal(fetch.mock.callCount(), 1)
  assert.match(String((fetch.mock.calls[0].arguments[1] as RequestInit).body), /fast-test-model/)
  await request(customBrief, key, handler)
  assert.equal(fetch.mock.callCount(), 2, 'failures are not cached')
})
