"""Canonical versioned hardware project store, dependency propagation, and diffs."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .bom import compute_cost_breakdown, format_minor_currency
from .catalog import PARTS
from .geometry import (
    AssemblyManifest,
    GeometryError,
    build_assembly_for_spec,
    export_glb,
)
from .models import (
    ActivityEntry,
    AssemblyParameters,
    ComponentInstance,
    CostBreakdown,
    DeviceSpecification,
    Part,
    ProcurementState,
    Requirements,
    ResearchReport,
    RevisionDiff,
    Transport,
    VerificationReport,
    WiringSpec,
)
from .verify import verify_design
from .evidence.datasheets import require_design_evidence
from .source_research import require_admitted_evidence

ALL_PARTS_BY_ID: dict[str, Part] = {part.id: part for part in PARTS}


class DesignEdit(BaseModel):
    """Scoped user or agent edit against a known base_revision."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    base_revision: int = Field(ge=1)
    project_name: str | None = Field(default=None, min_length=1, max_length=120)
    transport: Transport | None = None
    budget_usd_cents: int | None = Field(default=None, ge=0, le=10_000_000)
    clear_budget: bool = False
    budget_exclusive: bool | None = None
    gestures: list[str] | None = None
    wrist_circumference_mm: float | None = Field(default=None, ge=120, le=240)
    wall_mm: float | None = Field(default=None, ge=1.2, le=4.0)
    clearance_mm: float | None = Field(default=None, ge=0.8, le=4.0)
    controller_id: str | None = None
    sensor_id: str | None = None
    sensor_quantity: int | None = Field(default=None, ge=1, le=2)
    supply_rail_mv: int | None = Field(default=None, ge=1000, le=12000)
    signal_pins: list[str] | None = Field(default=None, min_length=1, max_length=2)
    status_led_pin: str | None = None
    clear_status_led_pin: bool = False


class RevisionSummary(BaseModel):
    revision: int
    parent_revision: int | None = None
    label: str
    known_subtotal_usd_cents: int
    has_unpriced_items: bool
    verification_status: str
    wrist_circumference_mm: float | None = None
    created_at: datetime


class ProjectView(BaseModel):
    project_id: UUID
    revision: int
    parent_revision: int | None = None
    mode: Literal["offline", "claude", "gemini", "nous"]
    model: str
    brief: str
    catalog_snapshot: dict[str, Part]
    device_spec: DeviceSpecification
    manifest: AssemblyManifest | None = None
    glb_url: str | None = None
    geometry_source_revision: int | None = None
    geometry_error: str | None = None
    cost: CostBreakdown
    verification: VerificationReport
    procurement: ProcurementState
    diff_from_previous: RevisionDiff | None = None
    revisions: list[RevisionSummary] = Field(default_factory=list)
    activity: list[ActivityEntry] = Field(default_factory=list)


@dataclass
class RevisionRecord:
    revision: int
    parent_revision: int | None
    label: str
    created_at: datetime
    spec: DeviceSpecification
    manifest: AssemblyManifest | None
    glb: bytes | None
    geometry_source_revision: int | None
    geometry_error: str | None
    cost: CostBreakdown
    verification: VerificationReport


@dataclass
class ManagedProject:
    project_id: UUID
    report: ResearchReport
    catalog_snapshot: dict[str, Part]
    current_revision: int
    records: dict[int, RevisionRecord] = field(default_factory=dict)
    procurement: ProcurementState = field(
        default_factory=lambda: ProcurementState(revision=1)
    )
    activity: list[ActivityEntry] = field(default_factory=list)

    @property
    def current(self) -> RevisionRecord:
        return self.records[self.current_revision]

    @property
    def glb(self) -> bytes:
        return self.current.glb or b""


def _default_wiring_for_parts(
    controller: Part, requirements: Requirements, sensor_qty: int = 1
) -> WiringSpec:
    rail = controller.sensor_rail_mv or 3300
    if controller.adc_max_mv is not None and rail > controller.adc_max_mv:
        safe = [r for r in controller.available_rails_mv if r <= controller.adc_max_mv]
        if safe:
            rail = safe[0]
    restricted = set(controller.reserved_pins) | set(controller.board_restricted_adc_pins)
    if requirements.transport == "wifi":
        restricted |= set(controller.adc_wifi_conflict_pins)
    usable = [p for p in controller.adc_pins if p not in restricted]
    default_pin = "GPIO34" if "GPIO34" in usable else (usable[0] if usable else "A0")
    pins = [default_pin]
    if sensor_qty == 2:
        second = next((p for p in usable if p != default_pin), default_pin)
        pins.append(second)
    return WiringSpec(supply_rail_mv=rail, signal_pins=pins, status_led_pin=None)


def initial_spec_from_report(
    report: ResearchReport, parameters: AssemblyParameters | None = None
) -> tuple[DeviceSpecification, dict[str, Part]]:
    snapshot = {**ALL_PARTS_BY_ID, **report.catalog_snapshot}
    selected_by_role = {part.role: part for part in report.review.selected_parts}
    ctrl = selected_by_role.get("controller") or snapshot.get(
        report.proposal.controller_id or "esp32-devkitc-32e"
    )
    sens = selected_by_role.get("emg_sensor") or snapshot.get(
        report.proposal.sensor_id or "myoware-2-dev-27924"
    )
    assert ctrl is not None and sens is not None

    components = [
        ComponentInstance(instance_id="board", catalog_id=ctrl.id, role="controller", quantity=1),
        ComponentInstance(
            instance_id="sensor-1", catalog_id=sens.id, role="emg_sensor", quantity=1
        ),
    ]
    parts_by_instance = {"board": ctrl, "sensor-1": sens}
    mech = parameters if parameters is not None else AssemblyParameters()
    wiring = _default_wiring_for_parts(ctrl, report.requirements, sensor_qty=1)

    return (
        DeviceSpecification(
            project_name="EMG Gesture Wristband",
            requirements=report.requirements.model_copy(deep=True),
            components=components,
            parts_by_instance=parts_by_instance,
            mechanical=mech,
            wiring=wiring,
        ),
        snapshot,
    )


def compute_revision_diff(prev: RevisionRecord, curr: RevisionRecord) -> RevisionDiff:
    changed: list[str] = []
    geom: list[str] = []
    verif: list[str] = []

    p_spec, c_spec = prev.spec, curr.spec
    if p_spec.project_name != c_spec.project_name:
        changed.append("project_name")
    if p_spec.requirements.transport != c_spec.requirements.transport:
        changed.append("transport")
    if (
        p_spec.requirements.budget_usd_cents != c_spec.requirements.budget_usd_cents
        or p_spec.requirements.budget_exclusive != c_spec.requirements.budget_exclusive
    ):
        changed.append("budget")
    if p_spec.requirements.gestures != c_spec.requirements.gestures:
        changed.append("gestures")
    if p_spec.mechanical != c_spec.mechanical:
        if p_spec.mechanical.wrist_circumference_mm != c_spec.mechanical.wrist_circumference_mm:
            changed.append("wrist_circumference_mm")
            geom.append(
                f"Wrist circumference: {p_spec.mechanical.wrist_circumference_mm} → "
                f"{c_spec.mechanical.wrist_circumference_mm} mm"
            )
        if p_spec.mechanical.wall_mm != c_spec.mechanical.wall_mm:
            changed.append("wall_mm")
            geom.append(
                f"Enclosure wall: {p_spec.mechanical.wall_mm:g} → {c_spec.mechanical.wall_mm:g} mm"
            )
        if p_spec.mechanical.clearance_mm != c_spec.mechanical.clearance_mm:
            changed.append("clearance_mm")
            geom.append(
                f"Internal clearance: {p_spec.mechanical.clearance_mm:g} → "
                f"{c_spec.mechanical.clearance_mm:g} mm"
            )
    if p_spec.components != c_spec.components:
        changed.append("components")
    if p_spec.wiring != c_spec.wiring:
        if p_spec.wiring.supply_rail_mv != c_spec.wiring.supply_rail_mv:
            changed.append("supply_rail_mv")
        if p_spec.wiring.signal_pins != c_spec.wiring.signal_pins:
            changed.append("signal_pins")
        if p_spec.wiring.status_led_pin != c_spec.wiring.status_led_pin:
            changed.append("status_led_pin")

    if prev.manifest and curr.manifest:
        if prev.manifest.envelope_mm != curr.manifest.envelope_mm:
            geom.append(
                f"Outer envelope: {prev.manifest.envelope_mm} → {curr.manifest.envelope_mm} mm"
            )
        elif not geom:
            geom.append("3D geometry unchanged (reused validated mesh)")
    elif curr.geometry_error and curr.geometry_error != prev.geometry_error:
        geom.append(f"Geometry blocked: {curr.geometry_error}")

    prev_obs = {ob.id: ob for ob in prev.verification.obligations}
    for ob in curr.verification.obligations:
        old_ob = prev_obs.get(ob.id)
        if old_ob is None or old_ob.status != ob.status:
            old_st = old_ob.status if old_ob else "none"
            verif.append(f"{ob.title}: {old_st.upper()} → {ob.status.upper()}")
    if not verif:
        verif.append(
            f"Verification status unchanged ({curr.verification.verified_count} verified, "
            f"{curr.verification.failed_count} failed, {curr.verification.unverified_count} unverified)"
        )

    cost_changes = list(curr.cost.deltas_from_previous)
    if not cost_changes and prev.cost.known_subtotal_usd_cents != curr.cost.known_subtotal_usd_cents:
        diff_cents = curr.cost.known_subtotal_usd_cents - prev.cost.known_subtotal_usd_cents
        sign = "+" if diff_cents >= 0 else "-"
        cost_changes.append(
            f"Known BOM subtotal: {format_minor_currency(prev.cost.known_subtotal_usd_cents, 'USD')} → "
            f"{format_minor_currency(curr.cost.known_subtotal_usd_cents, 'USD')} "
            f"({sign}${abs(diff_cents)/100:,.2f})"
        )
    if prev.cost.budget_status != curr.cost.budget_status:
        cost_changes.append(
            f"Budget status: {prev.cost.budget_status} → {curr.cost.budget_status}"
        )

    return RevisionDiff(
        from_revision=prev.revision,
        to_revision=curr.revision,
        changed_fields=changed,
        geometry_changes=geom,
        cost_changes=cost_changes,
        verification_changes=verif,
    )


def build_project_view(project: ManagedProject) -> ProjectView:
    curr = project.current
    prev = (
        project.records.get(curr.parent_revision)
        if curr.parent_revision is not None
        else None
    )
    diff = compute_revision_diff(prev, curr) if prev is not None else None
    glb_url = (
        f"/api/prototypes/{project.project_id}/model.glb?revision={curr.revision}"
        if curr.glb is not None
        else None
    )
    summaries = [
        RevisionSummary(
            revision=rec.revision,
            parent_revision=rec.parent_revision,
            label=rec.label,
            known_subtotal_usd_cents=rec.cost.known_subtotal_usd_cents,
            has_unpriced_items=rec.cost.has_unpriced_items,
            verification_status=rec.verification.status,
            wrist_circumference_mm=(
                rec.manifest.parameters.wrist_circumference_mm
                if rec.manifest is not None
                else rec.spec.mechanical.wrist_circumference_mm
            ),
            created_at=rec.created_at,
        )
        for rec in sorted(project.records.values(), key=lambda r: r.revision)
    ]
    return ProjectView(
        project_id=project.project_id,
        revision=curr.revision,
        parent_revision=curr.parent_revision,
        mode=project.report.mode,
        model=project.report.model,
        brief=project.report.brief,
        catalog_snapshot=project.catalog_snapshot,
        device_spec=curr.spec,
        manifest=curr.manifest,
        glb_url=glb_url,
        geometry_source_revision=curr.geometry_source_revision,
        geometry_error=curr.geometry_error,
        cost=curr.cost,
        verification=curr.verification,
        procurement=project.procurement,
        diff_from_previous=diff,
        revisions=summaries,
        activity=list(project.activity),
    )


def apply_design_edit_to_spec(
    prev_spec: DeviceSpecification,
    edit: DesignEdit,
    catalog_snapshot: dict[str, Part],
) -> DeviceSpecification:
    spec = prev_spec.model_copy(deep=True)
    if edit.project_name is not None:
        spec.project_name = edit.project_name.strip()

    if edit.transport is not None:
        spec.requirements.transport = edit.transport
    if edit.clear_budget:
        spec.requirements.budget_usd_cents = None
    elif edit.budget_usd_cents is not None:
        spec.requirements.budget_usd_cents = edit.budget_usd_cents
    if edit.budget_exclusive is not None:
        spec.requirements.budget_exclusive = edit.budget_exclusive
    if edit.gestures is not None:
        cleaned = [g.strip() for g in edit.gestures if g.strip()]
        spec.requirements.gestures = cleaned or spec.requirements.gestures

    new_wrist = (
        edit.wrist_circumference_mm
        if edit.wrist_circumference_mm is not None
        else spec.mechanical.wrist_circumference_mm
    )
    new_wall = edit.wall_mm if edit.wall_mm is not None else spec.mechanical.wall_mm
    new_clear = (
        edit.clearance_mm if edit.clearance_mm is not None else spec.mechanical.clearance_mm
    )
    spec.mechanical = AssemblyParameters(
        wrist_circumference_mm=new_wrist,
        wall_mm=new_wall,
        clearance_mm=new_clear,
    )

    ctrl_comp = next(c for c in spec.components if c.role == "controller")
    sens_comp = next(c for c in spec.components if c.role == "emg_sensor")

    if edit.controller_id is not None and edit.controller_id != ctrl_comp.catalog_id:
        new_ctrl = catalog_snapshot.get(edit.controller_id)
        if new_ctrl is None or new_ctrl.role != "controller":
            raise ValueError(f"Unsupported controller '{edit.controller_id}'.")
        ctrl_comp.catalog_id = new_ctrl.id
        ctrl_comp.selected_offer_id = None
        spec.parts_by_instance["board"] = new_ctrl

    if edit.sensor_id is not None and edit.sensor_id != sens_comp.catalog_id:
        new_sens = catalog_snapshot.get(edit.sensor_id)
        if new_sens is None or new_sens.role != "emg_sensor":
            raise ValueError(f"Unsupported sensor '{edit.sensor_id}'.")
        sens_comp.catalog_id = new_sens.id
        sens_comp.selected_offer_id = None
        spec.parts_by_instance["sensor-1"] = new_sens

    old_qty = sens_comp.quantity
    if edit.sensor_quantity is not None:
        sens_comp.quantity = edit.sensor_quantity
        sens_part = catalog_snapshot[sens_comp.catalog_id]
        if sens_comp.quantity == 2:
            spec.parts_by_instance["sensor-2"] = sens_part
        else:
            spec.parts_by_instance.pop("sensor-2", None)

    new_rail = (
        edit.supply_rail_mv
        if edit.supply_rail_mv is not None
        else spec.wiring.supply_rail_mv
    )
    if edit.signal_pins is not None:
        new_pins = [p.strip() for p in edit.signal_pins if p.strip()]
    else:
        new_pins = list(spec.wiring.signal_pins)
        if sens_comp.quantity != old_qty:
            ctrl_part = catalog_snapshot[ctrl_comp.catalog_id]
            restricted = set(ctrl_part.reserved_pins) | set(ctrl_part.board_restricted_adc_pins)
            if spec.requirements.transport == "wifi":
                restricted |= set(ctrl_part.adc_wifi_conflict_pins)
            usable = [p for p in ctrl_part.adc_pins if p not in restricted]
            if sens_comp.quantity == 2 and len(new_pins) == 1:
                second = next((p for p in usable if p not in new_pins), new_pins[0])
                new_pins.append(second)
            elif sens_comp.quantity == 1 and len(new_pins) > 1:
                new_pins = new_pins[:1]

    if edit.clear_status_led_pin:
        new_led = None
    elif edit.status_led_pin is not None:
        new_led = edit.status_led_pin.strip() or None
    else:
        new_led = spec.wiring.status_led_pin

    spec.wiring = WiringSpec(
        supply_rail_mv=new_rail,
        signal_pins=new_pins,
        status_led_pin=new_led,
    )
    return spec


async def evaluate_and_commit_revision(
    project: ManagedProject,
    next_spec: DeviceSpecification,
    *,
    label: str,
    actor: Literal["user", "claude", "gemini", "nous", "offline_fixture", "shop_mcp"] = "user",
    force_verify: bool = False,
    force_geometry: bool = False,
) -> RevisionRecord:
    if project.report.mode != "offline":
        require_admitted_evidence(project.report, [project.catalog_snapshot[cid] for cid in
                                  dict.fromkeys(c.catalog_id for c in next_spec.components)])
        await require_design_evidence([project.catalog_snapshot[cid] for cid in
                                       dict.fromkeys(c.catalog_id for c in next_spec.components)])
    prev = project.current
    next_rev = project.current_revision + 1
    now = datetime.now(UTC)

    # Prune procurement results for any SKU no longer in the active BOM
    active_skus = {c.catalog_id for c in next_spec.components}
    project.procurement.results_by_part = {
        cid: res
        for cid, res in project.procurement.results_by_part.items()
        if cid in active_skus
    }
    project.procurement.revision = next_rev

    # Determine affected dependencies
    mech_changed = prev.spec.mechanical != next_spec.mechanical
    comp_struct_changed = [
        (c.catalog_id, c.quantity) for c in prev.spec.components
    ] != [(c.catalog_id, c.quantity) for c in next_spec.components]
    offer_changed = [c.selected_offer_id for c in prev.spec.components] != [
        c.selected_offer_id for c in next_spec.components
    ]
    elec_or_req_changed = (
        prev.spec.wiring != next_spec.wiring
        or prev.spec.requirements != next_spec.requirements
        or comp_struct_changed
        or offer_changed
    )

    # 1. Cost & BOM (fast deterministic)
    cost = compute_cost_breakdown(
        next_rev,
        next_spec,
        project.catalog_snapshot,
        procurement=project.procurement,
        previous_spec=prev.spec,
        previous_cost=prev.cost,
    )

    # 2. Formal Verification (Lean 4) — skip kernel rerun on pure mechanical edits
    if elec_or_req_changed or force_verify:
        verification = await verify_design(
            next_rev, next_spec, project.catalog_snapshot, cost
        )
        project.activity.append(
            ActivityEntry(
                timestamp=now,
                revision=next_rev,
                actor="lean",
                kind="verification",
                title=f"Lean 4 checked Rev {next_rev} ({verification.status.upper()})",
                detail=(
                    f"{verification.verified_count} verified, {verification.failed_count} failed, "
                    f"{verification.unverified_count} unverified."
                ),
                status="fail"
                if verification.failed_count or verification.error_count
                else "pass",
            )
        )
    else:
        verification = prev.verification.model_copy(
            deep=True, update={"revision": next_rev}
        )

    # 3. 3D Geometry & GLB — recompute only when mechanical or physical parts changed
    if mech_changed or comp_struct_changed or force_geometry or prev.manifest is None:
        try:
            manifest = build_assembly_for_spec(next_spec, project.catalog_snapshot)
            next_spec.mechanical = manifest.parameters
            glb_bytes = export_glb(manifest)
            geom_src_rev = next_rev
            geom_err = None
            project.activity.append(
                ActivityEntry(
                    timestamp=now,
                    revision=next_rev,
                    actor="geometry",
                    kind="geometry_regenerated",
                    title=f"3D assembly regenerated (Rev {next_rev})",
                    detail=(
                        f"Envelope {manifest.envelope_mm} mm · "
                        f"Wrist {manifest.parameters.wrist_circumference_mm:g} mm · "
                        f"{len(glb_bytes) // 1024} KiB GLB."
                    ),
                    status="pass",
                )
            )
        except GeometryError as exc:
            # Preserve last valid 3D model so user never loses visual context
            manifest = prev.manifest
            glb_bytes = prev.glb
            geom_src_rev = prev.geometry_source_revision
            geom_err = str(exc)
            project.activity.append(
                ActivityEntry(
                    timestamp=now,
                    revision=next_rev,
                    actor="geometry",
                    kind="geometry_failed",
                    title=f"Geometry constraint failed (Rev {next_rev})",
                    detail=str(exc),
                    status="fail",
                )
            )
    else:
        manifest = prev.manifest
        glb_bytes = prev.glb
        geom_src_rev = prev.geometry_source_revision
        geom_err = None

    record = RevisionRecord(
        revision=next_rev,
        parent_revision=prev.revision,
        label=label,
        created_at=now,
        spec=next_spec,
        manifest=manifest,
        glb=glb_bytes,
        geometry_source_revision=geom_src_rev,
        geometry_error=geom_err,
        cost=cost,
        verification=verification,
    )
    project.records[next_rev] = record
    project.current_revision = next_rev
    if len(project.records) > 32:
        oldest = min(k for k in project.records if k != 1 and k != next_rev)
        project.records.pop(oldest, None)

    project.activity.append(
        ActivityEntry(
            timestamp=now,
            revision=next_rev,
            actor=actor,
            kind="revision_committed",
            title=f"Rev {next_rev}: {label}",
            detail="; ".join(cost.deltas_from_previous)
            if cost.deltas_from_previous
            else f"Known BOM {format_minor_currency(cost.known_subtotal_usd_cents, 'USD')}",
            status="warn" if verification.failed_count else "info",
        )
    )
    return record
