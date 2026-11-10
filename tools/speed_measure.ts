// H9: 通常巡航の速さの測定。同じ条件(開始位置・向き・風)で、操作の仕方ごとに 60 秒飛び、対地速度・対気速度の分布と高度の推移を出す。
// npx esbuild tools/speed_measure.ts --bundle --platform=node --outfile=dist-test/speed_measure.cjs && node dist-test/speed_measure.cjs
import { Flight } from "../src/flight";
import { FlapAssist } from "../src/assist";
import { CruiseGuard } from "../src/avoid";
import { Wind } from "../src/wind";
import { L } from "./autoland_success";
import { CRUISE, CruiseGovernor } from "../src/cruise";

const world = { colliders: L.colliders, heightAt: L.heightAt, perchAt: L.perchAt, perchPoint: L.perchPoint, wireDir: L.wireDir, waterAt: L.waterAt };
export interface Row { name: string; secs: number; gs: number[]; as: number[]; alt: number[]; crashes: number; stalls: number; landed: number }
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
/** 入力の仕方: tapEvery=その間隔(秒)で羽ばたきをタップ(0=触れない)、chain=連打(0.25 秒ごと)を tapEvery ごとに 2 秒、assist=片手の羽ばたき補助 */
export function run(name: string, o: { tapEvery: number; chain?: boolean; assist: boolean; wind?: boolean; govern?: boolean; boostAt?: number; secs?: number; v0?: number }): Row {
  const f = new Flight(world), as = new FlapAssist(), guard = new CruiseGuard(), gov = new CruiseGovernor(); as.enabled = o.assist; CRUISE.enabled = !!o.govern;
  if (o.wind) { const w = new Wind(world.colliders); w.set(270, 3, 0.3); f.wind = w; }
  f.pos.set(28, 25, 150); f.prevPos.copy(f.pos); f.yaw = 0; const v0 = o.v0 ?? 10; f.vel.set(-Math.sin(f.yaw) * v0, 0, -Math.cos(f.yaw) * v0);
  const gs: number[] = [], air: number[] = [], alt: number[] = []; let st = 0, nextTap = 0.5; const T = o.secs ?? 60;
  for (let k = 0; k < T * 60; k++) {
    const t = k / 60; const inp = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
    if (o.tapEvery > 0 && t >= nextTap) { inp.flapTap = true; nextTap = t + (o.chain ? 0.25 : o.tapEvery); if (o.chain && Math.floor(t / o.tapEvery) % 2 === 0) nextTap = t + o.tapEvery; }
    gov.update(f, inp, 1 / 60, false);
    if (f.mode === "air") guard.apply(world as never, f, inp);
    const out = as.apply(inp, f, false);
    f.step(1 / 60, out);
    if (f.stall) st++;
    if (k % 6 === 0 && f.mode === "air") { gs.push(Math.hypot(f.vel.x, f.vel.z)); air.push(f.airspeed); alt.push(f.pos.y); }
    if (f.mode !== "air") break;
  }
  return { name, secs: T, gs, as: air, alt, crashes: f.crashes, stalls: st, landed: f.mode === "air" ? 0 : 1 };
}
export function show(r: Row) {
  console.log(`${r.name.padEnd(34)} gs mean ${(r.gs.reduce((a, b) => a + b, 0) / Math.max(1, r.gs.length)).toFixed(1)} p50 ${pct(r.gs, 0.5).toFixed(1)} p90 ${pct(r.gs, 0.9).toFixed(1)} max ${Math.max(...r.gs, 0).toFixed(1)} | as med ${pct(r.as, 0.5).toFixed(1)} | alt ${r.alt[0]?.toFixed(0)}→${r.alt[r.alt.length - 1]?.toFixed(0)} | stall-steps ${r.stalls} crash ${r.crashes} ${r.landed ? "LANDED" : ""} (${r.gs.length} samples)`);
}
if (process.argv[1]?.includes("speed_measure")) {
  console.log("CRUISE", JSON.stringify(CRUISE));
  const cases: [string, Parameters<typeof run>[1]][] = [
    ["hands-off, assist (単一◎の指離し)", { tapEvery: 0, assist: true }],
    ["tap 1.5 s, assist", { tapEvery: 1.5, assist: true }],
    ["tap 1.2 s, assist", { tapEvery: 1.2, assist: true }],
    ["tap 1.0 s, assist", { tapEvery: 1.0, assist: true }],
    ["tap 0.8 s, assist", { tapEvery: 0.8, assist: true }],
    ["chain taps (0.25 s x 2 s / 3 s)", { tapEvery: 3, chain: true, assist: true }],
    ["legacy: tap 1.0 s, no assist", { tapEvery: 1.0, assist: false }],
    ["legacy: tap 0.6 s, no assist", { tapEvery: 0.6, assist: false }],
    ["hands-off with wind, assist", { tapEvery: 0, assist: true, wind: true }],
  ];
  if (process.env.SCALE0) CRUISE.scale0 = Number(process.env.SCALE0);
  for (const g of [false, true]) { console.log(g ? "--- 低速巡航 ON" : "--- 従来(OFF)"); for (const [n, o] of cases) show(run(n, { ...o, govern: g, secs: 20 })); }
}
