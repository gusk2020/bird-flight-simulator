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
    const pl = new ProxLand({ marker: S } as never, al);
    for (let i = 0; i < secs * 60; i++) pl.update(f, 1 / 60, held);
    return started;
  };
  check("slow, facing the surface, near, held 1 s: auto landing starts once", run(-8, 2.6, 0, 1) === 1);
  check("passing by fast does not start it", run(-8, 12, 0, 1) === 0);
  check("facing away does not start it", run(-8, 2.6, Math.PI, 1) === 0);
  check("a brief touch (0.3 s) does not start it", run(-8, 2.6, 0, 0.3) === 0);
  check("finger released: nothing starts", run(-8, 2.6, 0, 1, false) === 0);
  check("too far (30 m) does not start it", run(30, 2.6, Math.PI, 1) === 0);
}
