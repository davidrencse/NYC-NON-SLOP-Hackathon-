"""Headless preview render (numpy z-buffer, CPU) so Claude can look at its own design."""

from __future__ import annotations

import io
import math
from typing import Any


def _look(eye, target):
    import numpy as np

    f = target - eye
    f /= np.linalg.norm(f)
    r = np.cross(f, [0.0, 0.0, 1.0])
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    return r, u, f


def _raster(tri, col, w, h, eye, target, fov=30.0):
    """Perspective z-buffer rasterization. tri: (n,3,3) world, col: (n,3) 0-1."""
    import numpy as np

    r, u, f = _look(eye, target)
    rel = tri - eye
    cam = np.stack([rel @ r, rel @ u, rel @ f], axis=-1)  # x right, y up, z depth
    focal = (h / 2) / math.tan(math.radians(fov / 2))
    z = np.maximum(cam[..., 2], 1e-3)
    sx = w / 2 + focal * cam[..., 0] / z
    sy = h / 2 - focal * cam[..., 1] / z
    img = np.ones((h, w, 3)) * np.array([0.925, 0.925, 0.91])
    depth = np.full((h, w), np.inf)
    # Draw far to near is not needed with a z-buffer; skip degenerate/back faces.
    area = (sx[:, 1] - sx[:, 0]) * (sy[:, 2] - sy[:, 0]) - (sx[:, 2] - sx[:, 0]) * (sy[:, 1] - sy[:, 0])
    for i in np.nonzero(np.abs(area) > 1e-6)[0]:
        x0, x1, x2 = sx[i]
        y0, y1, y2 = sy[i]
        minx, maxx = max(int(min(x0, x1, x2)), 0), min(int(max(x0, x1, x2)) + 1, w)
        miny, maxy = max(int(min(y0, y1, y2)), 0), min(int(max(y0, y1, y2)) + 1, h)
        if minx >= maxx or miny >= maxy:
            continue
        px, py = np.meshgrid(np.arange(minx, maxx) + 0.5, np.arange(miny, maxy) + 0.5)
        a = area[i]
        w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / a
        w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / a
        w2 = 1 - w0 - w1
        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if not inside.any():
            continue
        d = w0 * z[i, 0] + w1 * z[i, 1] + w2 * z[i, 2]
        sub = depth[miny:maxy, minx:maxx]
        hit = inside & (d < sub)
        sub[hit] = d[hit]
        img[miny:maxy, minx:maxx][hit] = col[i]
    return img


def render_parts(parts: list[dict[str, Any]], *, size: int = 560) -> bytes:
    """Two shaded views (front-left, rear-right) of Z-up CadQuery parts as one PNG."""
    import numpy as np
    from PIL import Image

    from modal_workers.product import MATERIALS, _hex

    tris, cols = [], []
    for p in parts:
        verts, faces = p["shape"].tessellate(0.5, 0.5)
        if not faces:
            continue
        v = np.array([(q.x, q.y, q.z) for q in verts])
        t = v[np.array(faces)]
        base = _hex(p.get("color"), 255) or MATERIALS.get(p.get("mat") or "plastic", MATERIALS["plastic"])["color"]
        tris.append(t)
        cols.append(np.repeat((np.array(base[:3]) / 255)[None], len(t), axis=0))
    if not tris:
        raise ValueError("Nothing to render.")
    tri, rgb = np.vstack(tris), np.vstack(cols)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    lo, hi = tri.reshape(-1, 3).min(0), tri.reshape(-1, 3).max(0)
    centre, radius = (lo + hi) / 2, float(np.linalg.norm(hi - lo)) / 2
    dist = radius / math.sin(math.radians(15)) * 1.05
    views = []
    for azim in (-125.0, 55.0):  # front-left (front faces -Y), rear-right
        a, e = math.radians(azim), math.radians(28)
        eye = centre + dist * np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
        to_eye = eye - tri.mean(axis=1)
        to_eye /= np.linalg.norm(to_eye, axis=1, keepdims=True)
        nn = np.where((np.sum(n * to_eye, axis=1) < 0)[:, None], -n, n)  # two-sided
        key = np.array([-0.3, -0.5, 0.8]) / np.linalg.norm([-0.3, -0.5, 0.8])
        diffuse = np.clip(nn @ key, 0, 1) * 0.6 + np.clip(np.sum(nn * to_eye, axis=1), 0, 1) * 0.25 + 0.25
        views.append(_raster(tri, np.clip(rgb * diffuse[:, None], 0, 1), size, size, eye, centre))
    img = (np.concatenate(views, axis=1) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG")
    return buf.getvalue()
