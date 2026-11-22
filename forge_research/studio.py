"""Local web entry point for the FORGE Interactive Engineering Studio."""

from __future__ import annotations

import asyncio
import time
import json
import logging
import os
from collections import OrderedDict
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import UUID, uuid4

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.genai.errors import APIError
from pydantic import BaseModel, Field, ValidationError

from .bom import compute_cost_breakdown, format_minor_currency
from .agents.swarm import SwarmReport, run_swarm, swarm_available, swarm_model
from .catalog import PARTS, ResearchError
from .evidence.datasheets import (
    ComponentEvidence, EvidenceBlocked, EvidenceRegistry, documents_for, evidence_registry,
    require_design_evidence, require_cached_design_evidence,
)
from .providers.keys import KeyUpdate, forget_saved_keys, integrations_status, load_saved_keys, update_keys
from .providers.llm import live_model, provider_error_status
from .engineering_handoff import handoff_router
from .providers.gemini_models import list_gemini_models
from .providers.usage import UsageSummary, usage_summary
from .providers import modal_cad
from .geometry import (
    AssemblyManifest,
    AssemblyParameters,
    GeometryError,
    build_assembly,
    export_glb,
)
from .models import (
    ActivityEntry,
    DeviceSpecification,
    ProcurementState,
    ResearchReport,
    RevisionDiff,
    VerificationReport,
)
from .offline import DEMO_BRIEF, DemoModel
from .procurement import (
    ShopMcpError,
    get_shop_product,
    search_part_offers,
)
from .project import (
    DesignEdit,
    ManagedProject,
    ProjectView,
    RevisionRecord,
    apply_design_edit_to_spec,
    build_project_view,
    compute_revision_diff,
    evaluate_and_commit_revision,
    initial_spec_from_report,
)
from .repair import (
    apply_repair_patch,
    choose_repair_model,
    propose_repair_patch,
)
from .verify import find_lean_binary, verify_design, verify_design_sync
from .workflow import Progress, run_research, stage_event
from .validation import ValidationReport, validate_report
from .source_research import SourcePolicy, SourceResearch, research_sources, admitted_evidence, require_admitted_evidence
from .validation_html import render_validation_html

WEB = Path(__file__).with_name("web")
logger = logging.getLogger(__name__)
app = FastAPI(title="FORGE Studio", docs_url=None, redoc_url=None)
from .consumer_manual import router as consumer_manual_router
app.include_router(consumer_manual_router)
app.mount("/static", StaticFiles(directory=WEB), name="static")

# Browsers were keeping the last HTML/JS (304s) after this process died, so the
# page stayed on an old UI while Gemini kept editing the files. Never store a
# response, and reload the open tab when anything under web/ changes.
_DROP_HEADERS = {b"cache-control", b"etag", b"last-modified", b"expires", b"pragma"}
_NO_CACHE = (
    (b"cache-control", b"no-store, max-age=0, must-revalidate"),
    (b"pragma", b"no-cache"),
    (b"expires", b"0"),
)
_LIVE = (
    b'<script id="forge-live">(function(){var rev=null;async function tick(){'
    b'try{var r=await fetch("/api/assets-rev",{cache:"no-store"});if(!r.ok)return;'
    b"var j=await r.json();if(rev!==null&&j.rev!==rev)location.reload();rev=j.rev;}"
    b"catch(e){}setTimeout(tick,1000);}tick();})();</script>"
)


class AlwaysFresh:
    def __init__(self, asgi):
        self.asgi = asgi

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.asgi(scope, receive, send)
            return
        path = scope.get("path", "")
        inject = scope.get("method") == "GET" and path in ("/", "/index.html")
        if not inject:
            async def send_headers(message):
                if message["type"] == "http.response.start":
                    headers = [(k, v) for k, v in message.get("headers", []) if k.lower() not in _DROP_HEADERS]
                    headers.extend(_NO_CACHE)
                    message = {**message, "headers": headers}
                await send(message)

            await self.asgi(scope, receive, send_headers)
            return

        started: dict[str, Any] = {}
        chunks: list[bytes] = []

        async def capture(message):
            if message["type"] == "http.response.start":
                started.update(message)
                return
            if message["type"] != "http.response.body":
                await send(message)
                return
            chunks.append(message.get("body") or b"")
            if message.get("more_body", False):
                return
            body = b"".join(chunks)
            if b"forge-live" not in body and b"</body>" in body:
                body = body.replace(b"</body>", _LIVE + b"</body>", 1)
            headers = [
                (k, v)
                for k, v in started.get("headers", [])
                if k.lower() not in _DROP_HEADERS | {b"content-length"}
            ]
            headers.extend(_NO_CACHE)
            headers.append((b"content-length", str(len(body)).encode()))
            await send({**started, "type": "http.response.start", "headers": headers})
            await send({"type": "http.response.body", "body": body})

        await self.asgi(scope, receive, capture)


app.add_middleware(AlwaysFresh)


class ResearchRequest(BaseModel):
    mode: Literal["live", "sample"]
    brief: str = Field(default="", max_length=4000)
    source_policy: SourcePolicy = Field(default_factory=SourcePolicy)


class Prototype(BaseModel):
    project_id: UUID
    revision: int
    device_spec: DeviceSpecification
    manifest: AssemblyManifest
    glb_url: str


class StudioReport(ResearchReport):
    research_id: UUID = Field(default_factory=uuid4)
    prototype: Prototype | None = None
    prototype_error: str | None = None
    evidence_blocked: bool = False
    evidence: list[ComponentEvidence] = Field(default_factory=list)
    project: ProjectView | None = None
    swarm: SwarmReport | None = None
    source_research: SourceResearch | None = None
    compute: list[dict[str, Any]] = Field(default_factory=list)


class AssemblyEdit(BaseModel):
    base_revision: int = Field(ge=1)
    wrist_circumference_mm: float = Field(allow_inf_nan=False)


class RestoreRequest(BaseModel):
    base_revision: int = Field(ge=1)
    target_revision: int = Field(ge=1)


class RepairRequest(BaseModel):
    base_revision: int = Field(ge=1)
    mode: Literal["live", "sample"] = "live"


class RepairResponse(BaseModel):
    repaired: bool
    attempts: int
    actor: Literal["claude", "gemini", "nous", "offline_fixture"]
    rationale: str
    diff: RevisionDiff | None = None
    project: ProjectView


class ProcurementSearchRequest(BaseModel):
    catalog_id: str | None = None
    query: str | None = Field(default=None, max_length=200)
    country: str = Field(default="US", min_length=2, max_length=2)
    currency: str = Field(default="USD", min_length=3, max_length=3)


class ProductInspectRequest(BaseModel):
    product_id: str = Field(min_length=1, max_length=300)
    country: str = Field(default="US", min_length=2, max_length=2)
    currency: str = Field(default="USD", min_length=3, max_length=3)


class OfferSelectionRequest(BaseModel):
    base_revision: int = Field(ge=1)
    instance_id: str
    offer_id: str | None = None


projects: OrderedDict[UUID, ManagedProject] = OrderedDict()
research_runs: OrderedDict[UUID, StudioReport] = OrderedDict()
app.include_router(handoff_router(lambda: research_runs))
validation_runs: OrderedDict[UUID, ValidationReport] = OrderedDict()
_project_locks: dict[UUID, asyncio.Lock] = {}


def _lock_for(project_id: UUID) -> asyncio.Lock:
    if project_id not in _project_locks:
        _project_locks[project_id] = asyncio.Lock()
    return _project_locks[project_id]


def _make_prototype(project: ManagedProject) -> Prototype:
    curr = project.current
    assert curr.manifest is not None
    return Prototype(
        project_id=project.project_id,
        revision=curr.revision,
        device_spec=curr.spec,
        manifest=curr.manifest,
        glb_url=f"/api/prototypes/{project.project_id}/model.glb?revision={curr.revision}",
    )


def publish_prototype(
    report: ResearchReport,
    project_id: UUID,
    revision: int,
    parameters: AssemblyParameters | None = None,
    *,
    progress: Progress | None = None,
) -> Prototype:
    if report.mode != "offline":
        require_admitted_evidence(report, report.review.selected_parts)
        require_cached_design_evidence(report.review.selected_parts)
    specification, snapshot = initial_spec_from_report(report, parameters)
    if progress is not None:
        progress(
            stage_event("geometry", "running", detail="Generating the parametric assembly.")
        )
    try:
        manifest = build_assembly(report, specification.mechanical)
    except GeometryError as error:
        if progress is not None:
            progress(stage_event("geometry", "failed", detail=str(error)))
            progress(
                stage_event("export", "skipped", detail="No validated assembly to export.")
            )
        raise
    specification.mechanical = manifest.parameters
    if progress is not None:
        progress(
            stage_event(
                "geometry",
                "completed",
                data={
                    "path": "parametric",
                    "node_count": len(manifest.nodes),
                    "findings": [
                        finding.model_dump(mode="json") for finding in manifest.findings
                    ],
                },
            )
        )
        progress(stage_event("export", "running", detail="Packaging the GLB viewer model."))
    try:
        glb = export_glb(manifest)
    except GeometryError as error:
        if progress is not None:
            progress(stage_event("export", "failed", detail=str(error)))
        raise

    now = datetime.now(UTC)
    existing = projects.get(project_id)
    prev_spec = existing.current.spec if existing is not None else None
    prev_cost = existing.current.cost if existing is not None else None
    procurement = existing.procurement if existing is not None else ProcurementState(revision=revision)
    procurement.revision = revision

    cost = compute_cost_breakdown(
        revision,
        specification,
        snapshot,
        procurement=procurement,
        previous_spec=prev_spec,
        previous_cost=prev_cost,
    )
    if existing is not None and prev_spec is not None and prev_spec.wiring == specification.wiring and prev_spec.requirements == specification.requirements:
        verification: VerificationReport = existing.current.verification.model_copy(
            deep=True, update={"revision": revision}
        )
    else:
        if progress is not None:
            progress({"type": "verification", "status": "running", "detail": "Checking formal obligations in Lean 4."})
        verification = verify_design_sync(revision, specification, snapshot, cost)
        if progress is not None:
            progress(
                {
                    "type": "verification",
                    "status": "completed",
                    "data": {
                        "status": verification.status,
                        "verified_count": verification.verified_count,
                        "failed_count": verification.failed_count,
                        "unverified_count": verification.unverified_count,
                    },
                }
            )

    record = RevisionRecord(
        revision=revision,
        parent_revision=(revision - 1) if existing is not None else None,
        label="Initial researched design" if existing is None else f"Wrist updated to {manifest.parameters.wrist_circumference_mm:g} mm",
        created_at=now,
        spec=specification,
        manifest=manifest,
        glb=glb,
        geometry_source_revision=revision,
        geometry_error=None,
        cost=cost,
        verification=verification,
    )

    if existing is None:
        actor_mode = "offline_fixture" if report.mode == "offline" else report.mode
        activity = [
            ActivityEntry(
                timestamp=now,
                revision=1,
                actor=actor_mode,
                kind="research_completed",
                title=f"Research completed ({'Offline fixture' if report.mode == 'offline' else report.model})",
                detail=report.proposal.rationale,
                status="pass",
            ),
            ActivityEntry(
                timestamp=now,
                revision=1,
                actor="lean",
                kind="verification",
                title=f"Lean 4 checked Rev 1 ({verification.status.upper()})",
                detail=(
                    f"{verification.verified_count} verified, {verification.failed_count} failed, "
                    f"{verification.unverified_count} unverified."
                ),
                status="pass" if verification.failed_count == 0 else "fail",
            ),
            ActivityEntry(
                timestamp=now,
                revision=1,
                actor="geometry",
                kind="geometry_regenerated",
                title="3D wristband assembly generated",
                detail=(
                    f"Wrist {manifest.parameters.wrist_circumference_mm:g} mm · "
                    f"Envelope {manifest.envelope_mm} mm · {len(glb) // 1024} KiB GLB."
                ),
                status="pass",
            ),
        ]
        managed = ManagedProject(
            project_id=project_id,
            report=report,
            catalog_snapshot=snapshot,
            current_revision=revision,
            records={revision: record},
            procurement=procurement,
            activity=activity,
        )
        projects[project_id] = managed
    else:
        existing.records[revision] = record
        existing.current_revision = revision
        existing.activity.append(
            ActivityEntry(
                timestamp=now,
                revision=revision,
                actor="user",
                kind="wrist_revised",
                title=f"Rev {revision}: Wrist updated to {manifest.parameters.wrist_circumference_mm:g} mm",
                detail="; ".join(cost.deltas_from_previous)
                or f"Known BOM {format_minor_currency(cost.known_subtotal_usd_cents, 'USD')}",
                status="pass",
            )
        )
        managed = existing

    projects.move_to_end(project_id)
    while len(projects) > 32:
        evicted_id, _ = projects.popitem(last=False)
        _project_locks.pop(evicted_id, None)

    if progress is not None:
        progress(
            stage_event("export", "completed", data={"format": "GLB", "byte_count": len(glb)})
        )
    return _make_prototype(managed)


def require_project_exists(project_id: UUID) -> ManagedProject:
    project = projects.get(project_id)
    if project is None:
        raise HTTPException(404, "This prototype expired. Run the brief again.")
    return project


def require_current_project(project_id: UUID, revision: int) -> ManagedProject:
    project = require_project_exists(project_id)
    if revision != project.current_revision:
        raise HTTPException(
            409, "This prototype changed. Reload your report before editing it."
        )
    return project


LIVE_UNAVAILABLE = (
    "Live research needs a Claude API key (ANTHROPIC_API_KEY) on the server. You can run the offline sample."
)


def configured_model() -> str | None:
    """Name of the configured Gemini research model, if any."""
    live = live_model()
    return live.name if live else None


@app.get("/")
def home() -> FileResponse:
    return FileResponse(WEB / "index.html")


@app.get("/api/assets-rev")
def assets_rev() -> dict[str, str]:
    latest = 0
    for path in WEB.rglob("*"):
        if path.is_file():
            latest = max(latest, path.stat().st_mtime_ns)
    return {"rev": str(latest)}


PCB_URL_FILE = Path(__file__).resolve().parents[1] / "pcb-studio" / "dev-url.local"


def pcb_url() -> str:
    """Where the standalone research page sends a finished brief.

    FORGE_PCB_URL wins. Otherwise use the address the PCB studio dev server wrote
    when it started, because Vite does not always get port 5173.
    """
    configured = os.environ.get("FORGE_PCB_URL")
    if configured:
        return configured
    try:
        written = PCB_URL_FILE.read_text().strip()
    except OSError:
        written = ""
    # Vite binds "localhost", which can be IPv6 only, so 127.0.0.1 may refuse.
    return written or "http://localhost:5173/"


ACTOR_LABELS = {"claude": "Claude", "gemini": "Gemini", "nous": "Nous", "offline_fixture": "Offline fixture"}
load_saved_keys()


@app.get("/api/integrations")
def integrations() -> dict[str, Any]:
    """Which providers are configured. Never returns key values."""
    return integrations_status()


@app.post("/api/integrations")
def set_integrations(update: KeyUpdate) -> dict[str, Any]:
    """Store provider keys in server memory (optionally on local disk).

    Keys never go to the browser bundle or back out of this endpoint.
    """
    status = update_keys(update)
    evidence_registry.clear()  # re-read datasheets with the new Reducto key
    return status


class GeminiModelsRequest(BaseModel):
    gemini_api_key: str | None = Field(default=None, max_length=512)


@app.post("/api/integrations/gemini-models")
async def gemini_models(request: GeminiModelsRequest) -> dict[str, Any]:
    """Use an entered or saved key to list models without changing configuration."""
    return await list_gemini_models(request.gemini_api_key)


@app.delete("/api/integrations/saved")
def forget_integrations() -> dict[str, Any]:
    """Delete the remembered-keys file. Keys stay set for this server process."""
    forget_saved_keys()
    return integrations_status()


@app.get("/api/providers/usage")
def provider_usage() -> UsageSummary:
    return usage_summary()


@app.get("/api/session")
def session() -> dict[str, Any]:
    live = live_model()
    return {
        "live": live is not None,
        "provider": live.mode if live else None,
        "gemini_model": live.name if live and live.mode == "gemini" else None,
        "live_model": live.name if live else None,
        "integrations": integrations_status(),
        "lean_available": find_lean_binary() is not None,
        "shop_mcp_enabled": True,
        "sample_brief": DEMO_BRIEF,
        "pcb_url": pcb_url(),
        "swarm": {"enabled": swarm_available(), "model": swarm_model()},
    }


@app.get("/api/catalog")
def catalog() -> dict[str, Any]:
    return {"parts": [part.model_dump(mode="json") for part in PARTS]}


PARTS_BY_ID = {part.id: part for part in PARTS}


class EvidenceIndex(BaseModel):
    reducto_enabled: bool
    parts: dict[str, str]
    documents: dict[str, int]
    started: int


@app.exception_handler(EvidenceBlocked)
async def evidence_blocked_response(request, error: EvidenceBlocked):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=422, content={"detail": str(error)})


@app.get("/api/evidence")
async def evidence_index() -> EvidenceIndex:
    """Status of every catalog part's evidence bundle; starts reading any not yet read."""
    from .providers.reducto import reducto_api_key

    started = evidence_registry.prefetch(PARTS)
    return EvidenceIndex(
        reducto_enabled=reducto_api_key() is not None,
        parts=evidence_registry.status(),
        documents={part.id: len(documents_for(part)) for part in PARTS},
        started=started,
    )


@app.get("/api/evidence/{part_id}")
async def part_evidence(part_id: str) -> ComponentEvidence:
    part = PARTS_BY_ID.get(part_id)
    if part is None:
        raise HTTPException(404, f"Unknown catalog part '{part_id}'.")
    return await evidence_registry.get(part)


@app.post("/api/research")
async def research(request: ResearchRequest) -> StudioReport:
    return await run_studio_research(request)


async def run_studio_research(
    request: ResearchRequest, progress: Progress | None = None
) -> StudioReport:
    # The Gemini agent swarm runs beside the catalog workflow and streams its own
    # events; it is advisory and never blocks or overrides the validated path.
    swarm_task: asyncio.Task[SwarmReport] | None = None
    if request.mode == "sample" or request.brief.strip():
        swarm_task = asyncio.create_task(
            run_swarm(
                DEMO_BRIEF if request.mode == "sample" else request.brief,
                live=request.mode == "live",
                emit=progress,
            )
        )
    try:
        result = await _run_catalog_research(request, progress)
    except BaseException:
        if swarm_task is not None:
            swarm_task.cancel()
        raise
    if swarm_task is not None:
        try:
            result.swarm = await swarm_task
        except asyncio.CancelledError:
            result.swarm = None
    research_runs[result.research_id] = result.model_copy(deep=True)
    if len(research_runs) > 32:
        research_runs.popitem(last=False)
    return result


async def _run_catalog_research(
    request: ResearchRequest, progress: Progress | None
) -> StudioReport:
    try:
        if request.mode == "sample":
            report = await run_research(
                DEMO_BRIEF, DemoModel(), mode="offline", progress=progress
            )
        else:
            if not request.brief.strip():
                raise HTTPException(422, "Enter a design brief.")
            live = live_model()
            if live is None:
                raise HTTPException(503, LIVE_UNAVAILABLE)
            report = await run_research(
                request.brief, live.adk_model(), mode=live.mode, progress=progress
            )
    except ResearchError as error:
        raise HTTPException(
            502, "Research could not finish. Try again or run the sample."
        ) from error
    except (TimeoutError, LlmCallsLimitExceededError) as error:
        raise HTTPException(504, "Research timed out. Try again.") from error
    except Exception as error:
        status = provider_error_status(error)
        if status is None:
            raise
        name = "Claude" if (live_model() and live_model().mode == "claude") else "Gemini"
        if status in (401, 403) or "API_KEY_INVALID" in str(error):
            message = (
                f"{name} rejected the server credential. Update it or run the offline sample."
            )
        elif status == 429:
            message = (
                f"{name} is temporarily rate limited. Try again or run the offline sample."
            )
        else:
            message = (
                f"{name} could not complete the request. Try again or run the offline sample."
            )
        raise HTTPException(502, message) from error

    result = StudioReport(**report.model_dump())
    if request.mode == "live":
        if progress is not None:
            progress(stage_event("evidence", "running", detail="Researching manufacturer sources; parsing and Pangram scanning run in parallel."))
        result.source_research = await research_sources(request.brief, report.review.selected_parts, request.source_policy, emit=progress)
        if request.source_policy.enabled and result.source_research.status != "accepted":
            result.evidence_blocked = True
            result.prototype_error = "Source-admission policy needs review. " + " ".join(result.source_research.reasons)
            if progress is not None:
                progress(stage_event("evidence", "failed", detail=result.prototype_error))
                progress(stage_event("geometry", "skipped", detail="No admitted research source set."))
                progress(stage_event("export", "skipped", detail="Source policy blocked the build."))
            return result
        if request.source_policy.enabled:
            for part in report.review.selected_parts:
                evidence_registry.seed(part, admitted_evidence(part, result.source_research))
    if report.review.status == "candidate":
        pid = uuid4()
        try:
            if report.mode != "offline":
                if progress is not None:
                    progress(stage_event("evidence", "running", detail="Comparing independent Reducto and Gemini PDF reads."))
                result.evidence = await asyncio.gather(*(evidence_registry.get(part) for part in report.review.selected_parts))
                await require_design_evidence(report.review.selected_parts)
                if progress is not None:
                    progress(stage_event("evidence", "completed", detail="Critical datasheet evidence agrees."))
            started = time.monotonic()
            if progress is not None:
                progress(modal_cad.compute_event(
                    "local-assembly", "provision", provider="local", label="Local assembly worker",
                    function="build_assembly + export_glb", resources=modal_cad.LOCAL_RESOURCES,
                    detail="Parametric assembly on this server."))
            result.prototype = publish_prototype(result, pid, 1, progress=progress)
            local_stats = {
                "elapsed_s": round(time.monotonic() - started, 2),
                "nodes": len(result.prototype.manifest.nodes),
                "bytes": {"glb": len(projects[pid].current.glb or b"")},
            }
            result.compute.append({"job": "local-assembly", "provider": "local", "stats": local_stats})
            if progress is not None:
                progress(modal_cad.compute_event("local-assembly", "completed", provider="local", stats=local_stats,
                                                 glb_url=result.prototype.glb_url, detail="Assembly GLB ready."))
            await _run_modal_enclosure(result, pid, progress)
            # Read every candidate's documents now, including alternates the
            # user has not picked yet, so a part swap shows evidence at once.
            evidence_registry.prefetch(PARTS)
            result.project = build_project_view(projects[pid])
        except (GeometryError, EvidenceBlocked) as error:
            result.prototype_error = str(error)
            if isinstance(error, EvidenceBlocked):
                result.evidence_blocked = True
                if progress is not None:
                    progress(stage_event("evidence", "failed", detail=str(error)))
                    progress(stage_event("geometry", "skipped", detail="Critical datasheet evidence needs review."))
                    progress(stage_event("export", "skipped", detail="Build blocked by unverified evidence."))
    elif progress is not None:
        progress(
            stage_event(
                "geometry", "skipped", detail="The parts review did not clear a build."
            )
        )
        progress(stage_event("export", "skipped", detail="No validated assembly to export."))
    return result


modal_enclosures: dict[UUID, bytes] = {}


async def _run_modal_enclosure(result: StudioReport, pid: UUID, progress: Progress | None) -> None:
    """CadQuery enclosure: Modal first, this machine if Modal fails. Never fails research."""
    if os.getenv("FORGE_ENCLOSURE", "on").strip().lower() in ("0", "off", "false"):
        return
    try:
        mech = projects[pid].current.spec.mechanical
        spec = modal_cad.enclosure_spec(result.review.selected_parts, mech.wall_mm, mech.clearance_mm, f"forge-{pid.hex[:8]}")
        loop = asyncio.get_running_loop()
        emit = None if progress is None else (lambda event: loop.call_soon_threadsafe(progress, event))
        job = await asyncio.to_thread(modal_cad.generate_enclosure, spec, emit)
    except Exception as error:  # report, never fail research on the optional cloud job
        result.compute.append({"job": "enclosure", "provider": "none", "error": str(error)[:300]})
        return
    if glb := job["files"].get("glb"):
        modal_enclosures[pid] = glb
        while len(modal_enclosures) > 32:
            modal_enclosures.pop(next(iter(modal_enclosures)))
    glb_url = f"/api/prototypes/{pid}/enclosure.glb" if glb else None
    result.compute.append({"job": "enclosure", "provider": job["provider"], "stats": job["stats"], "glb_url": glb_url})
    if progress is not None and glb_url:
        progress(modal_cad.compute_event("enclosure", "ready", provider=job["provider"], glb_url=glb_url,
                                         detail=f"Enclosure GLB from the {job['provider']} worker."))


@app.get("/api/prototypes/{project_id}/enclosure.glb")
async def get_enclosure(project_id: UUID) -> Response:
    glb = modal_enclosures.get(project_id)
    if glb is None:
        raise HTTPException(404, "No generated enclosure for this prototype.")
    return Response(glb, media_type="model/gltf-binary")


async def research_events(request: ResearchRequest) -> AsyncIterator[str]:
    events: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()
    active_stage: str | None = None

    def publish(event: dict[str, object]) -> None:
        nonlocal active_stage
        if event["type"] == "stage":
            stage = str(event["stage"])
            if event["status"] == "running":
                active_stage = stage
            elif active_stage == stage:
                active_stage = None
        events.put_nowait(event)

    def publish_error(message: str) -> None:
        if active_stage is not None:
            publish(stage_event(active_stage, "failed", detail=message))
        publish({"type": "error", "message": message})

    async def produce() -> None:
        try:
            report = await run_studio_research(request, publish)
            publish({"type": "report", "report": report.model_dump(mode="json")})
        except HTTPException as error:
            publish_error(str(error.detail))
        except Exception:
            logger.exception("Unable to complete the research stream.")
            publish_error("Research did not finish. Try again or run the offline sample.")
        finally:
            events.put_nowait(None)

    task = asyncio.create_task(produce())
    try:
        yield json.dumps({"type": "run", "mode": request.mode}) + "\n"
        while (event := await events.get()) is not None:
            yield json.dumps(event) + "\n"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@app.post("/api/research/stream")
async def stream_research(request: ResearchRequest) -> StreamingResponse:
    return StreamingResponse(
        research_events(request),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.get("/api/prototypes/{project_id}/model.glb")
async def get_model(project_id: UUID, revision: int) -> Response:
    project = require_current_project(project_id, revision)
    if not project.glb:
        raise HTTPException(404, "No 3D model is available for this revision.")
    return Response(project.glb, media_type="model/gltf-binary")


@app.post("/api/prototypes/{project_id}/revisions")
async def revise_prototype(project_id: UUID, edit: AssemblyEdit) -> Prototype:
    async with _lock_for(project_id):
        project = require_current_project(project_id, edit.base_revision)
        previous = project.current.spec.mechanical
        try:
            parameters = AssemblyParameters(
                wrist_circumference_mm=edit.wrist_circumference_mm,
                wall_mm=previous.wall_mm,
                clearance_mm=previous.clearance_mm,
            )
            return publish_prototype(
                project.report, project_id, edit.base_revision + 1, parameters
            )
        except (GeometryError, ValidationError) as error:
            message = (
                str(error)
                if isinstance(error, GeometryError)
                else "Enter a supported wrist size."
            )
            raise HTTPException(422, message) from error


class ValidationRequest(BaseModel):
    base_revision: int = Field(ge=1)


def _store_validation(report: ValidationReport) -> ValidationReport:
    validation_runs[report.validation_id] = report
    if len(validation_runs) > 64:
        validation_runs.popitem(last=False)
    return report


def _advisory_text(report: StudioReport) -> str:
    if report.swarm is None:
        return ""
    return "\n\n".join([report.swarm.synthesis or "", *(a.summary for a in report.swarm.agents)])


@app.post("/api/research/{research_id}/validate", response_model=ValidationReport)
async def validate_research_run(research_id: UUID) -> ValidationReport:
    report = research_runs.get(research_id)
    if report is None:
        raise HTTPException(404, "Research run expired. Run research again before validating.")
    # No client-supplied report, claims or proof status can become audit evidence.
    parts = report.review.selected_parts
    spec = cost = None
    if len(parts) >= 2:
        try:
            spec, snapshot = initial_spec_from_report(report)
            cost = compute_cost_breakdown(1, spec, snapshot)
        except (GeometryError, ValueError):
            spec = cost = None
    return _store_validation(await validate_report(
        report, registry=EvidenceRegistry(), parts=parts, spec=spec, cost=cost,
        revision=None, advisory=_advisory_text(report),
    ))


@app.post("/api/projects/{project_id}/validate", response_model=ValidationReport)
async def validate_project_revision(project_id: UUID, request: ValidationRequest) -> ValidationReport:
    async with _lock_for(project_id):
        project = require_current_project(project_id, request.base_revision)
        record = project.current
        parts = [project.catalog_snapshot[cid] for cid in dict.fromkeys(c.catalog_id for c in record.spec.components)]
        report = project.report.model_copy(deep=True, update={"catalog_snapshot": project.catalog_snapshot})
        return _store_validation(await validate_report(
            report, registry=EvidenceRegistry(), parts=parts, spec=record.spec, cost=record.cost,
            revision=record.revision,
        ))


@app.get("/api/validations/{validation_id}")
async def validation_json(validation_id: UUID) -> Response:
    report = validation_runs.get(validation_id)
    if report is None:
        raise HTTPException(404, "Validation report expired. Validate again to create a new report.")
    return Response(report.model_dump_json(indent=2), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="forge-validation-{validation_id}.json"'})


@app.get("/api/validations/{validation_id}/report.html")
async def validation_html(validation_id: UUID) -> Response:
    report = validation_runs.get(validation_id)
    if report is None:
        raise HTTPException(404, "Validation report expired. Validate again to create a new report.")
    return Response(render_validation_html(report), media_type="text/html",
                    headers={"Content-Disposition": f'attachment; filename="forge-validation-{validation_id}.html"'})


@app.get("/api/projects/{project_id}")
async def get_project(project_id: UUID) -> ProjectView:
    project = require_project_exists(project_id)
    return build_project_view(project)


@app.post("/api/projects/{project_id}/edits")
async def edit_project(project_id: UUID, edit: DesignEdit) -> ProjectView:
    async with _lock_for(project_id):
        project = require_current_project(project_id, edit.base_revision)
        try:
            next_spec = apply_design_edit_to_spec(
                project.current.spec, edit, project.catalog_snapshot
            )
        except (ValidationError, ValueError) as error:
            raise HTTPException(422, str(error)) from error

        changed_summary = _summarize_edit_label(project.current.spec, next_spec)
        if not changed_summary:
            return build_project_view(project)

        await evaluate_and_commit_revision(
            project, next_spec, label=changed_summary, actor="user"
        )
        return build_project_view(project)


def _summarize_edit_label(prev: DeviceSpecification, curr: DeviceSpecification) -> str:
    parts: list[str] = []
    if prev.project_name != curr.project_name:
        parts.append(f"Renamed to '{curr.project_name}'")
    if prev.mechanical.wrist_circumference_mm != curr.mechanical.wrist_circumference_mm:
        parts.append(f"Wrist {curr.mechanical.wrist_circumference_mm:g} mm")
    if prev.mechanical.wall_mm != curr.mechanical.wall_mm:
        parts.append(f"Wall {curr.mechanical.wall_mm:g} mm")
    if prev.mechanical.clearance_mm != curr.mechanical.clearance_mm:
        parts.append(f"Clearance {curr.mechanical.clearance_mm:g} mm")
    if prev.requirements.budget_usd_cents != curr.requirements.budget_usd_cents or (
        prev.requirements.budget_exclusive != curr.requirements.budget_exclusive
    ):
        cap = (
            format_minor_currency(curr.requirements.budget_usd_cents, "USD")
            if curr.requirements.budget_usd_cents is not None
            else "no cap"
        )
        parts.append(f"Budget {'<' if curr.requirements.budget_exclusive else '≤'} {cap}")
    if prev.requirements.transport != curr.requirements.transport:
        parts.append(f"Transport {curr.requirements.transport.upper()}")
    if prev.requirements.gestures != curr.requirements.gestures:
        parts.append("Updated target gestures")
    if prev.components != curr.components:
        p_ctrl = next(c for c in prev.components if c.role == "controller")
        c_ctrl = next(c for c in curr.components if c.role == "controller")
        p_sens = next(c for c in prev.components if c.role == "emg_sensor")
        c_sens = next(c for c in curr.components if c.role == "emg_sensor")
        if p_ctrl.catalog_id != c_ctrl.catalog_id:
            parts.append(f"Controller → {c_ctrl.catalog_id}")
        if p_sens.catalog_id != c_sens.catalog_id:
            parts.append(f"Sensor → {c_sens.catalog_id}")
        if p_sens.quantity != c_sens.quantity:
            parts.append(f"Sensor qty ×{c_sens.quantity}")
    if prev.wiring != curr.wiring:
        if prev.wiring.supply_rail_mv != curr.wiring.supply_rail_mv:
            parts.append(f"Supply rail {curr.wiring.supply_rail_mv} mV")
        if prev.wiring.signal_pins != curr.wiring.signal_pins:
            parts.append(f"ADC pins {', '.join(curr.wiring.signal_pins)}")
        if prev.wiring.status_led_pin != curr.wiring.status_led_pin:
            parts.append(f"LED pin {curr.wiring.status_led_pin or 'none'}")
    return ", ".join(parts)


@app.post("/api/projects/{project_id}/restore")
async def restore_revision(project_id: UUID, req: RestoreRequest) -> ProjectView:
    async with _lock_for(project_id):
        project = require_current_project(project_id, req.base_revision)
        target = project.records.get(req.target_revision)
        if target is None:
            raise HTTPException(404, f"Revision {req.target_revision} is no longer in history.")
        if req.target_revision == project.current_revision:
            return build_project_view(project)
        await evaluate_and_commit_revision(
            project,
            target.spec.model_copy(deep=True),
            label=f"Restored Rev {req.target_revision}",
            actor="user",
            force_verify=True,
        )
        return build_project_view(project)


@app.get("/api/projects/{project_id}/compare")
async def compare_revisions(
    project_id: UUID,
    from_rev: int = Query(ge=1),
    to_rev: int = Query(ge=1),
) -> RevisionDiff:
    project = require_project_exists(project_id)
    rec_a = project.records.get(from_rev)
    rec_b = project.records.get(to_rev)
    if rec_a is None or rec_b is None:
        raise HTTPException(404, "One or both requested revisions were not found.")
    return compute_revision_diff(rec_a, rec_b)


@app.post("/api/projects/{project_id}/repair")
async def repair_project(project_id: UUID, req: RepairRequest) -> RepairResponse:
    async with _lock_for(project_id):
        project = require_current_project(project_id, req.base_revision)
        curr_ver = project.current.verification
        failed = [ob for ob in curr_ver.obligations if ob.status == "failed"]
        if not failed:
            return RepairResponse(
                repaired=True,
                attempts=0,
                actor=(live_model().mode if live_model() else "claude") if req.mode == "live" else "offline_fixture",
                rationale="All checkable constraints already pass; no repair required.",
                diff=None,
                project=build_project_view(project),
            )

        live = live_model()
        effective_mode: Literal["live", "sample"] = req.mode
        if req.mode == "live" and live is None:
            raise HTTPException(
                503,
                "Live repair needs ANTHROPIC_API_KEY (Claude) configured. "
                "Use Offline scripted repair to test locally.",
            )
        if effective_mode == "live":
            model, actor = live.adk_model(), live.mode
        else:
            model, actor = choose_repair_model(effective_mode, None)
        start_record = project.current
        working_spec = start_record.spec.model_copy(deep=True)
        working_failed = failed
        last_rationale = ""
        attempts = 0

        for attempt in range(1, 3):
            attempts = attempt
            try:
                patch = await propose_repair_patch(
                    working_spec, working_failed, project.catalog_snapshot, model
                )
            except ResearchError as exc:
                raise HTTPException(502, str(exc)) from exc
            except Exception as exc:
                status = provider_error_status(exc)
                if status is None:
                    raise
                raise HTTPException(
                    502, f"{ACTOR_LABELS.get(actor, 'Model')} repair request failed (status {status})."
                ) from exc

            last_rationale = patch.rationale
            if not patch.resolvable:
                project.activity.append(
                    ActivityEntry(
                        timestamp=datetime.now(UTC),
                        revision=project.current_revision,
                        actor=actor,
                        kind="repair_unresolvable",
                        title=f"Repair halted ({ACTOR_LABELS.get(actor, actor)})",
                        detail=patch.rationale,
                        status="warn",
                    )
                )
                return RepairResponse(
                    repaired=False,
                    attempts=attempts,
                    actor=actor,
                    rationale=patch.rationale,
                    diff=None,
                    project=build_project_view(project),
                )

            try:
                candidate_spec = apply_repair_patch(
                    working_spec, patch, project.catalog_snapshot
                )
            except (ResearchError, ValidationError, ValueError) as exc:
                last_rationale = f"Rejected invalid repair patch: {exc}"
                break

            temp_cost = compute_cost_breakdown(
                project.current_revision + 1,
                candidate_spec,
                project.catalog_snapshot,
                procurement=project.procurement,
            )
            temp_ver = await verify_design(
                project.current_revision + 1,
                candidate_spec,
                project.catalog_snapshot,
                temp_cost,
            )
            working_spec = candidate_spec
            working_failed = [ob for ob in temp_ver.obligations if ob.status == "failed"]
            if not working_failed:
                committed = await evaluate_and_commit_revision(
                    project,
                    candidate_spec,
                    label=f"Auto-repaired ({ACTOR_LABELS.get(actor, actor)})",
                    actor=actor,
                    force_verify=True,
                )
                project.activity.append(
                    ActivityEntry(
                        timestamp=datetime.now(UTC),
                        revision=committed.revision,
                        actor=actor,
                        kind="repair_succeeded",
                        title=f"Constraint repair verified in Lean 4 (attempt {attempts})",
                        detail=patch.rationale,
                        status="pass",
                    )
                )
                diff = compute_revision_diff(start_record, committed)
                return RepairResponse(
                    repaired=True,
                    attempts=attempts,
                    actor=actor,
                    rationale=patch.rationale,
                    diff=diff,
                    project=build_project_view(project),
                )

        # Commit best partial repair only if it strictly reduced failure count; else keep failed state visible
        project.activity.append(
            ActivityEntry(
                timestamp=datetime.now(UTC),
                revision=project.current_revision,
                actor=actor,
                kind="repair_incomplete",
                title=f"Repair did not clear all constraints after {attempts} attempt(s)",
                detail=last_rationale,
                status="fail",
            )
        )
        return RepairResponse(
            repaired=False,
            attempts=attempts,
            actor=actor,
            rationale=last_rationale,
            diff=None,
            project=build_project_view(project),
        )


@app.post("/api/projects/{project_id}/procurement/search")
async def search_procurement(
    project_id: UUID, req: ProcurementSearchRequest
) -> ProjectView:
    async with _lock_for(project_id):
        project = require_project_exists(project_id)
        if req.catalog_id:
            part = project.catalog_snapshot.get(req.catalog_id)
            if part is None:
                raise HTTPException(404, f"Unknown catalog component '{req.catalog_id}'.")
            targets = [part]
        else:
            seen: list[str] = []
            for comp in project.current.spec.components:
                if comp.catalog_id not in seen and comp.catalog_id in project.catalog_snapshot:
                    seen.append(comp.catalog_id)
            targets = [project.catalog_snapshot[cid] for cid in seen]

        results = await asyncio.gather(
            *(
                search_part_offers(
                    part,
                    query=req.query if req.catalog_id else None,
                    country=req.country.upper(),
                    currency=req.currency.upper(),
                )
                for part in targets
            )
        )
        project.procurement.source = "shop_mcp"
        project.procurement.revision = project.current_revision
        total_offers = 0
        errors: list[str] = []
        for res in results:
            project.procurement.results_by_part[res.catalog_id] = res
            total_offers += len(res.offers)
            if res.status == "error" and res.error_message:
                errors.append(f"{res.sku}: {res.error_message}")

        now = datetime.now(UTC)
        project.activity.append(
            ActivityEntry(
                timestamp=now,
                revision=project.current_revision,
                actor="shop_mcp",
                kind="procurement_search",
                title=f"Shop.dev MCP searched {len(targets)} BOM part(s)",
                detail=(
                    f"Found {total_offers} classified offer(s)."
                    + (f" Errors: {'; '.join(errors)}" if errors else "")
                ),
                status="warn" if errors else "info",
            )
        )
        return build_project_view(project)


@app.post("/api/projects/{project_id}/procurement/product")
async def inspect_procurement_product(
    project_id: UUID, req: ProductInspectRequest
) -> dict[str, Any]:
    require_project_exists(project_id)
    try:
        return await get_shop_product(
            req.product_id,
            country=req.country.upper(),
            currency=req.currency.upper(),
        )
    except ShopMcpError as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/api/projects/{project_id}/procurement/select")
async def select_procurement_offer(
    project_id: UUID, req: OfferSelectionRequest
) -> ProjectView:
    async with _lock_for(project_id):
        project = require_current_project(project_id, req.base_revision)
        next_spec = project.current.spec.model_copy(deep=True)
        comp = next(
            (c for c in next_spec.components if c.instance_id == req.instance_id), None
        )
        if comp is None:
            raise HTTPException(404, f"Unknown BOM instance '{req.instance_id}'.")

        if req.offer_id is None:
            comp.selected_offer_id = None
            label = f"Reverted {comp.catalog_id} to catalog reference price"
        else:
            part_offers = project.procurement.results_by_part.get(comp.catalog_id)
            offer = next(
                (o for o in (part_offers.offers if part_offers else []) if o.offer_id == req.offer_id),
                None,
            )
            if offer is None:
                raise HTTPException(404, "Selected merchant offer is not available.")
            if offer.match_kind != "exact_match":
                raise HTTPException(
                    422,
                    f"Offer '{offer.title}' is classified as '{offer.match_kind}'. "
                    "Only verified exact-SKU offers can replace BOM unit pricing.",
                )
            if not offer.available:
                raise HTTPException(422, f"Offer from {offer.seller_name} is out of stock.")
            comp.selected_offer_id = offer.offer_id
            label = f"Selected {offer.seller_name} offer ({offer.formatted_price}) for {comp.catalog_id}"

        await evaluate_and_commit_revision(
            project, next_spec, label=label, actor="shop_mcp"
        )
        return build_project_view(project)


if __name__ == "__main__":
    os.environ["GOOGLE_GENAI_USE_ENTERPRISE"] = "false"
    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "false"
    uvicorn.run(
        "forge_research.studio:app",
        host="127.0.0.1",
        port=int(os.getenv("FORGE_PORT", "8000")),
        reload=True,
    )
