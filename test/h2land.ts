import { check, suite } from "./harness";
import { Flight } from "../src/flight";
import { ProxLand } from "../src/proxland";

const S = { id: 1, kind: "roof", minX: -3, maxX: 3, minZ: -20, maxZ: -10, top: 5, edge: false, axisAlongX: true } as never;
const world = { colliders: [], heightAt: () => 0, perchAt: () => null } as never;
export function h2LandTests() {
  suite("H2: landing intent from the proximity approach");
  const run = (z: number, v: number, yaw: number, secs: number, held = true) => {
    const f = new Flight(world); f.pos.set(0, 7, z); f.yaw = yaw; f.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
    let started = 0; const al = { active: false, start: () => { started++; return true; } } as never;
    const pl = new ProxLand({ marker: S, target: S } as never, al);
    for (let i = 0; i < secs * 60; i++) pl.update(f, 1 / 60, held);
    return started;
  };
  check("slow, facing the surface, near, held 1 s: auto landing starts once", run(-8, 2.6, 0, 1) === 1);
  check("passing by fast does not start it", run(-8, 12, 0, 1) === 0);
  check("facing away does not start it", run(-8, 2.6, Math.PI, 1) === 0);
  check("a brief touch (0.3 s) does not start it", run(-8, 2.6, 0, 0.3) === 0);
  check("a stale marker (kept by the hold timer, not currently chosen) never starts it", (() => { const f = new Flight(world); f.pos.set(0, 7, -8); f.vel.set(0, 0, -2.6); let st = 0; const al = { active: false, start: () => { st++; return true; } } as never; const pl = new ProxLand({ marker: S, target: null } as never, al); for (let i = 0; i < 90; i++) pl.update(f, 1 / 60, true); return st === 0; })());
  check("finger released: nothing starts", run(-8, 2.6, 0, 1, false) === 0);
  check("too far (30 m) does not start it", run(30, 2.6, Math.PI, 1) === 0);
}

import { ringVisible, RingDiag, edgePosition } from "../src/ringdiag";
export function h2RingTests() {
  suite("H2: landing candidate ring - visibility reasons and diagnosis");
  const base = { auto: false, mode: "air", hopping: false, stun: 0, hasMarker: true, d: 6, maxD: 16, sx: 0.1, sy: -0.2, sz: 0.9, autoLand: false };
  const r = (o: Partial<typeof base>) => ringVisible({ ...base, ...o }).reason;
  check("visible with a marker, in the air, near, on screen", r({}) === "shown");
  check("each hidden state has its own reason", r({ auto: true }) === "autopilot" && r({ hasMarker: false }) === "no-marker" && r({ mode: "landed" }) === "not-air" && r({ hopping: true }) === "hopping" && r({ stun: 0.2 }) === "stunned" && r({ d: 17 }) === "out-of-range" && r({ sz: 1.2 }) === "edge" && r({ sx: 1.3 }) === "edge" && r({ sy: -1.2 }) === "edge");
  check("inside the screen: drawn in the world; outside or behind the camera: a small ring is pinned to the screen edge instead of vanishing", r({ sx: 0.98 }) === "shown" && r({ sy: -0.98 }) === "shown" && r({ sx: 1.05 }) === "edge" && r({ sy: -1.05 }) === "edge" && ringVisible({ ...base, sx: 1.05 }).show);
  { const e1 = edgePosition(2, 0, 0.5, 800, 400), e2 = edgePosition(0.1, -3, 0.5, 800, 400), e3 = edgePosition(0.5, 0.2, 1.5, 800, 400); check("the edge position is always inside the screen with a margin, on the side where the candidate is (reversed when behind)", e1.x > 700 && e1.x <= 764 && e2.y > 300 && e2.y <= 364 && e3.x < 400 && e3.y > 200 && [e1, e2, e3].every(e => e.x >= 36 && e.x <= 764 && e.y >= 72 && e.y <= 364) && edgePosition(0, 3, 0.5, 800, 400).y >= 72, JSON.stringify([e1, e2, e3])); }
  const d = new RingDiag(); d.update(0, "no-marker", "", 0, 0, false); d.update(1, "shown", "roof", 9, 0.1, false); d.update(2, "shown", "roof", 8, 0.2, false); d.update(5.5, "out-of-range", "roof", 8, 4.5, true);
  check("the log records transitions only, and how long the ring was shown", d.log.length === 2 && Math.abs(d.lastShownFor - 4.5) < 1e-9 && d.log[1].reason === "out-of-range" && d.log[1].stale, JSON.stringify(d.log));
}

import { PerchAssist } from "../src/perchassist";
import { AutoLand } from "../src/autoland";
import { buildSurfaces } from "../src/perches";
import { L as LAY } from "./common";
import { Wind } from "../src/wind";
export function h5WindTests() {
  suite("H5: wind - upwind approach for small free-standing perches");
  const idx = buildSurfaces(LAY), sign = idx.all.find(s => s.kind === "sign" && !LAY.colliders.some(c => c.maxX - c.minX > 3 && c.maxZ - c.minZ > 3 && c.top > s.top + 0.3 && c.maxX > s.minX - 12 && c.minX < s.maxX + 12 && c.maxZ > s.minZ - 12 && c.minZ < s.maxZ + 12))!;
  const mk = (windDir: number) => { // 風は西から 3 m/s(bearing 270)。足場の風上側(西)から東へ向かう = 向かい風、風下側(東)から西へ向かう = 追い風
    const f = new Flight(world); const w = new Wind(); w.set(270, 3, 0); f.wind = w;
    const cx = (sign.minX + sign.maxX) / 2, cz = (sign.minZ + sign.maxZ) / 2; f.pos.set(cx + windDir * 12, sign.top + 2.4, cz); f.prevPos.copy(f.pos); f.yaw = windDir > 0 ? Math.PI / 2 : -Math.PI / 2; f.vel.set(-windDir * 7, -0.3, 0);
    const pa = new PerchAssist(idx), al = new AutoLand(idx, pa, LAY.heightAt); return { f, al, ok: al.start(f, sign) };
  };
  const tail = mk(-1), head = mk(1);
  check("with a tailwind the approach to a small free-standing perch goes around to the downwind side first (waypoint set), with a headwind it goes straight", tail.ok && !!tail.al.wp && head.ok && !head.al.wp, `tail wp=${!!tail.al.wp} head wp=${!!head.al.wp}`);
  check("the waypoint lies on the downwind (east) side of the perch and the detour does not start toward a building", !!tail.al.wp && tail.al.wp.x > sign.maxX + 3);
}
