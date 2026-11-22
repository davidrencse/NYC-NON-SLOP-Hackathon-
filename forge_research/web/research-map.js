// Research graph: the streamed research run drawn as a node graph.
// Input nodes feed a bus; the bus feeds every stage node; the run log, worker
// dispatch and the human gate sit underneath. All values come from the stream.
// Wires, packets and cube lattices render in WebGL (research-gl.js).
import { createGraphGL } from "./research-gl.js";
import { applySwarmEvent, finishSwarm, resetSwarm } from "./swarm-panel.js";
import { applyDeckEvent, finishDeck, resetDeck } from "./pipeline-deck.js";
import { dioramaEvent, dioramaFinish, dioramaStart } from "./diorama-bridge.js";

const $ = id => document.getElementById(id);
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = cents => (Number.isFinite(cents) ? money.format(cents / 100) : "—");
const DASH = "—";

const STAGES = {
  requirements: { name: "requirements.parse", label: "Requirements", worker: 1, copy: "Extract the design constraints from the brief." },
  sourcing: { name: "sourcing.plan", label: "Part sourcing", worker: 2, copy: "Pick a controller and a sensor from the catalog." },
  controller: { name: "catalog.mcu", label: "Controllers", worker: 2, copy: "Controller candidates from the catalog." },
  sensor: { name: "catalog.emg", label: "EMG sensors", worker: 2, copy: "Sensor candidates from the catalog." },
  compatibility: { name: "compat.gate", label: "Compatibility", worker: 3, copy: "Check that the parts work together and fit the budget." },
  reviewer: { name: "design.review", label: "Design review", worker: 3, copy: "Surface open questions and next steps." },
  evidence: { name: "datasheet.verify", label: "Datasheet verification", worker: 3, copy: "Compare independent Reducto and Gemini PDF reads before building." },
  hold: { name: "build.hold", label: "Build hold", worker: 3, copy: "Keep the report when the build cannot proceed." },
  geometry: { name: "geometry.build", label: "Geometry", worker: 4, copy: "Assemble the enclosure and parts." },
  verification: { name: "lean.verify", label: "Lean 4 proofs", worker: 4, copy: "Prove the electrical and budget obligations." },
  export: { name: "glb.export", label: "Model export", worker: 4, copy: "Write the GLB for the 3D viewer." },
};
const GATE = { name: "your_call", label: "Human gate", copy: "Nothing is built or bought until you choose." };
const INPUTS = {
  brief: { name: "brief", copy: "The design brief as submitted." },
  constraints: { name: "constraints", copy: "Constraints extracted by the requirements agent." },
  catalog: { name: "catalog", copy: "Catalog entries returned to the sourcing agent." },
  budget: { name: "budget", copy: "Budget cap against the priced parts." },
};
// Grid placement: columns follow the flow left to right.
const LAYOUT = {
  requirements: [1, 1], sourcing: [1, 2], controller: [1, 3], sensor: [1, 4],
  compatibility: [2, 1], reviewer: [2, 2], evidence: [2, 3], hold: [2, 4],
  geometry: [3, 1], verification: [3, 2], export: [3, 3], gate: [3, 4],
};
const FLOW = [
  ["requirements", "sourcing"], ["sourcing", "controller"], ["sourcing", "sensor"],
  ["sourcing", "compatibility"], ["compatibility", "reviewer"], ["compatibility", "hold"],
  ["reviewer", "evidence"], ["evidence", "geometry"], ["evidence", "hold"], ["geometry", "verification"], ["geometry", "export"],
  ["export", "gate"], ["verification", "gate"],
];
const FEEDS = { requirements: ["brief", "constraints"], sourcing: ["catalog"], controller: ["catalog"], sensor: ["catalog"], compatibility: ["budget", "constraints"], verification: ["budget"] };
const WORKERS = [
  { id: "w1", name: "brief.agent", stages: ["requirements"] },
  { id: "w2", name: "sourcing.agent", stages: ["sourcing", "controller", "sensor"] },
  { id: "w3", name: "review.agent", stages: ["compatibility", "reviewer", "evidence", "hold"] },
  { id: "w4", name: "build.kernel", stages: ["geometry", "verification", "export"] },
];
const STATE_LABEL = { pending: "queued", running: "run", completed: "done", skipped: "skip", failed: "fail", stopped: "stop", gate: "await" };
const LOG_LABEL = { pending: "Queued", running: "Running", completed: "Complete", skipped: "Not run", failed: "Failed", stopped: "Stopped" };
const OUTCOMES = { candidate: "Candidate accepted", blocked: "Curated parts need review", unsupported: "No curated parts, PCB studio picks them" };
const TRANSPORT = { ble: "BLE", wifi: "Wi-Fi", wired: "Wired", wireless: "Wireless" };
const BARS = 20;

const canvas = $("rg-canvas");
const detail = $("map-detail");
const follow = $("map-follow");
const log = $("map-log");
const nodes = new Map();
const state = new Map();
const activity = new Map(Object.keys(INPUTS).map(id => [id, []]));
let report = null;
let mode = "live";
let brief = "";
let selected = null;
let current = null;
let followLive = true;
let runState = "idle";
let startedAt = 0;
let endedAt = 0;
let events = 0;
let clock = 0;

function h(tag, className, contents) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (contents != null) el.textContent = contents;
  return el;
}

function makeNode(id, def, kind) {
  const el = h("button", "rg-node");
  el.type = "button";
  el.dataset.node = id;
  el.dataset.kind = kind;
  el.dataset.status = "pending";
  el.setAttribute("aria-pressed", "false");
  const head = h("span", "rg-node-head");
  const status = h("span", "rg-node-state", kind === "input" ? "" : STATE_LABEL.pending);
  head.append(h("span", "rg-node-name", def.name), status);
  const rows = h("span", "rg-rows");
  el.append(head, rows);
  const node = { el, status, rows, kind };
  if (kind === "input") {
    node.bars = h("span", "rg-bars");
    for (let i = 0; i < BARS; i++) node.bars.append(h("i"));
    el.append(node.bars);
  } else {
    const viz = h("span", "rg-viz");
    node.viz = h("span", "rg-viz-gl");
    node.caption = h("span", "rg-viz-cap");
    viz.append(node.viz, node.caption);
    el.append(viz);
    node.tag = h("span", "rg-tag", "000");
    $("rg-tags").append(node.tag);
  }
  el.addEventListener("click", () => {
    setFollow(false);
    select(id);
  });
  nodes.set(id, node);
  return el;
}

for (const [id, def] of Object.entries(INPUTS)) $("rg-inputs").append(makeNode(id, def, "input"));
for (const [id, def] of [...Object.entries(STAGES), ["gate", GATE]]) {
  const el = makeNode(id, def, id === "gate" ? "gate" : "stage");
  const [column, row] = LAYOUT[id];
  el.style.gridColumn = column;
  el.style.gridRow = row;
  el.dataset.row = row;
  $("rg-grid").append(el);
}
$("rg-nodes").textContent = nodes.size;

const dispatch = new Map();
for (const worker of WORKERS) {
  const row = h("li");
  const bar = h("span", "rg-meter");
  for (let i = 0; i < 24; i++) bar.append(h("i"));
  const status = h("span", "rg-dispatch-state", "queued");
  row.append(h("span", "rg-k", worker.id), h("span", "rg-dispatch-name", worker.name), bar, status);
  $("rg-dispatch").append(row);
  dispatch.set(worker.id, { row, bar, status });
}

// ---------- derived values ----------

const data = id => state.get(id)?.data ?? {};
const cost = () => report?.project?.cost ?? null;
const proofs = () => report?.project?.verification ?? (state.get("verification")?.status === "completed" ? data("verification") : null);

function budgetCents() {
  return cost()?.budget_usd_cents ?? data("requirements").budget_usd_cents;
}
function subtotalCents() {
  return cost()?.known_subtotal_usd_cents ?? data("compatibility").core_subtotal_usd_cents ?? data("geometry").core_subtotal_usd_cents;
}
function partsFor(id) {
  return state.get(id)?.parts ?? [];
}
function chosen(role) {
  const sourcing = data("sourcing");
  const pickId = role === "controller" ? sourcing.controller_id : sourcing.sensor_id;
  return partsFor(role).find(part => part.id === pickId) ?? (pickId ? { name: pickId } : null);
}
function sourceCount() {
  return [...partsFor("controller"), ...partsFor("sensor")].reduce((n, part) => n + (part.technical_sources?.length ?? 0), 0);
}
function short(value, size = 18) {
  if (value == null || value === "") return DASH;
  const textValue = String(value);
  return textValue.length > size ? textValue.slice(0, size - 1) + "…" : textValue;
}
function canEngineer() {
  return !!report && !report.evidence_blocked;
}

const ROWS = {
  brief: () => [["goal", short(brief, 20)], ["mode", mode === "sample" ? "offline" : "gemini"], ["model", short(report?.model ?? (mode === "sample" ? "fixture" : "live"), 14)], ["length", brief.length + " ch"]],
  constraints: () => {
    const d = data("requirements");
    return [
      ["link", TRANSPORT[d.transport] ?? short(d.transport)],
      ["budget", Number.isFinite(d.budget_usd_cents) ? (d.budget_exclusive ? "< " : "") + usd(d.budget_usd_cents) : DASH],
      ["wrist", Number.isFinite(d.wrist_circumference_mm) ? d.wrist_circumference_mm + " mm" : DASH],
      ["open", d.unresolved ? String(d.unresolved.length) : DASH],
    ];
  },
  catalog: () => [
    ["mcu", partsFor("controller").length || DASH],
    ["sensor", partsFor("sensor").length || DASH],
    ["sources", sourceCount() || DASH],
    ["picked", [chosen("controller"), chosen("sensor")].filter(Boolean).length + " / 2"],
  ],
  budget: () => {
    const cap = budgetCents();
    const sub = subtotalCents();
    const status = cost()?.budget_status?.replace("_", " ");
    return [
      ["cap", usd(cap)],
      ["parts", usd(sub)],
      ["margin", Number.isFinite(cap) && Number.isFinite(sub) ? usd(cap - sub) : DASH],
      ["status", status ?? (Number.isFinite(cap) && Number.isFinite(sub) ? (sub <= cap ? "within" : "over") : DASH)],
    ];
  },
  requirements: () => {
    const d = data("requirements");
    return [["link", TRANSPORT[d.transport] ?? short(d.transport)], ["gestures", d.gestures?.length ?? DASH], ["budget", usd(d.budget_usd_cents)]];
  },
  sourcing: () => {
    const d = data("sourcing");
    return [["mcu", short(d.controller_id, 16)], ["sensor", short(d.sensor_id, 16)], ["scope", "catalog"]];
  },
  controller: () => [["found", partsFor("controller").length || DASH], ["pick", short(chosen("controller")?.name, 16)], ["sources", partsFor("controller").reduce((n, p) => n + (p.technical_sources?.length ?? 0), 0) || DASH]],
  sensor: () => [["found", partsFor("sensor").length || DASH], ["pick", short(chosen("sensor")?.name, 16)], ["sources", partsFor("sensor").reduce((n, p) => n + (p.technical_sources?.length ?? 0), 0) || DASH]],
  compatibility: () => {
    const d = data("compatibility");
    return [["outcome", short(d.outcome)], ["subtotal", usd(d.core_subtotal_usd_cents)], ["findings", d.findings?.length ?? DASH]];
  },
  reviewer: () => [["steps", data("reviewer").next_steps?.length ?? DASH], ["agent", "reviewer"], ["output", "notes"]],
  evidence: () => [["readers", "Reducto + Gemini"], ["gate", report?.evidence_blocked ? "blocked" : state.get("evidence")?.status === "completed" ? "agreed" : DASH]],
  hold: () => {
    const s = state.get("hold");
    return [["branch", s?.status === "completed" ? "armed" : s?.status === "skipped" ? "clear" : DASH], ["reason", short(s?.summary, 16)], ["report", "kept"]];
  },
  geometry: () => {
    const d = data("geometry");
    return [["nodes", d.node_count ?? DASH], ["outcome", short(d.outcome)], ["findings", d.findings?.length ?? DASH]];
  },
  verification: () => {
    const d = data("verification");
    return [["proved", d.verified_count ?? DASH], ["refuted", d.failed_count ?? DASH], ["open", d.unverified_count ?? DASH]];
  },
  export: () => {
    const d = data("export");
    return [["format", short(d.format)], ["size", Number.isFinite(d.byte_count) ? Math.round(d.byte_count / 1024) + " KiB" : DASH], ["target", "viewer"]];
  },
  gate: () => {
    const ready = state.get("gate")?.status === "gate";
    return [["input", ready ? "[ your call ]" : "[ pending ]"], ["authority", "human"], ["pcb", canEngineer() ? "ready" : DASH], ["studio", report?.project ? "ready" : DASH]];
  },
};

// ---------- rendering ----------

function renderRows(id) {
  const node = nodes.get(id);
  const rows = ROWS[id]();
  if (node.kind === "stage") rows.push(["state", LOG_LABEL[state.get(id).status].toLowerCase()]);
  node.rows.replaceChildren(...rows.map(([key, value]) => {
    const row = h("span", "rg-row");
    row.append(h("span", "rg-row-k", key), h("span", "rg-row-v", String(value)));
    return row;
  }));
}

function renderNode(id) {
  const node = nodes.get(id);
  if (node.kind !== "input") {
    const step = state.get(id);
    node.el.dataset.status = step.status;
    node.status.textContent = STATE_LABEL[step.status];
    node.caption.textContent = step.status === "gate"
      ? "> engineer pcb · open studio"
      : (step.detail || (STAGES[id] ?? GATE).copy);
    node.tag.textContent = String(step.events).padStart(3, "0");
  } else {
    node.el.dataset.status = activity.get(id).length ? "completed" : "pending";
    const values = activity.get(id);
    const peak = Math.max(1, ...values);
    [...node.bars.children].forEach((bar, i) => {
      const value = values[values.length - BARS + i] ?? 0;
      bar.style.setProperty("--v", (value / peak).toFixed(3));
    });
  }
  renderRows(id);
}

function renderAll() {
  for (const id of nodes.keys()) renderNode(id);
  renderDispatch();
  renderOutput();
  renderCaption();
  if (selected) renderDetail();
  layout();
}

function renderDispatch() {
  let live = 0;
  for (const worker of WORKERS) {
    const { bar, status, row } = dispatch.get(worker.id);
    const statuses = worker.stages.map(id => state.get(id).status);
    const done = statuses.filter(s => s === "completed" || s === "skipped").length;
    const word = statuses.includes("failed") ? "fail"
      : statuses.includes("running") ? "run"
      : statuses.includes("stopped") ? "stop"
      : done === statuses.length ? "done" : "queued";
    if (word === "run") live++;
    status.textContent = word;
    row.dataset.status = word;
    const filled = Math.round((done / statuses.length) * bar.children.length);
    [...bar.children].forEach((cell, i) => cell.classList.toggle("on", i < filled));
  }
  $("rg-dispatch-foot").textContent = `parallel 4 · ${live} live · ${runState === "running" ? "scheduler online" : "scheduler " + runState}`;
}

function renderOutput() {
  const sub = subtotalCents();
  const cap = budgetCents();
  const p = proofs();
  $("rg-total").textContent = usd(sub) === DASH ? "$—" : usd(sub);
  const parts = (report?.review?.selected_parts ?? []).map(part => part.name);
  const rows = [
    ["budget", usd(cap)],
    ["margin", Number.isFinite(cap) && Number.isFinite(sub) ? usd(cap - sub) : DASH],
    ["proofs", p ? `${p.verified_count ?? 0} pass · ${p.failed_count ?? 0} fail · ${p.unverified_count ?? 0} open` : DASH],
    ["parts", parts.length ? parts.join(", ") : DASH],
    ["ordered", "0 · approval required"],
  ];
  $("rg-output-rows").replaceChildren(...rows.flatMap(([key, value]) => [h("dt", null, key), h("dd", null, value)]));
}

function renderCaption() {
  const stages = Object.keys(STAGES);
  const done = stages.filter(id => ["completed", "skipped"].includes(state.get(id).status)).length;
  const candidates = partsFor("controller").length + partsFor("sensor").length;
  const p = proofs();
  const focus = current && STAGES[current];
  $("rg-caption-title").textContent = runState === "running"
    ? (focus ? focus.label : "Starting")
    : { completed: "Run complete · hold for your call", failed: "Run failed", stopped: "Run stopped", idle: "Waiting" }[runState];
  $("rg-caption-line").textContent =
    `${done} / ${stages.length} stages → ${candidates} candidates → ${p?.verified_count ?? 0} proved → ${usd(subtotalCents())} bom → 0 ordered`;
}

function safeLink(url, index) {
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" && target.protocol !== "http:") return null;
    const link = h("a", null, `src ${index + 1} · ${target.hostname}`);
    link.href = target.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  } catch {
    return null;
  }
}

function list(lines) {
  const items = lines.filter(Boolean);
  if (!items.length) return;
  const ul = h("ul", "rg-evidence");
  ul.append(...items.map(line => h("li", null, line)));
  detail.append(ul);
}

function renderDetail() {
  const id = selected;
  const def = STAGES[id] ?? INPUTS[id] ?? GATE;
  const step = state.get(id);
  const title = h("p", "rg-detail-title");
  title.append(h("strong", null, def.name), h("span", null, step ? STATE_LABEL[step.status] : "input"));
  detail.replaceChildren(title, h("p", "rg-detail-copy", step?.detail || def.copy));
  const d = data(id);
  if (id === "brief") list([brief]);
  if (id === "constraints" || id === "requirements") {
    const r = data("requirements");
    list([...(r.gestures ?? []).map(g => "gesture · " + g), ...(r.unresolved ?? []).map(u => "open · " + u)]);
  }
  if (id === "sourcing") list([d.rationale]);
  if (id === "controller" || id === "sensor" || id === "catalog") {
    const roles = id === "catalog" ? ["controller", "sensor"] : [id];
    for (const role of roles) {
      const pick = chosen(role);
      for (const part of partsFor(role)) {
        const item = h("div", "rg-part");
        item.append(h("strong", null, part.name), h("span", null, part.sku + (pick ? (pick.id === part.id ? " · selected" : " · alt") : "")));
        (part.technical_sources ?? []).forEach((url, index) => {
          const link = safeLink(url, index);
          if (link) item.append(link);
        });
        detail.append(item);
      }
    }
  }
  if (id === "compatibility" || id === "geometry") {
    if (d.outcome) detail.append(h("p", "rg-detail-copy", OUTCOMES[d.outcome] ?? d.outcome));
    list((d.findings ?? []).map(f => f.detail ?? String(f)));
  }
  if (id === "reviewer") list(d.next_steps ?? []);
  if (id === "budget") list(ROWS.budget().map(([k, v]) => k + " · " + v));
  if (id === "gate") list(["Engineer PCB sends the chosen parts to the PCB studio.", "Open engineering studio loads the 3D assembly, proofs and BOM.", "No order is placed from here."]);
}

// ---------- wires ----------

let gl = null;
try {
  gl = createGraphGL($("rg-gl-back"), $("rg-gl-front"), canvas);
} catch {
  gl = null;
}
gl?.setTargets(() => {
  const out = [];
  for (const [id, node] of nodes) {
    if (node.kind === "input") continue;
    const status = state.get(id)?.status;
    if (status === "running") out.push({ el: node.viz, seed: id.length * 0.13 });
    else if (status === "gate") out.push({ el: node.viz, seed: 0.4, progress: 1 });
  }
  return out;
});

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function layout() {
  if (!gl || !canvas.offsetParent || getComputedStyle($("rg-bus")).display === "none") return;
  const box = canvas.getBoundingClientRect();
  const rel = el => {
    const r = el.getBoundingClientRect();
    return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
  };
  const bus = rel($("rg-bus"));
  const bx = bus.x + bus.w / 2;
  const edges = [];
  const level = status => ({ running: 3, gate: 3, completed: 2, failed: 2, stopped: 1, skipped: 0 }[status] ?? 1);
  const curve = (x0, y0, x3, y3, bend = 0.45) => {
    const dx = (x3 - x0) * bend;
    return [x0, y0, x0 + dx, y0, x3 - dx, y3, x3, y3];
  };
  const bundle = (p, count, spread, props) => {
    for (let j = 0; j < count; j++) {
      const o = (j - (count - 1) / 2) * spread;
      edges.push({ ...props, p: [p[0], p[1] + o, p[2], p[3] + o * 2.4, p[4], p[5] + o * 1.2, p[6], p[7] + o * 0.6], packets: j === Math.floor(count / 2) ? props.packets : 0 });
    }
  };
  const stageIds = [...Object.keys(STAGES), "gate"];
  const live = new Set(stageIds.filter(id => state.get(id).status === "running"));
  const feedsLive = new Set([...live].flatMap(id => FEEDS[id] ?? []));

  // Fabric: faint strands that make the bus read as a dense backplane.
  const random = seeded(7);
  const targets = [...nodes.values()].map(n => rel(n.el));
  for (let i = 0; i < 64; i++) {
    const t = targets[Math.floor(random() * targets.length)];
    const y0 = bus.y + random() * bus.h;
    const left = t.x < bx;
    const x3 = left ? t.x + t.w : t.x;
    const y3 = t.y + 12 + random() * Math.max(8, t.h - 24);
    edges.push({ p: curve(bx, y0, x3, y3, 0.3 + random() * 0.3), level: 0, packets: 0 });
  }

  // Inputs → bus.
  for (const id of Object.keys(INPUTS)) {
    const r = rel(nodes.get(id).el);
    const y = r.y + 11;
    const lit = feedsLive.has(id);
    const busY = Math.min(bus.y + bus.h - 4, Math.max(bus.y + 4, y + 18));
    bundle(curve(r.x + r.w, y, bx, busY), 3, 2.5, { level: lit ? 3 : activity.get(id).length ? 2 : 1, packets: lit ? 4 : 0, speed: -0.5 });
  }
  // Bus → stages. Ports are spread down the bus in flow order.
  stageIds.forEach((id, i) => {
    const node = nodes.get(id);
    const r = rel(node.el);
    const busY = bus.y + 8 + ((i + 0.5) / stageIds.length) * (bus.h - 16);
    const y = r.y + 11;
    const status = state.get(id).status;
    bundle(curve(bx, busY, r.x, y), 3, 2.5, {
      level: level(status),
      packets: status === "running" ? 5 : status === "completed" ? 1 : 0,
      speed: status === "running" ? 0.55 : 0.1,
    });
    node.tag.style.transform = `translate(${Math.round(r.x - 34)}px, ${Math.round(y - 7)}px)`;
  });
  // Stage → stage flow.
  for (const [from, to] of FLOW) {
    const a = rel(nodes.get(from).el);
    const b = rel(nodes.get(to).el);
    const status = state.get(to).status;
    const props = { level: level(status) === 3 ? 3 : Math.min(level(status), 2), packets: status === "running" ? 2 : 0, speed: 0.7 };
    if (Math.abs(a.x - b.x) < 4) {
      const xr = a.x + a.w;
      edges.push({ ...props, p: [xr, a.y + 11, xr + 22, a.y + 11, xr + 22, b.y + 11, xr, b.y + 11] });
    } else {
      edges.push({ ...props, p: curve(a.x + a.w, a.y + 11, b.x, b.y + 11, 0.5) });
    }
  }
  gl.setEdges(edges);
  $("rg-edges").textContent = edges.length;
}

let layoutQueued = false;
function queueLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    gl?.resize();
    layout();
  });
}
const observer = new ResizeObserver(queueLayout);
observer.observe(canvas);
for (const node of nodes.values()) observer.observe(node.el);

// ---------- run state ----------

function select(id) {
  if (selected) nodes.get(selected).el.setAttribute("aria-pressed", "false");
  selected = id;
  nodes.get(id).el.setAttribute("aria-pressed", "true");
  renderDetail();
}

function setFollow(value) {
  followLive = value;
  follow.setAttribute("aria-pressed", String(value));
  if (value && current) select(current);
}
follow.addEventListener("click", () => setFollow(!followLive));

function elapsed() {
  return ((runState === "running" ? performance.now() : endedAt) - startedAt) / 1000;
}
function stamp(seconds) {
  const m = Math.floor(seconds / 60);
  return String(m).padStart(2, "0") + ":" + (seconds - m * 60).toFixed(1).padStart(4, "0");
}
function tickClock() {
  $("rg-clock").textContent = stamp(Math.max(0, elapsed()));
}

function showStatus(value, label) {
  runState = value;
  const status = $("map-status");
  status.dataset.status = value;
  status.firstElementChild.textContent = label;
  clearInterval(clock);
  if (value === "running") clock = setInterval(tickClock, 100);
  else {
    endedAt = performance.now();
    tickClock();
  }
}

function worker(id) {
  return WORKERS.find(w => w.stages.includes(id))?.id ?? "w0";
}

function addLog(who, name, message) {
  const row = h("li");
  row.append(h("time", null, stamp(Math.max(0, elapsed()))), h("span", "rg-log-who", who), h("span", "rg-log-name", name), h("span", "rg-log-msg", message));
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  log.append(row);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function bump(event, id) {
  events++;
  $("rg-events").textContent = String(events).padStart(4, "0");
  if (id && state.has(id)) state.get(id).events++;
  const weight = Math.max(1, Math.round(JSON.stringify(event).length / 40));
  for (const input of FEEDS[id] ?? []) activity.get(input).push(weight);
}

function update(id, status, message, payload, summary, options = {}) {
  const step = state.get(id);
  Object.assign(step, { status, detail: message ?? step.detail, data: payload ?? step.data, summary: summary ?? step.summary });
  if (options.focus) {
    current = id;
    if (followLive) select(id);
  }
  if (options.log) addLog(worker(id), STAGES[id]?.name ?? id, message || LOG_LABEL[status]);
  renderAll();
}

export function showResearchMap(runMode, runBrief) {
  mode = runMode;
  brief = runBrief ?? "";
  report = null;
  dioramaStart(runMode, brief);
  events = 0;
  current = "requirements";
  startedAt = performance.now();
  for (const id of [...Object.keys(STAGES), "gate"]) state.set(id, { status: "pending", events: 0 });
  for (const values of activity.values()) values.length = 0;
  if (selected) nodes.get(selected).el.setAttribute("aria-pressed", "false");
  selected = null;
  $("brief-view").hidden = true;
  $("research-view").hidden = false;
  $("open-workbench-btn").hidden = true;
  $("engineer-pcb-btn").hidden = true;
  $("edit-brief").hidden = true;
  $("stop-research").hidden = false;
  $("map-brief").textContent = brief;
  $("map-mode").textContent = mode === "sample" ? "FORGE / offline sample" : "FORGE / Gemini";
  $("research-title").textContent = "forge-run-" + new Date().toISOString().slice(11, 19).replaceAll(":", "");
  $("rg-cmd").textContent = mode === "sample" ? "research sample.md --offline" : "research brief.md --gemini --no-order";
  $("rg-events").textContent = "0000";
  $("rg-gate").textContent = "Research running. Nothing is built or bought without you.";
  log.replaceChildren();
  resetSwarm(mode);
  resetDeck(mode, brief);
  $("rg-workers").textContent = "4";
  showStatus("running", "Starting");
  setFollow(true);
  renderAll();
  $("research-title").focus({ preventScroll: true });
  addLog("chief", "run", "Run requested. Waiting for the research service.");
}

export function applyResearchEvent(event) {
  dioramaEvent(event);
  applyDeckEvent(event);
  if (event.type === "compute") {
    if (event.detail) addLog(event.provider === "modal" ? "modal" : "local", event.event, event.detail);
    return;
  }
  if (event.type === "source_audit") {
    bump(event, "evidence");
    if (event.event === "decision") {
      addLog("sources", event.source.decision, `${event.source.document.title}: ${event.source.reason}`);
    } else if (event.event === "round" || event.event === "retry") {
      addLog("sources", "discovery", event.detail || `Source round ${event.round}/${event.max_rounds}`);
    } else if (event.event === "complete") {
      const accepted = event.audit.sources.filter(s => s.decision === "accepted").length;
      update("evidence", event.audit.status === "accepted" ? "running" : "failed", `${accepted}/${event.audit.sources.length} sources admitted after ${event.audit.rounds} rounds.`, null, `${accepted} admitted`, { log: true });
    }
    return;
  }
  if (event.type === "swarm") {
    bump(event);
    if (event.event === "start") $("rg-workers").textContent = String(4 + (event.agents?.length ?? 0));
    const line = applySwarmEvent(event);
    if (line) addLog(line[0] === "swarm" || line[0] === "lead" ? "sw" : "a" + ((event.index ?? 0) + 1), line[0], line[1]);
    return;
  }
  if (event.type === "run") {
    bump(event);
    showStatus("running", "Research live");
    renderAll();
    return;
  }
  if (event.type === "catalog_lookup") {
    const id = { controller: "controller", emg_sensor: "sensor" }[event.role];
    if (!id || !Array.isArray(event.parts)) return;
    bump(event, id);
    const step = state.get(id);
    const byId = new Map((step.parts ?? []).map(part => [part.id, part]));
    event.parts.forEach(part => byId.set(part.id, part));
    step.parts = [...byId.values()];
    const count = step.parts.length;
    update(id, "completed", count + (count === 1 ? " catalog entry returned." : " catalog entries returned."), null, count + " candidates", { log: true });
    return;
  }
  if (event.type === "verification") {
    bump(event, "verification");
    const d = event.data ?? {};
    const done = event.status === "completed";
    update("verification", done ? "completed" : "running", event.detail, d, done ? `${d.verified_count ?? 0} verified` : "Checking", { log: true, focus: !done });
    return;
  }
  if (event.type !== "stage" || !state.has(event.stage) || !LOG_LABEL[event.status]) return;
  const { stage, status, detail: message, data: payload } = event;
  bump(event, stage);
  let summary;
  if (stage === "compatibility" && payload?.outcome) {
    summary = OUTCOMES[payload.outcome];
    const hold = payload.outcome !== "candidate";
    update("hold", hold ? "completed" : "skipped", hold ? summary + ". The PCB studio continues from the brief." : "The candidate cleared the compatibility gate.", null, hold ? summary : "cleared");
  }
  if (stage === "geometry" && ["skipped", "failed"].includes(status) && state.get("hold").status !== "completed") {
    update("hold", "completed", message || "The prototype could not be built. See the geometry findings.", null, "no model");
  }
  update(stage, status, message, payload, summary, { focus: status === "running" || (status === "failed" && runState === "running"), log: true });
}

export function finishResearchMap(outcome, message, finalReport) {
  if (finalReport) report = finalReport;
  dioramaFinish(outcome, message, report);
  finishSwarm(outcome);
  finishDeck(outcome, finalReport);
  for (const [id, step] of state) {
    if (id === "gate") continue;
    if (step.status === "pending") step.status = "skipped";
    if (step.status === "running") Object.assign(step, { status: outcome === "stopped" ? "stopped" : "failed", detail: message || step.detail });
  }
  const ready = outcome === "completed" && (report?.project || canEngineer());
  state.get("gate").status = ready ? "gate" : outcome === "completed" ? "skipped" : outcome === "stopped" ? "stopped" : "failed";
  const labels = { completed: "Complete", failed: "Failed", stopped: "Stopped" };
  showStatus(outcome, labels[outcome]);
  $("rg-gate").textContent = report?.evidence_blocked
    ? "Build blocked. Review the datasheet verification findings or run the offline sample."
    : ready
    ? "Research done. Sending the brief to the PCB studio."
    : outcome === "completed"
      ? "Research done. Sending the brief to the PCB studio."
      : message || "The run ended before a design was ready.";
  addLog("chief", "run", (labels[outcome] + (message ? " · " + message : "")) || "The report is ready.");
  if (ready) {
    current = "gate";
    if (followLive) select("gate");
  }
  const stoppedFromButton = document.activeElement === $("stop-research");
  $("stop-research").hidden = true;
  $("edit-brief").hidden = false;
  $("open-workbench-btn").hidden = !(outcome === "completed" && report?.project);
  $("engineer-pcb-btn").hidden = outcome === "stopped" || !canEngineer();
  renderAll();
  if (stoppedFromButton) $("edit-brief").focus();
}

export async function readResearch(runMode, runBrief, signal, onEvent, sourcePolicy = undefined) {
  const response = await fetch("/api/research/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(runMode === "sample" ? { mode: runMode } : { mode: runMode, brief: runBrief, ...(sourcePolicy ? { source_policy: sourcePolicy } : {}) }),
    signal,
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error("This Studio server needs a restart to load the research graph.");
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.detail === "string" ? error.detail : "Could not start research. Check the brief and try again.");
  }
  if (!response.body) throw new Error("The research stream could not be opened.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  function readLine(line) {
    if (!line.trim()) return null;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("FORGE returned an unreadable research event.");
    }
    if (event.type === "error") throw new Error(event.message || "Research could not finish.");
    if (event.type === "report") return event.report;
    onEvent(event);
    return null;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const result = readLine(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (result) return result;
      }
      if (done) {
        const result = readLine(buffer);
        if (result) return result;
        throw new Error("The research stream ended before the report arrived. Try again.");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Initial empty graph so the view is never blank.
for (const id of [...Object.keys(STAGES), "gate"]) state.set(id, { status: "pending", events: 0 });
renderAll();
