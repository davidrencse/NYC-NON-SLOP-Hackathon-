"""AI CAD: Claude writes CadQuery code for a product body, sees a render, revises.

Flow (runs inside the Modal worker, CPU only, no Blender):
  1. Claude writes ``build()`` in CadQuery, returning named, coloured parts.
  2. The code runs in a separate Python process with a timeout; parts come back
     as BREP files. A crash or timeout is sent back to Claude to fix.
  3. The parts are rendered to a PNG from two angles and shown to Claude, which
     criticises the look and returns improved code (``rounds`` times).

Code is written Z-up (CadQuery's natural frame); product.py rotates it to the
studio's Y-up frame. Units are millimetres.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

MATS = ("metal", "plastic", "rubber", "carbon", "clear", "glass", "fabric", "wood")

GUIDE = """You are a senior industrial designer and CadQuery expert. Write CadQuery (cadquery 2.8) Python that models the
physical body of the product as a premium, realistic, recognisable consumer product.

Write exactly one function:

def build():
    parts = []
    ...
    parts.append(("Top case", shape, "metal", "#c9ccd1"))
    return parts

Each part is (name, cq.Workplane or cq.Shape, material, "#rrggbb" colour). Materials: metal, plastic, rubber, carbon,
clear, glass, fabric, wood. `cq` and `math` are already imported; do not import anything else, read files or print.

Frame: millimetres, Z is up, the product rests on the ground plane z = 0 and is centred on x = 0, y = 0.
Front of the product (the user side) faces -Y.

Quality bar - this is what separates a good model from a bad one:
- Real proportions and real dimensions of the actual product category.
- Every visible element the product is known for is its own solid. Repeated elements (keys, buttons, vents, feet,
  ribs, grille holes, LEDs) are modelled individually with loops, rarray or pushPoints, never as one long bar.
- Shells, not blocks: use .shell(), .cut(), .hole(), .cboreHole(), chamfers and fillets (try/except around fillets
  so a failed fillet never breaks the build; use radii smaller than half the thinnest wall).
- Rounded edges everywhere a manufactured part has them. Draft, tapers, sculpted profiles with .loft() or
  polyline/spline sketches extruded where it helps the look.
- A considered colour palette (2-4 main colours plus accents), like a real product photo.
- 10 to 60 parts. Keep it fast: no more than ~300 solids in total, no huge boolean chains in tight loops
  (cut arrays with a single pushPoints/rarray operation instead).

The product's electronics are listed with their positions (already rotated to this Z-up frame). They already have
their own models: leave room for them and do not model them, but do model the parts the user sees and touches
(keycaps, knobs, buttons, screens bezels, lenses, wheels, straps...)."""

ANSWER = """

Answer format, nothing else:
# Name: <product name>
# Notes: <one line on the design decisions>
```python
def build():
    ...
```"""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "name": {"type": "STRING"},
        "notes": {"type": "STRING"},
        "code": {"type": "STRING"},
    },
    "required": ["name", "code"],
}

RUNNER = r'''
import json, math, sys, traceback
import cadquery as cq
out = sys.argv[2]
src = open(sys.argv[1]).read()
ns = {"cq": cq, "math": math, "__name__": "forge_body"}
try:
    exec(compile(src, "body.py", "exec"), ns)
    parts = ns["build"]()
    manifest = []
    for i, item in enumerate(parts):
        name, shape, mat, color = (list(item) + [None, None, None, None])[:4]
        if isinstance(shape, cq.Workplane):
            vals = [v for v in shape.vals() if isinstance(v, cq.Shape)]
            if not vals:
                continue
            shape = vals[0] if len(vals) == 1 else cq.Compound.makeCompound(vals)
        if not isinstance(shape, cq.Shape) or not shape.isValid():
            continue
        bb = shape.BoundingBox()
        if max(bb.xlen, bb.ylen, bb.zlen) <= 0:
            continue
        path = f"{out}/{i}.brep"
        shape.exportBrep(path)
        manifest.append({"name": str(name)[:60], "file": path, "mat": mat, "color": color})
    if not manifest:
        raise ValueError("build() returned no valid solids")
    json.dump({"ok": True, "parts": manifest}, open(f"{out}/manifest.json", "w"))
except BaseException:
    json.dump({"ok": False, "error": traceback.format_exc()[-2500:]}, open(f"{out}/manifest.json", "w"))
'''


def _parse(text: str) -> dict:
    """Answer format: optional '# Name: ...' and '# Notes: ...' lines, then a ```python block."""
    import re

    block = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.S)
    code = block.group(1) if block else text
    name = re.search(r"^#\s*Name:\s*(.+)$", text, re.M)
    notes = re.search(r"^#\s*Notes:\s*(.+)$", text, re.M)
    return {"code": code.strip(), "name": name.group(1).strip() if name else "", "notes": notes.group(1).strip() if notes else ""}


def _ask(api_key: str, model: str, content: list[dict], *, timeout: float = 600) -> tuple[dict, dict]:
    """Streamed Claude call: a long code answer keeps the connection alive chunk by chunk."""
    import httpx

    from modal_workers import claude

    last = None
    for _ in range(2):
        try:
            text, usage = claude.stream(api_key, model, GUIDE + ANSWER, content, timeout=timeout)
            answer = _parse(text)
            if "def build" not in answer["code"]:
                raise RuntimeError("Claude answer had no build() function.")
            return answer, usage
        except (httpx.TransportError, RuntimeError) as error:
            last = error
    raise RuntimeError(f"Claude code request failed: {last}")


def run_code(code: str, *, timeout: float = 120) -> dict[str, Any]:
    """Execute generated code in a child process. Returns {ok, parts:[{name,shape,mat,color}]} or {ok:False,error}."""
    import cadquery as cq

    work = Path(tempfile.mkdtemp(prefix="forge-body-"))
    (work / "body.py").write_text(code)
    (work / "runner.py").write_text(RUNNER)
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(work), "PYTHONPATH": ""}
    try:
        subprocess.run(
            [sys.executable, "-I", str(work / "runner.py"), str(work / "body.py"), str(work)],
            cwd=work, env=env, timeout=timeout, capture_output=True,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"build() took longer than {timeout:.0f} s. Use fewer booleans and simpler geometry."}
    manifest_path = work / "manifest.json"
    if not manifest_path.exists():
        return {"ok": False, "error": "The code crashed the CAD kernel. Simplify the geometry."}
    manifest = json.loads(manifest_path.read_text())
    if not manifest["ok"]:
        return manifest
    parts = []
    for p in manifest["parts"]:
        shape = cq.Shape.importBrep(p["file"])
        parts.append({"name": p["name"], "shape": shape, "mat": p["mat"] if p["mat"] in MATS else "plastic", "color": p["color"]})
    return {"ok": True, "parts": parts}


def device_text(system: dict[str, Any]) -> str:
    """Device placements converted from the studio's Y-up frame to the code's Z-up frame."""
    lines = [f"PCB: flat, centred at x=0 y=0, top at z={system.get('pcbHeight', 12)} mm (about 64 x 48 mm)."]
    for d in system.get("devices") or []:
        lines.append(f"- {d.get('label')}: x={d.get('x')}, y={-float(d.get('z', 0)):g}, z={d.get('y')}")
    return "\n".join(lines)


def design(
    brief: str,
    system: dict[str, Any],
    *,
    api_key: str,
    model: str,
    rounds: int = 1,
    render=None,
    log=print,
) -> dict[str, Any]:
    """Write, run, look at and revise a CadQuery body. ``render(parts) -> png bytes``."""
    started = time.monotonic()
    usage = {"prompt": 0, "output": 0}
    history: list[dict] = []
    ask = [{"type": "text", "text": f"Product brief: {brief.strip()[:2000]}\n\nElectronics inside:\n{device_text(system)}"}]
    best = None
    attempts = 0
    while attempts < 3 + rounds * 2:
        attempts += 1
        try:
            answer, used = _ask(api_key, model, ask)
        except RuntimeError:
            if best is not None:
                break  # keep the working design we already have
            raise
        usage = {k: usage[k] + used[k] for k in usage}
        code = answer.get("code", "")
        t = time.monotonic()
        result = run_code(code)
        run_s = round(time.monotonic() - t, 1)
        step = {"attempt": attempts, "ok": result["ok"], "run_s": run_s, "notes": (answer.get("notes") or "")[:300]}
        if not result["ok"]:
            step["error"] = result["error"][-600:]
            history.append(step)
            log(f"  attempt {attempts}: code failed ({run_s}s): {result['error'].strip().splitlines()[-1][:160]}")
            ask = [ask[0], {"type": "text", "text": f"Your previous code:\n```python\n{code}\n```\nIt failed:\n{result['error']}\nFix it and return the full corrected code."}]
            continue
        step["parts"] = len(result["parts"])
        history.append(step)
        best = {"name": answer.get("name") or "Product", "code": code, "parts": result["parts"]}
        log(f"  attempt {attempts}: {len(result['parts'])} parts built in {run_s}s")
        reviews_done = sum(1 for h in history if h.get("reviewed"))
        if render is None or reviews_done >= rounds:
            break
        png = render(result["parts"])
        step["reviewed"] = True
        ask = [
            ask[0],
            {"type": "text", "text": f"Your current code:\n```python\n{code}\n```\nThe image shows it rendered (front-left and rear-right views). "
                     "Critique it like a product designer: what makes it look fake, blocky, wrongly proportioned or "
                     "unrecognisable, what details are missing? Then return the full improved code that fixes all of it. "
                     "Keep what already works."},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(png).decode()}},
        ]
    if best is None:
        raise RuntimeError("Claude could not produce working CadQuery code: " + (history[-1].get("error", "")[-300:] if history else ""))
    return {**best, "model": model, "ms": int((time.monotonic() - started) * 1000), "usage": usage, "history": history}
