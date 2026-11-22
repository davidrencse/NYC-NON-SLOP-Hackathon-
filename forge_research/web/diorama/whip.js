import { actorAt, hitActor, boost } from './whip-state.mjs';
import { ropeAt, stepRope, crackReady, sweepPoints } from './whip-physics.mjs';

// Original cursor-rope simulation; presentation only, never changes agent tasks.
export function createWhip(T, scene, camera, canvas, crew, nav) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const button = document.createElement('button');
  button.title = 'Flick the rope tip onto crew. Click assists a flick. Cosmetic only; Escape exits.';
  nav.append(button);
  const overlay = document.createElement('canvas'), ctx = overlay.getContext('2d');
  overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
  overlay.setAttribute('aria-hidden', 'true'); canvas.parentElement.append(overlay);
  let enabled = false, nodes = null, pointer = { x: 0, y: 0 }, last = performance.now();
  let lastCrack = -Infinity, activeUntil = 0, struck = false, audio;
  const ray = new T.Raycaster();
  const soundControl = document.querySelector('#sound'), soundButton = document.createElement('button');
  soundButton.title = 'Toggle workshop and whip sounds'; nav.insertBefore(soundButton, button);
  function syncSound() {
    const on = soundControl.getAttribute('aria-pressed') === 'true';
    soundButton.textContent = on ? 'Sound on' : 'Sound off';
    soundButton.setAttribute('aria-pressed', String(on));
    if (on) {
      try { audio ??= new AudioContext(); audio.resume().catch(error => console.warn('Whip audio unavailable', error)); }
      catch (error) { console.warn('Whip audio unavailable', error); }
    } else if (audio?.state === 'running') audio.suspend().catch(error => console.warn('Could not mute whip audio', error));
  }
  soundButton.onclick = () => { soundControl.click(); syncSound(); };
  soundControl.addEventListener('click', () => queueMicrotask(syncSound)); syncSound();
  function clear() {
    nodes = null; activeUntil = 0; lastCrack = -Infinity; struck = false;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    crew.forEach(c => { c.whip = null; c.whipTime = 0; });
  }
  function toggle(on) {
    enabled = on; clear(); button.textContent = `Whip · ${on ? 'on' : 'off'}`;
    button.setAttribute('aria-pressed', String(on)); canvas.style.cursor = on ? 'crosshair' : '';
  }
  function sound(hit = false) {
    if (soundControl.getAttribute('aria-pressed') !== 'true' || audio?.state !== 'running') return;
    const now = audio.currentTime, gain = audio.createGain();
    gain.connect(audio.destination);
    if (hit) {
      const pop = audio.createOscillator(); pop.type = 'sine';
      pop.frequency.setValueAtTime(520, now); pop.frequency.exponentialRampToValueAtTime(150, now + .09);
      gain.gain.setValueAtTime(.15, now); gain.gain.exponentialRampToValueAtTime(.001, now + .11);
      pop.connect(gain); pop.start(); pop.stop(now + .12);
      pop.onended = () => { pop.disconnect(); gain.disconnect(); };
      return;
    }
    const buffer = audio.createBuffer(1, Math.ceil(audio.sampleRate * .16), audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / audio.sampleRate;
      const envelope = t < .09 ? .18 * Math.sin(t / .09 * Math.PI) : Math.exp(-(t - .09) * 95);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }
    const source = audio.createBufferSource(), filter = audio.createBiquadFilter();
    filter.type = 'highpass'; filter.frequency.value = 900;
    source.buffer = buffer; gain.gain.value = .24;
    source.connect(filter); filter.connect(gain); source.start();
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  }
  function point(e) {
    const r = canvas.getBoundingClientRect(); pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    nodes ??= ropeAt(pointer.x, pointer.y);
  }
  canvas.addEventListener('pointermove', e => { if (enabled) point(e); });
  canvas.addEventListener('pointerdown', e => {
    if (!enabled || e.button !== 0) return;
    e.stopImmediatePropagation(); point(e);
    // A click supplies a small forward impulse, not a cursor-based hit shortcut.
    if (!reduced.matches) nodes.slice(1).forEach((p, i) => { p.px -= (i + 1) * .65; p.py += (i + 1) * .25; });
  }, true);
  canvas.addEventListener('pointerup', e => { if (enabled) e.stopImmediatePropagation(); }, true);
  button.onclick = () => toggle(!enabled); toggle(false);
  window.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false); });
  window.addEventListener('pagehide', () => { toggle(false); audio?.close(); });
  window.addEventListener('message', e => {
    if (e.source === parent && e.origin === location.origin && e.data?.type === 'whip-off') toggle(false);
  });
  function motionPreference() {
    toggle(false); button.disabled = reduced.matches;
    if (reduced.matches) button.textContent = 'Whip · reduced motion';
  }
  reduced.addEventListener('change', motionPreference); motionPreference();
  function collide(a, b, now) {
    for (const p of sweepPoints(a, b)) {
      ray.setFromCamera(new T.Vector2(p.x / overlay.width * 2 - 1, 1 - p.y / overlay.height * 2), camera);
      // The first surface must belong to crew: walls/desks occlude strikes too.
      const hit = ray.intersectObjects(scene.children, true).find(h => {
        for (let node = h.object; node; node = node.parent) if (!node.visible) return false;
        return h.object.material?.opacity !== 0;
      });
      const actor = actorAt(hit ? [hit] : [], crew);
      if (actor) { hitActor(actor, now); struck = true; sound(true); return; }
    }
  }
  function draw(now) {
    ctx.lineCap = 'round';
    for (let i = 1; i < nodes.length; i++) {
      ctx.beginPath(); ctx.moveTo(nodes[i - 1].x, nodes[i - 1].y); ctx.lineTo(nodes[i].x, nodes[i].y);
      ctx.lineWidth = 6 * (1 - i / nodes.length) + .7;
      ctx.strokeStyle = i < 4 ? '#37251c' : i % 2 ? '#a97849' : '#805333'; ctx.stroke();
    }
    if (now < activeUntil) {
      const tip = nodes.at(-1); ctx.strokeStyle = '#f2d6a2'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(tip.px, tip.py); ctx.lineTo(tip.x, tip.y); ctx.stroke();
    }
    crew.forEach(c => {
      if (boost(c, now) === 1) return;
      const p = c.root.position.clone().add(new T.Vector3(0, .7, 0)).project(camera);
      if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || p.z > 1) return;
      const x = (p.x + 1) * overlay.width / 2, y = (1 - p.y) * overlay.height / 2;
      ctx.strokeStyle = '#e8c68d'; ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(x - 14, y + i * 5); ctx.lineTo(x - 25 - Math.sin(now / 70 + i) * 4, y + i * 5); ctx.stroke(); }
    });
  }
  return {
    click() { return enabled; },
    pose(c, t, dt) {
      const rate = boost(c, performance.now());
      c.whipTime = rate > 1 && !reduced.matches ? (c.whipTime || 0) + dt : 0;
      return t + c.whipTime;
    },
    update() {
      const now = performance.now(), dt = Math.min((now - last) / 1000, 1 / 30); last = now;
      if (overlay.width !== canvas.clientWidth || overlay.height !== canvas.clientHeight) { overlay.width = canvas.clientWidth; overlay.height = canvas.clientHeight; }
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (!enabled || !nodes || reduced.matches) return;
      const previous = { ...nodes.at(-1) }; stepRope(nodes, pointer, dt);
      const tip = nodes.at(-1), velocity = Math.hypot(tip.x - previous.x, tip.y - previous.y) / Math.max(dt, .001);
      if (crackReady(velocity, now, lastCrack)) { lastCrack = now; activeUntil = now + 160; struck = false; sound(); }
      if (now < activeUntil && !struck) collide(previous, tip, now);
      crew.forEach(c => {
        if (boost(c, now) === 1) return;
        const age = (now - c.whip.start) / 1000;
        if (age < .32) { c.body.position.y += Math.sin(age / .32 * Math.PI) * .32; c.head.rotation.z = -.15; c.headMat.map = c.faces.blink; c.headMat.needsUpdate = true; c.mood = 'blink'; }
      });
      draw(now);
    }
  };
}
