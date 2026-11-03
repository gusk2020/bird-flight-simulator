import type { Layout } from "./layout";

/** H3 水たまり。雨で増え、晴れると乾く。公園には常設の浅い池がある。位置は区画から決まる(決定的)。 */
export const PUDDLE = {
  fillPerSec: 0.045,    // 雨が最大のとき、1秒あたり増える濡れ量(0..1)。約22秒の雨で満水
  dryPerSec: 0.016,     // 日なた(sun=1)で1秒あたり減る量。約60秒の晴れで乾く
  dryBase: 0.002,       // 曇りでもわずかに乾く
  lotPuddles: 3,        // 空き地・公園の1区画あたりの雨水たまりの数
  roadPuddles: 10,      // 道路の水たまりの数
  maxRadius: 2.2,       // 雨水たまりの最大半径 m
  poolRadius: 3.2,      // 公園の常設池の半径 m
  y: 0.045,             // 地面からの高さ m(道路との同一平面を避ける)
  drinkRange: 1.4,      // 水際から、飲む・浴びるとみなす距離 m
};
export interface Puddle { x: number; z: number; r: number; thr: number; perm: boolean }
const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

const blocked = (L: Pick<Layout, "colliders">, x: number, z: number, r: number) => L.colliders.some(c => x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r);
export function buildPuddles(L: Pick<Layout, "lots" | "roads" | "groundAt" | "colliders">): Puddle[] {
  const out: Puddle[] = [];
  L.lots.forEach((lot, li) => {
    if (lot.use === "park") out.push({ x: lot.x + 9, z: lot.z - 7, r: PUDDLE.poolRadius, thr: 0, perm: true });
    if (lot.use !== "park" && lot.use !== "vacant") return;
    for (let k = 0; k < PUDDLE.lotPuddles; k++) {
      const a = hash(li * 7 + k * 3 + 1) * Math.PI * 2, d = 4 + hash(li * 5 + k * 11 + 2) * 12;
      const x = lot.x + Math.cos(a) * d, z = lot.z + Math.sin(a) * d, g = L.groundAt(x, z);
      if ((g !== "grass" && g !== "soil") || blocked(L, x, z, PUDDLE.maxRadius)) continue;
      out.push({ x, z, r: PUDDLE.maxRadius * (0.6 + hash(li + k * 13) * 0.4), thr: hash(li * 3 + k) * 0.6, perm: false });
    }
  });
  for (let k = 0; k < PUDDLE.roadPuddles; k++) {
    const ri = Math.floor(hash(k * 17 + 5) * L.roads.length), along = (hash(k * 19 + 9) - 0.5) * 300, alongX = k % 2 === 0;
    const x = alongX ? along : L.roads[ri], z = alongX ? L.roads[ri] : along;
    if (L.groundAt(x, z) !== "road" || blocked(L, x, z, 2)) continue;
    out.push({ x, z, r: 1.2 + hash(k + 40) * 0.8, thr: hash(k * 31 + 3) * 0.5, perm: false });
  }
  return out;
}

export class Puddles {
  wet = 0;
  constructor(public list: Puddle[]) {}
  update(dt: number, rain: number, sun: number) {
    if (rain > 0.05) this.wet = Math.min(1, this.wet + PUDDLE.fillPerSec * rain * dt);
    else this.wet = Math.max(0, this.wet - (PUDDLE.dryBase + PUDDLE.dryPerSec * sun) * dt);
  }
  /** 現在の半径(0なら見えない)。常設の池は常に満水 */
  radius(p: Puddle): number { if (p.perm) return p.r; const u = (this.wet - p.thr) / Math.max(0.05, 1 - p.thr); return u <= 0 ? 0 : p.r * Math.sqrt(Math.min(1, u)); }
  /** 点から最も近い水面の縁までの距離(水面の中は0)と、その水たまり。なければ null */
  nearest(x: number, z: number): { d: number; p: Puddle } | null {
    let best: { d: number; p: Puddle } | null = null;
    for (const p of this.list) { const r = this.radius(p); if (r <= 0) continue; const d = Math.max(0, Math.hypot(x - p.x, z - p.z) - r); if (!best || d < best.d) best = { d, p }; }
    return best;
  }
}
