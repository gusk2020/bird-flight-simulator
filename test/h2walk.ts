import { check, suite } from "./harness";
import { L, world } from "./common";
import { Flight, type FlightInput } from "../src/flight";
import { PHYS as P } from "../src/params";
import { PerchAssist } from "../src/perchassist";
import { buildSurfaces, type Surface } from "../src/perches";
import { perchClass } from "../src/perchclass";

const idx = buildSurfaces(L);
const I = (o: Partial<FlightInput> = {}): FlightInput => ({ x: 0, y: 0, flapHeld: false, flapTap: false, brake: false, ...o });
export interface WalkResult { moved: number; staysOn: boolean; stepped: boolean; crashed: boolean; endMode: string; settledSecs: number }
/** 長手方向の端から0.6 m(短ければ1/4)の点に立ち、長手方向へスティックを前へ4秒。実際の座標の移動量と、足元の面を毎フレーム確かめる(見かけだけの歩行は数えない)。 */
export function walkOn(s: Surface): WalkResult | null {
  const w = s.maxX - s.minX, d = s.maxZ - s.minZ, alongX = w >= d, cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
  const sx = alongX ? s.minX + Math.min(0.6, w * 0.25) : cx, sz = alongX ? cz : s.minZ + Math.min(0.6, d * 0.25);
  if (Math.abs(world.heightAt(sx, sz) - s.top) > 0.06) return null; // その点が面の上でない(形が違う)ものは除く
  const f = new Flight(world), pa = new PerchAssist(idx), under: Surface[] = [];
  f.pos.set(sx, s.top + P.feetOffset, sz); f.prevPos.copy(f.pos); f.mode = "landed"; f.vel.set(0, 0, 0); f.yaw = alongX ? -Math.PI / 2 : Math.PI;
  const x0 = f.pos.x, z0 = f.pos.z, c0 = f.crashes; let moved = 0, staysOn = true, stepped = false;
  for (let i = 0; i < 60 * 4; i++) {
    f.step(1 / 60, pa.apply(I({ y: 1 }), f));
    const u = idx.under(f.pos.x, f.pos.y - P.feetOffset, f.pos.z, under);
    if (u === s && f.mode === "landed") moved = Math.max(moved, Math.hypot(f.pos.x - x0, f.pos.z - z0)); else if (!stepped) { stepped = true; staysOn = false; }
  }
  let settled = -1; // 降りたあと、立ち止まって(スティックなしで)接地または止まるまでの秒数
  for (let i = 0; i < 60 * 6; i++) { f.step(1 / 60, pa.apply(I(), f)); if (settled < 0 && (f.mode === "landed" || f.mode === "perch") && f.vel.length() < 0.2) settled = i / 60; }
  return { moved, staysOn: staysOn && !stepped, stepped, crashed: f.crashes > c0, endMode: f.mode, settledSecs: settled };
}
export function h2WalkTests() {
  suite("H2: stand / walk / step off (real displacement and contact state)");
  const kinds = ["wall", "bench", "balcony", "rail", "fence", "sign", "rock", "branch", "pole", "planter", "roof"] as const;
  const table: Record<string, { walk: [number, number]; stand: [number, number]; stepOk: [number, number]; n: number; cls: string }> = {};
  let walkClassTotal = 0, walkClassOk = 0, standWalked = 0, standTotal = 0, stepTotal = 0, stepOk = 0;
  for (const k of kinds) {
    const ss = idx.all.filter(s => s.kind === k), t = (table[k] = { walk: [0, 0], stand: [0, 0], stepOk: [0, 0], n: 0, cls: "" });
    for (const s of ss) {
      const r = walkOn(s); if (!r) continue; t.n++; const c = perchClass(s); t.cls = c.use;
      if (c.use === "walk") { t.walk[1]++; walkClassTotal++; const need = Math.min(1.5, c.walkM * 0.8); if (r.moved >= need && !r.crashed) { t.walk[0]++; walkClassOk++; } }
      else { t.stand[1]++; standTotal++; if (r.moved > c.length) standWalked++; t.stand[0]++; }
      if (r.stepped) { t.stepOk[1]++; stepTotal++; if (!r.crashed && r.settledSecs >= 0 && (r.endMode === "landed" || r.endMode === "perch")) { t.stepOk[0]++; stepOk++; } }
    }
  }
  console.log("   kind     class  surfaces  walk(real distance ok/class)  stepped-off(ok=landed again, no crash)");
  for (const [k, t] of Object.entries(table)) console.log(`   ${k.padEnd(8)} ${t.cls.padEnd(6)} ${String(t.n).padStart(3)}  ${t.walk[1] ? `${t.walk[0]}/${t.walk[1]}` : "-"}  ${t.stepOk[1] ? `${t.stepOk[0]}/${t.stepOk[1]}` : "-"}`);
  check("walk-class surfaces (length >= ~3 m): the bird really moves along them (>= min(1.5 m, 80% of the walkable length)) while standing on the same surface, no crash", walkClassTotal > 100 && walkClassOk / walkClassTotal >= 0.95, `${walkClassOk}/${walkClassTotal}`);
  check("stand-class surfaces are never counted as walkable and the bird never travels farther than the surface is long", standTotal > 30 && standWalked === 0, `stand=${standTotal} overtravel=${standWalked}`);
  check("after stepping off the end the bird touches down again (landed or perched) within 6 s without a crash", stepTotal > 20 && stepOk / stepTotal >= 0.9, `${stepOk}/${stepTotal}`);
  check("a pole (0.5 m) is stand-only: pushing forward does not move the bird along it", (idx.all.filter(s => s.kind === "pole").map(walkOn).filter(Boolean) as WalkResult[]).every(r => r.moved < 0.05));
}
