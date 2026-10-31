// AutoLand の調整値のランダム探索(開発用)。全足場の種類を同じ重みで、成功率 - 衝突率*2 を最大化する。
// npx esbuild tools/autoland_tune.ts --bundle --platform=node --outfile=dist-test/autoland_tune.cjs && node dist-test/autoland_tune.cjs [反復] [種類あたり試行]
import { AUTOLAND } from "../src/autoland";
import { run } from "./autoland_success";
const iters = Number(process.argv[2] || 150), n = Number(process.argv[3] || 24);
const A = AUTOLAND as unknown as Record<string, number>;
const space: Record<string, [number, number]> = { vBase: [3, 6], vK: [0.2, 0.7], vMin: [4, 6.5], vMax: [7, 11], brakeMargin: [0, 1.5], hSlope: [0.15, 0.4], hFinal: [0.25, 0.7], downFast: [-0.35, -0.05], downSlow: [-0.6, -0.25], upMax: [0.1, 0.35], yGain: [0.08, 0.3], flapSpeed: [6, 8.5], flapSink: [0.6, 2.2] };
let seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const score = () => { const r = run(n); let ok = 0, att = 0, crash = 0; for (const v of Object.values(r)) { ok += v.ok / Math.max(1, v.n - v.refused); crash += v.crash / Math.max(1, v.n - v.refused); att += 1; } return { s: (ok - 3 * crash) / att, ok: ok / att, crash: crash / att }; };
const base = { ...A }; let best = { ...base }, bs = score(); console.log("start", bs.s.toFixed(3), bs.ok.toFixed(3), bs.crash.toFixed(3));
for (let i = 0; i < iters; i++) {
  const cand = { ...best }; const keys = Object.keys(space); for (const k of keys) if (rnd() < 0.3) { const [a, b] = space[k]; cand[k] = Math.min(b, Math.max(a, cand[k] + (rnd() - 0.5) * (b - a) * 0.4)); }
  Object.assign(A, cand); const sc = score(); if (sc.s > bs.s) { bs = sc; best = cand; console.log(i, "score", sc.s.toFixed(3), "ok", sc.ok.toFixed(3), "crash", sc.crash.toFixed(3), JSON.stringify(Object.fromEntries(Object.entries(cand).filter(([k]) => k in space).map(([k, v]) => [k, +v.toFixed(3)])))); }
}
