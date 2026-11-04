// H8-C: 「見えてから押す」を、実際の飛行(物理・自動着地・着地補助)つきで再現し、H8-B(遠い目印は押しても断られる)と H8-C(遠い目印は接近先に選べる)を同じ試行で比べる。
// 使い方: npx esbuild tools/spots_sim.ts --bundle --platform=node --outfile=dist-test/spots_sim.cjs && node dist-test/spots_sim.cjs [試行数] [反応時間 s]
// 試行: 約 110 m 先の足場へ、横に最大 ±9 m ずれた直線で飛ぶ(人が「だいたいあの辺り」へ飛ぶ状況)。見えて Tr 秒後に押す(B: 届かなければ 0.5 秒ごとに押し直す)。
import { L, idx } from "./autoland_success";
import { Flight } from "../src/flight";
import { LandSpots, type SpotFrame } from "../src/landspots";
import { AutoLand, AUTOLAND } from "../src/autoland";
import { PerchAssist } from "../src/perchassist";
import { FlapAssist } from "../src/assist";
import { Approach } from "../src/approach";
import { CruiseGuard } from "../src/avoid";
import { Wind } from "../src/wind";
import { PHYS as P } from "../src/params";

const world = { colliders: L.colliders, heightAt: L.heightAt, perchAt: L.perchAt, perchPoint: L.perchPoint, wireDir: L.wireDir, waterAt: L.waterAt };
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
import { APPROACH } from "../src/approach";
if (process.env.ALIGN) APPROACH.alignRad = Number(process.env.ALIGN); if (process.env.BRAKEV) APPROACH.brakeV = Number(process.env.BRAKEV); if (process.env.MINSTART) APPROACH.minStartD = Number(process.env.MINSTART);
const N = Number(process.argv[2] || 200), TR = Number(process.argv[3] || 0.8);
function frame(f: Flight, t: number, W: number, H: number): SpotFrame {
  const yaw = f.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw), bx = f.pos.x, by = f.pos.y, bz = f.pos.z, cx = bx - fx * 7, cz = bz - fz * 7, cy = by + 3, tanV = Math.tan(0.5), tanH = tanV * (W / H), pitch = -0.1;
  const hs = Math.hypot(f.vel.x, f.vel.z), vfx = hs > 2 ? f.vel.x / hs : fx, vfz = hs > 2 ? f.vel.z / hs : fz;
  return { bx, by, bz, fx: vfx, fz: vfz, feetY: by - P.feetOffset, cx, cy, cz, w: W, h: H, t, speed: hs, heightAt: world.heightAt,
    project: (x, y, z, out) => { const rx = x - cx, ry = y - cy, rz = z - cz, fw = rx * fx + rz * fz, side = rx * fz - rz * fx, up = ry * Math.cos(pitch) - fw * Math.sin(pitch), depth = fw * Math.cos(pitch) + ry * Math.sin(pitch);
      if (depth < 0.1) { out.x = out.y = 0; out.z = 1.1; return; } out.x = (side / depth) / tanH; out.y = (up / depth) / tanV; out.z = 0.5; } };
}
interface Out { crashAfter: boolean; mode: string; vp: string; v: number; kind: string; seen: boolean; tapped: boolean; refusedFar: number; started: boolean; success: boolean; crash: boolean; goneBeforeStart: boolean; why: string; wrongTarget: boolean }
function trial(i: number, mode: "B" | "C", vp: [number, number]): Out | null {
  seed = Number(process.env.SEEDBASE ?? 5000) + i * 977;
  const kinds = ["roof", "bench", "sign", "pole", "rock", "balcony", "fence", "wall", "planter"]; const kind = kinds[Math.floor(rnd() * kinds.length)];
  const ss = idx.all.filter(s => s.kind === kind && !(kind === "roof" && (s.maxX - s.minX) * (s.maxZ - s.minZ) < 40)); if (!ss.length) return null; const s = ss[Math.floor(rnd() * ss.length)];
  const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, theta = rnd() * Math.PI * 2, D0 = 110, v = [7, 9, 11, 13][Math.floor(rnd() * 4)], aim = (rnd() - 0.5) * 2 * 9;
  const sx = cx + Math.cos(theta) * D0, sz = cz + Math.sin(theta) * D0, tx = cx - Math.sin(theta) * aim, tz = cz + Math.cos(theta) * aim, yaw = Math.atan2(-(tx - sx), -(tz - sz));
  const guard = new CruiseGuard(), f = new Flight(world), pa = new PerchAssist(idx), al = new AutoLand(idx, pa, L.heightAt), sp = new LandSpots(idx), ap = new Approach(), as = new FlapAssist(); as.enabled = true;
  if (process.env.APPWIND) { const w = new Wind(); w.set(270, 3, 0.3); f.wind = w; } // アプリの既定の風
  f.pos.set(sx, Math.max(s.top + 1 + rnd() * 8, L.heightAt(sx, sz) + 8), sz); f.prevPos.copy(f.pos); f.yaw = yaw; f.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
  const o: Out = { crashAfter: false, mode, vp: vp.join("x"), v, kind, seen: false, tapped: false, refusedFar: 0, started: false, success: false, crash: false, goneBeforeStart: false, why: "", wrongTarget: false };
  let first = -1, nextTap = 1e9, holdUntil = -1, hold = 0; const c0 = f.crashes; const T = 60 * 40;
  for (let k = 0; k < T; k++) {
    const t = k / 60;
    if (k % 2 === 0) sp.update(frame(f, t, vp[0], vp[1]), f.mode === "air" && !al.active);
    const q = sp.get(s.id) ?? sp.list.find(r => r.kind === s.kind && Math.hypot((r.s.minX + r.s.maxX) / 2 - cx, (r.s.minZ + r.s.maxZ) / 2 - cz) < 1.3);
    if (q && first < 0 && !al.active) { first = t; o.seen = true; nextTap = t + TR; }
    // 人: 見えて TR 秒後に押す。B: 届かなければ(遠すぎ)0.5 秒ごとに押し直す。C: 遠ければ接近先に選ぶ(一度だけ)
    if (!al.active && !ap.active && t >= nextTap && q) {
      o.tapped = true;
      if (q.d > AUTOLAND.maxRange) { if (mode === "C") { ap.select(q.id, t); nextTap = 1e9; } else { o.refusedFar++; nextTap = t + 0.5; } }
      else { const c = al.check(f, q.s); if (c.ok && al.start(f, q.s)) { o.started = true; o.wrongTarget = al.lastTargetId !== q.id && !(["balcony", "rail"].includes(q.kind)); } else nextTap = t + 0.5; }
    }
    if (ap.active) { const aq = sp.get(ap.id); const r = ap.update(t, aq ? { s: aq.s, d: aq.d, near: aq.near, ready: ap.ready(f, aq.s) } : null, sp.goneWhy(ap.id), sf => { const c = al.check(f, sf); if (!c.ok) return false; if (al.start(f, sf)) { o.started = true; o.wrongTarget = al.lastTargetId !== ap.id && !(["balcony", "rail"].includes(sf.kind)); return true; } return false; }, () => al.lastRefusal); if (r === "cleared") { o.goneBeforeStart = true; o.why = ap.lastReason; } }
    const raw = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
    if (ap.active && !al.active) { const aq = sp.get(ap.id); if (aq) ap.steer(f, raw, aq.s, 1 / 60); }
    if (!al.active && f.mode === "air") guard.apply(world, f, raw); // 実機と同じ障害物回避
    if (al.active) { al.drive(f, raw); pa.apply(raw, f); } else as.apply(raw, f);
    f.step(1 / 60, raw);
    if (f.crashes > c0) { o.crash = true; o.crashAfter = o.started; if (al.active) al.cancel("crash"); break; }
    if (o.started && !al.active) { if (al.end === "success") { hold = hold || 1; if (holdUntil < 0) holdUntil = k + 90; if (k >= holdUntil) { const u = idx.under(f.pos.x, f.pos.y - P.feetOffset, f.pos.z, []); o.success = f.mode !== "air" && !!u && (u.id === al.lastTargetId || (["balcony", "rail"].includes(u.kind) && ["balcony", "rail"].includes(s.kind))); break; } } else break; }
    if (!o.started && first >= 0 && !q && !ap.active && (mode === "B" || o.tapped || true) && !al.active) { const behind = (cx - f.pos.x) * -Math.sin(f.yaw) + (cz - f.pos.z) * -Math.cos(f.yaw) < -2; if (behind) { o.goneBeforeStart = true; o.why = o.why || sp.goneWhy(s.id) || "passed"; break; } }
  }
  void hold; return o;
}
const pct = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) : "-") + `% (${a}/${b})`;
for (const vp of [[892, 412], [412, 892]] as [number, number][]) {
  const res: Record<string, Out[]> = { B: [], C: [] };
  for (const mode of ["B", "C"] as const) for (let i = 0; i < N; i++) { const o = trial(i, mode, vp); if (o) res[mode].push(o); }
  console.log(`=== 画面 ${vp.join("x")}、反応時間 ${TR} s、試行 ${res.B.length} ===`);
  for (const mode of ["B", "C"] as const) {
    const r = res[mode], seen = r.filter(x => x.seen), started = seen.filter(x => x.started), whyGone: Record<string, number> = {}; for (const x of seen.filter(y => y.goneBeforeStart)) whyGone[x.why || "?"] = (whyGone[x.why || "?"] || 0) + 1;
    const byV = [7, 9, 11, 13].map(v => { const a = started.filter(x => x.v === v); return `v${v}:${a.filter(x => x.success).length}/${a.length}`; }).join(" ");
    console.log(`${mode === "B" ? "H8-B" : "H8-C"}: 見えた ${seen.length} | 押す前に去った(一度も押せず) ${seen.filter(x => !x.tapped && x.goneBeforeStart).length} | 着地を始められた ${pct(started.length, seen.length)} | うち成功(1.5 s 保持) ${pct(started.filter(x => x.success).length, started.length)} | 衝突(始める前 ${r.filter(x => x.crash && !x.crashAfter).length} / 始めた後 ${r.filter(x => x.crashAfter).length}) | 誤ターゲット ${r.filter(x => x.wrongTarget).length} | 押し直しで「遠すぎ」 ${r.reduce((a, x) => a + x.refusedFar, 0)} | 始まらず去った理由 ${JSON.stringify(whyGone)} | 速さ別の成功/開始 ${byV}`);
  }
}
