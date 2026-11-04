// H8-D: 混同のおそれがあるときだけ確認(2 段階)を入れる方式の評価。H8-C(常に 1 タップで開始)と同じ「押し方」の試料で比べる。
// 試料: 街の中を速度 7/9/11/13 m/s で飛び、目印が見えているあいだ 0.1 秒ごとに「その目印を押したい」試行を作る。指は δ 秒遅れて、δ 秒前の位置を押す。
//   H8-C: 触れた点で LandSpots.pick() が選んだ候補をそのまま開始 → 狙い通りか(正) / 別の候補(誤開始) / 何も選ばれず(空振り)。
//   H8-D: 触れた点が assess() で risky なら仮選択のみ(開始しない)。人が強調表示を見て、狙いと違えば(確率 pn で気づく)0.6 秒後に押し直す(最大 3 回)。
//         狙い通りなら確認ボタンで開始(+1 タップ、約 0.5 秒)。気づかず確認すれば誤開始(確認後の誤開始)。risky でない押し直しは 1 タップで開始する。
// 使い方: npx esbuild tools/spots_confirm.ts --bundle --platform=node --outfile=dist-test/spots_confirm.cjs && node dist-test/spots_confirm.cjs [試行数] [pn]
import { L, idx } from "./autoland_success";
import { LandSpots, SPOTS, type SpotFrame } from "../src/landspots";
let seed = 21; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const N = Number(process.argv[2] || 80), PN = Number(process.argv[3] || 0.9), SEEDBASE = Number(process.env.SEEDBASE ?? 3000);
if (process.env.RISKPX) SPOTS.riskPx = Number(process.env.RISKPX); if (process.env.RISKFAR) SPOTS.riskFarPx = Number(process.env.RISKFAR); if (process.env.STATICPX) SPOTS.staticPx = Number(process.env.STATICPX); if (process.env.DRIFT) SPOTS.driftPx = Number(process.env.DRIFT);
function frame(bx: number, by: number, bz: number, yaw: number, t: number, W: number, H: number, speed: number): SpotFrame {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), cx = bx - fx * 7, cz = bz - fz * 7, cy = by + 3, tanV = Math.tan(0.5), tanH = tanV * (W / H), pitch = -0.1;
  return { bx, by, bz, fx, fz, feetY: by - 0.32, cx, cy, cz, w: W, h: H, t, speed, heightAt: L.heightAt,
    project: (x, y, z, out) => { const rx = x - cx, ry = y - cy, rz = z - cz, fw = rx * fx + rz * fz, side = rx * fz - rz * fx, up = ry * Math.cos(pitch) - fw * Math.sin(pitch), depth = fw * Math.cos(pitch) + ry * Math.sin(pitch);
      if (depth < 0.1) { out.x = out.y = 0; out.z = 1.1; return; } out.x = (side / depth) / tanH; out.y = (up / depth) / tanV; out.z = 0.5; } };
}
interface A { b: number; q: number; t: number; stage: number; extraTaps: number; extraT: number; wrongPre: boolean; done: boolean; res: string; far: boolean; densityN: number }
function run(vp: [number, number], lag: number, spread: number) {
  const R: Record<string, number> = { total: 0, base_ok: 0, base_wrong: 0, base_miss: 0, one_ok: 0, one_wrong: 0, miss: 0, asked: 0, wrongPre: 0, confirm_ok: 0, confirm_wrong: 0, abandon: 0, extraTaps: 0, extraT10: 0, totalFar: 0, askedFar: 0, baseWrongFar: 0, finalWrongFar: 0, t0: 0, a0: 0, bw0: 0, fw0: 0, t1: 0, a1: 0, bw1: 0, fw1: 0 };
  for (let i = 0; i < N; i++) {
    seed = SEEDBASE + i * 613; const v = [7, 9, 11, 13][Math.floor(rnd() * 4)], theta = rnd() * Math.PI * 2, aim = (rnd() - 0.5) * 2 * 9;
    const cx = (rnd() - 0.5) * spread, cz = (rnd() - 0.5) * spread, sx = cx + Math.cos(theta) * 90, sz = cz + Math.sin(theta) * 90, tx = cx - Math.sin(theta) * aim, tz = cz + Math.cos(theta) * aim, yaw = Math.atan2(-(tx - sx), -(tz - sz));
    const sp = new LandSpots(idx), fx = -Math.sin(yaw), fz = -Math.cos(yaw), h = 14 + rnd() * 6; const hist = new Map<number, { x: number; y: number; t: number }[]>(); const att: A[] = [];
    const at = (id: number, tt: number) => { const a = hist.get(id); if (!a) return null; let best = null as { x: number; y: number; t: number } | null; for (const r of a) if (r.t <= tt + 1e-6) best = r; return best; };
    for (let t = 0; t < 110 / v; t += 1 / 60) {
      sp.update(frame(sx + fx * v * t, h, sz + fz * v * t, yaw, t, vp[0], vp[1], v), true);
      for (const q of sp.list) { let a = hist.get(q.id); if (!a) hist.set(q.id, a = []); a.push({ x: q.dx, y: q.dy, t }); if (a.length > 80) a.shift(); }
      const k = Math.round(t * 60);
      if (k % 6 === 0) for (const q of sp.list) { const past = at(q.id, t - lag); if (!past || t - past.t < lag - 0.03 || past.x < 0 || past.x > vp[0] || past.y < 0 || past.y > vp[1]) continue; att.push({ b: q.d < 18 ? 0 : q.d <= SPOTS.farM ? 1 : 2, q: q.id, t, stage: 0, extraTaps: 0, extraT: 0, wrongPre: false, done: false, res: "", far: q.d > SPOTS.farM, densityN: sp.list.length }); }
      for (const a of att) {
        if (a.done || a.t > t + 1e-6 || !(k % 6 === 0 || a.stage > 0)) continue;
        const q = sp.get(a.q); if (!q) { if (a.stage > 0) { a.done = true; a.res = "abandon"; } continue; }
        const past = at(a.q, t - lag); if (!past) continue;
        const got = sp.pick(past.x, past.y);
        if (a.stage === 0) { // 1 回目
          R.total++; if (a.far) R.totalFar++; if (a.b === 0) R.t0++; if (a.b === 1) R.t1++;
          if (!got) { R.base_miss++; R.miss++; a.done = true; continue; } if (got.id === a.q) R.base_ok++; else { R.base_wrong++; if (a.far) R.baseWrongFar++; if (a.b === 0) R.bw0++; if (a.b === 1) R.bw1++; }
          const risk = sp.assess(past.x, past.y, got);
          if (!risk.risky) { if (got.id === a.q) R.one_ok++; else { R.one_wrong++; if (a.far) R.finalWrongFar++; if (a.b === 0) R.fw0++; if (a.b === 1) R.fw1++; } a.done = true; continue; }
          R.asked++; if (a.far) R.askedFar++; if (a.b === 0) R.a0++; if (a.b === 1) R.a1++; a.stage = 1; a.extraTaps = 1; a.extraT = 0.5; a.t = t; if (got.id !== a.q) { a.wrongPre = true; R.wrongPre++; }
          // 強調表示を見て判断(確認ボタンを押す / 狙いと違えば押し直す)
          if (got.id === a.q) { R.confirm_ok++; R.extraTaps += a.extraTaps; R.extraT10 += a.extraT * 10; a.done = true; }
          else if (rnd() >= PN) { R.confirm_wrong++; if (a.far) R.finalWrongFar++; if (a.b === 0) R.fw0++; if (a.b === 1) R.fw1++; R.extraTaps += a.extraTaps; R.extraT10 += a.extraT * 10; a.done = true; } // 気づかず確認
          else { a.t = t + 0.6; a.extraT = 0.6 + 0.0; }
        } else { // 押し直し(0.6 秒後)
          a.extraTaps++; a.extraT += 0.6;
          if (!got) { a.t = t + 0.6; if (a.stage++ >= 3) { R.abandon++; a.done = true; } continue; }
          const risk = sp.assess(past.x, past.y, got);
          if (!risk.risky) { if (got.id === a.q) R.confirm_ok++; else R.confirm_wrong++; R.extraTaps += a.extraTaps; R.extraT10 += a.extraT * 10; a.done = true; continue; } // risky でない押し直しは 1 タップで開始(従来どおり)
          if (got.id === a.q) { R.confirm_ok++; a.extraTaps++; a.extraT += 0.5; R.extraTaps += a.extraTaps; R.extraT10 += a.extraT * 10; a.done = true; }
          else if (rnd() >= PN) { R.confirm_wrong++; a.extraTaps++; a.extraT += 0.5; R.extraTaps += a.extraTaps; R.extraT10 += a.extraT * 10; a.done = true; }
          else { a.t = t + 0.6; if (a.stage++ >= 3) { R.abandon++; a.done = true; } }
        }
      }
    }
    for (const a of att) if (!a.done && a.stage > 0) R.abandon++; // 試行の終わりまでに決まらなかった(目印が去った)
  }
  return R;
}
const pct = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) : "-") + `% (${a}/${b})`;
const rows: Record<string, number>[] = []; const SUM = !!process.env.SUM;
for (const vp of [[892, 412], [412, 892]] as [number, number][]) for (const lag of [0.1, 0.2, 0.3]) {
  const R: Record<string, number> = {}; for (const spread of [30, 80]) { const r = run(vp, lag, spread); for (const [k, v] of Object.entries(r)) R[k] = (R[k] || 0) + v; }
  rows.push(R);
  const T = R.total;
  if (SUM) { console.log(`riskPx ${SPOTS.riskPx}+${SPOTS.riskFarPx} static ${SPOTS.staticPx} drift ${SPOTS.driftPx} ${vp.join("x")} δ${lag}: 確認要求 ${pct(R.asked, T)} | 誤開始 H8-C ${pct(R.base_wrong, T)} → H8-D ${pct(R.one_wrong + R.confirm_wrong, T)}(うち 1 タップ ${R.one_wrong}、確認後 ${R.confirm_wrong}) | 手数+${(R.extraTaps / T).toFixed(2)} 時間+${(R.extraT10 / 10 / T).toFixed(2)}s | 距離別[確認要求 / 誤開始 H8-C→H8-D] 18 m 未満: ${pct(R.a0, R.t0)} / ${pct(R.bw0, R.t0)}→${pct(R.fw0, R.t0)}  18-35 m: ${pct(R.a1, R.t1)} / ${pct(R.bw1, R.t1)}→${pct(R.fw1, R.t1)}  35 m 超: ${pct(R.askedFar, R.totalFar)} / ${pct(R.baseWrongFar, R.totalFar)}→${pct(R.finalWrongFar, R.totalFar)}`); continue; }
  console.log(`${vp.join("x")} 遅れ ${lag}s 試行 ${T} | H8-C(常に 1 タップ): 正 ${pct(R.base_ok, T)} 誤開始 ${pct(R.base_wrong, T)} 空振り ${pct(R.base_miss, T)} || H8-D: 1 タップで開始 ${pct(R.one_ok + R.one_wrong, T)}(正 ${R.one_ok} 誤 ${R.one_wrong}) 確認要求 ${pct(R.asked, T)} 誤って仮選択 ${R.wrongPre} 確認後の正開始 ${R.confirm_ok} 確認後の誤開始 ${R.confirm_wrong} 取りやめ(去った/回数切れ) ${R.abandon} 空振り ${R.miss} | 誤開始の合計 ${pct(R.one_wrong + R.confirm_wrong, T)} 正開始の合計 ${pct(R.one_ok + R.confirm_ok, T)} | 確認で増えた手数 平均 ${(R.extraTaps / T).toFixed(2)} タップ・${(R.extraT10 / 10 / T).toFixed(2)} 秒(全試行あたり)`);
}
void rows;
