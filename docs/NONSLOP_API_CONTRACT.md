# FORGE consumer repair contract

Dev-only Vite backend at :5173, namespace `/api/consumer-repair`; no Python EMG conversion. JSON responses, errors `{error: string}`. In-memory sessions (restart loses them), maximum 32. No physical safety certification.

- GET `/demo`: supported Rover R1 system and scripted example request.
- POST `/analyze`: `{description:string,budget?:number,component_id?:string,preserve_appearance?:boolean,mode?:"deterministic"|"live"}`. Default component m1 is a hypothesis, not a diagnosis. Budget can be parsed from `$30`; ambiguous input requires explicit budget. Returns session id, revision, goals, system specs, candidates, evidence, unresolved issues and recommendation (possibly null).
- GET `/{id}/options` or `/{id}/summary`: current session, analysis and history.
- POST `/{id}/apply`: `{base_revision:number,candidate_id:string}`. Returns 409 for stale revision, otherwise 422: no current candidate is eligible. No mutation is implemented in this review. Revision remains 0.
- POST `/{id}/undo`: `{base_revision:number}`. Returns 422 because there are no applied revisions.
- POST `/manual`: raw application/pdf body, maximum 10 MiB. Actual Reducto extraction via existing Python adapter, exposed separately on Python :8000 (Vite proxy). Unreviewed extraction is not catalog evidence.

Candidates distinguish catalog price (USD, not live quote), unknown shipping/tax/labor, electrical compatibility, appearance uncertainty, provenance and rejected reasons. Existing full rover warnings remain applicable. Missing evidence never establishes success. Live Hermes is optional and must fail explicitly if unavailable; deterministic mode is not Hermes execution.

UI: use fetch against :5173; never apply agent prose. Keep returned revision and send it as base_revision. Display recommendation=null as no supported solution. This backend does not mutate browser Zustand state or layouts. Reuse the returned system with the existing system renderer if desired.
