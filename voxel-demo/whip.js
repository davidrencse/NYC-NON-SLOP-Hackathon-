import { actorAt, hitActor, boost } from './whip-state.mjs';

// Presentation only: never changes the story clock, paths, or agent tasks.
export function createWhip(T, scene, camera, canvas, crew, nav) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const button = document.createElement('button');
  button.textContent = 'Whip · off';
  button.title = 'Cartoon whip: click crew for a cosmetic animation boost only. Escape exits.';
  button.setAttribute('aria-pressed', 'false'); nav.append(button);
  const geometry = new T.BufferGeometry().setFromPoints(Array.from({ length: 25 }, () => new T.Vector3()));
  const line = new T.Line(geometry, new T.LineBasicMaterial({ color: 0xf4ce86, depthTest: false }));
  line.renderOrder = 10; line.visible = false; scene.add(line);
  const accents = new T.Group(); scene.add(accents);
  const material = new T.LineBasicMaterial({ color: 0xffe3a0 });
  for (let i = 0; i < 8; i++) {
    const g = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
    accents.add(new T.Line(g, material));
  }
  accents.visible = false;
  let enabled = false, swing = null;
  function clear() {
    swing = null; line.visible = accents.visible = false;
    crew.forEach(c => { c.whip = null; c.whipTime = 0; });
  }
  function toggle(on) {
    enabled = on; clear(); button.textContent = `Whip · ${on ? 'on' : 'off'}`;
    button.setAttribute('aria-pressed', String(on)); canvas.style.cursor = on ? 'crosshair' : '';
  }
  button.onclick = () => toggle(!enabled);
  window.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false); });
  window.addEventListener('pagehide', () => toggle(false));
  window.addEventListener('message', e => {
    if (e.source === parent && e.origin === location.origin && e.data?.type === 'whip-off') toggle(false);
  });
  reduced.addEventListener('change', clear);
  return {
    click(ray, hits) {
      if (!enabled) return false;
      const actor = actorAt(hits, crew), now = performance.now();
      hitActor(actor, now);
      swing = { start: now, actor, end: actor ? actor.root.position.clone().add(new T.Vector3(0, 1, 0)) : ray.ray.at(25, new T.Vector3()) };
      return true;
    },
    pose(c, t, dt) {
      const now = performance.now(), rate = boost(c, now);
      if (reduced.matches) return t;
      c.whipTime = rate > 1 ? (c.whipTime || 0) + dt : 0;
      return t + c.whipTime;
    },
    update() {
      const now = performance.now();
      line.visible = !!swing && now - swing.start < 320 && !reduced.matches;
      accents.visible = false;
      crew.forEach(c => {
        if (boost(c, now) === 1 || reduced.matches) return;
        const age = (now - c.whip.start) / 1000;
        if (age < .32) {
          c.body.position.y += Math.sin(age / .32 * Math.PI) * .32;
          c.headMat.map = c.faces.blink; c.headMat.needsUpdate = true; c.mood = 'blink';
        }
      });
      if (!swing || reduced.matches) return;
      const age = (now - swing.start) / 1000;
      if (line.visible) {
        const start = camera.position.clone().lerp(swing.end, .65).add(new T.Vector3(.8, -.8, 0));
        const points = Array.from({ length: 25 }, (_, i) => {
          const u = i / 24, p = start.clone().lerp(swing.end, u);
          p.y += Math.sin(u * Math.PI) * Math.sin(age / .32 * Math.PI) * 2;
          return p;
        });
        geometry.setFromPoints(points);
      }
      if (!swing.actor || boost(swing.actor, now) === 1) return;
      accents.visible = true; accents.position.copy(swing.actor.root.position);
      accents.children.forEach((l, i) => {
        const a = i * Math.PI / 4, pop = age < .3;
        const x = Math.cos(a), y = Math.sin(a);
        l.geometry.setFromPoints(pop
          ? [new T.Vector3(x * .55, 1 + y * .55, 0), new T.Vector3(x * .85, 1 + y * .85, 0)]
          : [new T.Vector3(-.5, .3 + i * .12, -.3), new T.Vector3(-.9 - .15 * Math.sin(now / 70 + i), .3 + i * .12, -.3)]);
      });
    }
  };
}
