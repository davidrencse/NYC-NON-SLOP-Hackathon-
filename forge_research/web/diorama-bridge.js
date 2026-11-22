// "Cute mode": a toggle in the research bar that swaps the graph for the 3D
// diorama (labs → path → factory). The diorama is a same-origin iframe; this
// module only forwards the research events the page already receives. It makes
// no requests of its own.

const SRC = "/static/diorama/index.html";
const MAX_BUFFER = 400;
const buffer = [];
let frame = null;
let open = false;
// The studio handoff stays locked until the crew has played the whole story
// through (plus a short beat), so every run shows the full animation.
const HOLD_AFTER_STORY_MS = 5000;
const FALLBACK_MS = 75000; // if the diorama never reports (e.g. WebGL unavailable)
let gate = { locked: false, finished: false, timer: 0, fallback: 0 };

function post(message) {
  frame?.contentWindow?.postMessage({ source: "forge-research", ...message }, location.origin);
}

function remember(message) {
  buffer.push(message);
  if (buffer.length > MAX_BUFFER) buffer.splice(1, buffer.length - MAX_BUFFER); // keep the "start" message
  if (open) post(message);
}

// Trim payloads to what the diorama shows; the full report stays in the page.
function compact(event) {
  if (event.type === "report") return null;
  if (event.type === "catalog_lookup") return { type: event.type, role: event.role, parts: (event.parts ?? []).map(p => ({ id: p.id, name: p.name ?? p.title ?? p.id })) };
  if (event.type === "source_audit") {
    return {
      type: event.type, event: event.event, round: event.round, detail: event.detail,
      title: event.source?.document?.title, decision: event.source?.decision,
      accepted: event.audit?.sources?.filter(s => s.decision === "accepted").length,
      total: event.audit?.sources?.length
    };
  }
  if (event.type === "swarm") return { type: event.type, event: event.event, index: event.index, agents: event.agents?.length, detail: event.detail ?? event.message ?? event.summary };
  if (event.type === "verification") return { type: event.type, status: event.status, detail: event.detail, verified: event.data?.verified_count };
  return { type: event.type, stage: event.stage, status: event.status, detail: event.detail, provider: event.provider, event: event.event, mode: event.mode, message: event.message };
}

function setLocked(locked) {
  gate.locked = locked;
  document.body.classList.toggle("forge-handoff-locked", locked);
  renderHandoff();
}

function unlockSoon(delay) {
  clearTimeout(gate.timer);
  gate.timer = setTimeout(() => { clearTimeout(gate.fallback); setLocked(false); }, delay);
}

function renderHandoff() {
  const box = document.getElementById("rg-cute-handoff");
  if (!box) return;
  const ready = gate.finished && !gate.locked && gate.outcome === "completed";
  box.hidden = !(gate.finished && gate.outcome === "completed");
  box.querySelector("button").hidden = !ready;
  box.querySelector("span").textContent = ready ? "The crew is done. Take it to the bench." : "Crew is wrapping up the build…";
}

function goToStudio() {
  const target = ["engineer-pcb-btn", "btn-engineer-pcb", "open-workbench-btn"]
    .map(id => document.getElementById(id))
    .find(button => button && !button.hidden && !button.disabled);
  target?.click();
}

addEventListener("message", event => {
  if (event.origin !== location.origin || event.data?.source !== "forge-diorama") return;
  if (event.data.type === "story-complete" && gate.locked && gate.finished) unlockSoon(HOLD_AFTER_STORY_MS);
});

export function dioramaStart(mode, brief) {
  buffer.length = 0;
  clearTimeout(gate.timer); clearTimeout(gate.fallback);
  gate = { locked: false, finished: false, timer: 0, fallback: 0, outcome: null };
  setLocked(true);
  if (!open) setOpen(true);
  remember({ type: "start", mode, brief });
}

export function dioramaEvent(event) {
  try {
    const message = compact(event);
    if (message) remember(message);
  } catch { /* the diorama is decorative; never break the research view */ }
}

export function dioramaFinish(outcome, message, report) {
  gate.finished = true;
  gate.outcome = outcome;
  if (outcome === "completed") {
    clearTimeout(gate.fallback);
    gate.fallback = setTimeout(() => setLocked(false), FALLBACK_MS);
    renderHandoff();
  } else {
    setLocked(false); // nothing to hand off; never hold a failed run hostage
  }
  const parts = report?.review?.selected_parts ?? report?.proposal?.parts ?? [];
  remember({
    type: "finish", outcome, message,
    parts: Array.isArray(parts) ? parts.slice(0, 6).map(p => (typeof p === "string" ? p : p?.name ?? p?.id)).filter(Boolean) : [],
    evidence: report?.evidence?.length ?? 0
  });
}

function setOpen(next) {
  const view = document.getElementById("research-view");
  const button = document.getElementById("rg-cute-toggle");
  if (!view || !button) return;
  open = next;
  view.classList.toggle("rg-cute", open);
  button.setAttribute("aria-pressed", String(open));
  button.textContent = open ? "Graph view" : "Cute mode";
  if (open && !frame) {
    const wrap = document.createElement("div");
    wrap.className = "rg-diorama";
    frame = document.createElement("iframe");
    frame.title = "Research crew diorama";
    frame.src = SRC;
    frame.addEventListener("load", () => post({ type: "replay", events: buffer }));
    const handoff = document.createElement("div");
    handoff.id = "rg-cute-handoff";
    handoff.className = "rg-cute-handoff";
    handoff.hidden = true;
    handoff.innerHTML = '<span></span><button type="button" hidden>Open PCB engineering studio →</button>';
    handoff.querySelector("button").addEventListener("click", goToStudio);
    wrap.append(frame, handoff);
    view.append(wrap);
  }
  if (frame) frame.parentElement.hidden = !open;
  if (open) post({ type: "replay", events: buffer });
  renderHandoff();
  try { localStorage.setItem("forge:cute-mode", open ? "1" : "0"); } catch { /* storage unavailable */ }
}

function init() {
  const bar = document.querySelector("#research-view .rg-bar");
  if (!bar || document.getElementById("rg-cute-toggle")) return;
  const button = document.createElement("button");
  button.id = "rg-cute-toggle";
  button.type = "button";
  button.className = "rg-cute-btn";
  button.textContent = "Cute mode";
  button.setAttribute("aria-pressed", "false");
  button.title = "Watch the research crew work in a 3D lab and factory";
  button.addEventListener("click", () => setOpen(!open));
  const mode = document.getElementById("map-mode");
  mode ? mode.after(button) : bar.append(button);
  let saved = false;
  try { saved = localStorage.getItem("forge:cute-mode") === "1"; } catch { /* storage unavailable */ }
  if (saved) setOpen(true);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
