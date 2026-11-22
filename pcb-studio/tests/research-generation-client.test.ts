import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateBoard } from '../src/ai/generate.ts'
import { activateResearch, isBoardGenerationInFlight } from '../src/ai/researchHandoff.ts'

const reference = { researchId: '4e1b2ee3-1596-4a24-9ed2-718fc7088809', bundleSha256: 'a'.repeat(64) }
const board = { name: 'Test', researchHandoff: { envelope: { bundle_sha256: reference.bundleSha256 } } }
const boardEvent = { type: 'board', board }
const done = { type: 'done', ms: 1 }
function response(...events: unknown[]) {
  return new Response(events.map((e) => JSON.stringify(e)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } })
}

test('complete generation retains its captured research reference', async (t) => {
  activateResearch('EMG', reference)
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    assert.deepEqual(JSON.parse(opts.body as string).research, reference)
    return response(boardEvent, done)
  })
  assert.deepEqual(await generateBoard('EMG'), board)
  assert.equal(isBoardGenerationInFlight(), false)
})

test('truncated generation never returns a board even if the board event arrived', async (t) => {
  activateResearch('EMG', reference)
  t.mock.method(globalThis, 'fetch', async () => response(boardEvent))
  await assert.rejects(generateBoard('EMG'), /before generation completed/)
  assert.equal(isBoardGenerationInFlight(), false)
})

test('wrong or missing provenance and premature completion are rejected', async (t) => {
  activateResearch('EMG', reference)
  let payload = response({ type: 'board', board: { name: 'Unrelated' } }, done)
  t.mock.method(globalThis, 'fetch', async () => payload)
  await assert.rejects(generateBoard('EMG'), /does not match/)
  payload = response(done, boardEvent)
  await assert.rejects(generateBoard('EMG'), /without a board/)
  payload = response(boardEvent, done, boardEvent)
  await assert.rejects(generateBoard('EMG'), /event order/)
})

test('malformed or failed streams cancel their reader and release the generation lock', async (t) => {
  activateResearch('EMG', reference)
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{invalid json}\n')) },
    cancel() { cancelled = true },
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(stream))
  await assert.rejects(generateBoard('EMG'), /Invalid generation response/)
  assert.equal(cancelled, true)
  assert.equal(isBoardGenerationInFlight(), false)
})

test('overlapping generation is rejected and a superseded result cannot complete', async (t) => {
  activateResearch('EMG', reference)
  let respond!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { respond = resolve }))
  const pending = generateBoard('EMG')
  assert.equal(isBoardGenerationInFlight(), true)
  await assert.rejects(generateBoard('Different board'), /Finish the current/)
  activateResearch('New research', { ...reference, bundleSha256: 'b'.repeat(64) })
  respond(response(boardEvent, done))
  await assert.rejects(pending, /Discarded the older result/)
  assert.equal(isBoardGenerationInFlight(), false)
})

test('editing the brief creates an independent board with no inherited provenance', async (t) => {
  activateResearch('EMG', reference)
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    assert.equal(JSON.parse(opts.body as string).research, undefined)
    return response({ type: 'board', board: { name: 'Independent' } }, done)
  })
  assert.deepEqual(await generateBoard('Other design'), { name: 'Independent' })
})
