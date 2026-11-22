import { clearValidation, runValidation, renderSourceAdmission, renderSourceProgress } from "./validation.js";
import {
  applyResearchEvent,
  finishResearchMap,
  readResearch,
  showResearchMap,
} from "./research-map.js";
import {
  bindWorkbenchEvents,
  getCurrentProject,
  loadProjectIntoWorkbench,
  setCatalogParts,
  setLiveGeminiStatus,
} from "./workbench.js";

import { initSetup } from "./setup.js";

const $ = sel => document.querySelector(sel);

const form = $("#composer");
const brief = $("#brief");
const connection = $("#connection");
const runButton = $("#run");
const runLabel = $("#run-label");
const sampleButton = $("#run-sample");
const exampleButton = $("#fill-example");
const tightExampleButton = $("#fill-tight-budget");
const feedback = $("#feedback");

let sampleBrief =
  "Design a wrist-worn finger-gesture detector using muscle sensors for under $100 that sends gesture events to my laptop over Bluetooth Low Energy.";
const tightBrief =
  "Design a BLE wristband using EMG muscle sensors for finger gestures. Keep core parts under $80 and size the strap for a 175 mm wrist.";

let pending = false;
let liveProviderName = "Gemini";
let researchController = null;
let latestCompletedReport = null;

if (/mac/i.test(navigator.userAgentData?.platform ?? navigator.platform)) {
  $("#modifier").textContent = "⌘";
}

function showFeedback(msg) {
  feedback.textContent = msg;
}

function showBriefScreen() {
  $("#setup-view").hidden = true;
  $("#brief-view").hidden = false;
  $("#research-view").hidden = true;
  $("#blocked-view").hidden = true;
  $("#workbench-view").hidden = true;
  $("#engineering-statusbar").hidden = true;
  $("#Capabilities-pill").hidden = false;
  $("#nav-context").textContent = "New brief";
  brief.focus();
}

function showResearchScreen() {
  $("#brief-view").hidden = true;
  $("#research-view").hidden = false;
  $("#blocked-view").hidden = true;
  $("#workbench-view").hidden = true;
  $("#engineering-statusbar").hidden = true;
  $("#Capabilities-pill").hidden = false;
  $("#nav-context").textContent = "Agent Research DAG";
}

function renderBlockedReport(report) {
  $("#brief-view").hidden = true;
  $("#research-view").hidden = true;
  $("#workbench-view").hidden = true;
  $("#blocked-view").hidden = false;
  $("#engineering-statusbar").hidden = true;
  $("#Capabilities-pill").hidden = false;
  $("#nav-context").textContent = "Blocked Report";

  const statusMap = {
    blocked: "Design blocked by constraints",
    unsupported: "Outside supported wearable catalog scope",
    candidate: "Candidate report",
  };
  $("#blocked-mode").textContent = `${
    report.mode === "offline" ? "Offline sample" : `Gemini (${report.model})`
  } · ${statusMap[report.review.status] || report.review.status}`;
  $("#blocked-brief").textContent = report.brief;

  const findingsList = $("#blocked-findings");
  findingsList.replaceChildren(
    ...(report.review.findings || []).map(f => {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = `${f.check.replaceAll("_", " ")} · ${f.status.toUpperCase()}`;
      const small = document.createElement("small");
      small.textContent = f.detail;
      li.append(strong, small);
      return li;
    })
  );

  const stepsList = $("#blocked-next-steps");
  stepsList.replaceChildren(
    ...(report.review_notes?.next_steps || []).map(step => {
      const li = document.createElement("li");
      li.textContent = step;
      return li;
    })
  );
}

function setBusy(busy, mode) {
  pending = busy;
  if (busy) {
    clearValidation($("#research-validation-results"));
    $("#validate-research-btn").hidden = true;
    $("#validate-research-btn").disabled = false;
    $("#validate-research-btn").textContent = "Validate sources & proofs";
  }
  runButton.disabled = busy;
  runLabel.textContent = busy && mode === "live" ? "Researching…" : `Research with ${liveProviderName}`;
  sampleButton.disabled = busy;
  exampleButton.disabled = busy;
  tightExampleButton.disabled = busy;
  brief.readOnly = busy;
  form.setAttribute("aria-busy", String(busy));
}

async function startResearch(mode) {
  if (pending) return;
  const value = brief.value.trim();
  if (mode === "live" && !value) {
    showFeedback("Enter a hardware design brief or launch the offline wristband studio.");
    brief.setAttribute("aria-invalid", "true");
    brief.focus();
    return;
  }
  brief.removeAttribute("aria-invalid");
  setBusy(true, mode);
  showFeedback("");
  researchController = new AbortController();
  $("#open-workbench-btn").hidden = true;
  $("#engineer-pcb-btn").hidden = true;
  showResearchScreen();
  showResearchMap(mode, mode === "sample" ? sampleBrief : value);

  try {
    const report = await readResearch(
      mode,
      value,
      researchController.signal,
      event => {
        applyResearchEvent(event);
        if (event.type === "source_audit") renderSourceProgress($("#research-validation-results"), event);
      },
      {
        enabled: $("#source-policy-enabled").checked,
        exclude_at_ai_fraction: Number($("#source-ai-cutoff").value) / 100,
        include_ai_assisted: $("#source-include-assisted").checked,
        max_retries: Number($("input[name=source-max-retries]:checked")?.value ?? 1),
      }
    );
    latestCompletedReport = report;
    $("#validate-research-btn").hidden = !report.research_id;
    if (report.source_research) {
      $("#research-validation-results").replaceChildren();
      renderSourceAdmission($("#research-validation-results"), report.source_research);
    }
    finishResearchMap("completed", "", report);
    // Unresolved datasheet evidence must not be bypassed by the PCB handoff.
    if (!report.brief) report.brief = mode === "sample" ? sampleBrief : value;
    $("#engineer-pcb-btn").hidden = !!report.evidence_blocked;
    $("#btn-engineer-pcb").hidden = !!report.evidence_blocked;
    if (report.project) $("#open-workbench-btn").hidden = false;
    // The explicit Engineer PCB action keeps the validation report inspectable.
  } catch (error) {
    if (researchController.signal.aborted) {
      finishResearchMap("stopped", "Run cancelled. You can edit the brief and try again.");
    } else {
      const message =
        error instanceof TypeError
          ? "Could not reach FORGE server. Check that uvicorn is running."
          : error.message;
      finishResearchMap("failed", message);
      // A failed verification/research run cannot trigger automatic construction.
      $("#engineer-pcb-btn").hidden = true;
      $("#btn-engineer-pcb").hidden = true;
    }
  } finally {
    researchController = null;
    setBusy(false, mode);
  }
}

// Hand the finished research run to the PCB studio, which generates a board for it.
// Inside the PCB studio's Research tab this posts to the parent window; standalone it
// navigates to the studio (FORGE_PCB_URL from /api/session).
// Served under /research/ by the PCB studio: the studio is this origin's root.
const sameOriginStudio = location.pathname.startsWith("/research");
// Vite binds "localhost", which can be IPv6 only, so 127.0.0.1 may refuse.
let pcbUrl = sameOriginStudio ? `${location.origin}/` : "http://localhost:5173/";
// Resolves once /api/session has supplied the real studio address.
let sessionLoaded = Promise.resolve();
async function engineerPcb() {
  const report = latestCompletedReport;
  if (!report || report.evidence_blocked) return;
  const buttons = [$("#engineer-pcb-btn"), $("#btn-engineer-pcb")];
  buttons.forEach(button => { button.disabled = true; });
  document.querySelector("#engineering-handoff-error")?.remove();
  try {
    await sessionLoaded;
    const { sendEngineeringHandoff } = await import("./engineering-handoff.js");
    await sendEngineeringHandoff(report, pcbUrl);
  } catch (error) {
    const message = document.createElement("p");
    message.id = "engineering-handoff-error";
    message.setAttribute("role", "alert");
    message.textContent = error.message || "Engineering handoff failed.";
    buttons.find(button => !button.hidden)?.after(message);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}
$("#validate-research-btn").addEventListener("click", () => {
  if (!latestCompletedReport?.research_id) return;
  runValidation({
    url: `/api/research/${encodeURIComponent(latestCompletedReport.research_id)}/validate`,
    target: $("#research-validation-results"), button: $("#validate-research-btn"),
  });
});

$("#engineer-pcb-btn").addEventListener("click", engineerPcb);
$("#btn-engineer-pcb").addEventListener("click", engineerPcb);

$("#brand-home").addEventListener("click", e => {
  e.preventDefault();
  if (getCurrentProject()) {
    $("#brief-view").hidden = true;
    $("#research-view").hidden = true;
    $("#blocked-view").hidden = true;
    $("#workbench-view").hidden = false;
    $("#engineering-statusbar").hidden = false;
    $("#Capabilities-pill").hidden = true;
    $("#nav-context").textContent = "Workbench";
  } else {
    showBriefScreen();
  }
});

$("#stop-research").addEventListener("click", () => researchController?.abort());
$("#edit-brief").addEventListener("click", showBriefScreen);
$("#blocked-edit-brief").addEventListener("click", showBriefScreen);
$("#open-workbench-btn").addEventListener("click", () => {
  if (getCurrentProject()) {
    loadProjectIntoWorkbench(getCurrentProject(), latestCompletedReport);
  }
});

form.addEventListener("submit", e => {
  e.preventDefault();
  startResearch("live");
});
brief.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    form.requestSubmit();
  }
});
brief.addEventListener("input", () => {
  brief.removeAttribute("aria-invalid");
  if (!pending) showFeedback("");
});
exampleButton.addEventListener("click", () => {
  brief.value = sampleBrief;
  brief.removeAttribute("aria-invalid");
  showFeedback("");
  brief.focus();
});
tightExampleButton.addEventListener("click", () => {
  brief.value = tightBrief;
  brief.removeAttribute("aria-invalid");
  showFeedback("");
  brief.focus();
});
sampleButton.addEventListener("click", () => startResearch("sample"));
if (new URLSearchParams(location.search).get("run") === "sample") startResearch("sample");

bindWorkbenchEvents(
  () => showBriefScreen(),
  () => {
    showResearchScreen();
    $("#open-workbench-btn").hidden = !getCurrentProject();
    $("#edit-brief").hidden = false;
    $("#stop-research").hidden = true;
  }
);

initSetup(() => refreshSession());

function refreshSession() {
  return fetch("/api/session")
    .then(r => (r.ok ? r.json() : null))
    .then(sess => sess && applySession(sess))
    .catch(() => {});
}

function applySession(sess) {
  if (sess.pcb_url && !sameOriginStudio) pcbUrl = sess.pcb_url;
  connection.dataset.live = String(sess.live);
  connection.hidden = !!sess.live;
  connection.lastElementChild.textContent = sess.live ? "" : "Offline";
  setLiveGeminiStatus(sess.live);
  liveProviderName = "Gemini";
  if (!pending) runLabel.textContent = `Research with ${liveProviderName}`;
  if (sess.sample_brief) sampleBrief = sess.sample_brief;
}

sessionLoaded = Promise.all([
  fetch("/api/session").then(r => (r.ok ? r.json() : null)),
  fetch("/api/catalog").then(r => (r.ok ? r.json() : null)),
])
  .then(([sess, cat]) => {
    if (cat?.parts) setCatalogParts(cat.parts);
    if (sess) applySession(sess);
  })
  .catch(() => {
    connection.lastElementChild.textContent = "Server unavailable";
  });

// Source filter: keep the one-line summary in sync with the controls.
function syncPolicy() {
  const on = $("#source-policy-enabled").checked;
  const cutoff = $("#source-ai-cutoff").value;
  const rounds = Number($("input[name=source-max-retries]:checked")?.value ?? 1);
  $("#cutoff-out").textContent = cutoff + "%";
  $("#source-policy").classList.toggle("is-off", !on);
  for (const el of document.querySelectorAll(".policy-dep input")) el.disabled = !on;
  $("#policy-value").textContent = on
    ? `Pangram · drop sources ≥ ${cutoff}% ${$("#source-include-assisted").checked ? "AI or AI-assisted" : "AI"} · ${rounds ? rounds + (rounds > 1 ? " retries" : " retry") : "no retry"}`
    : "Off · every source is used";
}
$("#source-policy")?.addEventListener("input", syncPolicy);
syncPolicy();
