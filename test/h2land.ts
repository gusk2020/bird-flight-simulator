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
