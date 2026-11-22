# FORGE engineering / voxel integration

## Scope and provenance

One product, one rover, one explainable motor change. Primary entry is `/voxel-demo/`, served by Vite on :5173. David Ren's exact commit `2f403ec3631b830a15dc2216616092d6be872ddd` was fetched from https://github.com/davidrencse/NYC-NON-SLOP-Hackathon-/tree/voxel-diorama-demo, verified to change only eight files in `voxel-demo/`, and cherry-picked preserving authorship as `24f8c7e`. No main merge, push, remote configuration change or teammate checkout edit.

The voxel aesthetic, crew, rooms, orbit controls, camera views, employee inspection, replay, speed and sound remain. The old wristband study and carried wristband parts are hidden, not reconstructed as a fake rover. Its code remains retained. Scripted dialogue and factory status no longer claim all checks pass. Crew movement is explicitly illustrative, not live inference or engineering evidence.

Actual rover geometry uses the original React/Three renderer in an embedded workbench below the diorama. Engineering navigation scrolls to that workbench; this is not a rover inserted into the voxel factory itself. No new CAD, assets, dependency or state framework. Earlier React decision-panel work is parked in local git stash `parked React decision path; superseded by voxel ownership`, not integrated.

## Launch / 60–90 second rehearsal

From root:
```sh
uv sync --locked --python 3.12
(cd pcb-studio && npm install --package-lock=false)
uv run --locked --python 3.12 python -m forge_research.studio
# separate terminal
(cd pcb-studio && npm run dev -- --host 127.0.0.1 --port 5173 --strictPort)
```
Open http://127.0.0.1:5173/voxel-demo/. Explore the lab, click Engineering, select m2 in the actual rover (or explicit motor selector), then **Load original brief and compare**. This button explicitly starts from the original template, not independent full-editor changes. Expand JGA25: compare original/candidate, nominal voltage, curated catalog source, unit cost $7.50, known subtotal and unknown total. Read mounting/driver/stall-current unknowns. Acknowledge unverified preview, apply digital draft, inspect changed motor geometry, then undo (revisions 0→1→2). The original TT/N20 voltage mismatch and board clearance/island/thermal limitations remain; no physical solution is approved. Users may reject all options.

Full tools are secondary navigation: `/?mode=engineer`. Existing system/PCB editors, catalogs/swaps, costs, assembly templates, offline/generation, research/manuals/evidence, wiring/placement/routing, firmware starters, exports, Lean warnings, history, procurement, ADK and native Hermes implementation remain. The embedded view deliberately shows only the original renderer; full editor is independent, not a synchronized second editing session.

## UI/API boundary

`voxel-demo/decision.js` uses existing `/api/consumer-repair` routes unchanged. Additive `decision_kind:"prototype_change"` on analyze selects engineering intent wording, not broken-object diagnosis; legacy requests retain existing behavior. `status:no_solution` and `physical_repair_approved:false` remain intentional. Contract details: `NONSLOP_API_CONTRACT.md` (historical consumer naming only).

Analyze sends explicit motor, grounded rover brief, $30 budget and chosen advisory mode. All apply/undo requests carry current `base_revision`; apply requires `intent:digital_preview` and explicit acknowledgement. Revision history and unresolved warnings are reachable. Cost distinguishes unit, known subtotal and unknown delivered total; catalog prices are not live quotes. Curated generic specs are not manufacturer-validated evidence. No agent prose is treated as source evidence.

Same-origin iframe messaging accepts only parent messages and UUID-shaped session IDs. The renderer fetches authoritative summary, rather than trusting posted geometry or agent text. A sequence guard prevents earlier renderer fetches overwriting later ones. Selection messages must come from that iframe and origin. Standalone editor has no message listener. Session state is local/memory-only; restart loses it. No authentication or production/multi-user guarantees.

Hermes settings are collapsed: deterministic default, clearly SCRIPTED rehearsal, or live operator-configured native Hermes. UI polls actual queued/running/completed/failed states; stale advice is withheld. Applying does not await inference. Existing bounded official Hermes Haiku-only worker is unchanged; no model wrapper or fallback introduced. Live setup:
```sh
uv run --locked --python 3.12 python scripts/consumer-start.py --env-file /path/to/private/.env --hermes-source /tmp/forge-hermes-agent
```
No credentials copied or printed. Prior live evidence (~8.09s) remains historical; no new paid invocation was made for this integration.

## Verification and limits

Actual HTTP rehearsal:
```sh
node scripts/consumer-repair-smoke.mjs --launch
```
Final acceptance run: **352.606 ms flow, 995.803 ms including startup** (local HTTP, not browser/provider latency). Checks voxel asset delivery, engineering-intent analysis, SCRIPTED advice, original catalogs, options, invalid candidate, preview, stale rejection, summary and undo. Revision ends at 2, no physical approval.

Regression commands:
```sh
uv run --locked --python 3.12 python -m unittest discover -s tests
(cd pcb-studio && node --experimental-strip-types --test tests/*.test.ts)
node --test tests/test_validation_ui.mjs
(cd pcb-studio && npm run build && npm run lint)
node --check voxel-demo/decision.js
git diff --check
```
113 Python, 31 TypeScript (intent and preservation regressions), 3 existing UI tests pass. Build passes; lint retains 10 baseline warnings. TS tests must run from `pcb-studio/`: an initial root invocation had two Vite-root resolution failures, corrected without weakening tests. Existing UI tests are not browser proof of this new presentation.

**Actual browser smoke passed:** discovered local Chrome and used native CDP (no added dependency), `node scripts/voxel-browser-smoke.mjs --launch`. Measured **5435.422 ms** including services/browser launch: visible workbench, actual original renderer canvas, explicit m2 selector, sentimental-value toggle, compare, acknowledgement, JGA25 draft apply, renderer revisions 0→1→2, undo, actual JSON plan download/current revision contents, and navigation to full editor with canvas/Research/Export present. No JavaScript runtime exceptions. Screenshots inspected at `/tmp/forge-voxel-browser.png` (restored) and `/tmp/forge-voxel-draft.png` (JGA25 selected); browser also asserts the changed motor label inside the renderer. This exposed and fixed the friend's scene-only CSS hiding the integration panel; original dark styling is retained with a narrow workbench override. Raycast motor selection, mobile layout, every legacy advanced operation and physical geometry correctness were not exhaustively tested. Lean unchanged; no new proof success claimed.

**Reducto remains unresolved:** documented extract endpoint inspected at https://docs.reducto.ai/api-reference/api/sections/extract/operations/extract. Existing live failure has no retained raw provider response, so this change does not guess which objects/units to coerce. Parser still fails closed on malformed field types; facts remain unreviewed with per-fact references, no catalog writes. No paid rerun or success claim. Follow-up needs a bounded sanitized raw-response capture and normalization fixtures; earlier 502 evidence remains intact.

## Exact integration files (after the eight-file author-preserving import)

- `README.md`
- `docs/FORGE_ENGINEERING_HANDOFF.md`
- `docs/NONSLOP_API_CONTRACT.md`
- `pcb-studio/server/consumer-repair.ts`
- `pcb-studio/src/App.tsx`
- `pcb-studio/src/state/studio.ts`
- `pcb-studio/tests/consumer-repair.test.ts`
- `pcb-studio/vite.config.ts`
- `scripts/consumer-repair-smoke.mjs`
- `scripts/voxel-browser-smoke.mjs`
- `voxel-demo/style.css`
- `voxel-demo/app.js`
- `voxel-demo/index.html`
- `voxel-demo/decision.js`

Static `python -m http.server` still supports the friend's animation alone, but is NOT the integrated API/rover demo. Use Vite. Production static hosting, further iframe visual polish, live Reducto interoperability and durable session persistence are deferred.

## Final acceptance additions

The default voxel flow asks for a rover problem/change brief, validated intent (`repair_change` or `prototype_change`), explicit budget/target and **What are you trying to preserve?** Original appearance, affordability, performance and sentimental value are validated unique API priorities. Each produces deterministic option-specific reasons. Appearance and sentimental priorities favor investigation of original geometry/minimal reversible change; affordability orders by known cost only; performance explicitly cannot be optimized without load curves/stall-current/driver evidence. These are **investigation order, not a physical recommendation**: no eligible physical choice exists and NO remains explicit. Nothing changes catalog ratings, gates or proof status. Changing inputs invalidates preview/export until recomparison. Old repair API requests still work.

Optional animation controls are collapsed in a native details element. Existing orbit/camera/crew inspection remain; Inspect rover is the next useful scene navigation. Evidence/options/advisory settings are progressively disclosed. No extra theme or wow-mode framework.

`POST /api/consumer-repair/{id}/plan` with `{base_revision:number}` returns a revision-bound JSON plan; stale revision is 409 and the request does not mutate history. UI downloads it as `forge-rover-plan-rev-N.json`. It records the selected current draft part vs original, priorities/brief, actual catalog unit and known subtotal, unknown total, full important catalog specs/provenance (including approximate-field flags), alternative rejections, unresolved warnings and concrete inspection/measurement/documentation next steps. It is an investigation plan, not safe installation instructions. HTTP regression checks plan content both after apply and after undo, stale export rejection and original editor/embedded route reachability. No paid inference was repeated; real Reducto failure is not demo evidence.
