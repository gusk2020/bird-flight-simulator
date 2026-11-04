// H8-C: 着地点マーカーが「指の届く前に消える」問題の計測。直線で目印へ向かう飛行を、速度・向きのずれ・画面の縦横・乱数シードを変えて何百回も再現し、
// 目印の 初めて見えた距離 / 見えていた時間 / 押せる(自動着地の届く範囲)時間 / 消えた理由 を数える。
// H8-B(先読み 45 m 固定・遠い目印は押せない)と H8-C(速さに応じた先読み・遠い目印を押すと接近先に選べる)を、同じ試行で比べる。
// 使い方: npx esbuild tools/spots_measure.ts --bundle --platform=node --outfile=dist-test/spots_measure.cjs && node dist-test/spots_measure.cjs [試行数]
import { L, idx } from "./autoland_success";
import { LandSpots, SPOTS, type SpotFrame } from "../src/landspots";

let seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const N = Number(process.argv[2] || 300);
const world = { heightAt: L.heightAt };
function frame(bx: number, by: number, bz: number, yaw: number, t: number, W: number, H: number, speed: number): SpotFrame {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), cx = bx - fx * 7, cz = bz - fz * 7, cy = by + 3, tanV = Math.tan(0.5), tanH = tanV * (W / H), pitch = -0.1;
  return { bx, by, bz, fx, fz, feetY: by - 0.32, cx, cy, cz, w: W, h: H, t, speed, heightAt: world.heightAt,
    project: (x, y, z, out) => { const rx = x - cx, ry = y - cy, rz = z - cz, fw = rx * fx + rz * fz, side = rx * fz - rz * fx, up = ry * Math.cos(pitch) - fw * Math.sin(pitch), depth = fw * Math.cos(pitch) + ry * Math.sin(pitch);
      if (depth < 0.1) { out.x = out.y = 0; out.z = 1.1; return; } out.x = (side / depth) / tanH; out.y = (up / depth) / tanV; out.z = 0.5; } };
}
interface Row { v: number; vp: string; kind: string; first: number; vis: number; nearT: number; nearStart: number; why: string; seen: boolean }
function trial(i: number, mode: "B" | "C", vp: [number, number]): Row | null {
  seed = 1000 + i * 977; // 同じ i なら B と C で同じ飛行
  const kinds = ["roof", "bench", "sign", "pole", "rock", "balcony", "rail", "fence", "wall", "planter", "tank"]; const kind = kinds[Math.floor(rnd() * kinds.length)];
  const ss = idx.all.filter(s => s.kind === kind); if (!ss.length) return null; const s = ss[Math.floor(rnd() * ss.length)];
  const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, theta = rnd() * Math.PI * 2, D0 = 110, v = [7, 9, 11, 13][Math.floor(rnd() * 4)];
  const aim = (rnd() - 0.5) * 2 * 9; // 目印の横を通る距離のずれ(±9 m): 人が「だいたいあの辺り」へ飛ぶ状況
  const sx = cx + Math.cos(theta) * D0, sz = cz + Math.sin(theta) * D0, tx = cx - Math.sin(theta) * aim, tz = cz + Math.cos(theta) * aim;
  const yaw = Math.atan2(-(tx - sx), -(tz - sz)), fx = -Math.sin(yaw), fz = -Math.cos(yaw), h0 = Math.max(s.top + 1 + rnd() * 8, L.heightAt(sx, sz) + 6);
  const sp = new LandSpots(idx); if (mode === "B") { /* 45 m 固定 */ } let first = -1, last = -1, nearT = 0, nearStart = -1, why = "", seen = false, firstD = 0;
  const dt = 1 / 30, T = (D0 + 40) / v;
  for (let t = 0; t < T; t += dt) {
    const bx = sx + fx * v * t, bz = sz + fz * v * t, by = h0 + 0 * t;
    sp.update(frame(bx, by, bz, yaw, t, vp[0], vp[1], mode === "B" ? 0 : v), true);
    const q = sp.get(s.id) ?? sp.list.find(r => r.kind === s.kind && Math.hypot((r.s.minX + r.s.maxX) / 2 - cx, (r.s.minZ + r.s.maxZ) / 2 - cz) < (kind === "branch" ? 3.6 : 1.3));
    if (q) { if (first < 0) { first = t; firstD = q.d; seen = true; } last = t; if (q.near) { nearT += dt; if (nearStart < 0) nearStart = t; } }
    else if (first >= 0 && !why) why = sp.goneWhy(s.id) ?? "other";
  }
  void firstD;
  return { v, vp: vp.join("x"), kind, first, vis: first >= 0 ? last - first + 0.033 : 0, nearT, nearStart, why: why || (seen ? "end" : "never"), seen };
}
const pct = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) : "-") + `% (${a}/${b})`;
const med = (a: number[]) => a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2) : "-";
for (const vp of [[892, 412], [412, 892]] as [number, number][]) {
  for (const mode of ["B", "C"] as const) {
    const rows: Row[] = []; for (let i = 0; i < N; i++) { const r = trial(i, mode, vp); if (r) rows.push(r); }
    const seen = rows.filter(r => r.seen), withNear = seen.filter(r => r.nearStart >= 0);
    const out: string[] = [`${vp.join("x")} ${mode === "B" ? "H8-B(45 m 固定・遠いと押せない)" : "H8-C(速さに応じた先読み・遠くから選べる)"}: 試行 ${rows.length}、一度も見えない ${rows.length - seen.length}、見えた ${seen.length}`];
    out.push(`   見えていた時間 中央値 ${med(seen.map(r => r.vis))} s、初めて見えた時 中央値 ${med(seen.map(r => r.first))} s(開始から)、押せる(18 m 以内)時間 中央値 ${med(withNear.map(r => r.nearT))} s、押せる時間が一度もない ${seen.length - withNear.length}`);
    for (const Tr of [0.5, 1.0, 1.5]) { // 見えてから指が届くまでの反応時間(秒)
      let okB = 0, okC = 0, tot = 0; for (const r of seen) { tot++; const tt = r.first + Tr, goneAt = r.first + r.vis;
        // B: 見えてから Tr 後に押し、遠ければ断られるので 0.5 秒ごとに押し直す。押せる範囲にいるとき届けば成功
        let okb = false; for (let t = tt; t < goneAt; t += 0.5) if (r.nearStart >= 0 && t >= r.nearStart && t < r.nearStart + r.nearT + 1e-6) { okb = true; break; }
        // C: 見えてから Tr 後に押せば(遠くても)接近先に選べて、押せる範囲に入ったとき自動で始まる
        const okc = tt < goneAt && r.nearStart >= 0; if (okb) okB++; if (okc) okC++; }
      out.push(`   反応 ${Tr} s: 着地を始められた  B方式 ${pct(okB, tot)}  /  C方式 ${pct(okC, tot)}`);
    }
    const why: Record<string, number> = {}; for (const r of seen) why[r.why] = (why[r.why] || 0) + 1; out.push(`   消えた理由 ${JSON.stringify(why)}`);
    const byV: Record<string, [number, number]> = {}; for (const r of seen) { const k = "v" + r.v; byV[k] = byV[k] || [0, 0]; byV[k][1]++; if (r.nearStart >= 0 && r.nearT >= 0.8) byV[k][0]++; } out.push(`   押せる時間が 0.8 s 以上ある割合(速さ別) ${JSON.stringify(Object.fromEntries(Object.entries(byV).map(([k, v]) => [k, pct(v[0], v[1])])))}`);
    console.log(out.join("\n"));
  }
}
void SPOTS;
