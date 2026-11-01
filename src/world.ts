import * as THREE from "three";
import type { SeasonLook } from "./season";
import { generateLayout, Layout, PADDY, PITCH, ROAD, LOT, LOT_TOP, HOUSE_W, HOUSE_D, FLOOR_H, houseHeight, APT_W, APT_D } from "./layout";

export interface PaddyLook { growth: number; rice: number; water: number; waterColor?: number }
export interface World extends Layout { setSeason(k: SeasonLook, daylight?: number): void; setPaddyLook(p: PaddyLook): void; group: THREE.Group; clouds: THREE.Group; setLights(level: number): void; lightsLevel(): number; updateLOD(x: number, z: number, force?: boolean): void; lodCounts(): { near: number; far: number } }

/** 4x4窓タイルのテクスチャ(色)と、点灯している窓だけを光らせる発光マップ */
function wallTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const T = 64, N = 4;
  const mk = () => { const c = document.createElement("canvas"); c.width = c.height = T * N; return c; };
  const cm = mk(), ce = mk(), g = cm.getContext("2d")!, e = ce.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, T * N, T * N); e.fillStyle = "#000"; e.fillRect(0, 0, T * N, T * N);
  let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = i * T, y = j * T;
    g.fillStyle = "#e4e4e4"; g.fillRect(x, y + 54, T, 10);
    g.fillStyle = "#cfcfcf"; g.fillRect(x + 10, y + 11, 44, 38);
    g.fillStyle = "#6f8aa3"; g.fillRect(x + 13, y + 14, 38, 32);
    g.fillStyle = "#9db6cc"; g.fillRect(x + 13, y + 14, 38, 10);
    g.fillStyle = "#cfcfcf"; g.fillRect(x + 31, y + 14, 2, 32);
    if (rnd() < 0.45) { e.fillStyle = rnd() < 0.5 ? "#ffd79a" : "#fff1d0"; e.fillRect(x + 13, y + 14, 38, 32); }
  }
  const fin = (c: HTMLCanvasElement, srgb: boolean) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 2; return t; };
  return { map: fin(cm, true), emissive: fin(ce, true) };
}

/** 地面の細かい模様。急降下で地面が流れて見える手がかり(オプティカルフロー)になる */
function speckle(repU: number, repV: number, base: string, amp = 26): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d")!;
  g.fillStyle = base; g.fillRect(0, 0, 128, 128);
  let seed = 3; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 700; i++) { const v = Math.round((r() - 0.5) * amp); g.fillStyle = v > 0 ? `rgba(255,255,255,${v / 90})` : `rgba(0,0,0,${-v / 90})`; g.fillRect(r() * 128, r() * 128, 1 + r() * 3, 1 + r() * 3); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repU, repV); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 2; return t;
}

/** 窓の繰り返しが実寸になるよう、箱の側面UVを寸法に合わせて伸ばす。底面は原点。 */
function buildingBox(w: number, h: number, d: number, tileW: number, tileH: number) {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4);
    if (face === 0 || face === 1) uv.setXY(i, uv.getX(i) * d / tileW, uv.getY(i) * h / tileH);
    else if (face === 4 || face === 5) uv.setXY(i, uv.getX(i) * w / tileW, uv.getY(i) * h / tileH);
  }
  return g;
}

function inst(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], items: { x: number; y: number; z: number; ry?: number; sx?: number; sy?: number; sz?: number; color?: number }[]) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
  m.count = items.length;
  const o = new THREE.Object3D(), c = new THREE.Color();
  items.forEach((it, i) => {
    o.position.set(it.x, it.y, it.z); o.rotation.set(0, it.ry ?? 0, 0); o.scale.set(it.sx ?? 1, it.sy ?? 1, it.sz ?? 1);
    o.updateMatrix(); m.setMatrixAt(i, o.matrix);
    if (it.color !== undefined) m.setColorAt(i, c.setHex(it.color));
  });
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.frustumCulled = false;
  return m;
}
const lam = (color: number, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, ...extra });

export const GRASS_Y = -0.4;
export function buildWorld(): World {
  const L = generateLayout(7);
  const group = new THREE.Group();
  const EXT = 2 * 4 * PITCH; // 市街の全幅
  // 地面(草地) と道路
  /** 草地の面の高さ。道路(y=0)との差が小さいと、遠くで深度の精度が足りず草が道路に点々と透ける(z-fighting)。24bit深度・近面0.1では300m先の分解能が約5cmなので、それより十分離す */
  const grassMat = lam(0xffffff, { map: speckle(3000 / 8, 3000 / 8, "#7c9a5e", 40) }), grass = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), grassMat); grass.rotation.x = -Math.PI / 2; grass.position.y = GRASS_Y; group.add(grass);
  const asphaltTex = speckle(1, (EXT / 2 + 20) / 6, "#4a4d52", 30); asphaltTex.repeat.set(ROAD / 6, (EXT / 2 + 20) / 6);
  const asphalt = lam(0xffffff, { map: asphaltTex }), asphaltCross = lam(0xffffff, { map: asphaltTex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }); // 交差点: 2枚の道路面が同じ高さで重なるので、横の道路を常に手前に勝たせる
  for (const rd of L.roads) {
    for (const rot of [0, 1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(ROAD, EXT / 2 + 20), rot ? asphaltCross : asphalt);
      p.rotation.x = -Math.PI / 2; if (rot) p.rotation.z = Math.PI / 2;
      p.position.set(rot ? 0 : rd, 0, rot ? rd : 0); group.add(p);
    }
  }
  // 区画(歩道・敷地)
  const lotMat = lam(0xffffff, { map: speckle(LOT / 6, LOT / 6, "#a7a99f", 34) }), parkMat = lam(0xffffff, { map: speckle(LOT / 6, LOT / 6, "#6f9a52", 44) });
  const lotBox = new THREE.BoxGeometry(LOT, LOT_TOP, LOT), at = (l: { x: number; z: number }) => ({ x: l.x, y: LOT_TOP / 2, z: l.z });
  const soilMat = lam(0xffffff, { map: speckle(LOT / 6, LOT / 6, "#8a7554", 30) }), ridgeMat = lam(0xffffff, { map: speckle(LOT / 6, LOT / 6, "#86955a", 26) });
  group.add(inst(lotBox, lotMat, L.lots.filter(l => l.use === "town").map(at)), inst(lotBox, parkMat, L.lots.filter(l => l.use === "park").map(at)));
  group.add(inst(lotBox, soilMat, L.lots.filter(l => l.use === "vacant").map(at)), inst(lotBox, ridgeMat, L.lots.filter(l => l.use === "paddy").map(at)));
  const patchMat = lam(0xffffff), tuftMat = lam(0xffffff); let tuftMesh: THREE.InstancedMesh | null = null;
  // 空き地: 草むら(平たい緑の斑)と雑草の束。座標は区画ごとに決まった乱数で
  { let sd = 31; const rn = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296), patches: { x: number; y: number; z: number; sx: number; sz: number; color: number }[] = [], tufts: { x: number; y: number; z: number; ry: number; sy: number; color: number }[] = [];
    for (const l of L.lots.filter(q => q.use === "vacant")) {
      for (let k = 0; k < 14; k++) { const r = 1.5 + rn() * 3.2; patches.push({ x: l.x + (rn() - 0.5) * 40, y: LOT_TOP + 0.012, z: l.z + (rn() - 0.5) * 40, sx: r, sz: r * (0.6 + rn() * 0.5), color: rn() < 0.7 ? 0x6f9a4a : 0x8aa457 }); }
      for (let k = 0; k < 90; k++) tufts.push({ x: l.x + (rn() - 0.5) * 42, y: LOT_TOP, z: l.z + (rn() - 0.5) * 42, ry: rn() * 6, sy: 0.6 + rn() * 1.2, color: rn() < 0.5 ? 0x5f8a3c : 0x7a9a45 });
    }
    const disc = new THREE.CircleGeometry(1, 7); disc.rotateX(-Math.PI / 2);
    group.add(inst(disc, patchMat, patches));
    const tuft = new THREE.ConeGeometry(0.2, 0.7, 3, 1, true); tuft.translate(0, 0.35, 0);
    tuftMesh = inst(tuft, tuftMat, tufts); group.add(tuftMesh); }
  // 田んぼ: 3×3 の水面(あぜで仕切る)と、その上の稲。稲と水は setPaddyLook で季節に合わせて変える
  const e = LOT / 2 - PADDY.border, cell = (2 * e - 2 * PADDY.ridge) / PADDY.plots, pr = cell / 2 + PADDY.ridge / 2;
  const waterMat = new THREE.MeshLambertMaterial({ color: 0x6f93a8, transparent: true, opacity: 0.85, depthWrite: false }), waterGeo = new THREE.PlaneGeometry(cell, cell); waterGeo.rotateX(-Math.PI / 2);
  const plots: { x: number; y: number; z: number }[] = [], rice: { x: number; y: number; z: number; ry: number; sy: number }[] = []; let sd2 = 77; const rn2 = () => ((sd2 = (sd2 * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const l of L.lots.filter(q => q.use === "paddy")) for (const ix of [-1, 0, 1]) for (const iz of [-1, 0, 1]) {
    const px = l.x + ix * 2 * pr, pz = l.z + iz * 2 * pr; plots.push({ x: px, y: LOT_TOP + 0.014, z: pz });
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) rice.push({ x: px + (a - 2.5) * (cell / 6) + (rn2() - 0.5) * 0.6, y: LOT_TOP, z: pz + (b - 2.5) * (cell / 6) + (rn2() - 0.5) * 0.6, ry: rn2() * 6, sy: 0.85 + rn2() * 0.3 });
  }
  const waterMesh = inst(waterGeo, waterMat, plots); waterMesh.renderOrder = 1; group.add(waterMesh);
  const riceGeo = new THREE.ConeGeometry(0.2, 0.9, 3, 1, true); riceGeo.translate(0, 0.45, 0); // 稲は三角の筒(3枚)で足りる
  const riceMat = lam(0x6fae4a), riceMesh = inst(riceGeo, riceMat, rice); riceMesh.scale.y = 0.8; group.add(riceMesh);
  const setPaddyLook = (p: PaddyLook) => { riceMesh.scale.set(1, Math.max(0.02, p.growth), 1); riceMesh.visible = p.growth > 0.03; riceMat.color.setHex(p.rice); waterMat.opacity = p.water; waterMesh.visible = p.water > 0.02; if (p.waterColor !== undefined) waterMat.color.setHex(p.waterColor); };
  // 道路標示
  const mark = lam(0xe9e9e4, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const dashes: { x: number; y: number; z: number; ry?: number }[] = [], stripes: typeof dashes = [];
  const near = (v: number) => L.roads.some(r => Math.abs(v - r) < 8);
  for (const rd of L.roads) for (let p = -EXT / 2 + 3; p < EXT / 2; p += 6) {
    if (near(p)) continue;
    dashes.push({ x: rd, y: 0.03, z: p }); dashes.push({ x: p, y: 0.03, z: rd, ry: Math.PI / 2 });
  }
  for (const a of L.roads) for (const b of L.roads) for (const s of [-1, 1]) {
    for (let k = -3; k <= 3; k++) {
      const off = 7 * s; // 交差点の四方に横断歩道
      stripes.push({ x: a + k * 1.3, y: 0.03, z: b + off });
      stripes.push({ x: a + off, y: 0.03, z: b + k * 1.3, ry: Math.PI / 2 });
    }
  }
  const flat = (w: number, d: number) => { const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); return g; };
  group.add(inst(flat(0.25, 3), mark, dashes), inst(flat(0.7, 3.4), mark, stripes));

  // 建物
  const wall = wallTextures();
  const side = lam(0xffffff, { map: wall.map, emissiveMap: wall.emissive, emissive: 0xffffff, emissiveIntensity: 0 }), roofFlat = lam(0x9a9ca2), under = lam(0x777777);
  const bm = [side, side, roofFlat, under, side, side];
  const houseGeo = (fl: number) => buildingBox(HOUSE_W, houseHeight(fl), HOUSE_D, 3.3 * 4, 3.1 * 4);
  for (const fl of [1, 2] as const) for (const rot of [0, Math.PI / 2]) {
    const list = L.houses.filter(h => h.floors === fl && h.ry === rot);
    group.add(inst(houseGeo(fl), bm, list.map(h => ({ x: h.x, y: 0, z: h.z, ry: h.ry, color: h.wall }))));
  }
  const roofGeo = new THREE.ConeGeometry(0.7071, 0.9, 4); roofGeo.rotateY(Math.PI / 4); roofGeo.translate(0, 0.45, 0);
  const roofConeMat = lam(0xffffff);
  for (const rot of [0, Math.PI / 2]) {
    const hs = L.houses.filter(h => h.ry === rot);
    group.add(inst(roofGeo, roofConeMat, hs.map(h => ({ x: h.x, y: houseHeight(h.floors), z: h.z, ry: h.ry, sx: HOUSE_W + 1.4, sy: 1, sz: HOUSE_D + 1.4, color: h.roof }))));
  }
  const floorsSet = [...new Set(L.apts.map(a => a.floors))];
  for (const fl of floorsSet) {
    group.add(inst(buildingBox(APT_W, fl * FLOOR_H, APT_D, 3.5 * 4, FLOOR_H * 4), bm, L.apts.filter(a => a.floors === fl).map(a => ({ x: a.x, y: 0, z: a.z, color: a.wall }))));
  }
  const tankMat = lam(0xb9bcc0); group.add(inst(new THREE.BoxGeometry(5, 2.2, 5), tankMat, L.tanks.map(t => ({ x: t.x, y: t.y + 1.1, z: t.z }))));

  // 低い障害物と、止まれる構造物・自然物(ベンチ・塀・植え込み・ベランダ・手すり・柵・看板・岩・木の枝)。種類ごとに1つのInstancedMesh
  const lowCol = { bench: 0x8a5a3a, wall: 0xc9c3b4, planter: 0x6f7f5a, balcony: 0xd6d0c4, rail: 0x4a4d52, fence: 0x7a6a55, sign: 0xe8e3d0, rock: 0x8b8982, branch: 0x6b4f3a };
  const unit = new THREE.BoxGeometry(1, 1, 1);
  for (const k of ["bench", "wall", "planter"] as const) {
    group.add(inst(unit, lam(lowCol[k]), L.lows.filter(l => l.kind === k).map(l => ({ x: l.x, y: l.top / 2, z: l.z, sx: l.hw * 2, sy: l.top, sz: l.hd * 2 }))));
  }
  const of = (k: string) => L.lows.filter(l => l.kind === k);
  group.add(inst(unit, lam(lowCol.balcony), of("balcony").map(l => ({ x: l.x, y: l.top - 0.1, z: l.z, sx: l.hw * 2, sy: 0.2, sz: l.hd * 2 }))));   // ベランダ: 床板
  group.add(inst(unit, lam(lowCol.rail), of("rail").map(l => ({ x: l.x, y: l.top - 0.45, z: l.z, sx: l.hw * 2, sy: 0.9, sz: l.hd * 2 }))));          // 手すり
  group.add(inst(unit, lam(lowCol.fence), of("fence").map(l => ({ x: l.x, y: l.top / 2, z: l.z, sx: l.hw * 2, sy: l.top, sz: l.hd * 2 }))));       // 柵
  group.add(inst(unit, lam(lowCol.sign), of("sign").map(l => ({ x: l.x, y: l.top - 0.35, z: l.z, sx: l.hw * 2, sy: 0.7, sz: l.hd * 2 }))));         // 看板の板
  group.add(inst(unit, lam(0x55575c), of("sign").map(l => ({ x: l.x, y: (l.top - 0.7) / 2, z: l.z, sx: 0.1, sy: l.top - 0.7, sz: 0.1 }))));        // 看板の支柱
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  group.add(inst(rockGeo, lam(lowCol.rock), of("rock").map((l, i) => ({ x: l.x, y: l.top * 0.45, z: l.z, ry: i * 1.7, sx: l.hw * 1.15, sy: l.top * 0.62, sz: l.hd * 1.15 }))));
  const branchGeo = new THREE.CylinderGeometry(0.11, 0.15, 1.8, 6); branchGeo.rotateZ(Math.PI / 2);
  group.add(inst(branchGeo, lam(lowCol.branch), of("branch").map(l => ({ x: l.x, y: l.top - 0.12, z: l.z }))));
  group.add(inst(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 6), lam(0x6d665c), of("pole").map(l => ({ x: l.x, y: l.top + 0.06, z: l.z })))); // 電柱の頭
  // 街路樹
  const trunk = new THREE.CylinderGeometry(0.15, 0.22, 2.4, 5); trunk.translate(0, 1.2, 0);
  const greens = [0x4f8a3f, 0x5d9645, 0x3f7a3a, 0x6aa34d];
  group.add(inst(trunk, lam(0x6b4f3a), L.trees.map(t => ({ x: t.x, y: LOT_TOP, z: t.z, sx: t.s * 0.8, sy: t.s * 0.9, sz: t.s * 0.8 }))));
  // 樹冠は距離でLOD: 近く(<LOD_NEAR)は細かい形、遠くは粗い形。プレイヤーが動いたときだけ再配分する。
  const NT = L.trees.length, tm = new Float32Array(NT * 16), tc = new Float32Array(NT * 3), od = new THREE.Object3D(), col = new THREE.Color();
  L.trees.forEach((t, i) => {
    od.position.set(t.x, LOT_TOP + 2.4 * t.s * 0.9 + t.s * 1.2, t.z); od.rotation.set(0, 0, 0); od.scale.set(t.s * 1.6, t.s * 1.5, t.s * 1.6); od.updateMatrix();
    od.matrix.toArray(tm, i * 16); col.setHex(greens[Math.floor(t.tint * 4) % 4]).toArray(tc, i * 3);
  });
  const mkCrown = (detail: number) => { const m = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, detail), lam(0xffffff), Math.max(1, NT)); m.count = 0; m.frustumCulled = false; m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(NT * 3), 3); return m; };
  const nearCrown = mkCrown(1), farCrown = mkCrown(0); group.add(nearCrown, farCrown);
  const LOD_NEAR = 80; let lodX = 1e9, lodZ = 1e9, nNear = 0, nFar = 0;
  const updateLOD = (x: number, z: number, force = false) => {
    if (!force && Math.hypot(x - lodX, z - lodZ) < 10) return; lodX = x; lodZ = z;
    let a = 0, b = 0;
    for (let i = 0; i < NT; i++) {
      const tdx = L.trees[i].x - x, tdz = L.trees[i].z - z, near = tdx * tdx + tdz * tdz < LOD_NEAR * LOD_NEAR, m = near ? nearCrown : farCrown, k = near ? a++ : b++;
      const ma = m.instanceMatrix.array as Float32Array, ca = m.instanceColor!.array as Float32Array; // subarray は呼び出しごとに配列ビューを作るため手で複写
      for (let j = 0; j < 16; j++) ma[k * 16 + j] = tm[i * 16 + j];
      ca[k * 3] = tc[i * 3]; ca[k * 3 + 1] = tc[i * 3 + 1]; ca[k * 3 + 2] = tc[i * 3 + 2];
    }
    nearCrown.count = nNear = a; farCrown.count = nFar = b;
    for (const m of [nearCrown, farCrown]) { m.instanceMatrix.needsUpdate = true; m.instanceColor!.needsUpdate = true; }
  };
  updateLOD(0, 0, true);

  // 電柱と電線
  const pole = new THREE.CylinderGeometry(0.12, 0.16, 9, 6); pole.translate(0, 4.5, 0);
  const arm = new THREE.BoxGeometry(2.2, 0.12, 0.12); arm.translate(0, 8.3, 0);
  group.add(inst(pole, lam(0x8c8579), L.poles.map(p => ({ x: p.x, y: 0, z: p.z }))), inst(arm, lam(0x6d665c), L.poles.map(p => ({ x: p.x, y: 0, z: p.z }))));
  const lampMat = new THREE.MeshBasicMaterial({ color: 0x777777 });
  group.add(inst(new THREE.SphereGeometry(0.3, 8, 6), lampMat, L.poles.filter((_, i) => i % 2 === 0).map(p => ({ x: p.x, y: 8.9, z: p.z }))));
  const pts: number[] = [], wp = { x: 0, y: 0, z: 0 }, wq = { x: 0, y: 0, z: 0 };
  for (let id = 0; id < L.wires.length; id++) for (let q = 0; q < 4; q++) {
    L.perchPoint(id, q / 4, wp); L.perchPoint(id, (q + 1) / 4, wq); pts.push(wp.x, wp.y, wp.z, wq.x, wq.y, wq.z);
  }
  const wg = new THREE.BufferGeometry(); wg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const wires = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x222222 })); wires.frustumCulled = false; group.add(wires);

  // 遠景の山
  const mtn = new THREE.ConeGeometry(1, 1, 6);
  const ms: Parameters<typeof inst>[2] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + (i % 3) * 0.1, rad = 650 + (i % 4) * 40, h = 90 + ((i * 37) % 70);
    ms.push({ x: Math.cos(a) * rad, y: h / 2 - 2, z: Math.sin(a) * rad, sx: 220 + (i % 5) * 40, sy: h, sz: 220 + (i % 3) * 50, color: i % 2 ? 0x5f7f78 : 0x6b8a82 });
  }
  group.add(inst(mtn, lam(0xffffff), ms));

  // 雲
  const clouds = new THREE.Group();
  const cm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, fog: false });
  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), cm);
    const a = i * 2.4; m.position.set(Math.cos(a) * (150 + (i % 5) * 70), 120 + (i % 4) * 14, Math.sin(a) * (150 + (i % 5) * 70));
    m.scale.set(40 + (i % 3) * 14, 7, 22 + (i % 4) * 6); clouds.add(m);
  }
  group.add(clouds);
  let lightsLv = 0;
  const setLights = (lv: number) => {
    lightsLv = lv;
    side.emissiveIntensity = 0.9 * lv;
    lampMat.color.setHex(0x777777).lerp(new THREE.Color(0xffd98a), lv);
  };
  // --- 季節: 色(材質の乗算)・積雪(発光で白く)・樹冠(色と葉の量)・田んぼ。毎フレームではなく、季節が少し進んだときだけ呼ぶ
  const snowMats: [THREE.MeshLambertMaterial, number][] = [[grassMat, 0.9], [lotMat as THREE.MeshLambertMaterial, 0.8], [parkMat as THREE.MeshLambertMaterial, 0.9], [soilMat as THREE.MeshLambertMaterial, 0.9], [ridgeMat as THREE.MeshLambertMaterial, 0.9], [asphalt as THREE.MeshLambertMaterial, 0.45], [roofFlat as THREE.MeshLambertMaterial, 0.8], [roofConeMat, 0.7], [tankMat, 0.5]];
  for (const [m] of snowMats) { m.emissive.setHex(0xffffff); m.emissiveIntensity = 0; }
  const setSeason = (k: SeasonLook, daylight = 1) => {
    for (const m of [grassMat, parkMat, ridgeMat] as THREE.MeshLambertMaterial[]) m.color.setHex(k.grassTint);
    patchMat.color.setHex(k.grassTint); tuftMat.color.setHex(k.weedTint); if (tuftMesh) tuftMesh.scale.y = k.weedScale;
    for (const [m, w] of snowMats) m.emissiveIntensity = k.snow * w * 1.0 * Math.max(0.12, daylight); // 夜は雪も暗く
    const pink = new THREE.Color(0xf7b9cf), c = new THREE.Color();
    L.trees.forEach((t, i) => {
      c.setHex(k.leaf).offsetHSL(0, 0, (t.tint - 0.5) * 0.16); if (t.tint < 0.4) c.lerp(pink, k.blossom); c.toArray(tc, i * 3);
      const sc = k.leafAmount; od.position.set(t.x, LOT_TOP + 2.4 * t.s * 0.9 + t.s * 1.2, t.z); od.rotation.set(0, 0, 0); od.scale.set(t.s * 1.6 * sc, t.s * 1.5 * sc, t.s * 1.6 * sc); od.updateMatrix(); od.matrix.toArray(tm, i * 16);
    });
    updateLOD(lodX, lodZ, true);
    setPaddyLook(k.paddy);
  };
  return Object.assign(L, { setSeason, setPaddyLook, group, clouds, setLights, lightsLevel: () => lightsLv, updateLOD, lodCounts: () => ({ near: nNear, far: nFar }) }) as World;
}
