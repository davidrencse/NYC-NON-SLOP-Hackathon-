# FORGE Non-Slop — Backend Review 1

## Status: partial P0, honest no-solution slice

Implemented a dedicated consumer namespace without touching visual components, routing algorithms or proof infrastructure. Rover R1 comes from the existing TypeScript system/catalog, not the Python EMG model. Analysis parses an explicit USD budget, reported description and appearance preference; exposes catalog specifications, stable IDs, nominal geometry, known catalog costs, rejected reasons, provenance and unresolved engineering risks. Nothing claims a diagnosis, physical repair or safety certification.

**Not a successful repair demo:** TT and N20 catalog motors support 3–6 V, while the template rail is 7.4 V. JGA25 supports the rail but has different geometry, uncertain mounting and stall-current/driver requirements. No candidate has enough evidence to meet all requirements. All candidates are explicitly ineligible. Apply is a rejection gate, not an implemented versioned mutation path; undo is unavailable. Existing editor history remains untouched. This does not complete the requested apply vertical slice.

## API / UI handoff

Stable contract: `docs/NONSLOP_API_CONTRACT.md`. Vite dev :5173 serves analysis; raw PDF ingestion proxies to Python :8000. Preview/static hosting is not supported. No UI modifications required or made.

```sh
curl http://localhost:5173/api/consumer-repair/demo
curl -s http://localhost:5173/api/consumer-repair/analyze -H 'Content-Type: application/json' -d '{"description":"My little rover has a broken motor. Repair under $30 and preserve original appearance.","component_id":"m1","mode":"deterministic"}'
```

Response shape (abridged, not captured live provider evidence):
```json
{"id":"server-generated UUID","revision":0,"history":[],"analysis":{"status":"no_solution","recommendation":null,"verification":"unverified","component_id":"m1","mode":"deterministic","agent":null,"candidates":[{"candidate_id":"tt-motor-148","known_cost":1.6,"currency":"USD","price_kind":"catalog_not_live_quote","eligible":false}]},"agent":null,"elapsed_ms":0.0}
```
`elapsed_ms` above is a shape placeholder, not a timing claim. Full responses include system/specs and explanation/evidence objects; candidate ordering follows existing alternativesFor. Store returned id/revision; GET `/{id}/options` and `/{id}/summary` retrieve the session. POST `/{id}/apply` with `{ "base_revision":0,"candidate_id":"tt-motor-148" }` returns 422; stale revision returns 409. Show no-solution prominently, costs as catalog-only, unknown tax/shipping/labor, and motor selection as a hypothesis unless user selected it. Sessions are capped at 32 and lost on restart. No browser-state synchronization or persistent revision service was added.

## Hermes: actual integration path, no live execution

Read official integrations, repository and API-server documentation:
- https://hermes-agent.nousresearch.com/docs/integrations
- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

Implemented supported Hermes Agent gateway access, not a direct Nous model request. Checks `/v1/capabilities` for platform `hermes-agent`, sends full deterministic analysis/specs/costs to `/v1/chat/completions`, requires completed output and validates structured advice. Recommendation cannot override no-solution. Gateway calls have 3s/30s client deadlines. One model request per analysis. Credentials remain server-side. Agent prose is explicitly not evidence.

**Blocker:** no hermes executable, FORGE_HERMES_URL/key or relevant provider credentials found in shell. No live run, transcript, captured response or execution timing exists. Tests use clearly mocked responses. Gateway configuration must independently bound agent.max_turns and disable unsafe tools; client deadline does not guarantee remote cancellation. No FORGE callable Hermes tools/MCP server were implemented; this uses supported programmatic gateway access with supplied engineering results. Slow live analysis is independent of ordinary editor edits, but is a synchronous analysis HTTP request, not a streaming job. Its advice is returned at top level and not retained by summary.

To enable an actual installed/configured Hermes Agent, follow official setup; set API_SERVER_ENABLED=true and API_SERVER_KEY in its private environment, configure agent.max_turns conservatively (e.g. 3), then `hermes gateway`. Set FORGE_HERMES_URL=http://127.0.0.1:8642 and FORGE_HERMES_KEY to that private key in the Vite environment. POST analyze with mode=live. No unrelated-model fallback exists.

## Reducto: actual adapter, no live extraction

Read https://reducto.ai/developers. POST `/api/consumer-repair/manual` accepts raw application/pdf (not multipart), validates signature and 10 MiB bound, invokes the existing actual upload/extract adapter with a 45s overall deadline. Returns source SHA256, raw provider citations and unreviewed normalized nullable fields. Catalog is never modified. Citations are retained as provider-level references, not verified per-field support; page/chunk normalization and source-fact admission remain incomplete. Unknown values remain null; malformed field types fail.

**Blocker:** REDUCTO_API_KEY absent in shell. No live provider request or captured extraction exists; success tests are mocks, not fresh parses. Provider cache/static parse caching was not implemented.

Prepared real source: `docs/manuals/uln2003a.pdf`, downloaded directly from https://www.ti.com/lit/ds/symlink/uln2003a.pdf. SHA256 `ba83a908675b45c41e84fb06ea390efb10f4b7a358edfee656f87a968dd1d62f`. TI manufacturer datasheet, original copyright retained. Matches supported ULN2003A catalog chip; does NOT establish the generic module or rover motor specifications. Separate ingestion demonstration only:
```sh
curl http://localhost:5173/api/consumer-repair/manual -H 'Content-Type: application/pdf' --data-binary @docs/manuals/uln2003a.pdf
```
With missing key expect explicit 503, not a fixture extraction.

## Rehearsal and timings

GET demo supplies a **scripted request**, not a captured Hermes response. Deterministic mode uses real downstream alternativesFor and immutable catalog facts. Observed single local unit analysis: **0.409 ms**; this is not full browser demo or provider latency. No 60–90s successful-apply demo established. No real live Shop quote requested: catalog prices only. Existing Shop MCP/procurement routes, ADK, Lean and 3D template are preserved, but new consumer orchestration does not invoke those services. Existing full rover warnings are repeated, not rewritten or suppressed.

## Tests / launch

```sh
# terminal 1, root
uv sync --locked --python 3.12
uv run --locked --python 3.12 python -m forge_research.studio
# terminal 2
cd pcb-studio
npm install --package-lock=false
npm run dev -- --host 127.0.0.1 --port 5173
```
Set REDUCTO_API_KEY only in server environment for live parsing. FORGE_RESEARCH_URL defaults to http://127.0.0.1:8000. No new dependency or tracked lock change.

Verification: Python 112 tests passed (23.616s); root validation UI 3 passed; TypeScript 26 tests passed (809 ms suite); npm build passed (Vite build 724 ms), retaining existing chunk/dynamic-import warnings. git diff --check passed. Added tests cover rover, unknown/missing budget, invalid target, budget 0, provenance presence, invalid substitution, stale revision, missing Hermes configuration, structured response rejection, mocked timeout; manual success/failure/malformed data/type/signature/size and timeout. No live integration claim. Lint and Lean were not rerun; baseline proof failures remain applicable.

## Remaining limits / explicit deferrals

No engineering-approved apply/undo, diagnosis, verified mechanical fit, complete budget, live purchasing, source admission, per-field citations, static parse cache, streamed progress or real provider evidence. No provider-backed recommendation success. No Modal or Pangram work: deferred to preserve P0; authorship is not verification. No new CAD reconstruction. Local-only prototype; no auth/multi-user isolation. No push/merge/worktree operations or agents spawned.

## Changed files

- docs/NONSLOP_API_CONTRACT.md
- docs/FORGE_NONSLOP_BACKEND_REVIEW_1.md
- docs/manuals/uln2003a.pdf
- forge_research/consumer_manual.py
- forge_research/studio.py (router registration only)
- tests/test_consumer_manual.py
- pcb-studio/server/consumer-repair.ts
- pcb-studio/vite.config.ts (plugin and namespace proxy)
- pcb-studio/tests/consumer-repair.test.ts
- pcb-studio/tests/consumer-api.test.ts
- pcb-studio/src/data/system.ts
- pcb-studio/src/data/catalog/{index,types,boards,general,peripherals}.ts

The last six catalog/system files only change import paths/extensions to enable the existing shared system layer in Node server/tests; catalog data and validators unchanged. Local commit hash is reported in final handoff response (avoids self-referential document hash).
