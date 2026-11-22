const $ = id => document.getElementById(id);
const brief = 'Prototype Rover R1: compare one motor change under $30. Preserve placement; explain voltage, cost and mounting tradeoffs.';
let session = null, busy = false, selected = '', poll;
const controls = $('decision-controls'), result = $('decision-result');
controls.innerHTML = `<p>${brief}</p><label>Motor <select id="motor"><option value="">Select explicitly</option>${['m1','m2','m3','m4'].map(id => `<option>${id}</option>`).join('')}</select></label> <button id="compare">Load original brief and compare</button> <button id="undo" disabled>Undo draft</button><details><summary>Advanced advisory settings</summary><label>Mode <select id="advice"><option value="deterministic">Catalog checks only</option><option value="rehearsal">SCRIPTED rehearsal</option><option value="live">Live Hermes (requires operator setup)</option></select></label><p>Live setup: scripts/consumer-start.py. Advice is not source evidence. Ordinary edits do not wait for inference.</p></details>`;
const motor = $('motor');
function syncScene() { $('prototype').contentWindow.postMessage({ type: 'forge-session', id: session.id }, location.origin); }
window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.source !== $('prototype').contentWindow) return;
  if (e.data?.type === 'forge-renderer-state' && e.data.id === session?.id) {
    $('renderer-state').textContent = e.data.error ? `Renderer failed: ${e.data.error}` : `Renderer loaded digital revision ${e.data.revision}. Not physical approval.`;
    return;
  }
  if (e.data?.type !== 'forge-selection') return;
  if (['m1','m2','m3','m4'].includes(e.data.device)) { motor.value = selected = e.data.device; render(); }
});
motor.onchange = () => { selected = motor.value; render(); };
async function request(path, body) {
  const response = await fetch(`/api/consumer-repair${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
async function act(path, body, scene = true) {
  if (busy) return;
  busy = true; clearTimeout(poll); render();
  try { session = await request(path, body); if (scene) syncScene(); }
  catch (error) { busy = false; render(); text(result, String(error)); schedule(); return; }
  busy = false; render(); schedule();
}
function schedule() {
  if (!session || !['queued','running'].includes(session.agent_state)) return;
  const id = session.id;
  poll = setTimeout(async () => {
    try { const next = await request(`/${id}/summary`); if (session.id === id && !busy) { session = next; renderAdvice(); schedule(); } }
    catch (error) { result.textContent = String(error); }
  }, 500);
}
function text(parent, value) { const p = document.createElement('p'); p.textContent = value; parent.append(p); }
function render() {
  $('compare').disabled = busy || !selected;
  $('undo').disabled = busy || !session?.undo_stack.length;
  if (!session) return;
  result.replaceChildren();
  text(result, `Revision ${session.revision} · unverified digital draft · No physical solution approved.`);
  text(result, `Original: ${session.original.devices.find(d => d.id === session.analysis.component_id).catalogId}. Target: ${session.analysis.component_id}.`);
  if (selected !== session.analysis.component_id) text(result, 'Selection changed. Load a new original comparison before applying.');
  const label = document.createElement('label'), ack = document.createElement('input'); ack.type = 'checkbox'; label.append(ack, ' I acknowledge this is an unverified digital preview only.'); result.append(label);
  for (const c of session.analysis.candidates) {
    const details = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = `${c.changes} · $${c.cost.unit ?? 'unknown'}/unit · ${c.compatibility}`; details.append(summary);
    text(details, `Deterministic: catalog voltage range only, not full electrical/mechanical validation. ${c.explanation.reasons.join('; ')}. ${c.explanation.rejected.join('; ')}`);
    text(details, `Known subtotal $${c.cost.known_subtotal ?? 'unknown'}; total unknown (shipping, tax, labor). Catalog price, not live quote. Budget check is subtotal only.`);
    text(details, `Tradeoff: ${c.explanation.alternative_preferable}. ${c.appearance}.`);
    text(details, `Source-backed catalog specs: ${c.specs.voltage.min}–${c.specs.voltage.max} V. Sources: ${c.evidence.map(e => `${e.source} (${e.component_id})`).join(', ')}. Curated generic catalog, not manufacturer-validated facts.`);
    text(details, 'Unknown: mounting, shaft, stall current, driver/PWM compatibility and delivered cost. You may reject every option.');
    const apply = document.createElement('button'); apply.textContent = 'Apply digital draft'; apply.disabled = true;
    ack.addEventListener('change', () => { apply.disabled = busy || !ack.checked || selected !== session.analysis.component_id; });
    apply.onclick = () => act(`/${session.id}/apply`, { base_revision: session.revision, component_id: selected, candidate_id: c.candidate_id, intent: 'digital_preview', acknowledge_unverified: ack.checked });
    details.append(apply); result.append(details);
  }
  const warnings = document.createElement('details'); const title = document.createElement('summary'); title.textContent = 'Warnings and revision record'; warnings.append(title);
  session.analysis.unresolved.forEach(w => text(warnings, w)); session.history.forEach(h => text(warnings, `Revision ${h.revision}: ${h.action}`)); result.append(warnings);
  const advice = document.createElement('div'); advice.id = 'agent-status'; result.append(advice); renderAdvice();
}
function renderAdvice() {
  const advice = $('agent-status');
  if (!advice) return;
  advice.replaceChildren();
  text(advice, `Hermes state: ${session.agent_state}; advice revision: ${session.agent_revision ?? 'none'}.`);
  if (session.agent_error) text(advice, session.agent_error);
  if (session.agent) text(advice, session.agent_revision === session.revision ? `Advisory, not evidence (${session.agent.evidence_kind}): ${session.agent.explanation}` : 'Stale advice withheld after edit.');
}
$('compare').onclick = () => act('/analyze', { description: brief, budget: 30, component_id: selected, mode: $('advice').value, decision_kind: 'prototype_change' });
$('undo').onclick = () => act(`/${session.id}/undo`, { base_revision: session.revision });
$('engineering-view').addEventListener('click', () => $('decision').scrollIntoView({ behavior: 'smooth' }));
$('prototype').addEventListener('load', () => { if (session) syncScene(); });
render();
