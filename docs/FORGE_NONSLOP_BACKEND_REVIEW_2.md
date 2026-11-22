# FORGE Non-Slop — Backend Review 2

## Completed practical path

Fast-forwarded isolated branch to main (4ffbc247), preserving both Review 1 and taste docs; no parent checkout edits, coding agents, visual changes, push, or merge into main.

Real flow: demo → explicit affected motor → analysis/comparison → acknowledged **digital design preview** → revision-bound summary → undo. Physical repair/purchase remains no_solution: original TT and N20 support only 3–6 V vs template 7.4 V; JGA25 covers nominal supply range but mounting/shaft/current/PWM and appearance remain unresolved. Generic catalog records are not manufacturer-admitted motor evidence. No catalog values, proof gates or provenance were altered. Existing full rover warnings remain unchanged. Preview never authorizes installation or checkout.

Preview changes only the selected device catalog ID and retains placement, other devices and original template. Apply requires intent=digital_preview, acknowledgement=true, explicit matching motor and current base_revision. Undo restores previous snapshot with monotonically increasing revision. History/session limits 32/32. Async advice is revision-bound and retained; results arriving after an edit are discarded. Analysis is recomputed after each edit; old advice is labeled stale. Invalid candidates/physical apply/stale edits fail explicitly.

Budget semantics now distinguish strict under/below from inclusive ceilings, quantity (1–4), unit cost, known subtotal and unknown installed/delivered total. Explicit appearance=false is respected. No “Drop-in alternate” assertion: shared system explanation says catalog-listed alternative, fit unverified. Nominal voltage match is not electrical approval. Default m1 remains a hypothesis only and cannot be acted on without explicit selection.

## Actual Hermes execution — succeeded

Official sources inspected:
- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- https://platform.claude.com/docs/en/about-claude/models/overview

Cloned official runtime externally to /tmp/forge-hermes-agent, revision `0f602c5f6f18615632535251d62a2db74ce93b69`; installed using `uv sync --extra anthropic`. Used actual `run_agent.AIAgent`, native Anthropic Messages provider. Anthropic models endpoint returned 200 and advertised `claude-haiku-5-5` plus `claude-haiku-4-5-20251001`; official docs list Haiku 5.5 as cheapest suitable model. Fixed application worker to `claude-haiku-5-5` only, never Sonnet/Opus, no fallback. Coding agent model unchanged.

Parent `.env` discovered safely: ANTHROPIC_API_KEY present; REDUCTO present (REDUCTO_API_KEY absent). Private dotenv loading into process environment only, no secret values printed/copied/committed. Parent file unchanged.

Native worker exposes actual read-only `forge_engineering` callable tool using Hermes registry/custom toolset. Tool returns real FORGE deterministic results/specs/prices/provenance, no writes or purchases. Only this toolset is enabled. Isolated ephemeral Hermes home disables deferred tool discovery; max_iterations=3, max_tokens=900 per response, run_budget_seconds=35, hard subprocess timeout=45s, two concurrent sessions max. Validates structured response and requires actual tool call before accepting advice. UI live request gets 202 then polls real running/completed/failed state; edits remain independent. Gateway support remains backward compatible but requires operator-side turn limits.

Execution evidence (actual, not fixture):
- `docs/non-slop/execution/hermes-live.json`: successful standalone run, 7162.787 ms, tool called with all 3 real candidates.
- `docs/non-slop/execution/hermes-http-live.json`: actual Vite POST analyze + GET summary, completed at revision 0, retained agent_revision 0, 8086.653 ms end-to-end; worker 7632.792 ms. One forge_engineering invocation, no physical approval.

Debug attempts were bounded and also used only Haiku: two completed model runs did not invoke the tool before the 3-turn budget; one returned fenced JSON rejected by the initial parser. Fixed eager tool exposure and accepted only an enclosing JSON fence (still schema validated). One local import failure occurred before inference. Then standalone and actual HTTP runs succeeded. No fallback or unbounded paid loop. Agent prose remains advisory, not source/proof evidence; its wording must not replace deterministic facts.

## Actual Reducto execution — failed closed

One real upload/extract test used the existing private REDUCTO alias, mapped in subprocess to REDUCTO_API_KEY. Real TI ULN2003A PDF SHA256 `ba83a908675b45c41e84fb06ea390efb10f4b7a358edfee656f87a968dd1d62f`, source https://www.ti.com/lit/ds/symlink/uln2003a.pdf. Separate supported chip ingestion sample, NOT rover motor evidence.

Actual endpoint outcome: **502, Reducto returned invalid field types, 23.424 seconds**. No success claim, no catalog write, raw response was not retained; no second paid parse was made. Sanitized outcome: `docs/non-slop/execution/reducto-live-failure.json`. This is an unresolved provider-schema integration blocker, not missing credentials or a successful captured extraction. Do not present it as a demo parse success.

Parser improvements: 10 MiB cap, 10s upload/45s provider deadlines; validated plain filename and SHA256; per-fact nullable values/references, checked page/chunk/quote shapes, explicit unsupported_references when absent. Global citations are retained only in raw extraction, never copied onto each fact. Provider references remain unreviewed. Eight-entry/2 MB-per-output content hash cache; cache_hit is explicit and catalog remains immutable. Real missing-credential HTTP test also returned 503 in 4.013 ms (forced empty key); distinct from paid test above.

## Measured demo and regressions

Actual `node scripts/consumer-repair-smoke.mjs --launch` exercised real Vite HTTP and engineering checks, **SCRIPTED** advice, revision 0→1→2, real invalid/stale rejection, summary/undo and safety/cost assertions. Measured **23.495 ms flow**, **661.240 ms including service readiness/startup** on this machine (not provider latency/browser performance). Earlier independent run: 29.267 ms/471.648 ms. No physical repair performed.

Final tests:
- Python unittest full suite: **113 passed**, 24.854s on final run.
- All TypeScript tests: **29 passed** (includes explicit $30 boundary via 4×$7.50, false priorities, quantity/unknown total, preview/undo, stale async, retained fixture advice).
- Root UI regression: **3 passed**.
- npm build: passed; existing chunk/dynamic-import warnings remain.
- npm lint: **10 existing warnings**, no new consumer warnings.
- Lean example rerun with ~/.elan/bin on PATH: expected **trace_clearance/all_rules rejection**, disconnected island warnings and thermal envelope only through 7.4 V. Not made green, no validators weakened.
- git diff --check: passed.

## Launch and FE integration

Credential-free (root):
```sh
uv sync --locked --python 3.12
(cd pcb-studio && npm install --package-lock=false)
node scripts/consumer-repair-smoke.mjs --launch
```

Persistent dev: terminal 1 `uv run --locked --python 3.12 python -m forge_research.studio`; terminal 2 `cd pcb-studio && npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`.

Native live (requires installed official Hermes source; no new project dependency):
```sh
git clone https://github.com/NousResearch/hermes-agent.git /tmp/forge-hermes-agent
(cd /tmp/forge-hermes-agent && git checkout 0f602c5f6f18615632535251d62a2db74ce93b69 && uv sync --extra anthropic)
uv run --locked --python 3.12 python scripts/consumer-start.py --env-file /path/to/private/.env --hermes-source /tmp/forge-hermes-agent
```
Do not paste values into commands. Launcher reads only relevant keys and maps REDUCTO alias privately. Services :8000/:5173. Native live check separately: `uv run --locked --python 3.12 python scripts/consumer-live-check.py /path/to/private/.env` (one bounded paid run, source defaults /tmp/forge-hermes-agent).

Full exact request/response contracts and error semantics: `docs/NONSLOP_API_CONTRACT.md`. FE should use session.analysis.system for preview, always label digital_preview_unverified, keep physical_repair_approved=false, original template/warnings and unknown total visible. Send explicit target + acknowledgement + base_revision. Show no_solution even after preview. Poll summary for live advice, match agent_revision before using it as current. No UI edits are necessary for HTTP rehearsal; renderer integration belongs to teammate.

## Exact changed files

- docs/NONSLOP_API_CONTRACT.md
- docs/FORGE_NONSLOP_BACKEND_REVIEW_2.md
- docs/non-slop/execution/hermes-live.json
- docs/non-slop/execution/hermes-http-live.json
- docs/non-slop/execution/reducto-live-failure.json
- forge_research/consumer_manual.py
- pcb-studio/server/consumer-repair.ts
- pcb-studio/src/data/system.ts (explanation text only)
- pcb-studio/tests/consumer-api.test.ts
- pcb-studio/tests/consumer-repair.test.ts
- tests/test_consumer_manual.py
- scripts/consumer-repair-smoke.mjs
- scripts/consumer-hermes.py
- scripts/consumer-live-check.py
- scripts/consumer-start.py

No AGENTS.md exists in this worktree; parent baseline not copied or edited. Review 1 remains historical. Local commit hash reported in final response, not self-referentially stored here.

## Remaining limits

No supported physical repair/purchase; no live Shop quote, no diagnosis, no new CAD or proof/routing changes. Preview is in-memory digital state, not fabrication approval. Manual live schema remains blocked (explicit 502); no successful Reducto result claimed. Cache does not persist across restart. Local prototype lacks auth/multi-user storage. Gateway path still depends on operator-bounded configuration; native worker provides enforceable local limits. Modal/Pangram deferred; authorship is not factual verification. Browser usability/appearance was not tested; no frontend visual changes.
