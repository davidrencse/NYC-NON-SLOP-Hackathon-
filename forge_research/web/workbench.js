import { clearValidation, runValidation } from "./validation.js";
import { createEvidenceHover, prefetchAllEvidence, renderEvidenceBundle } from "./evidence-card.js";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const numFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const STATUS_BADGES = {
  verified: { icon: "✓", label: "VERIFIED", cls: "verified" },
  failed: { icon: "✕", label: "FAILED", cls: "failed" },
  unverified: { icon: "?", label: "UNVERIFIED", cls: "unverified" },
  error: { icon: "!", label: "ERROR", cls: "error" },
};
const FIDELITY_LABELS = {
  dimensioned_proxy: "Dimensioned datasheet proxy",
  estimated_detail: "Estimated package detail",
  parametric: "Parametric CAD solid",
};
const MATCH_LABELS = {
  exact_match: "✓ Exact SKU match",
  bundle_or_pack: "Bundle / multi-pack",
  variant_or_accessory: "⚠ Variant / accessory",
};

const $ = sel => document.querySelector(sel);

function el(tag, text = "", className = "") {
  const node = document.createElement(tag);
  if (text !== "") node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatCents(cents) {
  return usd.format((cents ?? 0) / 100);
}

let catalogById = new Map();
let currentProject = null;
let lastReport = null;
let selectedGroupId = "board";
let activeTab = "part";
let liveGeminiAvailable = false;

let viewer = null;
let viewerPromise = null;
let loadedGlbKey = null;

// Serialized edit queue to prevent race conditions & stale overwrites
let mutationInFlight = false;
let coalescedEdit = null;
let wristDebounceTimer = null;

export function setCatalogParts(parts) {
  catalogById = new Map((parts || []).map(p => [p.id, p]));
}

export function setLiveGeminiStatus(isLive) {
  liveGeminiAvailable = Boolean(isLive);
  const liveBtn = $("#btn-repair-live");
  if (liveBtn) {
    liveBtn.disabled = !liveGeminiAvailable;
    liveBtn.title = liveGeminiAvailable
      ? "Run live Claude repair agent"
      : "GEMINI_API_KEY / FORGE_GEMINI_MODEL not configured; use Scripted Offline Repair";
  }
}

export function getCurrentProject() {
  return currentProject;
}

const evidenceHover = createEvidenceHover({
  getPart: id => catalogById.get(id),
  // The design's supply rail feeds the sensor, so mark it on the sensor's
  // supply gauge. A controller's input range is a different net.
  getRailMv: part => (part?.role === "emg_sensor" ? currentProject?.device_spec.wiring.supply_rail_mv : null),
});

function catalogIdForGroup(groupId) {
  if (!currentProject) return null;
  const comps = currentProject.device_spec.components;
  if (groupId === "sensor-2") return comps.find(c => c.role === "emg_sensor")?.catalog_id ?? null;
  const comp = comps.find(c => c.instance_id === groupId);
  if (comp) return comp.catalog_id;
  const node = currentProject.manifest?.nodes.find(n => (n.part_instance_id || n.id) === groupId && n.catalog_id);
  return node?.catalog_id ?? null;
}

let evidencePoll = null;
async function refreshEvidenceStrip() {
  const strip = $("#sb-evidence");
  const index = await prefetchAllEvidence();
  if (!strip || !index) return;
  const states = Object.entries(index.parts);
  const ready = states.filter(([, s]) => s !== "pending").length;
  const total = Object.keys(index.documents).length;
  const docs = Object.values(index.documents).reduce((a, b) => a + b, 0);
  strip.replaceChildren(
    ...Object.keys(index.documents).map(id => {
      const dot = el("i", "", index.parts[id] === "pending" ? "pending" : index.parts[id] ? "ready" : "");
      dot.title = `${catalogById.get(id)?.name || id}: ${index.parts[id] || "queued"}`;
      return dot;
    }),
    el(
      "span",
      index.reducto_enabled
        ? `${ready}/${total} parts · ${docs} docs`
        : `${total} parts · catalog only`
    )
  );
  clearTimeout(evidencePoll);
  if (states.some(([, s]) => s === "pending") || ready < total) {
    evidencePoll = setTimeout(refreshEvidenceStrip, 2500);
  }
}

function ensureViewer() {
  viewerPromise ??= import("./assembly-viewer.js")
    .then(
      ({ AssemblyViewer }) =>
        new AssemblyViewer(
          $("#assembly-canvas"),
          pickedId => selectComponentOrNode(pickedId, { switchTab: true }),
          () => {
            $("#viewport-status").textContent =
              "WebGL context lost. Inspect BOM, Lean proofs, or download GLB.";
          },
          (groupId, x, y) => evidenceHover.show(groupId && catalogIdForGroup(groupId), x, y)
        )
    )
    .catch(() => null);
  return viewerPromise;
}

export async function loadProjectIntoWorkbench(project, report = null) {
  if (!project) return;
  if (
    currentProject &&
    currentProject.project_id === project.project_id &&
    project.revision < currentProject.revision
  ) {
    // Reject out-of-order stale response
    return;
  }
  if (currentProject?.project_id !== project.project_id || currentProject?.revision !== project.revision) {
    clearValidation($("#project-validation-results"));
    $("#btn-validate-project").disabled = false;
    $("#btn-validate-project").textContent = "Validate sources & proofs";
  }
  const isNewProject = !currentProject || currentProject.project_id !== project.project_id;
  currentProject = project;
  if (report) lastReport = report;
  for (const [id, part] of Object.entries(project.catalog_snapshot || {})) {
    catalogById.set(id, part);
  }

  $("#brief-view").hidden = true;
  $("#research-view").hidden = true;
  $("#blocked-view").hidden = true;
  $("#workbench-view").hidden = false;
  $("#engineering-statusbar").hidden = false;
  $("#Capabilities-pill").hidden = true;
  $("#nav-context").textContent = "Workbench";

  if (isNewProject) {
    refreshEvidenceStrip();
    loadedGlbKey = null;
    selectedGroupId = "board";
    $("#repair-outcome-banner").hidden = true;
  }

  renderStatusBar(project);
  renderLeftControls(project);
  renderBom(project);
  renderSceneChips(project);
  renderInspector(project);
  renderProofsTab(project);
  renderShopTab(project);
  renderActivityDrawer(project);
  renderDiffBanner(project);

  await sync3dViewport(project, { keepView: !isNewProject });
}

async function sync3dViewport(project, { keepView = true } = {}) {
  const warningBanner = $("#geometry-warning-banner");
  if (project.geometry_error) {
    warningBanner.textContent =
      `Geometry error in Rev ${project.revision}: ${project.geometry_error}` +
      (project.manifest ? ` (preserving last valid assembly from Rev ${project.geometry_source_revision})` : "");
    warningBanner.hidden = false;
  } else if (project.verification.failed_count > 0) {
    warningBanner.textContent =
      `Electrical/constraint violation active in Rev ${project.revision} — inspect Lean 4 tab to repair.`;
    warningBanner.hidden = false;
  } else {
    warningBanner.hidden = true;
  }

  const fitTag = $("#hud-fit-tag");
  if (project.geometry_error) {
    fitTag.textContent = "✕ Geometry Error";
    fitTag.className = "hud-pill warn";
  } else {
    fitTag.textContent = `✓ Clearance ≥ ${project.device_spec.mechanical.clearance_mm} mm`;
    fitTag.className = "hud-pill pass";
  }

  if (project.manifest?.envelope_mm) {
    $("#hud-envelope-tag").textContent =
      project.manifest.envelope_mm.map(v => numFmt.format(v)).join(" × ") + " mm";
  }
  const srcRev = project.geometry_source_revision ?? project.revision;
  $("#hud-rev-tag").textContent =
    srcRev === project.revision
      ? `Rev ${project.revision} · ${project.manifest?.parameters.wrist_circumference_mm ?? 170} mm wrist`
      : `Mesh from Rev ${srcRev} · Active Spec Rev ${project.revision}`;

  if (!project.glb_url || !project.manifest) {
    $("#viewport-status").textContent = "No validated 3D assembly available.";
    return;
  }

  const nextGlbKey = `${project.project_id}:${srcRev}`;
  if (loadedGlbKey === nextGlbKey && viewer?.model) {
    viewer.setSelection(selectedGroupId);
    return;
  }

  $("#hud-busy").hidden = false;
  if (!viewer?.model) {
    $("#viewport-status").textContent = "Loading 3D assembly…";
  }
  try {
    viewer = await ensureViewer();
    if (!viewer || viewer.contextLost) {
      $("#viewport-status").textContent =
        "3D WebGL preview unavailable in this browser. Inspect BOM & download GLB.";
      return;
    }
    const glbFetchUrl = `/api/prototypes/${project.project_id}/model.glb?revision=${project.revision}`;
    const loaded = await viewer.load(glbFetchUrl, project.manifest, { keepView });
    if (loaded) {
      loadedGlbKey = nextGlbKey;
      viewer.setSelection(selectedGroupId);
      $("#viewport-status").textContent = "";
    }
  } catch {
    $("#viewport-status").textContent = "Could not render 3D model. Download GLB to inspect.";
  } finally {
    $("#hud-busy").hidden = true;
  }
}

function renderStatusBar(project) {
  const { cost, verification, device_spec } = project;
  $("#sb-project-name").textContent = device_spec.project_name;
  $("#sb-revision").textContent = `Rev ${project.revision}`;
  const modeTag = $("#sb-exec-mode");
  modeTag.textContent = project.mode === "offline" ? "Offline Fixture" : `${String(project.model).startsWith("claude") ? "Claude" : "Gemini"} (${project.model})`;

  $("#sb-total-cost").textContent = formatCents(cost.known_subtotal_usd_cents);
  const unp = $("#sb-unpriced-badge");
  unp.hidden = !cost.has_unpriced_items;
  if (cost.has_unpriced_items) {
    unp.textContent = `+${cost.unpriced_catalog_ids.length} unpriced`;
  }

  const remNode = $("#sb-budget-remaining");
  if (cost.budget_usd_cents === null) {
    remNode.textContent = "No cap set";
    remNode.style.color = "var(--subtle)";
  } else if (cost.budget_status === "exceeded") {
    const over = Math.abs(cost.budget_remaining_usd_cents ?? 0);
    remNode.textContent =
      over === 0 && cost.budget_exclusive
        ? `At ${formatCents(cost.budget_usd_cents)} strict (<) limit`
        : `${formatCents(over)} over ${formatCents(cost.budget_usd_cents)}`;
    remNode.style.color = "var(--fail)";
  } else if (cost.budget_status === "incomplete") {
    remNode.textContent = `${formatCents(cost.budget_remaining_usd_cents)} headrm (incomplete)`;
    remNode.style.color = "var(--warn)";
  } else {
    remNode.textContent = `${formatCents(cost.budget_remaining_usd_cents)} under ${formatCents(cost.budget_usd_cents)}`;
    remNode.style.color = "var(--pass)";
  }

  const countsNode = $("#sb-proof-counts");
  countsNode.replaceChildren(
    el("span", `✓ ${verification.verified_count}`, "proof-chip pass"),
    el("span", `✕ ${verification.failed_count + verification.error_count}`, "proof-chip fail"),
    el("span", `? ${verification.unverified_count}`, "proof-chip unknown")
  );

  const overall = $("#sb-overall-status");
  if (verification.failed_count > 0 || verification.error_count > 0 || project.geometry_error) {
    overall.textContent = "✕ VIOLATION";
    overall.dataset.tone = "fail";
  } else if (cost.has_unpriced_items) {
    overall.textContent = "? INCOMPLETE BOM";
    overall.dataset.tone = "warn";
  } else {
    overall.textContent = "✓ VERIFIED READY";
    overall.dataset.tone = "pass";
  }

  $("#btn-undo").disabled = project.revision <= 1;
  $("#btn-reset-rev1").disabled = project.revision <= 1;
  const glbLink = $("#btn-export-glb");
  if (project.glb_url) {
    glbLink.href = project.glb_url;
    glbLink.hidden = false;
  } else {
    glbLink.hidden = true;
  }
}

function renderLeftControls(project) {
  const { requirements, mechanical, components, wiring } = project.device_spec;

  $("#cfg-transport").value = requirements.transport;
  $("#cfg-budget-mode").value = requirements.budget_exclusive ? "exclusive" : "inclusive";
  $("#cfg-budget-dollars").value =
    requirements.budget_usd_cents !== null
      ? (requirements.budget_usd_cents / 100).toFixed(requirements.budget_usd_cents % 100 ? 2 : 0)
      : "";
  $("#cfg-gestures").value = (requirements.gestures || []).join(", ");

  const wrist = mechanical.wrist_circumference_mm ?? 170;
  $("#cfg-wrist-slider").value = String(wrist);
  $("#cfg-wrist-input").value = String(wrist);
  $("#wrist-live-readout").textContent = `${numFmt.format(wrist)} mm`;
  $("#cfg-wall-input").value = String(mechanical.wall_mm);
  $("#cfg-clearance-input").value = String(mechanical.clearance_mm);

  // Controller dropdown
  const ctrlComp = components.find(c => c.role === "controller");
  const sensComp = components.find(c => c.role === "emg_sensor");
  const ctrlSelect = $("#cfg-controller");
  const controllers = [...catalogById.values()].filter(p => p.role === "controller");
  ctrlSelect.replaceChildren(
    ...controllers.map(p => {
      const priceLabel = p.quote ? formatCents(p.quote.unit_price_usd_cents) : "unquoted ref";
      const opt = el("option", `${p.name} (${priceLabel})`);
      opt.value = p.id;
      return opt;
    })
  );
  if (ctrlComp) ctrlSelect.value = ctrlComp.catalog_id;
  if (!ctrlSelect.dataset.evidenceBound) {
    // Hovering the controller picker previews the selected part's datasheet bundle;
    // every alternate was already read in the background, so swaps are instant.
    ctrlSelect.dataset.evidenceBound = "1";
    ctrlSelect.addEventListener("pointermove", e => evidenceHover.show(ctrlSelect.value, e.clientX, e.clientY));
    ctrlSelect.addEventListener("pointerleave", () => evidenceHover.hide());
    ctrlSelect.addEventListener("change", () => evidenceHover.hide());
  }

  // Electrical controls populated from active controller
  const activeCtrl = ctrlComp ? catalogById.get(ctrlComp.catalog_id) : null;
  const rails = activeCtrl?.available_rails_mv?.length ? activeCtrl.available_rails_mv : [3300, 5000];
  const railSelect = $("#cfg-rail");
  const railSet = new Set([...rails, wiring.supply_rail_mv]);
  railSelect.replaceChildren(
    ...[...railSet].sort((a, b) => a - b).map(mv => {
      const opt = el(
        "option",
        mv === 3300 ? "3300 mV (3.3V Regulated)" : mv === 5000 ? "5000 mV (5V USB / Rail)" : `${mv} mV`
      );
      opt.value = String(mv);
      return opt;
    })
  );
  railSelect.value = String(wiring.supply_rail_mv);

  const candidateAdcPins = new Set([
    ...(activeCtrl?.adc_pins || []),
    ...(activeCtrl?.reserved_pins || []).slice(0, 2),
    ...(wiring.signal_pins || []),
  ]);
  const annotatePin = pin => {
    const notes = [];
    if (activeCtrl?.board_restricted_adc_pins?.includes(pin)) notes.push("auto-flash conflict");
    if (activeCtrl?.adc_wifi_conflict_pins?.includes(pin)) notes.push("ADC2 / Wi-Fi conflict");
    if (activeCtrl?.reserved_pins?.includes(pin)) notes.push("SPI flash reserved");
    if (activeCtrl && !activeCtrl.adc_pins.includes(pin) && !notes.length) notes.push("invalid on board");
    return notes.length ? `${pin} (${notes.join(", ")})` : pin;
  };

  const sig1 = $("#cfg-sig-pin-1");
  sig1.replaceChildren(
    ...[...candidateAdcPins].map(pin => {
      const opt = el("option", annotatePin(pin));
      opt.value = pin;
      return opt;
    })
  );
  sig1.value = wiring.signal_pins[0] || "";

  const sensQty = sensComp?.quantity ?? 1;
  const fieldSig2 = $("#field-sig-pin-2");
  fieldSig2.hidden = sensQty < 2;
  if (sensQty >= 2) {
    const sig2 = $("#cfg-sig-pin-2");
    sig2.replaceChildren(
      ...[...candidateAdcPins].map(pin => {
        const opt = el("option", annotatePin(pin));
        opt.value = pin;
        return opt;
      })
    );
    sig2.value = wiring.signal_pins[1] || wiring.signal_pins[0] || "";
  }

  const ledSelect = $("#cfg-led-pin");
  const candidateLedPins = new Set([
    ...(activeCtrl?.digital_pins || []),
    ...(wiring.status_led_pin ? [wiring.status_led_pin] : []),
  ]);
  const ledOpts = [el("option", "None (disabled)")];
  ledOpts[0].value = "";
  for (const pin of candidateLedPins) {
    const tags = [];
    if (activeCtrl?.input_only_pins?.includes(pin)) tags.push("input-only GPI");
    if (activeCtrl?.reserved_pins?.includes(pin)) tags.push("reserved");
    if (activeCtrl && !activeCtrl.digital_pins.includes(pin) && !tags.length) tags.push("invalid");
    const opt = el("option", tags.length ? `${pin} (${tags.join(", ")})` : pin);
    opt.value = pin;
    ledOpts.push(opt);
  }
  ledSelect.replaceChildren(...ledOpts);
  ledSelect.value = wiring.status_led_pin || "";
}

function renderBom(project) {
  const { cost } = project;
  const list = $("#bom-list");
  list.replaceChildren(
    ...cost.line_items.map(item => {
      const card = el("div", "", "bom-item");
      card.setAttribute("role", "listitem");
      card.dataset.selected = String(selectedGroupId === item.instance_id);

      const top = el("div", "", "bom-item-top");
      const pickBtn = el("button", "", "bom-select-btn");
      pickBtn.type = "button";
      pickBtn.append(
        el("strong", item.name),
        el("small", `${item.manufacturer} · ${item.sku}`)
      );
      pickBtn.addEventListener("click", () =>
        selectComponentOrNode(item.instance_id, { switchTab: true })
      );
      evidenceHover.bind(pickBtn, item.catalog_id);

      const priceCol = el("div", "", "bom-price-col");
      const extText =
        item.extended_usd_cents !== null ? formatCents(item.extended_usd_cents) : "Unpriced";
      const srcLabel =
        item.pricing_source === "merchant_offer"
          ? `Shop: ${item.selected_offer?.seller_name}`
          : item.pricing_source === "catalog_quote"
          ? `${item.catalog_vendor} ref`
          : "No USD quote";
      const srcCls =
        item.pricing_source === "merchant_offer"
          ? "bom-src-tag live"
          : item.pricing_source === "unpriced"
          ? "bom-src-tag unpriced"
          : "bom-src-tag";
      priceCol.append(el("span", extText, "bom-ext-price"), el("span", srcLabel, srcCls));
      top.append(pickBtn, priceCol);
      card.append(top);

      const controls = el("div", "", "bom-item-controls");
      const unitInfo =
        item.effective_unit_usd_cents !== null
          ? `${formatCents(item.effective_unit_usd_cents)}/ea`
          : "Unit unquoted";
      controls.append(el("span", unitInfo));

      if (item.role === "emg_sensor") {
        const stepper = el("div", "", "qty-stepper");
        const minus = el("button", "−");
        minus.type = "button";
        minus.ariaLabel = "Decrease sensor quantity";
        minus.disabled = item.quantity <= 1;
        minus.addEventListener("click", () => queueDesignEdit({ sensor_quantity: item.quantity - 1 }));

        const qtyVal = el("span", `×${item.quantity}`);

        const plus = el("button", "+");
        plus.type = "button";
        plus.ariaLabel = "Increase sensor quantity";
        plus.disabled = item.quantity >= 2;
        plus.addEventListener("click", () => queueDesignEdit({ sensor_quantity: item.quantity + 1 }));

        stepper.append(minus, qtyVal, plus);
        controls.append(stepper);
      } else {
        controls.append(el("span", `Qty ×${item.quantity}`, "tabular"));
      }
      card.append(controls);

      for (const note of item.notes || []) {
        card.append(el("p", note, "bom-note"));
      }
      return card;
    })
  );

  $("#bom-cat-subtotal").textContent =
    cost.catalog_subtotal_usd_cents !== null
      ? formatCents(cost.catalog_subtotal_usd_cents)
      : "Incomplete ref";
  $("#bom-known-subtotal").textContent =
    formatCents(cost.known_subtotal_usd_cents) +
    (cost.has_unpriced_items ? " (partial)" : "");

  const deltasBox = $("#bom-deltas");
  deltasBox.replaceChildren(
    ...(cost.deltas_from_previous || []).map(d => el("div", d, "delta-pill"))
  );
  $("#bom-disclaimer").textContent = cost.scope_disclaimer;
}

function getSceneGroups(manifest) {
  const groups = new Map();
  if (!manifest) return groups;
  for (const node of manifest.nodes) {
    const gid = node.part_instance_id || node.id;
    if (!groups.has(gid) || node.id === gid) {
      groups.set(gid, node);
    }
  }
  return groups;
}

function renderSceneChips(project) {
  const bar = $("#scene-object-bar");
  const groups = getSceneGroups(project.manifest);
  if (!groups.has(selectedGroupId) && groups.size > 0) {
    selectedGroupId = groups.keys().next().value;
  }
  bar.replaceChildren(
    ...Array.from(groups, ([gid, node]) => {
      const btn = el("button", node.label, "scene-chip");
      btn.type = "button";
      btn.setAttribute("aria-pressed", String(gid === selectedGroupId));
      btn.addEventListener("click", () => selectComponentOrNode(gid, { switchTab: true }));
      const catalogId = catalogIdForGroup(gid);
      if (catalogId) evidenceHover.bind(btn, catalogId);
      return btn;
    })
  );
}

export function selectComponentOrNode(groupId, { switchTab = false } = {}) {
  selectedGroupId = groupId;
  viewer?.setSelection(groupId);
  if (currentProject) {
    renderBom(currentProject);
    renderSceneChips(currentProject);
    renderInspector(currentProject);
  }
  if (switchTab) switchInspectorTab("part");
}

function renderInspector(project) {
  const container = $("#part-inspector-content");
  const groups = getSceneGroups(project.manifest);
  const sceneNode = groups.get(selectedGroupId);
  const bomItem = project.cost.line_items.find(
    item =>
      item.instance_id === selectedGroupId ||
      (selectedGroupId === "sensor-2" && item.role === "emg_sensor")
  );
  const part = bomItem
    ? catalogById.get(bomItem.catalog_id)
    : sceneNode?.catalog_id
    ? catalogById.get(sceneNode.catalog_id)
    : null;

  container.replaceChildren();
  if (!sceneNode && !part) {
    container.append(el("div", "Select a component in the 3D scene or BOM to inspect.", "empty-state"));
    return;
  }

  const header = el("div", "", "insp-header");
  header.append(
    el("span", part ? `${part.role.replace("_", " ")} · ${part.manufacturer}` : "Parametric Enclosure Solid", "insp-role"),
    el("h3", part ? part.name : sceneNode.label),
    el("div", part ? `SKU: ${part.sku}` : `Scene ID: ${sceneNode.id}`, "insp-sku")
  );
  container.append(header);

  const kv = el("div", "", "kv-grid");
  const addKv = (label, value) => {
    const box = el("div", "", "kv-box");
    box.append(el("span", label), el("strong", value));
    kv.append(box);
  };

  if (sceneNode) {
    const dims = sceneNode.geometry.size_mm.map(v => numFmt.format(v)).join(" × ") + " mm";
    addKv("3D Envelope", dims);
    addKv("CAD Fidelity", FIDELITY_LABELS[sceneNode.fidelity] || sceneNode.fidelity);
  }
  if (part) {
    if (part.role === "controller") {
      addKv("ADC Ceiling", part.adc_max_mv ? `${part.adc_max_mv} mV` : "Unknown");
      addKv("Transports", (part.transports || []).join(", ").toUpperCase() || "None");
      addKv("Active Supply Rail", `${project.device_spec.wiring.supply_rail_mv} mV`);
      addKv(
        "Bound GPIOs",
        [
          ...project.device_spec.wiring.signal_pins,
          ...(project.device_spec.wiring.status_led_pin
            ? [`LED:${project.device_spec.wiring.status_led_pin}`]
            : []),
        ].join(", ")
      );
    } else if (part.role === "emg_sensor") {
      const range = part.supply_range_mv
        ? `${part.supply_range_mv[0]}–${part.supply_range_mv[1]} mV`
        : "Unknown";
      addKv("Rated Supply", range);
      addKv("Signal Output", part.output_scales_with_supply ? "0–VIN Analog Envelope" : "Analog");
      const chIdx = selectedGroupId === "sensor-2" ? 1 : 0;
      addKv("Bound ADC Pin", project.device_spec.wiring.signal_pins[chIdx] || "Unbound");
      addKv(
        "Unit Cost",
        bomItem?.effective_unit_usd_cents !== null
          ? formatCents(bomItem.effective_unit_usd_cents)
          : "Unpriced"
      );
    }
  } else {
    addKv("Wrist Size", `${project.device_spec.mechanical.wrist_circumference_mm ?? 170} mm`);
    addKv(
      "Wall / Clearance",
      `${project.device_spec.mechanical.wall_mm} / ${project.device_spec.mechanical.clearance_mm} mm`
    );
  }
  container.append(kv);

  // Sourced references
  const links = [];
  if (part) {
    (part.technical_sources || []).forEach((url, idx) => {
      links.push([idx === 0 ? "Manufacturer Datasheet ↗" : `Tech Ref ${idx + 1} ↗`, url]);
    });
    if (part.quote?.url) {
      links.push([`${part.quote.vendor} Quote (${formatCents(part.quote.unit_price_usd_cents)}) ↗`, part.quote.url]);
    }
  }
  if (sceneNode?.source) {
    links.push(["Mechanical Drawing ↗", sceneNode.source]);
  }
  if (links.length) {
    container.append(el("h4", "Sourced Engineering Evidence", "insp-subhead"));
    const linkWrap = el("div", "", "source-links");
    for (const [label, href] of links) {
      try {
        const parsed = new URL(href);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          const a = el("a", label, "source-link");
          a.href = parsed.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          linkWrap.append(a);
        }
      } catch {
        // ignore invalid URL
      }
    }
    container.append(linkWrap);
  }
  if (part) {
    renderEvidenceBundle(
      container,
      part,
      part.role === "emg_sensor" ? project.device_spec.wiring.supply_rail_mv : null
    );
  }

  // Relevant verification checks
  container.append(el("h4", "Applicable Verification Checks", "insp-subhead"));
  const checkList = el("ul", "", "insp-checks");
  const relevantObs = part
    ? project.verification.obligations.filter(ob =>
        part.role === "controller"
          ? ["adc_input_voltage", "gpio_pin_assignments", "wireless_transport_support", "core_parts_budget"].includes(ob.id)
          : ["sensor_supply_voltage", "adc_input_voltage", "rail_current_budget", "core_parts_budget"].includes(ob.id)
      )
    : (project.manifest?.findings || []).map(f => ({
        title: f.check.replaceAll("_", " "),
        status: f.status === "pass" ? "verified" : f.status === "fail" ? "failed" : "unverified",
        summary: f.detail,
      }));

  for (const ob of relevantObs) {
    const badge = STATUS_BADGES[ob.status] || STATUS_BADGES.unverified;
    const li = el("li");
    const row = el("div", "", "ob-top");
    row.append(
      el("strong", ob.title),
      el("span", `${badge.icon} ${badge.label}`, `status-badge ${badge.cls}`)
    );
    li.append(row, el("p", ob.summary, "ob-summary"));
    checkList.append(li);
  }
  container.append(checkList);

  // Contextual actions for part replacement & procurement
  if (part) {
    container.append(el("h4", "Actions & Procurement", "insp-subhead"));
    const actionWrap = el("div", "", "source-links");
    const shopBtn = el("button", `Find ${part.sku} on Shop.dev`, "mini-btn accent-outline");
    shopBtn.type = "button";
    shopBtn.addEventListener("click", () => {
      $("#shop-part-filter").value = part.id;
      switchInspectorTab("shop");
      triggerShopSearch(part.id);
    });
    actionWrap.append(shopBtn);

    if (part.role === "controller") {
      const alt = [...catalogById.values()].find(
        p => p.role === "controller" && p.id !== part.id
      );
      if (alt) {
        const swapBtn = el("button", `Swap to ${alt.name}`, "mini-btn");
        swapBtn.type = "button";
        swapBtn.addEventListener("click", () => queueDesignEdit({ controller_id: alt.id }));
        actionWrap.append(swapBtn);
      }
    }
    container.append(actionWrap);
  }
}

function renderProofsTab(project) {
  const { verification } = project;
  $("#proof-kernel-label").textContent = verification.lean_version
    ? verification.lean_version.split(",")[0]
    : "Lean 4 Formal Kernel";
  $("#proof-rev-stamp").textContent = `Checked Rev ${verification.revision}`;

  const badge = $("#tab-proof-badge");
  if (verification.failed_count > 0 || verification.error_count > 0) {
    badge.textContent = `${verification.failed_count + verification.error_count} fail`;
    badge.className = "tab-count fail";
  } else {
    badge.textContent = `${verification.verified_count}/${verification.obligations.length}`;
    badge.className = "tab-count pass";
  }

  $("#repair-card").hidden = verification.failed_count === 0;
  setLiveGeminiStatus(liveGeminiAvailable);

  const list = $("#obligations-list");
  list.replaceChildren(
    ...verification.obligations.map(ob => {
      const st = STATUS_BADGES[ob.status] || STATUS_BADGES.unverified;
      const card = el("article", "", "ob-card");
      card.dataset.status = ob.status;

      const top = el("div", "", "ob-top");
      top.append(
        el("strong", ob.title),
        el("span", `${st.icon} ${st.label}`, `status-badge ${st.cls}`)
      );
      card.append(top, el("p", ob.summary, "ob-summary"));

      const details = el("details", "", "ob-tech");
      details.append(el("summary", "Formal evidence & inputs"));
      const lines = [];
      if (ob.lean_theorem) lines.push(ob.lean_theorem);
      if (ob.axioms_used) {
        lines.push(
          `-- Kernel axioms: ${ob.axioms_used.length ? ob.axioms_used.join(", ") : "none (pure reduction)"}`
        );
      }
      if (ob.diagnostic) lines.push(`-- Result: ${ob.diagnostic}`);
      lines.push(`-- Witness inputs: ${JSON.stringify(ob.inputs)}`);
      details.append(el("pre", lines.join("\n"), "code-block"));
      card.append(details);
      return card;
    })
  );

  $("#raw-lean-code").textContent =
    verification.lean_source || "-- No checkable Lean obligations emitted for this revision.";
}

function renderShopTab(project) {
  const filterSelect = $("#shop-part-filter");
  const prevVal = filterSelect.value;
  const uniqueParts = [];
  const seen = new Set();
  for (const comp of project.device_spec.components) {
    if (!seen.has(comp.catalog_id) && catalogById.has(comp.catalog_id)) {
      seen.add(comp.catalog_id);
      uniqueParts.push([comp, catalogById.get(comp.catalog_id)]);
    }
  }
  const allOpt = el("option", "All active BOM parts");
  allOpt.value = "";
  filterSelect.replaceChildren(
    allOpt,
    ...uniqueParts.map(([, part]) => {
      const opt = el("option", `${part.sku} · ${part.name}`);
      opt.value = part.id;
      return opt;
    })
  );
  if ([...filterSelect.options].some(o => o.value === prevVal)) {
    filterSelect.value = prevVal;
  }

  const resultsMap = project.procurement?.results_by_part || {};
  const totalOffers = Object.values(resultsMap).reduce(
    (acc, r) => acc + (r.offers?.length || 0),
    0
  );
  const shopBadge = $("#tab-shop-badge");
  shopBadge.textContent = totalOffers ? String(totalOffers) : "";

  const container = $("#shop-results-container");
  container.replaceChildren();

  if (Object.keys(resultsMap).length === 0) {
    container.append(
      el(
        "div",
        "No live merchant search run yet. Click 'Search BOM Offers' to query real Shopify merchants via https://mcp.shop.com/.",
        "empty-state"
      )
    );
    return;
  }

  for (const [comp, part] of uniqueParts) {
    const res = resultsMap[part.id];
    if (!res) continue;

    const group = el("section", "", "shop-part-group");
    const head = el("h3");
    head.append(el("span", `${part.name} (${part.sku})`));
    if (comp.selected_offer_id) {
      const clearBtn = el("button", "Use Catalog Quote", "mini-btn");
      clearBtn.type = "button";
      clearBtn.addEventListener("click", () => selectMerchantOffer(comp.instance_id, null));
      head.append(clearBtn);
    }
    group.append(head);

    for (const warn of res.warnings || []) {
      group.append(el("div", `Shop MCP Warning: ${warn}`, "shop-warning"));
    }

    if (res.status === "error") {
      group.append(
        el("div", `Shop MCP error: ${res.error_message || "Request failed."}`, "inline-error")
      );
      container.append(group);
      continue;
    }

    if (!res.offers || res.offers.length === 0) {
      group.append(
        el(
          "div",
          `No verified electronics offers found on Shop for '${res.query}'. Curated distributor reference remains active.`,
          "empty-state"
        )
      );
      container.append(group);
      continue;
    }

    for (const offer of res.offers) {
      const isSelected = comp.selected_offer_id === offer.offer_id;
      const card = el("article", "", "offer-card");
      card.dataset.selected = String(isSelected);

      const top = el("div", "", "offer-head");
      top.append(el("strong", offer.title), el("span", offer.formatted_price, "offer-price"));
      card.append(top);
      card.append(
        el(
          "div",
          `${offer.seller_name}${offer.seller_domain ? ` (${offer.seller_domain})` : ""} · ${
            offer.available ? "In stock" : "Out of stock"
          }`,
          "offer-seller"
        )
      );

      const badges = el("div", "", "offer-badges");
      badges.append(
        el("span", MATCH_LABELS[offer.match_kind] || offer.match_kind, `match-tag ${offer.match_kind}`)
      );
      if (offer.currency !== "USD") {
        badges.append(el("span", `Foreign currency (${offer.currency})`, "match-tag bundle_or_pack"));
      }
      card.append(badges);
      card.append(el("p", offer.match_note, "offer-note"));

      const actions = el("div", "", "offer-actions");
      if (offer.match_kind === "exact_match" && offer.available) {
        const selectBtn = el(
          "button",
          isSelected ? "✓ Active BOM Offer" : "Select Offer for BOM",
          "mini-btn"
        );
        selectBtn.type = "button";
        selectBtn.disabled = isSelected;
        selectBtn.addEventListener("click", () =>
          selectMerchantOffer(comp.instance_id, offer.offer_id)
        );
        actions.append(selectBtn);
      }

      const inspectBtn = el("button", "Inspect Variants", "mini-btn");
      inspectBtn.type = "button";
      const drawer = el("div", "", "variant-drawer");
      drawer.hidden = true;
      inspectBtn.addEventListener("click", () => inspectShopProduct(offer.product_id, drawer, inspectBtn));
      actions.append(inspectBtn);

      const storeLink = el("a", "Open Merchant ↗", "source-link");
      storeLink.href = offer.url;
      storeLink.target = "_blank";
      storeLink.rel = "noopener noreferrer";
      actions.append(storeLink);

      card.append(actions, drawer);
      group.append(card);
    }
    container.append(group);
  }
}

function renderActivityDrawer(project) {
  const entries = project.activity || [];
  $("#drawer-count-badge").textContent = `${entries.length} event${entries.length === 1 ? "" : "s"}`;
  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    $("#drawer-latest-summary").textContent = `[Rev ${last.revision}] ${last.title} — ${last.detail}`;
  }
  const list = $("#activity-timeline");
  list.replaceChildren(
    ...[...entries].reverse().map(entry => {
      const li = el("li", "", "activity-row");
      li.append(
        el("span", `Rev ${entry.revision}`, "rev-pill"),
        el("span", entry.actor.replace("_", " "), "actor-badge"),
        el("span", `${entry.title}: ${entry.detail}`)
      );
      return li;
    })
  );
}

function renderDiffBanner(project) {
  const revs = project.revisions || [];
  const fromSel = $("#compare-from");
  const toSel = $("#compare-to");
  if (revs.length < 2) {
    $("#diff-banner").hidden = true;
    $("#btn-toggle-compare").setAttribute("aria-pressed", "false");
    return;
  }

  fromSel.replaceChildren(
    ...revs.map(r => {
      const o = el("option", `Rev ${r.revision}: ${r.label}`);
      o.value = String(r.revision);
      return o;
    })
  );
  toSel.replaceChildren(
    ...revs.map(r => {
      const o = el("option", `Rev ${r.revision}: ${r.label}`);
      o.value = String(r.revision);
      return o;
    })
  );

  if (project.diff_from_previous) {
    fromSel.value = String(project.diff_from_previous.from_revision);
    toSel.value = String(project.diff_from_previous.to_revision);
    populateDiffColumns(project.diff_from_previous);
  }
}

function populateDiffColumns(diff) {
  const cols = $("#diff-columns");
  const makeCol = (heading, items) => {
    const box = el("div", "", "diff-col");
    box.append(el("h4", heading));
    const ul = el("ul");
    for (const line of items?.length ? items : ["Unchanged"]) {
      ul.append(el("li", line));
    }
    box.append(ul);
    return box;
  };
  cols.replaceChildren(
    makeCol("Geometry & Fit", diff.geometry_changes),
    makeCol("BOM & Budget", diff.cost_changes),
    makeCol("Lean 4 Verification", diff.verification_changes)
  );
}

export function switchInspectorTab(tabName) {
  activeTab = tabName;
  for (const name of ["part", "proofs", "shop"]) {
    const isTarget = name === tabName;
    $(`#tab-btn-${name}`).setAttribute("aria-selected", String(isTarget));
    $(`#tab-${name}`).hidden = !isTarget;
  }
}

// Coalescing, serialized design-edit pipeline
export function queueDesignEdit(patch) {
  if (!currentProject) return;
  $("#cfg-error-msg").hidden = true;
  coalescedEdit = { ...(coalescedEdit || {}), ...patch };
  drainEditQueue();
}

async function drainEditQueue() {
  if (mutationInFlight || !coalescedEdit || !currentProject) return;
  mutationInFlight = true;
  const syncInd = $("#edit-sync-indicator");
  const overall = $("#sb-overall-status");
  syncInd.textContent = "Updating spec…";
  overall.textContent = "↻ UPDATING…";
  overall.dataset.tone = "busy";

  try {
    while (coalescedEdit && currentProject) {
      const batch = coalescedEdit;
      coalescedEdit = null;
      const body = { ...batch, base_revision: currentProject.revision };
      const response = await fetch(
        `/api/projects/${encodeURIComponent(currentProject.project_id)}/edits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        // Sync latest state from server cleanly on concurrent modification
        const latestResp = await fetch(
          `/api/projects/${encodeURIComponent(currentProject.project_id)}`
        );
        if (latestResp.ok) {
          await loadProjectIntoWorkbench(await latestResp.json());
        }
        showConfigError("Project updated in another request; synced latest revision.");
        break;
      }
      if (!response.ok) {
        const detail =
          typeof data.detail === "string"
            ? data.detail
            : Array.isArray(data.detail)
            ? data.detail.map(e => e.msg).join("; ")
            : "Invalid design parameter.";
        showConfigError(detail);
        renderStatusBar(currentProject);
        break;
      }
      await loadProjectIntoWorkbench(data);
      // Auto-open diff banner on meaningful edits
      if (data.diff_from_previous) {
        $("#diff-banner").hidden = false;
        $("#btn-toggle-compare").setAttribute("aria-pressed", "true");
      }
      // Auto-switch to Proofs tab if edit introduced a formal failure
      if (data.verification.failed_count > 0 && activeTab !== "proofs") {
        switchInspectorTab("proofs");
      }
    }
  } catch {
    showConfigError("Network error while updating specification.");
    if (currentProject) renderStatusBar(currentProject);
  } finally {
    mutationInFlight = false;
    syncInd.textContent = "";
  }
}

function showConfigError(msg) {
  const errNode = $("#cfg-error-msg");
  errNode.textContent = msg;
  errNode.hidden = false;
}

async function restoreToRevision(targetRev) {
  if (!currentProject || mutationInFlight) return;
  mutationInFlight = true;
  $("#edit-sync-indicator").textContent = `Restoring Rev ${targetRev}…`;
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(currentProject.project_id)}/restore`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_revision: currentProject.revision,
          target_revision: targetRev,
        }),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showConfigError(data.detail || "Could not restore revision.");
      return;
    }
    await loadProjectIntoWorkbench(data);
  } finally {
    mutationInFlight = false;
    $("#edit-sync-indicator").textContent = "";
  }
}

async function runRepair(mode) {
  if (!currentProject || mutationInFlight) return;
  mutationInFlight = true;
  const banner = $("#repair-outcome-banner");
  banner.hidden = false;
  banner.dataset.ok = "true";
  banner.textContent =
    mode === "live"
      ? "Running Claude repair agent & re-verifying in Lean 4…"
      : "Running scripted offline repair & re-verifying in Lean 4…";
  $("#btn-repair-live").disabled = true;
  $("#btn-repair-sample").disabled = true;

  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(currentProject.project_id)}/repair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_revision: currentProject.revision, mode }),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      banner.dataset.ok = "false";
      banner.textContent = data.detail || "Repair request could not complete.";
      return;
    }
    await loadProjectIntoWorkbench(data.project);
    banner.hidden = false;
    banner.dataset.ok = String(data.repaired);
    const srcLabel = data.actor === "claude" ? "Claude" : data.actor === "gemini" ? "Gemini" : "Offline scripted repair";
    banner.textContent =
      (data.repaired
        ? `✓ Repaired by ${srcLabel} in ${data.attempts} attempt(s) & verified in Lean 4: `
        : `⚠ ${srcLabel} could not resolve all constraints: `) + data.rationale;
    if (data.diff) {
      $("#diff-banner").hidden = false;
      $("#btn-toggle-compare").setAttribute("aria-pressed", "true");
      populateDiffColumns(data.diff);
    }
  } catch {
    banner.dataset.ok = "false";
    banner.textContent = "Network error while running repair.";
  } finally {
    mutationInFlight = false;
    setLiveGeminiStatus(liveGeminiAvailable);
    $("#btn-repair-sample").disabled = false;
  }
}

async function triggerShopSearch(catalogId = null, customQuery = null) {
  if (!currentProject) return;
  const statusMsg = $("#shop-status-msg");
  statusMsg.textContent = "Searching live Shopify catalog via mcp.shop.com…";
  $("#btn-search-all-shop").disabled = true;
  $("#btn-search-custom-shop").disabled = true;
  try {
    const payload = {
      catalog_id: catalogId || null,
      query: customQuery || null,
      country: "US",
      currency: "USD",
    };
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(currentProject.project_id)}/procurement/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      statusMsg.textContent = data.detail || "Shop MCP search failed.";
      return;
    }
    await loadProjectIntoWorkbench(data);
    statusMsg.textContent = "Updated live offers from Shop.dev MCP.";
  } catch {
    statusMsg.textContent = "Could not contact server for Shop MCP search.";
  } finally {
    $("#btn-search-all-shop").disabled = false;
    $("#btn-search-custom-shop").disabled = false;
  }
}

async function inspectShopProduct(productId, drawer, btn) {
  if (!currentProject) return;
  if (!drawer.hidden) {
    drawer.hidden = true;
    return;
  }
  btn.disabled = true;
  drawer.hidden = false;
  drawer.textContent = "Fetching product variants via get_product…";
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(currentProject.project_id)}/procurement/product`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: productId, country: "US", currency: "USD" }),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      drawer.textContent = data.detail || "Could not load product variants.";
      return;
    }
    const lines = (data.variants || []).map(
      v =>
        `${v.price_formatted || v.currency} · ${v.available ? "Available" : "Sold out"}${
          v.seller ? ` (${v.seller})` : ""
        }`
    );
    drawer.replaceChildren(
      el("strong", `${data.title || "Product"} — ${lines.length} featured variant(s)`),
      ...lines.map(l => el("div", l))
    );
  } catch {
    drawer.textContent = "Failed to inspect variants.";
  } finally {
    btn.disabled = false;
  }
}

async function selectMerchantOffer(instanceId, offerId) {
  if (!currentProject || mutationInFlight) return;
  mutationInFlight = true;
  $("#shop-status-msg").textContent = "Applying offer to BOM…";
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(currentProject.project_id)}/procurement/select`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_revision: currentProject.revision,
          instance_id: instanceId,
          offer_id: offerId,
        }),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      $("#shop-status-msg").textContent = data.detail || "Could not select offer.";
      return;
    }
    await loadProjectIntoWorkbench(data);
    $("#shop-status-msg").textContent = offerId
      ? "Applied merchant offer to BOM."
      : "Reverted to curated catalog quote.";
  } finally {
    mutationInFlight = false;
  }
}

export function bindWorkbenchEvents(onNewBrief, onShowGraph) {
  $("#btn-validate-project").addEventListener("click", () => {
    if (!currentProject) return;
    switchInspectorTab("proofs");
    runValidation({
      url: `/api/projects/${encodeURIComponent(currentProject.project_id)}/validate`,
      body: { base_revision: currentProject.revision },
      target: $("#project-validation-results"), button: $("#btn-validate-project"),
    });
  });
  // Status bar actions
  $("#sb-proof-summary").addEventListener("click", () => switchInspectorTab("proofs"));
  $("#sb-pangram-summary")?.addEventListener("click", () => switchInspectorTab("proofs"));
  $("#btn-undo").addEventListener("click", () => {
    if (currentProject && currentProject.revision > 1) {
      restoreToRevision(currentProject.revision - 1);
    }
  });
  $("#btn-reset-rev1").addEventListener("click", () => {
    if (currentProject && currentProject.revision > 1) {
      restoreToRevision(1);
    }
  });
  $("#btn-toggle-compare").addEventListener("click", () => {
    const banner = $("#diff-banner");
    const nextHidden = !banner.hidden;
    banner.hidden = nextHidden;
    $("#btn-toggle-compare").setAttribute("aria-pressed", String(!nextHidden));
  });
  $("#close-diff-banner").addEventListener("click", () => {
    $("#diff-banner").hidden = true;
    $("#btn-toggle-compare").setAttribute("aria-pressed", "false");
  });
  $("#btn-export-json").addEventListener("click", () => {
    if (!currentProject) return;
    const payload = {
      exported_at: new Date().toISOString(),
      research_report: lastReport,
      project: currentProject,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = `forge-project-rev${currentProject.revision}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("#btn-new-brief").addEventListener("click", () => onNewBrief?.());

  // Revision comparison selectors
  const triggerCompare = async () => {
    if (!currentProject) return;
    const fromRev = Number($("#compare-from").value);
    const toRev = Number($("#compare-to").value);
    if (!fromRev || !toRev) return;
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(currentProject.project_id)}/compare?from_rev=${fromRev}&to_rev=${toRev}`
    );
    if (resp.ok) populateDiffColumns(await resp.json());
  };
  $("#compare-from").addEventListener("change", triggerCompare);
  $("#compare-to").addEventListener("change", triggerCompare);

  // Left panel configuration controls
  $("#cfg-transport").addEventListener("change", e =>
    queueDesignEdit({ transport: e.target.value })
  );
  const applyBudget = () => {
    const raw = $("#cfg-budget-dollars").value.trim();
    const exclusive = $("#cfg-budget-mode").value === "exclusive";
    if (!raw) {
      queueDesignEdit({ clear_budget: true, budget_exclusive: exclusive });
      return;
    }
    const dollars = Number(raw);
    if (!Number.isFinite(dollars) || dollars < 0) {
      showConfigError("Enter a valid non-negative USD budget.");
      return;
    }
    queueDesignEdit({
      clear_budget: false,
      budget_usd_cents: Math.round(dollars * 100),
      budget_exclusive: exclusive,
    });
  };
  $("#btn-apply-budget").addEventListener("click", applyBudget);
  $("#cfg-budget-mode").addEventListener("change", applyBudget);
  $("#cfg-budget-dollars").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyBudget();
    }
  });

  const applyGestures = () => {
    const parts = $("#cfg-gestures")
      .value.split(",")
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length) queueDesignEdit({ gestures: parts });
  };
  $("#btn-apply-gestures").addEventListener("click", applyGestures);

  // Wrist debounced slider + numeric input
  $("#cfg-wrist-slider").addEventListener("input", e => {
    const val = Number(e.target.value);
    $("#cfg-wrist-input").value = String(val);
    $("#wrist-live-readout").textContent = `${val} mm`;
    clearTimeout(wristDebounceTimer);
    wristDebounceTimer = setTimeout(() => {
      queueDesignEdit({ wrist_circumference_mm: val });
    }, 170);
  });
  $("#cfg-wrist-input").addEventListener("change", e => {
    const val = Number(e.target.value);
    if (!Number.isFinite(val) || val < 120 || val > 240) {
      showConfigError("Wrist circumference must be between 120 and 240 mm.");
      return;
    }
    $("#cfg-wrist-slider").value = String(val);
    $("#wrist-live-readout").textContent = `${numFmt.format(val)} mm`;
    queueDesignEdit({ wrist_circumference_mm: val });
  });

  $("#cfg-wall-input").addEventListener("change", e => {
    const val = Number(e.target.value);
    if (!Number.isFinite(val) || val < 1.2 || val > 4.0) {
      showConfigError("Wall thickness must be between 1.2 and 4.0 mm.");
      return;
    }
    queueDesignEdit({ wall_mm: val });
  });
  $("#cfg-clearance-input").addEventListener("change", e => {
    const val = Number(e.target.value);
    if (!Number.isFinite(val) || val < 0.8 || val > 4.0) {
      showConfigError("Internal clearance must be between 0.8 and 4.0 mm.");
      return;
    }
    queueDesignEdit({ clearance_mm: val });
  });

  $("#cfg-controller").addEventListener("change", e =>
    queueDesignEdit({ controller_id: e.target.value })
  );

  // Electrical wiring edits
  $("#cfg-rail").addEventListener("change", e =>
    queueDesignEdit({ supply_rail_mv: Number(e.target.value) })
  );
  const updateSignalPins = () => {
    const pins = [$("#cfg-sig-pin-1").value];
    if (!$("#field-sig-pin-2").hidden && $("#cfg-sig-pin-2").value) {
      pins.push($("#cfg-sig-pin-2").value);
    }
    queueDesignEdit({ signal_pins: pins });
  };
  $("#cfg-sig-pin-1").addEventListener("change", updateSignalPins);
  $("#cfg-sig-pin-2").addEventListener("change", updateSignalPins);
  $("#cfg-led-pin").addEventListener("change", e => {
    const val = e.target.value;
    if (!val) queueDesignEdit({ clear_status_led_pin: true });
    else queueDesignEdit({ clear_status_led_pin: false, status_led_pin: val });
  });

  $("#btn-inject-fault").addEventListener("click", () => {
    if (!currentProject) return;
    const ctrlComp = currentProject.device_spec.components.find(c => c.role === "controller");
    if (ctrlComp?.catalog_id === "arduino-uno-r3") {
      queueDesignEdit({
        supply_rail_mv: 5000,
        signal_pins: ["D0"],
        status_led_pin: "D0",
      });
    } else {
      queueDesignEdit({
        supply_rail_mv: 5000,
        signal_pins:
          currentProject.device_spec.components.find(c => c.role === "emg_sensor")?.quantity === 2
            ? ["GPIO0", "GPIO0"]
            : ["GPIO0"],
        clear_status_led_pin: false,
        status_led_pin: "GPIO34",
      });
    }
  });

  // 3D Viewport controls
  $("#explode-view").addEventListener("click", e => {
    const btn = e.currentTarget;
    const next = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(next));
    viewer?.setExploded(next);
  });
  $("#wireframe-view").addEventListener("click", e => {
    const btn = e.currentTarget;
    const next = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(next));
    viewer?.setWireframe(next);
  });
  $("#reset-view").addEventListener("click", () => viewer?.reset("iso"));
  document.querySelectorAll("[data-cam]").forEach(btn => {
    btn.addEventListener("click", () => viewer?.reset(btn.dataset.cam));
  });

  // Inspector Tabs (click + arrow key navigation)
  const tabOrder = ["part", "proofs", "shop"];
  tabOrder.forEach((name, idx) => {
    const btn = $(`#tab-btn-${name}`);
    btn.addEventListener("click", () => switchInspectorTab(name));
    btn.addEventListener("keydown", e => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const nextName = tabOrder[(idx + delta + tabOrder.length) % tabOrder.length];
        switchInspectorTab(nextName);
        $(`#tab-btn-${nextName}`).focus();
      }
    });
  });

  // Repair buttons
  $("#btn-repair-live").addEventListener("click", () => runRepair("live"));
  $("#btn-repair-sample").addEventListener("click", () => runRepair("sample"));

  // Shop.dev buttons
  $("#btn-bom-shop-search").addEventListener("click", () => {
    switchInspectorTab("shop");
    triggerShopSearch(null, null);
  });
  $("#btn-search-all-shop").addEventListener("click", () => {
    const selectedCid = $("#shop-part-filter").value || null;
    triggerShopSearch(selectedCid, null);
  });
  $("#btn-search-custom-shop").addEventListener("click", () => {
    const selectedCid =
      $("#shop-part-filter").value ||
      currentProject?.device_spec.components[0]?.catalog_id ||
      null;
    const query = $("#shop-custom-query").value.trim();
    triggerShopSearch(selectedCid, query || null);
  });

  // Bottom drawer
  $("#btn-toggle-drawer").addEventListener("click", () => {
    const drawer = $("#activity-drawer");
    const expanded = drawer.dataset.expanded === "true";
    drawer.dataset.expanded = String(!expanded);
    $("#btn-toggle-drawer").setAttribute("aria-expanded", String(!expanded));
    $("#drawer-content").hidden = expanded;
  });
  $("#btn-show-research-graph").addEventListener("click", () => onShowGraph?.());
}
