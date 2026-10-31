import { check, suite } from "./harness";
import { L, world, inp, insideBuilding } from "./common";
import { Flight, type FlightInput } from "../src/flight";
import { PHYS as P } from "../src/params";

interface Run { crashes: number; escapes: number; grazes: number; inside: boolean; stunSteps: number; away: number; dy: number; mode: string; kind: string; finite: boolean; yawTurned: number }
/** 高い壁(アパート)の南面へ、距離 dist・高さ alt・速さ v・壁の法線からの入射角 ang で入る。壁に対して垂直=正面 */
function hit(wall: { minX: number; maxX: number; minZ: number; maxZ: number }, alt: number, v: number, ang: number, recovery: boolean, input?: (t: number, f: Flight) => FlightInput, secs = 4): Run {
  const f = new Flight(world); f.wallRecovery = recovery;
  const cx = (wall.minX + wall.maxX) / 2, z0 = wall.maxZ + 9; // 北側の面(+z)に向かって南へ(-z)飛ぶ
  const sx = Math.sin(ang) * 9; f.pos.set(cx + sx, alt, z0); f.prevPos.copy(f.pos);
  f.yaw = Math.atan2(-(-Math.sin(ang)), -(-Math.cos(ang))) ; // 入射方向 (-sin(ang)... ) へ向く
  const dx = -Math.sin(ang), dz = -Math.cos(ang); f.yaw = Math.atan2(-dx, -dz); f.vel.set(dx * v, 0, dz * v);
  const y0 = f.pos.y, c0 = f.crashes; let stunSteps = 0, inside = false, fin = true, maxAway = 0;
  for (let i = 0; i < secs * 60; i++) {
    f.step(1 / 60, input ? input(i / 60, f) : inp()); if (f.stun > 0) stunSteps++; inside = inside || insideBuilding(f); fin = fin && Number.isFinite(f.pos.x + f.pos.y + f.pos.z);
    maxAway = Math.max(maxAway, Math.hypot(f.pos.x - clampTo(f.pos.x, wall.minX, wall.maxX), f.pos.z - clampTo(f.pos.z, wall.minZ, wall.maxZ)));
  }
  return { crashes: f.crashes - c0, escapes: f.escapes, grazes: f.grazes, inside, stunSteps, away: maxAway, dy: f.pos.y - y0, mode: f.mode, kind: f.escapeKind, finite: fin, yawTurned: 0 };
}
const clampTo = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function g1WallTests() {
  suite("G1-2/G1-3: wall hits - recovery, and wing-tip grazes");
  // 十分に広い高層アパート(周りに他の建物が少ない面を選ぶ)
  const apt = L.apts.filter(a => a.floors >= 9).map(a => L.colliders.find(c => Math.abs((c.minX + c.maxX) / 2 - a.x) < 0.01 && Math.abs((c.minZ + c.maxZ) / 2 - a.z) < 0.01 && c.top > 30)!).filter(Boolean);
  const wall = apt[0];
  check("a tall wall to test against exists", !!wall && wall.top > 30, wall ? `top=${wall.top}` : "none");
  const flapper = (t: number): FlightInput => inp({ flapTap: t % 0.5 < 1 / 60 && t > 0.4 });
  const rows: string[] = [];
  let allOk = true, escapes = 0, n = 0, maxCrash = 0, worstInside = false, worstStun = 0, minAway = 99;
  for (const alt of [4, 12, 25]) for (const v of [8, 14, 22]) for (const ang of [0, 0.35, 0.7]) {
    const r = hit(wall, alt, v, ang, true, flapper), o = hit(wall, alt, v, ang, false, flapper);
    n++; if (r.escapes > 0) { escapes++; minAway = Math.min(minAway, r.away); }
    maxCrash = Math.max(maxCrash, r.crashes); worstInside = worstInside || r.inside || !r.finite; worstStun = Math.max(worstStun, r.stunSteps);
    allOk = allOk && r.finite;
    if (alt === 12 && ang === 0) rows.push(`v${v}: crashes ${o.crashes}->${r.crashes} stun ${(o.stunSteps / 60).toFixed(2)}->${(r.stunSteps / 60).toFixed(2)}s`);
  }
  check("never inside a building, always finite (27 approaches: 3 heights x 3 speeds x 3 angles)", !worstInside && allOk);
  check("at most one crash per approach (no repeated hits in the 4 s after)", maxCrash <= 1, `max crashes ${maxCrash}`);
  check("frontal / diagonal impacts trigger the escape", escapes >= 12, `${escapes}/${n} approaches escaped`);
  check("the stun is short (<= 0.35 s) instead of 0.7 s", worstStun <= 21, `worst ${(worstStun / 60).toFixed(2)} s; ${rows.join(" | ")}`);
  { const r = hit(wall, 12, 14, 0, true, flapper), o = hit(wall, 12, 14, 0, false, flapper);
    check("after a frontal hit the bird backs off the wall and keeps flying (flapping from 0.4 s)", r.crashes === 1 && r.mode === "air" && r.away > 5, `away=${r.away.toFixed(1)} m dy=${r.dy.toFixed(1)} m (legacy: away=${o.away.toFixed(1)} dy=${o.dy.toFixed(1)})`);
    check("with the recovery the bird loses less height than the legacy tumble", r.dy > o.dy - 1, `${r.dy.toFixed(1)} vs ${o.dy.toFixed(1)}`); }
  { // 自動の向き: 左右のどちらかに開けた側があればそちらへ(後ろへは戻らない)
    const r = hit(wall, 12, 14, 0, true, flapper); check("an open side is preferred over going back", r.kind === "left" || r.kind === "right", r.kind); }
  // ここから先は、周りに何もない単独の壁(東西20m x 南北20m、高さ40m)で調べる。街の中では他の建物に当たって結果が混ざるため
  const solo = { minX: -10, maxX: 10, minZ: -60, maxZ: -40, top: 40 };
  const sw = { colliders: [solo], heightAt: (x: number, z: number) => (x > solo.minX && x < solo.maxX && z > solo.minZ && z < solo.maxZ ? solo.top : 0), perchAt: () => null } as never;
  const soloIn = (f: Flight) => f.pos.x > solo.minX && f.pos.x < solo.maxX && f.pos.z > solo.minZ && f.pos.z < solo.maxZ && f.pos.y - 0.32 < solo.top - 0.3;
  const fly = (rec: boolean, x: number, z: number, vx: number, vz: number, secs: number) => {
    const f = new Flight(sw); f.wallRecovery = rec; f.pos.set(x, 12, z); f.prevPos.copy(f.pos); f.vel.set(vx, 0, vz); f.yaw = Math.atan2(-vx, -vz);
    let ins = false, vmin = 99; for (let i = 0; i < secs * 60; i++) { f.step(1 / 60, inp({ flapTap: i % 40 === 20 })); ins = ins || soloIn(f); vmin = Math.min(vmin, f.speed); }
    return { c: f.crashes, gr: f.grazes, esc: f.escapes, ins, mode: f.mode, vmin, x: f.pos.x, z: f.pos.z };
  };
  { const r = fly(true, 0, -20, 0, -5, 2); check("slow contact (5 m/s) is not a wall crash", r.c === 0 && r.esc === 0, `crashes ${r.c} escapes ${r.esc}`); }
  { // 壁(東面 x=10)に沿って、約15度の浅い角度で20 m/s で南下し、壁をこする
    const ang = 0.35; // 壁面とのなす角 約20度(法線方向の速さ 8.9 m/s > 7: 従来は墜落)
    const run = (rec: boolean) => { const f = new Flight(sw); f.wallRecovery = rec; f.pos.set(11.2, 12, -58); f.prevPos.copy(f.pos); f.vel.set(-Math.sin(ang) * 26, 0, Math.cos(ang) * 26); f.yaw = Math.atan2(-f.vel.x, -f.vel.z); // 北(+z)へ向かい、壁を斜めに通過
      let ins = false, c = 0; for (let i = 0; i < 60 * 1.2; i++) { f.step(1 / 60, inp()); ins = ins || soloIn(f); } return { c: f.crashes, gr: f.grazes, ins, mode: f.mode, v: f.speed, x: f.pos.x }; };
    // 壁の東側から壁に向けて、壁面とのなす角が約15度になるように入る
    const g = run(true), o = run(false);
    check("G1-3: skimming a wall at ~20 deg and 26 m/s (a crash before) is not a crash now; the bird keeps flying and stays outside", o.c === 1 && g.c === 0 && g.mode === "air" && !g.ins && g.gr >= 1, `crashes ${o.c}(legacy)->${g.c}, grazes ${g.gr}, speed ${g.v.toFixed(1)}`); }
  { // 胴体の正面衝突は有効なまま(かすり扱いにならない)
    const r = fly(true, 0, -20, 0, -20, 2); check("G1-3: a head-on body hit is still a crash", r.c === 1 && r.gr === 0, `crashes ${r.c} grazes ${r.gr}`); }
  { const r = hit(wall, 12, 20, 0.35, true, undefined, 2); check("G1-3: a 20 deg diagonal hit at 20 m/s is still a crash", r.crashes === 1, `crashes ${r.crashes}`); }
  { // 壁の貫通: 非常に速い斜め入射でも、胴体は壁の内側へ入らない
    let bad = 0; for (const v of [20, 28, 36]) for (const ang of [0, 0.5, 1.0, 1.4]) { const r = hit(wall, 12, v, ang, true, undefined, 3); if (r.inside) bad++; }
    check("no wall penetration at up to 36 m/s from any angle", bad === 0, `${bad} of 12 went inside`); }
}
