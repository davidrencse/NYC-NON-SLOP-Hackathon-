import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyze, hermes } from '../server/consumer-repair.ts'

test('Rover uses catalog facts, not a prose diagnosis or invented solution', () => {
  const start = performance.now()
  const a = analyze({ description: 'My rover has a broken motor under $30, preserve appearance' })
  assert.equal(a.system.name, 'Rover R1')
  assert.equal(a.goals.budget, 30)
  assert.equal(a.status, 'no_solution')
  assert.equal(a.recommendation, null)
  assert.ok(a.candidates.length > 0)
  assert.ok(a.candidates.every(c => !c.eligible && c.evidence.length && c.unresolved.length))
  console.log('deterministic analysis ms', performance.now() - start)
})
test('missing budget, invalid substitution target, unsupported device rejected', () => {
  for (const input of [{ description: 'rover motor' }, { description: 'rover $30', component_id: 'missing' }, { description: 'EMG $30' }, { description: 'rover', budget: -1 }]) assert.throws(() => analyze(input))
})
test('Hermes validates structured advice and rejects fabricated success and timeouts', async (t) => {
  const oldUrl = process.env.FORGE_HERMES_URL
  const oldKey = process.env.FORGE_HERMES_KEY
  process.env.FORGE_HERMES_URL = 'http://localhost:8642'
  process.env.FORGE_HERMES_KEY = 'unit-test-only'
  let advice: unknown = { recommendation: null, explanation: 'Insufficient evidence', missing_info: ['mounting'] }
  const mock = t.mock.method(globalThis, 'fetch', async (url: unknown) => new Response(JSON.stringify(String(url).endsWith('capabilities') ? { platform: 'hermes-agent' } : { id: 'mock-not-live', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(advice) } }] })))
  try {
    const a = analyze({ description: 'rover $30' })
    assert.equal((await hermes(a)).execution_id, 'mock-not-live')
    advice = { recommendation: 'invented', explanation: 'safe', missing_info: [] }
    await assert.rejects(hermes(a), /Invalid Hermes/)
    mock.mock.mockImplementation(async () => { throw new DOMException('timeout', 'TimeoutError') })
    await assert.rejects(hermes(a), /timeout/)
  } finally {
    if (oldUrl === undefined) delete process.env.FORGE_HERMES_URL; else process.env.FORGE_HERMES_URL = oldUrl
    if (oldKey === undefined) delete process.env.FORGE_HERMES_KEY; else process.env.FORGE_HERMES_KEY = oldKey
  }
})
test('strict budget boundary, quantity and explicit false priorities', () => {
  const a = analyze({ description: 'rover preserve appearance under $30', budget: 1.6, preserve_appearance: false })
  const tt = a.candidates.find(c => c.candidate_id === 'tt-motor-148')!
  assert.equal(tt.within_known_budget, false)
  assert.ok(!tt.explanation.priorities.includes('preserve appearance'))
  const inclusive = analyze({ description: 'rover', budget: 1.6, budget_exclusive: false })
  assert.equal(inclusive.candidates.find(c => c.candidate_id === tt.candidate_id)!.within_known_budget, true)
  const multiple = analyze({ description: 'rover', budget: 3, quantity: 2 })
  assert.equal(multiple.candidates.find(c => c.candidate_id === tt.candidate_id)!.cost.known_subtotal, 3.2)
  assert.equal(tt.cost.total, null)
  for (const exclusive of [true, false]) {
    const boundary = analyze({ description: 'rover', budget: 30, quantity: 4, budget_exclusive: exclusive })
    assert.equal(boundary.candidates.find(c => c.candidate_id === 'jga25-370-12v')!.within_known_budget, !exclusive)
  }
})
test('zero budget does not turn missing evidence into success', () => {
  const a = analyze({ description: 'rover motor', budget: 0 })
  assert.ok(a.candidates.every(c => c.within_known_budget === false && !c.eligible))
})


test('prototype intent preserves original ratings, evidence and unresolved gates', () => {
  const a = analyze({ description: 'Rover prototype under $30', component_id: 'm2', decision_kind: 'prototype_change' })
  const legacy = analyze({ description: 'Rover repair under $30', component_id: 'm2' })
  assert.deepEqual(a.system, legacy.system)
  assert.equal(a.status, 'no_solution')
  assert.ok(a.unresolved[0].includes('no failed component'))
  assert.deepEqual(a.unresolved.slice(1), legacy.unresolved.slice(1))
  assert.deepEqual(a.candidates.map(c => c.specs), legacy.candidates.map(c => c.specs))
  assert.ok(a.candidates.every(c => !c.eligible && c.explanation.hypothesis.includes('digital draft')))
  assert.throws(() => analyze({ description: 'Rover under $30', decision_kind: 'physical_approval' }))
})
