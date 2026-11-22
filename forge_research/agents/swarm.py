"""Agent swarm: parallel engineering specialists orchestrated on the Gemini API.

FORGE fans the brief out to every specialist at once (``asyncio.gather``, no
concurrency cap), streams each one's text back to the research screen, then a
lead call merges the briefs. Events go out as ``{"type": "swarm", ...}``.

The swarm is advisory. The ADK catalog workflow stays the canonical, validated
path; swarm briefs are attached to the report and never override catalog
checks. Without a Gemini key, or with ``FORGE_SWARM=off``, a labeled offline
fixture swarm replays so the screen still shows every step.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from collections.abc import Awaitable, Callable
from typing import Literal

from pydantic import BaseModel, Field

from forge_research.providers.usage import record_usage
from forge_research.providers.defaults import configured_gemini_model

TIMEOUT_S = float(os.getenv("FORGE_SWARM_TIMEOUT", "120"))

Emit = Callable[[dict], Awaitable[None] | None]


class SwarmRole(BaseModel):
    id: str
    name: str
    focus: str


ROLES: list[SwarmRole] = [
    SwarmRole(id="requirements", name="Requirements analyst", focus="Turn the brief into measurable requirements, constraints and open questions."),
    SwarmRole(id="sourcing", name="Sourcing scout", focus="Propose candidate controllers and sensors with manufacturer part numbers and why."),
    SwarmRole(id="electrical", name="Electrical engineer", focus="Check supply rails, logic levels, ADC inputs, current budget and battery safety."),
    SwarmRole(id="mechanical", name="Mechanical engineer", focus="Board envelope, enclosure, mounting, connector cutouts and wearability."),
]

SYNTHESIS_PROMPT = (
    "You are the FORGE lead engineer. Merge the specialist briefs below into one "
    "design direction for the product. Reply in under 180 words with: decision, "
    "top 3 risks, and the next verification steps. Do not invent part prices or "
    "test results; mark anything unverified as unverified."
)


class SwarmAgentResult(BaseModel):
    role: str
    name: str
    status: Literal["completed", "failed", "skipped"]
    summary: str = ""
    duration_s: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    api_calls: int | None = None


class SwarmReport(BaseModel):
    engine: Literal["gemini", "offline"]
    model: str | None = None
    status: Literal["completed", "failed", "skipped"]
    agents: list[SwarmAgentResult] = Field(default_factory=list)
    synthesis: str = ""
    duration_s: float = 0.0
    error: str | None = None
    advisory: str = (
        "Advisory only. Specialist briefs inform the run; catalog checks and "
        "Lean verification decide what is accepted."
    )


def swarm_model() -> str:
    return (
        os.getenv("FORGE_SWARM_MODEL", "").strip()
        or configured_gemini_model()
    )


def gemini_key() -> str | None:
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = os.getenv(name, "").strip()
        if value:
            return value
    return None


def swarm_available() -> bool:
    return os.getenv("FORGE_SWARM", "on").lower() not in {"off", "0", "false"} and gemini_key() is not None


def build_tasks(brief: str) -> list[dict]:
    tasks = []
    for role in ROLES:
        tasks.append(
            {
                "role": role.id,
                "goal": (
                    f"You are the {role.name} on a hardware design team. {role.focus} "
                    "Answer in at most 120 words as plain bullet points. No preamble."
                ),
                "context": f"Product brief from the user:\n{brief}",
            }
        )
    return tasks


async def _send(emit: Emit | None, event: dict) -> None:
    if emit is None:
        return
    result = emit({"type": "swarm", **event})
    if asyncio.iscoroutine(result):
        await result


def _role_at(index: object) -> SwarmRole | None:
    return ROLES[index] if isinstance(index, int) and 0 <= index < len(ROLES) else None


async def run_swarm(brief: str, *, live: bool, emit: Emit | None = None) -> SwarmReport:
    """Run the swarm, streaming events; never raises."""
    if live and swarm_available():
        return await _run_live(brief, emit)
    return await _run_offline(brief, emit, reason=None if not live else "No Gemini key for the swarm; replaying offline swarm.")


async def _run_offline(brief: str, emit: Emit | None, *, reason: str | None) -> SwarmReport:
    started = time.monotonic()
    await _send(emit, {"event": "start", "engine": "offline", "model": None, "agents": [r.model_dump() for r in ROLES], "note": reason})
    canned = {
        "requirements": "- Wrist-worn EMG gesture controller\n- BLE link, rechargeable cell\n- Budget ceiling from brief\n- Open: gesture count, battery life target",
        "sourcing": "- Controller: ESP32 DevKitC (BLE, 12-bit ADC)\n- Sensor: MyoWare 2.0 EMG\n- Alternative: Arduino Uno R3 (no BLE, rejected for wireless)",
        "electrical": "- Run sensor from 3.3 V rail; ADC max 3.3 V\n- Check sensor current against rail budget\n- Battery protection unverified",
        "mechanical": "- Board envelope ~55 × 28 mm\n- Strap slots on ±y; USB cutout on +x\n- 2 mm wall, 1.5 mm clearance",
    }
    agents: list[SwarmAgentResult] = []
    for index, role in enumerate(ROLES):
        await _send(emit, {"event": "agent", "index": index, "role": role.id, "status": "running"})
    for index, role in enumerate(ROLES):
        await asyncio.sleep(0.15)
        result = SwarmAgentResult(role=role.id, name=role.name, status="completed", summary=canned[role.id], duration_s=0.0)
        agents.append(result)
        await _send(emit, {"event": "agent", "index": index, "role": role.id, "status": "completed", "result": result.model_dump()})
    await _send(emit, {"event": "synthesis", "status": "running"})
    synthesis = "Offline replay: ESP32 + MyoWare 2.0 on a 3.3 V rail, printed enclosure. Risks: battery safety, EMG noise, strap fit. All unverified until catalog and Lean checks run."
    report = SwarmReport(engine="offline", status="completed", agents=agents, synthesis=synthesis, duration_s=round(time.monotonic() - started, 2))
    await _send(emit, {"event": "synthesis", "status": "completed", "text": synthesis})
    await _send(emit, {"event": "complete", "report": report.model_dump()})
    return report


async def _run_live(brief: str, emit: Emit | None) -> SwarmReport:
    """Every specialist streams from Gemini at once; no concurrency cap."""
    from google import genai
    from google.genai import types

    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "false"
    model = swarm_model()
    started = time.monotonic()
    client = genai.Client(api_key=gemini_key())
    await _send(emit, {"event": "start", "engine": "gemini", "model": model, "agents": [r.model_dump() for r in ROLES]})

    async def specialist(index: int, task: dict) -> SwarmAgentResult:
        role = ROLES[index]
        t0 = time.monotonic()
        await _send(emit, {"event": "agent", "index": index, "role": role.id, "status": "running"})
        text, meta = "", None
        try:
            stream = await client.aio.models.generate_content_stream(
                model=model,
                contents=task["context"],
                config=types.GenerateContentConfig(system_instruction=task["goal"], temperature=0.4),
            )
            last = 0.0
            async for chunk in stream:
                text += chunk.text or ""
                meta = chunk.usage_metadata or meta
                if time.monotonic() - last > 0.25:
                    last = time.monotonic()
                    await _send(emit, {"event": "agent", "index": index, "role": role.id, "status": "running", "text": text[-240:]})
            status = "completed" if text.strip() else "failed"
            summary = text.strip()[:2000] or "Gemini returned no text."
        except Exception as exc:  # noqa: BLE001
            status, summary = "failed", f"{type(exc).__name__}: {exc}"[:300]
        duration = round(time.monotonic() - t0, 2)
        result = SwarmAgentResult(
            role=role.id, name=role.name, status=status, summary=summary, duration_s=duration,
            input_tokens=getattr(meta, "prompt_token_count", None),
            output_tokens=getattr(meta, "candidates_token_count", None),
            api_calls=1,
        )
        record_usage(
            "gemini", f"swarm.{role.id}", model=model, ok=status == "completed", duration_ms=int(duration * 1000),
            prompt_tokens=result.input_tokens, output_tokens=result.output_tokens,
        )
        await _send(emit, {"event": "agent", "index": index, "role": role.id, "status": status, "result": result.model_dump()})
        return result

    try:
        agents = await asyncio.wait_for(
            asyncio.gather(*(specialist(i, t) for i, t in enumerate(build_tasks(brief)))), timeout=TIMEOUT_S
        )
    except TimeoutError:
        return await _fail(emit, model, started, f"Swarm timed out after {TIMEOUT_S:.0f} s.")

    briefs = "\n\n".join(f"## {a.name}\n{a.summary}" for a in agents if a.status == "completed")
    synthesis, error = "", None
    if not briefs:
        error = "Every specialist failed; no synthesis."
    else:
        await _send(emit, {"event": "synthesis", "status": "running"})
        try:
            response = await asyncio.wait_for(
                client.aio.models.generate_content(
                    model=model, contents=f"Product brief:\n{brief}\n\n{briefs}",
                    config=types.GenerateContentConfig(system_instruction=SYNTHESIS_PROMPT, temperature=0.3),
                ),
                timeout=60,
            )
            synthesis = (response.text or "").strip()[:4000]
            await _send(emit, {"event": "synthesis", "status": "completed", "text": synthesis})
        except Exception as exc:  # noqa: BLE001
            error = f"Synthesis failed: {type(exc).__name__}: {exc}"[:300]
            await _send(emit, {"event": "synthesis", "status": "failed"})
    ok = not error
    report = SwarmReport(
        engine="gemini", model=model, status="completed" if ok else "failed",
        agents=list(agents), synthesis=synthesis, duration_s=round(time.monotonic() - started, 2), error=error,
    )
    await _send(emit, {"event": "complete", "report": report.model_dump()})
    return report


async def _fail(emit: Emit | None, model: str, started: float, message: str) -> SwarmReport:
    report = SwarmReport(
        engine="gemini", model=model, status="failed", error=message,
        agents=[SwarmAgentResult(role=r.id, name=r.name, status="failed") for r in ROLES],
        duration_s=round(time.monotonic() - started, 2),
    )
    await _send(emit, {"event": "complete", "report": report.model_dump()})
    return report


if __name__ == "__main__":  # manual smoke: python -m forge_research.agents.swarm "brief"
    async def _print(event: dict) -> None:
        print(json.dumps(event)[:300], flush=True)

    brief = " ".join(sys.argv[1:]) or "EMG wristband gesture controller with BLE under $100"
    out = asyncio.run(run_swarm(brief, live=True, emit=_print))
    print(out.model_dump_json(indent=2))
