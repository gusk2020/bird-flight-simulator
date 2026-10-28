import { check, suite } from "./harness";
import { at, inp, L, world, insideBuilding, finite } from "./common";
import { Autopilot } from "../src/autopilot";
import { Flight } from "../src/flight";
import type { AutoPolicy } from "../src/settings";

interface Res { landed: number; agl: number; air: number; inside: number; out: number; maxStep: number; crashes: number; ok: boolean; ap: Autopilot; f: Flight }
function sim(policy: AutoPolicy, seed: number, secs: number, f = at(0, 25, 0, 0, 12), onStep?: (i: number, ap: Autopilot, f: Flight) => void): Res {
  const ap = new Autopilot(L, seed); ap.setPolicy(policy); ap.start(f);
  const o = inp(); let landed = 0, agl = 0, air = 0, inside = 0, out = 0, maxStep = 0, ok = true; let prev = f.pos.clone(); const c0 = f.crashes;
  for (let i = 0; i < secs * 60; i++) {
    o.flapTap = false; ap.drive(f, o, 1 / 60); f.step(1 / 60, o); onStep?.(i, ap, f);
    ok = ok && finite(f); if (f.mode === "landed" || f.mode === "perch") landed++; if (f.mode === "air") { agl += f.agl; air++; }
    if (insideBuilding(f)) inside++; if (Math.abs(f.pos.x) > 210 || Math.abs(f.pos.z) > 210) out++;
    maxStep = Math.max(maxStep, f.pos.distanceTo(prev)); prev.copy(f.pos);
  }
  return { landed: landed / (secs * 60), agl: agl / Math.max(1, air), air, inside, out, maxStep, crashes: f.crashes - c0, ok, ap, f };
}

export function autopilotTests() {
  suite("autopilot (D2)");
  const pol: AutoPolicy[] = ["life", "scenic", "adventure", "random"];
  const res: Record<string, Res[]> = {};
  for (const p of pol) { res[p] = [1, 2].map(s => sim(p, s, 150)); }
  for (const p of pol) {
    const r = res[p];
    check(`${p}: 2.5 min x2 seeds: all finite, never inside a building`, r.every(x => x.ok && x.inside === 0));
    check(`${p}: stays in the map and never jumps (no teleport, step < 1 m)`, r.every(x => x.out === 0 && x.maxStep < 1 && x.ap.stats.teleports === 0));
    check(`${p}: crashes are rare (<= 3 per run) and it keeps flying`, r.every(x => x.crashes <= 3 && x.air > 600));
  }
  const avg = (p: string, k: "landed" | "agl") => res[p].reduce((a, x) => a + x[k], 0) / res[p].length;
  check("policies differ: life spends more time on the ground than scenic", avg("life", "landed") > avg("scenic", "landed") + 0.1);
  check("policies differ: scenic flies higher than life", avg("scenic", "agl") > avg("life", "agl") + 5);
  check("life actually lands and walks; takeoffs happen", res.life.some(x => x.ap.stats.landings > 0) && res.life.some(x => x.ap.stats.takeoffs > 0));
  { const a = sim("random", 5, 40), b = sim("random", 5, 40);
    check("same seed -> identical flight (seedable)", a.f.pos.distanceTo(b.f.pos) < 1e-9 && a.ap.stats.flaps === b.ap.stats.flaps); }
  { let worst = 0, last = new Flight(world).pos.clone();
    const f = at(0, 25, 0, 0, 12);
    sim("life", 3, 60, f, (i, ap, ff) => { if (i === 1200) ap.setPolicy("scenic"); if (i === 2400) ap.setPolicy("adventure"); if (i > 0 && i % 1 === 0) { worst = Math.max(worst, ff.pos.distanceTo(last)); } last = ff.pos.clone(); });
    check("policy switch mid-flight: no position jump", worst < 1); }
  { const f = at(10, 30, 10, 0.5, 13), v0 = f.vel.clone(), p0 = f.pos.clone(); const ap = new Autopilot(L, 4); ap.start(f); const o = inp(); ap.drive(f, o, 1 / 60); f.step(1 / 60, o);
    check("hand-off from manual flight: position/velocity continue", f.pos.distanceTo(p0) < 0.5 && f.vel.distanceTo(v0) < 1.5); ap.stop();
    check("stop() leaves the flight state untouched", ap.enabled === false && f.mode === "air"); }
  { const f = at(0, 0.4, 0, 0, 0); f.mode = "landed"; f.vel.set(0, 0, 0);
    const r = sim("life", 6, 60, f);
    check("hand-off from the ground: it rests, then takes off and flies", r.ok && r.inside === 0 && r.ap.stats.takeoffs >= 1 && r.air > 60); }
  { const f = at(0, 25, 0, 0, 12); let teleports = 0; sim("adventure", 7, 120, f, (_i, ap) => { teleports = ap.stats.teleports; });
    check("adventure: wire/roof targets are attempted without teleporting", teleports === 0); }
}
