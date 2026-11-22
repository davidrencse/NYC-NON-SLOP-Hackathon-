// Agent swarm strip on the research screen. Every value comes from
// {"type": "swarm"} stream events: start -> agent (running/progress/completed)
// -> synthesis -> complete. Advisory: it never decides what gets accepted.
const $ = id => document.getElementById(id);

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

const STATE_LABEL = { pending: "queued", running: "running", completed: "done", failed: "failed", skipped: "skipped" };
let swarm = null;
let timer = 0;

function fresh() {
  return { engine: null, model: null, status: "pending", startedAt: 0, endedAt: 0, agents: [], synthesis: { status: "pending", text: "" }, note: null, error: null };
}

function secs(ms) {
  return (Math.max(0, ms) / 1000).toFixed(1) + " s";
}

function tokens(agent) {
  const total = (agent.input_tokens ?? 0) + (agent.output_tokens ?? 0);
  return total ? total.toLocaleString("en-US") + " tok" : null;
}

function agentCard(agent, index) {
  const card = h("li", "sw-agent");
  card.dataset.status = agent.status;
  const head = h("div", "sw-agent-head");
  head.append(h("span", "sw-idx", "a" + (index + 1)), h("span", "sw-name", agent.name), h("span", "sw-state", STATE_LABEL[agent.status] ?? agent.status));
  const meter = h("div", "sw-meter");
  meter.setAttribute("aria-hidden", "true");
  meter.append(h("i"));
  const body = h("p", "sw-text", agent.summary || agent.text || (agent.status === "pending" ? "Waiting for dispatch." : agent.status === "running" ? "Working…" : "No brief returned."));
  const facts = [agent.duration_s != null ? agent.duration_s.toFixed(1) + " s" : null, tokens(agent), agent.api_calls ? agent.api_calls + " call" + (agent.api_calls === 1 ? "" : "s") : null].filter(Boolean);
  const foot = h("p", "sw-facts", facts.join(" · ") || (agent.status === "running" ? "live" : "—"));
  card.append(head, meter, body, foot);
  card.title = agent.summary || "";
  return card;
}

function render() {
  const root = $("rg-swarm");
  if (!root || !swarm) return;
  root.hidden = false;
  root.dataset.status = swarm.status;
  const done = swarm.agents.filter(a => ["completed", "failed", "skipped"].includes(a.status)).length;
  const running = swarm.agents.filter(a => a.status === "running").length;
  $("sw-engine").textContent = swarm.engine === "claude" ? "Claude API" : swarm.engine === "gemini" ? "Gemini API" : swarm.engine === "offline" ? "offline replay" : "—";
  $("sw-model").textContent = swarm.model ?? (swarm.engine === "offline" ? "no model" : "—");
  $("sw-progress").textContent = `${done}/${swarm.agents.length || 4}`;
  $("sw-running").textContent = String(running);
  const end = swarm.endedAt || performance.now();
  $("sw-clock").textContent = swarm.startedAt ? secs(end - swarm.startedAt) : "0.0 s";
  const total = swarm.agents.reduce((sum, a) => sum + (a.input_tokens ?? 0) + (a.output_tokens ?? 0), 0);
  $("sw-tokens").textContent = total ? total.toLocaleString("en-US") : "—";
  $("sw-agents").replaceChildren(...swarm.agents.map(agentCard));
  const lead = $("sw-lead");
  lead.dataset.status = swarm.synthesis.status;
  $("sw-lead-state").textContent = STATE_LABEL[swarm.synthesis.status] ?? swarm.synthesis.status;
  $("sw-lead-text").textContent = swarm.error
    ? swarm.error
    : swarm.synthesis.text || (swarm.synthesis.status === "running" ? "Lead engineer is merging the specialist briefs…" : "Waits for every specialist brief.");
  $("sw-note").textContent = swarm.note || "Advisory. Catalog checks and Lean verification decide what is accepted.";
}

function clock() {
  const end = swarm?.endedAt || performance.now();
  if ($("sw-clock") && swarm?.startedAt) $("sw-clock").textContent = secs(end - swarm.startedAt);
  if (!swarm || swarm.status !== "running") clearInterval(timer);
}

function tick() {
  clearInterval(timer);
  timer = setInterval(clock, 100);
}

export function resetSwarm(mode) {
  clearInterval(timer);
  swarm = fresh();
  swarm.engine = mode === "sample" ? "offline" : null;
  const root = $("rg-swarm");
  if (root) root.hidden = false;
  render();
}

// Returns a log line [name, message] for the run log, or null.
export function applySwarmEvent(event) {
  if (!swarm) swarm = fresh();
  if (event.event === "start") {
    Object.assign(swarm, { engine: event.engine, model: event.model, status: "running", startedAt: performance.now(), note: event.note ?? null, error: null });
    swarm.agents = (event.agents ?? []).map(a => ({ role: a.id, name: a.name, focus: a.focus, status: "pending" }));
    tick();
    return ["swarm", `${event.engine === "claude" ? "Claude" : event.engine === "gemini" ? "Gemini" : "Offline"} swarm dispatched ${swarm.agents.length} specialists${event.model ? " on " + event.model : ""}.`];
  }
  if (event.event === "agent") {
    const agent = swarm.agents[event.index];
    if (!agent) return null;
    const was = agent.status;
    if (event.result) Object.assign(agent, event.result);
    agent.status = event.status;
    if (event.text) agent.text = event.text;
    render();
    if (was !== agent.status && agent.status === "running") return [agent.role, "started"];
    if (was !== agent.status && agent.status === "completed") return [agent.role, `brief ready${agent.duration_s != null ? " in " + agent.duration_s.toFixed(1) + " s" : ""}`];
    if (was !== agent.status && agent.status === "failed") return [agent.role, agent.summary || "failed"];
    return null;
  }
  if (event.event === "synthesis") {
    swarm.synthesis.status = event.status;
    if (event.text) swarm.synthesis.text = event.text;
    render();
    return ["lead", event.status === "running" ? "merging specialist briefs" : "design direction ready"];
  }
  if (event.event === "complete") {
    const r = event.report ?? {};
    swarm.status = r.status ?? "completed";
    swarm.endedAt = performance.now();
    swarm.error = r.error ?? null;
    if (Array.isArray(r.agents) && r.agents.length) swarm.agents = r.agents.map((a, i) => ({ ...swarm.agents[i], ...a }));
    if (r.synthesis) swarm.synthesis = { status: "completed", text: r.synthesis };
    else if (swarm.synthesis.status !== "completed") swarm.synthesis.status = r.status === "failed" ? "failed" : "skipped";
    render();
    return ["swarm", r.status === "completed" ? `swarm finished in ${(r.duration_s ?? 0).toFixed(1)} s` : "swarm failed · " + (r.error ?? "no detail")];
  }
  return null;
}

export function finishSwarm(outcome) {
  if (!swarm || swarm.status !== "running") return;
  swarm.status = outcome === "stopped" ? "skipped" : "failed";
  swarm.endedAt = performance.now();
  for (const agent of swarm.agents) if (agent.status === "running" || agent.status === "pending") agent.status = "skipped";
  if (swarm.synthesis.status !== "completed") swarm.synthesis.status = "skipped";
  render();
}
