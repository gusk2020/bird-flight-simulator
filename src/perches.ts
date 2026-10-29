import { MIN_HALF, type Layout } from "./layout";

/**
 * 着地できる面(止まり木)の一覧。手動操作の着地補助とオート周遊の双方が同じデータを使う。
 * 面ごとに上面の高さ・広さ・種類を持ち、細長い縁(壁・ベンチ・手すり・柵など)は edge=true で長手方向(axisAlongX)を持つ。
 */
export type SurfaceKind = "bench" | "wall" | "planter" | "roof" | "tank" | "balcony" | "rail" | "fence" | "pole" | "sign" | "branch" | "rock";
export interface Surface { id: number; kind: SurfaceKind; minX: number; maxX: number; minZ: number; maxZ: number; top: number; edge: boolean; axisAlongX: boolean; /** 壁際の足場の「建物の外側」(単位ベクトル xz)。着地誘導が壁側へ寄りすぎないために使う */ outward?: [number, number] }

const CELL = 16;
export class SurfaceIndex {
  readonly all: Surface[] = [];
  private cells = new Map<number, Surface[]>();
  private key(cx: number, cz: number) { return (cx + 64) * 256 + (cz + 64); }
  add(kind: SurfaceKind, minX: number, maxX: number, minZ: number, maxZ: number, top: number, edge?: boolean, outward?: [number, number]): Surface {
    const w = maxX - minX, d = maxZ - minZ;
    const s: Surface = { id: this.all.length, kind, minX, maxX, minZ, maxZ, top, edge: edge ?? Math.min(w, d) < 1.2, axisAlongX: w >= d, outward };
    this.all.push(s);
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
      const k = this.key(cx, cz); let a = this.cells.get(k); if (!a) { a = []; this.cells.set(k, a); } a.push(s);
    }
    return s;
  }
  /** (x,z)から半径r以内にかかる面。結果配列は呼び出し側が渡して使い回す(毎フレームの確保を避ける)。 */
  near(x: number, z: number, r: number, out: Surface[]): Surface[] {
    out.length = 0;
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
      const a = this.cells.get(this.key(cx, cz)); if (!a) continue;
      for (let i = 0; i < a.length; i++) if (out.indexOf(a[i]) < 0) out.push(a[i]);
    }
    return out;
  }
  /** 足が面の上(上面から0.12m以内)にあるとき、その面 */
  under(x: number, feetY: number, z: number, out: Surface[]): Surface | null {
    this.near(x, z, 1, out);
    for (const s of out) if (x >= s.minX - 0.05 && x <= s.maxX + 0.05 && z >= s.minZ - 0.05 && z <= s.maxZ + 0.05 && Math.abs(feetY - s.top) < 0.12) return s;
    return null;
  }
}

/** 既存の街(屋根・タンク・低い障害物)から着地面を作る。E3で増える構造物は layout 側に足せば自動で含まれる。 */
export function buildSurfaces(L: Layout): SurfaceIndex {
  const idx = new SurfaceIndex();
  for (const l of L.lows) { const w = Math.max(l.hw, MIN_HALF), d = Math.max(l.hd, MIN_HALF); idx.add(l.kind, l.x - w, l.x + w, l.z - d, l.z + d, l.top, l.kind === "planter" ? false : undefined); } // 当たり判定と同じ幅
  for (const h of L.houses) { const w = 5, d = 4, t = L.heightAt(h.x, h.z); if (t > 0) idx.add("roof", h.x - w, h.x + w, h.z - d, h.z + d, t, false); }
  for (const a of L.apts) { const t = L.heightAt(a.x, a.z); if (t > 0) idx.add("roof", a.x - a.w / 2, a.x + a.w / 2, a.z - a.d / 2, a.z + a.d / 2, t, false); }
  return idx;
}
