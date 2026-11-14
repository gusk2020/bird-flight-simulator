import { check, suite } from "./harness";
import { at, inp } from "./common";
import { Flight } from "./../src/flight";
import { FlapAssist } from "../src/assist";
import { CRUISE, CruiseGovernor } from "../src/cruise";
import { AutoLand } from "../src/autoland";
import { PerchAssist } from "../src/perchassist";
import { buildSurfaces } from "../src/perches";
import { L } from "./common";
import { guideValues, compassName } from "../src/guide";
import { Wind } from "../src/wind";
import { PHYS as PH } from "../src/params";

/** 手動の巡航を想定した飛行。tapEvery 秒ごとに羽ばたきをタップ(0=触れない)、chain=連打、assist=片手の補助 */
function fly(secs: number, o: { tapEvery: number; chain?: boolean; assist?: boolean; governor: boolean; v0?: number }) {
  const f = at(28, 25, 150, 0, o.v0 ?? 10), gov = new CruiseGovernor(), as = new FlapAssist(); as.enabled = !!o.assist; CRUISE.enabled = o.governor; gov.reset(f);
  if (!o.governor) f.speedScale = 1;
  let next = 0.5, stallSteps = 0, sum = 0, n = 0, max = 0; const speeds: number[] = [];
  for (let k = 0; k < secs * 60; k++) {
    const t = k / 60, i = inp();
    if (o.tapEvery > 0 && t >= next) { i.flapTap = true; next = t + (o.chain && Math.floor(t / o.tapEvery) % 2 === 0 ? o.tapEvery : o.chain ? 0.25 : o.tapEvery); }
    gov.update(f, i, 1 / 60, false);
    f.step(1 / 60, as.apply(i, f)); if (f.stall) stallSteps++;
    if (k % 6 === 0) { const gs = Math.hypot(f.vel.x, f.vel.z); sum += gs; n++; max = Math.max(max, gs); speeds.push(gs); }
    if (f.mode !== "air") break;
  }
  return { f, gov, mean: sum / Math.max(1, n), max, stallSteps, speeds };
}
export function h9Tests() {
  suite("H9 slow cruise");
  const keep = { ...CRUISE };
  const old = fly(20, { tapEvery: 0, assist: true, governor: false }), slow = fly(20, { tapEvery: 0, assist: true, governor: true });
  check("hands-off cruise (single ◎) is at least 35% slower than before", slow.mean <= old.mean * 0.65, `old ${old.mean.toFixed(1)} -> new ${slow.mean.toFixed(1)} m/s`);
  check("the slow cruise does not stall and stays in the air", slow.stallSteps === 0 && slow.f.mode === "air", `stall steps ${slow.stallSteps} mode ${slow.f.mode}`);
  const t15 = fly(20, { tapEvery: 1.5, assist: true, governor: true }), t15o = fly(20, { tapEvery: 1.5, assist: true, governor: false });
  check("holding altitude with a flap every 1.5 s stays well below the old speed (no creeping acceleration)", t15.mean < t15o.mean * 0.8, `old ${t15o.mean.toFixed(1)} -> new ${t15.mean.toFixed(1)}`);
  const fast = fly(20, { tapEvery: 0.6, governor: true }), fastOld = fly(20, { tapEvery: 0.6, governor: false });
  check("rapid flapping accelerates to (nearly) the old top speed", fast.max >= fastOld.max * 0.92, `old max ${fastOld.max.toFixed(1)} new max ${fast.max.toFixed(1)}`);
  const ch = fly(20, { tapEvery: 3, chain: true, assist: true, governor: true });
  check("chained taps (single ◎) also accelerate beyond the cruise", ch.max > slow.mean * 2, `max ${ch.max.toFixed(1)} vs cruise ${slow.mean.toFixed(1)}`);
  // 加速したあと、操作をやめると徐々に低速巡航へ戻る
  { CRUISE.enabled = true; const f = at(28, 25, 150, 0, 10), g = new CruiseGovernor(), as = new FlapAssist(); as.enabled = true; g.reset(f); const sp: number[] = [];
    for (let k = 0; k < 60 * 30; k++) { const t = k / 60, i = inp(); if (t < 4 && Math.floor(t * 4) !== Math.floor((t - 1 / 60) * 4)) i.flapTap = true; g.update(f, i, 1 / 60, false); f.step(1 / 60, as.apply(i, f)); if (k % 60 === 0) sp.push(Math.hypot(f.vel.x, f.vel.z)); }
    const peak = Math.max(...sp.slice(0, 8)), end = sp[sp.length - 1], at10 = sp[14];
    check("after accelerating, the speed returns gradually to the slow cruise (not an abrupt stop)", peak > 11 && end < peak * 0.7 && at10 > end - 0.5 && f.mode === "air", `peak ${peak.toFixed(1)} +10s ${at10.toFixed(1)} end ${end.toFixed(1)}`);
    check("boost decays to zero without input", g.boost < 0.05, `boost ${g.boost.toFixed(2)}`); }
  // オート(full)と自動着地(hold)では、従来の物理のまま・または空力を動かさない
  { CRUISE.enabled = true; const f = at(28, 25, 150, 0, 10), g = new CruiseGovernor(); f.speedScale = 1; for (let k = 0; k < 600; k++) { g.update(f, inp(), 1 / 60, true); f.step(1 / 60, inp()); }
    check("autopilot (full) keeps the old physics: speedScale stays 1", f.speedScale === 1); }
  { CRUISE.enabled = true; const f = at(28, 25, 150, 0, 10), g = new CruiseGovernor(); g.reset(f); const s0 = f.speedScale; for (let k = 0; k < 600; k++) { g.update(f, inp({ flapHeld: true }), 1 / 60, false, true); f.step(1 / 60, inp()); }
    check("during an automatic landing (hold) the aerodynamics are not changed even if flaps are pressed", f.speedScale === s0, `${f.speedScale} vs ${s0}`); }
  { const f = new Flight(at(0, 0, 0).world as never); f.speedScale = 0.5; f.vel.set(0, 0, -5); f.speed = 5; check("speedN reads a slow-cruise speed as the equivalent old-physics speed", Math.abs(f.speedN - 10) < 1e-9); }

  suite("H9 landing markers: green = a landing can start now");
  { const idx = buildSurfaces(L); let n = 0, agree = 0, greens = 0, blues = 0, seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const ss = idx.all.filter(s => ["bench", "wall", "fence", "rail", "balcony", "sign", "branch", "pole", "rock", "roof"].includes(s.kind));
    for (let i = 0; i < 300; i++) { const s = ss[Math.floor(rnd() * ss.length)], cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, a = rnd() * 6.283, d = 4 + rnd() * 20;
      const f = at(cx + Math.cos(a) * d, s.top + 0.5 + rnd() * 6, cz + Math.sin(a) * d, Math.atan2(Math.cos(a), Math.sin(a)) + (rnd() - 0.5), (4 + rnd() * 6) * CRUISE.scale0 * 2);
      f.step(1 / 60, inp()); const al = new AutoLand(idx, new PerchAssist(idx), L.heightAt);
      const before = JSON.stringify([f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.vel.z]), can = al.canStart(f, s);
      check_(JSON.stringify([f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.vel.z]) === before && !al.active);
      const started = al.start(f, s); n++; if (started === can.ok) agree++; if (can.ok) greens++; else blues++; }
    check("canStart (the marker colour) agrees with whether start() really begins a landing, in 300 random states", agree === n, `${agree}/${n} agree; ${greens} green ${blues} not`);
    check("the sample has both landable and not-landable states (the test is not vacuous)", greens > 20 && blues > 20, `${greens}/${blues}`); }

  suite("H9 flight guide values");
  { const f = at(28, 30, 150, 0, 10); f.step(1 / 60, inp()); const v = guideValues(f, null);
    check("no wind: ground speed and air speed agree (km/h)", Math.abs(v.gsKmh - v.tasKmh) < 1e-9 && Math.abs(v.gsKmh - f.vel.length() * 3.6) < 1e-9, `${v.gsKmh} ${v.tasKmh}`);
    const wv = { at: (_x: number, _y: number, _z: number, _t: number, out: any) => out.set(3, 0, 0) }; const w = guideValues(f, wv as never);
    check("with a 3 m/s wind toward +x, air speed = |ground velocity - wind|", Math.abs(w.tasKmh - Math.hypot(f.vel.x - 3, f.vel.y, f.vel.z) * 3.6) < 1e-9 && Math.abs(w.tasKmh - w.gsKmh) > 1, `gs ${w.gsKmh.toFixed(1)} tas ${w.tasKmh.toFixed(1)}`);
    const real = new Wind(L.colliders); real.set(270, 5, 0); const f2 = at(28, 30, 150, 0, 10); f2.wind = real; for (let i = 0; i < 120; i++) f2.step(1 / 60, inp());
    const vr = guideValues(f2, real), headwind = 5; check("with the app's wind (from the west 5 m/s), flying north: air speed differs from ground speed by the wind component", Math.abs(vr.tasKmh - vr.gsKmh) > 1 && Number.isFinite(vr.tasKmh) && headwind > 0, `gs ${vr.gsKmh.toFixed(1)} tas ${vr.tasKmh.toFixed(1)} (air-speed measured by the flight model ${(f2.airspeed * 3.6).toFixed(1)})`);
    check("the guide's air speed equals the flight model's own air speed (same wind, same step)", Math.abs(vr.tasKmh - f2.airspeed * 3.6) < 8, `${vr.tasKmh.toFixed(1)} vs ${(f2.airspeed * 3.6).toFixed(1)}`); }
  { const f = at(28, 30, 150, 0, 10); const dirs: [number, number][] = [[0, 0], [-Math.PI / 2, 90], [Math.PI, 180], [Math.PI / 2, 270]];
    check("heading: forward -z = north 0, +x = east 90, +z = south 180, -x = west 270", dirs.every(([yaw, want]) => { f.yaw = yaw; f.vel.set(-Math.sin(yaw) * 10, 0, -Math.cos(yaw) * 10); const v = guideValues(f, null); return Math.abs(((v.headingDeg - want + 540) % 360) - 180) < 1e-6 && Math.abs(((v.trackDeg - want + 540) % 360) - 180) < 1e-6; }), "");
    check("compass names", compassName(0) === "北" && compassName(90) === "東" && compassName(200) === "南" && compassName(315) === "北西"); }
  { const f = at(28, 30, 150, 0, 10); f.pitch = 0.2; f.roll = -0.3; const v = guideValues(f, null);
    check("pitch: nose up is positive; roll: right wing down is positive (degrees)", Math.abs(v.pitchDeg - 11.459) < 0.01 && Math.abs(v.rollDeg - 17.188) < 0.01, `${v.pitchDeg} ${v.rollDeg}`); }
  { const f = at(28, 30, 150, 0, 10); f.step(1 / 60, inp()); const a = guideValues(f, null); const g = L.heightAt(f.pos.x, f.pos.z);
    check("elevation is the feet height above sea level (world y=0) and ground height is feet minus the terrain directly below", Math.abs(a.elevM - (f.pos.y - PH.feetOffset)) < 1e-9 && Math.abs(a.aglM - Math.max(0, f.pos.y - PH.feetOffset - g)) < 1e-9, `${a.elevM} ${a.aglM} terrain ${g}`);
    const f3 = at(-120, 30, 40, 0, 10); const b = guideValues(f3, null); check("elevation does not depend on the horizontal position (no world-origin effect)", Math.abs(b.elevM - a.elevM) < 1e-6 || Math.abs(b.elevM - (30 - PH.feetOffset)) < 0.2, `${b.elevM}`); }
  { const f = at(28, 30, 150, 0, 10), h0 = guideValues(f, null).headingDeg; for (let i = 0; i < 90; i++) f.step(1 / 60, inp({ x: 1 })); const v = guideValues(f, null);
    check("a right turn increases the heading (clockwise) and shows a right roll", ((v.headingDeg - h0 + 360) % 360) > 5 && ((v.headingDeg - h0 + 360) % 360) < 180 && v.rollDeg > 5, `heading ${h0.toFixed(0)}→${v.headingDeg.toFixed(0)} roll ${v.rollDeg.toFixed(1)}`); }
  Object.assign(CRUISE, keep);
}
function check_(ok: boolean) { if (!ok) check("canStart must not change state", false); }
