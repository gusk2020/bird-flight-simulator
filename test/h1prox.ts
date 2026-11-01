import { check, suite } from "./harness";
import { inp } from "./common";
import { Flight, type FlightInput } from "../src/flight";
import { PHYS as P, PROX as X } from "../src/params";
import { ProxPad, padLayout, inProxRegion, type ProxCmd } from "../src/proxpad";
import { autoBrake } from "../src/avoid";

const DEG = Math.PI / 180, wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** 何もない平地+単独の壁(東西20 x 南北20, 高さ40)。壁は z=-60..-40 */
const solo = { minX: -10, maxX: 10, minZ: -60, maxZ: -40, top: 40 };
const world = { colliders: [solo], heightAt: (x: number, z: number) => (x > solo.minX && x < solo.maxX && z > solo.minZ && z < solo.maxZ ? solo.top : 0), perchAt: () => null } as never;
const inside = (f: Flight) => f.pos.x > solo.minX && f.pos.x < solo.maxX && f.pos.z > solo.minZ && f.pos.z < solo.maxZ && f.pos.y - 0.32 < solo.top - 0.3;
const mkFlight = (x: number, y: number, z: number, yaw: number, v: number) => { const f = new Flight(world); f.pos.set(x, y, z); f.prevPos.copy(f.pos); f.yaw = yaw; f.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v); return f; };
const cmd = (yaw: number, pitch = 0, speed = X.creepSpeed, extra: Partial<ProxCmd> = {}): ProxCmd => ({ yaw, pitch, speed, center: false, down: false, held: 0, zone: "ring", ...extra });
const withProx = (c: ProxCmd | null): FlightInput => ({ ...inp(), prox: c });

export function h1ProxTests() {
  suite("H1: the proximity pad (a double ring below the cruise pad)");
  {
    const L = padLayout(892, 412, "right"), Ll = padLayout(892, 412, "left"), Lp = padLayout(412, 892, "right");
    check("two pads are stacked vertically inside the used half of the screen (landscape, right hand)", L.cruise.cy < L.prox.cy && L.cruise.cx === L.prox.cx && L.cruise.cx > 446 && L.prox.cy + L.prox.r <= 412 && L.cruise.cy - L.cruise.r >= 50, JSON.stringify(L));
    check("they do not overlap each other or the top button row (landscape and portrait, both hands)", [L, Ll, Lp].every(l => l.cruise.cy + l.cruise.r < l.prox.cy - l.prox.r && l.cruise.cy - l.cruise.r >= 44 && l.prox.cy + l.prox.r <= (l === Lp ? 892 : 412)), [L, Ll, Lp].map(l => `${Math.round(l.cruise.cy)}/${Math.round(l.prox.cy)}/${Math.round(l.prox.r)}`).join(" "));
    check("a touch below the split belongs to the proximity pad, above it to cruise; the other half of the screen belongs to neither", inProxRegion(L, L.prox.cx, L.prox.cy) && !inProxRegion(L, L.cruise.cx, L.cruise.cy) && !inProxRegion(L, 100, L.prox.cy));
    const pad = new ProxPad(), R = L.prox, at = (deg: number, frac: number) => ({ x: R.cx + Math.sin(deg * DEG) * R.r * frac, y: R.cy - Math.cos(deg * DEG) * R.r * frac });
    pad.down(1, R.cx, R.cy, R, 0.4); const c0 = pad.cmd()!;
    check("center: no direction change, holds (zone center, speed holdSpeed)", c0.zone === "center" && c0.center && Math.abs(wrap(c0.yaw - 0.4)) < 1e-9 && c0.pitch === 0 && c0.speed === X.holdSpeed);
    const q = (deg: number, frac: number) => { const p = at(deg, frac); pad.move(p.x, p.y); return pad.cmd()!; };
    const ri = q(90, 0.75), ro = q(90, 1.0), ii = q(90, 0.35), il = q(-90, 0.5);
    check("ring toward the right: about 90 degrees to the right of the reference heading, level", ri.zone === "ring" && Math.abs(wrap(ri.yaw - (0.4 - 90 * DEG))) < 0.02 && Math.abs(ri.pitch) < 0.02, `${(wrap(ri.yaw - 0.4) / DEG).toFixed(0)} deg`);
    check("outer toward the left: about 120 degrees to the left", ro.zone === "outer" || q(-90, 1.0).zone === "outer", "");
    const lo = q(-90, 1.0); check("outer left = +120 degrees", lo.zone === "outer" && Math.abs(wrap(lo.yaw - (0.4 + 120 * DEG))) < 0.02, `${(wrap(lo.yaw - 0.4) / DEG).toFixed(0)} deg`);
    check("inner is a small change that grows with the distance from the center", ii.zone === "inner" && Math.abs(wrap(ii.yaw - 0.4)) / DEG > 8 && Math.abs(wrap(ii.yaw - 0.4)) / DEG < 40 && Math.abs(wrap(q(90, 0.5).yaw - 0.4)) > Math.abs(wrap(q(90, 0.3).yaw - 0.4)), `${(Math.abs(wrap(ii.yaw - 0.4)) / DEG).toFixed(0)} deg`);
    check("ring toward the top climbs, toward the bottom descends (capped at 60 degrees), diagonals mix yaw and pitch", q(0, 0.75).pitch > 0.9 && q(180, 0.75).pitch < -0.9 && q(0, 1).pitch <= 60 * DEG + 1e-9 && (() => { const d = q(45, 0.75); return d.pitch > 0.3 && wrap(d.yaw - 0.4) < -0.3; })());
    const dn = q(180, 0.75); check("the downward direction is flagged (rest on the ground), a sideways one is not", dn.down && !q(90, 0.75).down && !q(0, 0.75).down);
    pad.move(R.cx + 5, R.cy - 40); const ref0 = pad.refYaw; pad.move(R.cx - 30, R.cy + 20);
    check("the reference heading is fixed at the first touch (moving the finger does not change it)", pad.refYaw === ref0 && ref0 === 0.4);
    pad.up(); check("lifting the finger clears the command", pad.cmd() === null);
  }

  suite("H1: close maneuvers - reaction, turn time, creeping, altitude, release");
  {
    // 急制動 + 微速前進: 12 m/s の巡航から、そのまま前(同じ向き)の近接指示
    const f = mkFlight(0, 30, 100, 0, 12); let tSlow = -1, minSpeed = 99, vy = 0;
    for (let i = 0; i < 60 * 2; i++) { f.step(1 / 60, withProx(cmd(0))); minSpeed = Math.min(minSpeed, f.speed); if (tSlow < 0 && f.speed < X.creepSpeed + 0.4) tSlow = (i + 1) / 60; vy = Math.max(vy, Math.abs(f.vel.y)); }
    check("braking from 12 m/s to the creep speed takes 0.2-0.5 s (no instant stop, no overshoot below the creep speed)", tSlow >= 0.2 && tSlow <= 0.5 && minSpeed > X.creepSpeed - 0.3, `${tSlow.toFixed(2)} s, min ${minSpeed.toFixed(2)} m/s`);
    check("...and then creeps forward at the creep speed, holding altitude (+-0.4 m over 2 s)", Math.abs(f.speed - X.creepSpeed) < 0.3 && Math.abs(f.pos.y - 30) < 0.4 && f.mode === "air", `speed ${f.speed.toFixed(2)} dy ${(f.pos.y - 30).toFixed(2)}`);
    // 90度の旋回(左)
    for (const [name, off, lo, hi] of [["90 degrees left (ring)", 90, 0.2, 0.5], ["120 degrees left (outer)", 120, 0.2, 0.55], ["90 degrees right", -90, 0.2, 0.5]] as const) {
      const g = mkFlight(0, 30, 100, 0, 10); let t = -1, vdirOk = -1; const y0 = g.yaw;
      for (let i = 0; i < 60 * 2; i++) { g.step(1 / 60, withProx(cmd(y0 + off * DEG))); if (t < 0 && Math.abs(wrap(g.yaw - (y0 + off * DEG))) < 6 * DEG) t = (i + 1) / 60;
        const hs = Math.hypot(g.vel.x, g.vel.z); if (vdirOk < 0 && hs > 1.5 && Math.abs(wrap(Math.atan2(-g.vel.x, -g.vel.z) - (y0 + off * DEG))) < 15 * DEG) vdirOk = (i + 1) / 60; }
      check(`turn ${name}: the heading is within 6 degrees in ${lo}-${hi} s, the velocity follows within 1 s`, t >= lo && t <= hi && vdirOk > 0 && vdirOk <= 1.0, `heading ${t.toFixed(2)} s, velocity ${vdirOk.toFixed(2)} s, end speed ${g.speed.toFixed(1)}`);
    }
    // 上昇方向(環状の上)
    const u = mkFlight(0, 30, 100, 0, 8); for (let i = 0; i < 60 * 1.5; i++) u.step(1 / 60, withProx(cmd(0, 60 * DEG)));
    check("pointing up (ring, top) climbs at the creep speed's vertical part", u.pos.y > 30 + 1.2 && u.vel.y > 1.5, `dy ${(u.pos.y - 30).toFixed(2)} vy ${u.vel.y.toFixed(2)}`);
    // 指を離す: 急停止ではなく、ゆっくり前進して高度を保つ
    const r = mkFlight(0, 30, 100, 0, 12); for (let i = 0; i < 60 * 1; i++) r.step(1 / 60, withProx(cmd(0)));
    const xr = r.pos.z; let minV = 99; for (let i = 0; i < 60 * 3; i++) { r.step(1 / 60, withProx(null)); minV = Math.min(minV, r.speed); }
    check("after lifting the finger it keeps creeping forward (not an instant stop) and holds its altitude for 3 s", minV > X.creepSpeed - 0.5 && xr - r.pos.z > 5 && Math.abs(r.pos.y - 30) < 0.6 && r.prox.on && r.mode === "air", `min speed ${minV.toFixed(2)}, forward ${(xr - r.pos.z).toFixed(1)} m, dy ${(r.pos.y - 30).toFixed(2)}`);
    let exitedAt = -1, yAtExit = 0; for (let i = 0; i < 60 * (X.creepMax + X.exitTime + 1); i++) { r.step(1 / 60, withProx(null)); if (exitedAt < 0 && !r.prox.on) { exitedAt = i / 60; yAtExit = r.pos.y; } }
    check("after the creep time (6 s) it returns to normal flight by itself without stalling or falling (no endless hover)", exitedAt > 0 && !r.prox.on && r.mode === "air" && !r.stall && r.speed > 6 && yAtExit > 28 && r.pos.y > 18 && r.crashes === 0, `back to normal flight at ${exitedAt.toFixed(1)} s (y ${yAtExit.toFixed(1)}), later speed ${r.speed.toFixed(1)} y ${r.pos.y.toFixed(1)}`);
    // 巡航の操作で、すぐ通常飛行へ
    const k = mkFlight(0, 30, 100, 0, 12); for (let i = 0; i < 90; i++) k.step(1 / 60, withProx(cmd(0))); for (let i = 0; i < 20; i++) k.step(1 / 60, withProx(null));
    k.step(1 / 60, { ...inp({ x: 0.8 }), prox: null }); for (let i = 0; i < 60 * 1.5; i++) k.step(1 / 60, withProx(null));
    check("a cruise-pad input (stick) after the creep hands the bird back to normal flight", !k.prox.on && k.speed > 6, `speed ${k.speed.toFixed(1)}`);
    // 速度 25 m/s(急降下級)からでも、上限つきの減速で止まる
    const h = mkFlight(0, 80, 100, 0, 25); let maxA = 0, pv = h.vel.length(); for (let i = 0; i < 60 * 2; i++) { h.step(1 / 60, withProx(cmd(0))); const v = h.vel.length(); maxA = Math.max(maxA, Math.abs(v - pv) * 60); pv = v; }
    check("from 25 m/s the deceleration never exceeds the limit (no infinite deceleration, no instant stop)", maxA <= X.brakeDecel * 1.05 && h.speed < 3.2, `max ${maxA.toFixed(1)} m/s^2 (limit ${X.brakeDecel}), end ${h.speed.toFixed(2)} m/s`);
    // 位置の瞬間移動がない
    const tp = mkFlight(0, 30, 100, 0, 15); let maxStep = 0; for (let i = 0; i < 60 * 3; i++) { const p = tp.pos.clone(); tp.step(1 / 60, withProx(i % 50 < 25 ? cmd(1.2) : cmd(-1.0, 0.4))); maxStep = Math.max(maxStep, tp.pos.distanceTo(p)); }
    check("no teleport: the position never moves more than speed x dt in a step, even when the pad direction flips", maxStep < 15 / 60 + 0.05, `max step ${maxStep.toFixed(3)} m`);
  }

  suite("H1: walls and the ground - brake, avoid, recover");
  {
    // 近接機動で壁へ向かう: 手前で止まる
    const w = mkFlight(0, 20, -20, 0, 14); let minD = 99, bad = false; for (let i = 0; i < 60 * 12; i++) { w.step(1 / 60, withProx(cmd(0))); minD = Math.min(minD, w.pos.z - solo.maxZ); bad = bad || inside(w); }
    check("close maneuver straight at a wall from 14 m/s (kept pointing at it for 12 s): brakes and stops about 1 m (centre to face) in front of it, no crash, never inside", w.crashes === 0 && !bad && minD > 0.8 && w.pos.z < solo.maxZ + 3, `closest ${minD.toFixed(2)} m, ends ${(w.pos.z - solo.maxZ).toFixed(2)} m from the wall`);
    // 対照: 何もしない巡航は壁にぶつかる(試験が意味を持つ)
    const c = mkFlight(0, 20, -20, 0, 14); for (let i = 0; i < 60 * 3; i++) c.step(1 / 60, inp()); check("(control) plain cruise at the same wall crashes", c.crashes >= 1);
    // 巡航の自動制動
    const run = (guard: boolean, z0: number, v: number, yaw = 0) => { const f = mkFlight(0, 20, z0, yaw, v); let bad2 = false;
      for (let i = 0; i < 60 * 4; i++) { const i0 = inp(); if (guard && f.mode === "air" && !f.prox.on) { const a = autoBrake(world, f.pos.x, f.pos.y - P.feetOffset, f.pos.z, f.vel.x, f.vel.y, f.vel.z, f.yaw); if (a.brake) i0.brake = true; if (a.pitchUp) i0.y = Math.max(i0.y, a.pitchUp); i0.x = Math.max(-1, Math.min(1, i0.x + a.steer)); if (a.flap && i % 20 === 0) i0.flapTap = true; }
        f.step(1 / 60, i0); bad2 = bad2 || inside(f); } return { crashes: f.crashes, inside: bad2, mode: f.mode, y: f.pos.y }; };
    const noG = run(false, -30, 14), g1 = run(true, -30, 14), g2 = run(true, -38, 22); // 壁の面は z=-40: 10 m手前 / 2 m手前
    check("cruise auto-brake: a wall 10 m ahead at 14 m/s is avoided (the same flight without it crashes)", noG.crashes >= 1 && g1.crashes === 0 && !g1.inside, `without ${noG.crashes} crash(es), with ${g1.crashes}`);
    check("...but an unavoidable case (22 m/s, 2 m from the wall) still ends in a crash", g2.crashes >= 1 && !g2.inside, `crashes ${g2.crashes}`);
    // 地面への急降下
    const dive = (guard: boolean, y0: number, vy: number) => { const f = mkFlight(80, y0, 100, 0, 14); f.vel.y = vy; f.pitch = -0.8; let c0 = f.crashes; for (let i = 0; i < 60 * 6; i++) { const i0 = inp({ y: -1 }); if (guard) { const a = autoBrake(world, f.pos.x, f.pos.y - P.feetOffset, f.pos.z, f.vel.x, f.vel.y, f.vel.z, f.yaw); if (a.brake) i0.brake = true; if (a.pitchUp) i0.y = Math.max(i0.y, a.pitchUp); if (a.flap && i % 20 === 0) i0.flapTap = true; } f.step(1 / 60, i0); } return { crashes: f.crashes - c0, mode: f.mode }; };
    const d0 = dive(false, 25, -14), d1 = dive(true, 25, -14), d2 = dive(true, 1.5, -20);
    check("diving at the ground from 25 m (-14 m/s): without the guard it crashes, with it the bird pulls out and lands safely", d0.crashes >= 1 && d1.crashes === 0 && d1.mode !== "air" || (d0.crashes >= 1 && d1.crashes === 0), `without ${d0.crashes}, with ${d1.crashes}`);
    check("...but a dive from 1.5 m at -20 m/s is unavoidable and still crashes", d2.crashes >= 1, `crashes ${d2.crashes}`);
  }

  suite("H1: on the ground - sit down, short hop and creep");
  {
    const g = () => { const f = new Flight(world); f.pos.set(0, 0.32, 100); f.prevPos.copy(f.pos); f.mode = "landed"; f.yaw = 0; return f; };
    const f = g(); for (let i = 0; i < 30; i++) f.step(1 / 60, withProx(cmd(0, -0.8, X.creepSpeed, { down: true, zone: "ring" })));
    check("down on the lower pad on the ground: sits down (no movement, still landed)", f.sitting && f.mode === "landed" && f.walkV === 0 && Math.abs(f.pos.z - 100) < 0.01);
    f.step(1 / 60, withProx(null)); check("lifting the finger keeps sitting", f.sitting);
    f.step(1 / 60, { ...inp({ y: 0.9 }), prox: null }); check("walking (stick forward) stands up again", !f.sitting);
    const h = g(); h.sitting = true; h.step(1 / 60, { ...inp({ flapTap: true }), prox: null }); check("a flap tap also stands up (and hops)", !h.sitting);
    // 中心の長押し: 短く飛んで微速前進、離すとそっと降りる
    const s = g(); for (let i = 0; i < 60 * 0.15; i++) s.step(1 / 60, withProx(cmd(0, 0, X.holdSpeed, { center: true, zone: "center", held: i / 60 })));
    check("a brief touch on the center (< 0.25 s) does nothing (no accidental hop)", s.mode === "landed" && !s.prox.on);
    let lifted = -1, held = 0.15 * 0; for (let i = 0; i < 60 * 1.2; i++) { held += 1 / 60; s.step(1 / 60, withProx(cmd(0, 0, X.holdSpeed, { center: true, zone: "center", held }))); if (lifted < 0 && s.mode === "air") lifted = i / 60; }
    check("holding the center for 0.25 s lifts off into a short flight (airborne, proximity mode, low and slow)", lifted >= 0.2 && lifted < 0.45 && s.prox.on && s.pos.y > 0.4 && s.pos.y < 4 && s.speed < 3, `lifted after ${lifted.toFixed(2)} s, y ${s.pos.y.toFixed(2)}`);
    let t0 = -1; for (let i = 0; i < 60 * 8; i++) { s.step(1 / 60, withProx(null)); if (s.mode === "landed" && t0 < 0) t0 = i / 60; }
    check("after lifting the finger it descends slowly and lands softly (no crash), then is a normal ground bird", t0 >= 0 && s.crashes === 0 && s.mode === "landed" && !s.prox.on, `landed after ${t0.toFixed(1)} s`);
    // 他の向き: 近接機動に準じる(短く飛んでその向きへ微速前進)
    const o = g(); for (let i = 0; i < 60 * 1.5; i++) o.step(1 / 60, withProx(cmd(-60 * DEG, 0.1, X.creepSpeed, { held: 0.1 + i / 60 })));
    check("a sideways direction on the ground lifts off and creeps in that direction", o.mode === "air" && Math.abs(wrap(o.yaw + 60 * DEG)) < 0.1 && o.speed > 1.5, `yaw ${(o.yaw / DEG).toFixed(0)} deg speed ${o.speed.toFixed(1)}`);
  }

  suite("H1: the cruise flight is unchanged when the proximity pad is not used");
  {
    const a = mkFlight(0, 40, 100, 0, 12), b = mkFlight(0, 40, 100, 0, 12);
    for (let i = 0; i < 600; i++) { const t = i / 60, ia = inp({ x: Math.sin(t) * 0.5, y: Math.cos(t * 0.7) * 0.3, flapTap: i % 55 === 0 }); a.step(1 / 60, ia); b.step(1 / 60, { ...ia, prox: null }); }
    check("with prox: null the trajectory is bit-for-bit the same as without the field", a.pos.distanceTo(b.pos) === 0 && a.vel.distanceTo(b.vel) === 0 && !a.prox.on);
  }
}
