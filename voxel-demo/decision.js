const $ = id => document.getElementById(id);
let session = null, busy = false, selected = '', poll, dirty = false;
const controls = $('decision-controls'), result = $('decision-result');
controls.innerHTML = `<label>Describe the rover problem or prototype change<textarea id="problem" maxlength="4000" rows="2"></textarea></label><label>Intent <select id="intent"><option value="repair_change">Investigate a rover repair</option><option value="prototype_change">Explore a prototype change</option></select></label><label>Known-parts budget (USD) <input id="budget" type="number" min="0" value="30"></label><fieldset><legend>What are you trying to preserve?</legend>${[['original_appearance','Original appearance'],['affordability','Affordability'],['performance','Performance'],['sentimental_value','Sentimental value']].map(([id,label]) => `<label><input type="checkbox" name="priority" value="${id}">${label}</label>`).join('')}</fieldset><p>Explore options → Preview change in 3D → Understand the decision → Get an investigation / repair plan. No installation approval.</p><label>Motor <select id="motor"><option value="">Select explicitly</option>${['m1','m2','m3','m4'].map(id => `<option>${id}</option>`).join('')}</select></label> <button id="compare">Load original brief and compare</button> <button id="undo" disabled>Undo draft</button><details><summary>Advanced advisory settings</summary><label>Mode <select id="advice"><option value="deterministic">Catalog checks only</option><option value="rehearsal">SCRIPTED rehearsal</option><option value="live">Live Hermes (requires operator setup)</option></select></label><p>Live setup: scripts/consumer-start.py. Advice is not source evidence. Ordinary edits do not wait for inference.</p></details>`;
$('problem').value = 'Rover R1 motor is not turning. Investigate a repair under $30 without assuming the motor has failed.';
const motor = $('motor');
for (const input of controls.querySelectorAll('input, textarea, select')) input.addEventListener('input', () => { dirty = true; render(); });
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
  try { session = await request(path, body); if (path === '/analyze') dirty = false; if (scene) syncScene(); }
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
  if (dirty) text(result, 'Inputs changed. Compare again before previewing or exporting a new decision.');
  text(result, 'NO physical recommendation: original TT/N20 nominal voltage mismatch; JGA25 mounting, shaft, driver and stall-current evidence is insufficient. Budget total is unknown.');
  text(result, `Investigation priorities: ${session.analysis.priorities.join(', ') || 'none specified'}. Option order is for investigation only, never physical approval.`);
  text(result, `Revision ${session.revision} · unverified digital draft · No physical solution approved.`);
  text(result, `Original: ${session.original.devices.find(d => d.id === session.analysis.component_id).catalogId}. Target: ${session.analysis.component_id}.`);
  if (selected !== session.analysis.component_id) text(result, 'Selection changed. Load a new original comparison before applying.');
  const label = document.createElement('label'), ack = document.createElement('input'); ack.type = 'checkbox'; label.append(ack, ' I acknowledge this is an unverified digital preview only.'); result.append(label);
  for (const c of session.analysis.candidates) {
    const details = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = `${c.changes} · $${c.cost.unit ?? 'unknown'}/unit · ${c.compatibility}`; details.append(summary);
    text(details, `Deterministic: catalog voltage range only, not full electrical/mechanical validation. ${c.explanation.reasons.join('; ')}. ${c.explanation.rejected.join('; ')}`);
    text(details, `Known subtotal $${c.cost.known_subtotal ?? 'unknown'}; total unknown (shipping, tax, labor). Catalog price, not live quote. Budget check is subtotal only.`);
    c.preference_notes.forEach(note => text(details, note));
    text(details, `Physical option: REJECTED / NOT APPROVED. Known-subtotal budget: ${c.within_known_budget === true ? 'within (not delivered total)' : 'over budget or unknown'}.`);
    text(details, `Tradeoff: ${c.explanation.alternative_preferable}. ${c.appearance}.`);
    text(details, `Source-backed catalog specs: ${c.specs.voltage.min}–${c.specs.voltage.max} V. Sources: ${c.evidence.map(e => `${e.source} (${e.component_id})`).join(', ')}. Curated generic catalog, not manufacturer-validated facts.`);
    text(details, 'Unknown: mounting, shaft, stall current, driver/PWM compatibility and delivered cost. You may reject every option.');
    const apply = document.createElement('button'); apply.textContent = 'Apply digital draft'; apply.disabled = true;
    ack.addEventListener('change', () => { apply.disabled = busy || dirty || !ack.checked || selected !== session.analysis.component_id; });
    apply.onclick = () => act(`/${session.id}/apply`, { base_revision: session.revision, component_id: selected, candidate_id: c.candidate_id, intent: 'digital_preview', acknowledge_unverified: ack.checked });
    details.append(apply); result.append(details);
  }
  const warnings = document.createElement('details'); const title = document.createElement('summary'); title.textContent = 'Warnings and revision record'; warnings.append(title);
  session.analysis.unresolved.forEach(w => text(warnings, w)); session.history.forEach(h => text(warnings, `Revision ${h.revision}: ${h.action}`)); result.append(warnings);
  text(result, 'Why this draft choice: ' + session.analysis.system.devices.find(d => d.id === session.analysis.component_id).catalogId + '. Selected by you for digital investigation, not recommended for installation. Alternatives and rejections above remain inspectable.');
  session.analysis.next_steps.forEach(step => text(result, step));
  const plan = document.createElement('button'); plan.textContent = 'Download current repair / investigation plan'; plan.disabled = busy || dirty || selected !== session.analysis.component_id; plan.onclick = downloadPlan; result.append(plan);
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
async function downloadPlan() {
  const current = session;
  try {
    const plan = await request(`/${current.id}/plan`, { base_revision: current.revision });
    if (session.id !== current.id || session.revision !== current.revision || plan.revision !== current.revision) throw new Error('Revision changed; export again.');
    const url = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `forge-rover-plan-rev-${plan.revision}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { text(result, String(error)); }
}
$('compare').onclick = () => act('/analyze', { description: $('problem').value, budget: $('budget').value === '' ? null : Number($('budget').value), component_id: selected, mode: $('advice').value, decision_kind: $('intent').value, priorities: [...controls.querySelectorAll('[name="priority"]:checked')].map(input => input.value) });
$('undo').onclick = () => act(`/${session.id}/undo`, { base_revision: session.revision });
$('engineering-view').addEventListener('click', () => $('decision').scrollIntoView({ behavior: 'smooth' }));
const inspect = document.createElement('button'); inspect.textContent = 'Inspect rover'; inspect.onclick = () => $('decision').scrollIntoView({ behavior: 'smooth' }); document.querySelector('.scene-nav')?.append(inspect);
$('prototype').addEventListener('load', () => { if (session) syncScene(); });
render();
