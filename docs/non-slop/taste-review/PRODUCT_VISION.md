# FORGE — Make It Last

**Some things are worth fixing.** Help someone decide what to keep, what to change and what to check before spending money. A reasoned refusal is a useful result; a generated object is not automatically a better one.

## Review boundary

Inspected source at `c4251eca957432818fad3bc4969905d5f8a846cd` (consumer-repair baseline). Read `docs/FORGE_NONSLOP_BACKEND_REVIEW_1.md` and `docs/NONSLOP_API_CONTRACT.md` first. Also consulted the earlier root AGENTS inspection, treating its older findings as context, not current test results. This is source review and desk research, not browser review or user testing. All proposed consumer screens below are recommendations, not delivered UI. Existing interfaces are `forge_research/web/` and React `pcb-studio/src/App.tsx`; no consumer-route call was found in that React shell.

Backend is partial P0: deterministic rover analysis, costs/specs/provenance, no-solution and rejection gates exist. Successful apply/undo, physical validation and live Hermes/Reducto execution are not established. Reported baseline checks: 112 Python, 26 TS, 3 UI tests and build; not rerun for these documents.

## One person, one job

> My little rover has a broken motor. I want to keep its original appearance and spend less than $30.

Goal: restore useful motion without unnecessarily replacing the object or changing its appearance, with an all-in spend **below** $30. “Broken motor” is the person's hypothesis, not a diagnosis. Full replacement may discard working parts and violate appearance preference; it is not proven more expensive or worse environmentally. Compare it only with an actual quote and the person's consent.

| Need | Ask / use | Boundary |
|---|---|---|
| Identify the problem | Which wheel fails? What happens when it should move? Any label/model or accessible external photo? | Do not infer motor failure from prose; wiring, driver and power remain possible causes. |
| Match the object | Confirm whether the Rover R1 template matches; ask which motor | Template `m1` is front-left J2, not identification of a real object. |
| Keep appearance | Confirm unchanged shell/wheels; ask before mount/drivetrain changes | Boolean preference is available; actual fit/appearance is unknown. |
| Control spend | Confirm USD and whether $30 includes shipping, tax, tools and labor | Catalog unit prices exist; a total does not. Current API uses ≤ budget, unlike “less than.” |
| Decide safely | Show rejected options and missing evidence next to decision | No unsupported installation, battery probing or energized stall-test instructions. |

Already available: stable template IDs, 7.4 V nominal motor rail, catalog voltage ranges, approximate dimensions/current, catalog prices and system warnings. Unknowable from this request: real rail behavior, exact motor/shaft/mount, driver peak rating, fault, tools/skill, delivered cost. Ask for accessible identification first; refer electrical measurements and disassembly to a qualified repairer with the correct device procedure.

Success now: person can explain why not to buy, identify the next evidence needed and leave without a purchase. Future success: supported repair plan, accepted tradeoffs, complete cost and appropriately scoped checks—not a promise of physical success.

## Research → implementable patterns

Primary sources fetched/read for this review; observations are not FORGE research results. These recommendations still need testing with ordinary repair owners.

| Primary source / observed guidance | FORGE recommendation |
|---|---|
| [NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) distinguishes core/advanced disclosure from sequential steps; interdependent decisions should stay together. | Put outcome, budget and blockers on one decision screen. Keep priorities editable there. Expand specs/provenance, never hide a safety blocker. Use explicit “Compare the three catalog motors,” not “Learn more.” |
| [GOV.UK: Identify user needs](https://www.gov.uk/guidance/content-design/user-needs) requires action-based needs and acceptance criteria, not invented needs that justify a tool. | Every question must change diagnosis, eligibility or next action. Remove provider setup from consumer intake. Ask “Which wheel is affected?” not “Choose your agent team.” |
| [GOV.UK: Writing guidelines](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/) says content must help people find and understand what they need. The old writing-for-GOV.UK URL redirects; tone-of-voice extraction failed. | Editorial recommendation: short outcome-first sentences, verbs on buttons, expand “stall current” as “current when the motor cannot turn.” Do not attribute unextracted detailed plain-language rules to that page. |
| [iFixit: Creating a Repair Guide](https://www.ifixit.com/Info/Repair_Guide) calls for clear steps, warnings, tools, difficulty/time and action photos; identify connectors and screws precisely. | Do not generate generic “swap the motor” steps. Require an exact supported guide before instructions. Until then show an annotated template location, labeled illustrative, plus a request for accessible labels. Text labels accompany color markers. |
| [Apple Service and Repair](https://support.apple.com/repair) starts with product/problem, separates service options/cost expectations, and qualifies self-service by experience. | Confirm object first; offer “Ask a repairer” as a legitimate path. Separate catalog cost from service quote. Do not borrow Apple's certification or imply FORGE is an authorized repair service. |

Taste rule: fewer choices, stronger reasons. Keep the object and the person's constraints visually primary; AI/provider branding is secondary. Customization belongs only when it serves a stated need. No confidence percentages, sentiment stories or decorative activity as substitutes for evidence.
