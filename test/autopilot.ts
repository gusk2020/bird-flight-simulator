import { check, suite } from "./harness";
import { at, inp, L, world, insideBuilding, finite } from "./common";
import { Autopilot } from "../src/autopilot";
import { Flight } from "../src/flight";
import type { AutoPolicy } from "../src/settings";

interface Res { incidents: number; landed: number; agl: number; air: number; inside: number; out: number; maxStep: number; crashes: number; ok: boolean; ap: Autopilot; f: Flight }
function sim(policy: AutoPolicy, seed: number, secs: number, f = at(0, 25, 0, 0, 12), onStep?: (i: number, ap: Autopilot, f: Flight) => void): Res {
  const ap = new Autopilot(L, seed); ap.setPolicy(policy); ap.start(f);
  const o = inp(); let landed = 0, agl = 0, air = 0, inside = 0, out = 0, maxStep = 0, ok = true; let prev = f.pos.clone(); const c0 = f.crashes; let incidents = 0, lastC = f.crashes, lastAt = -1e9;
  for (let i = 0; i < secs * 60; i++) {
    o.flapTap = false; ap.drive(f, o, 1 / 60); f.step(1 / 60, o); onStep?.(i, ap, f);
    if (f.crashes !== lastC) { lastC = f.crashes; if (i - lastAt > 180) incidents++; lastAt = i; } // 壁にぶつかった後の落下の着地衝撃は同じ事故(3秒以内)として1回と数える
    ok = ok && finite(f); if (f.mode === "landed" || f.mode === "perch") landed++; if (f.mode === "air") { agl += f.agl; air++; }
    if (insideBuilding(f)) inside++; if (Math.abs(f.pos.x) > 210 || Math.abs(f.pos.z) > 210) out++;
    maxStep = Math.max(maxStep, f.pos.distanceTo(prev)); prev.copy(f.pos);
  }
  return { incidents, landed: landed / (secs * 60), agl: agl / Math.max(1, air), air, inside, out, maxStep, crashes: f.crashes - c0, ok, ap, f };
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
    check(`${p}: crash incidents are rare (<= 3 per 2.5 min run; a wall hit plus the fall after it counts once) and it keeps flying`, r.every(x => x.incidents <= 3 && x.air > 600));
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
  // ---- 監査対応: テレポート抑制・衝突低減の回帰テスト
  { const r = [["life", 11], ["scenic", 12], ["adventure", 13], ["random", 14]].map(([p, sd]) => sim(p as AutoPolicy, sd as number, 600));
    check("10 min x 4 policies: no teleport/rescue, no out-of-bounds, never inside a building", r.every(x => x.ap.stats.teleports === 0 && x.out === 0 && x.inside === 0 && x.maxStep < 1));
    check("10 min x 4 policies: crash incidents stay low (<= 6 per run, <= 12 total)", r.every(x => x.incidents <= 6) && r.reduce((a, x) => a + x.incidents, 0) <= 12, r.map(x => `${x.incidents}/${x.crashes}`).join()); }
  { const f = at(40, 30, 40, 0.7, 5); f.step(1 / 60, inp()); f.crashes = 7; f.resets = 3; f.strokes = 21; const ap = new Autopilot(L, 3); ap.start(f); const a = ap as any;
    const x0 = f.pos.x, z0 = f.pos.z, y0 = f.pos.y; a.recover(f);
    check("recover() uses only decisions: position, velocity and statistics are untouched", f.pos.x === x0 && f.pos.z === z0 && f.pos.y === y0 && f.crashes === 7 && f.resets === 3 && ap.stats.recoveries === 1);
    a.rescue(f);
    check("last-resort rescue keeps the same x/z (lifts straight up), clears hop/stun/perch state", f.pos.x === x0 && f.pos.z === z0 && f.pos.y >= y0 && f.mode === "air" && !f.hopping && f.stun === 0);
    check("rescue never wipes crash/reset/stroke statistics (no Flight.reset())", f.crashes === 7 && f.resets === 3 && f.strokes === 21); }
  { const f = at(0, 0.4, 0, 0, 0); f.mode = "landed"; f.vel.set(0, 0, 0); const ap = new Autopilot(L, 5); ap.setPolicy("life"); ap.start(f); const a = ap as any; a.enter("takeoff");
    const r0 = ap.stats.recoveries; for (let i = 0; i < 3; i++) { a.blocked = 3 + i; a.recover(f); }
    check("stuck takeoff: retries (hop again) before any teleport", ap.stats.recoveries === r0 + 3 && ap.stats.teleports === 0 && a.hopped === false); }
}
