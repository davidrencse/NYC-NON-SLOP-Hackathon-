"""Unreviewed consumer manual extraction; never updates the trusted catalog."""
import asyncio
import hashlib
import copy
import json
import re

from fastapi import APIRouter, HTTPException, Request
from .providers.reducto import extract, ReductoError

router = APIRouter(prefix="/api/consumer-repair")
FIELDS = ("manufacturer", "model", "part_numbers", "operating_voltage", "operating_current", "dimensions", "pin_assignments", "safety_installation_warnings")
FACT = {"type": "object", "properties": {"value": {"type": ["string", "null"]}, "references": {"type": "array", "items": {"type": "object", "properties": {"page": {"type": ["integer", "null"]}, "chunk_id": {"type": ["string", "null"]}, "quote": {"type": ["string", "null"]}}}}}}
SCHEMA = {"type": "object", "properties": {name: FACT for name in FIELDS}, "required": list(FIELDS)}
CACHE: dict[str, dict] = {}


@router.post("/manual")
async def manual(request: Request):
    if request.headers.get("content-type", "").split(";")[0] != "application/pdf":
        raise HTTPException(415, "Upload raw application/pdf")
    data = bytearray()
    try:
        async with asyncio.timeout(10):
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > 10 * 1024 * 1024:
                    raise HTTPException(413, "PDF exceeds 10 MiB")
    except TimeoutError as error:
        raise HTTPException(408, "Upload exceeded 10 seconds") from error
    if not data.startswith(b"%PDF-"):
        raise HTTPException(422, "Invalid PDF signature")
    filename = request.headers.get("x-filename", "manual.pdf")
    if not re.fullmatch(r"[\w .-]{1,100}\.pdf", filename, re.IGNORECASE):
        raise HTTPException(422, "x-filename must be a plain PDF filename")
    digest = hashlib.sha256(data).hexdigest()
    if digest in CACHE:
        cached = copy.deepcopy(CACHE[digest])
        cached["source"]["filename"] = filename
        cached["cache_hit"] = True
        return cached
    try:
        result = await asyncio.wait_for(extract(bytes(data), filename=filename, schema=SCHEMA,
            system_prompt="Extract only explicitly supported source facts, with citations and page/chunk references. Unknown or ambiguous fields must be null. Do not infer specifications."), timeout=45)
    except TimeoutError as error:
        raise HTTPException(504, "Reducto exceeded 45 seconds") from error
    except ReductoError as error:
        raise HTTPException(503, str(error)) from error
    except (ValueError, TypeError, AttributeError) as error:
        raise HTTPException(502, "Malformed Reducto response") from error
    if not isinstance(result, dict):
        raise HTTPException(502, "Invalid Reducto response")
    payload = result.get("result")
    if isinstance(payload, list) and len(payload) == 1:
        payload = payload[0]
    if not isinstance(payload, dict):
        raise HTTPException(502, "Reducto extraction result must be an object")
    facts = normalize(payload)
    if len(json.dumps(result)) > 2_000_000:
        raise HTTPException(502, "Reducto output exceeds storage limit")
    response = {"provider": "reducto", "mode": "live", "verification": "unreviewed",
            "source": {"sha256": digest, "filename": filename}, "cache_hit": False,
            "facts": facts, "extraction": result, "catalog_updated": False,
            "warning": "Provider output is unreviewed evidence; missing citations or ambiguous values cannot establish engineering facts."}
    if len(CACHE) >= 8:
        del CACHE[next(iter(CACHE))]
    CACHE[digest] = copy.deepcopy(response)
    return response


def normalize(payload):
    facts = {}
    for name in FIELDS:
        raw = payload.get(name)
        value = raw.get("value") if isinstance(raw, dict) else raw
        refs = raw.get("references", []) if isinstance(raw, dict) else []
        if value is not None and not isinstance(value, str):
            raise HTTPException(502, "Reducto returned invalid field types")
        if not isinstance(refs, list) or len(refs) > 100:
            raise HTTPException(502, "Invalid fact references")
        for ref in refs:
            if not isinstance(ref, dict) or (ref.get("page") is not None and (type(ref["page"]) is not int or ref["page"] < 1)):
                raise HTTPException(502, "Invalid page reference")
            if any(ref.get(key) is not None and not isinstance(ref[key], str) for key in ("chunk_id", "quote")):
                raise HTTPException(502, "Invalid chunk reference")
        facts[name] = {"value": value, "verification": "unreviewed", "references": refs,
                       "reference_status": "provider_claimed_unverified" if refs else "unsupported_references"}
    return facts
