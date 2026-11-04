// H8-C: 動く目印を押したとき、狙った候補が選ばれるか(選ばれない / 隣が選ばれる)を測る。
// 指は「目印を見て(δ 秒前の位置を狙い)、δ 秒後に触れる」。触れた時点の LandSpots.pick() が、狙った ID か、何もなしか、別の ID かを数える。
// 使い方: npx esbuild tools/spots_pick.ts --bundle --platform=node --outfile=dist-test/spots_pick.cjs && node dist-test/spots_pick.cjs [試行数]
import { L, idx } from "./autoland_success";
import { LandSpots, SPOTS, type SpotFrame } from "../src/landspots";
let seed = 21; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const N = Number(process.argv[2] || 150);
function frame(bx: number, by: number, bz: number, yaw: number, t: number, W: number, H: number, speed: number): SpotFrame {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), cx = bx - fx * 7, cz = bz - fz * 7, cy = by + 3, tanV = Math.tan(0.5), tanH = tanV * (W / H), pitch = -0.1;
  return { bx, by, bz, fx, fz, feetY: by - 0.32, cx, cy, cz, w: W, h: H, t, speed, heightAt: L.heightAt,
    project: (x, y, z, out) => { const rx = x - cx, ry = y - cy, rz = z - cz, fw = rx * fx + rz * fz, side = rx * fz - rz * fx, up = ry * Math.cos(pitch) - fw * Math.sin(pitch), depth = fw * Math.cos(pitch) + ry * Math.sin(pitch);
      if (depth < 0.1) { out.x = out.y = 0; out.z = 1.1; return; } out.x = (side / depth) / tanH; out.y = (up / depth) / tanV; out.z = 0.5; } };
}
function run(vp: [number, number], lag: number) {
  let ok = 0, none = 0, wrong = 0, ambiguous = 0, total = 0; const B: Record<string, [number, number]> = { "<18m": [0, 0], "18-35m": [0, 0], ">35m": [0, 0] };
  for (let i = 0; i < N; i++) {
    seed = 3000 + i * 613; const v = [7, 9, 11, 13][Math.floor(rnd() * 4)], theta = rnd() * Math.PI * 2, aim = (rnd() - 0.5) * 2 * 9;
    // 街の中央付近の混んだ場所へ向かう(目印が多い = 隣の誤選択が起きやすい)
    const cx = (rnd() - 0.5) * 80, cz = (rnd() - 0.5) * 80, sx = cx + Math.cos(theta) * 90, sz = cz + Math.sin(theta) * 90, tx = cx - Math.sin(theta) * aim, tz = cz + Math.cos(theta) * aim, yaw = Math.atan2(-(tx - sx), -(tz - sz));
    const sp = new LandSpots(idx), fx = -Math.sin(yaw), fz = -Math.cos(yaw), h = 14 + rnd() * 6; const hist: Map<number, { x: number; y: number; t: number }[]> = new Map();
    for (let t = 0; t < 110 / v; t += 1 / 60) {
      sp.update(frame(sx + fx * v * t, h, sz + fz * v * t, yaw, t, vp[0], vp[1], v), true);
      for (const q of sp.list) { let a = hist.get(q.id); if (!a) hist.set(q.id, a = []); a.push({ x: q.dx, y: q.dy, t }); if (a.length > 40) a.shift(); }
      if (Math.floor(t * 60) % 6 !== 0) continue;
      for (const q of sp.list) { const a = hist.get(q.id)!; const past = a.find(r => r.t >= t - lag - 1e-6); if (!past || t - past.t < lag - 0.02) continue;
        const px = past.x, py = past.y; if (px < 0 || px > vp[0] || py < 0 || py > vp[1]) continue; total++;
        const near = sp.list.filter(r => r.id !== q.id && Math.hypot(r.dx - px, r.dy - py) < SPOTS.hitPx + 12).length; if (near) ambiguous++;
        const got = (globalThis as any).__LAGPICK ? ({ id: pickLag(sp, px, py, (globalThis as any).__LAGPICK.tau, (globalThis as any).__LAGPICK.w) } as any) : sp.pick(px, py); const bk = q.d < 18 ? "<18m" : q.d < 35 ? "18-35m" : ">35m"; B[bk][1]++; if (!got || got.id === null) none++; else if (got.id === q.id) ok++; else { wrong++; B[bk][0]++; } }
    }
  }
  return { total, ok, none, wrong, ambiguous, B };
}
// 試案: 指は「見てから τ 秒後」に触れる。触れた点に最も合うのは、各候補の「τ 秒前の位置」。τ を 0〜0.3 s の事前分布(中心 TAU)で重みづけして選ぶ
function pickLag(sp: LandSpots, x: number, y: number, tau: number, w: number) {
  let best: number | null = null, bd = 1e9;
  for (const q of sp.list) {
    let d = Math.hypot(x - q.dx, y - q.dy) + w * tau * 0; // 現在位置
    // 過去の位置(trail は 0.25 s ぶん)から τ 付近を探し、その距離に「τ からのずれ」の罰をつける
    const now = q.trail[q.trail.length - 1]; if (now) for (const r of q.trail) { const dt = now.t - r.t, dd = Math.hypot(x - r.x, y - r.y) + w * Math.abs(dt - tau); if (dd < d) d = dd; }
    if (d <= SPOTS.hitPx && d < bd) { bd = d; best = q.id; }
  }
  return best;
}
const pct = (a: number, b: number) => (100 * a / b).toFixed(1) + "%";
for (const cfg of [{ name: "現状", trailPx: 24, trailS: 0.25 }, ] as any[]) {
  (globalThis as any).__LAGPICK = cfg.lag ?? null; Object.assign(SPOTS, { trailPx: cfg.trailPx, trailS: cfg.trailS });
  for (const vp of [[892, 412], [412, 892]] as [number, number][]) for (const lag of [0.1, 0.2, 0.3]) { const r = run(vp, lag); console.log(`${cfg.name} ${vp.join("x")} 指の遅れ ${lag}s: 正しく選ばれた ${pct(r.ok, r.total)}  何も選ばれず ${pct(r.none, r.total)}  別の候補 ${pct(r.wrong, r.total)}  [距離別の「別の候補」: ${Object.entries(r.B).map(([k, v]) => k + " " + (v[1] ? (100 * v[0] / v[1]).toFixed(1) : "-") + "%(" + v[1] + ")").join(", ")}]`); }
}
