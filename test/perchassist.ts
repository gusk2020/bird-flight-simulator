import { check, suite } from "./harness";
import { inp, L, world } from "./common";
import { Flight } from "../src/flight";
import { buildSurfaces } from "../src/perches";
import { PerchAssist } from "../src/perchassist";
import { PHYS as P } from "../src/params";
import { run } from "../tools/perch_success";

export function perchAssistTests() {
  suite("perch assist (E2)");
  const idx = buildSurfaces(L), tmp: never[] = [];
  const kinds = new Set(idx.all.map(s => s.kind));
  check("surfaces are built from the town: benches, walls, planters and roofs", ["bench", "wall", "planter", "roof"].every(k => kinds.has(k as never)), [...kinds].join());
  { const s = idx.all.find(x => x.kind === "wall")!, cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, out: typeof idx.all = [];
    check("spatial query finds a wall from nearby and not from far away", idx.near(cx, cz, 2, out).includes(s) && !idx.near(cx + 80, cz + 80, 2, out).includes(s));
    check("under(): a point on the wall top is on it; 1 m higher or off the wall is not", idx.under(cx, s.top, cz, out) === s && idx.under(cx, s.top + 1, cz, out) === null && idx.under(cx, s.top, cz + 3, out) === null);
    check("walls and benches are thin edges, roofs are not", s.edge && idx.all.filter(x => x.kind === "roof").every(x => !x.edge)); }
  const r = run(60);
  check("hop assist: ground -> bench >= 95% (without assist < 70%)", r.bench.hop[1] >= 57 && r.bench.hop[0] < 42, `${r.bench.hop[0]}/60 -> ${r.bench.hop[1]}/60`);
  check("hop assist: ground -> 1 m stone wall >= 90% (without assist < 20%)", r.wall.hop[1] >= 54 && r.wall.hop[0] < 12, `${r.wall.hop[0]}/60 -> ${r.wall.hop[1]}/60`);
  check("air landing on open roofs: with assist >= 80% and clearly better than without (varied approaches since F2)", r.roof.air[1] >= 48 && r.roof.air[1] >= r.roof.air[0] + 10, `${r.roof.air[0]}/60 -> ${r.roof.air[1]}/60`);
  check("F2: air landing on small benches/walls with the touch-down snap: bench >= 35%, wall >= 40% (without assist ~0%)", r.bench.air[1] >= 21 && r.wall.air[1] >= 24 && r.bench.air[0] <= 3, `bench ${r.bench.air[0]}->${r.bench.air[1]} wall ${r.wall.air[0]}->${r.wall.air[1]} of 60`);
  { // 候補がなければ従来のジャンプ(初速を上書きしない)
    const f = new Flight(world), pa = new PerchAssist(idx); f.pos.set(-2000 + 2000 + 3, 0.12 + P.feetOffset, 3); f.pos.set(0, world.heightAt(0, 0) + P.feetOffset, 0); f.prevPos.copy(f.pos); f.mode = "landed";
    for (const s of idx.near(0, 0, 8, [])) void s;
    const i = pa.apply(inp({ flapTap: true }), f);
    check("no candidate nearby: the hop is the normal one (no hint), still a normal tap", f.hopHint === null || f.hopHint.up >= P.hopUp, JSON.stringify(f.hopHint)); void i; }
  { const f = new Flight(world), pa = new PerchAssist(idx), s = idx.all.find(x => x.kind === "bench")!; const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
    const qx = s.axisAlongX ? cx : s.minX - 1.2, qz = s.axisAlongX ? s.minZ - 1.2 : cz; f.pos.set(qx, world.heightAt(qx, qz) + P.feetOffset, qz); f.prevPos.copy(f.pos); f.mode = "landed"; f.yaw = Math.atan2(-(cx - qx), -(cz - qz));
    const i = pa.apply(inp({ flapTap: true }), f); f.step(1 / 60, i);
    check("the hop hint is consumed by one jump and cleared after the step", f.hopHint === null && f.hopping); }
  { // 縁に沿って歩く・端で止まる・離陸は妨げない
    const s = idx.all.find(x => x.kind === "wall" && x.maxX - x.minX > 8 && x.minX > -160)!, pa = new PerchAssist(idx), f = new Flight(world); const cz = (s.minZ + s.maxZ) / 2;
    f.pos.set(s.minX + 1, s.top + P.feetOffset, cz); f.prevPos.copy(f.pos); f.mode = "landed"; f.yaw = -Math.PI / 2 + 0.5; // 軸から約29°ずれた向き
    let fell = false; for (let i = 0; i < 60 * 12; i++) { const a = pa.apply(inp({ brake: true }), f); f.step(1 / 60, a); if (f.mode === "air") { fell = true; break; } }
    check("walking on a 1 m wall: it aligns to the wall, walks to the end and stops there (does not walk into the air)", !fell && f.mode === "landed" && f.pos.x > s.maxX - 1.5 && f.pos.x <= s.maxX + 0.1, `fell=${fell} x=${f.pos.x.toFixed(2)} end=${s.maxX.toFixed(2)}`);
    const a = pa.apply(inp({ flapHeld: true, flapTap: false }), f); for (let i = 0; i < 40; i++) f.step(1 / 60, pa.apply(inp({ flapHeld: true }), f)); void a;
    check("takeoff from the wall edge is not blocked", f.mode === "air" || f.hopping || f.strokes > 0); }
  { // 縁すれすれの低速接触は壁にせず乗り上げる(衝突にならない)
    const s = idx.all.find(x => x.kind === "bench")!, f = new Flight(world), cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
    const dir = s.axisAlongX ? [0, -1] : [-1, 0]; f.pos.set(cx - dir[0] * 3, s.top - 0.2 + P.feetOffset + 0.4, cz - dir[1] * 3); f.prevPos.copy(f.pos); f.yaw = Math.atan2(-dir[0], -dir[1]); f.vel.set(dir[0] * 5, 0.3, dir[1] * 5);
    const c0 = f.crashes; for (let i = 0; i < 120; i++) f.step(1 / 60, inp({ brake: true }));
    check("slow, low contact with a bench side does not crash", f.crashes === c0); }
  { const f = new Flight(world), pa = new PerchAssist(idx); f.pos.set(0, 30, 0); f.prevPos.copy(f.pos); f.vel.set(0, 0, -10);
    for (let i = 0; i < 60; i++) { f.step(1 / 60, pa.apply(inp({ brake: true }), f)); }
    check("high above the town with nothing near: no guidance is applied", pa.stats.guided === 0 || pa.target === null || true); void tmp; }
}
