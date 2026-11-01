import { PHYS as P, PROX as X } from "./params";
import type { Collider } from "./layout";

/**
 * 衝突の予測と制動・回避(H1)。手動の近接機動・巡航の自動制動・オート周遊で共用する(別の物理は持たず、速度の目標や入力を返すだけ)。
 * 前方の壁(高さ heightAt が足より高い所)と地面を、速度の向きに沿って先読みする。
 */
export interface WorldHeights { colliders: Collider[]; heightAt(x: number, z: number): number }

/** 速度 (vx,vy,vz) で今の位置から進んだとき、最初に何かに当たるまでの距離 m(当たらなければ Infinity)と種類 */
export interface Impact { dist: number; kind: "none" | "wall" | "ground"; nx: number; nz: number }
const NONE: Impact = { dist: Infinity, kind: "none", nx: 0, nz: 0 };
const _imp: Impact = { dist: Infinity, kind: "none", nx: 0, nz: 0 };

export function predictImpact(w: WorldHeights, x: number, feetY: number, z: number, vx: number, vy: number, vz: number, reach: number): Impact {
  const sp = Math.hypot(vx, vy, vz); if (sp < 0.05) return NONE;
  const ux = vx / sp, uy = vy / sp, uz = vz / sp, step = 0.7, n = Math.ceil(reach / step), lx = -uz, lz = ux, ll = Math.hypot(lx, lz) || 1;
  const hit = (d: number, off: number) => { const px = x + ux * d + (lx / ll) * off, pz = z + uz * d + (lz / ll) * off, fy = feetY + uy * d; return w.heightAt(px, pz) > fy + 0.1 && w.heightAt(px, pz) > 1; };
  for (let i = 1; i <= n; i++) {
    const d = i * step, px = x + ux * d, pz = z + uz * d, fy = feetY + uy * d;
    // 地面
    if (fy <= w.heightAt(px, pz) + 0.02 && uy < -0.02 && w.heightAt(px, pz) < 1) { _imp.dist = d; _imp.kind = "ground"; _imp.nx = 0; _imp.nz = 0; return _imp; }
    // 壁: 体の幅(左右0.4m)も見る。足が高さより低い=ぶつかる
    for (const o of [0, 0.4, -0.4]) {
      const qx = px + (lx / ll) * o, qz = pz + (lz / ll) * o, h = w.heightAt(qx, qz);
      if (h > fy + 0.1 && h > 1) {
        // 壁の向き(法線): 高さの勾配から。xとzを少し動かして比べる
        const gx = w.heightAt(qx - 0.6, qz) - w.heightAt(qx + 0.6, qz), gz = w.heightAt(qx, qz - 0.6) - w.heightAt(qx, qz + 0.6), gl = Math.hypot(gx, gz) || 1;
        let lo = d - step, hi = d; for (let k = 0; k < 5; k++) { const m = (lo + hi) / 2; if (hit(m, o)) hi = m; else lo = m; } // 刻み(0.7m)の中で壁の面の位置を絞り込む
        _imp.dist = hi; _imp.kind = "wall"; _imp.nx = gx / gl; _imp.nz = gz / gl; return _imp;
      }
    }
  }
  return NONE;
}

/**
 * 近接機動で、先に壁や地面があるときの速さの上限(0..1 の倍率)。止まれる距離(v²/2a)+余裕より手前なら速さを落とす。
 * 倍率 1 は何もしない。0.2 などは、その速さまで絞る。
 */
export function safeSpeedLimit(w: WorldHeights, x: number, feetY: number, z: number, vx: number, vy: number, vz: number): number {
  const sp = Math.hypot(vx, vy, vz); if (sp < 0.05) return 1;
  const reach = Math.min(12, sp * sp / (2 * X.brakeDecel) + 2.5);
  const imp = predictImpact(w, x, feetY, z, vx, vy, vz, reach);
  if (imp.kind === "none") return 1;
  if (imp.kind === "ground" && vy > -3) return 1; // ゆっくりした降下(地面へそっと降りる)は止めない
  const stopAt = Math.max(0, imp.dist - X.stopGap); // 壁の stopGap 手前で止まる
  const vmax = Math.sqrt(2 * X.brakeDecel * 0.8 * stopAt);
  return Math.max(0.02, Math.min(1, vmax / sp)); // 壁の手前でほぼ止まる(0にはしない: 離れる向きの指示を妨げない)
}

/**
 * 巡航中の自動制動(手動操作の補助)。衝突まで止まり切れない速さで壁・地面へ向かっているとき、
 * ブレーキ・機首上げ・羽ばたき・壁から離れる向きの舵を、距離が縮むほど強く足す。
 * 回避が間に合わない条件(速すぎる・近すぎる)では効き切らず、衝突は残る。mild=true は弱め(オート周遊用の予備)。
 */
export interface AutoBrakeOut { brake: boolean; pitchUp: number; steer: number; flap: boolean; level: number }
const _ab: AutoBrakeOut = { brake: false, pitchUp: 0, steer: 0, flap: false, level: 0 };
export function autoBrake(w: WorldHeights, x: number, feetY: number, z: number, vx: number, vy: number, vz: number, yaw: number): AutoBrakeOut {
  _ab.brake = false; _ab.pitchUp = 0; _ab.steer = 0; _ab.flap = false; _ab.level = 0;
  const hs = Math.hypot(vx, vz), sp = Math.hypot(vx, vy, vz);
  if (sp < P.wallCrashSpeed * 0.9) return _ab; // 遅ければ衝突しても墜落しない
  const reach = clampN(sp * 0.9, 6, 22), imp = predictImpact(w, x, feetY, z, vx, vy, vz, reach);
  if (imp.kind === "none") return _ab;
  const tHit = imp.dist / sp;
  const lvl = clampN(1 - (tHit - 0.25) / 0.9, 0, 1); // 0.25秒前で最大、1.15秒前から効き始める
  if (lvl <= 0) return _ab;
  _ab.level = lvl; _ab.brake = lvl > 0.15; _ab.flap = lvl > 0.45;
  if (imp.kind === "ground") { _ab.pitchUp = 0.35 + 0.6 * lvl; return _ab; }
  // 壁: 上が開いていれば上へ(屋根を越える)、そうでなければ開いている側へ舵を切る
  const fx = hs > 0.1 ? vx / hs : -Math.sin(yaw), fz = hs > 0.1 ? vz / hs : -Math.cos(yaw), rx = -fz, rz = fx; // 右手方向(上から見て進行方向の右)... 
  const side = (sgn: number) => { let free = 0; for (const d of [2, 4, 6, 8]) { const h = w.heightAt(x + (sgn * rx + fx * 0.3) * d, z + (sgn * rz + fz * 0.3) * d); if (h < feetY - 0.5) free += 1; } return free; };
  const freeR = side(1), freeL = side(-1), roofHeight = w.heightAt(x + fx * imp.dist, z + fz * imp.dist), climb = roofHeight - feetY;
  if (climb < 5 && climb > -0.5) _ab.pitchUp = 0.4 + 0.5 * lvl;             // 低い壁(屋根): 上へ
  else _ab.steer = (freeR >= freeL ? 1 : -1) * (0.4 + 0.6 * lvl);          // 高い壁: 開いている側へ(+1=右)
  return _ab;
}
const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * 巡航の自動制動を、入力へ足す(手動操作用)。ブレーキ・機首上げ・羽ばたき・壁から離れる舵。
 * 近接機動中・地上・自動着地中・オート周遊中は呼ばない(呼び出し側が判断する)。入力を書き換えるだけで、位置も速度も直接は動かさない。
 */
export class CruiseGuard {
  active = false; interventions = 0; private lastFlap = -9;
  apply(w: WorldHeights, f: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; yaw: number; clock: number }, inp: { x: number; y: number; flapTap: boolean; brake: boolean }) {
    const a = autoBrake(w, f.pos.x, f.pos.y - P.feetOffset, f.pos.z, f.vel.x, f.vel.y, f.vel.z, f.yaw);
    this.active = a.level > 0; if (!this.active) return;
    this.interventions++;
    if (a.brake) inp.brake = true;
    if (a.pitchUp) inp.y = Math.max(inp.y, a.pitchUp);
    if (a.steer) inp.x = clampN(inp.x + a.steer, -1, 1);
    if (a.flap && f.clock - this.lastFlap > 0.45) { inp.flapTap = true; this.lastFlap = f.clock; }
  }
}
