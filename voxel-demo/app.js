import * as T from './vendor/three.module.js';

/* FORGE diorama — research labs → pathway → engineering factory.
   Low-res PSX-style renderer: vertex snapping, nearest-upscaled render target,
   ordered dithering and colour quantisation. Everything is local; no network. */

const $ = s => document.querySelector(s);
const host = $('#world'), canvas = $('#scene'), labelsEl = $('#labels');
const LOOP = 54, PI = Math.PI, HP = PI / 2;
let seed = 1337;
const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
const clamp = T.MathUtils.clamp, lerp = T.MathUtils.lerp;
const ease = u => 1 - Math.pow(1 - clamp(u, 0, 1), 3);

/* ---------------------------------------------------------------- renderer */
const renderer = new T.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
const rt = new T.WebGLRenderTarget(2, 2, { minFilter: T.LinearFilter, magFilter: T.LinearFilter, type: T.HalfFloatType, samples: 4 });
const snapU = { value: new T.Vector2(160, 120) };
const post = new T.ShaderMaterial({
  uniforms: { tDiffuse: { value: rt.texture }, time: { value: 0 } },
  depthTest: false, depthWrite: false,
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; varying vec2 vUv;
        void main(){
      vec3 c=texture2D(tDiffuse,vUv).rgb*1.12;
      c=c*(1.+c/5.)/(1.+c);                       // soft shoulder
      c=pow(max(c,0.),vec3(1./2.2));
      float l=dot(c,vec3(.299,.587,.114));
      c=mix(vec3(l),c,.9);                        // muted, filmic
      c*=mix(vec3(.84,.94,1.05),vec3(1.05,1.0,.93),smoothstep(.15,.85,l)); // cool shadows, warm lights
      c+=vec3(.012,.018,.026);                    // lifted blacks
      vec2 q=vUv-.5; c*=1.-dot(q,q)*.45;           // vignette
      gl_FragColor=vec4(c,1.);
    }`
});
const postScene = new T.Scene(), postCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
postScene.add(new T.Mesh(new T.PlaneGeometry(2, 2), post));

const scene = new T.Scene();
scene.background = new T.Color(0x12181b);
scene.fog = new T.Fog(0x12181b, 34, 78);
const camera = new T.PerspectiveCamera(30, 1, .5, 200);

scene.add(new T.HemisphereLight(0xdde7ec, 0x3a3f3a, 1.45));
const sun = new T.DirectionalLight(0xfff0da, 2.2);
sun.position.set(-12, 26, 16);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 18, bottom: -18, near: 1, far: 80 });
sun.shadow.bias = -.0015;
scene.add(sun, sun.target);

/* ---------------------------------------------------------------- materials & textures */
function psx(m) { return m;
  m.onBeforeCompile = s => {
    s.uniforms.uSnap = snapU;
    s.vertexShader = 'uniform vec2 uSnap;\n' + s.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\ngl_Position.xy=floor(gl_Position.xy/gl_Position.w*uSnap+.5)/uSnap*gl_Position.w;');
  };
  return m;
}
const lam = o => psx(new T.MeshLambertMaterial(o));
const matCache = new Map();
function M(c) { if (typeof c === 'object') return c; if (!matCache.has(c)) matCache.set(c, lam({ color: c })); return matCache.get(c); }
const glow = (c, i = 1.4) => lam({ color: c, emissive: c, emissiveIntensity: i });

const rgb = (n, f = 1) => `rgb(${[16, 8, 0].map(s => clamp(((n >> s) & 255) * f, 0, 255) | 0).join(',')})`;
function ctex(w, h, draw, rx = 1, ry = 1) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); draw(g, w, h);
  const t = new T.CanvasTexture(c);
  t.magFilter = t.minFilter = T.NearestFilter; t.generateMipmaps = false; t.colorSpace = T.SRGBColorSpace;
  if (rx !== 1 || ry !== 1) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(rx, ry); }
  t.userData.ctx = g; return t;
}
const px = (g, x, y, w, h, c) => { g.fillStyle = typeof c === 'number' ? rgb(c) : c; g.fillRect(x, y, w, h); };
function speckle(g, x0, y0, w, h, base, amt = .07) { amt *= .3; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(g, x, y, 1, 1, rgb(base, 1 + (rnd() - .5) * amt * 2)); }
const rep = (t, x, y) => { const c = t.clone(); c.wrapS = c.wrapT = T.RepeatWrapping; c.repeat.set(x, y); c.needsUpdate = true; return c; };

const tileTex = (a, b) => ctex(16, 16, g => {
  for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
    speckle(g, tx * 8, ty * 8, 8, 8, (tx + ty) % 2 ? a : b, .05);
    px(g, tx * 8, ty * 8, 8, 1, rgb(b, .82)); px(g, tx * 8, ty * 8, 1, 8, rgb(b, .82));
  }
});
const wallTex = (base, trim) => ctex(32, 32, g => {
  speckle(g, 0, 0, 32, 32, base, .05);
  for (let i = 0; i < 5; i++) px(g, rnd() * 30 | 0, 10 + rnd() * 16 | 0, 2, 1, rgb(base, .9));
  px(g, 0, 17, 32, 1, rgb(base, 1.06)); px(g, 0, 18, 32, 1, rgb(base, .9));
  speckle(g, 0, 28, 32, 4, trim, .06); px(g, 0, 28, 32, 1, rgb(trim, 1.15));
});
const woodTex = ctex(16, 16, g => { for (let y = 0; y < 16; y++) { const b = y % 4 === 0 ? .78 : 1; for (let x = 0; x < 16; x++) px(g, x, y, 1, 1, rgb(0x9a7a56, b * (1 + (rnd() - .5) * .12))); } });
const crateTex = ctex(16, 16, g => {
  speckle(g, 0, 0, 16, 16, 0xb08a5a, .1);
  for (let i = 0; i < 16; i += 5) px(g, 0, i, 16, 1, 0x7a5a38);
  px(g, 0, 0, 16, 2, 0x8a6a42); px(g, 0, 14, 16, 2, 0x8a6a42); px(g, 0, 0, 2, 16, 0x8a6a42); px(g, 14, 0, 2, 16, 0x8a6a42);
  for (let i = 2; i < 14; i++) px(g, i, i, 2, 1, 0x8a6a42);
});
const concreteTex = ctex(32, 32, g => { speckle(g, 0, 0, 32, 32, 0x7d817c, .09); px(g, 0, 0, 32, 1, 0x5f635e); px(g, 0, 0, 1, 32, 0x5f635e); for (let i = 0; i < 6; i++) px(g, rnd() * 30 | 0, rnd() * 30 | 0, 3, 2, 0x6e716b); });
const hazardTex = ctex(16, 16, g => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(g, x, y, 1, 1, ((x + y) >> 2) % 2 ? 0xd8b23a : 0x2a2a28); });
const grassTex = ctex(32, 32, g => { for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const n = rnd(); px(g, x, y, 1, 1, n < .04 ? 0x5a7046 : n < .5 ? 0x4a5d3d : 0x47593a); } for (let i = 0; i < 4; i++) px(g, rnd() * 31 | 0, rnd() * 31 | 0, 1, 1, [0xd8d0a8, 0xc89aa8][i % 2]); }, 34, 24);
const paverTex = ctex(16, 16, g => {
  px(g, 0, 0, 16, 16, 0x4f4c46);
  for (let r = 0; r < 4; r++) for (let c = -1; c < 3; c++) { const o = r % 2 ? 4 : 0; speckle(g, c * 8 + o + 1, r * 4 + 1, 7, 3, rnd() < .5 ? 0x9a948a : 0x8a857b, .07); }
});
const corrTex = ctex(16, 32, g => { for (let x = 0; x < 16; x++) for (let y = 0; y < 32; y++) px(g, x, y, 1, 1, rgb(0x56625f, (x % 4 < 2 ? 1.08 : .9) * (1 + (rnd() - .5) * .06))); px(g, 0, 26, 16, 6, 0x3b4442); });
const beltTex = ctex(16, 8, g => { px(g, 0, 0, 16, 8, 0x26292a); for (let x = 0; x < 16; x += 4) px(g, x, 0, 1, 8, 0x3a3e3f); }, 9, 1);

// Packaging labels — the shelf goods borrowed from a corner-shop.
const LABEL_C = [0x6aa070, 0xc05050, 0x8a66a8, 0xd6b048, 0x5a9aa0, 0xd8d4c8];
const productMats = LABEL_C.map((c, i) => {
  const t = ctex(12, 12, g => { speckle(g, 0, 0, 12, 12, 0xe6e2d8, .04); px(g, 0, 8, 12, 4, c); px(g, 4, 2, 4, 4, i % 2 ? 0x4a4a52 : rgb(c, .8)); px(g, 5, 3, 2, 2, 0xf4f2ea); px(g, 2, 9, 3, 1, 0xf4f2ea); });
  const side = M(0xdedad0), top = M(0xe6e2d8), front = lam({ map: t });
  return [side, side, top, top, front, front];
});
const posterTex = [
  ctex(24, 32, g => { speckle(g, 0, 0, 24, 32, 0xe8e6de, .03); px(g, 1, 1, 22, 30, 0xd8d6cc); speckle(g, 2, 2, 20, 28, 0xeeece6, .03); for (let r = 0; r < 6; r++) { const s = 4 - (r >> 1); for (let c = 0; c < 18 / (s + 1); c++) px(g, 3 + c * (s + 1), 4 + r * 4, s, s - (r > 3 ? 0 : 1), r === 0 ? 0xb06060 : r === 4 ? 0x5a8a6a : 0x5a5050); } px(g, 14, 25, 6, 4, 0x6a6a72); }),
  ctex(24, 32, g => { px(g, 0, 0, 24, 32, 0x2e5a48); for (let i = 0; i < 9; i++) { const x = 2 + rnd() * 20 | 0, y = 2 + rnd() * 28 | 0; px(g, x, y, 1 + rnd() * 8 | 0, 1, 0xc9b56a); px(g, x, y, 1, 1 + rnd() * 6 | 0, 0xc9b56a); } px(g, 8, 10, 8, 8, 0x1c2a28); px(g, 3, 26, 5, 3, 0xe8e2c8); }),
  ctex(24, 32, g => { px(g, 0, 0, 24, 32, 0xe9e2cf); px(g, 2, 2, 20, 4, 0xd47e52); for (let i = 0; i < 5; i++) { const h = 6 + rnd() * 14 | 0; px(g, 3 + i * 4, 28 - h, 3, h, [0x5a8aa8, 0x6aa070, 0xd6b048][i % 3]); } px(g, 2, 28, 20, 1, 0x3a3a3a); })
];
const signTex = (txt, bg, fg, w = 64) => ctex(w, 12, g => { px(g, 0, 0, w, 12, bg); px(g, 1, 1, w - 2, 10, rgb(bg, 1.1)); g.font = 'bold 8px monospace'; g.fillStyle = rgb(fg); g.textBaseline = 'middle'; g.fillText(txt, 4, 6.5); });

// Animated canvases: CRT text, oscilloscope, whiteboard, factory status board.
const screenTex = ctex(40, 30, () => {});
const scopeTex = ctex(32, 24, () => {});
const boardTex = ctex(48, 32, () => {});
const statusTex = ctex(64, 24, () => {});
function drawScreen(t) {
  const g = screenTex.userData.ctx, sc = Math.floor(t * 3);
  px(g, 0, 0, 40, 30, 0x0f2a2b);
  for (let i = 0; i < 8; i++) { const h = Math.sin((i + sc) * 12.9898) * 43758.5453; const w = 6 + Math.abs(h % 1) * 28 | 0; px(g, 3, 3 + i * 3, w, 1, (i + sc) % 5 ? 0x7fdcb0 : 0xe6f0c0); }
  if (sc % 2) px(g, 3, 27, 3, 1, 0xe6f0c0);
  screenTex.needsUpdate = true;
  const s = scopeTex.userData.ctx; px(s, 0, 0, 32, 24, 0x0b1b16);
  for (let i = 0; i < 32; i += 4) px(s, i, 0, 1, 24, 0x17332a); for (let i = 0; i < 24; i += 4) px(s, 0, i, 32, 1, 0x17332a);
  for (let x = 0; x < 32; x++) px(s, x, 12 + Math.round(Math.sin(x * .45 + t * 7) * 7 * Math.sin(t * .8 + x * .05)), 1, 1, 0x8affc0);
  scopeTex.needsUpdate = true;
}
const boardStrokes = (() => { seed = 99; const s = []; s.push([3, 3, 20, 2, 0x3a4f8a]); for (let r = 0; r < 4; r++) { s.push([3, 8 + r * 4, 2, 2, 0x3a4f8a]); s.push([7, 8 + r * 4, 6 + rnd() * 12 | 0, 1, 0x2a2a2a]); } s.push([28, 4, 16, 10, 0xc05050, 'box']); s.push([31, 7, 4, 1, 0xc05050]); s.push([31, 10, 9, 1, 0xc05050]); s.push([26, 20, 18, 1, 0x2a2a2a]); s.push([26, 20, 1, 8, 0x2a2a2a]); for (let i = 0; i < 4; i++) s.push([28 + i * 4, 26 - i * 2 - (rnd() * 2 | 0), 2, 2 + i * 2, 0x4a8a5a]); s.push([3, 26, 1, 1, 0x4a8a5a]); s.push([4, 27, 1, 1, 0x4a8a5a]); s.push([5, 25, 1, 1, 0x4a8a5a]); s.push([6, 24, 1, 1, 0x4a8a5a]); return s; })();
let boardN = -1;
function drawBoard(p) {
  const n = Math.floor(clamp(p, 0, 1) * boardStrokes.length); if (n === boardN) return; boardN = n;
  const g = boardTex.userData.ctx; px(g, 0, 0, 48, 32, 0xf2f2ec); px(g, 0, 31, 48, 1, 0xd0d0c8);
  for (let i = 0; i < n; i++) { const [x, y, w, h, c, k] = boardStrokes[i]; if (k === 'box') { px(g, x, y, w, 1, c); px(g, x, y + h, w, 1, c); px(g, x, y, 1, h, c); px(g, x + w - 1, y, 1, h + 1, c); } else px(g, x, y, w, h, c); }
  boardTex.needsUpdate = true;
}
let statusN = -1;
function drawStatus(n, t) {
  const k = n * 2 + (n >= 5 && Math.floor(t * 2) % 2); if (k === statusN) return; statusN = k;
  const g = statusTex.userData.ctx; px(g, 0, 0, 64, 24, 0x101818);
  g.font = 'bold 7px monospace'; g.fillStyle = '#9fdcc0'; g.textBaseline = 'top'; g.fillText(n >= 5 ? 'DRAFT ONLY' : 'ILLUSTRATION', 3, 2);
  for (let i = 0; i < 5; i++) px(g, 3 + i * 12, 13, 10, 7, i < n ? 0x7fdcb0 : 0x2a3a38);
  statusTex.needsUpdate = true;
}

/* ---------------------------------------------------------------- mesh helpers */
const G = { box: new T.BoxGeometry(1, 1, 1), cyl: new T.CylinderGeometry(.5, .5, 1, 10), cyl6: new T.CylinderGeometry(.5, .5, 1, 6), ball: new T.SphereGeometry(.5, 8, 6), ico: new T.IcosahedronGeometry(.5, 0), cone: new T.ConeGeometry(.5, 1, 6) };
function mesh(geo, m, p, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) { const o = new T.Mesh(geo, Array.isArray(m) ? m : M(m)); o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.castShadow = o.receiveShadow = true; p.add(o); return o; }
const box = (p, x, y, z, w, h, d, c) => mesh(G.box, c, p, x, y, z, w, h, d);
const grp = (p, x = 0, y = 0, z = 0, ry = 0) => { const g = new T.Group(); g.position.set(x, y, z); g.rotation.y = ry; p.add(g); return g; };
const faceMat = (side, front) => [M(side), M(side), M(side), M(side), front, M(side)];
const topMat = (side, top) => [M(side), M(side), top, M(side), M(side), M(side)];

/* ---------------------------------------------------------------- characters */
function faceTex(skin, mode, glasses) {
  return ctex(96, 48, g => {
    speckle(g, 0, 0, 96, 48, skin, .025);
    px(g, 0, 34, 96, 14, rgb(skin, .93));
    for (const s of [-1, 1]) {
      const ex = 24 + s * 5;
      if (mode === 'open') {
        px(g, ex - 1, 23, 3, 4, 0x2b2030); px(g, ex - 1, 26, 3, 1, 0x5a3a5c);
        px(g, s < 0 ? ex - 2 : ex - 1, 22, 4, 1, 0x161214); px(g, ex - 1, 23, 1, 1, 0xf6f2f0);
      } else if (mode === 'blink') { px(g, ex - 1, 25, 3, 1, 0x161214); px(g, s < 0 ? ex - 2 : ex + 2, 24, 1, 1, 0x161214); }
      else { px(g, ex - 1, 25, 1, 1, 0x161214); px(g, ex, 24, 1, 1, 0x161214); px(g, ex + 1, 25, 1, 1, 0x161214); }
      px(g, ex + s * 3 - 1, 28, 2, 1, 0xe2908e);
      if (glasses) { const c = 0x3a3434; px(g, ex - 3, 21, 7, 1, c); px(g, ex - 3, 28, 7, 1, c); px(g, ex - 3, 21, 1, 7, c); px(g, ex + 3, 21, 1, 7, c); }
    }
    if (glasses) px(g, 22, 23, 4, 1, 0x3a3434);
    if (mode === 'happy') { px(g, 23, 29, 3, 2, 0x7a2e34); px(g, 24, 30, 1, 1, 0xd06a70); }
    else px(g, 23, 30, 2, 1, 0x8a4040);
  });
}
const hairTex = c => ctex(16, 16, g => { speckle(g, 0, 0, 16, 16, c, .12); for (let i = 0; i < 7; i++) px(g, rnd() * 16 | 0, 0, 1, 16, rgb(c, .78)); px(g, 0, 3, 16, 1, rgb(c, 1.35)); });
function clothTex(type, shirt, accent) {
  return ctex(32, 16, g => {
    if (type === 'lab') {
      speckle(g, 0, 0, 32, 16, 0xe6e6e0, .03); px(g, 15, 0, 2, 8, shirt); px(g, 14, 0, 4, 2, shirt);
      px(g, 17, 9, 1, 1, 0x8a8a84); px(g, 17, 12, 1, 1, 0x8a8a84); px(g, 10, 8, 4, 3, 0xd2d2cc); px(g, 11, 7, 1, 2, accent); px(g, 19, 4, 3, 2, accent);
    } else if (type === 'apron') {
      speckle(g, 0, 0, 32, 16, shirt, .04); speckle(g, 9, 3, 15, 13, accent, .07);
      px(g, 10, 0, 2, 3, accent); px(g, 21, 0, 2, 3, accent); px(g, 18, 5, 3, 2, 0xf2f0e8); px(g, 12, 11, 9, 3, rgb(accent, .85)); px(g, 15, 0, 3, 2, rgb(shirt, .85));
    } else {
      speckle(g, 0, 0, 32, 16, accent, .06); px(g, 0, 8, 32, 2, 0xd9d07a); px(g, 0, 13, 32, 1, rgb(accent, .7)); px(g, 12, 2, 8, 4, rgb(accent, .85)); px(g, 14, 0, 4, 2, shirt);
    }
  });
}
const GEO = {
  head: new T.SphereGeometry(.42, 14, 10), torso: new T.CylinderGeometry(.19, .25, .42, 10, 1, false, PI),
  limb: new T.CylinderGeometry(.075, .068, .3, 6), leg: new T.CylinderGeometry(.085, .078, .26, 6),
  hand: new T.SphereGeometry(.085, 6, 5), shoe: new T.BoxGeometry(.15, .09, .24),
  cap: new T.SphereGeometry(.455, 14, 7, 0, PI * 2, 0, 1.32),
  bob: new T.SphereGeometry(.47, 14, 9, HP + .95, PI * 2 - 1.9, 0, 2.2),
  short: new T.SphereGeometry(.465, 14, 8, HP + 1.25, PI * 2 - 2.5, 0, 1.85),
  helmet: new T.SphereGeometry(.49, 14, 6, 0, PI * 2, 0, 1.36)
};
const crew = [], pickables = [];
function person(o) {
  const root = grp(scene), body = grp(root);
  mesh(GEO.torso, lam({ map: clothTex(o.outfit, o.shirt, o.accent) }), body, 0, .57, 0);
  const head = grp(body, 0, 1.13, 0);
  const faces = { open: faceTex(o.skin, 'open', o.glasses), blink: faceTex(o.skin, 'blink', o.glasses), happy: faceTex(o.skin, 'happy', o.glasses) };
  const headMat = lam({ map: faces.open });
  mesh(GEO.head, headMat, head, 0, 0, 0, 1, .94, .92);
  const hm = lam({ map: hairTex(o.hair), side: T.DoubleSide });
  mesh(GEO.cap, hm, head, 0, .015, 0, 1, .96, .95);
  if (o.style === 'bob') mesh(GEO.bob, hm, head, 0, 0, 0, 1, .96, .95);
  else mesh(GEO.short, hm, head, 0, 0, 0, 1, .96, .95);
  if (o.style === 'bun') mesh(G.ball, hm, head, 0, .38, -.2, .34, .34, .34);
  if (o.style === 'pony') { mesh(G.ball, hm, head, 0, .02, -.5, .3, .32, .3); mesh(G.ball, hm, head, 0, -.2, -.52, .22, .3, .22); }
  if (o.clip) box(head, .27, .22, .3, .12, .05, .05, o.clip);
  if (o.hat) { const hat = M(o.hat); mesh(GEO.helmet, hat, head, 0, .03, 0, 1, .9, .98); mesh(G.cyl, hat, head, 0, .1, .08, .98, .03, 1.02); }
  const sleeve = o.outfit === 'lab' ? 0xe6e6e0 : o.outfit === 'overall' ? o.accent : o.shirt;
  const arms = [], legs = [];
  for (const s of [-1, 1]) {
    const a = grp(body, s * .24, .72, 0); mesh(GEO.limb, sleeve, a, 0, -.15, 0); mesh(GEO.hand, o.skin, a, 0, -.32, 0); arms.push(a);
    const l = grp(body, s * .1, .37, 0); mesh(GEO.leg, o.pants || 0x3a4048, l, 0, -.13, 0); mesh(GEO.shoe, 0x2a2624, l, 0, -.3, .03); legs.push(l);
  }
  const carry = grp(body, 0, .62, .34);
  const c = { ...o, root, body, head, headMat, faces, arms, legs, carry, yaw: 0, blinkAt: 1 + rnd() * 3, mood: 'open', seedT: rnd() * 10, pose: 'idle' };
  c.index = crew.length; crew.push(c);
  root.traverse(m => { if (m.isMesh) { m.userData.crew = c.index; pickables.push(m); } });
  return c;
}

const POSES = {
  idle(c, t) { c.head.rotation.y = Math.sin(t * .6 + c.seedT) * .35; c.arms[0].rotation.x = Math.sin(t * 1.4) * .05; },
  type(c, t) { c.body.rotation.x = .06; c.head.rotation.x = .22; c.head.rotation.y = Math.sin(t * .5 + c.seedT) * .12; c.arms.forEach((a, j) => { a.rotation.x = -1.18 + Math.sin(t * 15 + j * PI) * .12; a.rotation.z += j ? -.18 : .18; }); },
  walk(c, t) { const w = t * 10; c.legs.forEach((l, j) => l.rotation.x = Math.sin(w + j * PI) * .7); c.arms.forEach((a, j) => a.rotation.x = Math.sin(w + (1 - j) * PI) * .55); c.body.position.y = Math.abs(Math.sin(w)) * .06; c.body.rotation.z = Math.sin(w) * .04; },
  carry(c, t) { POSES.walk(c, t); c.arms.forEach((a, j) => { a.rotation.x = -1.25; a.rotation.z = j ? -.25 : .25; }); },
  read(c, t) { c.head.rotation.x = .32; c.arms.forEach((a, j) => { a.rotation.x = -.95; a.rotation.z = j ? -.4 : .4; }); if (Math.sin(t * .9) > .96) c.arms[1].rotation.x = -1.3; },
  write(c, t) { c.head.rotation.x = -.05; c.arms[0].rotation.x = -2.1 + Math.sin(t * 7) * .18; c.arms[0].rotation.z = Math.sin(t * 3.3) * .3; c.body.rotation.y = Math.sin(t * 1.6) * .08; },
  reach(c, t) { c.arms[0].rotation.x = -2.3 + Math.sin(t * 3) * .1; c.arms[1].rotation.x = -.4; c.body.position.y = .04; c.head.rotation.x = -.15; },
  place(c, t) { c.body.rotation.x = .18; c.head.rotation.x = .3; c.arms.forEach((a, j) => { a.rotation.x = -.95; a.rotation.z = j ? -.2 : .2; }); },
  hammer(c, t) {
    const u = (t * 2.2) % 1; c.arms[0].rotation.x = u < .7 ? lerp(-.9, -2.05, ease(u / .7)) : lerp(-2.05, -.85, (u - .7) / .3);
    c.arms[1].rotation.x = -1.05; c.head.rotation.x = .28; c.body.rotation.x = .1;
    if (u > .97 && !c.hit) { c.hit = 1; c.onHit?.(); } if (u < .5) c.hit = 0;
  },
  screw(c, t) { c.arms[0].rotation.x = -1.15; c.arms[0].rotation.y = Math.sin(t * 13) * .45; c.arms[1].rotation.x = -1.0; c.head.rotation.x = .3; c.body.rotation.x = .12; },
  sort(c, t) { c.arms[0].rotation.x = -1.05 + Math.sin(t * 4.5) * .35; c.arms[1].rotation.x = -1.05 + Math.cos(t * 4.5) * .35; c.head.rotation.x = .25; c.head.rotation.y = Math.sin(t * 1.1) * .3; },
  file(c, t) { const u = Math.sin(t * 1.8); c.arms[0].rotation.x = -1.3 + u * .35; c.arms[1].rotation.x = -.6; c.body.rotation.x = .08 - u * .05; c.head.rotation.x = .15; },
  inspect(c, t) { c.body.rotation.x = .16; c.arms[0].rotation.x = -2.2; c.arms[0].rotation.z = .65; c.head.rotation.x = .2; c.head.rotation.y = Math.sin(t * 1.3) * .4; },
  wave(c, t) { c.arms[1].rotation.z = 2.5 + Math.sin(t * 11) * .35; c.head.rotation.z = .12; },
  cheer(c, t) { const p = t * 6 + c.seedT; c.body.position.y = Math.abs(Math.sin(p)) * .28; c.arms[0].rotation.z = -2.6 + Math.sin(p * 2) * .2; c.arms[1].rotation.z = 2.6 - Math.sin(p * 2) * .2; c.legs.forEach((l, j) => l.rotation.x = Math.sin(p) * (j ? .3 : -.3)); }
};
function applyPose(c, pose, t, dt) {
  c.pose = pose;
  c.arms.forEach((a, j) => a.rotation.set(0, 0, j ? .09 : -.09)); c.legs.forEach(l => l.rotation.set(0, 0, 0));
  c.head.rotation.set(0, 0, Math.sin(t * .9 + c.seedT) * .05); c.body.rotation.set(0, 0, 0);
  c.body.position.set(0, Math.sin(t * 2.4 + c.seedT) * .012, 0);
  POSES[pose](c, t + c.seedT);
  let mood = pose === 'cheer' ? 'happy' : 'open';
  c.blinkAt -= dt; if (c.blinkAt < 0) { mood = 'blink'; if (c.blinkAt < -.12) c.blinkAt = 2 + rnd() * 3.5; }
  if (pose === 'cheer') mood = 'happy';
  if (mood !== c.mood) { c.mood = mood; c.headMat.map = c.faces[mood]; c.headMat.needsUpdate = true; }
}
function track(keys, t) {
  if (t <= keys[0][0]) return { x: keys[0][1], z: keys[0][2], face: keys[0][3] ?? 0, moving: false };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t < b[0]) { const u = (t - a[0]) / (b[0] - a[0]), dx = b[1] - a[1], dz = b[2] - a[2], mv = Math.hypot(dx, dz) > .01; return { x: a[1] + dx * u, z: a[2] + dz * u, moving: mv, face: mv ? Math.atan2(dx, dz) : (a[3] ?? b[3] ?? 0) }; }
  }
  const l = keys[keys.length - 1]; return { x: l[1], z: l[2], face: l[3] ?? 0, moving: false };
}
const lerpAngle = (a, b, k) => a + ((((b - a + PI) % (2 * PI)) + 2 * PI) % (2 * PI) - PI) * k;

/* ---------------------------------------------------------------- props */
function shelf(p, x, z, ry = 0, books = false) {
  const g = grp(p, x, 0, z, ry), dark = 0x2e2622;
  box(g, -.8, .95, 0, .06, 1.9, .45, dark); box(g, .8, .95, 0, .06, 1.9, .45, dark); box(g, 0, .95, -.21, 1.6, 1.9, .04, 0x241d1a);
  for (let i = 0; i < 4; i++) {
    const y = .12 + i * .55; box(g, 0, y, 0, 1.6, .05, .45, 0x4a3c34);
    if (i === 3) continue;
    for (let k = 0; k < 5; k++) {
      if (books) { const h = .3 + rnd() * .14; box(g, -.6 + k * .12 + rnd() * .02, y + h / 2 + .03, .02, .1, h, .3, [0x8a4a4a, 0x4a6a8a, 0xb89a5a, 0x5a7a5a, 0x7a5a8a][(k + i) % 5]); }
      else mesh(G.box, productMats[(k * 3 + i * 2) % 6], g, -.6 + k * .3, y + .17, .04, .24, .28, .26);
    }
    if (books) for (let k = 0; k < 4; k++) box(g, .15 + k * .14, y + .2, .03, .11, .32 + rnd() * .08, .3, [0xc0b8a8, 0x6a8a9a, 0xa86a5a][k % 3]);
  }
  return g;
}
function desk(p, x, z, w = 1.8) {
  const g = grp(p, x, 0, z);
  mesh(G.box, lam({ map: woodTex }), g, 0, .58, 0, w, .06, .8);
  for (const sx of [-1, 1]) box(g, sx * (w / 2 - .08), .28, 0, .06, .55, .7, 0x6a7470);
  box(g, w / 2 - .35, .3, 0, .5, .5, .66, 0x8a948e); box(g, w / 2 - .35, .42, .335, .4, .02, .02, 0x4a504c); box(g, w / 2 - .35, .22, .335, .4, .02, .02, 0x4a504c);
  // chunky beige CRT turned toward the researcher
  const crt = grp(g, w / 2 - .4, .61, -.05, PI + .55);
  box(crt, 0, .24, 0, .5, .42, .42, 0xd8d2bc); box(crt, 0, .22, -.26, .36, .3, .14, 0xc8c2ac);
  mesh(G.box, faceMat(0x1a2222, lam({ map: screenTex, emissive: 0xffffff, emissiveMap: screenTex, emissiveIntensity: .9 })), crt, 0, .25, .215, .4, .3, .01);
  box(g, -.1, .625, -.12, .55, .03, .18, 0xd2ccb6);
  box(g, -w / 2 + .25, .66, .1, .1, .12, .1, 0xe8e0d0);
  box(g, -w / 2 + .5, .63, -.15, .32, .05, .24, 0xf0eee6); box(g, -w / 2 + .52, .67, -.14, .3, .03, .22, 0xe8e6de);
  return g;
}
function poster(p, x, y, z, tex, w = .7, h = .93, ry = 0) { const g = grp(p, x, y, z, ry); mesh(G.box, faceMat(0xd8d6cc, lam({ map: tex })), g, 0, 0, 0, w, h, .03); return g; }
function plant(p, x, z, s = 1) {
  const g = grp(p, x, 0, z); mesh(G.cyl, 0xb07a58, g, 0, .2 * s, 0, .4 * s, .4 * s, .4 * s); box(g, 0, .41 * s, 0, .36 * s, .02, .36 * s, 0x3a2e24);
  const leaf = [0x5a8a4a, 0x6f9a55, 0x4a7a40];
  for (let i = 0; i < 4; i++) { const m = mesh(G.ico, lam({ color: leaf[i % 3], flatShading: true }), g, (rnd() - .5) * .35 * s, (.65 + i * .18) * s, (rnd() - .5) * .3 * s, .5 * s, .45 * s, .5 * s); m.rotation.y = rnd() * 3; }
  return g;
}
function microwave(p, x, y, z, ry = 0) {
  const t = ctex(24, 14, g => { speckle(g, 0, 0, 24, 14, 0xdedbd2, .03); px(g, 2, 2, 14, 10, 0x6a6a6a); px(g, 3, 3, 12, 8, 0x1e1c1e); px(g, 4, 4, 4, 2, 0x3a3436); px(g, 18, 2, 4, 3, 0x2a4a3a); for (let i = 0; i < 3; i++) px(g, 18, 7 + i * 2, 4, 1, 0xa8a49c); });
  const g = grp(p, x, y, z, ry); mesh(G.box, faceMat(0xdedbd2, lam({ map: t })), g, 0, .17, 0, .6, .34, .4); return g;
}
function fileCab(p, x, z, ry) {
  const t = ctex(12, 24, g => { speckle(g, 0, 0, 12, 24, 0x7f9690, .04); for (let i = 0; i < 4; i++) { px(g, 0, i * 6, 12, 1, 0x4e5e5a); px(g, 4, i * 6 + 3, 4, 1, 0xc8ccc4); } });
  const g = grp(p, x, 0, z, ry); mesh(G.box, faceMat(0x7f9690, lam({ map: t })), g, 0, .65, 0, .55, 1.3, .55);
  box(g, 0, 1.35, .05, .32, .1, .25, 0xf0eee6); return g;
}
const crate = (p, x, y, z, s = .45) => mesh(G.box, lam({ map: crateTex }), p, x, y + s / 2, z, s, s, s);
function lampPost(x, z) { const g = grp(scene, x, 0, z); mesh(G.cyl6, 0x2a3032, g, 0, 1.2, 0, .1, 2.4, .1); box(g, 0, 2.45, 0, .32, .1, .32, 0x2a3032); box(g, 0, 2.32, 0, .22, .16, .22, glow(0xffe2a0, 2)); }
function tree(x, z, s = 1) {
  const g = grp(scene, x, 0, z); mesh(G.cyl6, 0x5a4434, g, 0, .5 * s, 0, .22 * s, s, .22 * s);
  [[0, 1.3, .0, 1.3], [.25, 1.85, .1, 1], [-.2, 2.2, -.1, .75]].forEach(([dx, y, dz, r], i) => { const m = mesh(G.ico, lam({ color: [0x4a6a40, 0x5a7a48, 0x6a8a52][i], flatShading: true }), g, dx * s, y * s, dz * s, r * s, r * s, r * s); m.rotation.set(rnd(), rnd() * 3, rnd()); });
}
const folder = () => { const g = new T.Group(); box(g, 0, 0, 0, .34, .05, .42, 0xc89a58); box(g, .01, .03, 0, .3, .02, .38, 0xf2efe6); box(g, 0, .055, -.1, .12, .01, .08, 0xd04a3a); return g; };
const papers = () => { const g = new T.Group(); for (let i = 0; i < 3; i++) box(g, (rnd() - .5) * .03, i * .025, 0, .26, .02, .34, 0xf2efe6); g.rotation.x = -.5; return g; };

/* ---------------------------------------------------------------- world: ground */
const ground = mesh(new T.PlaneGeometry(130, 90), lam({ map: grassTex }), scene, 0, 0, 0); ground.rotation.x = -HP; ground.castShadow = false; ground.receiveShadow = true;
mesh(G.box, lam({ map: rep(paverTex, 14, 14) }), scene, -14, .02, 0, 15.6, .04, 14.6);
mesh(G.box, lam({ map: rep(paverTex, 14, 1.6) }), scene, .1, .02, 1.5, 14.6, .04, 1.6);
for (let x = -6.2; x < 7; x += .9) box(scene, x, .045, 1.5, .35, .01, .07, 0xd8cfa0);

/* ---------------------------------------------------------------- world: labs */
const labs = {};
function labRoom(key, cx, cz, o) {
  const g = grp(scene, cx, 0, cz), W = 6, D = 5, H = 2.1;
  box(g, 0, .03, 0, W + .2, .06, D + .2, 0x2e3633);
  mesh(G.box, topMat(0xbcbfb8, lam({ map: rep(tileTex(o.floor[0], o.floor[1]), W / 2, D / 2) })), g, 0, .07, 0, W, .04, D);
  const wt = wallTex(0xd2d3cc, o.accent);
  mesh(G.box, lam({ map: rep(wt, 3, 1) }), g, 0, H / 2 + .09, -D / 2 + .08, W, H, .16);
  mesh(G.box, lam({ map: rep(wt, 2.5, 1) }), g, -W / 2 + .08, H / 2 + .09, 0, .16, H, D);
  box(g, 0, H + .12, -D / 2 + .08, W + .04, .08, .22, 0x3a4442); box(g, -W / 2 + .08, H + .12, 0, .22, .08, D, 0x3a4442);
  box(g, .2, H - .18, -D / 2 + .2, 1.6, .07, .12, glow(0xf4f8f4, 1.8)); box(g, .2, H - .12, -D / 2 + .19, 1.7, .04, .14, 0x9aa09c);
  mesh(G.box, faceMat(0x2e3633, lam({ map: signTex(o.sign, 0x2a3432, 0xe8eedc, 72) })), g, -1.5, H - .2, -D / 2 + .17, 1.5, .25, .02);
  // window with a cool sky
  const win = grp(g, -W / 2 + .17, 1.25, -.4); box(win, 0, 0, 0, .04, .9, 1.3, 0x8a9a96); box(win, .015, 0, 0, .03, .78, 1.18, glow(0xa8c6d6, .7)); box(win, .03, 0, 0, .02, .78, .05, 0x8a9a96); box(win, .03, 0, 0, .02, .05, 1.18, 0x8a9a96);
  const light = new T.PointLight(0xfff0d8, 9, 8, 1.6); light.position.set(0, 1.9, .3); g.add(light);
  plant(g, 2.55, 2.0, .9);
  labs[key] = g; return g;
}
const L = (g, x, z) => new T.Vector3(g.position.x + x, 0, g.position.z + z);

const comp = labRoom('comp', -17.5, -3.5, { floor: [0xd9ddd6, 0xbfcac6], accent: 0x6f9fc0, sign: 'LAB 01 PARTS' });
shelf(comp, -1.6, -2.15); shelf(comp, -2.62, -.6, HP); desk(comp, .9, -.9); poster(comp, 1.6, 1.45, -2.41, posterTex[0]);
{ const t = grp(comp, -1.6, 0, .95); mesh(G.box, lam({ map: woodTex }), t, 0, .58, 0, 1.5, .06, .7); for (const s of [-1, 1]) box(t, s * .65, .28, 0, .06, .55, .6, 0x6a7470);
  for (let i = 0; i < 6; i++) { const bx = -.55 + (i % 3) * .55, bz = i < 3 ? -.15 : .17; box(t, bx, .67, bz, .42, .12, .26, [0xc05050, 0x5a9aa0, 0xd6b048][i % 3]); for (let k = 0; k < 3; k++) box(t, bx - .12 + k * .12, .74, bz, .07, .03, .07, 0x2a3a2a); } }
const shelfBox = mesh(G.box, productMats[1], comp, -1.6, .67 + .17, -1.95, .24, .28, .26); // the box Milo fetches
const deskBox = mesh(G.box, productMats[1], comp, .25, .76, -.7, .24, .28, .26);

const src = labRoom('src', -10.5, -3.5, { floor: [0xe2dccd, 0xcdc4ae], accent: 0x8fb88f, sign: 'LAB 02 SOURCES' });
shelf(src, -1.6, -2.15, 0, true); shelf(src, .1, -2.15, 0, true); desk(src, .9, -.9); fileCab(src, -2.6, .3, HP); fileCab(src, -2.6, 1.0, HP);
poster(src, 2.2, 1.45, -2.41, posterTex[2]); { const cb = ctex(24, 16, g => { speckle(g, 0, 0, 24, 16, 0xb08a60, .12); for (let i = 0; i < 6; i++) px(g, 2 + (i % 3) * 7, 2 + (i / 3 | 0) * 7, 5, 5, [0xf0e6a0, 0xe8b0b0, 0xb0d0e8][i % 3]); }); poster(src, 1.3, 1.45, -2.41, cb, 1, .65); }
for (let i = 0; i < 4; i++) box(src, -1.2 + i * .15, .05 + i * .03, 1.6, .3, .06, .4, 0xefece2);

const cmp = labRoom('cmp', -17.5, 3.5, { floor: [0xd6d9dd, 0xbcc3ca], accent: 0xd0a46a, sign: 'LAB 03 FIT' });
desk(cmp, .9, -.9); shelf(cmp, -1.6, -2.15); poster(cmp, 1.6, 1.45, -2.41, posterTex[1]);
{ const b = grp(cmp, -1.7, 0, .9); mesh(G.box, lam({ map: woodTex }), b, 0, .58, 0, 1.6, .06, .7); for (const s of [-1, 1]) box(b, s * .7, .28, 0, .06, .55, .6, 0x6a7470);
  const scope = grp(b, -.35, .61, 0); box(scope, 0, .17, 0, .5, .34, .36, 0x5a6a6c); mesh(G.box, faceMat(0x1a2222, lam({ map: scopeTex, emissive: 0xffffff, emissiveMap: scopeTex, emissiveIntensity: 1 })), scope, -.06, .19, .181, .28, .21, .01); for (let i = 0; i < 3; i++) box(scope, .17, .1 + i * .07, .19, .05, .04, .02, 0xd8c06a);
  box(b, .35, .73, 0, .38, .22, .3, 0x3a4446); box(b, .3, .76, .16, .12, .08, .01, glow(0xff8a50, 1.5)); box(b, .1, .62, .2, .5, .02, .03, 0xc04a3a); box(b, .1, .62, .24, .45, .02, .03, 0x2a2a2a); }
microwave(cmp, 2.1, .62, -1.95, 0); box(cmp, 2.1, .3, -1.95, 1.1, .6, .6, 0xa8aca4);

const syn = labRoom('syn', -10.5, 3.5, { floor: [0xdcd6e0, 0xc4bdcc], accent: 0xa898c8, sign: 'LAB 04 SYNTH' });
desk(syn, .9, -.9); poster(syn, 1.7, 1.45, -2.41, posterTex[0]); shelf(syn, -1.7, -2.15, 0, true);
{ const wb = grp(syn, -2.88, 1.3, .6, HP); box(wb, 0, 0, 0, 1.7, 1.05, .05, 0x9aa09c); mesh(G.box, faceMat(0xf2f2ec, lam({ map: boardTex })), wb, 0, 0, .03, 1.58, .94, .02); box(wb, 0, -.52, .07, 1.4, .04, .1, 0x6a706c); }
{ const t = grp(syn, .4, 0, 1.3); mesh(G.cyl, lam({ map: woodTex }), t, 0, .55, 0, 1.3, .06, 1.3); mesh(G.cyl6, 0x5a6260, t, 0, .27, 0, .12, .52, .12); box(t, -.2, .6, .1, .26, .02, .34, 0xf0eee6); mesh(G.cyl, 0xe8e0d0, t, .3, .63, -.15, .1, .12, .1);
  for (const [dx, dz] of [[-.85, .2], [.85, -.1], [0, .85]]) { mesh(G.cyl, 0x8a7aa8, t, dx, .3, dz, .38, .1, .38); mesh(G.cyl6, 0x4a4e50, t, dx, .15, dz, .06, .3, .06); } }
{ const wc = grp(syn, 2.4, 0, -1.9); box(wc, 0, .45, 0, .4, .9, .4, 0xdedad0); mesh(G.cyl, lam({ color: 0x8ac0e0, transparent: true, opacity: .75 }), wc, 0, 1.12, 0, .32, .45, .32); }

/* ---------------------------------------------------------------- world: pathway */
[[-4.5, .45], [-.5, 2.6], [3.5, .45]].forEach(([x, z]) => lampPost(x, z));
[[-5, -3.5, 1.2], [-2, -5.5, 1], [1.5, -3.2, 1.3], [4.5, -6, 1.1], [-3, 5.5, 1.2], [2, 5.2, 1], [5.2, 4.2, .9], [-6.3, 8.5, 1.1], [0, 9, 1.3], [-22.5, -4, 1.3], [-23, 3, 1.1], [-14, -9, 1.2], [-8, -9, 1], [20.5, -4.5, 1.2], [21, 4, 1], [10, 7.5, 1.2], [16, 7.8, 1]].forEach(([x, z, s]) => tree(x, z, s));
for (let x = -5.5; x <= 5.5; x += .55) { box(scene, x, .3, 3, .07, .6, .07, 0xc8b892); }
box(scene, 0, .46, 3, 11.1, .05, .04, 0xc8b892); box(scene, 0, .24, 3, 11.1, .05, .04, 0xc8b892);
{ const b = grp(scene, -2.2, 0, 3.6); box(b, 0, .35, 0, 1.3, .06, .4, 0x9a7a56); box(b, 0, .6, -.18, 1.3, .3, .05, 0x9a7a56); box(b, -.55, .17, 0, .06, .34, .35, 0x3a3e3c); box(b, .55, .17, 0, .06, .34, .35, 0x3a3e3c); }
{ const s = grp(scene, -6.3, 0, 2.7); mesh(G.cyl6, 0x5a4434, s, 0, .7, 0, .08, 1.4, .08); mesh(G.box, faceMat(0x8a6a42, lam({ map: signTex('FACTORY >', 0xe8dcb8, 0x3a2a1a) })), s, .35, 1.2, .05, 1.1, .24, .05); mesh(G.box, faceMat(0x8a6a42, lam({ map: signTex('< LABS', 0xe8dcb8, 0x3a2a1a) })), s, -.25, .9, .05, .8, .22, .05); }
for (let i = 0; i < 26; i++) { const x = -6 + rnd() * 12, z = rnd() < .5 ? -.2 - rnd() * 1.2 : 3.4 + rnd() * 1.5; box(scene, x, .06, z, .08, .12, .08, [0xe8d070, 0xd88aa0, 0xf0f0e8, 0x9ab0e0][i % 4]); }
for (let i = 0; i < 10; i++) { const m = mesh(G.ico, lam({ color: 0x4f6b42, flatShading: true }), scene, -6 + rnd() * 12, .2, rnd() < .5 ? -.6 - rnd() : 4 + rnd(), .5, .4, .5); m.rotation.y = rnd() * 3; }

/* ---------------------------------------------------------------- world: factory */
const fac = grp(scene, 13, 0, 0);
{
  const W = 12, D = 9, H = 3.1;
  box(fac, 0, .03, 0, W + .2, .06, D + .2, 0x2e3330);
  mesh(G.box, topMat(0x6a6e69, lam({ map: rep(concreteTex, 6, 4.5) })), fac, 0, .07, 0, W, .04, D);
  mesh(G.box, lam({ map: rep(corrTex, 12, 1) }), fac, 0, H / 2 + .09, -D / 2 + .1, W, H, .2);
  const lw = lam({ map: rep(corrTex, 5, 1) });
  mesh(G.box, lw, fac, -W / 2 + .1, H / 2 + .09, -2.05, .2, H, 4.9); mesh(G.box, lw, fac, -W / 2 + .1, H / 2 + .09, 3.55, .2, H, 1.9);
  box(fac, -W / 2 + .1, H - .3, 1.5, .2, .6, 2.2, 0x46504d); box(fac, -W / 2 + .1, H - .72, 1.5, .3, .25, 2.4, 0x7a8480);
  for (const z of [.38, 2.62]) mesh(G.box, lam({ map: rep(hazardTex, 1, 6) }), fac, -W / 2 + .1, 1.2, z, .26, 2.3, .12);
  box(fac, 0, H + .15, -D / 2 + .1, W + .1, .12, .3, 0x2c3432); box(fac, -W / 2 + .1, H + .15, 0, .3, .12, D, 0x2c3432);
  for (let i = 0; i < 5; i++) { const x = -4.4 + i * 2.2; box(fac, x, 2.35, -D / 2 + .21, 1.5, .6, .04, 0x3a4442); box(fac, x, 2.35, -D / 2 + .23, 1.38, .5, .03, glow(0x9ac2d0, .6)); }
  mesh(G.box, faceMat(0x2c3432, lam({ map: signTex('FORGE WORKS', 0x26302e, 0xf0c050, 72) })), fac, -3.6, 1.55, -D / 2 + .22, 2.4, .4, .02);
  mesh(G.box, faceMat(0x1a2222, lam({ map: statusTex, emissive: 0xffffff, emissiveMap: statusTex, emissiveIntensity: .9 })), fac, 1.2, 1.5, -D / 2 + .22, 1.6, .6, .03);
  for (const [x, z] of [[-2.5, 0], [2.5, 0]]) { const l = new T.PointLight(0xfff2dc, 12, 10, 1.5); l.position.set(x, 2.6, z); fac.add(l); }
  // floor zone around the assembly table
  const hz = lam({ map: rep(hazardTex, 8, .25) });
  for (const [x, z, w, d] of [[-.5, -1.5, 4.4, .12], [-.5, 2.1, 4.4, .12]]) mesh(G.box, hz, fac, x, .095, z, w, .01, d);
  for (const x of [-2.7, 1.7]) mesh(G.box, lam({ map: rep(hazardTex, .25, 8) }), fac, x, .095, .3, .12, .01, 3.7);
}
// conveyor
const belt = lam({ map: beltTex });
{ const c = grp(fac, 0, 0, -3.3); mesh(G.box, faceMat(0x3a4442, belt).map((m, i) => i === 2 ? belt : m), c, 0, .78, 0, 9.2, .06, .8);
  box(c, 0, .7, 0, 9.4, .1, .95, 0x4f7f7a); for (let x = -4.4; x <= 4.4; x += 1.1) { box(c, x, .35, .38, .08, .7, .08, 0x3a4442); box(c, x, .35, -.38, .08, .7, .08, 0x3a4442); }
  box(c, 4.6, .9, 0, .2, .4, 1.0, 0xd8b23a); box(c, -4.6, .9, 0, .2, .4, 1.0, 0xd8b23a); }
const beltCrates = []; for (let i = 0; i < 5; i++) beltCrates.push(crate(fac, 0, .81, -3.3, .42));
{ const bin = grp(fac, 2.6, 0, -2.45); box(bin, 0, .35, 0, .9, .7, .5, 0x6a7a76); box(bin, 0, .72, 0, .85, .06, .45, 0x4a5652); for (let i = 0; i < 5; i++) box(bin, -.3 + i * .15, .78, 0, .1, .06, .2, [0x34444a, 0x3d8267, 0x609d8b, 0x3c4c52, 0x758c8c][i]); }
// assembly table
const TABLE = new T.Vector3(12.5, .98, .35);
{ const t = grp(fac, -.5, 0, .35); box(t, 0, .9, 0, 3, .1, 1.4, 0x7e8b7a); box(t, 0, .45, 0, 2.7, .8, 1.1, 0x354743); box(t, 0, .4, .56, 2.4, .3, .02, 0x2a3836); }
const statusLamp = box(fac, -.5, .55, 1.08, .5, .14, .04, glow(0xd8a040, 1.6));
// robot welding cell
const robot = { base: grp(fac, 3.8, 0, 1.8) };
{ const r = robot; box(r.base, .9, .45, 0, 1.2, .9, 1.2, 0x5a6462); box(r.base, .9, .95, 0, .6, .12, .5, 0x8a9490); mesh(G.cyl, 0xd8b23a, r.base, 0, .2, 0, .7, .4, .7);
  r.turn = grp(r.base, 0, .4, 0); mesh(G.cyl, 0xe0a040, r.turn, 0, .1, 0, .5, .2, .5);
  r.sh = grp(r.turn, 0, .2, 0); box(r.sh, 0, .5, 0, .2, 1.0, .2, 0xe0a040);
  r.el = grp(r.sh, 0, 1.0, 0); box(r.el, 0, .4, 0, .16, .8, .16, 0xe0a040); mesh(G.ball, 0x3a3e3c, r.el, 0, 0, 0, .26, .26, .26);
  r.tip = grp(r.el, 0, .82, 0); box(r.tip, 0, .05, 0, .08, .14, .08, 0x2a2e2c); box(r.tip, 0, .14, 0, .05, .06, .05, glow(0xffb060, 2)); }
// break corner, racks, crates
{ const v = ctex(24, 40, g => { px(g, 0, 0, 24, 40, 0x2a3a4a); px(g, 2, 2, 15, 30, 0x0e1418); for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) px(g, 3 + c * 3.5 | 0, 3 + r * 6, 2, 4, LABEL_C[(r * 3 + c) % 6]); px(g, 18, 6, 4, 6, 0x9ac0a8); px(g, 2, 34, 15, 4, 0x0a0a0a); });
  const vm = grp(fac, 5.2, 0, 3.4, -HP); mesh(G.box, faceMat(0x2a3a4a, lam({ map: v, emissive: 0xffffff, emissiveMap: v, emissiveIntensity: .55 })), vm, 0, .9, 0, .8, 1.8, .6); }
microwave(fac, 5.3, .7, 2.2, -HP); box(fac, 5.35, .35, 2.2, .6, .7, 1, 0x8a9490);
{ const rk = grp(fac, -2.6, 0, -2.5); for (const s of [-1, 1]) box(rk, s * .9, 1, 0, .08, 2, .6, 0x4a6a8a); for (let i = 0; i < 3; i++) { box(rk, 0, .3 + i * .7, 0, 1.9, .06, .6, 0xd8b23a); for (let k = 0; k < 3; k++) crate(rk, -.6 + k * .6, .33 + i * .7, 0, .4); } }
for (const [x, z] of [[-4.6, -1.0], [-4.6, -.5], [-4.15, -.75]]) crate(fac, x, .09, z, .45); crate(fac, -4.4, .54, -.75, .45);
for (const [x, z] of [[-5.3, 4], [-4.8, 4.1]]) { mesh(G.cyl, 0x4a7a8a, fac, x, .5, z, .45, .8, .45); box(fac, x, .91, z, .2, .02, .2, 0x3a5a6a); }
plant(fac, 5.3, -4, 1.1);
// scanner gantry
const gantry = grp(fac, -.5, 0, .35);
{ for (const z of [-.85, .85]) box(gantry, 0, 1.4, z, .12, 1.0, .12, 0x8a9490); box(gantry, 0, 1.92, 0, .16, .12, 1.85, 0x8a9490); box(gantry, 0, 1.84, 0, .06, .04, 1.6, glow(0x7affc8, 2.5)); }
const scanBeam = mesh(G.box, psx(new T.MeshBasicMaterial({ color: 0x7affc8, transparent: true, opacity: .28, depthWrite: false })), gantry, 0, 1.4, 0, .04, .85, 1.6); scanBeam.castShadow = false;
const tableFolder = folder(); tableFolder.position.set(11.3, .99, .7); tableFolder.rotation.y = .3; scene.add(tableFolder);

// The wristband, assembled in five visible stages.
const assembly = grp(scene, TABLE.x, TABLE.y, TABLE.z); assembly.scale.setScalar(.42);
// The old wristband study is retained but not presented as the rover prototype.
assembly.visible = false;
const pieces = [];
function part(y, build) { const g = grp(assembly); g.userData.y = y; build(g); pieces.push(g); return g; }
const partBuilds = [
  g => { box(g, 0, 0, 0, 2.5, .18, 2.1, 0x34444a); for (const z of [-1, 1]) box(g, 0, .25, z, 2.5, .5, .14, 0x536971); for (const x of [-1.18, 1.18]) box(g, x, .25, 0, .14, .5, 2.1, 0x536971); },
  g => { box(g, 0, 0, 0, 2.05, .1, 1.65, 0x3d8267); box(g, -.35, .14, 0, .75, .2, .7, 0x263c3b); box(g, .58, .1, .25, .45, .15, .55, 0xc0c7af); for (let x = -.8; x < 1; x += .22) { box(g, x, .1, .68, .1, .12, .17, 0xd1b36a); box(g, x, .1, -.68, .1, .12, .17, 0xd1b36a); } box(g, .6, .15, -.4, .12, .1, .12, glow(0x7affc8, 2)); },
  g => { box(g, 0, 0, 0, .8, .14, .7, 0x609d8b); box(g, 0, .12, 0, .42, .16, .34, 0x1d3335); box(g, -.26, .09, .23, .1, .05, .1, 0xdeb265); box(g, .26, .09, .23, .1, .05, .1, 0xdeb265); box(g, 0, .21, 0, .2, .02, .16, glow(0xff6a6a, 2)); },
  g => { for (const x of [-2, 2]) { box(g, x, 0, 0, 1.55, .22, .98, 0x3c4c52); for (let j = 0; j < 4; j++) box(g, x - .48 + j * .28, .12, 0, .09, .02, .2, 0x17272c); } box(g, 2.7, .05, 0, .23, .3, 1.15, 0xadb8ab); },
  g => { box(g, 0, 0, 0, 2.5, .19, 2.1, 0x758c8c); box(g, 0, .11, 0, .88, .04, .9, 0x2e494d); box(g, 0, .14, 0, .62, .02, .63, glow(0x8fe0c4, 1.2)); for (const x of [-1, 1]) for (const z of [-.8, .8]) box(g, x, .11, z, .09, .03, .09, 0xc8d0b9); }
];
[0, .22, .49, -.12, .7].forEach((y, i) => part(y, partBuilds[i]));

/* ---------------------------------------------------------------- crew */
const ada = person({ id: 'ada', name: 'Ada', role: 'Research lead', skin: 0xf1c9a5, hair: 0x3b2a24, style: 'bun', outfit: 'lab', shirt: 0x6c8fb0, accent: 0xd9774a, pants: 0x3a4250 });
const milo = person({ id: 'milo', name: 'Milo', role: 'Component scout', skin: 0xe2b48c, hair: 0x8a5a32, style: 'short', outfit: 'lab', shirt: 0x6f9a6a, accent: 0x4f86b5, pants: 0x4a4038 });
const bea = person({ id: 'bea', name: 'Bea', role: 'Evidence specialist', skin: 0xc58f68, hair: 0x23201f, style: 'pony', outfit: 'lab', shirt: 0xb57aa0, accent: 0x8a5aa0, glasses: true, clip: 0xe8c050 });
const pip = person({ id: 'pip', name: 'Pip', role: 'Research coordinator', skin: 0xf3d0b0, hair: 0x4a3024, style: 'bob', outfit: 'apron', shirt: 0xd2d2ca, accent: 0x3e5f93, pants: 0x3a3e48 });
const sol = person({ id: 'sol', name: 'Sol', role: 'Parts assistant', skin: 0xd9a77f, hair: 0x2e2a28, style: 'short', outfit: 'lab', shirt: 0xd0a85a, accent: 0x5a9aa0 });
const noor = person({ id: 'noor', name: 'Noor', role: 'Archivist', skin: 0xa8774f, hair: 0x1c1716, style: 'bob', outfit: 'lab', shirt: 0x7a9f9a, accent: 0xc05050, clip: 0xd88aa0 });
const otto = person({ id: 'otto', name: 'Otto', role: 'Assembly', skin: 0xe0b08a, hair: 0x4a3324, style: 'short', outfit: 'overall', shirt: 0x9aa3a0, accent: 0xd9823e, hat: 0xe8c040, pants: 0x3a4048 });
const kit = person({ id: 'kit', name: 'Kit', role: 'Inspection', skin: 0xf0c7a2, hair: 0xa8642e, style: 'pony', outfit: 'overall', shirt: 0xd8d4c4, accent: 0x4a6f8f, pants: 0x34404a });
const rae = person({ id: 'rae', name: 'Rae', role: 'Logistics', skin: 0xbf8a62, hair: 0x2b2220, style: 'short', outfit: 'overall', shirt: 0xc8c4b4, accent: 0x6f8a52, hat: 0xe8c040 });

const props = {
  box: (() => { const m = new T.Mesh(G.box, productMats[1]); m.scale.set(.24, .28, .26); return m; })(),
  papers: papers(), folder: folder(),
  crate: (() => { const m = new T.Mesh(G.box, lam({ map: crateTex })); m.scale.setScalar(.4); m.position.y = .05; return m; })()
};
props.folder.rotation.x = -.35;
const kitParts = partBuilds.map(b => { const g = new T.Group(); b(g); g.scale.setScalar(.22); g.visible = false; return g; });
const held = new Map();
function hold(c, key) {
  if (held.get(c) === key) return; held.set(c, key);
  c.carry.clear();
  if (!key) return;
  if (key.startsWith('part')) c.carry.add(kitParts[+key.slice(4)]);
  else if (key === 'readPapers') { const p = papers(); p.position.set(0, -.05, 0); c.carry.add(p); }
  else c.carry.add(props[key]);
}

/* ---------------------------------------------------------------- particles */
const NP = 320, pPos = new Float32Array(NP * 3).fill(-99), pCol = new Float32Array(NP * 3), pVel = new Float32Array(NP * 3), pLife = new Float32Array(NP);
const pGeo = new T.BufferGeometry(); pGeo.setAttribute('position', new T.BufferAttribute(pPos, 3)); pGeo.setAttribute('color', new T.BufferAttribute(pCol, 3));
const points = new T.Points(pGeo, new T.PointsMaterial({ size: .07, sizeAttenuation: true, vertexColors: true, depthWrite: false })); points.frustumCulled = false; scene.add(points);
let pNext = 0; const tmpC = new T.Color();
function emit(pos, n, colors, spd = 2, up = 2) {
  for (let k = 0; k < n; k++) {
    const i = pNext = (pNext + 1) % NP; pPos.set([pos.x, pos.y, pos.z], i * 3);
    pVel.set([(rnd() - .5) * spd, up * (.5 + rnd()), (rnd() - .5) * spd], i * 3); pLife[i] = .5 + rnd() * .9;
    tmpC.set(colors[k % colors.length]); pCol.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
  }
}
function stepParticles(dt) {
  for (let i = 0; i < NP; i++) {
    if (pLife[i] <= 0) continue; pLife[i] -= dt;
    if (pLife[i] <= 0) { pPos[i * 3 + 1] = -99; continue; }
    pVel[i * 3 + 1] -= 6 * dt; for (let a = 0; a < 3; a++) pPos[i * 3 + a] += pVel[i * 3 + a] * dt;
    if (pPos[i * 3 + 1] < .1) { pPos[i * 3 + 1] = .1; pVel[i * 3 + 1] *= -.3; pVel[i * 3] *= .6; pVel[i * 3 + 2] *= .6; }
  }
  pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true;
}
otto.onHit = () => emit(new T.Vector3(TABLE.x - .3, TABLE.y + .25, TABLE.z), 6, [0xffd070, 0xffa040, 0xfff0c0], 2.5, 1.6);
const tipPos = new T.Vector3();

/* ---------------------------------------------------------------- story */
const phases = [
  { end: 10, title: 'Scouting the right components', detail: 'Milo pulls parts off the shelf while Ada frames the brief.' },
  { end: 18, title: 'Reading the evidence', detail: 'Bea checks datasheets, Ada maps the trade-offs, Pip collects findings.' },
  { end: 26, title: 'Handing off to engineering', detail: 'Illustrative handoff; catalog checks and evidence appear in the workbench below.' },
  { end: 46, title: 'Exploring a digital draft', detail: 'Illustrative workshop animation. Inspect the actual Rover R1 in the workbench below.' },
  { end: LOOP, title: 'Inspection and review', detail: 'Animation only, not validation. Review unresolved constraints before any physical work.' }
];
const script = [
  [0, 3.5, ada, 'Brief: Rover R1, one motor choice under $30.'], [3.5, 7, milo, 'Compare catalog options in the workbench below.'], [7, 10, bea, 'Opening the sensor datasheets.'],
  [10, 14, pip, 'Collecting everyone’s findings!'], [14, 18, ada, 'Catalog facts and unknowns must remain separate.'],
  [18, 22, pip, 'Running the brief over to engineering…'], [22, 26, otto, 'Brief received. Firing up the line!'],
  [26, 30, otto, 'First, the enclosure.'], [30, 34, kit, 'Controller board, coming through.'], [34, 38, otto, 'Consider nominal voltage and driver limits.'],
  [38, 42, kit, 'Mounting and shaft fit remain unknown.'], [42, 46, otto, 'Closing the protective cover.'], [46, 50, kit, 'Preview only. Physical checks remain unresolved.'], [50, 54, pip, 'Explain the choice. Inspect the digital draft below.']
];
const activity = { idle: 'Taking a breather.', type: 'Typing up findings.', walk: 'On the move.', carry: 'Carrying something important.', read: 'Reading a datasheet.', write: 'Mapping trade-offs on the whiteboard.', reach: 'Handing over notes.', place: 'Placing a part.', hammer: 'Tapping a part into place.', screw: 'Fastening screws.', sort: 'Sorting components.', file: 'Pulling source files.', inspect: 'Inspecting the work.', wave: 'Saying hello!', cheer: 'Celebrating!' };

const PIP_KEYS = [[0, -16.6, 1.9, 0], [10, -16.6, 1.9, 0], [10.9, -14, 1.9], [11.6, -14, -.1], [12.8, -16.6, -3.3], [12.85, -16.6, -3.3, PI], [14.2, -16.6, -3.3, PI], [15, -14, -.2], [16.2, -9.6, -.2], [17, -9.6, -3.2], [17.05, -9.6, -3.2, PI], [18.4, -9.6, -3.2, PI], [19.3, -9, -.4], [20.3, -6.3, 1.5], [25, 7.6, 1.5], [26.2, 10.9, 1.75], [26.25, 10.9, 1.75, 2.3]];
const ADA_KEYS = [[0, -9.6, 1.9, 0], [10, -9.6, 1.9, 0], [10.5, -11.2, 1.9], [11.2, -12.7, 4.1], [11.25, -12.7, 4.1, -HP], [17, -12.7, 4.1, -HP], [17.6, -11.2, 1.9], [18.1, -9.6, 1.9], [18.15, -9.6, 1.9, 0]];
const MILO_KEYS = [[0, -16.6, -5.1, 0], [2, -16.6, -5.1, 0], [3.2, -19.1, -4.95], [3.25, -19.1, -4.95, PI], [4.8, -19.1, -4.95, PI], [6.2, -16.6, -5.1], [6.25, -16.6, -5.1, 0]];
const RAE_KEYS = [[0, 8.4, -1.0, PI], [.6, 8.4, -1.0, PI], [2.2, 8.9, -2.5], [2.25, 8.9, -2.5, PI], [3, 8.9, -2.5, PI], [4.6, 8.4, -1.0], [4.65, 8.4, -1.0, PI]];

function direct(t) {
  const out = new Map(), at = (x, z, face) => ({ x, z, face, moving: false });
  let k = track(ADA_KEYS, t); k.pose = k.moving ? 'walk' : t >= 46 ? 'cheer' : t > 11.2 && t < 17 ? 'write' : 'type'; out.set(ada, k);
  k = track(MILO_KEYS, t); k.pose = k.moving ? (t > 4.8 ? 'carry' : 'walk') : t >= 46 ? 'cheer' : t >= 3.25 && t < 4.8 ? 'reach' : 'type'; k.carry = t >= 4.8 && t < 6.25 ? 'box' : null; out.set(milo, k);
  k = at(-9.6, -5.1, 0); k.pose = t >= 46 ? 'cheer' : t < 10 ? 'read' : t >= 16.8 && t < 18.4 ? 'reach' : 'type'; k.carry = t < 10 ? 'readPapers' : null; out.set(bea, k);
  k = at(-19.1, -3.15, 0); k.pose = t >= 46 ? 'cheer' : 'sort'; out.set(sol, k);
  k = at(-12.4, -3.2, -HP); k.pose = t >= 46 ? 'cheer' : 'file'; out.set(noor, k);
  k = track(PIP_KEYS, t); k.carry = t >= 14.2 && t < 18.4 ? 'papers' : t >= 18.4 && t < 26.2 ? 'folder' : null;
  k.pose = k.moving ? (k.carry ? 'carry' : 'walk') : t >= 46 ? 'cheer' : t < 10 ? 'type' : (t >= 12.85 && t < 14.2) || (t >= 17.05 && t < 18.4) ? 'reach' : t >= 26.2 && t < 29 ? 'wave' : 'idle'; out.set(pip, k);
  const step = Math.floor((t - 26) / 4);
  k = at(12.0, -.75, 0); k.pose = t < 22 ? 'idle' : t < 26 ? 'wave' : t < 46 ? (step % 2 ? 'screw' : 'hammer') : t < 50 ? 'inspect' : 'cheer'; out.set(otto, k);
  if (t >= 26 && t < 46) {
    const s = 26 + step * 4, lt = t - s;
    k = track([[s, 13.2, -.75, 0], [s + 1.2, 15.6, -1.95], [s + 1.25, 15.6, -1.95, PI], [s + 1.8, 15.6, -1.95, PI], [s + 3, 13.2, -.75], [s + 3.05, 13.2, -.75, 0]], t);
    k.pose = k.moving ? (lt > 1.8 ? 'carry' : 'walk') : lt >= 1.25 && lt < 1.8 ? 'reach' : lt >= 3 && lt < 3.6 ? 'place' : 'idle';
    k.carry = lt >= 1.8 && lt < 3.3 ? 'part' + step : null;
  } else { k = at(13.2, -.75, 0); k.pose = t >= 50 ? 'cheer' : t >= 46 ? 'inspect' : 'idle'; }
  out.set(kit, k);
  const lt = t % 6; k = track(RAE_KEYS, lt); k.carry = lt >= .6 && lt < 2.6 ? 'crate' : null;
  k.pose = t >= 50 ? 'cheer' : k.moving ? (k.carry ? 'carry' : 'walk') : lt < .6 ? 'reach' : lt >= 2.25 && lt < 3 ? 'place' : 'idle'; out.set(rae, k);
  return out;
}

/* ---------------------------------------------------------------- DOM overlays */
const tags = [];
function label(text, sub, x, y, z) { const el = document.createElement('div'); el.className = 'room-label'; el.innerHTML = `${text}<small>${sub}</small>`; labelsEl.append(el); tags.push({ el, pos: new T.Vector3(x, y, z) }); }
label('PARTS LAB', 'Milo · Sol', -17.5, 2.6, -6.2); label('SOURCE LAB', 'Bea · Noor', -10.5, 2.6, -6.2);
label('FIT LAB', 'Pip', -17.5, 2.6, .8); label('SYNTHESIS LAB', 'Ada', -10.5, 2.6, .8);
label('ENGINEERING FACTORY', 'Otto · Kit · Rae', 13, 3.6, -4.6);
crew.forEach(c => { c.bubble = document.createElement('div'); c.bubble.className = 'bubble'; labelsEl.append(c.bubble); });

let stage = -1, selected = null;
const timelineNames = ['Scout', 'Read sources', 'Handoff', 'Assemble', 'Inspect'];
document.querySelectorAll('#timeline li').forEach((li, i) => li.innerHTML = `${timelineNames[i]} <span>0${i + 1}</span>`);
function setStage(s) {
  stage = s; $('#phase-title').textContent = phases[s].title; $('#phase-detail').textContent = phases[s].detail;
  document.querySelectorAll('#timeline li').forEach((e, i) => e.className = i === s ? 'active' : i < s ? 'done' : '');
  $('#handoff').disabled = s === 4; if (soundOn) chirp(330 + s * 75);
}
function showPerson(c) { selected = c; $('#employee').hidden = false; $('#employee-name').textContent = c.name; $('#employee-role').textContent = c.role; $('#employee-task').textContent = activity[c.pose]; }
$('#close-employee').onclick = () => { $('#employee').hidden = true; selected = null; };

const v3 = new T.Vector3();
function toScreen(pos) { v3.copy(pos).project(camera); return { x: (v3.x * .5 + .5) * host.clientWidth, y: (-v3.y * .5 + .5) * host.clientHeight, on: v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1 }; }
function updateOverlays(t) {
  const line = script.find(l => t >= l[0] && t < l[1]);
  crew.forEach(c => {
    const speaking = line && line[2] === c, show = speaking || selected === c;
    const p = toScreen(v3.set(c.root.position.x, c.root.position.y + 2.05, c.root.position.z));
    c.bubble.style.opacity = show && p.on ? '1' : '0'; c.bubble.setAttribute('aria-hidden', String(!show));
    if (show) { c.bubble.style.transform = `translate(${p.x | 0}px,${p.y | 0}px) translate(-50%,-100%)`; const txt = speaking ? line[3] : activity[c.pose]; const html = `<b>${c.name} · ${c.role}</b>${txt}`; if (c.bubble._h !== html) c.bubble.innerHTML = c.bubble._h = html; }
  });
  tags.forEach(o => { const p = toScreen(o.pos); o.el.style.transform = `translate(${p.x | 0}px,${p.y | 0}px) translate(-50%,0)`; o.el.style.opacity = p.on ? '1' : '0'; });
}

/* ---------------------------------------------------------------- world update */
let lastScreen = -1;
function updateWorld(t, dt) {
  const s = phases.findIndex(p => t < p.end); if (s !== stage) setStage(Math.max(0, s));
  const plan = direct(t);
  crew.forEach(c => {
    const k = plan.get(c);
    c.root.position.set(k.x, .09, k.z);
    c.yaw = Math.abs(t - (c.lastT ?? t)) > 1 ? k.face : lerpAngle(c.yaw, k.face, 1 - Math.exp(-12 * dt)); c.lastT = t;
    c.root.rotation.y = c.yaw; applyPose(c, k.pose, t, dt); hold(c, k.carry || null);
  });
  shelfBox.visible = t < 4.8; deskBox.visible = t >= 6.25;
  drawBoard((t - 11.25) / 5.75);
  if (Math.floor(t * 8) !== lastScreen) { lastScreen = Math.floor(t * 8); drawScreen(t); }
  // factory
  const running = t >= 22, beltPos = running ? (t - 22) * .9 : 0;
  beltTex.offset.x = -beltPos / 9.2 * 9;
  beltCrates.forEach((c, i) => { c.position.x = -4.3 + ((beltPos + i * 1.9) % 9.5); c.visible = c.position.x < 4.3; });
  pieces.forEach((p, i) => { const tp = 26 + i * 4 + 3.0, u = ease((t - tp) / .5); p.visible = t >= tp; p.position.y = p.userData.y + (1 - u) * 1.6; p.rotation.y = (1 - u) * .6; if (p.visible && !p.userData.landed && u >= 1) { p.userData.landed = 1; emit(v3.set(TABLE.x, TABLE.y + .3, TABLE.z), 10, [0xe8e0c0, 0x9ac0b0], 1.8, 1.2); } if (t < tp) p.userData.landed = 0; });
  assembly.rotation.y = t >= 50 ? (t - 50) * .9 : 0;
  assembly.position.y = TABLE.y + (t >= 50 ? .15 + Math.sin(t * 3) * .03 : 0);
  tableFolder.visible = t >= 26.2;
  const built = pieces.filter(p => p.visible).length; drawStatus(t >= 50 ? 5 : Math.min(built, 4) + (t >= 46 ? 1 : 0), t);
  statusLamp.material = statusWait;
  gantry.visible = t >= 46 && t < 50.5; gantry.position.x = -.5 + Math.sin((t - 46) * 1.7) * 1.3;
  if (t >= 50 && t < 51.2 && Math.floor(t * 20) % 2) emit(v3.set(TABLE.x, TABLE.y + .4, TABLE.z), 8, [0xe85a5a, 0xf0c050, 0x6ac0a0, 0x8a9ae8, 0xf0f0e8], 4, 4.5);
  // welding robot
  const r = robot, wt = t * 1.1; r.turn.rotation.y = -1.6 + Math.sin(wt * .6) * .5; r.sh.rotation.z = -.55 + Math.sin(wt * 1.3) * .15; r.el.rotation.z = -1.25 + Math.sin(wt * 1.7) * .15;
  if (running && Math.sin(t * 2.6) > .2 && rnd() < .6) { r.tip.getWorldPosition(tipPos); tipPos.y += .15; emit(tipPos, 2, [0xffd070, 0xffa040, 0xffffff], 2, 1.4); }
  stepParticles(dt);
}
const statusWait = glow(0xd8a040, 1.6);

/* ---------------------------------------------------------------- camera + input */
let yaw = .42, pitch = .62, zoom = 1, camMode = 'auto';
const focus = new T.Vector3(-14, .6, 0), want = new T.Vector3();
function resize() {
  const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
  const dpr = Math.min(devicePixelRatio || 1, 2), lw = Math.round(w * dpr), lh = Math.round(h * dpr);
  renderer.setSize(lw, lh, false); rt.setSize(lw, lh); snapU.value.set(lw * .4, lh * .4);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host); resize();
let camDist = 52;
function updateCamera(t, dt) {
  let d = 25;
  if (camMode === 'factory') want.set(13, .6, 0);
  else if (camMode === 'labs') want.set(-14, .6, 0);
  else if (camMode === 'all') { want.set(2.8, .6, -1.2); d = 47; }
  else if (t < 3) { want.set(2.8, .6, -1.2); d = 47; }            // open on the whole site
  else if (t < 17) want.set(-14, .6, 0);
  else if (t < 26) { want.set(clamp(pip.root.position.x, -12, 13), .6, .8); d = 30; }
  else want.set(13, .6, 0);
  const k = 1 - Math.exp(-(camMode === 'auto' && t >= 17 && t < 26 ? 2.6 : 1.6) * dt);
  focus.lerp(want, k);
  camDist = lerp(camDist, d / zoom * Math.max(1, 1.45 / camera.aspect), k);
  const dist = camDist;
  camera.position.set(focus.x + Math.sin(yaw) * Math.cos(pitch) * dist, focus.y + Math.sin(pitch) * dist, focus.z + Math.cos(yaw) * Math.cos(pitch) * dist);
  camera.lookAt(focus);
}
// In-scene camera nav (the page's own controls are hidden in embed mode).
{
  const nav = document.createElement('div'); nav.className = 'scene-nav'; nav.setAttribute('role', 'group'); nav.setAttribute('aria-label', 'Camera');
  [['auto', 'Story'], ['all', 'Whole site'], ['labs', 'Labs'], ['factory', 'Factory']].forEach(([m, txt]) => {
    const b = document.createElement('button'); b.textContent = txt; b.dataset.cam = m;
    b.onclick = () => { camMode = m; zoom = 1; nav.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
    if (m === 'auto') b.className = 'on'; nav.append(b);
  });
  host.append(nav);
}
let drag = null, moved = false;
canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; moved = false; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 2) moved = true; yaw -= dx * .005; pitch = clamp(pitch + dy * .004, .28, 1.25); drag = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', e => {
  drag = null; if (moved) return;
  const r = canvas.getBoundingClientRect(), ray = new T.Raycaster();
  ray.setFromCamera(new T.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  const hit = ray.intersectObjects(pickables)[0]; if (hit) showPerson(crew[hit.object.userData.crew]); else { selected = null; $('#employee').hidden = true; }
});
canvas.addEventListener('pointercancel', () => drag = null);
canvas.addEventListener('wheel', e => { e.preventDefault(); zoom = clamp(zoom - e.deltaY * .001, .6, 2.6); }, { passive: false });
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { camMode = 'auto'; zoom = b.dataset.view === 'all' ? 1 : 1.7; document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x === b)); $('#engineering-view').classList.remove('active'); });
$('#reset-camera').onclick = () => { yaw = .42; pitch = .62; document.querySelector('[data-view="all"]').click(); };
$('#engineering-view').onclick = () => { camMode = camMode === 'factory' ? 'auto' : 'factory'; $('#engineering-view').classList.toggle('active', camMode === 'factory'); $('#engineering-view').textContent = camMode === 'factory' ? 'Back to research' : 'Engineering'; };

/* ---------------------------------------------------------------- playback */
let elapsed = 0, paused = false, speed = 1, last = performance.now(), audio = null, soundOn = false;
const setPaused = p => { paused = p; $('#pause').textContent = p ? 'Play' : 'Pause'; $('#pause').setAttribute('aria-pressed', String(p)); };
$('#pause').onclick = () => setPaused(!paused); setPaused(paused);
$('#restart').onclick = () => { elapsed = 0; setPaused(false); };
$('#speed').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? .5 : 1; $('#speed').textContent = speed + '×'; };
$('#handoff').onclick = () => { elapsed = stage <= 0 ? 10 : phases[Math.min(stage, 3)].end; setPaused(false); };
function chirp(f) { if (!audio) return; const o = audio.createOscillator(), g = audio.createGain(); o.type = 'square'; o.frequency.setValueAtTime(f, audio.currentTime); o.frequency.exponentialRampToValueAtTime(f * 1.5, audio.currentTime + .12); g.gain.setValueAtTime(.02, audio.currentTime); g.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .25); o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + .25); }
$('#sound').onclick = () => { soundOn = !soundOn; if (soundOn) { audio ??= new AudioContext(); audio.resume(); chirp(440); } $('#sound').textContent = soundOn ? 'Sound on' : 'Sound off'; $('#sound').setAttribute('aria-pressed', String(soundOn)); };

function frame(now) {
  const dt = Math.min((now - last) / 1000, .05); last = now;
  if (!paused) elapsed = (elapsed + dt * speed) % LOOP;
  updateWorld(elapsed, paused ? 0 : dt * speed);
  updateCamera(elapsed, dt);
  updateOverlays(elapsed);
  renderer.setRenderTarget(rt); renderer.render(scene, camera);
  renderer.setRenderTarget(null); renderer.render(postScene, postCam);
  requestAnimationFrame(frame);
}
$('#loading').hidden = true; requestAnimationFrame(frame);

// Local presentation controls only; there are deliberately no network or backend handlers.
window.ForgeCamera = m => { const b = document.querySelector(`.scene-nav [data-cam="${m}"]`); b?.click(); };
window.demoState = () => ({ stage, elapsed, paused, crew: crew.length, view: camMode });
window.ForgeDiorama = { pause: () => setPaused(true), play: () => setPaused(false), restart: () => { elapsed = 0; }, setProgress: s => { elapsed = clamp(s, 0, LOOP - .01); }, getState: () => window.demoState() };
