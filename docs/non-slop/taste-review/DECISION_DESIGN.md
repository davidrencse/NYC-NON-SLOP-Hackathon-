# Decision design

A decision record is inspectable evidence and consequences, **not chain-of-thought**. Initial view: recommendation, blocking uncertainty, cost basis, next action. Expand Why for the following seven headings; blockers remain visible when collapsed.

## Complete actual decision: Rover R1, m1

Based on `pcb-studio/src/data/system.ts` defaultSystem/motor and `catalog/peripherals.ts:702–775`, and `server/consumer-repair.ts:analyze`. No physical object or manufacturer motor datasheet was inspected. Stable target `m1` = front-left drive, port `J2`, catalog `tt-motor-148`, nominal rail 7.4 V. Default target is a hypothesis until confirmed.

### RECOMMENDATION

Do not buy a replacement motor yet. No current catalog candidate supports a recommendation for this template under the stated requirements. **We don't have enough information to recommend a replacement yet.**

### WHY

You want unchanged appearance and spending below $30. Unit prices alone are below that limit, but neither a complete cost nor a suitable replacement is established. The existing TT catalog entry itself conflicts with the nominal rail; replacing like-for-like does not resolve that conflict.

| Catalog ID | Unit USD, not quote | Catalog voltage / current | Nominal dimensions mm (w × h × thickness) | Decision |
|---|---:|---|---|---|
| `tt-motor-148` | $1.60 | 3–6 V; 250 mA running; description says stall over 1 A | 70 × 22.5 × 18.8 | Reject on 7.4 V nominal rail. Same catalog geometry does not establish actual fit. |
| `n20-gearmotor-100` | $3.20 | 3–6 V; 100 mA running; description says stall about 0.5 A | 24 × 12 × 10 | Reject on rail; different mount/shaft/drivetrain unresolved. Smaller is not drop-in. |
| `jga25-370-12v` | $7.50 | 6–12 V; 300 mA running; description says stall around 2 A | 62 × 25 × 25 | Rail lies in catalog range only. Driver peak, mounting, shaft and appearance unresolved; not eligible. |

All three records mark current/dimensions approximate. Catalog descriptions are not measured stall tests. Shipping, tax and labor are unknown; tools, mounts or other changes may add costs and have no quote. These are per-motor prices, not four-motor totals or installed repair totals. No actual budget rejection at $30 is established.

### WHAT WE PRESERVED

Your appearance requirement and budget remain constraints. Nothing was bought, mutated or physically repaired. The original shell/wheels are not promised to fit any replacement.

### WHAT WE GAVE UP

An immediate purchase and an unsupported one-click repair. The rover remains unresolved; this result does not restore motion.

### WHAT WE REJECTED

TT and N20 on nominal voltage; JGA25 as a recommendation despite its range match, because other checks are unresolved. A rail redesign is outside a motor substitution and needs new engineering/cost review. Full rover replacement has no quote/comparison and may contradict appearance; it is not automatically a better choice.

### WHAT WE STILL DON'T KNOW

Whether the motor failed; whether m1 is the affected motor; whether this template describes the actual rover; exact driver and motor variants; real supply limits; shaft/wheel/mount clearances; installation procedure; total cost. Full rover warnings remain: board clearance/all_rules failures, disconnected copper islands, thermal model limited to 7.4 V despite 12 V label. No global safety or manufacturing readiness claim.

Evidence classes: **checked engineering relation** = nominal 7.4 exceeds catalog 6 maximum for TT/N20; this is a comparison, not physical verification. **Catalog specs** = table above, generic curated entries, not newly source-admitted motor specifications. **Source-backed document** = real TI ULN2003A PDF, irrelevant to proving these motor/module facts. **Agent hypothesis** = replacing a failed motor might help. **Missing evidence** = diagnosis and exact-part documentation. **Unverified physical assumptions** = template rail/geometry matches the real rover and installation preserves appearance.

### NEXT STEP

Confirm the affected wheel and whether the template matches. Provide accessible motor and driver labels/manual references without opening or powering the rover for this demo. Ask a qualified repairer to resolve diagnosis, supply/driver limits and mechanical fit using an appropriate procedure. Do not perform a powered stall test from these notes. Then re-evaluate; do not buy first.

## UI-ready condensed record

**No supported replacement yet**

The TT and N20 catalog voltage ranges do not cover the template's 7.4 V rail. JGA25 covers that nominal voltage, but driver current and fit are unresolved. Catalog unit prices: $1.60 / $3.20 / $7.50; delivered repair total unknown. Nothing changed.

**Next:** confirm which wheel is affected and the motor/driver labels. **Why this decision** expands the seven headings above. **Change priorities** and **This is not my rover** let the person disagree without overriding evidence gates.

## Three complete outcomes

### A — supported repair meets requirements (illustrative, conditional; NOT this build)

Only if diagnosis confirms a motor failure, exact original-part documentation and reviewed measurements support electrical and mechanical fit, appearance remains unchanged, and an actual complete quote is below $30: recommend the documented original-part replacement. Why: changes only the failed part and meets confirmed priorities. Evidence: exact source references, reviewed driver/supply and fit checks, dated itemized quote; none currently supplied. Alternative: different motor requiring drivetrain changes, rejected because it adds unneeded changes; complete replacement requires a separate quote. Known price **today: none for this supported scenario**; do not reuse $1.60 as a delivered quote. Remaining uncertainty: physical installation/testing. Next: person approves the documented guide/service plan, then physical testing. “The checked electrical constraints passed. Physical testing is still needed” is conditional copy, not a present result. No SKU or invented price assigned to this hypothetical positive case.

### B — electrical rejection (actual at below $30)

Use the actual record above: TT/N20 rejected, JGA25 unresolved; no purchase. More money alone cannot resolve voltage/fit. Budget subcase: if person instead sets $1, all three known unit prices exceed it even before extras; reject on unit budget too. Source: same table, not a new quote. Offer further diagnosis or reconsider priorities, not a forced upsell. Preserve appearance requirement; next evidence request remains the same.

### C — insufficient information (actual boundary)

If the person cannot confirm template/target or supply labels: no replacement recommendation. “We don't have enough information to recommend a replacement yet.” Explain which information changes the decision: object identity, affected wheel and accessible motor/driver identification. Prices are only template examples, not estimates for their object. Replacing nothing/consulting a repairer beats guessing; do not rank a motor. Next: collect accessible labels or stop. A missing budget is an input error requiring confirmation, not a zero-dollar repair. The API currently requires a rover description and explicit nonnegative USD budget; a friendlier insufficient-information screen is proposed FE work.

## Semantic/API handoff (recommendation only; no API edits)

Use existing response fields directly: `analysis.status`, `recommendation`, `verification`, `component_id`, `component_selection`, `goals`, `system`, `candidates[].candidate_id/specs/known_cost/price_kind/unknown_costs/eligible/compatibility/appearance/explanation/evidence/unresolved`, plus session `id/revision/history`. `recommendation:null` means no supported option, never choose the cheapest automatically. Existing `explanation` provides hypothesis/priorities/reasons/rejected/alternative_preferable; these are not seven new API headings.

Suggested future decision view-model fields: `recommendation_text`, `why[]`, `preserved[]`, `given_up[]`, `rejected[{candidate_id,reason,evidence_refs}]`, `unknowns[{question,needed_for}]`, `next_step`, `cost{currency,unit,kind,total:null}`, `evidence[{claim,kind,source,page,review_status}]`. FE can derive current headings without changing transport; BE should add typed field-level evidence and quote completeness only when implemented. Do not persist agent prose as engineering facts. Top-level Hermes advice currently is not retained in summary. Apply/undo remains unavailable; stale revision 409, current apply/undo 422, revision 0.
