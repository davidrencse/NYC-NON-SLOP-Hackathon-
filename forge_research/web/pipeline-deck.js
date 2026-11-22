// The research run as one live flowchart.
//
// Four columns, left to right: Your brief -> Research -> Datasheets -> Build.
// Every unit of work (an agent, a datasheet, a compute worker) is one node;
// wires show what feeds what. Nodes stay short (name + one status line); the
// full story for the selected node is in the inspector on the right. The
// inspector follows whatever is running until the user picks a node.
import {
  Box3,
  Color,
  DirectionalLight,
  GLTFLoader,
  HemisphereLight,
  OrbitControls,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "./vendor/three-runtime.js";
import { createCrew } from "./crew.js";

const COLUMNS = [
  { id: "input", label: "Your brief" },
  { id: "research", label: "Research" },
  { id: "parsing", label: "Datasheets" },
  { id: "generation", label: "Build" },
];
const CATALOG_STEPS = [
  ["requirements", "Read requirements"],
  ["sourcing", "Pick parts from the catalog"],
  ["compatibility", "Check electrical fit"],
  ["reviewer", "Review the design"],
];
// Build column reads top to bottom in the order work happens.
const RANK = { assembly: 1, "modal-enclosure": 2, "local-enclosure": 3, export: 4, model: 5, evidence: 9 };
const DONE = new Set(["completed", "failed", "skipped", "cancelled"]);
const STATUS_TEXT = { pending: "Waiting", running: "Working", completed: "Done", failed: "Failed", skipped: "Skipped", cancelled: "Handed off" };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = id => document.getElementById(id);
function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
const pct = x => (x == null ? "—" : Math.round(x * 100) + "%");
const secs = s => (s == null ? "—" : s < 10 ? s.toFixed(1) + " s" : Math.round(s) + " s");
const kb = n => (n == null ? "—" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " kB");
const clip = (text, n) => (text && text.length > n ? text.slice(0, n - 1) + "…" : text || "");

let state = null;
let tick = 0;

// ---------- graph model ----------
function node(key, col, title, opts = {}) {
  let n = state.nodes.get(key);
  if (!n) {
    n = { key, col, title, status: "pending", note: "", from: [], data: {}, group: null, order: state.nodes.size, ...opts };
    state.nodes.set(key, n);
    state.dirty = true;
  }
  return n;
}

function link(from, to, dashed = false) {
  const n = state.nodes.get(to);
  if (n && !n.from.some(f => f.key === from)) {
    n.from.push({ key: from, dashed });
    state.dirty = true;
  }
}

function update(key, patch) {
  const n = state.nodes.get(key);
  if (!n) return;
  // A finished step never goes back to working (skipped may resume).
  if (patch.status && DONE.has(n.status) && n.status !== "skipped" && !DONE.has(patch.status)) delete patch.status;
  const data = patch.data;
  delete patch.data;
  Object.assign(n, patch);
  if (data) n.data = { ...n.data, ...data };
  if (patch.status === "running") follow(key);
  schedule();
}

function remove(key) {
  if (state.nodes.delete(key)) {
    for (const n of state.nodes.values()) n.from = n.from.filter(f => f.key !== key);
    state.dirty = true;
  }
}

// ---------- rendering ----------
let frame = 0;
function schedule() {
  if (!frame) frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

function glyph(status) {
  const g = h("span", "pd-glyph");
  g.dataset.status = status;
  g.setAttribute("aria-hidden", "true");
  return g;
}

function columnStatus(col) {
  const list = [...state.nodes.values()].filter(n => n.col === col).map(n => n.status);
  if (!list.length) return "pending";
  if (list.some(s => s === "running")) return "running";
  if (list.every(s => DONE.has(s))) return list.some(s => s === "failed") ? "failed" : list.every(s => s === "skipped") ? "skipped" : "completed";
  return list.some(s => s !== "pending") ? "running" : "pending";
}

function render() {
  if (!state) return;
  const flow = $("pd-flow");
  if (state.dirty) {
    state.dirty = false;
    flow.replaceChildren(...COLUMNS.map(col => {
      const section = h("section", "pd-col");
      section.dataset.col = col.id;
      const head = h("header", "pd-col-head");
      head.append(glyph("pending"), h("h4", null, col.label));
      const body = h("div", "pd-col-body");
      let groupBox = null;
      for (const n of [...state.nodes.values()].filter(x => x.col === col.id).sort((a, b) => (RANK[a.key] ?? 0) - (RANK[b.key] ?? 0) || a.order - b.order)) {
        if (n.group) {
          if (!groupBox || groupBox.dataset.group !== n.group) {
            groupBox = h("div", "pd-group");
            groupBox.dataset.group = n.group;
            groupBox.append(h("p", "pd-group-label", n.group));
            body.append(groupBox);
          }
        } else groupBox = null;
        n.el = nodeButton(n);
        (n.group ? groupBox : body).append(n.el);
      }
      section.append(head, body);
      return section;
    }));
  }
  for (const n of state.nodes.values()) paintNode(n);
  for (const section of flow.children) section.querySelector(".pd-glyph").dataset.status = columnStatus(section.dataset.col);
  const running = COLUMNS.find(c => columnStatus(c.id) === "running");
  $("pd-current").textContent = running ? running.label : state.finished ? "Finished" : "Starting";
  wires();
  renderInspector();
}

function nodeButton(n) {
  const btn = h("button", "pd-node");
  btn.type = "button";
  btn.dataset.key = n.key;
  btn.append(glyph(n.status), h("span", "pd-node-title", n.title), h("span", "pd-node-note"));
  btn.addEventListener("click", () => select(n.key, true));
  return btn;
}

function paintNode(n) {
  if (!n.el) return;
  n.el.dataset.status = n.status;
  n.el.dataset.kind = n.kind || "";
  n.el.setAttribute("aria-pressed", String(state.selected === n.key));
  n.el.querySelector(".pd-glyph").dataset.status = n.status;
  n.el.querySelector(".pd-node-note").textContent = n.note || STATUS_TEXT[n.status] || n.status;
  n.el.setAttribute("aria-label", `${n.title}: ${n.note || STATUS_TEXT[n.status]}`);
}

function wires() {
  const svg = $("pd-wires");
  const box = $("pd-canvas").getBoundingClientRect();
  const paths = [];
  for (const n of state.nodes.values()) {
    if (!n.el) continue;
    const b = n.el.getBoundingClientRect();
    for (const f of n.from) {
      const src = state.nodes.get(f.key);
      if (!src?.el) continue;
      const a = src.el.getBoundingClientRect();
      let d;
      if (src.col === n.col) {
        // Loop down the left edge inside one column.
        const x = Math.min(a.left, b.left) - box.left;
        const y1 = a.top + a.height / 2 - box.top;
        const y2 = b.top + b.height / 2 - box.top;
        d = `M${x} ${y1} C${x - 16} ${y1}, ${x - 16} ${y2}, ${x} ${y2}`;
      } else {
        const x1 = a.right - box.left;
        const y1 = a.top + a.height / 2 - box.top;
        const x2 = b.left - box.left;
        const y2 = b.top + b.height / 2 - box.top;
        const mid = (x1 + x2) / 2;
        d = `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
      }
      const live = n.status === "running" && (DONE.has(src.status) || src.status === "running");
      const done = DONE.has(src.status) && n.status !== "pending";
      const focus = state.selected === n.key || state.selected === src.key;
      const cls = ["pd-wire", f.dashed && "is-dashed", live ? "is-live" : done && "is-done", focus && "is-focus"].filter(Boolean).join(" ");
      paths.push(`<path class="${cls}" d="${d}"/>`);
    }
  }
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = paths.join("");
}

// ---------- inspector ----------
function follow(key) {
  if (!state.pinned) state.selected = key;
}

function select(key, byUser) {
  if (byUser) state.pinned = true;
  state.selected = key;
  $("pd-follow").hidden = !state.pinned;
  schedule();
}

function renderInspector() {
  const n = state.nodes.get(state.selected);
  const panel = $("pd-inspect");
  if (state.inspected === n && n?.kind === "model" && panel.contains(state.viewerHost)) {
    panel.querySelector(".pd-aside").textContent = state.modelInfo || "Loading…";
    panel.querySelector(".pd-in-state").textContent = STATUS_TEXT[n.status];
    panel.querySelector(".pd-in-head .pd-glyph").dataset.status = n.status;
    return; // keep the live WebGL canvas in place
  }
  state.inspected = n;
  if (!n) {
    panel.replaceChildren(h("p", "pd-empty", "Pick a step in the flowchart to see what it did."));
    return;
  }
  const head = h("header", "pd-in-head");
  head.append(glyph(n.status), h("h4", null, n.title), h("span", "pd-in-state", STATUS_TEXT[n.status] || n.status));
  const body = h("div", "pd-in-body");
  (DETAIL[n.kind] || DETAIL.plain)(n, body);
  panel.replaceChildren(head, body);
}

function field(list, label, value) {
  list.append(h("dt", null, label), h("dd", null, value == null || value === "" ? "—" : String(value)));
}

function meter(label, value) {
  const row = h("div", "pd-meter");
  const bar = h("span", "pd-meter-bar");
  const fill = h("i");
  fill.style.width = value == null ? "0%" : Math.round(value * 100) + "%";
  bar.append(fill);
  row.append(h("span", null, label), bar, h("b", null, pct(value)));
  return row;
}

const DETAIL = {
  plain(n, body) {
    body.append(h("p", "pd-prose", n.data.text || n.note || STATUS_TEXT[n.status]));
  },
  brief(n, body) {
    body.append(h("p", "pd-prose pd-quote", state.brief || "The sample wristband brief."));
    const dl = h("dl", "pd-facts");
    field(dl, "Run", state.mode === "sample" ? "Offline sample, no API calls" : "Live");
    body.append(dl);
  },
  agent(n, body) {
    if (n.data.focus) body.append(h("p", "pd-lede", n.data.focus));
    const text = n.data.summary || n.data.text;
    const out = h("pre", "pd-prose pd-stream", text || (n.status === "pending" ? "Waiting to start." : "Thinking…"));
    if (n.status === "running") out.dataset.live = "true";
    body.append(out);
    const dl = h("dl", "pd-facts");
    field(dl, "Model", state.swarmModel || "Offline replay");
    if (n.data.duration_s != null) field(dl, "Time", secs(n.data.duration_s));
    if (n.data.tokens) field(dl, "Tokens", n.data.tokens.toLocaleString());
    body.append(dl, h("p", "pd-aside", "Advice only. Catalog checks and Lean proofs decide what is accepted."));
  },
  catalog(n, body) {
    const steps = h("ol", "pd-steps");
    for (const [id, label] of CATALOG_STEPS) {
      const s = n.data.steps?.[id] || "pending";
      const li = h("li");
      li.append(glyph(s), h("span", null, label), h("span", "pd-step-state", STATUS_TEXT[s] || s));
      steps.append(li);
    }
    body.append(steps);
    for (const lookup of n.data.lookups || []) {
      body.append(h("p", "pd-sub", `Candidates for the ${lookup.role}`));
      const ul = h("ul", "pd-list");
      for (const p of lookup.parts) ul.append(h("li", null, p.name || p.id));
      body.append(ul);
    }
    if (n.data.rationale) body.append(h("p", "pd-sub", "Why these parts"), h("p", "pd-prose", n.data.rationale));
  },
  doc(n, body) {
    const d = n.data;
    if (d.url) {
      const a = h("a", "pd-link", d.url.replace(/^https?:\/\//, ""));
      a.href = d.url;
      a.target = "_blank";
      a.rel = "noreferrer";
      body.append(a);
    }
    if (!d.decision) {
      body.append(h("p", "pd-prose", "Pangram is checking who wrote it. Reducto is pulling out tables and figures."));
      return;
    }
    body.append(h("p", "pd-sub", "Pangram authorship"), meter("AI-generated", d.ai), meter("AI-assisted", d.assist));
    const dl = h("dl", "pd-facts");
    field(dl, "Reducto", d.parsed ? `${d.facts ?? 0} facts extracted` : "Not parsed");
    field(dl, "Scans", d.scans);
    field(dl, "Decision", d.decision === "accepted" ? "Used as evidence" : d.decision === "excluded" ? "Left out" : d.decision);
    body.append(dl);
    if (d.reason) body.append(h("p", "pd-prose", d.reason));
  },
  vm(n, body) {
    const d = n.data;
    const res = d.resources || {};
    const dl = h("dl", "pd-facts");
    field(dl, "Where", d.cloud ? "Modal container" : "This machine");
    field(dl, "Runs", d.function);
    field(dl, "CPU", res.cpu != null ? res.cpu + " vCPU" : null);
    field(dl, "Memory", res.memory_mb ? res.memory_mb / 1024 + " GiB" : "Shared with this machine");
    field(dl, "GPU", res.gpu || "None, CAD runs on CPU");
    if (res.timeout_s) field(dl, "Time limit", res.timeout_s + " s");
    body.append(dl);
    if (d.stats) {
      const s = d.stats;
      const out = h("dl", "pd-facts");
      field(out, "Took", secs(s.elapsed_s));
      if (s.triangles) field(out, "Triangles", s.triangles.toLocaleString());
      field(out, "Parts", Array.isArray(s.nodes) ? s.nodes.length : s.nodes);
      field(out, "GLB size", kb(s.bytes?.glb));
      if ("cache_hit" in s) field(out, "Cache", s.cache_hit ? "Reused an earlier result" : "Built fresh");
      body.append(h("p", "pd-sub", "Output"), out);
    }
    if (d.log?.length) {
      const log = h("ol", "pd-log");
      for (const line of d.log) log.append(h("li", null, line));
      body.append(h("p", "pd-sub", "Log"), log);
    }
  },
  export(n, body) {
    const dl = h("dl", "pd-facts");
    field(dl, "3D file", state.exported === "completed" ? "GLB ready" : STATUS_TEXT[state.exported] || "Waiting");
    field(dl, "Lean proofs", state.leanText || "Waiting");
    body.append(dl);
  },
  model(n, body) {
    const tabs = h("div", "pd-tabs");
    for (const m of state.models) {
      const tab = h("button", "pd-tab", m.label);
      tab.type = "button";
      tab.setAttribute("aria-pressed", String(m === state.model));
      tab.addEventListener("click", () => showModel(m));
      tabs.append(tab);
    }
    ensureViewer();
    body.append(tabs, state.viewerHost, h("p", "pd-aside", state.modelInfo || "Loading…"));
  },
};

// ---------- event handlers ----------
function onSwarm(event) {
  if (event.event === "start") {
    state.swarmModel = event.model;
    (event.agents ?? []).forEach((a, i) => {
      node("agent-" + i, "research", a.name, { kind: "agent", group: "Agent swarm" }).data.focus = a.focus;
      link("brief", "agent-" + i);
    });
    node("lead", "research", "Lead engineer", { kind: "agent", group: "Agent swarm" }).data.focus = "Merges the specialist briefs into one plan.";
    (event.agents ?? []).forEach((_, i) => link("agent-" + i, "lead"));
    catalogNode();
    schedule();
  } else if (event.event === "agent") {
    const key = "agent-" + event.index;
    node(key, "research", event.role, { kind: "agent", group: "Agent swarm" });
    const r = event.result;
    const tokens = (r?.input_tokens ?? 0) + (r?.output_tokens ?? 0);
    update(key, {
      status: event.status,
      note: event.status === "running" ? "Thinking" : [STATUS_TEXT[event.status], r?.duration_s ? secs(r.duration_s) : null].filter(Boolean).join(", "),
      data: { text: event.text, summary: r?.summary, duration_s: r?.duration_s, tokens },
    });
  } else if (event.event === "synthesis") {
    update("lead", { status: event.status, note: event.status === "running" ? "Merging briefs" : "Plan written", data: { text: event.text } });
  } else if (event.event === "complete" && event.report?.status === "failed") {
    update("lead", { status: "failed", note: "Swarm failed" });
  }
}

function catalogNode() {
  node("catalog", "research", "Catalog review", { kind: "catalog" });
  link("brief", "catalog");
}

function catalogStep(stage, status, data) {
  catalogNode();
  const n = state.nodes.get("catalog");
  n.data.steps = { ...n.data.steps, [stage]: status };
  if (stage === "sourcing" && data?.rationale) n.data.rationale = data.rationale;
  const label = CATALOG_STEPS.find(s => s[0] === stage)?.[1];
  const finished = stage === "reviewer" && DONE.has(status);
  update("catalog", { status: finished ? status : status === "failed" ? "failed" : "running", note: finished ? "Parts chosen" : label });
}

function ensureEvidence() {
  remove("parse-skip");
  if (!state.nodes.has("evidence")) {
    node("evidence", "parsing", "Cross-check facts", { kind: "plain" });
    link("evidence", "assembly");
  }
}

function docNode(doc, part) {
  ensureEvidence();
  const key = "doc-" + (doc.url || doc.title);
  const n = node(key, "parsing", clip(doc.title || "Datasheet", 38), { kind: "doc", group: part ? "Part: " + part : "Sources" });
  n.data.url = doc.url;
  link("catalog", key);
  link(key, "evidence");
  return key;
}

function onSource(event) {
  if (event.event === "reading") {
    update(docNode({ url: event.url, title: event.title }, event.part_id), { status: "running", note: "Scanning and parsing" });
  } else if (event.event === "decision") {
    const s = event.source ?? {};
    const facts = Array.isArray(s.facts) ? s.facts.length : s.facts;
    update(docNode(s.document ?? {}, s.part_id), {
      status: s.decision === "accepted" ? "completed" : s.decision === "error" ? "failed" : "skipped",
      note: s.decision === "accepted" ? `Used, ${facts ?? 0} facts` : s.decision === "excluded" ? "Left out" : s.decision,
      data: { decision: s.decision, reason: s.reason, ai: s.ai_fraction, assist: s.ai_assisted_fraction, scans: s.scans, parsed: s.parsed, facts },
    });
  }
}

function onCompute(event) {
  if (event.event === "ready") {
    addModel(event.glb_url, event.provider === "modal" ? "Enclosure (Modal)" : "Enclosure");
    return;
  }
  if (event.job === "enclosure") return;
  const cloud = event.provider === "modal";
  const key = event.job === "local-assembly" ? "assembly" : event.job;
  const title = key === "assembly" ? "Assemble parts" : cloud ? "Enclosure on Modal" : "Enclosure on this machine";
  const n = node(key, "generation", title, { kind: "vm" });
  n.data.cloud = cloud;
  if (event.resources) n.data.resources = event.resources;
  if (event.function) n.data.function = event.function;
  if (event.detail) n.data.log = [...(n.data.log || []), event.detail];
  if (key === "assembly") {
    link(state.nodes.has("evidence") ? "evidence" : state.nodes.has("parse-skip") ? "parse-skip" : "catalog", "assembly");
  } else if (event.job === "modal-enclosure") {
    link("assembly", key);
  } else if (event.job === "local-enclosure") {
    const handoff = state.nodes.has("modal-enclosure");
    link(handoff ? "modal-enclosure" : "assembly", key, handoff);
  }
  if (event.event === "provision" || event.event === "running") {
    update(key, { status: "running", note: cloud ? "Starting container" : "Working" });
  } else if (event.event === "skipped") {
    update(key, { status: "skipped", note: "Not configured" });
  } else if (event.event === "cancelled") {
    update(key, { status: "cancelled", note: "Failed, handed to this machine" });
  } else if (event.event === "completed") {
    n.data.stats = event.stats;
    update(key, { status: "completed", note: `Done in ${secs(event.stats?.elapsed_s)}` });
    if (event.glb_url) addModel(event.glb_url, "Assembly");
  } else {
    update(key, { status: "failed", note: clip(event.detail, 40) || "Failed" });
  }
}

function onStage(event) {
  const { stage, status, data } = event;
  if (CATALOG_STEPS.some(s => s[0] === stage)) catalogStep(stage, status, data);
  else if (stage === "evidence") {
    ensureEvidence();
    if (!state.nodes.get("evidence").from.length) link("catalog", "evidence");
    update("evidence", { status, note: clip(event.detail, 44), data: { text: event.detail } });
  } else if (stage === "geometry") {
    if (!state.nodes.has("evidence")) {
      node("parse-skip", "parsing", "Datasheet check", { kind: "plain" });
      link("catalog", "parse-skip");
      update("parse-skip", {
        status: "skipped",
        note: "Not part of the sample",
        data: { text: "The offline sample relies on catalog facts that were already reviewed. In a live run, Pangram scans each datasheet and Reducto parses it here." },
      });
    }
    node("assembly", "generation", "Assemble parts", { kind: "vm" });
    link(state.nodes.has("evidence") ? "evidence" : "parse-skip", "assembly");
    if (status !== "completed") update("assembly", { status, note: clip(event.detail, 40) });
  } else if (stage === "export") {
    state.exported = status;
    exportNode();
  }
}

function exportNode() {
  node("export", "generation", "Export and prove", { kind: "export" });
  link("assembly", "export");
  const done = state.exported === "completed" && state.lean && state.lean !== "running";
  update("export", {
    status: state.exported === "failed" ? "failed" : done ? "completed" : "running",
    note: done ? `GLB ready, Lean ${state.lean}` : state.exported === "completed" ? "Checking Lean proofs" : "Packaging GLB",
  });
}

// ---------- model ----------
function ensureViewer() {
  if (!state.viewer) {
    state.viewerHost = h("div", "pd-gl");
    state.viewer = createViewer(state.viewerHost);
  }
}

function addModel(url, label) {
  if (!url) return;
  let m = state.models.find(x => x.url === url);
  if (!m) {
    m = { url, label };
    state.models.push(m);
  }
  node("model", "generation", "3D model", { kind: "model" });
  link("export", "model");
  for (const key of ["modal-enclosure", "local-enclosure"]) if (state.nodes.has(key)) link(key, "model", key === "modal-enclosure" && state.nodes.get(key).status !== "completed");
  if (!state.pinned) state.selected = "model";
  showModel(m);
}

function showModel(m) {
  state.model = m;
  state.inspected = null; // rebuild tabs
  ensureViewer();
  update("model", { status: "running", note: "Loading " + m.label.toLowerCase() });
  state.viewer.load(m.url).then(info => {
    state.modelInfo = `${m.label}: ${info.meshes} meshes, ${info.size}. Drag to turn it.`;
    update("model", { status: "completed", note: `${state.models.length} model${state.models.length > 1 ? "s" : ""} ready` });
  }, () => {
    state.modelInfo = "Could not load " + m.label + ".";
    update("model", { status: "failed", note: "Load failed" });
  });
}

function createViewer(host) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  host.append(renderer.domElement);
  const scene = new Scene();
  scene.add(new HemisphereLight(0xffffff, 0x202020, 2.2));
  const key = new DirectionalLight(0xffffff, 2.4);
  key.position.set(1, 2, 1.5);
  scene.add(key);
  const camera = new PerspectiveCamera(32, 1, 0.001, 50);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = !reduceMotion;
  controls.autoRotateSpeed = 1.6;
  const loader = new GLTFLoader();
  const crew = createCrew(loader, scene);
  let root = null;
  let token = 0;
  let raf = 0;
  const t0 = performance.now();

  function loop() {
    raf = requestAnimationFrame(loop);
    if (!host.isConnected) return;
    const w = host.clientWidth || 300;
    const hh = host.clientHeight || 200;
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
    crew.update((performance.now() - t0) / 1000, reduceMotion);
    controls.update();
    renderer.render(scene, camera);
  }
  loop();

  return {
    async load(url) {
      const mine = ++token;
      const gltf = await loader.loadAsync(url);
      if (mine !== token) return { meshes: 0, size: "" };
      if (root) scene.remove(root);
      root = gltf.scene;
      scene.add(root);
      const box = new Box3().setFromObject(root);
      const centre = box.getCenter(new Vector3());
      const size = box.getSize(new Vector3());
      let meshes = 0;
      root.traverse(o => { if (o.isMesh) meshes++; });
      // Frame the model plus the crew walking around it.
      const reach = await crew.attach(root);
      if (mine !== token) return { meshes: 0, size: "" };
      const radius = Math.max(size.length() / 2, reach * 0.85, 1e-3);
      root.traverse(o => {
        if (o.isMesh && o.material?.emissive) o.material.emissive = new Color(0x050505);
      });
      controls.target.copy(centre);
      camera.position.copy(centre).add(new Vector3(radius * 1.9, radius * 1.3, radius * 2.3));
      camera.near = radius / 100;
      camera.far = radius * 40;
      camera.updateProjectionMatrix();
      return { meshes, size: `${(size.x * 1000).toFixed(0)} × ${(size.z * 1000).toFixed(0)} × ${(size.y * 1000).toFixed(0)} mm` };
    },
    dispose() {
      cancelAnimationFrame(raf);
      crew.dispose();
      renderer.dispose();
    },
  };
}

// ---------- public API ----------
export function resetDeck(mode, brief) {
  state?.viewer?.dispose();
  state = { mode, brief, started: performance.now(), nodes: new Map(), dirty: true, models: [], selected: "brief", pinned: false };
  node("brief", "input", "Brief", { kind: "brief", status: "completed", note: clip(brief || "Sample wristband brief", 34) });
  $("pd-follow").hidden = true;
  clearInterval(tick);
  tick = setInterval(() => {
    if (state && !state.finished) $("pd-clock").textContent = secs((performance.now() - state.started) / 1000);
  }, 200);
  schedule();
}

export function applyDeckEvent(event) {
  if (!state) return;
  if (event.type === "swarm") onSwarm(event);
  else if (event.type === "source_audit") onSource(event);
  else if (event.type === "compute") onCompute(event);
  else if (event.type === "stage") onStage(event);
  else if (event.type === "catalog_lookup") {
    catalogNode();
    const n = state.nodes.get("catalog");
    n.data.lookups = [...(n.data.lookups || []).filter(l => l.role !== event.role), { role: event.role, parts: event.parts ?? [] }];
    update("catalog", { note: `Comparing ${event.role} options` });
  } else if (event.type === "verification") {
    state.lean = event.status === "completed" ? event.data?.status ?? "done" : event.status;
    state.leanText = event.status === "completed" && event.data
      ? `${event.data.verified_count} proved, ${event.data.failed_count} failed, ${event.data.unverified_count} open`
      : STATUS_TEXT[event.status] || event.status;
    exportNode();
  }
}

export function finishDeck(outcome, report) {
  if (!state) return;
  clearInterval(tick);
  state.finished = true;
  const failed = outcome === "failed" || outcome === "error";
  for (const n of state.nodes.values()) {
    if (n.status === "running" && n.kind !== "model") n.status = failed ? "failed" : "completed";
    if (n.status === "pending") n.status = "skipped";
  }
  if (report?.project?.glb_url && !state.models.length) addModel(report.project.glb_url, "Assembly");
  $("pd-clock").textContent = secs((performance.now() - state.started) / 1000);
  state.inspected = null;
  schedule();
}

addEventListener("resize", () => state && schedule());
$("pd-follow")?.addEventListener("click", () => {
  state.pinned = false;
  $("pd-follow").hidden = true;
  const running = [...state.nodes.values()].filter(n => n.status === "running").pop();
  select(running ? running.key : state.selected, false);
});
$("pd-graph-toggle")?.addEventListener("click", event => {
  const show = $("research-view").classList.toggle("show-graph");
  event.currentTarget.setAttribute("aria-pressed", String(show));
  event.currentTarget.textContent = show ? "Hide event graph" : "Show event graph";
  dispatchEvent(new Event("resize"));
});
