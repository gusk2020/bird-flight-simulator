import { check, suite } from "./harness";
import { Puddles, buildPuddles, PUDDLE } from "../src/puddles";
import { Life, LIFE, type LifeCtx } from "../src/life";
import { generateLayout } from "../src/layout";

const ctx = (o: Partial<LifeCtx> = {}): LifeCtx => ({ landed: true, moving: false, input: false, sitting: false, water: false, onWaterEdge: false, ...o });
const seeded = (s: number) => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

export function h3LifeTests() {
  suite("H3: puddles and bird life");
  const L = generateLayout(7), list = buildPuddles(L), pd = new Puddles(list);
  const perm = list.filter(p => p.perm), temp = list.filter(p => !p.perm);
  check("a permanent park pool exists; rain puddles exist on parks, vacant lots and roads", perm.length >= 1 && temp.length >= 8, `${perm.length} perm, ${temp.length} temp`);
  check("every puddle sits on open ground (no building top, grass/soil/road/paved only) and is deterministic", list.every(p => L.heightAt(p.x, p.z) < 0.5 && !L.colliders.some(c => p.x > c.minX && p.x < c.maxX && p.z > c.minZ && p.z < c.maxZ) && ["grass", "soil", "road", "paved"].includes(L.groundAt(p.x, p.z))) && buildPuddles(L).length === list.length);
  check("dry weather: only the permanent pool is visible", temp.every(p => pd.radius(p) === 0) && perm.every(p => pd.radius(p) === p.r));
  for (let i = 0; i < 30 * 60; i++) pd.update(1 / 60, 1, 0.25);
  const wetN = temp.filter(p => pd.radius(p) > 0).length;
  check("30 s of heavy rain: most rain puddles appear, none larger than their maximum", wetN >= temp.length * 0.6 && temp.every(p => pd.radius(p) <= p.r + 1e-9), `${wetN}/${temp.length} wet=${pd.wet.toFixed(2)}`);
  let prev = temp.reduce((a, p) => a + pd.radius(p), 0), mono = true;
  for (let i = 0; i < 90 * 60; i++) { pd.update(1 / 60, 0, 1); if (i % 60 === 0) { const t = temp.reduce((a, p) => a + pd.radius(p), 0); if (t > prev + 1e-9) mono = false; prev = t; } }
  check("sunshine dries them gradually (never grows) until none is left; the park pool stays", mono && temp.every(p => pd.radius(p) === 0) && perm.every(p => pd.radius(p) === p.r), `wet=${pd.wet.toFixed(3)}`);
  const w0 = pd.nearest(perm[0].x, perm[0].z);
  check("nearest water: 0 inside a pool, grows with distance, and a far point finds the pool as the nearest one", !!w0 && w0.d === 0 && (pd.nearest(perm[0].x + perm[0].r + 2, perm[0].z)!.d - 2) < 1e-6);

  // --- 生活動作
  const run = (secs: number, c: LifeCtx, seed = 1, life = new Life(seeded(seed))) => { const seen: Record<string, number> = {}; let maxRun = 0, cur = 0, last = "none", finite = true; for (let i = 0; i < secs * 60; i++) { const p = life.update(1 / 60, c); seen[life.act] = (seen[life.act] || 0) + 1; if (life.act !== "none" && life.act === last) cur++; else cur = 0; maxRun = Math.max(maxRun, cur); last = life.act; if (Object.values(p).some(v => !Number.isFinite(v))) finite = false; } return { life, seen, maxRun, finite }; };
  const a = run(120, ctx());
  const kinds = Object.keys(a.life.stats.byAct);
  check("standing on the ground for 2 min: several different life actions occur, poses stay finite", kinds.length >= 4 && a.finite, JSON.stringify(a.life.stats.byAct));
  check("no action runs longer than its duration (never sticks in a rest state)", a.maxRun / 60 <= Math.max(...Object.values(LIFE.dur)) + 0.1, `${(a.maxRun / 60).toFixed(2)} s`);
  const rest = run(120, ctx({ sitting: true })), stand = run(120, ctx());
  check("sitting to rest repeats actions more often than standing", rest.life.stats.started > stand.life.stats.started * 1.3, `${rest.life.stats.started} vs ${stand.life.stats.started}`);
  const sitStuff = Object.keys(rest.life.stats.byAct);
  check("resting without water preens / stretches / fluffs, and never drinks or bathes", sitStuff.includes("preen") && !sitStuff.includes("drink") && !sitStuff.includes("bathe"), sitStuff.join(","));
  const near = run(120, ctx({ water: true }), 3), nearSit = run(120, ctx({ water: true, sitting: true }), 4);
  check("standing by water: drinks; no bathing unless resting", !!near.life.stats.byAct.drink && !near.life.stats.byAct.bathe, JSON.stringify(near.life.stats.byAct));
  check("resting by water: bathes and drinks", !!nearSit.life.stats.byAct.bathe && !!nearSit.life.stats.byAct.drink, JSON.stringify(nearSit.life.stats.byAct));
  // キャンセル
  for (const [name, c] of [["walking", ctx({ moving: true })], ["a stick/flap input", ctx({ input: true })], ["taking off", ctx({ landed: false })]] as [string, LifeCtx][]) {
    const l = new Life(seeded(9)); run(20, ctx({ water: true }), 9, l); // 何か動作中の状態にしておく
    let t0 = -1; for (let i = 0; i < 600 && l.act === "none"; i++) l.update(1 / 60, ctx({ water: true })); const started = l.act !== "none";
    l.update(1 / 60, c);
    check(`an action in progress stops at once on ${name}, and the pose relaxes back`, started && l.act === "none"); void t0;
    for (let i = 0; i < 90; i++) l.update(1 / 60, c);
    check(`...and stays neutral while ${name} continues`, Object.values(l.pose).every(v => Math.abs(v) < 0.02), JSON.stringify(l.pose));
  }
  check("after stopping, it can resume resting actions", (() => { const l = new Life(seeded(5)); for (let i = 0; i < 60; i++) l.update(1 / 60, ctx({ moving: true })); for (let i = 0; i < 20 * 60; i++) l.update(1 / 60, ctx()); return l.stats.started > 0; })());
}
