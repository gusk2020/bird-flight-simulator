// オートパイロット長時間耐久試験: node でゲーム内時間を高速に進める(描画なし・物理は実機と同じ固定60Hz)。
// 使い方: npx esbuild tools/autopilot_endurance.ts --bundle --platform=node --outfile=dist-test/endurance.cjs && node dist-test/endurance.cjs [分=30] [シード数=3]
import { Flight } from "../src/flight";
import { generateLayout } from "../src/layout";
import { Autopilot } from "../src/autopilot";
import type { AutoPolicy } from "../src/settings";

const L = generateLayout();
const world = { colliders: L.colliders, heightAt: L.heightAt, perchAt: L.perchAt, perchPoint: L.perchPoint, wireDir: L.wireDir };
const minutes = Number(process.argv[2] || 30), nSeeds = Number(process.argv[3] || 3);
const BOUND = 205;
interface R { policy: string; seed: number; crashes: number; teleports: number; resets: number; stuck: number; out: number; landings: number; walks: number; perches: number; takeoffs: number; ground: number; inside: number; maxStep: number; crashAt: string[] }
function sim(policy: AutoPolicy, seed: number): R {
  const f = new Flight(world); f.pos.set(28, 30, 110); f.prevPos.copy(f.pos); f.vel.set(0, 0, -10);
  const ap = new Autopilot(L, seed); ap.setPolicy(policy); ap.start(f);
  const o = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
  const c0 = f.crashes; let stuck = 0, out = 0, inside = 0, ground = 0, maxStep = 0, win = 0, wx = f.pos.x, wz = f.pos.z, calm = true; const crashAt: string[] = []; const prev = f.pos.clone();
  const total = minutes * 3600;
  for (let i = 0; i < total; i++) {
    const cc = f.crashes, st = ap.state;
    o.flapTap = false; ap.drive(f, o, 1 / 60); f.step(1 / 60, o);
    if (f.crashes !== cc && crashAt.length < 6) crashAt.push(`${(i / 3600).toFixed(1)}m ${st} v${f.speed.toFixed(0)} y${f.pos.y.toFixed(0)}`);
    if (ap.state === "rest" || ap.state === "walk") calm = false; // 休憩・歩行は意図した停止なので固着に数えない
    if (++win >= 1200) { // 20秒ごと: 休憩/歩行以外の状態で5m未満しか動けていなければ「重大な固着」
      if (calm && Math.hypot(f.pos.x - wx, f.pos.z - wz) < 5) stuck++;
      win = 0; wx = f.pos.x; wz = f.pos.z; calm = true;
    }
    if (Math.abs(f.pos.x) > BOUND || Math.abs(f.pos.z) > BOUND) out++;
    if (f.mode === "landed" || f.mode === "perch") ground++;
    if (L.colliders.some(c => f.pos.x > c.minX && f.pos.x < c.maxX && f.pos.z > c.minZ && f.pos.z < c.maxZ && f.pos.y - 0.32 < c.top - 0.3)) inside++;
    const d = f.pos.distanceTo(prev); if (d > maxStep) maxStep = d; prev.copy(f.pos);
  }
  return { policy, seed, crashes: f.crashes - c0, teleports: ap.stats.teleports, resets: f.resets, stuck, out, landings: ap.stats.landings, walks: ap.stats.walks, perches: ap.stats.perches, takeoffs: ap.stats.takeoffs, ground: ground / total, inside, maxStep, crashAt };
}
const pol: AutoPolicy[] = ["life", "scenic", "adventure", "random"], all: R[] = [];
for (const p of pol) for (let s = 1; s <= nSeeds; s++) { const r = sim(p, s * 7 + 1); all.push(r); console.log(`${p.padEnd(9)} seed${String(r.seed).padStart(2)} crash=${r.crashes} tele=${r.teleports} stuck=${r.stuck} out=${r.out} inside=${r.inside} land=${r.landings} walk=${r.walks} perch=${r.perches} takeoff=${r.takeoffs} ground=${(100 * r.ground).toFixed(0)}% maxStep=${r.maxStep.toFixed(2)}${r.crashAt.length ? "  [" + r.crashAt.join("; ") + "]" : ""}`); }
const sum = (k: keyof R) => all.reduce((a, r) => a + (r[k] as number), 0);
console.log(`TOTAL (${all.length} runs x ${minutes} min = ${all.length * minutes} min): crashes=${sum("crashes")} teleports=${sum("teleports")} stuck=${sum("stuck")} out=${sum("out")} inside=${sum("inside")} landings=${sum("landings")} walks=${sum("walks")} perches=${sum("perches")} takeoffs=${sum("takeoffs")}`);
