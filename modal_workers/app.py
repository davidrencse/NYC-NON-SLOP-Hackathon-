"""FORGE CAD workers on Modal. CPU only, no Blender.

Deploy:
    pip install modal && modal setup
    modal secret create forge-cad FORGE_MODAL_TOKEN=<random string> \
        [R2_ENDPOINT_URL=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... R2_PUBLIC_BASE_URL=...]
    modal deploy modal_workers/app.py

Then point the studio at the printed endpoint URL:
    FORGE_MODAL_CAD_URL=https://<workspace>--forge-cad-generate-enclosure.modal.run
    FORGE_MODAL_TOKEN=<same random string>

Each request is keyed by a hash of the spec and generator version. Results live
on the ``forge-cad-cache`` Volume, so an identical request returns the cached
files without rebuilding. When R2 credentials are present the finished GLB,
STEP and STL are also published to object storage and their URLs returned.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parents[1]

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("libgl1", "libxrender1")
    .pip_install(
        "cadquery==2.8.0", "trimesh==5.2.2", "scipy==1.18.1", "matplotlib==3.10.7", "httpx==0.28.1",
        "fastapi[standard]==0.115.12", "boto3==1.35.99",
    )
    .add_local_file(ROOT / "tools" / "step_to_glb.py", "/root/step_to_glb.py")
    .add_local_dir(ROOT / "assets" / "models" / "glb", "/root/device_glb")
    .add_local_python_source("modal_workers")
)

app = modal.App("forge-cad", image=image)
cache = modal.Volume.from_name("forge-cad-cache", create_if_missing=True)
CACHE = Path("/cache")
FILES = ("enclosure.glb", "enclosure.step", "enclosure.stl")


def _publish_r2(key_prefix: str, folder: Path) -> dict[str, str]:
    if not all(os.environ.get(k) for k in ("R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")):
        return {}
    import boto3

    client = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )
    types = {"glb": "model/gltf-binary", "step": "model/step", "stl": "model/stl"}
    base = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")
    urls: dict[str, str] = {}
    for name in FILES:
        ext = name.rsplit(".", 1)[1]
        key = f"{key_prefix}/{name}"
        client.upload_file(
            str(folder / name), os.environ["R2_BUCKET"], key,
            ExtraArgs={"ContentType": types[ext], "CacheControl": "public, max-age=31536000, immutable"},
        )
        if base:
            urls[ext] = f"{base}/{key}"
    return urls


def run_enclosure_job(spec: dict) -> dict:
    """Generate (or reuse) one enclosure. Shared by the web endpoint and tests."""
    import json
    import sys

    sys.path.insert(0, "/root")
    import step_to_glb  # type: ignore[import-not-found]

    from modal_workers import enclosure

    key = enclosure.spec_hash(spec)
    folder = CACHE / "enclosures" / key
    meta_path = folder / "meta.json"
    hit = meta_path.exists() and all((folder / name).exists() for name in FILES)
    if not hit:
        folder.mkdir(parents=True, exist_ok=True)
        result = enclosure.generate(spec, str(folder))
        report = step_to_glb.convert_step(
            folder / "enclosure.step", folder / "enclosure.glb",
            linear_mm=0.1, angular_rad=0.35, copyright_text=None, license_notice=None,
            source_url=None,
        )
        result["glb"] = {"triangles": report["triangles"], "size_mm": report["size_mm"], "nodes": report["nodes"]}
        result["published"] = _publish_r2(f"enclosures/{key}", folder)
        result.pop("files", None)
        meta_path.write_text(json.dumps(result))
        cache.commit()
    else:
        result = json.loads(meta_path.read_text())
    return {
        "spec_hash": key,
        "cache_hit": hit,
        **result,
        "files": {
            name.rsplit(".", 1)[1]: base64.b64encode((folder / name).read_bytes()).decode()
            for name in FILES
        },
    }


@app.function(
    volumes={str(CACHE): cache},
    secrets=[modal.Secret.from_name("forge-cad")],
    cpu=2.0,
    memory=2048,
    timeout=300,
    max_containers=4,
)
@modal.fastapi_endpoint(method="POST", docs=False)
def generate_enclosure(body: dict):
    from fastapi import HTTPException  # available inside the container image

    expected = os.environ.get("FORGE_MODAL_TOKEN")
    token = (body.pop("_token", None) or "").strip()
    if not expected or token != expected:
        raise HTTPException(401, "Invalid FORGE token.")
    spec = body.get("spec")
    if not isinstance(spec, dict) or "board" not in spec:
        raise HTTPException(422, "Body must contain spec.board.")
    return run_enclosure_job(spec)


def run_product_job(
    system: dict, board: dict | None = None, *, brief: str = "", api_key: str = "", model: str = "", rounds: int = 1,
) -> dict:
    """Design (Claude writes CadQuery, sees a render, revises) and build one product.

    Falls back to the primitive body designer if no working code comes back.
    Cached by the final design, so a repeat of the same design is not rebuilt.
    """
    import json
    import time

    from modal_workers import codegen, designer, preview, product

    design, body = None, None
    if brief and api_key:
        try:
            design = codegen.design(
                brief, system, api_key=api_key, model=model or designer.default_model(),
                rounds=rounds, render=preview.render_parts,
            )
            body = design.pop("parts")
            system = {**system, "form": "none", "structure": [], "name": design["name"]}
        except RuntimeError as error:
            print("codegen failed, using primitive designer:", error)
            design = designer.design_body(brief, system, api_key=api_key, model=model or designer.default_model(), cache_dir=CACHE / "designs")
            if not design["parts"]:
                raise ValueError("Claude returned no valid body parts.") from error
            system = {**system, "form": "none", "structure": design["parts"]}
    devices = product.load_local_devices(system, Path("/root/device_glb"), flat=True)
    key = product.spec_hash({"system": system, "board": board, "code": (design or {}).get("code")}, list(devices))
    folder = CACHE / "products" / key
    glb_path, meta_path = folder / "product.glb", folder / "meta.json"
    hit = glb_path.exists() and meta_path.exists()
    if hit:
        meta = json.loads(meta_path.read_text())
    else:
        started = time.monotonic()
        built = product.build_product(system, devices, board=board, body=body)
        folder.mkdir(parents=True, exist_ok=True)
        glb_path.write_bytes(built.pop("glb"))
        meta = {**built, "build_s": round(time.monotonic() - started, 2)}
        meta_path.write_text(json.dumps(meta))
        (folder / "system.json").write_text(json.dumps(system))
        if design and design.get("code"):
            (folder / "body.py").write_text(design["code"])
            (folder / "preview.png").write_bytes(preview.render_parts(body))
        cache.commit()
    return {
        "spec_hash": key,
        "cache_hit": hit,
        **meta,
        "design": design and {k: design.get(k) for k in ("name", "model", "ms", "usage", "history", "code")},
        "preview": base64.b64encode((folder / "preview.png").read_bytes()).decode() if (folder / "preview.png").exists() else None,
        "system": system,
        "bytes": glb_path.stat().st_size,
        "glb": base64.b64encode(glb_path.read_bytes()).decode(),
    }


@app.function(
    volumes={str(CACHE): cache},
    secrets=[modal.Secret.from_name("forge-cad")],
    cpu=2.0,
    memory=4096,
    timeout=1200,
    max_containers=4,
)
@modal.fastapi_endpoint(method="POST", docs=False)
def build_product(body: dict):
    """POST {system, brief?, anthropic_key?, model?, board?, _token}. With a brief and
    key, Claude designs a new body first; the key is used for this call only."""
    from fastapi import HTTPException

    expected = os.environ.get("FORGE_MODAL_TOKEN")
    token = (body.pop("_token", None) or "").strip()
    if not expected or token != expected:
        raise HTTPException(401, "Invalid FORGE token.")
    system = body.get("system")
    if not isinstance(system, dict) or not isinstance(system.get("devices"), list):
        raise HTTPException(422, "Body must contain system.devices.")
    try:
        return run_product_job(
            system, body.get("board"),
            brief=str(body.get("brief") or ""), api_key=str(body.get("anthropic_key") or body.get("api_key") or ""), model=str(body.get("model") or ""),
        )
    except (ValueError, RuntimeError) as error:
        raise HTTPException(502, str(error)) from error


@app.function(volumes={str(CACHE): cache}, cpu=2.0, memory=4096, timeout=1200)
def remote_product(system: dict, brief: str, api_key: str, model: str = "", rounds: int = 1) -> dict:
    return run_product_job(system, brief=brief, api_key=api_key, model=model, rounds=rounds)


@app.local_entrypoint()
def generate(drafts: str) -> None:
    """`ANTHROPIC_API_KEY=... modal run modal_workers/app.py::generate --drafts drafts.json`

    drafts.json maps each new brief to {"system": SystemDesign}. Every brief is
    designed by Claude and built in parallel on Modal; GLBs land next to the file.
    """
    import json
    import re

    key = os.environ["ANTHROPIC_API_KEY"]
    data = json.loads(Path(drafts).read_text())
    briefs = list(data)
    out = Path(drafts).parent
    args = [(data[b]["system"], b, key) for b in briefs]
    for brief, result in zip(briefs, remote_product.starmap(args, return_exceptions=True)):
        if isinstance(result, Exception):
            print("FAILED", brief[:60], result)
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", brief.lower())[:40].strip("-")
        (out / f"modal-{slug}.glb").write_bytes(base64.b64decode(result.pop("glb")))
        (out / f"modal-{slug}.json").write_text(json.dumps(result["system"]))
        if result.get("preview"):
            (out / f"modal-{slug}-preview.png").write_bytes(base64.b64decode(result.pop("preview")))
        if (result.get("design") or {}).get("code"):
            (out / f"modal-{slug}-body.py").write_text(result["design"].pop("code"))
        print(slug, {k: result[k] for k in ("spec_hash", "cache_hit", "build_s", "bytes", "bounds_mm", "design")})
        print("   ", [f for f in result["findings"] if f["status"] != "pass"][:4])


@app.local_entrypoint()
def smoke() -> None:
    """`modal run modal_workers/app.py` builds a sample enclosure remotely."""
    sample = {
        "id": "smoke",
        "board": {"length": 48.26, "width": 27.94, "thickness": 1.6, "component_height": 8.0},
        "cutouts": [{"id": "usb", "face": "-x", "width": 12.0, "height": 7.0}],
    }
    result = remote_job.remote(sample)
    print({k: v for k, v in result.items() if k != "files"})


@app.function(volumes={str(CACHE): cache}, cpu=2.0, memory=2048, timeout=300)
def remote_job(spec: dict) -> dict:
    return run_enclosure_job(spec)
