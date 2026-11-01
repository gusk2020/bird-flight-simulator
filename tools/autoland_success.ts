// G1-5 自動着地(◯タップ)の成功率・衝突率・所要時間を、ランダムな進入で測る。
// npx esbuild tools/autoland_success.ts --bundle --platform=node --outfile=dist-test/autoland_run.cjs && node dist-test/autoland_run.cjs [試行数]
import { Flight } from "../src/flight";
import { generateLayout } from "../src/layout";
import { buildSurfaces, type Surface } from "../src/perches";
import { PerchAssist } from "../src/perchassist";
import { AutoLand } from "../src/autoland";
import { PHYS as P } from "../src/params";
import { perchClass } from "../src/perchclass";

const L = generateLayout();
const world = { colliders: L.colliders, heightAt: L.heightAt, perchAt: L.perchAt, perchPoint: L.perchPoint, wireDir: L.wireDir, waterAt: L.waterAt };
const idx = buildSurfaces(L);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
let seed = 3; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
export interface Result { kind: string; refused: boolean; why: string; ok: boolean; crash: boolean; secs: number; walked: boolean; on?: string; v0?: number; use?: string }

/** 人が「このあたりの足場へ降りたい」と思って飛んでいる状況: 距離6〜16m・面の上0.8〜5m・速さ6〜11m/s・足場の方向から±45度ずれた向き */
export function trial(s: Surface, i: number, trace?: Record<string, number | string>[]): Result {
  seed = 500 + i * 7 + s.id;
  const f = new Flight(world), pa = new PerchAssist(idx), al = new AutoLand(idx, pa, L.heightAt);
  const apt = (s.kind === "balcony" || s.kind === "rail") ? L.apts.find(a => Math.abs((s.minX + s.maxX) / 2 - a.x) < a.w / 2 + 0.1 && Math.abs((s.minZ + s.maxZ) / 2 - a.z) < a.d / 2 + 1.5) : undefined;
  const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
  const ang = apt ? ((s.minZ + s.maxZ) / 2 > apt.z ? Math.PI / 2 : -Math.PI / 2) + (rnd() - 0.5) * 1.6 : rnd() * Math.PI * 2;
  const dist = 6 + rnd() * 10, h0 = s.top + 0.8 + rnd() * 4.2;
  // dist は足場の縁からの距離(大きな屋根では中心からの距離にすると、屋根の真上から始まってしまう)
  const dxs = Math.cos(ang), dzs = Math.sin(ang), hx = (s.maxX - s.minX) / 2, hz = (s.maxZ - s.minZ) / 2, tExit = Math.min(hx / Math.max(Math.abs(dxs), 1e-6), hz / Math.max(Math.abs(dzs), 1e-6));
  f.pos.set(cx + dxs * (tExit + dist), h0, cz + dzs * (tExit + dist)); f.prevPos.copy(f.pos);
  const toward = Math.atan2(-(cx - f.pos.x), -(cz - f.pos.z)); f.yaw = toward + (rnd() - 0.5) * 1.57; const v0 = 6 + rnd() * 5;
  f.vel.set(-Math.sin(f.yaw) * v0, -0.5, -Math.cos(f.yaw) * v0);
  const out: Result = { v0, kind: s.kind, refused: false, why: "", ok: false, crash: false, secs: 0, walked: false };
  if (!al.start(f, s)) { out.refused = true; out.why = al.lastRefusal || "refused"; return out; }
  const c0 = f.crashes; let i2 = 0;
  for (; i2 < 60 * 16 && al.active; i2++) {
    const raw = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
    al.drive(f, raw); pa.apply(raw, f);
    if (trace && i2 % 6 === 0) { const dxs = Math.max(s.minX - f.pos.x, 0, f.pos.x - s.maxX), dzs = Math.max(s.minZ - f.pos.z, 0, f.pos.z - s.maxZ); trace.push({ t: +(i2 / 60).toFixed(2), dx: +dxs.toFixed(2), dz: +dzs.toFixed(2), d: +Math.hypot(dxs, dzs).toFixed(2), feet: +(f.pos.y - P.feetOffset - s.top).toFixed(2), hs: +Math.hypot(f.vel.x, f.vel.z).toFixed(1), vy: +f.vel.y.toFixed(1), mode: f.mode, stall: f.stall ? 1 : 0, brake: raw.brake ? 1 : 0, flap: raw.flapTap ? 1 : 0, pitch: +f.pitch.toFixed(2), ry: +raw.y.toFixed(2), planH: pa.plan ? +(pa.plan.h - s.top).toFixed(2) : -9 }); }
    f.step(1 / 60, raw);
    if (f.crashes > c0) { out.crash = true; al.cancel("crash"); break; }
  }
  out.secs = i2 / 60; out.why = al.end; (globalThis as any).__dbg = al.dbg;
  if (al.end === "success") {
    // 1.5秒、何も触らずに待つ(滑り落ちない・そのまま止まる)。そのあと歩けるか(スティック前=歩く)を確かめる
    for (let j = 0; j < 90; j++) { const q = pa.apply({ x: 0, y: 0, flapHeld: false, flapTap: false, brake: false }, f); f.step(1 / 60, q); if (f.crashes > c0) out.crash = true; }
    const u = idx.under(f.pos.x, f.pos.y - P.feetOffset, f.pos.z, []);
    out.on = u?.kind;
    out.ok = !out.crash && f.mode !== "air" && !!u && (u === s || (u.kind !== s.kind && (u.kind === "rail" || u.kind === "balcony") && (s.kind === "rail" || s.kind === "balcony")));
    if (out.ok && f.mode === "landed") { // 実際に歩けるか: 足場の長手方向へ向きを合わせ(人がスティックで向きを変える)、1.5秒前へ。実際の座標の移動と足元の面を確かめる。見かけの歩行・端だから歩けたことにはしない
      const cls = perchClass(s); out.use = cls.use;
      if (cls.use === "walk") {
        const alongX = s.maxX - s.minX >= s.maxZ - s.minZ, a0 = alongX ? -Math.PI / 2 : Math.PI, a1 = a0 + Math.PI, dd = (a: number) => Math.abs(wrap(a - f.yaw)); f.yaw = dd(a0) <= dd(a1) ? a0 : a1;
        // 長手方向のどちらへ向いても、端まで少なくとも必要な距離があるとは限らない: 遠い側の端へ向ける
        const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, fwd = [-Math.sin(f.yaw), -Math.cos(f.yaw)]; if ((cx - f.pos.x) * fwd[0] + (cz - f.pos.z) * fwd[1] < 0) f.yaw += Math.PI;
        const x0 = f.pos.x, z0 = f.pos.z; let moved = 0; for (let j = 0; j < 90; j++) { f.step(1 / 60, pa.apply({ x: 0, y: 1, flapHeld: false, flapTap: false, brake: false }, f)); const uu = idx.under(f.pos.x, f.pos.y - P.feetOffset, f.pos.z, []); if (f.mode === "landed" && uu && (uu === s || uu.kind === "rail" || uu.kind === "balcony")) moved = Math.max(moved, Math.hypot(f.pos.x - x0, f.pos.z - z0)); }
        out.walked = moved >= 0.8;
      }
    }
  }
  return out;
}

const open = (s: Surface) => !L.colliders.some(c => c.maxX - c.minX > 3 && c.maxZ - c.minZ > 3 && c.top > s.top + 0.3 && c.maxX > s.minX - 7 && c.minX < s.maxX + 7 && c.maxZ > s.minZ - 7 && c.minZ < s.maxZ + 7);
export function run(n: number, offset = 0) {
  const kinds = ["bench", "wall", "fence", "rail", "balcony", "sign", "branch", "pole", "rock", "roof"] as const;
  const res: Record<string, { n: number; refused: number; ok: number; crash: number; secs: number; walked: number; walkable: number; ends: Record<string, number>; on: Record<string, number>; byV: Record<string, [number, number]> }> = {};
  for (const kind of kinds) {
    const ss = idx.all.filter(s => s.kind === kind && (kind === "balcony" || kind === "rail" || open(s)) && (kind !== "roof" || s.top < 12)); if (!ss.length) continue;
    const r = { n, refused: 0, ok: 0, crash: 0, secs: 0, walked: 0, walkable: 0, ends: {} as Record<string, number>, on: {} as Record<string, number>, byV: {} as Record<string, [number, number]> };
    for (let i = 0; i < n; i++) { const t = trial(ss[(i + offset) % ss.length], i + offset); if (t.refused) { r.refused++; continue; } { const b = t.v0! < 8 ? "6-8" : t.v0! < 9.5 ? "8-9.5" : "9.5-11"; (r.byV[b] ||= [0, 0])[1]++; if (t.ok) r.byV[b][0]++; } if (t.ok) { r.ok++; r.on[t.on || "?"] = (r.on[t.on || "?"] || 0) + 1; r.secs += t.secs; if (t.use === "walk") { r.walkable++; if (t.walked) r.walked++; } } if (t.crash) r.crash++; r.ends[t.why] = (r.ends[t.why] || 0) + 1; }
    res[kind] = r;
  }
  return res;
}
if (typeof process !== "undefined" && process.argv[1]?.includes("autoland_run")) {
  const n = Number(process.argv[2] || 100), r = run(n, Number(process.argv[3] || 0));
  for (const [k, v] of Object.entries(r)) { const att = v.n - v.refused; console.log(`${k.padEnd(8)} 試行${v.n} 開始不可${v.refused} → 成功${v.ok}(${att ? (100 * v.ok / att).toFixed(0) : "-"}%) 衝突${v.crash} 平均${v.ok ? (v.secs / v.ok).toFixed(1) : "-"}s 着地後に歩ける${v.walked}/${v.ok} 内訳${JSON.stringify(v.ends)}`); }
}
