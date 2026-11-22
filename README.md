# FORGE · Autonomous AI Hardware Engineering

FORGE is an autonomous hardware engineering platform where a swarm of Gemini agents transforms natural-language ideas into editable 3D prototypes, selecting compatible components, designing circuits, generating firmware, and validating the results through simulation.

**Hackathon MVP in development.** The prompt studio runs Gemini research and generates an editable 3D preview for the supported wristband assembly. Firmware verification is planned.

## Open the prompt studio

```bash
uv run --locked --python 3.12 python -m forge_research.studio
```

Open `http://127.0.0.1:8000`. **Use wristband brief** fills the editor. **Run offline sample** runs the research harness without a key. The report lists candidate parts, compatibility checks, and sources. Inspect the generated assembly, adjust the wrist circumference, or export the model as GLB and the report as JSON.

For live research, enter a Gemini API key in the setup screen or set `GEMINI_API_KEY` before starting the studio. FORGE selects `gemini-4-argon` by default. You can choose another model in setup or set `FORGE_GEMINI_MODEL`; replacing a key preserves your existing model choice. The browser sends the brief to the local server, which calls Gemini. The wristband image is an illustrative concept study.

The run graph streams the lead engineer, parts search, compatibility checks, reviewer, assembly, and GLB export as they happen. Select a node to see the associated part sources, decision, or build findings.

## Engineer the PCB

The PCB studio in `pcb-studio/` is the engineering half of FORGE. It opens on a system view of the whole device, with catalog peripherals (motors, sensors, displays, power) wired to a custom PCB by bus. Select a device to compare compatible replacements by price and current draw, or swap it. Scroll into the PCB to work on the board itself, with 3D parts, routed copper, Gemini board generation, Lean 4 design-rule proofs, and STL, GLB, OBJ, PNG and BOM exports.

```bash
uv run --locked --python 3.12 python -m forge_research.studio   # research swarm on :8000
cd pcb-studio && npm install && npm run dev                      # studio on :5173
```

### Local 3D assemblies

The engineering studio builds procedural 3D assemblies locally in the System view. Built-in shapes include a four-wheel rover, wristband, quadcopter, hexacopter, octocopter, and smart glasses. Existing procedural bodies and bundled product models are preserved and bypass Gemini body generation. For unmatched briefs, Gemini designs a custom body from bounded primitive solids around the catalog peripherals when a Gemini key is configured; the browser builds and renders that geometry. Catalog peripheral meshes remain unchanged. Without a key or when generation fails, the studio shows the local mounting plate or enclosure and reports the fallback. Built-in assemblies require no 3D-generation API key. Use the existing Export menu to download the assembly as GLB or other supported formats. Custom bodies use boxes, cylinders, rings and spheres rather than unrestricted generated meshes.

Custom body generation runs in the background independently of board completion. The chassis endpoint uses `GEMINI_CHASSIS_MODEL`, then `GEMINI_FAST_MODEL`, with the configured fast-model default as fallback. It makes one attempt with a 20-second deadline; the local preview stays available if that expires. Successful designs are cached in server memory for 30 minutes (up to 128 entries), and identical requests in flight share one call. Cache keys include the model, brief, layout and credential identity. Responses expose `Server-Timing` and `X-Forge-Chassis-Cache` for latency checks. Modal product workers also cache the Gemini design on their volume before checking/building the mesh, so repeated jobs can skip both inference and CAD generation. Redeploy the Modal worker to apply worker changes; live cloud latency has not been benchmarked.

The **Research** tab in the studio shows the research swarm from port 8000. **Engineer PCB** on a finished research run sends the brief and the selected parts to the PCB studio, which generates a board for them. Set `GEMINI_API_KEY` (or `GEMINI_API_KEY_FILE`) before `npm run dev` to enable board generation. Lean proofs need `elan`; see `pcb-studio/verify/README.md`.

## Run the research swarm

The offline wristband scenario runs from the repository root with uv. [uv documentation](https://docs.astral.sh/uv/)

```bash
uv run --locked --python 3.12 python -m forge_research --offline
```

The offline run uses scripted model responses and exercises the actual ADK workflow and lookup tool. It looks up both controller and sensor candidates, checks the proposal against records returned during that run, and prints a versioned JSON report with sources, dated prices, findings, and an agent activity trace.

For a live brief, set `GEMINI_API_KEY` or `GOOGLE_API_KEY` and set `FORGE_GEMINI_MODEL` to the Gemini model ID enabled for your account. Then run the workflow against your brief.

```bash
uv run --locked --python 3.12 python -m forge_research \
  --brief 'Design a BLE wristband using EMG for finger gestures. Keep parts under $80.'
```

The first catalog covers EMG wearables. The report distinguishes the controller and sensor subtotal from the full build budget. Its checks cover catalog evidence, the requested transport, the presence of an ADC input, and the nominal sensor supply. It also records the work still needed to validate signal range, enclosure fit, and BLE on a physical device. Custom briefs use Gemini through local Google ADK. Google-hosted Managed Agents and live supplier lookup are future integrations.

### Agent swarm

While the catalog workflow runs, the studio also fans the brief out to four Gemini specialists (requirements, sourcing, electrical, mechanical). They run in parallel with no concurrency cap, straight on the Gemini API. A lead call then merges their briefs into one design direction. The research screen streams each step in the **Agent swarm** strip: dispatch, live text, per-agent time and tokens, and the synthesis. The swarm is advisory. Catalog checks and Lean verification still decide what is accepted.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORGE_SWARM` | `on` | `off` replays the labeled offline swarm instead |
| `FORGE_SWARM_MODEL` | `FORGE_GEMINI_MODEL`, else `gemini-4-argon` | Gemini model for the specialists and the lead |
| `FORGE_SWARM_TIMEOUT` | `120` | Seconds before the swarm is stopped |

Without a Gemini key, the offline sample replays a scripted swarm so the screen still shows every step. Smoke test: `uv run --locked --python 3.12 python -m forge_research.agents.swarm "your brief"`.

### Independent datasheet verification

Supported live research builds require `REDUCTO_API_KEY` and a Gemini key
(`GEMINI_API_KEY` or `GOOGLE_API_KEY`). The default source-admission policy also
requires `PANGRAM_API_KEY`. For each known PDF, the server downloads
one copy and sends the same bytes independently to Reducto and Gemini. Gemini
never receives Reducto's proposed answers. This uses Gemini's native
[PDF input](https://ai.google.dev/gemini-api/docs/document-processing) and
[structured output](https://ai.google.dev/gemini-api/docs/structured-output).

The comparison checks exact document identity and revision, normalized numbers,
units, PDF page citations, component subject, and verbatim conditions/footnotes.
Critical values must agree; model agreement is supporting evidence, not a guarantee
that the manufacturer data or either extraction is correct. Missing limits,
ambiguous rows, provider failures, wrong variants, conflicting sources, and
unverified catalog dimensions block automatic publication and live revisions.
Chip/module evidence cannot stand in for exact board ratings or board dimensions.
The gate retains the catalog values rather than silently replacing them.

`/api/evidence/{part_id}` exposes each fact's verification state, both readings,
and `design_ready` with `blocking_reasons`. A blocked live research response keeps
the report, sets `evidence_blocked`, and prevents the automatic PCB handoff. The
research graph shows the verification stage; the part inspector shows the reasons
and source evidence. Offline samples remain explicitly labeled demonstrations.
The separate general PCB studio is not independently datasheet-verified by this gate.

Set `FORGE_DATASHEET_REVIEW_MODEL` to choose the verifier; it otherwise uses
`FORGE_GEMINI_MODEL`, then `gemini-4-argon`. Reader calls time out and PDFs over
14 MB remain unverified by Gemini. Independent results are cached by PDF hash,
subject, manufacturer, model and review/schema version; changed credentials or
catalog values invalidate in-memory approvals. Review disputed cited pages and
supply missing exact-SKU evidence before attempting a live build. There is no
model-vote override or automatic approval of unresolved disagreements.

### Research source admission and the validation report

The composer exposes an authorship policy: exclude a source at or above an
AI-detected fraction (default **50%**), optionally count AI-assisted text, and allow
0–2 additional discovery rounds (default **1**). Three search-enabled Gemini
specialists (sourcing, electrical, mechanical) look for manufacturer PDFs for the
supported catalog parts. Catalog documents are also considered. Retrieval and
redirects are restricted to known manufacturer HTTPS hosts; unrelated websites,
HTML articles and unsupported parts are not automatically admitted by this path.

For each retrieved PDF, Reducto extraction/Gemini verification and Pangram scanning
start in parallel. `pdftotext` (Poppler) extracts original PDF text locally for
Pangram; generated Gemini summaries are never substituted for source text. Long
text is split into complete scan sections; every section must complete. The source
metric is the character-weighted mean of the returned section AI fractions, with
AI-assisted fractions added only if selected. Incomplete scans, scanned-image PDFs
without extractable text, truncation, missing keys and detector failures stay
unverified. Technical manuals may produce false positives; authorship filtering
is a user policy, not factual verification.

Above-threshold sources are excluded from accepted evidence, retained in the audit,
and placed on the next search round's avoidance list. Content hashes prevent the
same document at a new URL from resetting a rejection. Discovery retries when
accepted sources are missing or still lack required verified design facts. The
budget stops after the configured rounds and at most 12 retrieved candidates.
Sources, facts and reads are pinned to the exact accepted PDF bytes; publication
and later revisions cannot substitute excluded source facts from another run.
The initial specialist narrative remains advisory, not a fact-checked report.

**Validate sources & proofs** is available after research and in the workbench.
It rechecks the saved server-side proposal or selected project revision, uses
fresh Lean kernel checks (`use_cache=False`), and returns an inspectable audit.
For runs with source filtering, validation repeats discovery/admission under the
same saved policy. The graphic separates admitted/excluded/unverified sources,
formal obligation outcomes and Pangram authorship segments. Select a source or
segment to inspect its text/decision. Engineering handoff is now an explicit
button so the report remains available for inspection.

Pangram's [inference API](https://pangram.readthedocs.io/en/stable/api/rest.html)
returns writing-origin fractions, per-segment AI-assistance indices and detector
confidence labels. It does not certify factual truth. High AI detection cannot
refute a proved proposition; a human classification cannot rescue unverified
source data or failed Lean obligations. Pangram requests disable public dashboard
links. Missing credentials and short prose produce explicit unavailable/skipped
states, never fabricated scores.

The report shows sample standard deviation (`n−1`) across comparable reader
measurements and across Pangram segment indices separately. A single observation
has no sample SD. These are descriptive spreads, not calibrated probabilities of
correctness or confidence intervals. No combined truth score is invented. Lean
proves only the emitted constraints given the catalog inputs; narrative claims,
physical behavior and source authenticity are not thereby proved.

Research and project validation endpoints are
`POST /api/research/{research_id}/validate` and
`POST /api/projects/{project_id}/validate` (with `base_revision`). Download buttons
export self-contained HTML or full JSON via `/api/validations/{validation_id}`
and `/api/validations/{validation_id}/report.html`. Reports contain source hashes,
identities, retained exclusions, detector scopes/model version, numerical spread,
proof inputs/theorems/kernel script, limitations and the audit-payload SHA-256.
Saved research and audit records are bounded in-memory snapshots; restart or
eviction requires running research/validation again. Offline demos stay labeled
and do not pretend to have passed live authorship checks.

Run the workflow and catalog tests.

```bash
uv run --locked --python 3.12 python -m unittest discover -s tests
```

## Hackathon demo

> Design a wrist-worn finger-gesture detector using muscle sensors for under $100 that sends gesture events to my laptop over Bluetooth Low Energy.

1. **Describe the device.** The lead agent turns the prompt into reviewable requirements for cost, inputs, connectivity, and fit.
2. **Generate a design.** Gemini specialists select parts from a small, sourced catalog. FORGE builds the circuit, firmware, BOM, and adjustable 3D enclosure from one versioned device specification.
3. **Inspect and test it.** Open a part to see its pin assignments, cost, and datasheet. Run firmware against synthetic muscle-signal inputs. Show a failing assertion, the repair an agent proposes, and the result of rerunning the test.
4. **Revise it.** Edit the wrist size or change the budget from $100 to $80. FORGE recomputes the affected artifacts and reports any constraint the supported catalog cannot satisfy.

The demo uses one ESP32 target and synthetic EMG envelope traces. Firmware behavior is the validation target. BLE hardware testing, individual-finger recognition on real users, and fabrication-ready outputs are future milestones.

## Workspace

| Area | What the user sees |
| --- | --- |
| Design controls | Requirements, budget, parts, compatibility, and enclosure dimensions |
| Prototype | Rotatable 3D assembly, wiring and schematic, firmware, and BOM |
| Agent activity | Tool results, design decisions, validation evidence, and revision diffs |

## Local reference checkout

The prep workspace keeps CircuitMind in its own Git checkout at `CircuitMind/`. To recreate the reference checkout, run these commands from the root.

```bash
git clone https://github.com/takemygunq/CircuitMind.git CircuitMind
git -C CircuitMind checkout --detach d5237aefb880bb4dff122f8be45c475b7b84c0c7
```

Use Node.js 24+ and Corepack to start CircuitMind's scripted demo locally.

```bash
cd CircuitMind
corepack pnpm install --frozen-lockfile
CIRCUITMIND_MOCK_AI=1 corepack pnpm dev
```

Open `http://localhost:3000` and try “Build an ESP32 weather station for my balcony.” This exercises the upstream pipeline using scripted model responses. [CircuitMind source and license](https://github.com/takemygunq/CircuitMind/tree/d5237aefb880bb4dff122f8be45c475b7b84c0c7)

The upstream type check passed, and its test suite reported 574 passed and 5 skipped. A local smoke test loaded the homepage and confirmed that the scripted weather-station request streamed a failed electrical check, a repair, and a passing result.

## Build plan

See the [MVP plan](docs/mvp-plan.md) for the integration order and repair scenario, and the [prototype pipeline](docs/prototype-pipeline.md) for the research-to-CAD handoff and editable Three.js workspace.

FORGE's judging demo centers on the autonomous repair loop. The event lists an overall competition and a Best Use of Managed Agents prize. The build plan includes a check for the actual Google Managed Agents integration and event requirements. [Gemini 4 NYC Hackathon](https://cerebralvalley.ai/e/gemini-4-nyc)
