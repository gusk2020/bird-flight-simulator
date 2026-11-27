/**
 * KFM 地域スナップショット(kfm.region.v1) → Vind Ving の飛行用地形。three.js に依存しない純粋な計算。
 *
 * 描画(regionView.ts)と飛行の地面・水面判定は、ここで作る同じ TerrainField の同じ配列を使う。
 * 別々に地形を作らない。三角形の分け方もここで一つに決め、描画のインデックスもここから作る。
 *
 * 座標・尺度・向きの変換は regionTransform() の一箇所だけに置く。
 *   KFM : 局所等距円筒 km。x=東、y=北。標高はメートル(基準は frame.heightDatum)。格子の行0は南、値はセル中心。
 *   Vind: x=東、y=上、z=南(three.js の右手系。北は -z で、yaw 0 の進行方向 -z が北を向く)。単位はメートル。
 *   ※ 下書きアダプター(kfmRegion.ts)は「z が北」としているが、右手系の three.js でそうすると地図が鏡像になる。
 *     この試作は下書きの regionToLayout を使わず、変換をここに持つ。
 *
 * 尺度: 水平も標高も同じ倍率で縮める(形を保つ)。倍率は黙って決めず、REGION_SCALES に名前と理由を持たせて画面に出す。
 */
import { readKfmRegion } from "./kfmRegion";

export interface RegionScale {
  id: string;
  /** KFMの1 km が Vind Ving の何メートルか。水平にも標高にも同じ倍率を掛ける(標高の強調はしない) */
  metresPerKm: number;
  label: string;
  reason: string;
}
export const REGION_SCALES: readonly RegionScale[] = [
  { id: "1:20", metresPerKm: 50, label: "1/20(地域を縮めて飛ぶ)", reason: "実寸だと200 km四方を横断するのに数時間かかる(20 m/sで約2.8時間)。1/20なら約10 km四方で、巡航で十分に横断できる。標高も同じ1/20で縮め、斜面の角度は実際と同じ。鳥の大きさは変えない。" },
  { id: "1:1", metresPerKm: 1000, label: "実寸 1/1", reason: "縮めない。地域は広大で、20 m/sでは数時間かかる。5 km格子は鳥から見ると非常に粗い。" },
];
export const DEFAULT_REGION_SCALE = REGION_SCALES[0];

export type KfmDecoded = ReturnType<typeof readKfmRegion>;

export interface RegionTransform {
  scale: RegionScale;
  /** Vind の x=0,z=0 に置く KFM の点(km)。頂点格子の中心 */
  originKm: { x: number; y: number };
  /** KFM km → Vind m。北(+y)は -z へ */
  toVind(xKm: number, yKm: number): { x: number; z: number };
  /** Vind m → KFM km */
  toKm(x: number, z: number): { x: number; y: number };
  /** KFM の標高 m → Vind の高さ m(同じ倍率、強調なし) */
  heightToVind(m: number): number;
  /** Vind の高さ m → 縮める前の標高 m(表示用) */
  heightToReal(h: number): number;
}

/** 頂点はセル中心。頂点格子の外側の半セルは、データが「そこには頂点がない」だけで、この試作では範囲外として扱う */
export function regionTransform(r: KfmDecoded, scale: RegionScale = DEFAULT_REGION_SCALE): RegionTransform {
  const g = r.file.grid, k = scale.metresPerKm;
  const originKm = { x: g.x0 + g.nx * g.cellKm / 2, y: g.y0 + g.ny * g.cellKm / 2 };
  return {
    scale, originKm,
    toVind: (xKm, yKm) => ({ x: (xKm - originKm.x) * k, z: -(yKm - originKm.y) * k }),
    toKm: (x, z) => ({ x: x / k + originKm.x, y: -z / k + originKm.y }),
    heightToVind: m => m * k / 1000,
    heightToReal: h => h * 1000 / k,
  };
}

export interface TerrainField {
  nx: number; ny: number;
  /** 頂点間隔(m)。KFMの cellKm × 倍率。名目格子間隔であり、有効な地形解像度ではない */
  spacing: number;
  /** 最初の頂点(北西の角)の位置。頂点 (i,k) は x=x0+i*spacing, z=z0+k*spacing。k は北から南へ */
  x0: number; z0: number;
  /** 頂点の高さ(Vind m)。北から南、西から東の順。海・湖の頂点は 0(海面) */
  heights: Float32Array;
  /** 水の頂点は1、陸は0。陸地かどうかは KFM の land(0海/1陸/2湖) から */
  water: Uint8Array;
  /** 範囲外なら false */
  inside(x: number, z: number): boolean;
  /** 地面の高さ(m)。範囲外は 0(データなし)。描画メッシュと同じ三角形で線形補間する */
  heightAt(x: number, z: number): number;
  /** 水の上か(海・湖)。範囲外は false */
  waterAt(x: number, z: number): boolean;
  /** 範囲の端(頂点格子の外周) */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  tf: RegionTransform;
  stats: { minReal: number; maxReal: number; landVertices: number; waterVertices: number; clampedBelowSea: number };
}

/** 三角形の分け方。四角形 (i,k)-(i+1,k)-(i,k+1)-(i+1,k+1) を (i,k)-(i+1,k+1) の対角線で割る。描画のインデックスもこの順 */
export function terrainIndices(nx: number, ny: number): Uint32Array {
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6); let o = 0;
  for (let k = 0; k < ny - 1; k++) for (let i = 0; i < nx - 1; i++) {
    const a = k * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx[o++] = a; idx[o++] = c; idx[o++] = d; // 三角形A: 上向きの法線
    idx[o++] = a; idx[o++] = d; idx[o++] = b; // 三角形B
  }
  return idx;
}

export function buildTerrainField(r: KfmDecoded, scale: RegionScale = DEFAULT_REGION_SCALE): TerrainField {
  const g = r.file.grid, tf = regionTransform(r, scale), nx = g.nx, ny = g.ny;
  const heights = new Float32Array(nx * ny), water = new Uint8Array(nx * ny);
  let minReal = Infinity, maxReal = -Infinity, landV = 0, waterV = 0, below = 0;
  for (let k = 0; k < ny; k++) for (let i = 0; i < nx; i++) {
    const j = ny - 1 - k, src = j * nx + i, v = k * nx + i; // KFM の行0は南。ここは北から
    const kind = r.land[src], m = r.elev[src];
    if (kind === 1) { // 陸: 海面下の標高(データ上の負値)は 0 に切る。切った数は stats に残す
      const mm = Math.max(0, m); if (m < 0) below++;
      heights[v] = tf.heightToVind(mm); minReal = Math.min(minReal, mm); maxReal = Math.max(maxReal, mm); landV++;
    } else { // 海・湖: 水面。KFM は海セルに「陰影用の深さ」を負値で入れており、地形としては使わない(海面 0 m)
      heights[v] = 0; water[v] = 1; waterV++;
    }
  }
  const x0 = (0.5 - nx / 2) * g.cellKm * scale.metresPerKm, z0 = (0.5 - ny / 2) * g.cellKm * scale.metresPerKm, spacing = g.cellKm * scale.metresPerKm;
  const bounds = { minX: x0, maxX: x0 + (nx - 1) * spacing, minZ: z0, maxZ: z0 + (ny - 1) * spacing };
  const inside = (x: number, z: number) => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
  // 頂点セルの中での位置から、描画と同じ三角形で線形補間する
  function sample(arr: ArrayLike<number>, x: number, z: number): number {
    const fx = (x - x0) / spacing, fz = (z - z0) / spacing;
    const i = Math.min(nx - 2, Math.max(0, Math.floor(fx))), k = Math.min(ny - 2, Math.max(0, Math.floor(fz)));
    const u = fx - i, w = fz - k, a = k * nx + i, b = a + 1, c = a + nx, d = c + 1;
    // 対角線 a-d。u<=w(南西側)は三角形A (a,c,d)、それ以外は三角形B (a,d,b)
    return u <= w ? arr[a] + (arr[d] - arr[c]) * u + (arr[c] - arr[a]) * w : arr[a] + (arr[b] - arr[a]) * u + (arr[d] - arr[b]) * w;
  }
  return {
    nx, ny, spacing, x0, z0, heights, water, bounds, tf, inside,
    heightAt: (x, z) => (inside(x, z) ? sample(heights, x, z) : 0),
    waterAt: (x, z) => (inside(x, z) ? sample(water, x, z) >= 0.5 : false),
    stats: { minReal, maxReal, landVertices: landV, waterVertices: waterV, clampedBelowSea: below },
  };
}

/** 画面に出す、日本語の読み込みエラー。下書きアダプターの英語メッセージを置き換える。入力は補正せず、原文も添える */
const ERR_JA: [RegExp, string][] = [
  [/Invalid KFM snapshot/, "JSONの中身がオブジェクトではありません"],
  [/Unsupported KFM format/, "kfm.region.v1 の形式ではありません(format や frame.kind が違います)"],
  [/Invalid KFM grid/, "格子の情報(nx, ny, cellKm, x0, y0)が不正、または大きすぎます(最大50万セル)"],
  [/Invalid KFM projection/, "座標系の情報(lon0, lat0, kmPerDegLon, kmPerDegLat)が不正です"],
  [/Invalid KFM metadata/, "出典・年・乱数の種・licence・places・lines のいずれかが不正です"],
  [/Invalid KFM base64/, "標高または土地区分の base64 が壊れています"],
  [/Invalid KFM raster length\/land/, "標高・土地区分の長さが nx×ny と合いません、または土地区分に 0/1/2 以外があります"],
  [/Invalid KFM place/, "places の中に不正な場所があります"],
  [/Invalid KFM line/, "lines の中に不正な線があります"],
];
export function describeRegionError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof SyntaxError) return `JSONとして読めません(${msg})`;
  for (const [re, ja] of ERR_JA) if (re.test(msg)) return `${ja}(${msg})`;
  return `読み込めませんでした(${msg})`;
}

/** 文字列(JSON)から読む。失敗は Error(日本語) で投げる */
export function parseRegionText(text: string): KfmDecoded {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(describeRegionError(e)); }
  try { return readKfmRegion(raw); } catch (e) { throw new Error(describeRegionError(e)); }
}

/** 飛行の開始位置: 指定の場所、なければ人口最大の場所、なければ範囲の中央。範囲外・水の上なら中央の最も近い陸ではなく、そのまま(利用者に見せる) */
export function pickSpawn(r: KfmDecoded, f: TerrainField, placeId?: string) {
  const places = r.file.places, p = placeId ? places.find(q => q.id === placeId) : [...places].sort((a, b) => b.pop - a.pop)[0];
  if (!p) return { x: 0, z: 0, name: "範囲の中央", id: "" };
  const v = f.tf.toVind(p.x, p.y);
  return { x: v.x, z: v.z, name: p.name, id: p.id };
}

/** 最も近い場所(KFMのゲーム内の地名)。表示用 */
export function nearestPlace(r: KfmDecoded, f: TerrainField, x: number, z: number) {
  let best: { name: string; pop: number; distM: number } | null = null;
  for (const p of r.file.places) {
    const v = f.tf.toVind(p.x, p.y), d = Math.hypot(v.x - x, v.z - z);
    if (!best || d < best.distM) best = { name: p.name, pop: p.pop, distM: d };
  }
  return best;
}

/** 飛行の範囲と最高高度を地形に合わせる。範囲は地形の外側に2セル分の余白(外に出ると「範囲外」と表示)。最高高度は最高地点の上、標準ワールドと同じ160 m */
export function setFlightLimits(flight: { bound: number; maxAltitude: number }, f: TerrainField, headroom = 160) {
  const b = f.bounds; flight.bound = Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minZ), Math.abs(b.maxZ)) + 2 * f.spacing;
  flight.maxAltitude = Math.max(...f.heights) + headroom;
}
