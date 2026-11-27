/**
 * 地域地形の3D表示。頂点の高さは TerrainField.heights そのもの(飛行の地面と同じ配列)。補間で頂点を増やさない。
 * 色は高さによる飾りで、実測の土地利用ではない。道路・鉄道・地名は KFM の書き出しにあるもの(ゲーム内の架空史)だけを描く。
 * 建物・電線・着地面は書き出しに無いので、何も作らない。
 */
import * as THREE from "three";
import { terrainIndices, type KfmDecoded, type TerrainField } from "./regionTerrain";

const WATER = new THREE.Color(0x3b6e9c), SKIRT = new THREE.Color(0x5a5348);
/** 縮める前の標高(m)で決める飾りの色。境目はなめらかに混ぜる */
const RAMP: [number, number][] = [[0, 0xcfc497], [30, 0x7da35a], [300, 0x6a8f4e], [900, 0x8a8f55], [1600, 0x8b7656], [2500, 0x9c968c], [3300, 0xf2f2f0]];
const _a = new THREE.Color(), _b = new THREE.Color();
export function heightColour(realM: number, out: THREE.Color): THREE.Color {
  if (realM <= RAMP[0][0]) return out.setHex(RAMP[0][1]);
  for (let i = 1; i < RAMP.length; i++) if (realM <= RAMP[i][0]) { const t = (realM - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]); return out.lerpColors(_a.setHex(RAMP[i - 1][1]), _b.setHex(RAMP[i][1]), t); }
  return out.setHex(RAMP[RAMP.length - 1][1]);
}

export interface TerrainGeometryData { positions: Float32Array; colors: Float32Array; indices: Uint32Array }
/** 地形メッシュの頂点・インデックス(three.js のオブジェクトを作らない形。単体試験が飛行側の高さと突き合わせる) */
export function terrainGeometryData(f: TerrainField): TerrainGeometryData {
  const n = f.nx * f.ny, positions = new Float32Array(n * 3), colors = new Float32Array(n * 3), c = new THREE.Color();
  for (let k = 0; k < f.ny; k++) for (let i = 0; i < f.nx; i++) {
    const v = k * f.nx + i, h = f.heights[v];
    positions[v * 3] = f.x0 + i * f.spacing; positions[v * 3 + 1] = h; positions[v * 3 + 2] = f.z0 + k * f.spacing;
    if (f.water[v]) c.copy(WATER); else heightColour(f.tf.heightToReal(h), c);
    colors[v * 3] = c.r; colors[v * 3 + 1] = c.g; colors[v * 3 + 2] = c.b;
  }
  return { positions, colors, indices: terrainIndices(f.nx, f.ny) };
}

export interface RegionView { group: THREE.Group; dispose(): void }

export function buildRegionView(r: KfmDecoded, f: TerrainField): RegionView {
  const group = new THREE.Group(), disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(o: T) => { disposables.push(o); return o; };

  // 地形(飛行の地面と同じ高さ配列・同じ三角形)
  const d = terrainGeometryData(f), geo = own(new THREE.BufferGeometry());
  geo.setAttribute("position", new THREE.BufferAttribute(d.positions, 3)); geo.setAttribute("color", new THREE.BufferAttribute(d.colors, 3));
  geo.setIndex(new THREE.BufferAttribute(d.indices, 1)); geo.computeVertexNormals();
  const mat = own(new THREE.MeshLambertMaterial({ vertexColors: true }));
  group.add(new THREE.Mesh(geo, mat));

  // 範囲の縁: 高い所で終わる地形の側面を、地面0 m の「データ範囲外」まで塞ぐ(見た目だけ。飛行の地面は範囲外で 0 m)
  const sk: number[] = [], skc: number[] = [], skIdx: number[] = [];
  const edge: [number, number][] = [];
  for (let i = 0; i < f.nx; i++) edge.push([i, 0]); for (let k = 1; k < f.ny; k++) edge.push([f.nx - 1, k]);
  for (let i = f.nx - 2; i >= 0; i--) edge.push([i, f.ny - 1]); for (let k = f.ny - 2; k >= 1; k--) edge.push([0, k]);
  edge.forEach(([i, k], q) => { const v = k * f.nx + i, x = f.x0 + i * f.spacing, z = f.z0 + k * f.spacing, h = f.heights[v]; sk.push(x, h, z, x, 0, z); skc.push(SKIRT.r, SKIRT.g, SKIRT.b, SKIRT.r, SKIRT.g, SKIRT.b); const n = edge.length, a = q * 2, b = ((q + 1) % n) * 2; skIdx.push(a, a + 1, b, b, a + 1, b + 1); });
  const sgeo = own(new THREE.BufferGeometry()); sgeo.setAttribute("position", new THREE.Float32BufferAttribute(sk, 3)); sgeo.setAttribute("color", new THREE.Float32BufferAttribute(skc, 3)); sgeo.setIndex(skIdx);
  group.add(new THREE.Mesh(sgeo, own(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))));
  // 範囲外の面(0 m、データなし)。地形より下に置いて、縁の外側が空に抜けて見えないようにする
  const span = Math.max(f.bounds.maxX - f.bounds.minX, f.bounds.maxZ - f.bounds.minZ) * 6, outG = own(new THREE.PlaneGeometry(span, span)); outG.rotateX(-Math.PI / 2);
  const outM = new THREE.Mesh(outG, own(new THREE.MeshBasicMaterial({ color: SKIRT })));
  outM.position.set((f.bounds.minX + f.bounds.maxX) / 2, -0.05 * f.tf.scale.metresPerKm / 50, (f.bounds.minZ + f.bounds.maxZ) / 2); group.add(outM);

  // 道路・鉄道(KFMの線。開通中のみ。地面に沿わせる。区間は頂点間隔の半分以下に刻む)
  const lift = Math.max(0.4, f.spacing * 0.004), pos: number[] = [], col: number[] = [], cr = new THREE.Color(0xe0b13a), cl = new THREE.Color(0xb0413e);
  for (const l of r.file.lines) {
    if (l.state !== "open" || l.facility === "ferry") continue; const c = l.mode === "rail" ? cl : cr;
    for (let q = 0; q + 3 < l.pts.length; q += 2) {
      const a = f.tf.toVind(l.pts[q], l.pts[q + 1]), b = f.tf.toVind(l.pts[q + 2], l.pts[q + 3]), len = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(len / (f.spacing / 2)));
      for (let s = 0; s < n; s++) for (const t of [s / n, (s + 1) / n]) { const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t; if (!f.inside(x, z)) { pos.push(x, 0, z); } else pos.push(x, f.heightAt(x, z) + lift, z); col.push(c.r, c.g, c.b); }
    }
  }
  const lg = own(new THREE.BufferGeometry()); lg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); lg.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  group.add(new THREE.LineSegments(lg, own(new THREE.LineBasicMaterial({ vertexColors: true }))));

  // 地名(KFMのゲーム内の場所): 細い柱だけ。名前は画面の文字で最寄りを出す
  const pg = own(new THREE.CylinderGeometry(f.spacing * 0.01, f.spacing * 0.01, 1, 6)), pm = own(new THREE.MeshBasicMaterial({ color: 0xff5a4a }));
  for (const p of r.file.places) { const v = f.tf.toVind(p.x, p.y); if (!f.inside(v.x, v.z)) continue; const h = Math.max(30, f.spacing * 0.5), m = new THREE.Mesh(pg, pm); m.scale.set(1, h, 1); m.position.set(v.x, f.heightAt(v.x, v.z) + h / 2, v.z); group.add(m); }

  return { group, dispose: () => { disposables.forEach(o => o.dispose()); group.clear(); } };
}
