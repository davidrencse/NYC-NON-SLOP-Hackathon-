"""Datasheet evidence: Reducto extraction to typed, source-linked component facts.

Flow per catalog part:
1. Collect known manufacturer PDFs (board, module, SoC, and explicitly added URLs).
2. Hash each; reuse a cached extraction for the same hash and schema version.
3. Reducto fills EXTRACTION_SCHEMA with page citations for each document, and
   the facts are merged: one primary value per field, corroborations counted,
   disagreements kept and marked for review.
4. Normalize units to mV / mA / mm and keep absolute-maximum ratings apart from
   recommended operating conditions.
5. Independently read the same PDF with Gemini; compare identity, revision,
   numbers, units, citations and conditions. Missing or disputed critical specs
   block live builds and revisions.
6. Compare against the curated catalog record. Disagreements are flagged as
   conflicts for a human; nothing here silently changes the design.

Without a Reducto key the studio still shows evidence, built from the curated
catalog record and labeled ``catalog_record`` so it is never mistaken for a
parsed datasheet.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..models import Finding, Part
from ..providers.reducto import ReductoError, extract, fetch_pdf, reducto_api_key
from ..providers.usage import record_usage
from ..providers.datasheet_review import (
    IndependentRead, REVIEW_VERSION, ReviewUnavailable, read_pdf, review_model,
)

SCHEMA_VERSION = 2

# Every manufacturer document FORGE knows for each curated part. All of them are
# read and merged into one evidence bundle. ``scope`` limits which facts a
# document may contribute: a SoC datasheet knows electrical limits but its
# 5 x 5 mm package outline is not the dev board's outline.
DocumentScope = Literal["full", "electrical"]


class BundleDocument(BaseModel):
    url: str
    title: str
    scope: DocumentScope = "full"
    subject: str | None = None
    manufacturer: str | None = None


PART_DOCUMENTS: dict[str, list[BundleDocument]] = {
    "esp32-devkitc-32e": [
        BundleDocument(
            url="https://www.espressif.com/sites/default/files/documentation/esp32-wroom-32e_esp32-wroom-32ue_datasheet_en.pdf",
            title="ESP32-WROOM-32E module datasheet", scope="electrical", subject="ESP32-WROOM-32E",
        ),
        BundleDocument(
            url="https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf",
            title="ESP32 SoC datasheet", scope="electrical", subject="ESP32",
        ),
    ],
    "arduino-uno-r3": [
        BundleDocument(url="https://docs.arduino.cc/resources/datasheets/A000066-datasheet.pdf", title="Arduino UNO R3 datasheet"),
        BundleDocument(
            url="https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf",
            title="ATmega328P datasheet", scope="electrical", subject="ATmega328P", manufacturer="Microchip",
        ),
    ],
    "myoware-2-dev-27924": [
        BundleDocument(
            url="https://myoware.com/wp-content/uploads/2022/03/MyoWare_v2_AdvancedGuide-Updated.pdf",
            title="MyoWare 2.0 advanced guide",
        ),
    ],
}

# Kept for callers that want a single primary PDF per part.
DATASHEET_PDFS: dict[str, str] = {pid: docs[0].url for pid, docs in PART_DOCUMENTS.items()}


def documents_for(part: Part, extra_urls: list[str] | None = None) -> list[BundleDocument]:
    """Known documents plus any PDF links found during research, deduplicated."""
    docs = list(PART_DOCUMENTS.get(part.id, []))
    seen = {d.url for d in docs}
    for url in [*(str(u) for u in part.technical_sources), *(extra_urls or [])]:
        if url.lower().split("?")[0].endswith(".pdf") and url not in seen:
            docs.append(BundleDocument(url=url, title=url.rsplit("/", 1)[-1], scope="electrical"))
            seen.add(url)
    return docs


FactKind = Literal[
    "absolute_maximum", "recommended_operating", "electrical", "dimension", "pin", "interface"
]
Provenance = Literal["datasheet_extraction", "catalog_record"]
FactStatus = Literal["extracted", "consistent", "conflict", "needs_review", "catalog_only"]

_NUMBER = {"type": ["number", "null"]}
_RANGE = {
    "type": "object",
    "properties": {"min": _NUMBER, "typ": _NUMBER, "max": _NUMBER, "unit": {"type": ["string", "null"]},
                   "conditions": {"type": ["string", "null"]},
                   "subject": {"type": ["string", "null"]}},
}

EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "manufacturer": {"type": ["string", "null"], "description": "Manufacturer named on the document."},
        "part_number": {"type": ["string", "null"], "description": "Primary manufacturer part number."},
        "document_revision": {"type": ["string", "null"], "description": "Datasheet version or revision label."},
        "supply_voltage_recommended": {**_RANGE, "description": "Recommended operating supply voltage (VDD/VCC/VIN)."},
        "supply_voltage_absolute_max": {**_RANGE, "description": "Absolute maximum supply voltage rating only."},
        "io_voltage_absolute_max": {**_RANGE, "description": "Absolute maximum voltage on any I/O pin."},
        "operating_current": {**_RANGE, "description": "Supply current in the main active mode."},
        "adc_input_range": {**_RANGE, "description": "ADC input voltage range at default attenuation/reference."},
        "adc_resolution_bits": _NUMBER,
        "adc_resolution_conditions": {"type": ["string", "null"]},
        "adc_resolution_subject": {"type": ["string", "null"]},
        "dimensions": {
            "type": "object",
            "description": "Package or module outline.",
            "properties": {"length": _NUMBER, "width": _NUMBER, "height": _NUMBER, "unit": {"type": ["string", "null"]},
                           "conditions": {"type": ["string", "null"]}, "subject": {"type": ["string", "null"]}},
        },
        "wireless_interfaces": {"type": "array", "items": {"type": "string"}},
        "pins": {
            "type": "array",
            "description": "Pin table rows.",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "function": {"type": ["string", "null"]}},
            },
        },
    },
}

SYSTEM_PROMPT = (
    "You extract electrical and mechanical facts from a component datasheet. Copy numbers "
    "exactly as printed with their units. Keep absolute maximum ratings separate from "
    "recommended operating conditions. Return null when a value is not stated. Never infer. "
    "For each range and outline, copy the exact subject (board/module/chip) and all table conditions "
    "and relevant footnotes verbatim into conditions. Use an empty conditions string only when none "
    "are stated; use null when unresolved. Do not collapse rows with different operating modes."
)


class ComponentFact(BaseModel):
    model_config = {"allow_inf_nan": False}
    field: str
    label: str
    kind: FactKind
    value: float | str | None = None
    min: float | None = None
    typ: float | None = None
    max: float | None = None
    unit: str | None = None
    page: int | None = None
    snippet: str | None = None
    provenance: Provenance
    status: FactStatus
    note: str | None = None
    document_url: str | None = None
    primary: bool = True
    corroborated_by: int = 0
    conditions: str | None = None
    subject: str | None = None
    verification: Literal["unverified", "agreed", "disputed"] = "unverified"
    verification_reason: str | None = None
    independent: dict[str, Any] | None = None


class SourceDocument(BaseModel):
    url: str
    title: str | None = None
    scope: DocumentScope = "full"
    sha256: str | None = None
    revision: str | None = None
    extracted_part_number: str | None = None
    extracted_manufacturer: str | None = None
    pages: int | None = None
    job_id: str | None = None
    cached: bool = False
    status: Literal["parsed", "failed", "catalog"] = "parsed"
    error: str | None = None
    independent_read: IndependentRead | None = None
    verification_error: str | None = None


class ComponentEvidence(BaseModel):
    part_id: str
    part_name: str
    provider: Literal["reducto", "catalog"]
    status: Literal["source_grounded", "catalog_only", "conflict", "error"]
    documents: list[SourceDocument] = Field(default_factory=list)
    bundle_sha256: str | None = None
    facts: list[ComponentFact] = Field(default_factory=list)
    checks: list[Finding] = Field(default_factory=list)
    cached: bool = False
    error: str | None = None
    design_ready: bool = False
    blocking_reasons: list[str] = Field(default_factory=list)
    schema_version: int = SCHEMA_VERSION
    retrieved_at: datetime


# ---------------------------------------------------------------- units

_SCALE = {
    "v": ("mV", 1000.0), "mv": ("mV", 1.0), "kv": ("mV", 1_000_000.0),
    "a": ("mA", 1000.0), "ma": ("mA", 1.0), "ua": ("mA", 0.001), "µa": ("mA", 0.001), "μa": ("mA", 0.001),
    "mm": ("mm", 1.0), "cm": ("mm", 10.0), "in": ("mm", 25.4), "mil": ("mm", 0.0254), "m": ("mm", 1000.0),
}


def normalize_unit(value: float | None, unit: str | None) -> tuple[float | None, str | None]:
    """Convert to FORGE's internal mV / mA / mm. Unknown units pass through unchanged."""
    if unit is None:
        return value, None
    key = re.sub(r"\s+", "", unit).lower()
    if key not in _SCALE:
        return value, unit
    target, factor = _SCALE[key]
    return (None if value is None else round(value * factor, 4)), target


def _cell(raw: Any) -> tuple[Any, int | None, str | None]:
    """Unwrap a Reducto citation cell {value, citations:[{bbox:{page}, content}]}."""
    if isinstance(raw, dict) and "value" in raw and ("citations" in raw or len(raw) == 1):
        page = snippet = None
        for citation in raw.get("citations") or []:
            bbox = citation.get("bbox") or {}
            page = page or bbox.get("page") or citation.get("page")
            snippet = snippet or citation.get("content")
        return raw["value"], page, snippet
    return raw, None, None


def _unwrap(raw: Any) -> tuple[Any, int | None, str | None]:
    value, page, snippet = _cell(raw)
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            inner, inner_page, inner_snippet = _unwrap(item)
            out[key] = inner
            page = page or inner_page
            snippet = snippet or inner_snippet
        return out, page, snippet
    if isinstance(value, list):
        items = []
        for item in value:
            inner, inner_page, inner_snippet = _unwrap(item)
            items.append(inner)
            page = page or inner_page
            snippet = snippet or inner_snippet
        return items, page, snippet
    return value, page, snippet


def facts_from_extraction(result: Any) -> tuple[list[ComponentFact], str | None]:
    if isinstance(result, list):
        result = result[0] if result else {}
    data, _, _ = _unwrap(result or {})
    raw = result if isinstance(result, dict) else {}
    facts: list[ComponentFact] = []

    def page_of(name: str) -> tuple[int | None, str | None]:
        _, page, snippet = _unwrap(raw.get(name))
        return page, snippet

    ranges = (
        ("supply_voltage_recommended", "Recommended supply voltage", "recommended_operating"),
        ("supply_voltage_absolute_max", "Absolute maximum supply voltage", "absolute_maximum"),
        ("io_voltage_absolute_max", "Absolute maximum I/O voltage", "absolute_maximum"),
        ("operating_current", "Operating current", "electrical"),
        ("adc_input_range", "ADC input range", "electrical"),
    )
    for name, label, kind in ranges:
        block = data.get(name)
        if not isinstance(block, dict) or all(block.get(k) is None for k in ("min", "typ", "max")):
            continue
        unit = block.get("unit")
        lo, out_unit = normalize_unit(block.get("min"), unit)
        typ, _ = normalize_unit(block.get("typ"), unit)
        hi, _ = normalize_unit(block.get("max"), unit)
        page, snippet = page_of(name)
        facts.append(
            ComponentFact(
                field=name, label=label, kind=kind, min=lo, typ=typ, max=hi, unit=out_unit,
                page=page, snippet=snippet, provenance="datasheet_extraction",
                conditions=block.get("conditions"), subject=block.get("subject"),
                status="extracted" if out_unit in ("mV", "mA") else "needs_review",
                note=None if out_unit in ("mV", "mA") else f"Unrecognized unit '{unit}'.",
            )
        )
    if (bits := data.get("adc_resolution_bits")) is not None:
        page, snippet = page_of("adc_resolution_bits")
        facts.append(ComponentFact(
            field="adc_resolution_bits", label="ADC resolution", kind="electrical", value=bits,
            unit="bit", page=page, snippet=snippet, provenance="datasheet_extraction", status="extracted",
            conditions=data.get("adc_resolution_conditions"), subject=data.get("adc_resolution_subject"),
        ))
    dims = data.get("dimensions")
    if isinstance(dims, dict) and any(dims.get(k) is not None for k in ("length", "width", "height")):
        page, snippet = page_of("dimensions")
        for axis in ("length", "width", "height"):
            value, unit = normalize_unit(dims.get(axis), dims.get("unit"))
            if value is None:
                continue
            facts.append(ComponentFact(
                field=f"dimension_{axis}", label=f"Outline {axis}", kind="dimension", value=value,
                unit=unit, page=page, snippet=snippet, provenance="datasheet_extraction",
                conditions=dims.get("conditions"), subject=dims.get("subject"),
                status="extracted" if unit == "mm" else "needs_review",
            ))
    for name in data.get("wireless_interfaces") or []:
        facts.append(ComponentFact(
            field="wireless_interface", label="Wireless interface", kind="interface", value=str(name),
            provenance="datasheet_extraction", status="extracted",
        ))
    pins = [p for p in data.get("pins") or [] if isinstance(p, dict) and p.get("name")]
    if pins:
        page, snippet = page_of("pins")
        facts.append(ComponentFact(
            field="pin_table", label="Pin table", kind="pin",
            value=", ".join(str(p["name"]) for p in pins[:64]), page=page, snippet=snippet,
            provenance="datasheet_extraction", status="extracted", note=f"{len(pins)} pins extracted",
        ))
    return facts, data.get("document_revision")


# ------------------------------------------------------------- checks


def _find(facts: list[ComponentFact], field: str) -> ComponentFact | None:
    return next((fact for fact in facts if fact.field == field and fact.primary), None)


def cross_check(part: Part, facts: list[ComponentFact]) -> list[Finding]:
    """Deterministic comparison of parsed facts with the curated catalog record."""
    findings: list[Finding] = []
    recommended = _find(facts, "supply_voltage_recommended")
    absolute = _find(facts, "supply_voltage_absolute_max")

    if recommended and absolute and recommended.max is not None and absolute.max is not None:
        ok = recommended.max <= absolute.max
        findings.append(Finding(
            check="ratings_ordering",
            status="pass" if ok else "fail",
            detail=(
                f"Recommended max {recommended.max:g} mV is within the absolute maximum {absolute.max:g} mV."
                if ok else
                f"Recommended max {recommended.max:g} mV exceeds the absolute maximum {absolute.max:g} mV; the extraction likely mixed tables."
            ),
        ))
        if not ok:
            recommended.status = absolute.status = "conflict"

    if part.supply_range_mv and recommended and recommended.min is not None and recommended.max is not None:
        lo, hi = part.supply_range_mv
        ok = abs(lo - recommended.min) <= 50 and abs(hi - recommended.max) <= 50
        recommended.status = "consistent" if ok else "conflict"
        findings.append(Finding(
            check="supply_range_matches_catalog",
            status="pass" if ok else "fail",
            detail=f"Catalog {lo}-{hi} mV vs datasheet {recommended.min:g}-{recommended.max:g} mV.",
        ))

    rail = part.sensor_rail_mv or (max(part.available_rails_mv) if part.available_rails_mv else None)
    io_abs = _find(facts, "io_voltage_absolute_max")
    if rail and io_abs and io_abs.max is not None:
        ok = rail <= io_abs.max
        findings.append(Finding(
            check="logic_rail_within_io_abs_max",
            status="pass" if ok else "fail",
            detail=f"Logic rail {rail} mV vs I/O absolute maximum {io_abs.max:g} mV.",
        ))

    adc = _find(facts, "adc_input_range")
    if part.adc_max_mv and adc and adc.max is not None:
        ok = part.adc_max_mv <= adc.max + 50
        adc.status = "consistent" if ok else "conflict"
        findings.append(Finding(
            check="adc_range_matches_catalog",
            status="pass" if ok else "fail",
            detail=f"Catalog ADC full scale {part.adc_max_mv} mV vs datasheet max {adc.max:g} mV.",
        ))

    dims = [f for f in facts if f.kind == "dimension" and isinstance(f.value, (int, float))]
    if part.dimensions_mm and dims:
        catalog_sorted = sorted(part.dimensions_mm)
        sheet_sorted = sorted(float(f.value) for f in dims)
        # A module datasheet can describe the module rather than the dev board.
        largest_gap = max(abs(a - b) for a, b in zip(catalog_sorted[-len(sheet_sorted):], sheet_sorted))
        ok = largest_gap <= 1.0
        for fact in dims:
            fact.status = "consistent" if ok else "needs_review"
        findings.append(Finding(
            check="outline_matches_catalog",
            status="pass" if ok else "unknown",
            detail=(
                "Datasheet outline agrees with the catalog within 1 mm."
                if ok else
                f"Outline differs by up to {largest_gap:.1f} mm; the document may describe the bare module, not the board. Review before CAD use."
            ),
        ))

    if "ble" in part.transports:
        wireless = " ".join(str(f.value).lower() for f in facts if f.field == "wireless_interface")
        if wireless:
            ok = "ble" in wireless or "bluetooth" in wireless
            findings.append(Finding(
                check="ble_in_datasheet",
                status="pass" if ok else "fail",
                detail="Datasheet lists Bluetooth." if ok else "Catalog claims BLE but the datasheet extraction does not list it.",
            ))
    return findings


def catalog_evidence(part: Part, *, error: str | None = None) -> ComponentEvidence:
    """Evidence view of the curated record, explicitly not a parsed datasheet."""
    source = str(part.technical_sources[0])
    facts: list[ComponentFact] = []

    def add(field: str, label: str, kind: FactKind, **values: Any) -> None:
        facts.append(ComponentFact(
            field=field, label=label, kind=kind, provenance="catalog_record", status="catalog_only",
            snippet=f"Curated catalog record; see {source}", **values,
        ))

    if part.supply_range_mv:
        add("supply_voltage_recommended", "Supply voltage", "recommended_operating",
            min=part.supply_range_mv[0], max=part.supply_range_mv[1], unit="mV")
    for rail in part.available_rails_mv:
        add("available_rail", "Available rail", "electrical", value=rail, unit="mV")
    if part.adc_max_mv:
        add("adc_input_range", "ADC full scale", "electrical", max=part.adc_max_mv, unit="mV")
    if part.max_current_ma:
        add("operating_current", "Max current", "electrical", max=part.max_current_ma, unit="mA")
    if part.dimensions_mm:
        for axis, value in zip(("length", "width", "height"), part.dimensions_mm):
            add(f"dimension_{axis}", f"Outline {axis}", "dimension", value=value, unit="mm")
    for transport in part.transports:
        add("wireless_interface", "Interface", "interface", value=transport)
    if part.adc_pins:
        add("pin_table", "ADC pins", "pin", value=", ".join(part.adc_pins))
    return ComponentEvidence(
        part_id=part.id,
        part_name=part.name,
        provider="catalog",
        status="error" if error else "catalog_only",
        documents=[SourceDocument(url=source, title="Curated catalog record", status="catalog")],
        facts=facts,
        error=error,
        blocking_reasons=[error or "Catalog-only evidence has not been independently verified."],
        retrieved_at=datetime.now(UTC),
    )


# ------------------------------------------------------------- cache


def cache_dir() -> Path:
    root = Path(os.getenv("FORGE_CACHE_DIR") or Path(__file__).resolve().parents[2] / ".cache" / "forge")
    path = root / "evidence"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _cache_path(sha: str) -> Path:
    return cache_dir() / f"{sha}-v{SCHEMA_VERSION}.json"


async def _independent_read(part: Part, doc: BundleDocument, data: bytes, sha: str) -> IndependentRead:
    # Reader caches are independent of Reducto and invalidated by model, prompt,
    # subject or schema changes. A missing credential never reuses a prior approval.
    if not os.getenv("ANTHROPIC_API_KEY", "").strip():
        raise ReviewUnavailable("Claude key missing; independent verification unavailable.")
    subject = doc.subject or part.sku
    manufacturer = doc.manufacturer or part.manufacturer
    context = f"{sha}|{subject}|{manufacturer}|{review_model()}|{REVIEW_VERSION}|{SCHEMA_VERSION}"
    path = cache_dir() / f"review-{hashlib.sha256(context.encode()).hexdigest()}.json"
    if path.exists():
        try:
            result = IndependentRead.model_validate_json(path.read_text())
            record_usage("gemini", "datasheet.independent_read", model=review_model(), cache_hit=True)
            return result
        except (OSError, ValueError):
            pass
    result = await read_pdf(data, subject=subject, manufacturer=manufacturer)
    path.write_text(result.model_dump_json())
    return result


def _text(value: str | None) -> str:
    return " ".join((value or "").casefold().split())


CRITICAL_FIELDS = {
    "supply_voltage_recommended", "supply_voltage_absolute_max", "io_voltage_absolute_max",
    "operating_current", "adc_input_range", "adc_resolution_bits",
    "dimension_length", "dimension_width", "dimension_height",
}


def compare_independent(facts: list[ComponentFact], read: IndependentRead | None,
                        error: str | None = None) -> None:
    """Conservative agreement, never a model vote or a replacement for source review."""
    for fact in facts:
        if fact.field not in CRITICAL_FIELDS:
            continue
        reason = error or "Independent evidence unavailable."
        if read is not None:
            candidates = [f for f in read.facts if f.field == fact.field]
            if not read.identity_matches:
                reason = f"Document identity unresolved: {read.identity_reason}"
            elif len(candidates) != 1:
                reason = "Independent reader found no unique applicable row."
            else:
                other = candidates[0]
                fact.independent = other.model_dump()
                numbers = {k: normalize_unit(getattr(other, k), other.unit)[0]
                           for k in ("value", "min", "typ", "max")}
                unit = normalize_unit(None, other.unit)[1]
                expected_unit = ("mm" if fact.kind == "dimension" else "bit" if fact.field == "adc_resolution_bits"
                                 else "mA" if fact.field == "operating_current" else "mV")
                exact = fact.unit == unit == expected_unit and all(
                    (getattr(fact, k) is None and v is None) or
                    (getattr(fact, k) is not None and v is not None and
                     math.isclose(float(getattr(fact, k)), v, rel_tol=1e-6, abs_tol=1e-6))
                    for k, v in numbers.items()
                )
                cited = bool(fact.page and fact.page >= 1 and fact.snippet and fact.snippet.strip())
                context = (other.conditions_complete and fact.conditions is not None and
                           _text(fact.conditions) == _text(other.conditions) and
                           bool(fact.subject) and _text(fact.subject) == _text(other.subject))
                if exact and cited and context and fact.page == other.page and fact.status != "needs_review":
                    fact.verification = "agreed"
                    fact.verification_reason = "Independent PDF reads agree on value, unit, page, subject and conditions."
                    continue
                reason = "Independent reads disagree or lack matching citations, subject or complete conditions."
                fact.verification = "disputed"
        fact.verification_reason = reason
        fact.status = "needs_review"


async def _parse_pdf(part: Part, doc: BundleDocument, data: bytes) -> tuple[SourceDocument, list[ComponentFact]]:
    sha = hashlib.sha256(data).hexdigest()
    cached = _cache_path(sha)
    raw: dict[str, Any] | None = None
    if cached.exists():
        try:
            raw = json.loads(cached.read_text())
        except (OSError, json.JSONDecodeError):
            pass
    hit = raw is not None

    async def reducto_read() -> dict[str, Any]:
        if raw is not None:
            record_usage("reducto", "extract", ok=True, cache_hit=True, detail=doc.title)
            return raw
        result = await extract(data, filename=doc.url.rsplit("/", 1)[-1] or f"{part.id}.pdf",
                               schema=EXTRACTION_SCHEMA, system_prompt=SYSTEM_PROMPT)
        cached.write_text(json.dumps(result))
        return result

    # Neither reader sees the other's answer. Both receive the same bytes.
    extracted, reviewed = await asyncio.gather(
        reducto_read(), _independent_read(part, doc, data, sha), return_exceptions=True,
    )
    if isinstance(extracted, BaseException):
        return SourceDocument(url=doc.url, title=doc.title, scope=doc.scope, sha256=sha,
                              status="failed", error=str(extracted) if isinstance(extracted, ReductoError) else f"Extraction failed ({type(extracted).__name__})."), []
    read = reviewed if isinstance(reviewed, IndependentRead) else None
    review_error = str(reviewed) if isinstance(reviewed, ReviewUnavailable) else (
        f"Independent read failed ({type(reviewed).__name__})." if read is None else None
    )
    facts, revision = facts_from_extraction(extracted.get("result"))
    result = extracted.get("result") or {}
    if isinstance(result, list):
        result = result[0] if result else {}
    identity, _, _ = _unwrap(result)
    extracted_number = identity.get("part_number")
    extracted_manufacturer = identity.get("manufacturer")
    if read is not None:
        expected = re.sub(r"[^a-z0-9]", "", (doc.subject or part.sku).casefold())
        observed = re.sub(r"[^a-z0-9]", "", read.part_number.casefold())
        reducto_number = re.sub(r"[^a-z0-9]", "", (extracted_number or "").casefold())
        if expected != reducto_number or not extracted_manufacturer or _text(doc.manufacturer or part.manufacturer) not in _text(extracted_manufacturer):
            review_error = "Reducto document identity missing or mismatched."
        if expected != observed or _text(doc.manufacturer or part.manufacturer) not in _text(read.manufacturer):
            read.identity_matches = False
            read.identity_reason = "Extracted manufacturer or exact variant does not match the expected subject."
        if not revision or not read.revision or _text(revision) != _text(read.revision):
            review_error = "Document revision missing or readers disagree on revision."
    if doc.scope == "electrical":
        facts = [f for f in facts if f.kind != "dimension"]
    for fact in facts:
        fact.document_url = doc.url
    compare_independent(facts, read if not review_error else None, review_error)
    usage = extracted.get("usage") or {}
    return SourceDocument(
        url=doc.url, title=doc.title, scope=doc.scope, sha256=sha, revision=revision,
        pages=usage.get("num_pages"), job_id=extracted.get("job_id"), cached=hit,
        extracted_part_number=extracted_number, extracted_manufacturer=extracted_manufacturer,
        independent_read=read, verification_error=review_error,
    ), facts


async def _extract_document(part: Part, doc: BundleDocument) -> tuple[SourceDocument, list[ComponentFact]]:
    try:
        return await _parse_pdf(part, doc, await fetch_pdf(doc.url))
    except ReductoError as error:
        return SourceDocument(url=doc.url, title=doc.title, scope=doc.scope,
                              status="failed", error=str(error)), []


def _same(a: ComponentFact, b: ComponentFact) -> bool:
    if a.unit != b.unit:
        return False
    if a.field in CRITICAL_FIELDS:
        return (a.conditions == b.conditions and a.subject == b.subject and all(
            (getattr(a, k) is None and getattr(b, k) is None) or
            (getattr(a, k) is not None and getattr(b, k) is not None and
             math.isclose(float(getattr(a, k)), float(getattr(b, k)), rel_tol=1e-6, abs_tol=1e-6))
            for k in ("value", "min", "typ", "max")
        ))
    for x, y in ((a.min, b.min), (a.typ, b.typ), (a.max, b.max)):
        if x is not None and y is not None and abs(x - y) > max(abs(x), abs(y)) * 0.05 + 1e-9:
            return False
    if isinstance(a.value, (int, float)) and isinstance(b.value, (int, float)):
        return abs(a.value - b.value) <= max(abs(a.value), abs(b.value)) * 0.05 + 1e-9
    return True


def merge_facts(per_document: list[list[ComponentFact]]) -> list[ComponentFact]:
    """Combine facts from every document in the bundle.

    The first document stating a field supplies the primary fact. Later
    documents that agree on numbers and context corroborate it; disagreements are kept
    as secondary facts and both sides are marked ``needs_review``.
    """
    merged: list[ComponentFact] = []
    primary: dict[str, ComponentFact] = {}
    for facts in per_document:
        for fact in facts:
            # Interfaces and pin tables are lists: every distinct value is primary.
            key = fact.field if fact.kind not in ("interface",) else f"{fact.field}:{str(fact.value).lower()}"
            first = primary.get(key)
            if first is None:
                primary[key] = fact
                merged.append(fact)
            elif _same(first, fact):
                first.corroborated_by += 1
                if fact.verification != "agreed" or fact.conditions != first.conditions or fact.subject != first.subject:
                    first.verification = "unverified"
                    first.verification_reason = "Another document lacks matching verified context."
            else:
                first.verification = fact.verification = "disputed"
                fact.primary = False
                fact.status = "needs_review"
                fact.note = "Disagrees with the primary document for this field."
                if first.status == "extracted":
                    first.status = "needs_review"
                    first.note = "Another document in this bundle states a different value."
                merged.append(fact)
    return merged


async def extract_part_evidence(
    part: Part, *, extra_urls: list[str] | None = None, pdf: bytes | None = None
) -> ComponentEvidence:
    """Read every document known for a part and merge them into one evidence bundle.

    Without a Reducto key, or with no PDFs for the part, returns the labeled
    catalog record instead.
    """
    docs = documents_for(part, extra_urls)
    if (not docs and pdf is None) or reducto_api_key() is None:
        return catalog_evidence(part)
    results = await asyncio.gather(*(_extract_document(part, doc) for doc in docs))
    sources = [source for source, _ in results]
    per_document = [facts for _, facts in results]
    if pdf is not None:
        upload = BundleDocument(url="uploaded.pdf", title="Uploaded datasheet")
        source, uploaded_facts = await _parse_pdf(part, upload, pdf)
        sources.insert(0, source)
        per_document.insert(0, uploaded_facts)
    return bundle_from_documents(part, sources, per_document)


def bundle_from_documents(part: Part, sources: list[SourceDocument],
                          per_document: list[list[ComponentFact]]) -> ComponentEvidence:
    """Build checks from already-read, content-pinned documents; never refetch."""
    parsed = [s for s in sources if s.status == "parsed"]
    if not parsed:
        errors = "; ".join(f"{s.title}: {s.error}" for s in sources if s.error)
        fallback = catalog_evidence(part, error=errors or "No document could be parsed.")
        fallback.documents = sources + fallback.documents
        return fallback
    facts = merge_facts(per_document)
    checks = cross_check(part, facts)
    if not any(f.kind == "dimension" for f in facts) and part.dimensions_mm:
        # Board outline still comes from the curated record; say so.
        facts.extend(f for f in catalog_evidence(part).facts if f.kind == "dimension")
    blockers = design_blockers(part, facts, sources, checks)
    status: Literal["source_grounded", "conflict"] = (
        "conflict" if any(c.status == "fail" for c in checks) else "source_grounded"
    )
    bundle = hashlib.sha256("|".join(sorted(s.sha256 or s.url for s in parsed)).encode()).hexdigest()
    return ComponentEvidence(
        part_id=part.id,
        part_name=part.name,
        provider="reducto",
        status=status,
        documents=sources,
        bundle_sha256=bundle,
        facts=facts,
        checks=checks,
        design_ready=not blockers, blocking_reasons=blockers,
        cached=all(s.cached for s in parsed),
        retrieved_at=datetime.now(UTC),
    )


def design_blockers(part: Part, facts: list[ComponentFact], sources: list[SourceDocument],
                    checks: list[Finding]) -> list[str]:
    required = {"supply_voltage_recommended", "supply_voltage_absolute_max", "operating_current",
                "dimension_length", "dimension_width", "dimension_height"}
    if part.role == "controller":
        required |= {"io_voltage_absolute_max", "adc_input_range", "adc_resolution_bits"}
    reasons = []
    for field in sorted(required):
        fact = _find(facts, field)
        if fact is None or fact.verification != "agreed" or fact.status in {"conflict", "needs_review", "catalog_only"}:
            reasons.append(f"{field}: missing, disputed or unverified.")
    for field in sorted(required):
        fact = _find(facts, field)
        if fact is None:
            continue
        if field in {"supply_voltage_recommended", "adc_input_range"} and (fact.min is None or fact.max is None):
            reasons.append(f"{field}: both range limits are required.")
        if field in {"supply_voltage_absolute_max", "io_voltage_absolute_max", "operating_current"} and fact.max is None:
            reasons.append(f"{field}: an explicit maximum is required.")
    for fact in facts:
        if fact.field in required and fact.primary:
            if fact.min is not None and fact.max is not None and fact.min > fact.max:
                reasons.append(f"{fact.field}: minimum exceeds maximum.")
            if fact.typ is not None and ((fact.min is not None and fact.typ < fact.min) or
                                         (fact.max is not None and fact.typ > fact.max)):
                reasons.append(f"{fact.field}: typical value lies outside range.")
            if fact.kind == "dimension" and (not isinstance(fact.value, (float, int)) or fact.value <= 0):
                reasons.append(f"{fact.field}: positive outline dimension required.")
    current = _find(facts, "operating_current")
    if part.max_current_ma is not None and (not current or current.unit != "mA" or current.max != part.max_current_ma):
        reasons.append("operating_current: catalog maximum is not corroborated.")
    for source in sources:
        if source.status != "parsed" or source.verification_error or not source.independent_read or not source.independent_read.identity_matches:
            reasons.append(f"{source.title}: document identity/read not verified.")
    for check in checks:
        if check.status != "pass":
            reasons.append(f"{check.check}: {check.detail}")
    # Electrical sources cannot substitute for the actual board dimensions.
    for fact in facts:
        if fact.field in required and fact.primary and _text(fact.subject) != _text(part.sku):
            reasons.append(f"{fact.field}: component rating cannot substitute for the exact catalog SKU.")
    return reasons


# ---------------------------------------------------------- registry


class EvidenceRegistry:
    """Pre-reads evidence for every catalog part so swaps are instant.

    ``prefetch`` schedules background extraction for parts that have no
    result yet; ``get`` awaits an in-flight task or starts one.
    """

    def __init__(self, concurrency: int = 3) -> None:
        self._results: dict[str, ComponentEvidence] = {}
        self._part_signatures: dict[str, str] = {}
        self._tasks: dict[str, asyncio.Task[ComponentEvidence]] = {}
        self._extra: dict[str, list[str]] = {}
        self._limit = asyncio.Semaphore(concurrency)
        self._configuration: tuple[str, ...] | None = tuple(os.getenv(k, "") for k in self.CONFIG_KEYS)

    async def _run(self, part: Part) -> ComponentEvidence:
        async with self._limit:
            try:
                evidence = await extract_part_evidence(part, extra_urls=self._extra.get(part.id))
            except Exception as error:  # noqa: BLE001 - a background read must not crash the studio
                evidence = catalog_evidence(part, error=f"Evidence read failed: {error}")
        self._results[part.id] = evidence
        self._tasks.pop(part.id, None)
        return evidence

    def seed(self, part: Part, evidence: ComponentEvidence) -> None:
        self._refresh_configuration()
        self._refresh_part(part)
        task = self._tasks.pop(part.id, None)
        if task is not None:
            task.cancel()
        self._results[part.id] = evidence.model_copy(deep=True)

    def add_documents(self, part_id: str, urls: list[str]) -> None:
        """Attach PDF links discovered during research; invalidates the old read."""
        known = self._extra.setdefault(part_id, [])
        new = [u for u in urls if u not in known]
        if new:
            known.extend(new)
            self._results.pop(part_id, None)
            task = self._tasks.pop(part_id, None)
            if task is not None:
                task.cancel()

    CONFIG_KEYS = (
        "REDUCTO_API_KEY", "REDUCTO_BASE_URL", "GEMINI_API_KEY", "GOOGLE_API_KEY",
        "FORGE_GEMINI_MODEL", "FORGE_DATASHEET_REVIEW_MODEL", "ANTHROPIC_API_KEY", "FORGE_CLAUDE_MODEL",
    )

    def _refresh_configuration(self) -> None:
        signature = tuple(os.getenv(k, "") for k in self.CONFIG_KEYS)
        if self._configuration != signature:
            self.clear()
            self._configuration = signature

    def _refresh_part(self, part: Part) -> None:
        signature = part.model_dump_json()
        if self._part_signatures.get(part.id) != signature:
            self._results.pop(part.id, None)
            task = self._tasks.pop(part.id, None)
            if task:
                task.cancel()
            self._part_signatures[part.id] = signature

    def prefetch(self, parts: list[Part]) -> int:
        self._refresh_configuration()
        started = 0
        for part in parts:
            self._refresh_part(part)
            if part.id in self._results or part.id in self._tasks:
                continue
            self._tasks[part.id] = asyncio.get_running_loop().create_task(self._run(part))
            started += 1
        return started

    async def get(self, part: Part) -> ComponentEvidence:
        self._refresh_configuration()
        self._refresh_part(part)
        if part.id in self._results:
            return self._results[part.id]
        task = self._tasks.get(part.id)
        if task is None:
            task = self._tasks[part.id] = asyncio.get_running_loop().create_task(self._run(part))
        return await task

    def status(self) -> dict[str, str]:
        out = {pid: "pending" for pid in self._tasks}
        out.update({pid: ev.status for pid, ev in self._results.items()})
        return out

    def clear(self) -> None:
        for task in self._tasks.values():
            task.cancel()
        self._tasks.clear()
        self._results.clear()
        self._part_signatures.clear()
        self._extra.clear()


class EvidenceBlocked(ValueError):
    """A live design cannot consume unresolved critical evidence."""


evidence_registry = EvidenceRegistry()


async def require_design_evidence(parts: list[Part]) -> None:
    if not parts:
        raise EvidenceBlocked("No selected parts to verify.")
    bundles = await asyncio.gather(*(evidence_registry.get(part) for part in parts))
    blocked = [f"{ev.part_name}: {'; '.join(ev.blocking_reasons) or 'Evidence not verified.'}"
               for ev in bundles if not ev.design_ready]
    if blocked:
        raise EvidenceBlocked("Live design blocked pending datasheet verification. " + " | ".join(blocked))


def require_cached_design_evidence(parts: list[Part]) -> None:
    """Synchronous publication guard, including legacy prototype revision routes."""
    evidence_registry._refresh_configuration()
    for part in parts:
        evidence_registry._refresh_part(part)
    if not parts or any(not (ev := evidence_registry._results.get(part.id)) or not ev.design_ready for part in parts):
        raise EvidenceBlocked("Live design requires independently verified datasheet evidence before publication.")
