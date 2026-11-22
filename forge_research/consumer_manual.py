"""Unreviewed consumer manual extraction; never updates the trusted catalog."""
import asyncio
import hashlib

from fastapi import APIRouter, HTTPException, Request
from .providers.reducto import extract, ReductoError

router = APIRouter(prefix="/api/consumer-repair")
FIELDS = ("manufacturer", "model", "part_numbers", "operating_voltage", "operating_current", "dimensions", "pin_assignments", "safety_installation_warnings")
SCHEMA = {"type": "object", "properties": {name: {"type": ["string", "null"]} for name in FIELDS}, "required": list(FIELDS)}


@router.post("/manual")
async def manual(request: Request):
    if request.headers.get("content-type", "").split(";")[0] != "application/pdf":
        raise HTTPException(415, "Upload raw application/pdf")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 10 * 1024 * 1024:
            raise HTTPException(413, "PDF exceeds 10 MiB")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(422, "Invalid PDF signature")
    try:
        result = await asyncio.wait_for(extract(bytes(data), filename="manual.pdf", schema=SCHEMA,
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
    if any(value is not None and not isinstance(value, str) for name, value in payload.items() if name in FIELDS):
        raise HTTPException(502, "Reducto returned invalid field types")
    facts = {name: {"value": payload.get(name), "verification": "unreviewed",
                    "references": result.get("citations", [])} for name in FIELDS}
    return {"provider": "reducto", "mode": "live", "verification": "unreviewed",
            "source": {"sha256": hashlib.sha256(data).hexdigest(), "filename": "manual.pdf"},
            "facts": facts, "extraction": result, "catalog_updated": False,
            "warning": "Provider output is unreviewed evidence; missing citations or ambiguous values cannot establish engineering facts."}
