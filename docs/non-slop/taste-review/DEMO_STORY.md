# Demo story — one decision in 90 seconds

## Honest current-capability path

This is a timed presentation script, not a rehearsed browser result. Current consumer backend is partial P0. Use the existing Rover R1 editor only for labeled template context, then an API client's formatted response for evidence. Do not pretend an intake or decision frontend exists. A teammate's separate UI must be inspected/rehearsed before replacing these actions with clicks.

Preflight: run the Vite dev server on :5173; static/preview hosting does not serve this namespace. GET `/api/consumer-repair/demo` returns a **scripted request**, not a captured provider run. Prepare POST `/api/consumer-repair/analyze` with `{ "description":"My little rover has a broken motor. I want to keep its original appearance and spend less than $30.", "budget":30, "preserve_appearance":true, "component_id":"m1", "mode":"deterministic" }`. Selection of m1 is a presenter assumption, not diagnosis. Budget 30 is the current API ceiling; all catalog unit costs are strictly below it anyway, total still unknown.

| Time | Screen action | Spoken narrative |
|---|---|---|
| 0–12s | Show existing rover template; identify it as a template, not a scanned object. | “FORGE: Make It Last. Some things are worth fixing. This person wants a rover moving again, without changing its appearance or spending $30.” |
| 12–25s | Show scripted request and explicit priorities; point to m1 as an assumed front-left target. | “They report a broken motor. We haven't diagnosed it. For this demonstration we select the front-left motor in Rover R1; a real owner must confirm the object and affected wheel.” |
| 25–40s | Send deterministic POST. Show returned no_solution and recommendation:null. If request fails, show failure, not a prepared success labeled live. | “This is a catalog-only check, not Hermes or a physical test. Its useful answer is: don't buy yet. No candidate has enough evidence.” |
| 40–57s | Expand candidate specs/rejected evidence: TT and N20 ranges against system rail. | “The original-style TT costs $1.60 in the catalog. But its 3-to-6-volt range doesn't cover the template's 7.4-volt rail. The $3.20 N20 has the same voltage problem and different geometry. Cheap doesn't mean suitable.” |
| 57–72s | Show JGA25 specs and unresolved list; keep all eligible:false visible. | “The $7.50 JGA25 includes that nominal voltage, but its driver current and mounting still need evidence. Choosing it just because the voltage range matches could change the appearance or require more parts.” |
| 72–83s | Show summary, original warnings and unknown_costs; no purchase/apply click. | “None of those is an installed repair price. Shipping, tax and labor are unknown. Next: confirm the affected wheel and motor/driver labels, then get the electrical and fit questions reviewed.” |
| 83–90s | Hold no-solution decision. | “When generation is cheap, the valuable choice is knowing what not to change—and explaining why. Nothing bought. Nothing falsely verified.” |

This intentionally demonstrates an evidence-based refusal, not a fixed rover. Budget/electrical consequences and one rejected worse choice carry the story; do not detour through every feature. Do not claim measured environmental savings, testimonials, personal histories or hardware verification.

## Optional separate integration demonstration, not part of the 90s

Hermes: official gateway path exists, but baseline has no executable/configuration/live transcript. Deterministic checks use actual catalog data; provider success tests use mocks. Never narrate specialist animation as live Hermes work. A future live run must show returned execution evidence and retain “agent prose is not engineering evidence.” Missing gateway fails explicitly; rerunning catalog-only is a separately labeled action.

Reducto: raw PDF `/api/consumer-repair/manual`, max 10 MiB; real TI `docs/manuals/uln2003a.pdf` is prepared. Missing key is reported as 503 for this upload path; success mocks are not live extraction. It documents a ULN2003A chip, not motor compatibility. Demonstrate ingestion separately only with working credentials and disclose extracted facts are unreviewed. No fabricated timing, extracted values or motor-source admission.

Baseline reports 112 Python + 26 TS + 3 UI checks and build; this is not live service, physical or browser evidence. Apply returns 422; stale revision 409. Undo unavailable. Don't spend demo time making a knowingly rejected apply call look like repair progress.

## Aspirational successful-apply path — blocked, not current capability

Keep the opening priorities and replace investigation only after an actual supported case exists (see conditional A in DECISION_DESIGN). Show exact-part diagnosis/evidence, scoped electrical checks, reviewed fit/appearance and a complete below-$30 quote. Present a rejected alternative and what the chosen repair gives up. Person approves; only then demonstrate an implemented versioned mutation with returned revision and an independently tested undo. Finish with physical testing still required. Do not use editor undo or a changed 3D mesh as proof of consumer apply or physical repair. This path requires new engineering and evidence; it is not available by changing narration.
