// Provider key setup: the first screen when no provider is configured, and
// reachable any time from the "Keys" button. Keys are POSTed to the local
// FORGE server, kept in server memory (optionally a gitignored local file) and
// never read back: the server only reports "set" plus the last four characters.

const $ = sel => document.querySelector(sel);
const DISMISSED = "forge.setup.dismissed";

const GROUPS = [
  { provider: "gemini", fields: [["gemini_api_key", "password", "AIza…"], ["gemini_model", "select", "Choose a Gemini model"]] },
  { provider: "reducto", fields: [["reducto_api_key", "password", "Reducto key"]] },
  { provider: "pangram", fields: [["pangram_api_key", "password", "Pangram key"]] },
  { provider: "modal", fields: [["modal_cad_url", "url", "https://…--forge-cad-generate-enclosure.modal.run"], ["modal_token", "password", "Shared endpoint token"]] },
];

function el(tag, text = "", className = "") {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

let status = null;
let onDone = () => {};
let modelRequest = null;

async function loadModels() {
  const select = $("#key-gemini_model");
  const help = $("#gemini-model-help");
  if (!select || !help) return;
  modelRequest?.abort();
  const controller = new AbortController();
  modelRequest = controller;
  const selected = select.value || status.default_gemini_model;
  select.disabled = true;
  select.setAttribute("aria-busy", "true");
  help.textContent = "Loading models…";
  try {
    const key = $("#key-gemini_api_key").value.trim();
    const response = await fetch("/api/integrations/gemini-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(key ? { gemini_api_key: key } : {}),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || "Could not load models. Try again.");
    if (controller.signal.aborted) return;
    select.replaceChildren();
    for (const model of body.models) select.add(new Option(`${model.label} (${model.id})${model.id === status.default_gemini_model ? ' · Recommended' : ''}`, model.id));
    if (!body.models.some(model => model.id === selected)) select.add(new Option(selected === status.default_gemini_model ? `${selected} · Recommended` : `${selected} (saved)`, selected));
    select.value = selected;
    help.textContent = body.reason === "no-key" ? "Argon is selected by default. Add your key to load other models." : body.models.some(model => model.id === selected) ? "Argon is recommended. You can choose another model." : "Selected model was not listed for this key. Choose an available model or check your access.";
  } catch (error) {
    if (!controller.signal.aborted) help.textContent = error.name === "TimeoutError" ? "Loading timed out. Try loading models again." : error.message;
  } finally {
    if (modelRequest === controller) {
      select.disabled = false;
      select.removeAttribute("aria-busy");
    }
  }
}

async function load() {
  const res = await fetch("/api/integrations");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  status = await res.json();
  return status;
}

function render() {
  modelRequest?.abort();
  const grid = $("#setup-providers");
  grid.replaceChildren();
  for (const group of GROUPS) {
    const meta = status.providers[group.provider];
    const card = el("fieldset", "", "setup-card");
    card.dataset.configured = String(meta.configured);
    const legend = el("legend");
    legend.append(el("span", meta.title, "setup-title"), el("span", meta.configured ? "Connected" : "Not set", "setup-state"));
    card.append(legend, el("p", meta.role, "setup-role"));
    for (const [field, type, placeholder] of group.fields) {
      const info = status.fields[field];
      const id = `key-${field}`;
      const label = el("label", info.label);
      label.htmlFor = id;
      const input = el(type === "select" ? "select" : "input");
      Object.assign(input, { id, name: field, autocomplete: "off", spellcheck: false });
      if (type !== "select") input.type = type;
      else {
        const selected = info.hint || status.default_gemini_model;
        input.add(new Option(selected === status.default_gemini_model ? `${selected} · Recommended` : selected, selected));
        input.value = selected;
      }
      input.placeholder = info.set ? `${info.secret ? "Saved " : ""}${info.hint}` : placeholder;
      if (!info.secret && info.set) input.value = info.hint;
      input.dataset.secret = String(info.secret);
      const row = el("div", "", "setup-field");
      row.append(label, input);
      if (type === "select") {
        const refresh = el("button", "Load models", "text-link setup-clear");
        refresh.type = "button";
        refresh.addEventListener("click", loadModels);
        const help = el("small", "Argon is selected by default. Add your key to load other models.", "setup-model-help");
        help.id = "gemini-model-help";
        help.setAttribute("aria-live", "polite");
        input.setAttribute("aria-describedby", help.id);
        row.append(refresh, help);
      }
      if (field === "gemini_api_key") input.addEventListener("change", loadModels);
      if (info.set && info.secret) {
        const clear = el("button", "Clear", "text-link setup-clear");
        clear.type = "button";
        clear.addEventListener("click", () => save({ [field]: "" }));
        row.append(clear);
      }
      card.append(row);
    }
    grid.append(card);
  }
  $("#setup-remember").checked = status.remembered;
  $("#setup-forget").hidden = !status.remembered;
  const live = status.providers.gemini.configured;
  $("#setup-summary").textContent = live
    ? `Live agents: Gemini. ${Object.values(status.providers).filter(p => p.configured).length} of ${GROUPS.length} providers connected.`
    : "No LLM key yet. You can still open the offline demo.";
  updatePill();
  if (status.fields.gemini_api_key.set) void loadModels();
}

function updatePill() {
  const pill = $("#keys-button");
  if (!pill || !status) return;
  const count = Object.values(status.providers).filter(p => p.configured).length;
  pill.lastElementChild.textContent = `Keys ${count}/${GROUPS.length}`;
  pill.dataset.ready = String(count > 0);
}

async function save(values) {
  const msg = $("#setup-message");
  msg.textContent = "Saving…";
  const res = await fetch("/api/integrations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    msg.textContent = typeof body.detail === "string" ? body.detail : "Those values were rejected.";
    return false;
  }
  status = body;
  render();
  msg.textContent = "Saved. Keys stay on this server.";
  return true;
}

function collect() {
  const values = { remember: $("#setup-remember").checked };
  for (const input of document.querySelectorAll("#setup-providers input, #setup-providers select")) {
    const field = input.name;
    const info = status.fields[field];
    const value = input.value.trim();
    // Untouched non-secret fields show their saved value; skip them.
    if (!value || (!info.secret && value === info.hint)) continue;
    values[field] = value;
  }
  return values;
}

export function openSetup() {
  $("#setup-view").hidden = false;
  $("#brief-view").hidden = true;
  load().then(render).catch(() => ($("#setup-message").textContent = "Server unavailable."));
  $("#setup-providers").querySelector("input")?.focus();
}

function close() {
  try {
    localStorage.setItem(DISMISSED, "1");
  } catch {}
  $("#setup-view").hidden = true;
  $("#brief-view").hidden = false;
  onDone(status);
}

/** Show the setup screen first if nothing is configured and it wasn't dismissed. */
export async function initSetup(done) {
  onDone = done || onDone;
  $("#setup-form").addEventListener("submit", async event => {
    event.preventDefault();
    // Model discovery is optional: the recommended default is already selected.
    const values = collect();
    // Clear typed secrets from the DOM whether or not the save succeeds.
    for (const input of document.querySelectorAll('#setup-providers input[data-secret="true"]')) input.value = "";
    if (await save(values)) close();
  });
  $("#setup-skip").addEventListener("click", close);
  $("#setup-forget").addEventListener("click", async () => {
    const res = await fetch("/api/integrations/saved", { method: "DELETE" });
    if (res.ok) {
      status = await res.json();
      render();
      $("#setup-message").textContent = "Removed the saved key file. Keys stay set until the server restarts.";
    }
  });
  $("#keys-button").addEventListener("click", openSetup);
  try {
    await load();
  } catch {
    return null;
  }
  updatePill();
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(DISMISSED) === "1";
  } catch {}
  const any = Object.values(status.providers).some(p => p.configured);
  if (!any && !dismissed && !location.hash) {
    openSetup();
  }
  return status;
}
