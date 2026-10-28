// カメラ高さフィルタの調整値探索: 既存のカメラ試験(急降下・旋回・ブレーキ・建物)を全て満たす範囲で、羽ばたき成分の伝わりが最小になる値を探す。
// npx esbuild tools/camera_tune.ts --bundle --platform=node --outfile=dist-test/tune.cjs && node dist-test/tune.cjs [試行数]
import { CAM_TUNE } from "../src/camera";
import { probe } from "../test/camera";
import { measure } from "./camera_shake";
import { at, inp, L } from "../test/common";
import type { Flight, FlightInput } from "../src/flight";

const air = (x: number, y: number, z: number, yaw = 0) => (f: Flight) => { f.pos.set(x, y, z); f.yaw = yaw; f.vel.set(-Math.sin(yaw) * 10, 0, -Math.cos(yaw) * 10); };
const a = L.apts[0];
const cases: [string, (f: Flight) => void, (t: number) => FlightInput][] = [
  ["steep dive", air(28, 150, 110), () => inp({ y: -1 })], ["long steep dive", air(28, 150, 110), () => inp({ y: -1 })],
  ["dive then brake", air(28, 140, 110), t => inp({ y: -1, brake: t > 1.5 })], ["hard turns", air(28, 100, 110), t => inp({ x: t % 2 < 1 ? 1 : -1 })],
  ["flap then hard brake", air(28, 100, 110), t => inp({ flapHeld: t < 3, brake: t > 3 })], ["near building", air(a.x, 12, a.z + 45), () => inp({ x: 0.3 })],
];
function failures() {
  let bad = 0, worst = 0;
  for (const fps of [60, 30]) for (const [name, setup, fn] of cases) {
    const r = probe(setup, fn, name.startsWith("long") ? 4.5 : 5, fps, fps === 30, name.includes("dive") ? 12 : -1);
    if (!(r.maxD - r.minD < 3.4 && r.maxD < 9)) bad++; if (!(r.ndc < 0.3 && r.lag < 14)) bad++; if (!(r.maxJump < 4)) bad++; if (name.includes("dive") && !(r.acc < 60)) bad++;
    worst = Math.max(worst, r.ndc / 0.3, r.acc / 60);
  }
  return { bad, worst };
}
const keys = Object.keys(CAM_TUNE) as (keyof typeof CAM_TUNE)[];
const range: Record<string, [number, number]> = { tauS: [0.5, 1.4], corr: [0.3, 1.5], corrFirst: [0.5, 2.5], softK: [1, 10], softOff: [0.2, 0.9], pkLo: [2.5, 6], pkRange: [2, 7], swUp: [1.5, 8], swDown: [0.5, 4], cpSlow: [0.8, 4], maxLag: [0.08, 0.3] };
let seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const score = () => { const f = failures(); if (f.bad) return { s: 1e3 + f.bad * 10 + f.worst, f }; const m3 = measure({ stable: true, mode: "third" }), m1 = measure({ stable: true, mode: "first" }); return { s: m3.hfRatio + 0.7 * m1.hfRatio + 0.3 * f.worst, f, m3, m1 }; };
let best = { ...CAM_TUNE }, bs = score(); console.log("start", bs.s.toFixed(3), bs.f);
const N = Number(process.argv[2] || 150);
for (let i = 0; i < N; i++) {
  const cand = { ...best }; for (const k of keys) if (rnd() < 0.4) { const [lo, hi] = range[k]; cand[k] = Math.min(hi, Math.max(lo, cand[k] + (rnd() - 0.5) * (hi - lo) * 0.35)); }
  Object.assign(CAM_TUNE, cand); const sc = score();
  if (sc.s < bs.s) { best = cand; bs = sc; console.log(i, sc.s.toFixed(3), JSON.stringify(cand), sc.m3 ? `third ${(100 * sc.m3.hfRatio).toFixed(0)}% first ${(100 * sc.m1!.hfRatio).toFixed(0)}%` : "fail" + sc.f.bad); }
}
Object.assign(CAM_TUNE, best); console.log("BEST", JSON.stringify(best), bs.s.toFixed(3));
