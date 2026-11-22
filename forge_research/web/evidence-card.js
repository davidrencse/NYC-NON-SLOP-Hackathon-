// Datasheet evidence infographic: a hover card that grows out of the cursor,
// plus a full bundle view for the inspector. Data comes from
// /api/evidence/{part_id}; every value is rendered as text (never HTML)
// because snippets come from parsed third-party documents.

const SVG = "http://www.w3.org/2000/svg";
const cache = new Map();
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const STATUS = {
  source_grounded: ["Source-grounded", "pass"],
  conflict: ["Conflict", "fail"],
  catalog_only: ["Catalog record", "info"],
  error: ["Read failed", "warn"],
};

function el(tag, text = "", className = "") {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function fetchEvidence(partId) {
  if (!cache.has(partId)) {
    const pending = fetch(`/api/evidence/${encodeURIComponent(partId)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch(error => {
        cache.delete(partId);
        throw error;
      });
    cache.set(partId, pending);
  }
  return cache.get(partId);
}

/** Ask the server to read every catalog part now, then warm the browser cache. */
export async function prefetchAllEvidence() {
  try {
    const index = await fetch("/api/evidence").then(r => r.json());
    for (const id of Object.keys(index.documents || {})) fetchEvidence(id).catch(() => {});
    return index;
  } catch {
    return null;
  }
}

export function forgetEvidence() {
  cache.clear();
}

const find = (ev, field) => ev.facts.find(f => f.field === field && f.primary !== false);
const volts = mv => `${nf.format(mv / 1000)} V`;

// ------------------------------------------------------------------ pieces

function docStack(ev) {
  const wrap = el("div", "", "ev-docs");
  const docs = ev.documents || [];
  const parsed = docs.filter(d => d.status === "parsed").length;
  const label =
    ev.provider === "reducto"
      ? `${parsed}/${docs.length} documents read`
      : "Curated catalog record · not a parsed datasheet";
  const icons = el("div", "", "ev-doc-icons");
  docs.slice(0, 5).forEach((doc, i) => {
    const sheet = el("span", "", `ev-doc ev-doc-${doc.status}`);
    sheet.style.setProperty("--i", i);
    sheet.title = `${doc.title || doc.url}${doc.pages ? ` · ${doc.pages} pp` : ""}${doc.cached ? " · cached" : ""}${doc.error ? ` · ${doc.error}` : ""}`;
    icons.append(sheet);
  });
  wrap.append(icons, el("span", label, "ev-docs-label"));
  return wrap;
}

function scaleRow(label, valueText, build) {
  const row = el("div", "", "ev-row");
  const head = el("div", "", "ev-row-head");
  head.append(el("span", label), el("strong", valueText));
  const bar = svg("svg", { viewBox: "0 0 240 18", class: "ev-bar", "aria-hidden": "true" });
  bar.append(svg("rect", { x: 0, y: 7, width: 240, height: 4, rx: 2, class: "ev-track" }));
  build(bar);
  row.append(head, bar);
  return row;
}

function supplyGauge(ev, railMv) {
  const rec = find(ev, "supply_voltage_recommended");
  const abs = find(ev, "supply_voltage_absolute_max");
  if (!rec && !abs) return null;
  const top = Math.max(abs?.max ?? 0, rec?.max ?? 0, railMv ?? 0) * 1.12 || 6000;
  const x = mv => Math.max(0, Math.min(240, (mv / top) * 240));
  const text = rec
    ? `${rec.min != null ? volts(rec.min) : "?"} – ${rec.max != null ? volts(rec.max) : "?"}`
    : `≤ ${volts(abs.max)} abs`;
  return scaleRow("Supply", text, bar => {
    if (rec?.min != null || rec?.max != null) {
      const a = x(rec.min ?? 0);
      bar.append(svg("rect", { x: a, y: 5, width: Math.max(2, x(rec.max ?? rec.min) - a), height: 8, rx: 3, class: "ev-band" }));
    }
    if (abs?.max != null) {
      bar.append(svg("line", { x1: x(abs.max), x2: x(abs.max), y1: 1, y2: 17, class: "ev-limit" }));
    }
    if (railMv) {
      const ok = (!rec || ((rec.min ?? 0) <= railMv && railMv <= (rec.max ?? Infinity))) && (!abs?.max || railMv <= abs.max);
      bar.append(svg("circle", { cx: x(railMv), cy: 9, r: 4.2, class: ok ? "ev-marker" : "ev-marker bad" }));
    }
  });
}

function simpleRange(ev, field, label, fmt) {
  const fact = find(ev, field);
  if (!fact || (fact.max == null && fact.typ == null)) return null;
  const hi = fact.max ?? fact.typ;
  const lo = fact.min ?? 0;
  const text = fact.min != null ? `${fmt(fact.min)} – ${fmt(hi)}` : `${fact.typ != null && fact.max == null ? "typ " : "≤ "}${fmt(hi)}`;
  return scaleRow(label, text, bar => {
    const a = (lo / (hi * 1.1)) * 240;
    bar.append(svg("rect", { x: a, y: 5, width: Math.max(2, (hi / (hi * 1.1)) * 240 - a), height: 8, rx: 3, class: "ev-band soft" }));
    if (fact.typ != null && fact.max != null) {
      bar.append(svg("line", { x1: (fact.typ / (hi * 1.1)) * 240, x2: (fact.typ / (hi * 1.1)) * 240, y1: 3, y2: 15, class: "ev-typ" }));
    }
  });
}

function outline(ev) {
  const l = find(ev, "dimension_length")?.value;
  const w = find(ev, "dimension_width")?.value;
  const h = find(ev, "dimension_height")?.value;
  if (!l || !w) return null;
  const box = el("div", "", "ev-outline");
  const long = Math.max(l, w);
  const short = Math.min(l, w);
  const W = 72;
  const H = Math.max(10, (short / long) * W);
  const drawing = svg("svg", { viewBox: `0 0 ${W + 4} ${H + 4}`, width: W + 4, height: H + 4, "aria-hidden": "true" });
  drawing.append(svg("rect", { x: 2, y: 2, width: W, height: H, rx: 2.5, class: "ev-board" }));
  box.append(drawing);
  const dims = el("div", "", "ev-outline-dims");
  dims.append(
    el("strong", `${nf.format(l)} × ${nf.format(w)}${h ? ` × ${nf.format(h)}` : ""} mm`),
    el("span", find(ev, "dimension_length").provenance === "catalog_record" ? "outline · catalog" : "outline · datasheet")
  );
  box.append(dims);
  return box;
}

function chips(ev) {
  const wrap = el("div", "", "ev-chips");
  const ifaces = ev.facts.filter(f => f.field === "wireless_interface").map(f => String(f.value).toUpperCase());
  for (const name of [...new Set(ifaces)].slice(0, 4)) wrap.append(el("span", name, "ev-chip"));
  const bits = find(ev, "adc_resolution_bits");
  if (bits) wrap.append(el("span", `${bits.value}-bit ADC`, "ev-chip"));
  const pins = find(ev, "pin_table");
  if (pins?.note) wrap.append(el("span", pins.note, "ev-chip"));
  return wrap.childElementCount ? wrap : null;
}

function checkDots(ev) {
  if (!ev.checks?.length) return null;
  const wrap = el("div", "", "ev-checks");
  const pass = ev.checks.filter(c => c.status === "pass").length;
  const dots = el("span", "", "ev-dots");
  for (const c of ev.checks) {
    const d = el("i", "", `ev-dot ${c.status}`);
    d.title = `${c.check}: ${c.detail}`;
    dots.append(d);
  }
  wrap.append(dots, el("span", `${pass}/${ev.checks.length} datasheet cross-checks pass`));
  return wrap;
}

function header(part, ev) {
  const head = el("div", "", "ev-head");
  const [label, tone] = ev && !ev.design_ready
    ? ["Unverified · build blocked", "warn"]
    : ev?.design_ready ? ["Independent reads agree", "pass"]
    : STATUS[ev?.status] || ["Reading…", "busy"];
  const titles = el("div", "", "ev-titles");
  titles.append(
    el("span", part ? `${part.role.replace("_", " ")} · ${part.manufacturer}` : "Component", "ev-role"),
    el("strong", part?.name || ev?.part_name || "Component", "ev-name")
  );
  head.append(titles, el("span", label, `ev-pill ${tone}`));
  return head;
}

function body(ev, railMv) {
  const nodes = [
    docStack(ev),
    supplyGauge(ev, railMv),
    simpleRange(ev, "adc_input_range", "ADC input", volts),
    simpleRange(ev, "operating_current", "Current", ma => `${nf.format(ma)} mA`),
    outline(ev),
    chips(ev),
    checkDots(ev),
  ];
  const cited = ev.facts.filter(f => f.page != null).length;
  const conflicts = ev.facts.filter(f => f.status === "needs_review" || f.status === "conflict").length;
  const foot = el(
    "div",
    ev.provider === "reducto"
      ? `${ev.facts.length} facts · ${cited} page-cited${conflicts ? ` · ${conflicts} need review` : ""}${ev.cached ? " · cached" : ""}`
      : ev.error
      ? `Reducto: ${ev.error}`
      : "Add REDUCTO_API_KEY to parse the manufacturer PDFs.",
    "ev-foot"
  );
  const verification = el("div", ev.design_ready
    ? "Reducto and Claude agree on critical specs. Source review is still recommended."
    : `Build blocked: ${(ev.blocking_reasons || []).join(" ") || "Critical evidence is unverified."}`, "ev-foot");
  return [...nodes.filter(Boolean), foot, verification];
}

// --------------------------------------------------------------- hover card

export function createEvidenceHover({ getPart, getRailMv }) {
  const card = el("div", "", "ev-card");
  card.setAttribute("role", "tooltip");
  card.hidden = true;
  const leader = el("div", "", "ev-leader");
  leader.hidden = true;
  document.body.append(leader, card);

  let currentId = null;
  let px = 0;
  let py = 0;
  let hideTimer = null;

  function place() {
    const gap = 18;
    const rect = card.getBoundingClientRect();
    let left = px + 14;
    let top = py - gap - rect.height;
    let below = false;
    if (top < 8) {
      top = py + gap + 8;
      below = true;
    }
    if (left + rect.width > innerWidth - 8) left = Math.max(8, px - 14 - rect.width);
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    card.dataset.below = String(below);
    leader.style.transform = `translate(${Math.round(px)}px, ${Math.round(below ? py + 4 : top + rect.height)}px)`;
    leader.style.height = `${Math.max(0, below ? top - py - 4 : py - top - rect.height - 4)}px`;
  }

  function render(ev) {
    const part = getPart(currentId);
    card.replaceChildren(header(part, ev), ...(ev ? body(ev, getRailMv(part)) : [el("div", "Reading datasheets…", "ev-loading")]));
    place();
  }

  return {
    show(partId, x, y) {
      clearTimeout(hideTimer);
      px = x;
      py = y;
      if (!partId) return this.hide();
      if (partId !== currentId || card.hidden) {
        currentId = partId;
        card.hidden = false;
        leader.hidden = false;
        card.classList.remove("in");
        render(null);
        requestAnimationFrame(() => card.classList.add("in"));
        fetchEvidence(partId)
          .then(ev => currentId === partId && render(ev))
          .catch(() => currentId === partId && card.replaceChildren(header(getPart(partId), { status: "error" }), el("div", "Evidence unavailable.", "ev-loading")));
      } else {
        place();
      }
    },
    hide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        currentId = null;
        card.classList.remove("in");
        card.hidden = true;
        leader.hidden = true;
      }, 60);
    },
    /** Attach hover to a DOM element that stands for one catalog part. */
    bind(node, partId) {
      node.addEventListener("pointerenter", e => this.show(partId, e.clientX, e.clientY));
      node.addEventListener("pointermove", e => this.show(partId, e.clientX, e.clientY));
      node.addEventListener("pointerleave", () => this.hide());
      node.addEventListener("focus", () => {
        const r = node.getBoundingClientRect();
        this.show(partId, r.left + 12, r.top);
      });
      node.addEventListener("blur", () => this.hide());
    },
  };
}

// ------------------------------------------------------------ inspector view

export function renderEvidenceBundle(container, part, railMv) {
  const section = el("div", "", "ev-panel");
  section.append(el("div", "Reading datasheets…", "ev-loading"));
  container.append(el("h4", "Datasheet Evidence Bundle", "insp-subhead"), section);
  fetchEvidence(part.id)
    .then(ev => {
      section.replaceChildren(header(part, ev), ...body(ev, railMv));
      const list = el("ul", "", "ev-doc-list");
      for (const doc of ev.documents || []) {
        const li = el("li", "", `ev-doc-row ${doc.status}`);
        let link;
        try {
          const url = new URL(doc.url);
          link = el("a", doc.title || url.pathname.split("/").pop());
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        } catch {
          link = el("span", doc.title || doc.url);
        }
        const meta = [doc.scope === "electrical" ? "electrical only" : "full", doc.pages ? `${doc.pages} pp` : null, doc.revision, doc.cached ? "cached" : null, doc.error, doc.verification_error, doc.independent_read ? `Claude identity: ${doc.independent_read.identity_matches ? "matched" : "unresolved"}` : "No independent read"]
          .filter(Boolean)
          .join(" · ");
        li.append(link, el("small", meta));
        list.append(li);
      }
      const table = el("div", "", "ev-facts");
      for (const fact of ev.facts) {
        const row = el("div", "", `ev-fact ${fact.status}`);
        const value =
          fact.value != null
            ? `${fact.value}${fact.unit && typeof fact.value === "number" ? ` ${fact.unit}` : ""}`
            : [fact.min, fact.typ, fact.max].map(v => (v == null ? "–" : nf.format(v))).join(" / ") + (fact.unit ? ` ${fact.unit}` : "");
        row.append(
          el("span", fact.label),
          el("strong", value),
          el("small", [fact.page ? `p.${fact.page}` : null, fact.corroborated_by ? `+${fact.corroborated_by} docs agree` : null, fact.note, fact.verification_reason].filter(Boolean).join(" · "))
        );
        row.title = [fact.snippet, fact.conditions ? `Conditions: ${fact.conditions}` : null,
          fact.independent ? `Claude p.${fact.independent.page}: ${fact.independent.quote}` : null,
          fact.verification_reason].filter(Boolean).join("\n");
        table.append(row);
      }
      section.append(list, table);
    })
    .catch(() => section.replaceChildren(el("div", "Evidence unavailable.", "ev-loading")));
}
