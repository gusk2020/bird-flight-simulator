import { Layout, ROAD } from "./layout";

/**
 * 動いている街: NPC鳥・歩行者・自動車の軽量な自律行動 (描画に依存しない)。
 * 方針: 世界全体を常時計算せず、プレイヤー周辺だけを詳細に更新する。遠くの個体は低頻度更新、離れすぎたらプレイヤー近くへ再配置する。
 */
export interface Player { x: number; y: number; z: number; speed: number; yaw: number; air: boolean }
export interface Density { birds: number; peds: number; cars: number }
export const DENSITY: Density[] = [{ birds: 0, peds: 0, cars: 0 }, { birds: 4, peds: 12, cars: 5 }, { birds: 8, peds: 24, cars: 10 }, { birds: 14, peds: 40, cars: 16 }];
/** 時間帯による活動量 0..1 (人・車)。夜は少なく、朝夕は多い。 */
export function activity(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const pts: [number, number][] = [[0, 0.2], [5, 0.25], [7, 0.8], [9, 1], [16, 1], [18, 0.9], [21, 0.5], [24, 0.2]];
  for (let i = 0; i + 1 < pts.length; i++) if (h >= pts[i][0] && h <= pts[i + 1][0]) { const t = (h - pts[i][0]) / (pts[i + 1][0] - pts[i][0]); return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t; }
  return 1;
}

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrapAng = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const dist2 = (ax: number, az: number, bx: number, bz: number) => { const dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); };

// ---------------------------------------------------------------- 鳥
export type BirdKind = "pigeon" | "sparrow" | "crow";
export interface NpcBird {
  kind: BirdKind; x: number; y: number; z: number; yaw: number; speed: number;
  state: "perch" | "ground" | "fly"; timer: number; tx: number; ty: number; tz: number; cruise: number; land: "wire" | "roof" | "ground";
  flock: number; leader: boolean; delay: number; phase: number; walkV: number; acc: number; scale: number; active: boolean;
}
const KIND = { pigeon: { v: 9, flap: 9, scale: 1 }, sparrow: { v: 7.5, flap: 16, scale: 0.55 }, crow: { v: 8.5, flap: 5.5, scale: 1.4 } };

// ---------------------------------------------------------------- 歩行者・車
export interface Ped { lx: number; lz: number; s: number; dir: 1 | -1; v: number; pause: number; react: number; flee: number; x: number; z: number; yaw: number; hue: number; phase: number; active: boolean; walking: boolean; on: boolean }
export interface Car { axis: "x" | "z"; dir: 1 | -1; road: number; pos: number; v: number; x: number; z: number; yaw: number; color: number; turn: null | { p0: [number, number]; p1: [number, number]; p2: [number, number]; t: number; len: number; nAxis: "x" | "z"; nDir: 1 | -1; nRoad: number }; active: boolean; turns: number; waiting: boolean; on: boolean }
export const CAR_LEN = 4.2, LANE = 2.5, SIDEWALK_HALF = 22, SIGNAL_CYCLE = 18;
/** 信号: 'x'方向(東西)が先に青 */
export function signal(axis: "x" | "z", clock: number): "green" | "yellow" | "red" {
  const ph = ((clock % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE, own = axis === "x" ? ph : (ph + 9) % SIGNAL_CYCLE;
  return own < 6.5 ? "green" : own < 8 ? "yellow" : "red";
}
const RP = { x: 0, z: 0, yaw: 0 }; // 結果の使い回し(毎回タプルを作らない)。呼び出し側はすぐ読み出すこと
const ringPos = (s: number, H = SIDEWALK_HALF) => { // 周回路 s → x,z と進行方向yaw
  const P = 8 * H; s = ((s % P) + P) % P; const side = Math.floor(s / (2 * H)), u = s - side * 2 * H;
  switch (side) { case 0: RP.x = -H + u; RP.z = -H; RP.yaw = -Math.PI / 2; break; case 1: RP.x = H; RP.z = -H + u; RP.yaw = Math.PI; break; case 2: RP.x = H - u; RP.z = H; RP.yaw = Math.PI / 2; break; default: RP.x = -H; RP.z = H - u; RP.yaw = 0; }
  return RP;
};

export class NpcWorld {
  /** 季節による行動の偏り(1=変化なし)。控えめな値だけ。setSeasonBias で更新 */
  bias = { ground: 1, roof: 1, forage: 1 };
  setSeasonBias(b: { ground: number; roof: number; forage: number }) { this.bias.ground = b.ground; this.bias.roof = b.roof; this.bias.forage = b.forage; }
  birds: NpcBird[] = []; peds: Ped[] = []; cars: Car[] = []; clock = 0; level = 0; stats = { turns: 0, flights: 0, landings: 0, flees: 0, escorts: 0 };
  private r: () => number; private lotCells: { x: number; z: number }[] = []; private roofs: { x0: number; x1: number; z0: number; z1: number; top: number }[] = [];
  private escortT = 0; private escort = false;
  constructor(private L: Layout, seed = 1, private density: Density[] = DENSITY) {
    this.r = rng(seed);
    for (const l of L.lots) this.lotCells.push({ x: l.x, z: l.z });
    for (const c of L.colliders) if (c.top >= 3 && c.maxX - c.minX > 3 && c.maxZ - c.minZ > 3) this.roofs.push({ x0: c.minX + 0.8, x1: c.maxX - 0.8, z0: c.minZ + 0.8, z1: c.maxZ - 0.8, top: c.top });
  }

  /** 設定レベル(0..3)に合わせて個体数を調整。増える分は初期位置を作り、減る分は不活性にする。 */
  setLevel(level: number, p: Player) {
    this.level = level; const d = this.density[level];
    while (this.birds.length < d.birds) this.spawnBird(p, this.birds.length);
    while (this.peds.length < d.peds) this.spawnPed(p);
    while (this.cars.length < d.cars) this.spawnCar(p);
    this.birds.forEach((b, i) => b.active = i < d.birds); this.peds.forEach((q, i) => q.active = i < d.peds); this.cars.forEach((c, i) => c.active = i < d.cars);
  }
  activeCounts() { return { birds: this.birds.filter(b => b.active).length, peds: this.peds.filter(b => b.active).length, cars: this.cars.filter(b => b.active).length }; }

  update(dt: number, p: Player, hour: number) {
    dt = Math.min(dt, 0.1); this.clock += dt; const act = activity(hour);
    // プレイヤーが群れに混ざる(参加)/離れる(離脱)
    this.updateEscort(dt, p);
    const nPeds = Math.round(this.density[this.level].peds * act), nCars = Math.round(this.density[this.level].cars * act);
    let pi = 0, ci = 0; this.vp.length = 0; this.vc.length = 0;
    for (const b of this.birds) if (b.active) this.updateBird(b, dt, p);
    for (let i = 0; i < this.peds.length; i++) { const q = this.peds[i]; q.on = i < this.density[this.level].peds && pi++ < nPeds; if (q.on) { this.updatePed(q, dt, p); this.vp.push(q); } }
    for (let i = 0; i < this.cars.length; i++) { const c = this.cars[i]; c.on = i < this.density[this.level].cars && ci++ < nCars; if (c.on) { this.updateCar(c, dt, p); this.vc.push(c); } }
  }
  /** 現在表示すべき(活動中の)歩行者/車 */
  /** 直近の update() で活動中だった歩行者/車(毎フレーム配列を作らず使い回す) */
  visiblePeds() { return this.vp; }
  visibleCars() { return this.vc; }
  private vp: Ped[] = []; private vc: Car[] = [];

  // ------------------------------------------------------------ 鳥
  private spotFor(kind: BirdKind, near?: { x: number; z: number }): { x: number; y: number; z: number; land: NpcBird["land"] } {
    const r = this.r, roll = r(), bw = kind === "pigeon" ? [0.5, 0.3] : kind === "sparrow" ? [0.3, 0.1] : [0.2, 0.5], w = [Math.min(0.85, bw[0] * this.bias.ground), bw[1] * this.bias.roof]; // 地面/屋根の確率、残りは電線
    for (let tries = 0; tries < 12; tries++) {
      let s: { x: number; y: number; z: number; land: NpcBird["land"] };
      if (roll < w[0]) { const l = this.lotCells[Math.floor(r() * this.lotCells.length)], px = l.x + (r() - 0.5) * 40, pz = l.z + (r() - 0.5) * 40, gy = this.L.heightAt(px, pz); if (gy > 0.2 || this.L.waterAt(px, pz) || [[3, 0], [-3, 0], [0, 3], [0, -3]].some(([ox, oz]) => this.L.heightAt(px + ox, pz + oz) > 0.2)) continue; const gk = this.L.groundAt(px, pz); if (gk === "paved" ? r() < (this.bias.forage - 1) * 1.2 : r() < 1 - this.bias.forage) continue; /* 季節: 春・秋は草地・土・あぜへ、冬は少なめ */ s = { x: px, y: gy, z: pz, land: "ground" }; }
      else if (roll < w[0] + w[1]) { const q = this.roofs[Math.floor(r() * this.roofs.length)]; const px = q.x0 + r() * Math.max(0, q.x1 - q.x0), pz = q.z0 + r() * Math.max(0, q.z1 - q.z0); s = { x: px, y: this.L.heightAt(px, pz), z: pz, land: "roof" }; }
      else { const id = Math.floor(r() * this.L.wires.length), t = 0.12 + r() * 0.76, o = { x: 0, y: 0, z: 0 }; this.L.perchPoint(id, t, o); if ([[4, 0], [-4, 0], [0, 4], [0, -4], [3, 3], [-3, 3], [3, -3], [-3, -3]].some(([ox, oz]) => this.L.heightAt(o.x + ox, o.z + oz) > o.y - 0.5)) continue; s = { x: o.x, y: o.y, z: o.z, land: "wire" }; }
      if (!near || dist2(s.x, s.z, near.x, near.z) < 140) return s;
    }
    return { x: near ? near.x : 0, y: 0, z: near ? near.z : 0, land: "ground" };
  }
  private spawnBird(p: Player, i: number) {
    const r = this.r, kind: BirdKind = i % 4 === 3 ? "crow" : i % 4 === 2 ? "sparrow" : "pigeon", s = this.spotFor(kind, p), k = KIND[kind];
    const flockId = kind === "pigeon" ? Math.floor(i / 4) : -1, leaderOfFlock = kind === "pigeon" && i % 4 === 0;
    const b: NpcBird = { kind, x: s.x + (r() - 0.5) * 2, y: s.y, z: s.z + (r() - 0.5) * 2, yaw: r() * 6.28, speed: 0, state: s.land === "ground" ? "ground" : "perch", timer: 3 + r() * 10, tx: s.x, ty: s.y, tz: s.z, cruise: 12, land: s.land,
      flock: flockId, leader: leaderOfFlock, delay: 0, phase: r() * 6.28, walkV: 0, acc: 0, scale: k.scale, active: true };
    if (!leaderOfFlock && flockId >= 0) { const ld = this.leaderOf(flockId); if (ld) { b.x = ld.x + (r() - 0.5) * 3; b.z = ld.z + (r() - 0.5) * 3; b.y = this.L.heightAt(b.x, b.z); b.land = "ground"; b.state = "ground"; b.tx = b.x; b.ty = b.y; b.tz = b.z; } }
    this.birds.push(b);
  }
  private startFlight(b: NpcBird, s: { x: number; y: number; z: number; land: NpcBird["land"] }) {
    b.tx = s.x; b.ty = s.y; b.tz = s.z; b.land = s.land; b.state = "fly"; this.stats.flights++;
    // 経路上の最も高い建物 + 余裕 を巡航高度にして、建物へ突っ込まない
    let top = 0; const n = Math.max(2, Math.ceil(dist2(b.x, b.z, s.x, s.z) / 1.5)); // 細い障害物(電柱の頭・手すり)を飛ばさない間隔
    for (let i = 0; i <= n; i++) { const t = i / n; top = Math.max(top, this.L.heightAt(b.x + (s.x - b.x) * t, b.z + (s.z - b.z) * t)); }
    b.cruise = Math.max(top + 3.5, Math.max(b.y, s.y) + 4 + this.r() * 5, 9);
    b.speed = Math.max(b.speed, 3);
  }
  private fs: NpcBird[] = [];
  /** 同じ群れの他の活動中の個体(使い回し配列。呼び出しの入れ子は不可) */
  private freeFlock(b: NpcBird) { const o = this.fs; o.length = 0; for (let i = 0; i < this.birds.length; i++) { const q = this.birds[i]; if (q.flock === b.flock && q !== b && q.active) o.push(q); } return o; }
  private leaderOf(flock: number) { for (let i = 0; i < this.birds.length; i++) { const q = this.birds[i]; if (q.flock === flock && q.leader) return q; } return undefined; }
  private updateBird(b: NpcBird, dt: number, p: Player) {
    const d = dist2(b.x, b.z, p.x, p.z);
    if (d > 260) { this.relocateBird(b, p); return; }
    // 遠い個体は低頻度で更新(位置の積分は大きなdtでも安定な単純モデル)
    if (d > 90 && b.state !== "fly") { b.acc += dt; if (b.acc < 0.5) return; dt = b.acc; b.acc = 0; }
    const k = KIND[b.kind];
    if (b.state !== "fly") {
      b.timer -= dt; b.speed = 0;
      // 近づくと逃げる(プレイヤーが速い/飛んでいる/すぐ近く)
      if (d < (b.kind === "crow" ? 4 : 6) && (p.speed > 3 || (p.air && Math.abs(p.y - b.y) < 6)) && b.timer > 0.3) { b.timer = this.r() * 0.3; this.stats.flees++; if (b.flock >= 0) this.freeFlock(b).forEach(q => { if (q.state !== "fly") q.timer = Math.min(q.timer, this.r() * 0.4); }); }
      if (b.state === "ground") { // 地面ではときどき数歩歩く
        if (b.walkV > 0) { b.x += Math.sin(b.yaw) * -b.walkV * dt; b.z += -Math.cos(b.yaw) * b.walkV * dt; b.phase += b.walkV * dt * 4.5; b.y = this.L.heightAt(b.x, b.z); if (this.r() < dt * 0.8) b.walkV = 0; }
        else if (this.r() < dt * 0.25) { b.walkV = 0.7; b.yaw += (this.r() - 0.5) * 2; const nx = b.x - Math.sin(b.yaw) * 2, nz = b.z - Math.cos(b.yaw) * 2; if (this.L.heightAt(nx, nz) > this.L.heightAt(b.x, b.z) + 0.3) b.walkV = 0; }
      }
      if (b.timer <= 0 && !(b.flock >= 0 && !b.leader && b.delay > 0 && (b.delay -= dt) > 0)) {
        if (b.flock >= 0 && !b.leader) { const ld = this.leaderOf(b.flock); if (ld && ld.state === "fly") this.startFlight(b, { x: ld.tx + (this.r() - 0.5) * 3, y: this.L.heightAt(ld.tx, ld.tz), z: ld.tz + (this.r() - 0.5) * 3, land: "ground" }); else b.timer = 1; }
        else { const s = this.escort && b.leader ? this.escortTarget(p) : this.spotFor(b.kind, p); this.startFlight(b, s); if (b.leader) this.freeFlock(b).forEach(q => { if (q.state !== "fly") { q.timer = 0; q.delay = 0.1 + this.r() * 0.6; } }); }
      }
      return;
    }
    // 飛行: 目標へ旋回しながら進み、高度は巡航→降下
    const dx = b.tx - b.x, dz = b.tz - b.z, dh = Math.hypot(dx, dz), want = Math.atan2(-dx, -dz);
    b.yaw += clamp(wrapAng(want - b.yaw), -2.2 * dt, 2.2 * dt);
    const v = k.v * (b.leader && this.escort ? 1.1 : 1); b.speed += (v - b.speed) * Math.min(1, 2 * dt);
    // 前方の建物の上を越えられる高さがなければ、その場で上昇してから進む(壁へ突っ込まない)
    const ax = -Math.sin(b.yaw), az = -Math.cos(b.yaw);
    const hh = (x: number, z: number) => this.L.heightAt(x, z); // 旋回中でも側方の建物に入らないよう周囲1.5mも見る
    const ahead = dh > 3 ? Math.max(hh(b.x, b.z), hh(b.x + 1.5, b.z), hh(b.x - 1.5, b.z), hh(b.x, b.z + 1.5), hh(b.x, b.z - 1.5), this.L.heightAt(b.x + ax * 3, b.z + az * 3), this.L.heightAt(b.x + ax * 6, b.z + az * 6), this.L.heightAt(b.x + ax * 9, b.z + az * 9), this.L.heightAt(b.x + ax * 3 + az * 1.2, b.z + az * 3 - ax * 1.2), this.L.heightAt(b.x + ax * 3 - az * 1.2, b.z + az * 3 + ax * 1.2), this.L.heightAt(b.x + ax * 6 + az * 1.2, b.z + az * 6 - ax * 1.2), this.L.heightAt(b.x + ax * 6 - az * 1.2, b.z + az * 6 + ax * 1.2)) : 0;
    const blocked = dh > 3 && b.y < ahead + 1;
    if (!blocked) { b.x += ax * b.speed * dt; b.z += az * b.speed * dt; }
    b.phase += k.flap * dt;
    const glide = b.cruise - b.ty; let desired = dh < glide * 4 + 2 ? b.ty + Math.max(0, (dh - 0.6)) / 4 : b.cruise;
    if (dh > 3) desired = Math.max(desired, ahead + 1.2);
    b.y += clamp(desired - b.y, -4 * dt, 3.5 * dt);
    if (dh > 1.2) { const g = hh(b.x, b.z) + 0.3; if (b.y < g) b.y = g; } // 最後の安全策: 建物の中には入らない
    // 分離(群れの個体同士が重ならない)
    if (b.flock >= 0) for (const q of this.freeFlock(b)) { const ddx = b.x - q.x, ddz = b.z - q.z, dd = Math.hypot(ddx, ddz); if (dd < 1.4 && dd > 1e-3) { b.x += ddx / dd * 0.8 * dt; b.z += ddz / dd * 0.8 * dt; } }
    if (dh < 1.2 && Math.abs(b.y - b.ty) < 0.9) { // 着地
      b.x = b.tx; b.y = b.ty; b.z = b.tz; b.state = b.land === "ground" ? "ground" : "perch"; b.timer = 4 + this.r() * 12; b.speed = 0; b.walkV = 0; this.stats.landings++;
    }
  }
  private relocateBird(b: NpcBird, p: Player) { const s = this.spotFor(b.kind, p); b.x = s.x; b.y = s.y; b.z = s.z; b.tx = s.x; b.ty = s.y; b.tz = s.z; b.state = s.land === "ground" ? "ground" : "perch"; b.land = s.land; b.timer = 2 + this.r() * 8; b.speed = 0; }
  private escortTarget(p: Player) { const a = p.yaw; return { x: p.x - Math.sin(a) * 18, y: 0, z: p.z - Math.cos(a) * 18, land: "ground" as const }; }
  /** プレイヤーが群れの近くを同じ向きで飛び続けると群れが付いてくる。離れる/止まると離脱。 */
  private updateEscort(dt: number, p: Player) {
    const ld = this.leaderOf(0); if (!ld) return;
    let near = false;
    for (let i = 0; i < this.birds.length && !near; i++) { const b = this.birds[i]; near = b.active && b.flock === 0 && b.state === "fly" && dist2(b.x, b.z, p.x, p.z) < 10 && Math.abs(b.y - p.y) < 8; }
    const same = Math.cos(wrapAng(ld.yaw - p.yaw)) > 0.5;
    if (!this.escort) { this.escortT = p.air && p.speed > 4 && near && same ? this.escortT + dt : 0; if (this.escortT > 2) { this.escort = true; this.escortT = 0; this.stats.escorts++; } }
    else { const far = dist2(ld.x, ld.z, p.x, p.z) > 35, slow = !p.air || p.speed < 3; this.escortT = far || slow ? this.escortT + dt : 0; if (this.escortT > 1.5) { this.escort = false; this.escortT = 0; } }
  }
  get escorting() { return this.escort; }

  // ------------------------------------------------------------ 歩行者
  private spawnPed(p: Player) {
    const r = this.r, cells = this.lotCells.filter(l => dist2(l.x, l.z, p.x, p.z) < 140), l = (cells.length ? cells : this.lotCells)[Math.floor(r() * (cells.length || this.lotCells.length))];
    const q: Ped = { lx: l.x, lz: l.z, s: r() * 8 * SIDEWALK_HALF, dir: r() < 0.5 ? 1 : -1, v: 1.1 + r() * 0.5, pause: r() < 0.3 ? r() * 4 : 0, react: 0, flee: 0, x: 0, z: 0, yaw: 0, hue: r(), phase: r() * 6, active: true, walking: true, on: true };
    this.placePed(q); this.peds.push(q);
  }
  private placePed(q: Ped) { const r = ringPos(q.s); q.x = q.lx + r.x; q.z = q.lz + r.z; q.yaw = q.dir > 0 ? r.yaw : r.yaw + Math.PI; }
  private updatePed(q: Ped, dt: number, p: Player) {
    const d = dist2(q.x, q.z, p.x, p.z);
    if (d > 170) { const cells = this.lotCells.filter(l => { const dd = dist2(l.x, l.z, p.x, p.z); return dd > 20 && dd < 120; }), l = cells.length ? cells[Math.floor(this.r() * cells.length)] : this.lotCells[0]; q.lx = l.x; q.lz = l.z; q.s = this.r() * 8 * SIDEWALK_HALF; this.placePed(q); return; }
    if (q.react > 0) q.react -= dt; if (q.flee > 0) q.flee -= dt; if (q.pause > 0) q.pause -= dt;
    // 鳥への反応: 低く近いと立ち止まって見る。速く近づくと少し逃げる
    if (d < 5 && p.y < 3.5 && q.react <= 0 && q.flee <= 0) { if (p.speed > 6) { q.dir = (q.dir * -1) as 1 | -1; q.flee = 1.5; this.stats.flees++; } else { q.react = 1.5; q.pause = Math.max(q.pause, 1.5); } }
    const moving = q.pause <= 0; q.walking = moving;
    if (moving) { const v = q.flee > 0 ? 2.4 : q.v; q.s += q.dir * v * dt; q.phase += v * dt * 4; } else if (this.r() < dt * 0.05) q.pause = 1 + this.r() * 4;
    if (!moving && this.r() < dt * 0.1 && q.react <= 0) q.dir = (q.dir * -1) as 1 | -1;
    if (moving && this.r() < dt * 0.02) q.pause = 1.5 + this.r() * 5;
    this.placePed(q);
    if (q.react > 0) q.yaw = Math.atan2(-(p.x - q.x), -(p.z - q.z));
  }

  // ------------------------------------------------------------ 車
  private lane(axis: "x" | "z", dir: 1 | -1, road: number): { x: number; z: number } { // 左側通行
    return axis === "x" ? { x: 0, z: road + (dir > 0 ? -LANE : LANE) } : { x: road + (dir > 0 ? LANE : -LANE), z: 0 };
  }
  private spawnCar(p: Player) {
    const r = this.r, roads = this.L.roads;
    for (let tries = 0; tries < 30; tries++) {
      const axis: "x" | "z" = r() < 0.5 ? "x" : "z", dir: 1 | -1 = r() < 0.5 ? 1 : -1, road = roads[Math.floor(r() * roads.length)];
      const pc = axis === "x" ? p.x : p.z, pos = clamp(pc + (r() - 0.5) * 240, -190, 190);
      if (dist2(axis === "x" ? pos : road, axis === "x" ? road : pos, p.x, p.z) > 160 && tries < 20) continue;
      if (this.cars.some(c => c.axis === axis && c.dir === dir && c.road === road && Math.abs(c.pos - pos) < 12)) continue;
      if (roads.some(rc => Math.abs(pos - rc) < 22)) continue; // 交差点・曲がり出口の近くには出現させない
      const car: Car = { axis, dir, road, pos, v: 6 + r() * 4, x: 0, z: 0, yaw: 0, color: [0xd8d8d8, 0x2b3a55, 0xa23a3a, 0x3b3b3b, 0xe6e0c8, 0x5a7d5a, 0xc9a227][Math.floor(r() * 7)], turn: null, active: true, turns: 0, waiting: false, on: true };
      this.placeCar(car); this.cars.push(car); return;
    }
    const c: Car = { axis: "x", dir: 1, road: roads[0], pos: -190, v: 0, x: 0, z: 0, yaw: 0, color: 0x888888, turn: null, active: true, turns: 0, waiting: false, on: true }; this.placeCar(c); this.cars.push(c);
  }
  private placeCar(c: Car) {
    const ln = this.lane(c.axis, c.dir, c.road);
    if (c.axis === "x") { c.x = c.pos; c.z = ln.z; c.yaw = Math.atan2(-c.dir, 0); } else { c.x = ln.x; c.z = c.pos; c.yaw = Math.atan2(0, -c.dir); }
  }
  private respawnCar(c: Car, p: Player) {
    const tmp = this.cars.filter(q => q !== c); const keep = this.cars; this.cars = tmp; this.spawnCar(p); const n = this.cars.pop()!; this.cars = keep; Object.assign(c, n, { active: c.active });
  }
  private signalAt(axis: "x" | "z") { return signal(axis, this.clock); }
  private updateCar(c: Car, dt: number, p: Player) {
    if (dist2(c.x, c.z, p.x, p.z) > 185 || Math.abs(c.pos) > 200) { this.respawnCar(c, p); return; }
    // 曲がっている最中: ベジェ曲線に沿って進む
    if (c.turn) {
      const t = c.turn; c.v += (5 - c.v) * Math.min(1, 2 * dt); t.t = Math.min(1, t.t + c.v * dt / t.len);
      const u = 1 - t.t, bx = u * u * t.p0[0] + 2 * u * t.t * t.p1[0] + t.t * t.t * t.p2[0], bz = u * u * t.p0[1] + 2 * u * t.t * t.p1[1] + t.t * t.t * t.p2[1];
      const tx = 2 * u * (t.p1[0] - t.p0[0]) + 2 * t.t * (t.p2[0] - t.p1[0]), tz = 2 * u * (t.p1[1] - t.p0[1]) + 2 * t.t * (t.p2[1] - t.p1[1]);
      c.x = bx; c.z = bz; c.yaw = Math.atan2(-tx, -tz);
      if (t.t >= 1) { c.axis = t.nAxis; c.dir = t.nDir; c.road = t.nRoad; c.pos = c.axis === "x" ? c.x : c.z; c.turn = null; c.turns++; this.stats.turns++; this.placeCar(c); }
      return;
    }
    // 次の交差点と信号・前の車を見て目標速度を決める
    const roads = this.L.roads; let nextC = Infinity, best = Infinity;
    for (const rc of roads) { const gap = (rc - c.pos) * c.dir; if (gap > -0.01 && gap < best) { best = gap; nextC = rc; } }
    let target = 9; const stopLine = ROAD / 2 + 2.5; // 交差点中心の手前
    if (best < Infinity && best > 0) {
      const sig = this.signalAt(c.axis), distToStop = best - stopLine;
      if (sig === "red" && distToStop > -3.9 && distToStop < 30) target = Math.min(target, Math.max(0, distToStop - 0.5) * 0.9);
      else if (sig === "yellow" && distToStop > 6 && distToStop < 30) target = Math.min(target, Math.max(0, distToStop - 0.5) * 0.9);
    }
    for (const q of this.cars) { if (q === c || q.axis !== c.axis || q.dir !== c.dir || q.road !== c.road || (q.turn && q.turn.t > 0.5)) continue; const qp = q.turn ? q.pos + q.dir * q.turn.t * 12 : q.pos, gap = (qp - c.pos) * c.dir - CAR_LEN; if (gap > -CAR_LEN && gap < 22) target = Math.min(target, gap < 2.5 ? 0 : q.v + Math.sqrt(2 * 6 * (gap - 2.5))); }
    c.waiting = target < 0.5;
    c.v += clamp(target - c.v, -9 * dt, 3 * dt); c.v = Math.max(0, c.v);
    c.pos += c.dir * c.v * dt;
    // 交差点に入る手前で進路を決める(直進60% / 左20% / 右20%)
    const toC = (nextC - c.pos) * c.dir;
    if (best < Infinity && toC <= 6 && toC > 5.5 - c.v * dt && this.signalAt(c.axis) !== "red") {
      const roll = this.r(); if (roll > 0.6 && Math.abs(nextC) < 190) this.beginTurn(c, nextC, roll < 0.8 ? "left" : "right");
      if (c.turn && !this.laneClear(c)) { c.turn = null; } // 出口の車線が混んでいたら直進する
    }
    if (!c.turn) this.placeCar(c);
  }
  /** 曲がった先の車線(出口付近)に他の車がいないか */
  private laneClear(c: Car) {
    const t = c.turn!; const ex = t.nAxis === "x" ? t.p2[0] : t.p2[1], exRoad = t.nRoad;
    return !this.cars.some(q => q !== c && (q.turn ? (q.turn.nAxis === t.nAxis && q.turn.nDir === t.nDir && q.turn.nRoad === exRoad) : (q.axis === t.nAxis && q.dir === t.nDir && q.road === exRoad && Math.abs(q.pos - ex) < 16)));
  }
  private beginTurn(c: Car, cc: number, side: "left" | "right") {
    // x(東)→左=北(z-)/右=南(z+), -x→左=南/右=北, z(南)→左=東/右=西, -z→左=西/右=東
    const table = { x: { 1: { left: -1, right: 1 }, "-1": { left: 1, right: -1 } }, z: { 1: { left: 1, right: -1 }, "-1": { left: -1, right: 1 } } } as const;
    const nDir = table[c.axis][String(c.dir) as "1" | "-1"][side] as 1 | -1, nAxis: "x" | "z" = c.axis === "x" ? "z" : "x";
    const oldLane = this.lane(c.axis, c.dir, c.road), newLane = this.lane(nAxis, nDir, cc);
    let p0: [number, number], p1: [number, number], p2: [number, number];
    if (c.axis === "x") { p0 = [cc - c.dir * 6, oldLane.z]; p1 = [newLane.x, oldLane.z]; p2 = [newLane.x, c.road + nDir * 6]; }
    else { p0 = [oldLane.x, cc - c.dir * 6]; p1 = [oldLane.x, newLane.z]; p2 = [c.road + nDir * 6, newLane.z]; }
    const len = dist2(p0[0], p0[1], p1[0], p1[1]) + dist2(p1[0], p1[1], p2[0], p2[1]);
    c.turn = { p0, p1, p2, t: 0, len: len * 0.82, nAxis, nDir, nRoad: cc };
  }
}
