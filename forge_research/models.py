from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

Transport = Literal["ble", "wifi", "wired", "wireless", "other", "unspecified"]
PartRole = Literal["controller", "emg_sensor"]
ProofStatus = Literal["verified", "failed", "unverified", "error"]
VerificationStatus = Literal["verified", "partial", "failed", "error"]
OfferMatchKind = Literal["exact_match", "bundle_or_pack", "variant_or_accessory"]


class Requirements(BaseModel):
    application: Literal["emg_wearable", "unsupported"]
    budget_usd_cents: int | None = Field(default=None, ge=0)
    budget_exclusive: bool
    transport: Transport
    wrist_circumference_mm: int | None = Field(default=None, ge=1)
    gestures: list[str]
    unresolved: list[str]


class Quote(BaseModel):
    unit_price_usd_cents: int = Field(ge=0)
    vendor: str
    url: HttpUrl
    reviewed_on: date


class Part(BaseModel):
    id: str
    role: PartRole
    manufacturer: str
    sku: str
    name: str
    transports: list[Transport] = Field(default_factory=list)
    adc_pins: list[str] = Field(default_factory=list)
    digital_pins: list[str] = Field(default_factory=list)
    adc_wifi_conflict_pins: list[str] = Field(default_factory=list)
    board_restricted_adc_pins: list[str] = Field(default_factory=list)
    input_only_pins: list[str] = Field(default_factory=list)
    reserved_pins: list[str] = Field(default_factory=list)
    sensor_rail_mv: int | None = None
    available_rails_mv: list[int] = Field(default_factory=list)
    adc_max_mv: int | None = None
    rail_max_current_ma: int | None = None
    max_current_ma: int | None = None
    supply_range_mv: tuple[int, int] | None = None
    signal_output: Literal["analog_envelope"] | None = None
    output_scales_with_supply: bool | None = None
    dimensions_mm: tuple[float, float, float] | None = None
    technical_sources: list[HttpUrl] = Field(min_length=1)
    quote: Quote | None = None


class AssemblyParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    wrist_circumference_mm: float | None = Field(default=None, ge=120, le=240)
    wall_mm: float = Field(default=2.0, ge=1.2, le=4)
    clearance_mm: float = Field(default=1.5, ge=0.8, le=4)


class ComponentInstance(BaseModel):
    instance_id: str
    catalog_id: str
    role: PartRole
    quantity: int = Field(default=1, ge=1, le=2)
    selected_offer_id: str | None = None


class WiringSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    supply_rail_mv: int = Field(default=3300, ge=1000, le=12000)
    signal_pins: list[str] = Field(default_factory=lambda: ["GPIO34"], min_length=1, max_length=2)
    status_led_pin: str | None = None


class DeviceSpecification(BaseModel):
    """Canonical versioned hardware design inputs."""

    schema_version: Literal[1] = 1
    project_name: str = "EMG Gesture Wristband"
    requirements: Requirements
    components: list[ComponentInstance] = Field(default_factory=list)
    parts_by_instance: dict[str, Part] = Field(default_factory=dict)
    mechanical: AssemblyParameters = Field(default_factory=AssemblyParameters)
    wiring: WiringSpec = Field(default_factory=WiringSpec)


class Proposal(BaseModel):
    controller_id: str | None = None
    sensor_id: str | None = None
    rationale: str


class Finding(BaseModel):
    check: str
    status: Literal["pass", "fail", "unknown"]
    detail: str


class CatalogReview(BaseModel):
    status: Literal["candidate", "blocked", "unsupported"]
    selected_parts: list[Part]
    core_subtotal_usd_cents: int | None = None
    findings: list[Finding]


class ReviewNotes(BaseModel):
    next_steps: list[str]


class TraceEvent(BaseModel):
    agent: str
    event: Literal["catalog_lookup", "completed"]
    part_ids: list[str] = Field(default_factory=list)


class ResearchReport(BaseModel):
    schema_version: Literal[1] = 1
    mode: Literal["offline", "claude", "gemini", "nous"]
    model: str
    brief: str
    requirements: Requirements
    proposal: Proposal
    catalog_snapshot: dict[str, Part]
    review: CatalogReview
    review_notes: ReviewNotes
    trace: list[TraceEvent]


class ProcurementOffer(BaseModel):
    offer_id: str
    product_id: str
    variant_id: str
    title: str
    variant_label: str | None = None
    seller_name: str
    seller_domain: str
    price_minor_units: int = Field(ge=0)
    currency: str
    formatted_price: str
    price_usd_cents: int | None = None
    available: bool
    url: str
    image_url: str | None = None
    match_kind: OfferMatchKind
    match_note: str
    retrieved_at: datetime


class PartProcurementResult(BaseModel):
    catalog_id: str
    sku: str
    query: str
    status: Literal["not_searched", "ok", "no_results", "error"] = "not_searched"
    offers: list[ProcurementOffer] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    error_message: str | None = None
    retrieved_at: datetime | None = None


class ProcurementState(BaseModel):
    revision: int
    source: Literal["none", "shop_mcp"] = "none"
    results_by_part: dict[str, PartProcurementResult] = Field(default_factory=dict)


class BomLineItem(BaseModel):
    instance_id: str
    catalog_id: str
    name: str
    manufacturer: str
    sku: str
    role: PartRole
    quantity: int
    catalog_unit_usd_cents: int | None = None
    catalog_vendor: str | None = None
    catalog_url: str | None = None
    catalog_reviewed_on: date | None = None
    selected_offer: ProcurementOffer | None = None
    effective_unit_usd_cents: int | None = None
    pricing_source: Literal["catalog_quote", "merchant_offer", "unpriced"]
    extended_usd_cents: int | None = None
    notes: list[str] = Field(default_factory=list)


class CostBreakdown(BaseModel):
    revision: int
    currency: Literal["USD"] = "USD"
    line_items: list[BomLineItem]
    catalog_subtotal_usd_cents: int | None = None
    known_subtotal_usd_cents: int
    complete_subtotal_usd_cents: int | None = None
    has_unpriced_items: bool
    unpriced_catalog_ids: list[str] = Field(default_factory=list)
    budget_usd_cents: int | None = None
    budget_exclusive: bool = True
    budget_remaining_usd_cents: int | None = None
    budget_status: Literal["within_budget", "exceeded", "incomplete", "unspecified"]
    deltas_from_previous: list[str] = Field(default_factory=list)
    scope_disclaimer: str = (
        "Known hardware BOM only. Excludes disposable EMG electrodes, battery, "
        "3D-printed enclosure material, shipping, and tax."
    )


class ObligationResult(BaseModel):
    id: str
    title: str
    category: Literal["voltage", "gpio", "power", "budget", "connectivity"]
    status: ProofStatus
    summary: str
    inputs: dict[str, object] = Field(default_factory=dict)
    lean_theorem: str | None = None
    lean_proposition: str | None = None
    axioms_used: list[str] = Field(default_factory=list)
    diagnostic: str | None = None
    sources: list[str] = Field(default_factory=list)


class VerificationReport(BaseModel):
    revision: int
    status: VerificationStatus
    lean_version: str | None = None
    lean_source: str | None = None
    verified_count: int = 0
    failed_count: int = 0
    unverified_count: int = 0
    error_count: int = 0
    obligations: list[ObligationResult] = Field(default_factory=list)


class RevisionDiff(BaseModel):
    from_revision: int
    to_revision: int
    changed_fields: list[str] = Field(default_factory=list)
    geometry_changes: list[str] = Field(default_factory=list)
    cost_changes: list[str] = Field(default_factory=list)
    verification_changes: list[str] = Field(default_factory=list)


class ActivityEntry(BaseModel):
    timestamp: datetime
    revision: int
    actor: Literal["user", "claude", "gemini", "nous", "offline_fixture", "lean", "geometry", "bom", "shop_mcp"]
    kind: str
    title: str
    detail: str
    status: Literal["info", "pass", "warn", "fail"] = "info"
