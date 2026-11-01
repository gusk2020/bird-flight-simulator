// オートパイロット長時間耐久試験: node でゲーム内時間を高速に進める(描画なし・物理は実機と同じ固定60Hz)。
// 使い方: npx esbuild tools/autopilot_endurance.ts --bundle --platform=node --outfile=dist-test/endurance.cjs && node dist-test/endurance.cjs [分=30] [シード数=3]
import { Flight } from "../src/flight";
import { generateLayout } from "../src/layout";
import { Autopilot } from "../src/autopilot";
import { Forage } from "../src/forage";
import { CruiseGuard } from "../src/avoid";
import { Puddles, buildPuddles } from "../src/puddles";
import type { AutoPolicy } from "../src/settings";

const L = generateLayout();
const world = { colliders: L.colliders, heightAt: L.heightAt, perchAt: L.perchAt, perchPoint: L.perchPoint, wireDir: L.wireDir, waterAt: L.waterAt };
const minutes = Number(process.argv[2] || 30), nSeeds = Number(process.argv[3] || 3);
const BOUND = 205;
const H4 = !process.argv.includes("--no-h4"); // 巡航ガード・水辺行動を切って比べる
interface R { drinks: number; sits: number; policy: string; seed: number; crashes: number; teleports: number; resets: number; stuck: number; out: number; landings: number; walks: number; perches: number; takeoffs: number; pecks: number; ground: number; inside: number; maxStep: number; crashAt: string[] }
function sim(policy: AutoPolicy, seed: number): R {
  const f = new Flight(world); f.pos.set(28, 30, 110); f.prevPos.copy(f.pos); f.vel.set(0, 0, -10);
  const ap = new Autopilot(L, seed); ap.setPolicy(policy); ap.start(f);
  const pd = new Puddles(buildPuddles(L)), cg = new CruiseGuard(); let drinkSits = 0;
  if (H4) ap.water = (x, z) => { const n = pd.nearest(x, z); if (!n) return null; const dx = x - n.p.x, dz = z - n.p.z, h = Math.hypot(dx, dz) || 1, r = pd.radius(n.p); return { x: n.p.x + dx / h * (r - 0.3), z: n.p.z + dz / h * (r - 0.3), d: n.d }; }; const fg = new Forage(L.groundAt, seed);
  const o = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
  const c0 = f.crashes; let stuck = 0, out = 0, inside = 0, ground = 0, maxStep = 0, win = 0, wx = f.pos.x, wz = f.pos.z, calm = true; const crashAt: string[] = []; const prev = f.pos.clone();
  const total = minutes * 3600;
  for (let i = 0; i < total; i++) {
    const cc = f.crashes, st = ap.state;
    o.flapTap = false; ap.busy = fg.active; pd.update(1 / 60, (i / 3600) % 8 < 3 ? 1 : 0, 0.6);
    const ao = ap.drive(f, o, 1 / 60); if (H4 && ap.state === "cruise" && f.mode === "air" && !f.hopping && f.stun <= 0) cg.apply(L as never, f, ao); f.step(1 / 60, fg.apply(ao, f, false));
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
  void drinkSits; return { policy, seed, drinks: ap.stats2.drinks, sits: ap.stats2.sits, crashes: f.crashes - c0, teleports: ap.stats.teleports, resets: f.resets, stuck, out, landings: ap.stats.landings, walks: ap.stats.walks, perches: ap.stats.perches, takeoffs: ap.stats.takeoffs, pecks: fg.stats.pecks, ground: ground / total, inside, maxStep, crashAt };
}
const pol: AutoPolicy[] = ["life", "scenic", "adventure", "random"], all: R[] = [];
for (const p of pol) for (let s = 1; s <= nSeeds; s++) { const r = sim(p, s * 7 + 1); all.push(r); console.log(`${p.padEnd(9)} seed${String(r.seed).padStart(2)} crash=${r.crashes} tele=${r.teleports} stuck=${r.stuck} out=${r.out} inside=${r.inside} drink=${r.drinks} sit=${r.sits} land=${r.landings} walk=${r.walks} perch=${r.perches} takeoff=${r.takeoffs} peck=${r.pecks} ground=${(100 * r.ground).toFixed(0)}% maxStep=${r.maxStep.toFixed(2)}${r.crashAt.length ? "  [" + r.crashAt.join("; ") + "]" : ""}`); }
const sum = (k: keyof R) => all.reduce((a, r) => a + (r[k] as number), 0);
console.log(`H4=${H4} drinks=${sum("drinks")} sits=${sum("sits")}`);
console.log(`TOTAL (${all.length} runs x ${minutes} min = ${all.length * minutes} min): crashes=${sum("crashes")} teleports=${sum("teleports")} stuck=${sum("stuck")} out=${sum("out")} inside=${sum("inside")} landings=${sum("landings")} walks=${sum("walks")} perches=${sum("perches")} takeoffs=${sum("takeoffs")} pecks=${sum("pecks")}`);
// --assert: CIの長時間検査用。テレポート・範囲外・建物の中が1回でもあれば失敗。クラッシュは30分×12回で上限を超えたら失敗(現状は約50〜60)
if (process.argv.includes("--assert")) {
  const bad: string[] = [];
  if (H4 && sum("drinks") === 0) bad.push("no water visits (drinks=0)");
  if (sum("teleports") > 0) bad.push(`teleports=${sum("teleports")}`);
  if (sum("out") > 0) bad.push(`out=${sum("out")}`);
  if (sum("inside") > 0) bad.push(`inside=${sum("inside")}`);
  if (sum("crashes") > 90 * (all.length / 12)) bad.push(`crashes=${sum("crashes")} (limit ${90 * (all.length / 12)})`);
  if (sum("stuck") > 8 * (all.length / 12)) bad.push(`stuck=${sum("stuck")}`);
  if (bad.length) { console.log("ENDURANCE FAIL: " + bad.join(", ")); process.exit(1); }
  console.log("endurance checks passed");
}
