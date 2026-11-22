# Adversarial acceptance and handoff

These are proposed acceptance checks, **not passed user studies**. Source-only review of `c4251ec`; no quality score. Current capability is a no-solution slice, not a completed consumer repair demo.

## Five highest-impact fixes before judging

| Order / owner | Exact change | Observable acceptance check |
|---|---|---|
| 1 · FE consumer teammate + BE consumer routes | Bind returned no_solution/recommendation:null to primary decision and suppress purchase/apply/undo; confirm template and affected motor. Preserve existing server gates. | Submit the rover scenario: none of three candidates is selectable as a supported repair; no browser model mutation. Default m1 cannot be mistaken for diagnosis. Existing apply 422 and stale 409 still hold. |
| 2 · BE shared system/catalog + FE comparison | Replace `system.ts` “Drop-in alternate” with “Catalog-listed alternative; fit unverified.” Split nominal voltage range match from electrical approval and actual fit. | TT/N20 visibly fail 7.4 V range comparison. JGA25 never gets a compatibility success badge; current/fit unknowns are visible without expansion. No “hardware verified.” |
| 3 · FE/content owners of both interfaces | Replace universal live-price/auto-repair claims in `forge_research/web/index.html`; scope verification labels in workbench and React repair/proof UI. | With no credentials and no matching offers, no copy claims live execution, every-part quotes, automatic repair or physical validation. Failed/unchecked obligations remain readable. |
| 4 · BE `consumer-repair.ts` + FE intake | Derive candidate priorities from confirmed goals, preserve explicit false; distinguish strict below vs inclusive ceiling and unit catalog price vs complete cost. | Appearance=false is not summarized as “preserve appearance.” At exactly $30, a strict below-$30 rule rejects. Missing costs never become zero or an all-in total; $1 ceiling rejects all three known units. |
| 5 · FE decision + BE evidence/manual owner | Implement seven-heading decision view from current fields; retain provenance and unknowns. Before future eligibility, add reviewed exact-part/page evidence, diagnosis, driver/fit checks and cost completeness; do not admit raw extraction automatically. | Every consequential claim links to its evidence class. TI chip PDF cannot turn a motor eligible. Summary remains useful with agent prose hidden; current result ends in accessible label/identity request, not purchase. |

## Testable quality definition

- [ ] **10-second understanding:** in a planned formative session, show the collapsed decision for 10 seconds, then hide it. Ask an ordinary repair owner what to do, why, and what remains unknown. Require “don't buy yet,” voltage/fit blocker and next evidence request. Record confusion; do not report success before testing.
- [ ] **Goal-oriented steps:** annotate each input/action with the decision it changes. Remove any step with no effect on identification, constraints, eligibility or next action.
- [ ] **Why and unknowns:** blocking voltage/current/fit uncertainty and price basis are visible initially; expanded Why exposes all seven headings without a reasoning transcript.
- [ ] **Meaningful personalization:** changing budget or appearance yields changed goal text and relevant tradeoffs, not a decorative personalized paragraph. Safety gates cannot be overridden by preferences.
- [ ] **Real alternatives:** compare actual stable IDs, same units, price kind and rejection reasons. Include “buy nothing yet”; do not manufacture a positive winner.
- [ ] **Avoid unnecessary purchase:** current no-solution never produces checkout, hidden cart, preselected purchase or auto-apply. Raising budget alone does not clear electrical/fit blockers.
- [ ] **Disagreement:** person can change priorities, correct target/template or stop; correction discards stale advice and requires a new check. No argument that the AI knows better.
- [ ] **Honest words:** repository copy search/review finds no unqualified consumer live/verified/drop-in/guarantee claim. Agent hypotheses, catalog facts and physical assumptions stay distinct.
- [ ] **Actionable output:** summary states affected template target, constraints, no-solution, real known unit costs, unknown total and safe next evidence request. No unsupported disassembly or powered test instructions.
- [ ] **Useful without AI branding:** hide provider names/activity panels; a reader can still explain the decision and next step. Removing tokens/avatars must remove no evidence.
- [ ] **Theme answered:** presenter explains a rejected unnecessary change and retained requirement, not how many things were generated.
- [ ] **Visual/accessibility:** template vs actual image label, text equivalents for annotations, keyboard disclosure/priority editing and announced errors/status; blockers do not depend on color. Requires browser checks later.
- [ ] **Failure integrity:** rehearse unavailable Hermes, unavailable manual extraction, missing session, ambiguous budget and stale revision. Each ends in explicit failure/next action, never simulated progress or silent fallback.

## Documentation verification / release boundary

Owned deliverables only: PRODUCT_VISION.md, ANTI_SLOP_AUDIT.md, VOICE_AND_COPY.md, DECISION_DESIGN.md, DEMO_STORY.md and this file, all under `docs/non-slop/taste-review/`. No production/API/style changes, dependencies, agents, push, merge or worktree deletion. Verify six files, internal links, catalog numbers/IDs against source, whitespace and changed-path scope before local commit. No code test rerun needed for this doc-only change; baseline reported tests are attributed, not reproduced.

Research sources and extraction limitations are recorded in PRODUCT_VISION; exact decision evidence in DECISION_DESIGN. Highest residual risk: a presenter or UI combines model proofs, generic catalog data and provider prose into an unsupported physical-repair claim. Deliberately defer successful apply, diagnosis, purchasing and generated instructions until those capabilities have evidence; no copy can resolve that engineering gap.
