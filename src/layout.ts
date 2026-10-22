// 街の配置データ (描画なし・純粋なデータ)。物理とテストからも使う。
export const PITCH = 56, ROAD = 10, LOT = 46, HALF = 3, LOT_TOP = 0.12;
export interface Collider { minX: number; maxX: number; minZ: number; maxZ: number; top: number }
export interface House { x: number; z: number; ry: number; floors: 1 | 2; wall: number; roof: number }
export interface Apt { x: number; z: number; ry: number; floors: number; wall: number; w: number; d: number }
export interface Tree { x: number; z: number; s: number; tint: number }
export interface Low { x: number; z: number; hw: number; hd: number; top: number; kind: "bench" | "wall" | "planter" }
export interface Layout {
  lows: Low[];
  colliders: Collider[]; houses: House[]; apts: Apt[]; tanks: { x: number; z: number; y: number }[];
  trees: Tree[]; poles: { x: number; z: number }[]; poleLines: [number, number][][];
  lots: { x: number; z: number; park: boolean }[]; roads: number[];
  heightAt(x: number, z: number): number;
}
export const HOUSE_W = 10, HOUSE_D = 8, FLOOR_H = 3.1, APT_W = 24, APT_D = 15;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const WALLS = [0xf1ead9, 0xe8e2d0, 0xd9d4c6, 0xf4f1ea, 0xcfd8dc, 0xe6d5b8];
const APT_WALLS = [0xe9e6df, 0xd7d9dc, 0xc9b9a6, 0xdad2c2];
const ROOFS = [0x4b4f58, 0x6b4a3d, 0x3f5566, 0x59504a];

export function houseHeight(floors: number) { return floors === 2 ? 6.2 : 3.2; }

export function generateLayout(seed = 7): Layout {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const L: Layout = { lows: [], colliders: [], houses: [], apts: [], tanks: [], trees: [], poles: [], poleLines: [], lots: [], roads: [], heightAt };
  for (let k = 0; k < 8; k++) L.roads.push((k - 3.5) * PITCH);
  const box = (x: number, z: number, hw: number, hd: number, top: number) =>
    L.colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd, top });
  for (let i = -HALF; i <= HALF; i++) for (let j = -HALF; j <= HALF; j++) {
    const cx = i * PITCH, cz = j * PITCH, ring = Math.max(Math.abs(i), Math.abs(j));
    const park = i === 0 && j === 0;
    L.lots.push({ x: cx, z: cz, park });
    if (park) {
      for (let n = 0; n < 70; n++) L.trees.push({ x: cx + (r() - 0.5) * 40, z: cz + (r() - 0.5) * 40, s: 1.4 + r() * 1.6, tint: r() });
      continue;
    }
    const kind = ring === 1 ? 'tall' : r() < 0.28 ? 'mid' : 'houses';
    if (kind === 'houses') {
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const floors = r() < 0.7 ? 2 : 1, rot = r() < 0.5 ? 0 : Math.PI / 2;
        const x = cx + sx * 11.5 + (r() - 0.5) * 3, z = cz + sz * 11.5 + (r() - 0.5) * 3;
        L.houses.push({ x, z, ry: rot, floors: floors as 1 | 2, wall: pick(WALLS), roof: pick(ROOFS) });
        const hw = (rot ? HOUSE_D : HOUSE_W) / 2, hd = (rot ? HOUSE_W : HOUSE_D) / 2;
        box(x, z, hw, hd, houseHeight(floors) + 0.45);
      }
      for (let n = 0; n < 3; n++) L.trees.push({ x: cx + (r() - 0.5) * 6, z: cz + (r() - 0.5) * 36, s: 1.2 + r() * 0.8, tint: r() });
    } else {
      const spots = kind === 'tall' ? [-12, 12] : [0];
      for (const oz of spots) {
        const floors = kind === 'tall' ? 9 + Math.floor(r() * 5) : 5 + Math.floor(r() * 3);
        const ry = 0, h = floors * FLOOR_H;
        const x = cx + (r() - 0.5) * 4, z = cz + oz;
        L.apts.push({ x, z, ry, floors, wall: pick(APT_WALLS), w: APT_W, d: APT_D });
        box(x, z, APT_W / 2, APT_D / 2, h);
        const tx = x + (r() - 0.5) * 8, tz = z + (r() - 0.5) * 4;
        L.tanks.push({ x: tx, z: tz, y: h });
        box(tx, tz, 2.5, 2.5, h + 2.2);
      }
    }
    // 街路樹: 区画の縁に沿って
    for (let t = -20; t <= 20; t += 10) {
      const e = LOT / 2 - 2.2;
      for (const [x, z] of [[t, -e], [t, e], [-e, t], [e, t]]) if (r() < 0.65) L.trees.push({ x: cx + x, z: cz + z, s: 1.1 + r() * 0.7, tint: r() });
    }
  }
  // 電柱: 道路沿い。交差点から14m離れた位置に28m間隔
  for (const rd of L.roads) {
    const line: [number, number][] = [], line2: [number, number][] = [];
    for (let p = -196 + 14; p < 196; p += 28) {
      L.poles.push({ x: p, z: rd + 5.8 }); line.push([p, rd + 5.8]);
      L.poles.push({ x: rd + 5.8, z: p }); line2.push([rd + 5.8, p]);
    }
    L.poleLines.push(line, line2);
  }
  // 低い障害物(歩く・小ジャンプで乗り越える練習用): 既存の乱数列を乱さないよう別系列で配置する
  const r2 = rng(seed + 999);
  const low = (x: number, z: number, hw: number, hd: number, top: number, kind: Low["kind"]) => { L.lows.push({ x, z, hw, hd, top, kind }); box(x, z, hw, hd, top); };
  for (const lot of L.lots) {
    if (lot.park) { for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; low(lot.x + Math.cos(a) * 9, lot.z + Math.sin(a) * 9, k % 2 ? 0.25 : 0.8, k % 2 ? 0.8 : 0.25, 0.5, "bench"); } continue; }
    if (r2() < 0.7) low(lot.x + (r2() - 0.5) * 14, lot.z + (r2() < 0.5 ? -20.3 : 20.3), 5, 0.15, 1.0, "wall");
    if (r2() < 0.5) low(lot.x + (r2() < 0.5 ? -21 : 21) , lot.z + (r2() - 0.5) * 20, 0.5, 0.5, 0.45, "planter");
  }
  function heightAt(x: number, z: number) {
    let h = 0;
    for (const c of L.colliders) if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && c.top > h) h = c.top;
    if (h > 0) return h;
    const ix = Math.round(x / PITCH), iz = Math.round(z / PITCH);
    if (Math.abs(ix) <= HALF && Math.abs(iz) <= HALF && Math.abs(x - ix * PITCH) < LOT / 2 && Math.abs(z - iz * PITCH) < LOT / 2) return LOT_TOP;
    return 0;
  }
  return L;
}
