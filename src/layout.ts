// 街の配置データ (描画なし・純粋なデータ)。物理とテストからも使う。
export const PITCH = 56, ROAD = 10, LOT = 46, HALF = 3, LOT_TOP = 0.12;
export interface Collider { minX: number; maxX: number; minZ: number; maxZ: number; top: number }
export interface House { x: number; z: number; ry: number; floors: 1 | 2; wall: number; roof: number }
export interface Apt { x: number; z: number; ry: number; floors: number; wall: number; w: number; d: number }
export interface Tree { x: number; z: number; s: number; tint: number }
export interface Low { x: number; z: number; hw: number; hd: number; top: number; kind: "bench" | "wall" | "planter" | "balcony" | "rail" | "fence" | "sign" | "rock" | "branch" | "pole" }
export interface Wire { ax: number; az: number; bx: number; bz: number; off: number; alongX: boolean }
export const WIRE_TOP = 8.3, WIRE_SAG = 1.2, WIRE_SPACING = 0.9;
export interface Layout {
  wires: Wire[]; perchAt(x: number, y: number, z: number, r: number): { id: number; t: number } | null;
  perchPoint(id: number, t: number, out: { x: number; y: number; z: number }): void; wireDir(id: number): [number, number];
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
  const L: Layout = { wires: [], perchAt, perchPoint, wireDir, lows: [], colliders: [], houses: [], apts: [], tanks: [], trees: [], poles: [], poleLines: [], lots: [], roads: [], heightAt };
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
  // 電線: 柱の間に3本ずつ。見た目(world.ts)と止まり木判定が同じデータを使う
  for (const line of L.poleLines) for (let i = 0; i + 1 < line.length; i++) {
    const [x0, z0] = line[i], [x1, z1] = line[i + 1], alongX = Math.abs(x1 - x0) > 1;
    for (const off of [-WIRE_SPACING, 0, WIRE_SPACING]) L.wires.push({ ax: x0, az: z0, bx: x1, bz: z1, off, alongX });
  }
  function perchPoint(id: number, t: number, out: { x: number; y: number; z: number }) {
    const w = L.wires[id]; out.x = w.ax + (w.bx - w.ax) * t + (w.alongX ? 0 : w.off); out.z = w.az + (w.bz - w.az) * t + (w.alongX ? w.off : 0);
    out.y = WIRE_TOP - WIRE_SAG * 4 * t * (1 - t);
  }
  function wireDir(id: number): [number, number] { const w = L.wires[id], dx = w.bx - w.ax, dz = w.bz - w.az, l = Math.hypot(dx, dz); return [dx / l, dz / l]; }
  /** (x,y,z)に最も近い電線上の点。半径r以内でなければ null */
  function perchAt(x: number, y: number, z: number, r: number) {
    if (y < WIRE_TOP - WIRE_SAG - r || y > WIRE_TOP + r) return null;
    let best = -1, bt = 0, bd = r * r; const pt = { x: 0, y: 0, z: 0 };
    for (let id = 0; id < L.wires.length; id++) {
      const w = L.wires[id], mx = (w.ax + w.bx) / 2 + (w.alongX ? 0 : w.off), mz = (w.az + w.bz) / 2 + (w.alongX ? w.off : 0);
      if (Math.abs(x - mx) > 15 + r || Math.abs(z - mz) > 15 + r) continue;
      const dx = w.bx - w.ax, dz = w.bz - w.az; const ox = w.alongX ? 0 : w.off, oz = w.alongX ? w.off : 0;
      let t = ((x - w.ax - ox) * dx + (z - w.az - oz) * dz) / (dx * dx + dz * dz); t = Math.max(0.03, Math.min(0.97, t));
      perchPoint(id, t, pt); const d = (pt.x - x) ** 2 + (pt.y - y) ** 2 + (pt.z - z) ** 2;
      if (d < bd) { bd = d; best = id; bt = t; }
    }
    return best < 0 ? null : { id: best, t: bt };
  }
  // 低い障害物(歩く・小ジャンプで乗り越える練習用): 既存の乱数列を乱さないよう別系列で配置する
  const r2 = rng(seed + 999);
  const low = (x: number, z: number, hw: number, hd: number, top: number, kind: Low["kind"]) => { L.lows.push({ x, z, hw, hd, top, kind }); box(x, z, hw, hd, top); };
  for (const lot of L.lots) {
    if (lot.park) { for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; low(lot.x + Math.cos(a) * 9, lot.z + Math.sin(a) * 9, k % 2 ? 0.25 : 0.8, k % 2 ? 0.8 : 0.25, 0.5, "bench"); } continue; }
    if (r2() < 0.7) low(lot.x + (r2() - 0.5) * 14, lot.z + (r2() < 0.5 ? -20.3 : 20.3), 5, 0.15, 1.0, "wall");
    if (r2() < 0.5) low(lot.x + (r2() < 0.5 ? -21 : 21) , lot.z + (r2() - 0.5) * 20, 0.5, 0.5, 0.45, "planter");
  }
  // E3: 飛び乗って遊べる構造物と自然物(ベランダ・手すり・柵・看板・岩・木の枝・電柱の上)。既存の乱数列を乱さないよう別系列で配置する
  const r3 = rng(seed + 1999);
  // ベランダと手すり: 集合住宅の前後の壁面に、2階(と高層は5階)の高さで。slab は上面だけが足場、手すりは細い縁
  for (const a of L.apts) {
    const levels = a.floors >= 9 ? [2, 5] : [2];
    for (const lv of levels) {
      if (r3() < 0.25) continue;
      const side = r3() < 0.6 ? 1 : -1, bx = a.x + (r3() - 0.5) * 12, bz = a.z + side * (APT_D / 2 + 0.7), top = FLOOR_H * lv;
      L.lows.push({ x: bx, z: bz, hw: 2.2, hd: 0.7, top, kind: "balcony" }); box(bx, bz, 2.2, 0.7, top);
      const rz = bz + side * 0.62;
      L.lows.push({ x: bx, z: rz, hw: 2.2, hd: 0.04, top: top + 1.0, kind: "rail" }); box(bx, rz, 2.2, 0.04, top + 1.0);
    }
  }
  for (const lot of L.lots) {
    if (lot.park) continue;
    // 柵: 区画の縁(道路側)に沿って低い柵。壁とは別の辺
    if (r3() < 0.6) { const sx = r3() < 0.5 ? -1 : 1; L.lows.push({ x: lot.x + sx * 21.8, z: lot.z + (r3() - 0.5) * 18, hw: 0.05, hd: 3.2, top: 1.15, kind: "fence" }); const l = L.lows[L.lows.length - 1]; box(l.x, l.z, l.hw, l.hd, l.top); }
    // 看板: 区画の角に近い支柱つきの小さな看板(上面が足場)
    if (r3() < 0.35) { const sx = r3() < 0.5 ? -1 : 1, sz = r3() < 0.5 ? -1 : 1; L.lows.push({ x: lot.x + sx * 19, z: lot.z + sz * 21.2, hw: 0.6, hd: 0.07, top: 2.3, kind: "sign" }); const l = L.lows[L.lows.length - 1]; box(l.x, l.z, l.hw, l.hd, l.top); }
    // 岩: ときどき区画の隅に
    if (r3() < 0.3) { L.lows.push({ x: lot.x + (r3() < 0.5 ? -1 : 1) * 17, z: lot.z + (r3() < 0.5 ? -1 : 1) * 19, hw: 0.6 + r3() * 0.4, hd: 0.5 + r3() * 0.3, top: 0.5 + r3() * 0.5, kind: "rock" }); const l = L.lows[L.lows.length - 1]; box(l.x, l.z, l.hw, l.hd, l.top); }
  }
  // 公園の岩
  for (let k = 0; k < 7; k++) { const a = r3() * Math.PI * 2, d = 12 + r3() * 7; const l: Low = { x: Math.cos(a) * d, z: Math.sin(a) * d, hw: 0.7 + r3() * 0.6, hd: 0.6 + r3() * 0.5, top: 0.6 + r3() * 0.8, kind: "rock" }; if (Math.abs(d - 9) < 1.5) continue; L.lows.push(l); box(l.x, l.z, l.hw, l.hd, l.top); }
  // 木の枝: 大きな木(公園・街路樹)の幹の脇に、止まれる太い枝。足場は枝の上面
  { let n = 0; for (const t of L.trees) { if (t.s < 1.7 || n >= 40) continue; n++; const a = r3() * Math.PI * 2, bx = t.x + Math.cos(a) * 0.9, bz = t.z + Math.sin(a) * 0.9; L.lows.push({ x: bx, z: bz, hw: 0.9, hd: 0.14, top: 2.4 * t.s, kind: "branch" }); box(bx, bz, 0.9, 0.14, 2.4 * t.s); } }
  // 電柱の上: 一部の電柱の頭(柱そのものが障害物にもなる)
  for (let i = 0; i < L.poles.length; i += 7) { const p = L.poles[i]; L.lows.push({ x: p.x, z: p.z, hw: 0.14, hd: 0.14, top: 9.0, kind: "pole" }); box(p.x, p.z, 0.14, 0.14, 9.0); }
  function heightAt(x: number, z: number) {
    let h = 0;
    const cs = L.colliders;
    for (let i = 0; i < cs.length; i++) { const c = cs[i]; if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && c.top > h) h = c.top; }
    if (h > 0) return h;
    const ix = Math.round(x / PITCH), iz = Math.round(z / PITCH);
    if (Math.abs(ix) <= HALF && Math.abs(iz) <= HALF && Math.abs(x - ix * PITCH) < LOT / 2 && Math.abs(z - iz * PITCH) < LOT / 2) return LOT_TOP;
    return 0;
  }
  return L;
}
