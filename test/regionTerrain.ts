import { readFileSync } from "node:fs";
import { check, suite } from "./harness";
import { Flight } from "../src/flight";
import { PHYS } from "../src/params";
import { REGION_SCALES, setFlightLimits, buildTerrainField, parseRegionText, pickSpawn, regionTransform, terrainIndices } from "../src/regionTerrain";
import { terrainGeometryData } from "../src/regionView";

const text = readFileSync("test/fixtures/kfm-region-sample-kanto-1900.json", "utf8");

/** 独立の検査: 描画メッシュの頂点・インデックスだけから、点を含む三角形を探して高さを求める(飛行側の補間を使わない) */
function meshHeight(d: ReturnType<typeof terrainGeometryData>, x: number, z: number): number {
  const p = d.positions, I = d.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const x1 = p[a], z1 = p[a + 2], x2 = p[b], z2 = p[b + 2], x3 = p[c], z3 = p[c + 2];
    const det = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3), l1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / det, l2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / det, l3 = 1 - l1 - l2, e = -1e-9;
    if (l1 >= e && l2 >= e && l3 >= e) return l1 * p[a + 1] + l2 * p[b + 1] + l3 * p[c + 1];
  }
  return NaN;
}

export function regionTerrainTests() {
  suite("Region pilot: KFM region -> flyable terrain (one height array for drawing and flight)");
  const region = parseRegionText(text), f = buildTerrainField(region), g = region.file.grid;
  check("real 41x41 KFM sample loads; grid, cell and counts come from the schema", f.nx === 41 && f.ny === 41 && g.cellKm === 5 && f.stats.landVertices + f.stats.waterVertices === 41 * 41 && f.stats.landVertices === 1130);
  check("default scale is 1/20, 1 km = 50 m, spacing 250 m", f.tf.scale.id === "1:20" && f.tf.scale.metresPerKm === 50 && f.spacing === 250);
  check("land elevation range matches the data (Fuji 3776 m before scaling)", f.stats.maxReal === 3776 && f.stats.minReal >= 0);
  check("highest vertex height = 3776 m x 1/20 = 188.8 m (no vertical exaggeration)", Math.abs(Math.max(...f.heights) - 188.8) < 1e-3);

  // 変換は一箇所。北は -z、東は +x。往復で戻る。原点は頂点格子の中心
  const tf = f.tf, a = tf.toVind(200, -100), b = tf.toVind(200, -90), c = tf.toVind(210, -100);
  check("north (+y km) maps to -z, east (+x km) maps to +x", b.z < a.z && Math.abs((a.z - b.z) - 10 * 50) < 1e-9 && Math.abs((c.x - a.x) - 10 * 50) < 1e-9);
  const back = tf.toKm(a.x, a.z); check("km -> Vind -> km round trip", Math.abs(back.x - 200) < 1e-9 && Math.abs(back.y + 100) < 1e-9);
  check("origin is the centre of the vertex grid (Vind 0,0)", Math.abs(f.x0 + (f.nx - 1) * f.spacing / 2) < 1e-9 && Math.abs(f.z0 + (f.ny - 1) * f.spacing / 2) < 1e-9);
  const tokyo = region.file.places.find(p => p.id === "C-JP-13")!, lonLat = region.lonLat(tokyo.x, tokyo.y);
  check("Tokyo place converts to lon/lat near the real Tokyo (frame is read from the schema)", Math.abs(lonLat[0] - 139.75) < 0.1 && Math.abs(lonLat[1] - 35.69) < 0.1);

  // 同じ高さ配列: 頂点では完全一致、任意の点では描画メッシュの三角形補間と一致
  let exact = true; for (let k = 0; k < f.ny; k++) for (let i = 0; i < f.nx; i++) if (f.heightAt(f.x0 + i * f.spacing, f.z0 + k * f.spacing) !== f.heights[k * f.nx + i]) exact = false;
  check("flight ground equals the drawn vertex heights at every vertex", exact);
  const d = terrainGeometryData(f); let maxDiff = 0, n = 0;
  for (let q = 0; q < 400; q++) { const x = f.bounds.minX + ((q * 0.6180339887) % 1) * (f.bounds.maxX - f.bounds.minX), z = f.bounds.minZ + ((q * 0.7548776662) % 1) * (f.bounds.maxZ - f.bounds.minZ); const m = meshHeight(d, x, z); if (!Number.isNaN(m)) { maxDiff = Math.max(maxDiff, Math.abs(m - f.heightAt(x, z))); n++; } }
  check("flight ground equals the drawn mesh surface at 400 arbitrary points (independent triangle search)", n === 400 && maxDiff < 1e-3, `max diff ${maxDiff.toExponential(2)} m`);
  const idx = terrainIndices(f.nx, f.ny); check("mesh indices come from the same function the sampler's triangles assume", idx.length === 40 * 40 * 6 && d.indices.length === idx.length && d.indices.every((v, i) => v === idx[i]));

  // 海・湖は水面0 m。陸の負値は0に切り、数を残す。範囲外は0 mで水ではない
  let seaV = -1, landV = -1; for (let v = 0; v < f.heights.length; v++) { if (f.water[v] && seaV < 0) seaV = v; if (!f.water[v] && landV < 0 && f.heights[v] > 50) landV = v; }
  const sx = f.x0 + (seaV % f.nx) * f.spacing, sz = f.z0 + Math.floor(seaV / f.nx) * f.spacing, lx = f.x0 + (landV % f.nx) * f.spacing, lz = f.z0 + Math.floor(landV / f.nx) * f.spacing;
  check("sea vertex: height 0 and water; inland vertex: not water", f.heightAt(sx, sz) === 0 && f.waterAt(sx, sz) && !f.waterAt(lx, lz) && f.heightAt(lx, lz) > 50);
  check("outside the region: ground 0 m, not water, not inside", !f.inside(f.bounds.minX - 1, 0) && f.heightAt(f.bounds.minX - 1000, 0) === 0 && !f.waterAt(f.bounds.minX - 1000, 0));

  // 尺度は明示。実寸では倍率が20倍になり、同じ標高は同じ実標高に戻る
  const f1 = buildTerrainField(region, REGION_SCALES[1]), t1 = regionTransform(region, REGION_SCALES[1]);
  check("1:1 scale: spacing 5000 m, highest 3776 m, heightToReal returns the original metres", f1.spacing === 5000 && Math.abs(Math.max(...f1.heights) - 3776) < 0.01 && Math.abs(t1.heightToReal(t1.heightToVind(1234)) - 1234) < 1e-9);
  check("every scale carries a reason shown on screen", REGION_SCALES.every(s => s.reason.length > 20 && s.label.length > 0));

  // 入力は補正せず、日本語で拒否する
  const bad = (mut: (o: any) => void) => { const o = JSON.parse(text); mut(o); try { parseRegionText(JSON.stringify(o)); return ""; } catch (e) { return (e as Error).message; } };
  let msg = ""; try { parseRegionText("not json{"); } catch (e) { msg = (e as Error).message; }
  check("broken JSON: Japanese message", msg.includes("JSONとして読めません"), msg);
  check("wrong format string is rejected (not silently accepted)", bad(o => { o.format = "kfm.region.v2"; }).includes("kfm.region.v1 の形式ではありません"));
  check("land value outside 0/1/2 is rejected, not clamped", bad(o => { o.grid.land = Buffer.from([1, 1, 1, 3]).toString("base64"); o.grid.nx = 2; o.grid.ny = 2; o.grid.elevM = Buffer.alloc(8).toString("base64"); }).includes("土地区分"));
  check("length mismatch is rejected", bad(o => { o.grid.nx = 40; }).includes("長さ"));
  check("negative or zero cell size is rejected", bad(o => { o.grid.cellKm = 0; }).includes("格子"));

  // 飛行: 同じ地形の上で、地面を突き抜けない・斜面に当たる・水面に降りられる
  const world = { colliders: [] as never[], heightAt: f.heightAt, waterAt: f.waterAt };
  const fl = new Flight(world), sp = pickSpawn(region, f); setFlightLimits(fl, f);
  fl.reset(); fl.pos.set(sp.x, f.heightAt(sp.x, sp.z) + 30, sp.z); fl.prevPos.copy(fl.pos); fl.yaw = 0; fl.pitch = 0.05; fl.vel.set(0, 0, -12);
  let under = 0; const inp = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
  for (let s = 0; s < 60 * 60; s++) { fl.step(1 / 60, inp); const feet = fl.pos.y - PHYS.feetOffset; if (feet < f.heightAt(fl.pos.x, fl.pos.z) - 0.05) under++; }
  check("free flight 60 s from the spawn (Tokyo): never below the shared ground height", under === 0, `landed/crashed mode ${fl.mode}`);
  // Fuji(最高点)へ向けて低空を飛ぶと、斜面で止まる
  let hv = 0; for (let v = 1; v < f.heights.length; v++) if (f.heights[v] > f.heights[hv]) hv = v;
  const px = f.x0 + (hv % f.nx) * f.spacing, pz = f.z0 + Math.floor(hv / f.nx) * f.spacing, f2 = new Flight(world); f2.reset();
  const sx0 = px - 1500, sz0 = pz; f2.pos.set(sx0, f.heightAt(sx0, sz0) + 12, sz0); f2.prevPos.copy(f2.pos); f2.yaw = -Math.PI / 2; f2.pitch = 0; f2.vel.set(14, 0, 0); // 東向き(+x)にFujiへ
  let stopped = -1, under2 = 0; for (let s = 0; s < 60 * 120; s++) { f2.step(1 / 60, inp); if (f2.pos.y - PHYS.feetOffset < f.heightAt(f2.pos.x, f2.pos.z) - 0.05) under2++; if (stopped < 0 && (f2.mode !== "air" || f2.stun > 0)) stopped = s; }
  check("flying low toward the highest peak ends in contact with the slope (no pass-through)", under2 === 0 && stopped >= 0, `contact at step ${stopped}`);
  // 水面へ降りる: 周囲8頂点もすべて水の頂点の真上から、ほぼ垂直に降りると着地(水面=0 m)
  let wv = -1; for (let k = 2; k < f.ny - 2 && wv < 0; k++) for (let i = 2; i < f.nx - 2 && wv < 0; i++) { let all = true; for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) if (!f.water[(k + dk) * f.nx + i + di]) all = false; if (all) wv = k * f.nx + i; }
  const wx = f.x0 + (wv % f.nx) * f.spacing, wz = f.z0 + Math.floor(wv / f.nx) * f.spacing;
  const f3 = new Flight(world); setFlightLimits(f3, f); f3.reset(); f3.pos.set(wx, 6, wz); f3.prevPos.copy(f3.pos); f3.yaw = 0; f3.pitch = -0.2; f3.vel.set(0, -1, -2);
  for (let s = 0; s < 60 * 20; s++) f3.step(1 / 60, inp);
  check("descending over the sea settles on the water surface (ground 0 m, water flagged)", f3.mode !== "air" && Math.abs(f3.pos.y - PHYS.feetOffset) < 0.2 && f.waterAt(f3.pos.x, f3.pos.z), `mode ${f3.mode}, y ${f3.pos.y.toFixed(2)}`);
}
