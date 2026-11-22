# Consumer repair API — Review 2

Dev Vite :5173 owns `/api/consumer-repair`; `/manual` proxies to Python :8000. Not supported in static hosting/preview. No EMG conversion. JSON response unless raw PDF request. Memory only: 32 sessions, 32 history entries/session; eviction/restart returns 404. No physical repair or purchase is approved by this implementation.

## Modes and evidence

`deterministic` (default/backward compatible): real catalog checks, no agent.
`rehearsal`: same checks plus explicitly **SCRIPTED** advice, not captured/live output.
`live`: native open-source Hermes Agent worker when FORGE_HERMES_SOURCE/FORGE_HERMES_PYTHON and ANTHROPIC_API_KEY are configured; otherwise supported capability-checked gateway. Responds 202 while advice runs. Native runtime is fixed to verified Anthropic `claude-haiku-5-5`, 3 iterations, 900 output tokens/iteration, 35s runtime budget/45s hard process timeout, no fallback; only a read-only FORGE engineering tool is enabled. Tool-search deferral is disabled in an isolated temporary Hermes home. Secrets stay in process environment. No model-only fallback. At most two concurrent calls, capability deadline 3s, completion deadline 30s. Poll summary every 500ms until agent_state completed/failed/discarded_stale. Gateway must itself be configured with bounded `agent.max_turns`; client timeout does not cancel remote execution. No automatic provider subscription/setup.

Every session has `revision`, `analysis_revision` and `agent_revision`. Analysis is recomputed synchronously after design edits. Advice remains attached to its original revision, clearly stale after an edit. Late async completions cannot overwrite a newer design. `agent_state` is real queued/running/completed/failed/discarded_stale/stale/not_requested, not decorative simulated stages. Provider failures after 202 appear as agent_error `provider_timeout:504` or `provider_failed:502`; initial missing config is HTTP 503. Advice is never engineering evidence.

## Requests

GET `/demo`: `{template:SystemDesign,mode:"scripted_request_real_catalog_checks",request:{description:string}}`. No motor is confirmed by loading a demo.

POST `/analyze`:
```json
{"description":"My little rover has a broken motor. Repair under $30 and preserve original appearance.","budget":30,"budget_exclusive":true,"preserve_appearance":true,"quantity":1,"component_id":"m2","mode":"rehearsal"}
```
`description` required 1–4000 chars, must identify rover. Optional budget finite nonnegative USD; absent requires one `$number` in description. `budget_exclusive` defaults to true for under/below/less than, otherwise inclusive. Explicit false respected. `quantity` integer 1–4 is number of replacement units for costing, not number of devices edited. `preserve_appearance` defaults from description; explicit false respected. Target must be one supported motor m1/m2/m3/m4. Omitted target retains backwards-compatible hypothetical m1 analysis with `target_confirmed:false`; action is blocked until a new analysis explicitly selects target. No diagnosis inferred.

GET `/{id}/options`, GET `/{id}/summary`: same session envelope, including retained advice/history and original system. Analysis and original system specs are actual existing catalogs, with approximate fields preserved.

POST `/{id}/apply` (preview only):
```json
{"base_revision":0,"component_id":"m2","candidate_id":"jga25-370-12v","intent":"digital_preview","acknowledge_unverified":true}
```
Requires revision equality, explicit target equal to analyzed target, candidate in that revision's options and both acknowledgement fields exactly as shown. Invalid/unsafe **physical** substitution is rejected; electrical failure does not prevent a clearly acknowledged **digital comparison**. Preview does not change voltage, mesh policy, source evidence, driver or proof status. It only changes the selected system-device catalog ID, preserving placement and other motors. New revision is 1; analysis is recomputed. All engineering/purchase eligibility remains false.

POST `/{id}/undo`:
```json
{"base_revision":1}
```
Restores previous preview system snapshot, revision increases to 2. Repeated undo traverses stack, never decreases revision. History records prior revision, action and system; original template retained separately. History limit rejects further mutations, not silently truncates audit. No external purchase/install side effects exist.

## Session response schema

The following is a concrete abridged example; full `system`, `original`, candidate `specs`, `history` snapshots use the existing SystemDesign/CatalogItem contracts. Fields shown are stable and additive to Review 1:
```json
{"id":"UUID","revision":0,"analysis_revision":0,"design_status":"digital_preview_unverified","physical_repair_approved":false,"history":[],"undo_stack":[],"agent_revision":0,"agent_state":"not_requested","agent":{"recommendation":null,"explanation":"SCRIPTED REHEARSAL: compare a digital draft only. TT/N20 nominal voltage mismatch; JGA25 fit and driver remain unknown. Do not buy or install.","missing_info":["confirmed diagnosis","exact driver and mounting evidence"],"evidence_kind":"scripted_advice_not_evidence","mode":"rehearsal"},"analysis":{"status":"no_solution","recommendation":null,"verification":"unverified","component_id":"m2","target_confirmed":true,"component_selection":"user_selected","mode":"deterministic","agent":null,"goals":{"description":"rover under $30","budget":30,"currency":"USD","preserve_appearance":false,"budget_exclusive":true,"quantity":1},"candidates":[{"candidate_id":"jga25-370-12v","component_id":"m2","compatibility":"partial","eligible":false,"preview_eligible":true,"known_cost":7.5,"currency":"USD","price_kind":"catalog_not_live_quote","within_known_budget":true,"cost":{"unit":7.5,"quantity":1,"known_subtotal":7.5,"total":null,"currency":"USD","total_within_budget":null},"unknown_costs":["shipping","tax","labor"]}]}}
```
`analysis.agent` stays null for backwards compatibility; use session-level `agent`. `analysis.mode=deterministic` describes checks, `agent.mode` describes advisory origin. `within_known_budget` compares quantity subtotal only, NOT total budget approval. A $30 strict constraint rejects $30, inclusive permits it. Known subtotal is not delivered/installed total. `compatibility=partial` means nominal voltage range comparison only, not electrical approval; PWM/driver/installation remain unknown. Full rover clearance, disconnected island and thermal warnings remain in `analysis.unresolved` and each candidate. Catalog evidence and hypotheses remain separate in candidate explanation/evidence. No “drop-in” assertion.

## Errors

`{error:string,code:string}` for consumer input/action errors: 400 invalid_request, 404 session_not_found, 405 method_not_allowed, 409 stale_revision, 422 acknowledgement_required/target_required/invalid_substitution/nothing_to_undo/history_limit, 503 provider_unavailable/provider_busy. Retry stale actions only after fetching summary. Provider execution errors live in the asynchronous status described above. Never turn failed advice into success.

## PDF manual

POST `/manual` raw `Content-Type: application/pdf`, optional `X-Filename: uln2003a.pdf` (plain filename <=100 characters before extension), <=10 MiB, 10s upload/45s provider deadline:
```sh
curl http://localhost:5173/api/consumer-repair/manual -H 'Content-Type: application/pdf' -H 'X-Filename: uln2003a.pdf' --data-binary @docs/manuals/uln2003a.pdf
```
Actual Reducto upload/extract. SHA256 cache holds at most eight successful outputs <=2 MB each. `cache_hit:true` means previously parsed content, never a fresh provider call. Cached results are still unreviewed and may be served without a credential. Returns `{provider:"reducto",mode:"live",verification:"unreviewed",source:{sha256,filename},cache_hit:boolean,facts:{manufacturer:{value:string|null,verification:"unreviewed",references:[],reference_status:"unsupported_references"},...},extraction:object,catalog_updated:false,warning:string}`. Facts: manufacturer, model, part_numbers, operating_voltage/current, dimensions, pin_assignments, safety_installation_warnings. Each reference when available has page integer >=1/null, chunk_id string/null, quote string/null. Provider-claimed references are unverified; global citations are NOT copied onto every fact. Missing fact references explicitly unsupported. Malformed output 502, absent credentials/provider unavailability 503, timeout 504, upload timeout 408, type 415, size 413, invalid signature/name 422 (Python errors use FastAPI `{detail:string}`). Does not attach to or mutate design/session/catalog, so parse completion cannot overwrite design revision.

## FE integration / rehearsal

Render session.analysis.system using existing system renderer if desired; do not mutate browser state from agent prose. Keep no_solution as engineering outcome even after digital preview. Clearly label every preview unverified, never expose checkout/installation approval. Keep original target, revision, unknown total and full warnings visible. Disable action until explicit user target and acknowledgement. Match agent_revision before presenting advice as current. No visual changes required by backend.

From root: `node scripts/consumer-repair-smoke.mjs --launch` launches Vite/Python temporarily, performs actual HTTP demo→analyze→options→preview→summary→undo, invalid/stale rejection and checks safety/price labels, then stops its own processes. Without --launch targets existing :5173; FORGE_CONSUMER_URL overrides target. Scripted advice only, no paid provider call. Persistent launch: `uv run --locked --python 3.12 python -m forge_research.studio` and `cd pcb-studio && npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`. Install with `uv sync --locked --python 3.12` and `npm install --package-lock=false` (known lock issue).

## Engineering voxel demo (additive, current)

Current product/launch: `FORGE_ENGINEERING_HANDOFF.md`; consumer positioning above is historical. Analyze accepts optional `decision_kind: "repair_change" | "prototype_change"` and `priorities: string[]` (unique, max four: `original_appearance`, `affordability`, `performance`, `sentimental_value`). Invalid intent/priorities returns 400. Preferences add `analysis.priorities`, per-option `preference_notes`/`investigation_score`, `comparison_purpose: investigation_order_not_physical_recommendation`, and practical `next_steps`. They order investigation and explain impossible priorities; physical eligibility/recommendation gates remain unchanged. Performance is unknown without relevant manufacturer/load/driver evidence. No sentimental backstory inferred.

POST `/{id}/plan` with `{ "base_revision": 1 }` exports the current draft investigation plan (200), without mutation. Stale revision returns 409. Includes revision, original/selected draft parts, actual catalog costs with unknown total, specs/provenance/approximation flags, priorities, alternatives/rejections, warnings, history and next steps; physical recommendation remains null. UI downloads JSON; never install/purchase based on this plan.
