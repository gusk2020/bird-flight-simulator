// 着地補助・飛び乗り補助の成功率(補助あり/なし)を、ランダムな進入で測る。
// npx esbuild tools/perch_success.ts --bundle --platform=node --outfile=dist-test/perch.cjs && node dist-test/perch.cjs [試行数]
import { Flight } from "../src/flight";
import { generateLayout } from "../src/layout";
import { buildSurfaces, type Surface } from "../src/perches";
import { PerchAssist } from "../src/perchassist";
import { PHYS as P } from "../src/params";

const L = generateLayout();
const world = { colliders: L.colliders, heightAt: L.heightAt, perchAt: L.perchAt, perchPoint: L.perchPoint, wireDir: L.wireDir, waterAt: L.waterAt };
const idx = buildSurfaces(L);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export interface Outcome { ok: boolean; why: string }
let seed = 3; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const open = (s: Surface) => !L.colliders.some(c => c.maxX - c.minX > 3 && c.maxZ - c.minZ > 3 && c.top > s.top + 0.3 && c.maxX > s.minX - 7 && c.minX < s.maxX + 7 && c.maxZ > s.minZ - 7 && c.minZ < s.maxZ + 7); // 周囲に背の高い建物がない面だけ

/** 空中から減速して降りる(人の操作の代わりの簡易モデル: 目標へ目で合わせた舵+誤差、近づいたら減速) */
export function airApproach(s0: Surface, assist: boolean): Outcome {
  const s = s0;
  const f = new Flight(world), pa = new PerchAssist(idx); pa.enabled = assist;
  // ベランダ・手すりは建物の外側からだけ近づける(壁の向こうからは来られない)
  const apt = (s.kind === "balcony" || s.kind === "rail") ? L.apts.find(a => Math.abs((s.minX + s.maxX) / 2 - a.x) < a.w / 2 + 0.1 && Math.abs((s.minZ + s.maxZ) / 2 - a.z) < a.d / 2 + 1.5) : undefined;
  const ang = apt ? ((s.minZ + s.maxZ) / 2 > apt.z ? Math.PI / 2 : -Math.PI / 2) + (rnd() - 0.5) * 1.6 : rnd() * Math.PI * 2, dist = 6 + rnd() * 8, cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
  let a0 = ang, h0 = s.top + 0.8 + rnd() * 3.2;
  // 人が実際に飛んでくる経路だけを使う: 出発点から足場までの直線上に、その高さより高い物(木の枝・電柱など)がない向きを選び直す
  const clear = (a: number) => { for (let k = 0; k <= 20; k++) { const t = k / 20, x = cx + Math.cos(a) * dist * (1 - t), z = cz + Math.sin(a) * dist * (1 - t); if (t < 0.97 && L.heightAt(x, z) > s.top + 0.05 && L.heightAt(x, z) > h0 - 0.9 - (h0 - s.top) * t) return false; } return true; };
  for (let k = 0; k < 24 && !clear(a0); k++) a0 = apt ? ang + (rnd() - 0.5) * 1.2 : rnd() * Math.PI * 2;
  f.pos.set(cx + Math.cos(a0) * dist, h0, cz + Math.sin(a0) * dist); f.prevPos.copy(f.pos); // 進入の高さ・距離・速さ・向きをばらつかせる
  const toward = Math.atan2(-(cx - f.pos.x), -(cz - f.pos.z)); f.yaw = toward + (rnd() - 0.5) * 0.9; const v0 = 6 + rnd() * 5; f.vel.set(-Math.sin(f.yaw) * v0, -0.5, -Math.cos(f.yaw) * v0);
  const c0 = f.crashes, bias = (rnd() - 0.5) * 0.5;
  for (let i = 0; i < 60 * 9; i++) {
    const e = wrap(Math.atan2(-(cx - f.pos.x), -(cz - f.pos.z)) - f.yaw + bias), d = Math.hypot(cx - f.pos.x, cz - f.pos.z);
    const feet = f.pos.y - P.feetOffset;
    let inp = { x: -Math.max(-1, Math.min(1, e * 1.1)) * 0.8, y: Math.max(-0.4, Math.min(0.3, (s.top + 0.5 + d * 0.2 - feet) * 0.12)), flapHeld: false, flapTap: false, brake: d < 12 || f.speed > 8 && d < 16 };
    if (f.speed < 6.2 && f.vel.y < 0 && i % 25 === 0 && !(d < 3 && feet - s.top < 1.6)) inp.flapTap = true; // 着地直前(足場の真上近く)では羽ばたかない(人も降りる)
    inp = pa.apply(inp, f);
    f.step(1 / 60, inp);
    if (f.crashes > c0) return { ok: false, why: `crash feet-top=${(feet - s.top).toFixed(1)} d=${d.toFixed(1)} v=${f.speed.toFixed(1)} t=${(i / 60).toFixed(1)}` };
    if (f.mode === "landed" || f.mode === "rollout") {
      // ベランダは床と、その外側の手すりを1つの構造物として数える(手すりに止まるのもベランダへの着地)
      const rail = s.kind === "balcony" ? idx.all.find(r => r.kind === "rail" && r.maxX > s.minX && r.minX < s.maxX && r.maxZ > s.minZ - 0.6 && r.minZ < s.maxZ + 0.6 && Math.abs(r.top - s.top - 1) < 0.05 && Math.abs(f.pos.y - P.feetOffset - r.top) < 0.2) : undefined;
      const t = rail ?? s;
      const fy = f.pos.y - P.feetOffset, inside = f.pos.x >= t.minX - 0.3 && f.pos.x <= t.maxX + 0.3 && f.pos.z >= t.minZ - 0.3 && f.pos.z <= t.maxZ + 0.3;
      if (Math.abs(fy - t.top) < 0.2 && inside) { // 触れた瞬間ではなく、1.5秒後もその足場の上にいるか(滑り落ちない・そのまま止まる)まで見る
        for (let j = 0; j < 90; j++) { const q = pa.apply({ x: 0, y: 0, flapHeld: false, flapTap: false, brake: false }, f); f.step(1 / 60, q); if (f.crashes > c0) return { ok: false, why: "crash-after" }; }
        const fy2 = f.pos.y - P.feetOffset, in2 = f.pos.x >= t.minX - 0.05 && f.pos.x <= t.maxX + 0.05 && f.pos.z >= t.minZ - 0.05 && f.pos.z <= t.maxZ + 0.05;
        return Math.abs(fy2 - t.top) < 0.2 && in2 && f.mode !== "air" ? { ok: true, why: "landed" } : { ok: false, why: "slid-off" };
      }
      if (fy < s.top - 0.5) return { ok: false, why: "ground" };
    }
  }
  return { ok: false, why: "missed" };
}

/** 地上から前方の段差へ、向きを少しずらして1回タップ */
export function hopOnto(s: Surface, assist: boolean): Outcome {
  const f = new Flight(world), pa = new PerchAssist(idx); pa.enabled = assist;
  // 段差の手前(長手方向と直角の側)に、軸方向に少しずらして立つ。向きは段差の方へ ±0.35rad の誤差
  const dist = 0.8 + rnd() * 1.4, cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, side = rnd() < 0.5 ? -1 : 1, slide = (rnd() - 0.5) * 2;
  const px = s.axisAlongX ? cx + slide : (side < 0 ? s.minX - dist : s.maxX + dist), pz = s.axisAlongX ? (side < 0 ? s.minZ - dist : s.maxZ + dist) : cz + slide;
  if (world.heightAt(px, pz) > 0.5) return { ok: true, why: "skip" };
  f.pos.set(px, world.heightAt(px, pz) + P.feetOffset, pz); f.prevPos.copy(f.pos); f.mode = "landed"; f.vel.set(0, 0, 0);
  f.yaw = Math.atan2(-(cx - px), -(cz - pz)) + (rnd() - 0.5) * 0.7;
  for (let i = 0; i < 60 * 3; i++) {
    let inp = { x: 0, y: 0, flapHeld: false, flapTap: i === 5, brake: false };
    inp = pa.apply(inp, f); f.step(1 / 60, inp);
    if (i > 10 && (f.mode === "landed" || f.mode === "rollout")) { const fy = f.pos.y - P.feetOffset; return Math.abs(fy - s.top) < 0.2 ? { ok: true, why: "on" } : { ok: false, why: `ground d=${dist.toFixed(1)} yawErr=${(f.yaw).toFixed(2)} start=(${px.toFixed(1)},${pz.toFixed(1)}) h0=${world.heightAt(px, pz).toFixed(2)} wall=[${s.minX.toFixed(1)},${s.maxX.toFixed(1)}]x[${s.minZ.toFixed(1)},${s.maxZ.toFixed(1)}] land=(${f.pos.x.toFixed(2)},${f.pos.z.toFixed(2)}) crashes=${f.crashes}` }; }
  }
  return { ok: false, why: "missed" };
}

export function run(n: number) {
  const out: Record<string, { air: [number, number]; hop: [number, number]; why: Record<string, number> }> = {};
  if (typeof (globalThis as any).KINDS === "string") { /* 絞り込み用 */ }
  const kinds = ["bench", "wall", "roof", "fence", "rock", "balcony", "rail", "sign", "branch", "pole"] as const;
  for (const kind of kinds) {
    const surfaces = idx.all.filter(s => s.kind === kind && (kind === "balcony" || kind === "rail" || open(s)) && (kind !== "roof" || s.top < 7));
    if (!surfaces.length) continue;
    const r = { air: [0, 0] as [number, number], hop: [0, 0] as [number, number], why: {} as Record<string, number> };
    for (let a = 0; a < 2; a++) {
      for (let i = 0; i < n; i++) {
        seed = 100 + i; const s = surfaces[i % surfaces.length];
        const o = airApproach(s, a === 1); if (o.ok) r.air[a]++; else r.why[(a ? "補助あり:" : "補助なし:") + o.why] = (r.why[(a ? "補助あり:" : "補助なし:") + o.why] || 0) + 1;
        if (kind !== "roof" && kind !== "balcony" && s.top < 1.6) { seed = 900 + i; const h = hopOnto(s, a === 1); if (h.ok) r.hop[a]++; }
      }
    }
    out[kind] = r;
  }
  return out;
}
if (typeof process !== "undefined" && process.argv[1]?.includes("perch")) {
  const n = Number(process.argv[2] || 150), r = run(n);
  for (const [k, v] of Object.entries(r)) console.log(`${k.padEnd(6)} 空中から着地 ${(100 * v.air[0] / n).toFixed(0)}% → ${(100 * v.air[1] / n).toFixed(0)}%` + (v.hop[1] + v.hop[0] > 0 ? `   地上から飛び乗り ${(100 * v.hop[0] / n).toFixed(0)}% → ${(100 * v.hop[1] / n).toFixed(0)}%` : "") + `   失敗内訳 ${JSON.stringify(v.why)}`);
}
export const _dbg = { idx, hopOnto, open };
