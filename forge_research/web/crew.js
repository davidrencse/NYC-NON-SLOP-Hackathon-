// A tiny engineering crew that "builds" whatever model the viewer shows.
//
// Purely decorative: parts fly in one at a time while three chibi engineers
// walk around the model swinging their tools, cheer when it is done, then the
// parts drift apart and the cycle starts again. The crew model is made by
// tools/make_crew.py (models/crew.glb).
import { Box3, Scene, Vector3 } from "./vendor/three-runtime.js";

// The vendored three build does not export Group; a nested Scene is a plain
// Object3D container for our purposes.
const Group = Scene;

const CYCLE = 11; // seconds per build loop
const BUILD = [0.8, 6.8]; // window in which parts land
const CHEER = [7.0, 9.2]; // everything assembled, crew celebrates
const FLIGHT = 0.9; // seconds per part flight
const CREW_HEIGHT = 1.08; // units in crew.glb

const ease = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const crewUrl = new URL("./models/crew.glb", import.meta.url).href;

export function createCrew(loader, scene) {
  const holder = new Group();
  holder.visible = false;
  scene.add(holder);
  let workers = [];
  let parts = [];
  let ring = 0;
  let height = 0;
  let centre = new Vector3();
  let floor = 0;

  const ready = loader.loadAsync(crewUrl).then(gltf => {
    // Each worker_i becomes its own group so it can walk the ring.
    for (const node of [...gltf.scene.getObjectByName("world")?.children ?? gltf.scene.children]) {
      if (!/^worker_\d$/.test(node.name)) continue;
      node.position.set(0, 0, 0);
      const group = new Group();
      group.add(node);
      const limb = s => node.getObjectByName(`${node.name}_${s}`);
      workers.push({ group, root: node, head: limb("head"), legL: limb("leg_l"), legR: limb("leg_r"), armL: limb("arm_l"), armR: limb("arm_r") });
      holder.add(group);
    }
  }).catch(() => { workers = []; });

  return {
    // Fit the crew around a freshly loaded model and prepare its parts.
    async attach(root) {
      await ready;
      const box = new Box3().setFromObject(root);
      centre = box.getCenter(new Vector3());
      const size = box.getSize(new Vector3());
      const span = Math.max(size.x, size.y, size.z);
      height = span * 0.42;
      ring = Math.max(size.x, size.z) / 2 + height * 0.55;
      floor = box.min.y;
      const scale = height / CREW_HEIGHT;
      for (const w of workers) w.group.scale.setScalar(scale);
      holder.visible = workers.length > 0;

      // Parts: the top-level pieces of the model, ordered bottom to top so the
      // build reads naturally (base first, lid last).
      let top = root.children;
      while (top.length === 1 && top[0].children.length) top = top[0].children;
      parts = top.map(object => {
        const b = new Box3().setFromObject(object);
        const c = b.isEmpty() ? centre.clone() : b.getCenter(new Vector3());
        const dir = c.clone().sub(centre).setY(0);
        if (dir.lengthSq() < 1e-12) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        dir.normalize();
        return { object, home: object.position.clone(), dir, low: c.y, scale: object.scale.clone() };
      }).sort((a, b) => a.low - b.low);
      const n = Math.max(parts.length, 1);
      parts.forEach((p, i) => { p.land = BUILD[0] + ((BUILD[1] - BUILD[0] - FLIGHT) * i) / Math.max(n - 1, 1) + FLIGHT; });
      return ring + height; // how far the scene now reaches from the centre
    },

    // Move everything for time `t` (seconds since start).
    update(t, still) {
      if (still) return;
      const c = t % CYCLE;
      const reach = ring * 0.55;
      const lift = height * 1.3;
      for (const p of parts) {
        // 0 = scattered above and around, 1 = in place.
        let k;
        if (c < CHEER[1]) k = ease((c - (p.land - FLIGHT)) / FLIGHT);
        else k = 1 - ease((c - CHEER[1]) / (CYCLE - CHEER[1] - 0.2));
        const away = 1 - k;
        p.object.position.copy(p.home)
          .addScaledVector(p.dir, reach * away)
          .setY(p.home.y + lift * away + Math.sin(k * Math.PI) * height * 0.5);
        p.object.rotation.y = away * 1.4;
        p.object.scale.copy(p.scale).multiplyScalar(0.55 + 0.45 * k);
      }

      const building = c >= BUILD[0] && c < CHEER[0];
      const cheering = c >= CHEER[0] && c < CHEER[1];
      workers.forEach((w, i) => {
        const a = (i / workers.length) * Math.PI * 2 + t * 0.35 * (building ? 1 : 0.15) + 0.6;
        const hop = cheering ? Math.abs(Math.sin(t * 7 + i)) * height * 0.14 : 0;
        w.group.position.set(centre.x + Math.sin(a) * ring, floor + hop, centre.z + Math.cos(a) * ring);
        w.group.rotation.y = a + Math.PI; // face the model
        const step = building ? Math.sin(t * 9 + i * 2) : 0;
        if (w.legL) w.legL.rotation.x = step * 0.45;
        if (w.legR) w.legR.rotation.x = -step * 0.45;
        if (w.head) w.head.rotation.z = Math.sin(t * 2.4 + i) * 0.08;
        if (cheering) {
          if (w.armL) { w.armL.rotation.set(0, 0, -2.5 + Math.sin(t * 10 + i) * 0.25); }
          if (w.armR) { w.armR.rotation.set(0, 0, 2.5 - Math.sin(t * 10 + i) * 0.25); }
        } else if (building) {
          // Swing the tool at the model; left arm sways with the walk.
          if (w.armR) w.armR.rotation.set(-1.25 + Math.sin(t * 13 + i * 1.7) * 0.55, 0, 0);
          if (w.armL) w.armL.rotation.set(-step * 0.4, 0, 0);
        } else {
          if (w.armR) w.armR.rotation.set(-0.2, 0, 0);
          if (w.armL) w.armL.rotation.set(Math.sin(t * 3 + i) * 0.6, 0, -0.3); // wave
        }
      });
    },

    dispose() {
      scene.remove(holder);
    },
  };
}
