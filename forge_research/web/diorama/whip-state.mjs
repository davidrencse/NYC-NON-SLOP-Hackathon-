export function actorAt(hits, crew) {
  for (const hit of hits) {
    for (let node = hit.object; node; node = node.parent) {
      if (Number.isInteger(node.userData?.crew)) return crew[node.userData.crew] ?? null;
    }
  }
  return null;
}
export function hitActor(actor, now) {
  if (actor) actor.whip = { start: now, until: now + 2400 };
}
export function boost(actor, now) {
  if (!actor.whip || now >= actor.whip.until) { actor.whip = null; return 1; }
  return 2;
}
