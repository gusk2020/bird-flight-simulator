import * as THREE from "three";
import { PHYS as P } from "./params";
import type { Collider } from "./layout";

export interface WindSource { at(x: number, y: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3 }
export interface WorldQuery { colliders: Collider[]; heightAt(x: number, z: number): number }
export interface FlightInput { x: number; y: number; flapHeld: boolean; flapTap: boolean; brake: boolean }
export type Mode = "air" | "rollout" | "landed";
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const V = THREE.Vector3;
const _f = new V(), _r = new V(), _u = new V(), _d = new V(), _a = new V(), _l = new V();

/** 固定時間刻みで進める飛行モデル。three.js の描画には依存しない。 */
export class Flight {
  pos = new V(); prevPos = new V(); vel = new V();
  yaw = 0; pitch = 0; roll = 0;
  mode: Mode = "air";
  stun = 0; stall = false; strokeT = -1; strokes = 0;
  wind: WindSource | null = null; windVec = new THREE.Vector3(); liftScale = 1; dragScale = 1; clock = 0; airspeed = 0;
  groundHold = 0; walkV = 0; hopping = false; hopT = -1; walkPhase = 0;
  alpha = 0; speed = 0; agl = 0; braking = false; crashes = 0; resets = 0;
  constructor(public world: WorldQuery) { this.reset(); }

  reset() {
    this.pos.set(28, 14, 110); this.prevPos.copy(this.pos); this.vel.set(0, 0, -10);
    this.yaw = 0; this.pitch = 0.1; this.roll = 0; this.mode = "air";
    this.stun = 0; this.stall = false; this.strokeT = -1; this.resets++; this.walkV = 0; this.hopping = false; this.hopT = -1;
  }
  forward(out: THREE.Vector3, yaw = this.yaw, pitch = this.pitch) {
    return out.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  }

  step(dt: number, inp: FlightInput) {
    this.prevPos.copy(this.pos); this.clock += dt;
    if (this.stun > 0) this.stun = Math.max(0, this.stun - dt);
    const ctl = this.stun > 0 ? 0 : 1;
    const sx = clamp(inp.x, -1, 1) * ctl, sy = clamp(inp.y, -1, 1) * ctl;
    const held = inp.flapHeld && ctl > 0, tap = inp.flapTap && ctl > 0;
    this.braking = inp.brake && ctl > 0;
    if (this.strokeT >= 0) {
      this.strokeT += dt / P.strokeTime;
      if (this.strokeT >= 1) { if (held) { this.strokeT -= 1; this.strokes++; } else this.strokeT = -1; }
    } else if ((held || tap) && this.mode === "air" && !(this.hopping && this.hopT < P.hopTapTime)) {
      if (this.hopping) { // 小ジャンプ中に押し続けた → 離陸へ移行
        this.hopping = false; this.forward(_f, this.yaw, 0);
        const hs = Math.max(P.takeoffSpeed, Math.hypot(this.vel.x, this.vel.z)); this.vel.x = _f.x * hs; this.vel.z = _f.z * hs; this.vel.y = Math.max(this.vel.y, P.takeoffUp * 0.7); this.pitch = 0.25;
      }
      this.strokeT = 0; this.strokes++;
    }

    if (this.mode === "air") this.air(dt, sx, sy);
    else { this.stall = false; this.strokeT = -1; this.ground(dt, sx, inp.brake && ctl > 0, tap, held); this.braking = this.mode === "rollout" && inp.brake && ctl > 0; }
    this.finish();
  }

  /** 地上で歩いている(歩くボタンを押していて前進中) */
  get walking() { return this.mode === "landed" && this.walkV > 0.05; }

  private air(dt: number, sx: number, sy: number) {
    if (this.hopping) { this.hopT += dt; if (this.strokeT >= 0) this.hopping = false; }
    if (this.hopping) { this.hop(dt, sx); return; }
    // 空気に対する速度で空力を計算し、最後に風を足して地面に対する移動にする
    const w = this.windVec; if (this.wind) this.wind.at(this.pos.x, this.pos.y, this.pos.z, this.clock, w); else w.set(0, 0, 0);
    this.vel.sub(w);
    const speed = this.vel.length(); this.airspeed = speed;
    // --- 姿勢 ---
    const ctl = clamp(speed / P.controlSpeed, 0.35, 1.2);
    this.yaw -= sx * P.turnRate * ctl * dt;
    let pt = P.trimPitch + (sy > 0 ? sy * P.maxClimbPitch : sy * P.maxDivePitch);
    if (this.braking) pt += 0.15;
    if (this.stall) pt = Math.min(pt, P.stallRecoverPitch);
    this.pitch += (pt - this.pitch) * (1 - Math.exp(-P.pitchResponse * dt));
    this.pitch = clamp(this.pitch, -P.pitchLimit, P.pitchLimit);
    const rt = -sx * P.maxBank * Math.min(1, speed / 8);
    this.roll += (rt - this.roll) * (1 - Math.exp(-P.bankResponse * dt));

    // --- 力 ---
    const f = this.forward(_f);
    _r.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _u.crossVectors(_r, f); // 翼の法線(ロール無し)
    _d.copy(this.vel);
    if (speed > 0.5) _d.divideScalar(speed); else _d.copy(f);
    const gamma = speed > 1 ? Math.asin(clamp(this.vel.y / speed, -1, 1)) : 0;
    const alpha = this.pitch - gamma;
    this.alpha = alpha;
    this.stall = alpha > P.alphaStall;
    let cl = alpha <= P.alphaStall ? P.cl0 + P.clSlope * alpha
      : Math.max(P.clAfterStall, P.cl0 + P.clSlope * P.alphaStall - (alpha - P.alphaStall) * P.clDropRate);
    cl = Math.max(cl, -0.6);
    if (this.braking) cl += P.brakeCl;
    const cd = (P.cd0 + P.kInduced * cl * cl + P.flatPlateDrag * Math.sin(alpha) ** 2) * (1 + (this.braking ? P.brakeDrag : 0));
    const q = speed * speed;
    _a.set(0, -P.gravity, 0);
    // 揚力方向: 翼法線のうち速度に垂直な成分
    _l.copy(_u).addScaledVector(_d, -_u.dot(_d));
    const ll = _l.length();
    if (ll > 1e-3) _a.addScaledVector(_l, (P.liftK * this.liftScale * cl * q) / ll * Math.min(1, ll * 2));
    _a.addScaledVector(_d, -P.liftK * this.dragScale * cd * q);
    if (this.strokeT >= 0) {
      const s = Math.sin(Math.PI * this.strokeT);
      _a.addScaledVector(f, P.flapThrust * s * clamp((P.flapMaxSpeed - speed) / 6, 0, 1)); _a.y += P.flapLift * s;
    }
    this.vel.addScaledVector(_a, dt);
    // 横滑りを減衰 (旋回で速度が機首方向へ曲がる)
    const side = this.vel.dot(_r);
    this.vel.addScaledVector(_r, -side * (1 - Math.exp(-P.sideDamp * dt)));
    if (this.vel.length() > P.maxDiveSpeed) this.vel.setLength(P.maxDiveSpeed);
    this.vel.add(w);
    this.pos.addScaledVector(this.vel, dt);

    this.collide();
    const gh = this.world.heightAt(this.pos.x, this.pos.z), feet = this.pos.y - P.feetOffset;
    this.agl = feet - gh;
    if (feet <= gh) { this.pos.y = gh + P.feetOffset; this.touchdown(); }
  }

  private touchdown() {
    const sink = Math.max(0, -this.vel.y), hs = Math.hypot(this.vel.x, this.vel.z);
    if (sink > P.safeSink || hs > P.safeSpeed) {
      this.crash(); this.vel.y = Math.min(sink * 0.3, 3); this.vel.x *= 0.5; this.vel.z *= 0.5;
    } else { this.mode = "rollout"; this.vel.y = 0; this.strokeT = -1; }
  }
  private crash() { this.stun = P.stunTime; this.crashes++; this.strokeT = -1; }

  /** 小ジャンプ中: ほぼ放物運動。向きは変えられる。着地は安全(沈下速度が小さい) */
  private hop(dt: number, sx: number) {
    this.yaw -= sx * P.groundTurn * 1.2 * dt;
    this.pitch += (0.15 - this.pitch) * (1 - Math.exp(-6 * dt)); this.roll += (0 - this.roll) * (1 - Math.exp(-6 * dt));
    this.vel.y -= P.gravity * dt; this.stall = false;
    this.pos.addScaledVector(this.vel, dt);
    this.collide();
    const gh = this.world.heightAt(this.pos.x, this.pos.z), feet = this.pos.y - P.feetOffset;
    this.agl = feet - gh;
    if (feet <= gh && this.vel.y <= 0) {
      this.pos.y = gh + P.feetOffset; this.hopping = false; this.hopT = -1;
      const hs = Math.hypot(this.vel.x, this.vel.z); this.vel.y = 0;
      if (hs > 0.3) this.mode = "rollout"; else { this.mode = "landed"; this.vel.set(0, 0, 0); }
    }
  }

  private ground(dt: number, sx: number, walkHeld: boolean, tap: boolean, flapHeld: boolean) {
    _f.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    // 押下を検知できない入力(押しっぱなしだけ)でも、長押しなら離陸する
    this.groundHold = flapHeld ? this.groundHold + dt : 0;
    if (!tap && this.groundHold >= P.hopTapTime) {
      this.groundHold = 0;
      const hs = Math.max(P.takeoffSpeed, this.vel.dot(_f)); this.vel.copy(_f).multiplyScalar(hs); this.vel.y = P.takeoffUp;
      this.mode = "air"; this.pitch = 0.25; this.pos.y += 0.05; this.strokeT = 0; this.strokes++; this.walkV = 0; return;
    }
    if (tap) {
      const hs0 = Math.max(0, this.vel.dot(_f));
      if (this.mode === "rollout" && hs0 > 4) { // 走りながら羽ばたく: そのまま離陸
        this.vel.copy(_f).multiplyScalar(Math.max(P.takeoffSpeed, hs0)); this.vel.y = P.takeoffUp;
        this.mode = "air"; this.pitch = 0.25; this.pos.y += 0.05; this.strokeT = 0; this.strokes++; return;
      }
      // 小ジャンプ (押し続ければ hopTapTime 後に離陸の羽ばたきが始まる)
      this.vel.copy(_f).multiplyScalar(this.walkV + P.hopForward); this.vel.y = P.hopUp;
      this.mode = "air"; this.hopping = true; this.hopT = 0; this.walkV = 0; this.pos.y += 0.03; return;
    }
    let hs = Math.max(0, this.vel.dot(_f));
    if (this.mode === "rollout") {
      hs = Math.max(0, hs - (P.rolloutDecel + (walkHeld ? P.rolloutBrake : 0)) * dt);
      this.yaw -= sx * P.groundTurn * Math.min(1, hs / 4) * dt;
      if (hs < 0.3) { hs = 0; this.mode = "landed"; }
      this.walkV = 0;
    } else {
      // 歩行: 歩くボタンで前進。スティックで向きを変える
      this.yaw -= sx * P.groundTurn * dt;
      const target = walkHeld ? P.walkSpeed : 0;
      this.walkV += clamp(target - this.walkV, -P.walkDecel * dt, P.walkAccel * dt);
      hs = this.walkV; this.walkPhase += hs * dt * 4.5;
    }
    this.vel.copy(_f).multiplyScalar(hs);
    this.pos.addScaledVector(this.vel, dt);
    this.collide(true);
    this.pitch += (0 - this.pitch) * (1 - Math.exp(-8 * dt));
    this.roll += (0 - this.roll) * (1 - Math.exp(-8 * dt));
    const gh = this.world.heightAt(this.pos.x, this.pos.z);
    this.agl = this.pos.y - P.feetOffset - gh;
    if (this.agl > P.stepDown) { this.mode = "air"; this.walkV = 0; } // 屋根の縁・高い段から外へ出た
    else this.pos.y = gh + P.feetOffset;                                 // 小さな段差は歩いて昇降(接地を維持)
  }

  /** 建物の壁との衝突。上面は heightAt が受け持つ。 */
  private collide(grounded = false) {
    const R = P.bodyRadius, prevFeet = this.prevPos.y - P.feetOffset;
    for (const c of this.world.colliders) {
      if (prevFeet >= c.top - 0.05) continue;
      if (grounded && c.top - prevFeet <= P.stepUp) continue; // 低い段差は壁にせず、そのまま乗り上がる
      const cx = clamp(this.pos.x, c.minX, c.maxX), cz = clamp(this.pos.z, c.minZ, c.maxZ);
      let nx = this.pos.x - cx, nz = this.pos.z - cz, pen: number;
      const d = Math.hypot(nx, nz);
      if (d >= R || this.pos.y - P.feetOffset >= c.top) continue;
      if (d < 1e-6) {
        const l = this.pos.x - c.minX, r = c.maxX - this.pos.x, b = this.pos.z - c.minZ, fr = c.maxZ - this.pos.z;
        const m = Math.min(l, r, b, fr);
        if (m === l) { nx = -1; nz = 0; pen = l + R; } else if (m === r) { nx = 1; nz = 0; pen = r + R; }
        else if (m === b) { nx = 0; nz = -1; pen = b + R; } else { nx = 0; nz = 1; pen = fr + R; }
      } else { nx /= d; nz /= d; pen = R - d; }
      this.pos.x += nx * pen; this.pos.z += nz * pen;
      const vn = this.vel.x * nx + this.vel.z * nz;
      if (vn < 0) {
        this.vel.x -= 1.2 * vn * nx; this.vel.z -= 1.2 * vn * nz;
        if (-vn > P.wallCrashSpeed) this.crash();
      }
    }
  }

  private finish() {
    const p = this.pos, v = this.vel;
    if (![p.x, p.y, p.z, v.x, v.y, v.z, this.yaw, this.pitch, this.roll].every(Number.isFinite) || p.y < -5) { this.reset(); return; }
    const B = P.bound;
    if (Math.abs(p.x) > B) { p.x = Math.sign(p.x) * B; if (v.x * p.x > 0) v.x = 0; }
    if (Math.abs(p.z) > B) { p.z = Math.sign(p.z) * B; if (v.z * p.z > 0) v.z = 0; }
    if (p.y > P.maxAltitude) { p.y = P.maxAltitude; if (v.y > 0) v.y = 0; }
    this.speed = v.length();
  }
}
