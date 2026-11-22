# Voice and state-bound copy

Thoughtful, practical, curious and warm without sentimentality. Name the object, constraint and next action. Separate “you reported” from “we checked.” Never imply an illustration is a measurement. No revolutionary, democratization, unlock endless possibilities, harness AI, seamlessly transform or guaranteed compatibility. No confidence percentages without a defined validated measure. No essay explaining an agent's thinking.

All consumer presentation below is proposed copy. Enable only in the listed state; the baseline does not contain a finished consumer journey. Research rationale: [PRODUCT_VISION](PRODUCT_VISION.md).

| Surface / actual or proposed state | Production-ready text / action |
|---|---|
| Landing, supported scope | **FORGE — Make It Last.** Some things are worth fixing. Check replacement options for the Rover R1 template and see what still needs confirmation. **Check my options** |
| Intake | **What is happening?** Tell us what the rover does when it should move. A reported broken motor is a starting point, not a diagnosis. |
| Object/target confirmation, proposed UI | **Does this template match your rover?** Front-left drive · m1 · J2. **Confirm this motor** / **This is not my rover**. Template image is illustrative, not a scan of your rover. |
| Priorities | **What must stay the same?** Keep the original appearance. **What is your spending limit in USD?** Include shipping, tax, tools and labor. You can change these priorities before deciding. |
| Missing/ambiguous budget | **Confirm your budget in USD.** We need a number before comparing catalog prices. |
| Manual upload before request | **Add a manual (optional).** PDF, up to 10 MiB. This file will be sent to an external document extraction service. Extracted details need review before they can support a repair. **Choose PDF** |
| Manual returned, unreviewed | **Details extracted—not verified.** Check the document and references. These details have not changed the catalog or established compatibility. |
| Separate TI demonstration | **TI ULN2003A chip datasheet.** This document does not establish your rover motor or module specifications. |
| Pending deterministic analysis, only while request outstanding | **Checking catalog constraints…** No percentage, simulated specialist steps or live-provider claim. |
| Current no-solution recommendation | **No supported replacement yet.** We don't have enough information to recommend a replacement yet. The catalog voltage ranges rule out two motors on this template rail. The other still needs current and fit evidence. |
| Why this repair / decision | **Why not buy yet?** A low unit price does not resolve voltage, driver or mounting requirements. **See evidence and rejected options** |
| Alternatives | **Three catalog motors compared.** None is eligible for this template repair. Show voltage, fit status and unit cost in one table; do not badge any “best match.” |
| Electrical warning | **Voltage mismatch.** The template rail is 7.4 V. This catalog motor supports 3–6 V. Do not treat it as a supported replacement. |
| Partial voltage match | **Voltage range matches the nominal rail only.** Driver current, mounting and shaft fit are unresolved. |
| Purchase, current state | **Do not buy from this comparison yet.** Prices are catalog references, not live quotes. Shipping, tax and labor are unknown. No order has been placed. Hide purchase CTA; keep source/details links. |
| Conditional future supported state | **Review this repair plan.** The checked electrical constraints passed. Physical testing is still needed. Only render when the identified electrical checks actually passed; show which checks. |
| Provider failure | **Live advice is unavailable.** No live result was returned. **Run catalog-only check** is an explicit new request, never a silent live fallback. |
| Manual service failure / missing key | **We couldn't extract this PDF.** No document facts were accepted. Try again later or continue with catalog-only information. Missing configuration is operator detail; do not expose credentials. |
| Unsupported object | **This check supports the Rover R1 template only.** We can't recommend a part for this object. |
| Apply 422 | **No change made.** No candidate has enough evidence for substitution. |
| Stale revision 409 | **This result is out of date.** Reload the current summary before trying again. |
| Missing session 404 | **This session is no longer available.** Sessions are temporary and may be lost on restart. **Start a new check** |
| Undo 422 | **Nothing to undo.** No repair was applied in this session. |
| Summary | **Rover R1 · no supported replacement.** Goal: keep appearance, spend below $30. Motor failure not confirmed. Catalog unit prices $1.60–$7.50; repair total unknown. Next: confirm affected wheel and motor/driver identification. Nothing bought or changed. |

Keep error text with the affected control, announce returned status accessibly, and preserve entered priorities after recoverable errors. Model current `≤` budget behavior honestly until backend supports strict “below”; frontend must not silently translate the distinction. Do not show the table's concrete three-motor summary for an unrelated object or failed request.
