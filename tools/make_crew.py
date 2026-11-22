"""Build the little engineering crew shown assembling models in the research view.

    uv run --no-project --python 3.12 --with trimesh==4.5.3 --with numpy python tools/make_crew.py

Writes forge_research/web/models/crew.glb: three chibi engineers (hard hat,
hi-vis vest, coveralls, boots, a tool each), about 1 unit tall, standing on
y=0 and facing +z. Limbs are separate nodes pivoting at the hip/shoulder so
the viewer can animate walking and hammering. Purely decorative.
"""

from pathlib import Path

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial

OUT = Path(__file__).resolve().parents[1] / "forge_research" / "web" / "models" / "crew.glb"

SKIN = (246, 205, 170)
BOOT = (40, 36, 34)
EYE = (25, 25, 30)
CHEEK = (240, 140, 140)
STEEL = (170, 176, 184)

CREW = [
    {"name": "worker_0", "hat": (250, 204, 21), "suit": (36, 74, 140), "vest": (255, 120, 30), "tool": "wrench"},
    {"name": "worker_1", "hat": (245, 245, 240), "suit": (60, 64, 72), "vest": (190, 240, 40), "tool": "hammer"},
    {"name": "worker_2", "hat": (255, 120, 30), "suit": (40, 110, 90), "vest": (250, 204, 21), "tool": "screwdriver"},
]


def paint(mesh: trimesh.Trimesh, rgb, rough=0.65) -> trimesh.Trimesh:
    mesh.visual = trimesh.visual.TextureVisuals(
        material=PBRMaterial(baseColorFactor=[*rgb, 255], metallicFactor=0.0, roughnessFactor=rough)
    )
    return mesh


def at(mesh, x=0.0, y=0.0, z=0.0, scale=None):
    if scale is not None:
        mesh.apply_scale(scale)
    mesh.apply_translation((x, y, z))
    return mesh


def capsule(radius, length):
    # trimesh capsules run along z; stand them up along y.
    m = trimesh.creation.capsule(height=length, radius=radius, count=[16, 16])
    m.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, (1, 0, 0)))
    return m


def sphere(r):
    return trimesh.creation.icosphere(subdivisions=3, radius=r)


def box(x, y, z):
    return trimesh.creation.box((x, y, z))


def cyl(r, h):
    m = trimesh.creation.cylinder(radius=r, height=h, sections=32)
    m.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, (1, 0, 0)))
    return m


def tool(kind):
    if kind == "hammer":
        return [(at(box(0.03, 0.2, 0.03), y=-0.1), (150, 100, 60)), (at(box(0.1, 0.05, 0.05), y=-0.2), STEEL)]
    if kind == "screwdriver":
        return [(at(cyl(0.025, 0.08), y=-0.04), (230, 60, 60)), (at(cyl(0.008, 0.1), y=-0.13), STEEL)]
    return [(at(box(0.025, 0.16, 0.02), y=-0.08), STEEL), (at(cyl(0.035, 0.02), y=-0.17), STEEL)]


def add(scene, parent, name, parts, pivot=(0, 0, 0)):
    """Add a node at `pivot` (in parent space) holding the given (mesh, colour) parts."""
    scene.graph.update(frame_from=parent, frame_to=name, matrix=trimesh.transformations.translation_matrix(pivot))
    for i, (mesh, rgb) in enumerate(parts):
        scene.add_geometry(paint(mesh, rgb), node_name=f"{name}_g{i}", geom_name=f"{name}_g{i}", parent_node_name=name)


def worker(scene, spec, x):
    root = spec["name"]
    scene.graph.update(frame_from="world", frame_to=root, matrix=trimesh.transformations.translation_matrix((x, 0, 0)))
    suit, vest = spec["suit"], spec["vest"]
    # Torso: coverall body, vest band with reflective stripe, belt.
    add(scene, root, f"{root}_body", [
        (at(capsule(0.15, 0.12), y=0.52, scale=(1, 1, 0.85)), suit),
        (at(cyl(0.158, 0.13), y=0.55, scale=(1, 1, 0.86)), vest),
        (at(cyl(0.161, 0.025), y=0.55, scale=(1, 1, 0.87)), (235, 235, 235)),
        (at(cyl(0.155, 0.03), y=0.43, scale=(1, 1, 0.86)), BOOT),
    ])
    # Head with face, then the hard hat on top.
    add(scene, root, f"{root}_head", [
        (at(sphere(0.2)), SKIN),
        (at(sphere(0.026), x=-0.07, y=0.0, z=0.18), EYE),
        (at(sphere(0.026), x=0.07, y=0.0, z=0.18), EYE),
        (at(sphere(0.03), x=-0.12, y=-0.05, z=0.145, scale=(1, 0.6, 0.5)), CHEEK),
        (at(sphere(0.03), x=0.12, y=-0.05, z=0.145, scale=(1, 0.6, 0.5)), CHEEK),
        (at(box(0.05, 0.012, 0.02), y=-0.07, z=0.19), (120, 60, 60)),
        (at(sphere(0.215), y=0.06, scale=(1, 0.75, 1)), spec["hat"]),
        (at(cyl(0.25, 0.02), y=0.05, z=0.03), spec["hat"]),
        (at(box(0.04, 0.05, 0.36), y=0.19), spec["hat"]),
    ], pivot=(0, 0.86, 0))
    for side, sx in (("l", -1), ("r", 1)):
        add(scene, root, f"{root}_leg_{side}", [
            (at(capsule(0.06, 0.16), y=-0.14), suit),
            (at(box(0.11, 0.07, 0.16), y=-0.31, z=0.025), BOOT),
        ], pivot=(0.075 * sx, 0.36, 0))
        arm = [(at(capsule(0.045, 0.16), y=-0.1), suit), (at(sphere(0.05), y=-0.22), SKIN)]
        if side == "r":
            arm += [(at(m, y=-0.22, z=0.04), c) for m, c in tool(spec["tool"])]
        add(scene, root, f"{root}_arm_{side}", arm, pivot=(0.19 * sx, 0.64, 0))


def main():
    scene = trimesh.Scene(base_frame="world")
    for i, spec in enumerate(CREW):
        worker(scene, spec, (i - 1) * 0.7)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(scene.export(file_type="glb"))
    print(OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
