export function ropeAt(x, y) {
  return Array.from({ length: 20 }, (_, i) => ({ x: x + i * 8, y: y + i * 2, px: x + i * 8, py: y + i * 2 }));
}
export function stepRope(nodes, handle, seconds) {
  const dt = Math.max(0, Math.min(seconds, 1 / 30));
  if (!dt) return;
  const steps = Math.ceil(dt / (1 / 120)), h = dt / steps;
  for (let s = 0; s < steps; s++) {
    nodes[0].x = handle.x; nodes[0].y = handle.y;
    for (let i = 1; i < nodes.length; i++) {
      const p = nodes[i], x = p.x, y = p.y;
      p.x += (p.x - p.px) * .975;
      p.y += (p.y - p.py) * .975 + 700 * h * h;
      p.px = x; p.py = y;
    }
    for (let pass = 0; pass < 10; pass++) {
      for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1], b = nodes[i], dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1, correction = (d - 8) / d;
        const share = i === 1 ? 1 : .5;
        b.x -= dx * correction * share; b.y -= dy * correction * share;
        if (i > 1) { a.x += dx * correction * .5; a.y += dy * correction * .5; }
      }
    }
  }
}
export function crackReady(speed, now, last) {
  return speed >= 850 && now - last >= 650;
}
export function sweepPoints(a, b) {
  const count = Math.min(80, Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3)));
  return Array.from({ length: count }, (_, i) => ({ x: a.x + (b.x - a.x) * (i + 1) / count, y: a.y + (b.y - a.y) * (i + 1) / count }));
}
