import { check, suite } from "./harness";
import { L, world } from "./common";
import { Flight, type FlightInput } from "../src/flight";
import { PHYS as P } from "../src/params";
import { OneHandGesture } from "../src/gesture";
import { FlapAssist } from "../src/assist";
import { PerchAssist } from "../src/perchassist";
import { buildSurfaces } from "../src/perches";
import { Forage } from "../src/forage";

// 実機の片手操作と同じ入力の流れ: 指(ジェスチャ) → 着地補助 → 羽ばたき補助 → ついばみ → 物理
const idx = buildSurfaces(L);
class Rig {
  g = new OneHandGesture(); pa = new PerchAssist(idx); fa = new FlapAssist(); fg: Forage; t = 0; f: Flight;
  modes = new Set<string>();
  constructor(f: Flight, seed = 3) { this.f = f; this.fa.enabled = true; this.fg = new Forage(L.groundAt, seed); }
  down() { this.g.down(1, 200, 600, this.t, 60); }
  /** 指を (dx, dy) px へ(上が負) */
  slide(dx: number, dy: number) { this.g.move(1, 200 + dx, 600 + dy); }
  up() { this.g.up(1, this.t); }
  input(): FlightInput {
    const g = this.g; g.poll(this.t);
    const o: FlightInput = { x: g.x, y: g.y, brake: g.brake, flapTap: g.consumeTap(), flapHeld: false };
    return this.fg.apply(this.fa.apply(this.pa.apply(o, this.f), this.f), this.f, true);
  }
  run(secs: number, each?: (r: Rig, i: number) => void) {
    for (let i = 0; i < secs * 60; i++) { each?.(this, i); this.f.step(1 / 60, this.input()); this.t += 1000 / 60; this.modes.add(this.f.mode); }
  }
}
const landed = (x: number, z: number, yaw = 0, y?: number) => { const f = new Flight(world); f.pos.set(x, (y ?? world.heightAt(x, z)) + P.feetOffset, z); f.prevPos.copy(f.pos); f.mode = "landed"; f.yaw = yaw; return f; };
const flat = (f: Flight) => Math.hypot(f.pos.x - f.prevPos.x, f.pos.z - f.prevPos.z);
const lot = (use: string) => L.lots.find(l => l.use === use)!;

export function f1WalkTests() {
  suite("F1: walking after landing (one-hand thumb, real input chain)");
  const town = lot("town"), vc = lot("vacant");
  // 舗装された区画の中(ついばみが起きない地面)で、指を前へスライドしたまま歩く
  const gx = L.roads[4], gz = town.z + 8; // 道路の上を道路に沿って(北へ)歩く(ついばまない・壁がない)
  { const r = new Rig(landed(gx, gz, 0)); const x0 = r.f.pos.clone(); r.down(); r.slide(0, -45); let vmax = 0; r.run(4, rr => { vmax = Math.max(vmax, rr.f.walkV); });
    const d = Math.hypot(r.f.pos.x - x0.x, r.f.pos.z - x0.z);
    check("stick forward on the ground walks (no long press needed)", d > 4 && r.f.mode === "landed", `${d.toFixed(2)} m in 4 s, vmax=${vmax.toFixed(2)} m/s, mode=${r.f.mode}`);
    r.slide(0, -18); const v1: number[] = []; r.run(1.5, rr => v1.push(rr.f.walkV)); r.slide(0, -45); r.run(1.5);
    check("a small forward push walks slower (speed follows the stick)", v1[v1.length - 1] > 0.1 && v1[v1.length - 1] < P.walkSpeed * 0.7, `v=${v1[v1.length - 1].toFixed(2)}`);
    r.up(); r.run(1); check("lifting the thumb stops the walk", r.f.walkV < 0.05 && flat(r.f) < 1e-3); }
  { const r = new Rig(landed(gx, gz, 0)); const y0 = r.f.yaw, p0 = r.f.pos.clone(); r.down(); r.slide(30, -40); r.run(3);
    const d = Math.hypot(r.f.pos.x - p0.x, r.f.pos.z - p0.z), turned = Math.abs(r.f.yaw - y0);
    check("turning while walking (diagonal stick)", d > 2.5 && turned > 0.8, `${d.toFixed(2)} m, turned ${turned.toFixed(2)} rad`);
    r.slide(45, 0); const p1 = r.f.pos.clone(); r.run(1); check("sideways only: turns on the spot, does not walk", Math.hypot(r.f.pos.x - p1.x, r.f.pos.z - p1.z) < 0.3); r.up(); }
  { const r = new Rig(landed(gx, gz, 0)); const p0 = r.f.pos.clone(); r.down(); r.run(1.5); const dHold = Math.hypot(r.f.pos.x - p0.x, r.f.pos.z - p0.z);
    r.slide(0, -45); r.run(1.5); const dBoth = Math.hypot(r.f.pos.x - p0.x, r.f.pos.z - p0.z);
    check("long press still walks, and sliding the held thumb forward keeps walking (no stop)", dHold > 1 && dBoth > dHold + 2, `hold ${dHold.toFixed(2)} m, then ${dBoth.toFixed(2)} m`); r.up(); }
  // 飛行 → 着地 → (指を離さず)そのまま歩く
  { const f = new Flight(world); f.pos.set(gx, world.heightAt(gx, gz) + P.feetOffset + 0.8, gz); f.prevPos.copy(f.pos); f.yaw = 0; f.vel.set(-Math.sin(f.yaw) * 5, 0, -Math.cos(f.yaw) * 5);
    const r = new Rig(f); r.down(); r.slide(0, 25); let landT = -1; r.run(3, (rr, i) => { if (landT < 0 && rr.f.mode === "landed") landT = i; });
    r.slide(0, -45); const p0 = r.f.pos.clone(); r.run(3);
    check("after landing, the bird is controllable at once: stick forward walks", landT >= 0 && Math.hypot(r.f.pos.x - p0.x, r.f.pos.z - p0.z) > 3 && r.f.mode === "landed", `d=${Math.hypot(r.f.pos.x - p0.x, r.f.pos.z - p0.z).toFixed(2)} mode=${r.f.mode} walkV=${r.f.walkV.toFixed(2)} g=${r.g.phase} landed at ${(landT / 60).toFixed(2)} s, modes=${[...r.modes].join(",")}`);
    r.up(); r.t += 50; r.down(); r.t += 80; r.up(); r.run(1.2); check("tap on the ground hops, and it lands again and can walk", r.f.mode === "landed" && [...r.modes].includes("air"), `mode=${r.f.mode} y=${r.f.pos.y.toFixed(2)}`); }
  // 足場(ベンチ/低い壁)の上で歩く: 端で止まり、落ちない
  { const w = L.lows.find(l => l.kind === "wall" && l.hw > 3)!; const yaw = w.hw >= w.hd ? -Math.PI / 2 : 0;
    const r = new Rig(landed(w.x, w.z, yaw, w.top)); r.down(); r.slide(0, -45); let maxAlong = 0; r.run(6, rr => { maxAlong = Math.max(maxAlong, Math.abs(rr.f.pos.x - w.x)); });
    check("on a wall top: stick forward walks along it and stops at the end (does not walk off)", r.f.mode === "landed" && maxAlong > w.hw - 1.2 && Math.abs(r.f.pos.y - P.feetOffset - w.top) < 0.05, `along=${maxAlong.toFixed(2)} of ${w.hw}, y=${(r.f.pos.y - P.feetOffset).toFixed(2)} top=${w.top}`);
    r.slide(0, 0); r.slide(-45, 0); const back = r.f.yaw + Math.PI; let k = 0; while (Math.abs(Math.atan2(Math.sin(r.f.yaw - back), Math.cos(r.f.yaw - back))) > 0.4 && k++ < 600) r.run(1 / 60); r.slide(0, -45); const x1 = r.f.pos.x; r.run(2);
    check("turning around on the wall and walking back works", Math.abs(r.f.pos.x - x1) > 1.5 && r.f.mode === "landed", `${Math.abs(r.f.pos.x - x1).toFixed(2)} m`); r.up(); }

  suite("F5: pecking while walking with the thumb held forward");
  { const r = new Rig(landed(vc.x - 12, vc.z + 6, -Math.PI / 2), 11); r.down(); r.slide(0, -45); const p0 = r.f.pos.clone(); let walkAfter = 0, lastSeq = 0;
    r.run(24, rr => { if (rr.fg.stats.sequences > lastSeq) lastSeq = rr.fg.stats.sequences; if (lastSeq >= 1 && rr.fg.state === "idle" && rr.f.walkV > 1) walkAfter++; });
    const d = Math.hypot(r.f.pos.x - p0.x, r.f.pos.z - p0.z);
    check("walk → stop → peck 1-3 times → walk again, repeatedly, while the thumb stays forward", r.fg.stats.sequences >= 3 && r.fg.stats.pecks >= r.fg.stats.sequences && walkAfter > 60 && d > 8 && r.fg.stats.interrupts === 0, `seq=${r.fg.stats.sequences} pecks=${r.fg.stats.pecks} dist=${d.toFixed(1)} m interrupts=${r.fg.stats.interrupts}`);
    let inPeck = false; r.run(10, rr => { if (!inPeck && rr.fg.state !== "idle") { inPeck = true; rr.slide(45, -45); } });
    check("a big stick change during pecking interrupts it at once", inPeck && r.fg.stats.interrupts >= 1);
    r.slide(0, -45); let t0 = -1, t1 = -1; r.run(10, (rr, i) => { if (t0 < 0 && rr.fg.state !== "idle") { t0 = i; rr.up(); rr.t += 40; rr.down(); rr.t += 60; rr.up(); } if (t0 >= 0 && t1 < 0 && rr.f.mode === "air") t1 = i; });
    check("a tap during pecking hops right away (within 0.1 s)", t0 >= 0 && t1 >= 0 && t1 - t0 <= 6, `${t0}->${t1}`); }
}
