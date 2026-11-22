// Real HTTP rehearsal. Advisory is SCRIPTED; engineering checks and revisions are real.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
const base = process.env.FORGE_CONSUMER_URL ?? 'http://127.0.0.1:5173'
const children = []
if (process.argv.includes('--launch')) {
  for (const [command, args, cwd] of [['npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], 'pcb-studio'], ['uv', ['run', '--locked', '--python', '3.12', 'python', '-m', 'forge_research.studio'], '.']]) {
    children.push(spawn(command, args, { cwd, detached: true, stdio: 'ignore' }))
  }
}
const start = performance.now()
async function call(path, body, expected = 200) {
  const response = await fetch(base + '/api/consumer-repair/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const data = await response.json()
  assert.equal(response.status, expected, JSON.stringify(data))
  return data
}
try {
  let ready = false
  for (let i = 0; i < 100; i++) { try { await call('demo'); ready = true; break } catch { await new Promise(r => setTimeout(r, 200)) } }
  assert.ok(ready, 'Vite not ready')
  const flow = performance.now()
  const demo = await call('demo')
  const s = await call('analyze', { ...demo.request, component_id: 'm2', mode: 'rehearsal' })
  assert.equal(s.analysis.status, 'no_solution')
  assert.match(s.agent.explanation, /SCRIPTED/)
  assert.equal(s.analysis.candidates[0].cost.total, null)
  await call(`${s.id}/options`)
  const action = { base_revision: 0, component_id: 'm2', candidate_id: 'jga25-370-12v', intent: 'digital_preview', acknowledge_unverified: true }
  await call(`${s.id}/apply`, { ...action, candidate_id: 'invented' }, 422)
  const draft = await call(`${s.id}/apply`, action)
  assert.equal(draft.revision, 1)
  assert.equal(draft.physical_repair_approved, false)
  assert.equal(draft.analysis.system.devices.find(d => d.id === 'm2').catalogId, 'jga25-370-12v')
  await call(`${s.id}/apply`, action, 409)
  const summary = await call(`${s.id}/summary`)
  assert.equal(summary.agent_revision, 0)
  assert.match(summary.analysis.unresolved.join(), /clearance/)
  const undo = await call(`${s.id}/undo`, { base_revision: 1 })
  assert.equal(undo.revision, 2)
  assert.equal(undo.history.length, 2)
  assert.equal(undo.analysis.system.devices.find(d => d.id === 'm2').catalogId, 'tt-motor-148')
  console.log(JSON.stringify({ mode: 'SCRIPTED_ADVICE_REAL_HTTP_AND_CHECKS', flow_ms: performance.now() - flow, including_startup_ms: performance.now() - start, revision: undo.revision, physical_repair_approved: false }))
} finally { for (const child of children) { try { process.kill(-child.pid, 'SIGTERM') } catch {} } }
