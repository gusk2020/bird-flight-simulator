import * as THREE from "three";
import { PHYS as P, PROX as X } from "./params";
import type { ProxCmd } from "./proxpad";
import { safeSpeedLimit } from "./avoid";
import type { Collider } from "./layout";

export interface WindSource { at(x: number, y: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3 }
export interface WorldQuery {
  colliders: Collider[]; heightAt(x: number, z: number): number;
  /** 水面(田んぼの水)か。歩いて入らない(飛ぶ・跳ぶ・離陸は自由) */
  waterAt?(x: number, z: number): boolean;
  perchAt?(x: number, y: number, z: number, r: number): { id: number; t: number } | null;
  perchPoint?(id: number, t: number, out: { x: number; y: number; z: number }): void;
  wireDir?(id: number): [number, number];
}
/** スティックの前倒しで歩き出す閾値(これ未満の前倒しは向き替えだけ) */
export const WALK_STICK_DEAD = 0.15;
export interface FlightInput { x: number; y: number; flapHeld: boolean; flapTap: boolean; brake: boolean; /** H1: 近接◎のタッチ(なければ null/未指定) */ prox?: ProxCmd | null }
export type Mode = "air" | "rollout" | "landed" | "perch";
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const V = THREE.Vector3;
const _f = new V(), _r = new V(), _u = new V(), _d = new V(), _a = new V(), _l = new V();

/** 固定時間刻みで進める飛行モデル。three.js の描画には依存しない。 */
export class Flight {
  pos = new V(); prevPos = new V(); vel = new V();
  yaw = 0; pitch = 0; roll = 0;
  mode: Mode = "air";
  stun = 0; stall = false; strokeT = -1; strokes = 0;
  wind: WindSource | null = null; windVec = new THREE.Vector3(); liftScale = 1; dragScale = 1; clock = 0; airspeed = 0;
  /** 着地補助が小ジャンプの初速を一時的に上書きする(次の1回のジャンプでだけ使い、毎ステップ末尾で消す) */
  hopHint: { up: number; fwd: number; yaw?: number } | null = null;
  groundHold = 0; perchId = -1; perchT = 0; perchCool = 0; perchBlend = 0; walkV = 0; hopping = false;
  /** 旋回の横滑りを機首方向へ向け直すときに残す割合(手動操作=PHYS.turnKeep。0=従来どおり捨てる: オート周遊はこちらで調整済み) */
  turnKeep: number = P.turnKeep; hopT = -1; walkPhase = 0;
  alpha = 0; speed = 0; agl = 0; braking = false; crashes = 0; resets = 0;
  /** G1-2: 壁への衝突から自動で安全な向きへ復帰する(手動操作)。オート周遊は専用の復旧を持つので Autopilot.start が切り、止めたときに main が戻す */
  wallRecovery = true;
  /** H1 近接機動の状態。on の間は揚力の物理ではなく、指示された向きへ上限つきの加速度で動く(失速しない・位置は動かさない) */
  prox = { on: false, state: "touch" as "touch" | "creep" | "exit", yaw: 0, pitch: 0, pitchNow: 0, speed: 0, t: 0, fromGround: false };
  /** 地上で座っている(下側◎の下方向)。歩く・羽ばたく・大きな操作で終わる。休息の動作は見た目側(H3)が使う */
  sitting = false;
  /** 計測・テスト用: かすり回数 / 復帰回数 / 直近の逃げる向き(yaw)と理由 */
  grazes = 0; escapes = 0; escapeYaw = 0; escapeT = 0; escapeGuard = 0; escapeKind: "" | "left" | "right" | "back" = "";
  constructor(public world: WorldQuery) { this.reset(); }

  reset() {
    this.pos.set(28, 14, 110); this.prevPos.copy(this.pos); this.vel.set(0, 0, -10);
    this.yaw = 0; this.pitch = 0.1; this.roll = 0; this.mode = "air";
    this.prox.on = false; this.sitting = false; this.stun = 0; this.escapeT = 0; this.escapeGuard = 0; this.stall = false; this.strokeT = -1; this.resets++; this.walkV = 0; this.hopping = false; this.hopT = -1; this.perchId = -1; this.perchCool = 0;
  }
  forward(out: THREE.Vector3, yaw = this.yaw, pitch = this.pitch) {
    return out.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  }

  step(dt: number, inp: FlightInput) {
    this.prevPos.copy(this.pos); this.clock += dt; if (this.perchCool > 0) this.perchCool -= dt;
    if (this.stun > 0) this.stun = Math.max(0, this.stun - dt);
    if (this.escapeGuard > 0) this.escapeGuard -= dt;
    if (this.escapeT > 0) { // 逃げる向きへ機首を回す(硬直中も)
      this.escapeT -= dt; let e = this.escapeYaw - this.yaw; e = Math.atan2(Math.sin(e), Math.cos(e));
      this.yaw += clamp(e, -P.escapeTurn * dt, P.escapeTurn * dt);
    }
    const ctl = this.stun > 0 ? 0 : 1;
    const sx = clamp(inp.x, -1, 1) * ctl, sy = clamp(inp.y, -1, 1) * ctl;
    const held = inp.flapHeld && ctl > 0, tap = inp.flapTap && ctl > 0, pc = ctl > 0 && inp.prox ? inp.prox : null;
    this.braking = inp.brake && ctl > 0;
    if (this.prox.on && this.mode === "air") { /* 近接機動中の羽ばたきは proxAir が管理する */ }
    else if (this.strokeT >= 0) {
      this.strokeT += dt / P.strokeTime;
      if (this.strokeT >= 1) { if (held) { this.strokeT -= 1; this.strokes++; } else this.strokeT = -1; }
    } else if ((held || tap) && this.mode === "air" && !(this.hopping && this.hopT < P.hopTapTime)) {
      if (this.hopping) { // 小ジャンプ中に押し続けた → 離陸へ移行
        this.hopping = false; this.forward(_f, this.yaw, 0);
        const hs = Math.max(P.takeoffSpeed, Math.hypot(this.vel.x, this.vel.z)); this.vel.x = _f.x * hs; this.vel.z = _f.z * hs; this.vel.y = Math.max(this.vel.y, P.takeoffUp * 0.7); this.pitch = 0.25;
      }
      this.strokeT = 0; this.strokes++;
    }

    if (this.mode === "air") { if (pc || this.prox.on) this.proxAir(dt, pc, tap, held, sx, sy); else this.air(dt, sx, sy); }
    else if (pc && (this.mode === "landed" || this.mode === "rollout") && this.proxGround(dt, pc)) { /* 近接◎が地上の動きを引き受けた */ }
    else { // 地上・電線: 歩くボタン(長押し)か、スティックを前へ倒すと歩く。前へ倒した量で速さが変わる
      const walk = this.braking ? 1 : clamp((sy - WALK_STICK_DEAD) / 0.4, 0, 1);
      this.stall = false; this.strokeT = -1;
      if (this.mode === "perch") { this.perchStep(dt, sx, walk > 0, tap, held); this.braking = false; }
      else { this.ground(dt, sx, walk, tap, held); this.braking = this.mode === "rollout" && inp.brake && ctl > 0; }
    }
    this.hopHint = null;
    this.finish();
  }

  /** 地上で歩いている(歩くボタンを押していて前進中) */
  get walking() { return this.mode === "landed" && this.walkV > 0.05; }

  private air(dt: number, sx: number, sy: number) {
    if (this.hopping) { this.hopT += dt; if (this.strokeT >= 0 || this.vel.y < -4 || this.hopT > 1.2) this.hopping = false; } // 高い所からの落下は通常の空力飛行へ
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
    // 横滑りを機首方向へ向け直す(以前は横成分を捨てていたため、旋回するたびに速度を大きく失い、緩い旋回でも失速→落下していた)。向け直しの損失は一部だけ
    const side = this.vel.dot(_r), rm = side * (1 - Math.exp(-P.sideDamp * dt)), h2 = this.vel.x * this.vel.x + this.vel.z * this.vel.z;
    this.vel.addScaledVector(_r, -rm);
    const keep = h2 - (1 - this.turnKeep) * rm * rm, now = this.vel.x * this.vel.x + this.vel.z * this.vel.z;
    if (this.turnKeep > 0 && now > 1e-6 && keep > now) { const k = Math.sqrt(keep / now); this.vel.x *= k; this.vel.z *= k; } // 水平成分だけ戻す(沈下は増やさない)
    if (this.vel.length() > P.maxDiveSpeed) this.vel.setLength(P.maxDiveSpeed);
    this.vel.add(w);
    this.pos.addScaledVector(this.vel, dt);

    this.collide();
    const gh = this.world.heightAt(this.pos.x, this.pos.z), feet = this.pos.y - P.feetOffset;
    this.agl = feet - gh;
    if (this.tryPerch(this.braking)) return;
    if (feet <= gh) { this.pos.y = gh + P.feetOffset; this.touchdown(); }
  }

  /** 電線に着地できるか。意図(減速ボタン/小ジャンプ)・低速・近距離・非上昇のすべてを満たすときだけ。通過しただけでは止まらない。 */
  private tryPerch(intent: boolean): boolean {
    if (!intent || this.perchCool > 0 || !this.world.perchAt) return false;
    if (Math.hypot(this.vel.x, this.vel.z) > P.perchMaxSpeed || this.vel.y > P.perchMaxRise) return false;
    const hit = this.world.perchAt(this.pos.x, this.pos.y - P.feetOffset, this.pos.z, P.perchRadius);
    if (!hit) return false;
    this.mode = "perch"; this.perchId = hit.id; this.perchT = hit.t; this.hopping = false; this.hopT = -1; this.strokeT = -1;
    this.vel.set(0, 0, 0); this.walkV = 0; this.pitch = 0; this.roll = 0; return true;
  }

  /** 電線上: 足が電線をつかむ位置へなめらかに寄り、滑らず止まる。歩くで電線沿いに移動、羽ばたきで小ジャンプ/離陸。 */
  private perchStep(dt: number, sx: number, walkHeld: boolean, tap: boolean, flapHeld: boolean) {
    const w = this.world, pt = { x: 0, y: 0, z: 0 };
    this.yaw -= sx * P.groundTurn * dt;
    this.pitch += (0 - this.pitch) * (1 - Math.exp(-8 * dt)); this.roll += (0 - this.roll) * (1 - Math.exp(-8 * dt));
    _f.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.groundHold = flapHeld ? this.groundHold + dt : 0;
    if (tap || this.groundHold >= P.hopTapTime) {
      this.perchCool = P.perchCooldown; this.perchId = -1;
      if (tap) { this.vel.copy(_f).multiplyScalar(P.perchHopForward); this.vel.y = P.hopUp; this.mode = "air"; this.hopping = true; this.hopT = 0; this.pos.y += 0.03; }
      else { this.groundHold = 0; this.vel.copy(_f).multiplyScalar(P.takeoffSpeed); this.vel.y = P.takeoffUp; this.mode = "air"; this.pitch = 0.25; this.strokeT = 0; this.strokes++; }
      return;
    }
    const dir = w.wireDir!(this.perchId), along = _f.x * dir[0] + _f.z * dir[1];
    if (walkHeld && Math.abs(along) > 0.35) { const wl = this.wireLength(); this.perchT = clamp(this.perchT + Math.sign(along) * P.perchWalk * dt / wl, 0.04, 0.96); this.walkPhase += P.perchWalk * dt * 4.5; }
    w.perchPoint!(this.perchId, this.perchT, pt);
    const k = 1 - Math.exp(-25 * dt);
    this.pos.x += (pt.x - this.pos.x) * k; this.pos.y += (pt.y + P.feetOffset - this.pos.y) * k; this.pos.z += (pt.z - this.pos.z) * k;
    this.vel.set(0, 0, 0); this.agl = this.pos.y - P.feetOffset - w.heightAt(pt.x, pt.z);
  }
  private wireLength() { return 28; } // 柱の間隔

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
    if (this.tryPerch(true)) return;
    if (feet <= gh && this.vel.y <= 0) {
      this.pos.y = gh + P.feetOffset; this.hopping = false; this.hopT = -1;
      if (-this.vel.y > P.safeSink) { this.mode = "air"; this.touchdown(); return; }
      const hs = Math.hypot(this.vel.x, this.vel.z); this.vel.y = 0;
      // 小ジャンプの着地は、歩く速さ程度ならそのまま歩行へつなぐ(滑走で操作が効かない時間を作らない)
      if (hs > P.walkSpeed + 2) this.mode = "rollout"; else { this.mode = "landed"; this.walkV = Math.min(hs, P.walkSpeed); this.vel.set(0, 0, 0); }
    }
  }

  private ground(dt: number, sx: number, walk: number, tap: boolean, flapHeld: boolean) {
    const walkHeld = walk > 0;
    if (this.sitting) { // 座っている: 歩く・羽ばたく・大きく向きを変える、で立ち上がる。それまでは動かない
      if (walkHeld || tap || flapHeld || Math.abs(sx) > 0.35 || this.mode !== "landed") this.sitting = false;
      else { this.walkV = 0; this.vel.set(0, 0, 0); this.agl = this.pos.y - P.feetOffset - this.world.heightAt(this.pos.x, this.pos.z); return; }
    }
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
      const hh = this.hopHint; if (hh && hh.yaw !== undefined) { this.yaw = hh.yaw; _f.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); } this.vel.copy(_f).multiplyScalar(hh ? hh.fwd : this.walkV + P.hopForward); this.vel.y = hh ? hh.up : P.hopUp;
      this.mode = "air"; this.hopping = true; this.hopT = 0; this.walkV = 0; this.pos.y += 0.03; return;
    }
    let hs = Math.max(0, this.vel.dot(_f));
    if (this.mode === "rollout") {
      hs = Math.max(0, hs - (P.rolloutDecel + (this.braking ? P.rolloutBrake : 0)) * dt);
      this.yaw -= sx * P.groundTurn * Math.min(1, hs / 4) * dt;
      if (hs < 0.3) { hs = 0; this.mode = "landed"; this.walkV = 0; }
      else if (walkHeld && hs < P.walkSpeed + 1) { this.mode = "landed"; this.walkV = Math.min(hs, P.walkSpeed); } // 減速しきる前でも、歩く入力があれば歩行へ
      else this.walkV = 0;
    } else {
      // 歩行: 歩くボタンで前進。スティックで向きを変える
      this.yaw -= sx * P.groundTurn * dt;
      const target = P.walkSpeed * walk;
      this.walkV += clamp(target - this.walkV, -P.walkDecel * dt, P.walkAccel * dt);
      hs = this.walkV; this.walkPhase += hs * dt * 4.5;
    }
    this.vel.copy(_f).multiplyScalar(hs);
    const wx = this.pos.x, wz = this.pos.z, inWater = !!this.world.waterAt && this.world.waterAt(wx, wz);
    this.pos.addScaledVector(this.vel, dt);
    this.collide(true);
    // 水田の水面へは歩いて入らない(すでに水の中にいるときは、出る向きの歩行を妨げない)
    if (!inWater && this.world.waterAt && this.world.waterAt(this.pos.x, this.pos.z)) { this.pos.x = wx; this.pos.z = wz; this.vel.set(0, 0, 0); this.walkV = 0; if (this.mode === "rollout") this.mode = "landed"; }
    this.pitch += (0 - this.pitch) * (1 - Math.exp(-8 * dt));
    this.roll += (0 - this.roll) * (1 - Math.exp(-8 * dt));
    const gh = this.world.heightAt(this.pos.x, this.pos.z);
    this.agl = this.pos.y - P.feetOffset - gh;
    if (this.agl > P.stepDown) { this.mode = "air"; this.walkV = 0; } // 屋根の縁・高い段から外へ出た
    else this.pos.y = gh + P.feetOffset;                                 // 小さな段差は歩いて昇降(接地を維持)
  }

  /**
   * H1 近接機動(空中)。指示(pc)の向きへ機首を回し(約0.25〜0.4秒)、速度を上限つきの加速度で目標へ近づける
   * (急制動 brakeDecel、加速 accel。瞬間的な停止・位置の移動はしない)。指を離すとゆっくり前進して高度を保ち(creep)、
   * 一定時間か巡航の操作で通常飛行へ戻る(exit: 失速しない速さまで羽ばたきながら加速)。地上から飛んだ場合は、離すとゆっくり降りる。
   */
  private proxAir(dt: number, pc: ProxCmd | null, tap: boolean, held: boolean, sx: number, sy: number) {
    const S = this.prox;
    if (this.hopping) { this.hopping = false; this.hopT = -1; }
    if (!S.on) { S.on = true; S.state = "touch"; S.t = 0; S.fromGround = false; S.yaw = this.yaw; S.pitch = 0; S.pitchNow = Math.asin(clamp(this.vel.y / Math.max(this.vel.length(), 1), -1, 1)); S.speed = X.creepSpeed; }
    if (pc) { S.state = "touch"; S.yaw = pc.yaw; S.pitch = pc.pitch; S.speed = pc.speed; S.t = 0; }
    else if (S.state === "touch") { S.state = "creep"; S.t = 0; }
    else if (S.state === "creep" && (tap || held || Math.abs(sx) > 0.3 || Math.abs(sy) > 0.3)) { S.state = "exit"; S.t = 0; } // 巡航の操作で通常飛行へ
    S.t += dt;
    let tYaw = S.yaw, tPitch = S.pitch, tSpeed = S.speed, sinkV = 0;
    if (S.fromGround && S.state === "touch") { // 地上から飛んだとき: 地面から約1.1 mを保って微速前進(指が上を向けばさらに上がり、下を向けば地面近くまで)
      const hold = clamp((1.1 - this.agl) * 0.6, -0.35, 0.35); tPitch = S.pitch > 0.05 ? Math.max(S.pitch, hold) : S.pitch < -0.05 ? Math.min(S.pitch, hold) : hold; tSpeed = Math.max(tSpeed, X.creepSpeed * 0.8);
    }
    if (S.state === "creep") {
      tYaw = S.yaw; tPitch = 0; tSpeed = S.fromGround ? 1.2 : X.creepSpeed; if (S.fromGround) sinkV = -X.landSink;
      if (!S.fromGround && S.t > X.creepMax) { S.state = "exit"; S.t = 0; }
    }
    if (S.state === "exit") { tYaw = this.yaw; tPitch = 0.04; tSpeed = X.exitSpeed; if (S.t > X.exitTime) { S.on = false; this.strokeT = -1; return this.finishProxExit(); } }
    // 機首: 指示の向きへ(回る速さに上限)
    const e = wrap(tYaw - this.yaw), rate = clamp(e * X.turnGain, -X.turnRate, X.turnRate); this.yaw += rate * dt;
    S.pitchNow += clamp(tPitch - S.pitchNow, -X.pitchRate * dt, X.pitchRate * dt);
    const cp = Math.cos(S.pitchNow);
    _a.set(-Math.sin(this.yaw) * cp * tSpeed, Math.sin(S.pitchNow) * tSpeed + sinkV, -Math.cos(this.yaw) * cp * tSpeed); // 目標の速度
    // 壁・地面の手前で止まる(回避の共通処理): 先に壁/地面が迫っていれば目標の速さを落とす
    const lim = safeSpeedLimit(this.world, this.pos.x, this.pos.y - P.feetOffset, this.pos.z, _a.x, _a.y, _a.z);
    if (lim < 1) _a.multiplyScalar(lim);
    _d.copy(_a).sub(this.vel); const dv = _d.length(), cur = this.vel.length(), a = (cur > _a.length() + 0.3 || this.vel.dot(_a) < 0 ? X.brakeDecel : X.accel) * dt;
    if (dv <= a) this.vel.copy(_a); else this.vel.addScaledVector(_d, a / dv);
    // 姿勢(見た目): 少し機首を上げ、曲がる向きへ傾く。羽ばたきは続けるが、羽ばたき回数(strokes)には数えない
    this.pitch += (clamp(S.pitchNow * 0.6, -0.5, 0.7) + 0.2 - this.pitch) * (1 - Math.exp(-6 * dt));
    this.roll += (clamp(-rate * 0.07, -0.45, 0.45) - this.roll) * (1 - Math.exp(-8 * dt)); this.stall = false;
    this.strokeT = this.strokeT < 0 ? 0 : this.strokeT + dt / (P.strokeTime * 0.8); if (this.strokeT >= 1) this.strokeT -= 1;
    this.pos.addScaledVector(this.vel, dt);
    this.collide();
    const gh = this.world.heightAt(this.pos.x, this.pos.z), feet = this.pos.y - P.feetOffset; this.agl = feet - gh;
    if (S.state !== "exit" && this.tryPerch(true)) { S.on = false; return; }
    if (feet <= gh + 0.01 && this.vel.y <= 0.3) { // 地面: 遅ければそっと降りる。速い降下は着地と同じ判定(墜落)
      this.pos.y = gh + P.feetOffset; S.on = false; this.strokeT = -1;
      if (-this.vel.y > P.safeSink) { this.mode = "air"; this.touchdown(); return; }
      this.vel.set(0, 0, 0); this.mode = "landed"; this.walkV = 0; this.pitch = 0; this.roll = 0; this.agl = 0;
    }
  }
  /** 近接機動から通常飛行へ戻る: いまの向きに速さ exitSpeed で、水平に近い姿勢 */
  private finishProxExit() {
    this.forward(_f, this.yaw, 0); const sp = Math.max(X.exitSpeed, Math.hypot(this.vel.x, this.vel.z));
    this.vel.x = _f.x * sp; this.vel.z = _f.z * sp; this.vel.y = Math.max(this.vel.y, 0); this.pitch = 0.1; this.roll = 0;
  }
  /**
   * H1 地上で下側◎に触れているとき。下向き=座り込み(休息へ)、中心か他の向きを一定時間触れ続けると、短く飛んで微速前進。
   * 戻り値 true なら地上の通常処理は行わない。
   */
  private proxGround(dt: number, pc: ProxCmd): boolean {
    if (pc.down && this.mode === "landed") { this.sitting = true; this.walkV = 0; this.vel.set(0, 0, 0); return true; }
    this.sitting = false;
    if (pc.held >= X.groundHold && this.mode === "landed") { // 短く飛ぶ
      const S = this.prox; S.on = true; S.state = "touch"; S.fromGround = true; S.t = 0; S.yaw = pc.yaw; S.pitch = pc.pitch; S.pitchNow = 0.15; S.speed = pc.speed;
      this.mode = "air"; this.pos.y += 0.05; this.walkV = 0; this.vel.set(0, X.hopClimb, 0); this.strokeT = 0; this.pitch = 0.2; return true;
    }
    // 触れ始め: その向きへ機首だけ回す(歩かない)
    const e = wrap(pc.yaw - this.yaw); if (!pc.center) this.yaw += clamp(e * X.turnGain, -X.turnRate, X.turnRate) * dt;
    return false;
  }

  /**
   * G1-2: 壁に当たったら、壁の接線(左右)と真後ろのうち、先がいちばん開けている向きへ機首を向け、壁から離れる速度を与える。
   * 左右を優先(壁に沿って抜けるほうが自然)し、どちらも塞がっていれば後方。位置は動かさない(壁の押し戻しは collide が行う)ので、壁を貫通しない。
   */
  private beginEscape(nx: number, nz: number, hs0: number) {
    const cands: { d: [number, number]; kind: "left" | "right" | "back"; bias: number }[] = [
      { d: [-nz, nx], kind: "left", bias: 0 }, { d: [nz, -nx], kind: "right", bias: 0 }, { d: [nx, nz], kind: "back", bias: 3 },
    ];
    const vx = this.vel.x, vz = this.vel.z, feet = this.pos.y - P.feetOffset;
    let best = cands[0], bs = 1e9;
    for (const c of cands) {
      // 先 3,6,10,16 m と左右1.5mを調べ、自分の高さ(-1m)より高い建物があるぶんを「塞がり」として足す。壁沿いに続けて飛んでいた向きは少し有利
      let block = 0;
      for (const dist of [3, 6, 10, 16]) for (const side of [-1.5, 0, 1.5]) {
        const x = this.pos.x + c.d[0] * dist + -c.d[1] * side, z = this.pos.z + c.d[1] * dist + c.d[0] * side;
        const h = this.world.heightAt(x, z); if (h > feet - 1) block += 2 + Math.min(6, h - feet + 1) * 0.2;
      }
      const along = (vx * c.d[0] + vz * c.d[1]) / Math.max(hs0, 1);
      const score = block + c.bias - along * 1.5;
      if (score < bs) { bs = score; best = c; }
    }
    const sp = clamp(hs0 * 0.6, P.escapeSpeedMin, P.escapeSpeedMax);
    this.vel.x = best.d[0] * sp + nx * P.escapeAway; this.vel.z = best.d[1] * sp + nz * P.escapeAway;
    this.vel.y = Math.max(this.vel.y, P.escapeClimb);
    this.escapeYaw = Math.atan2(-this.vel.x, -this.vel.z); this.escapeT = 0.6; this.escapeGuard = P.escapeGuard; this.escapeKind = best.kind; this.escapes++;
    this.pitch = 0.05; this.roll = 0;
  }

  /** 建物の壁との衝突。上面は heightAt が受け持つ。 */
  private collide(grounded = false) {
    const R = P.bodyRadius, prevFeet = this.prevPos.y - P.feetOffset;
    const cs = this.world.colliders;
    for (let i = 0; i < cs.length; i++) { // for-of は反復子オブジェクトを毎回作るためホットパスでは添字で回す
      const c = cs[i];
      if (prevFeet >= c.top - 0.05) continue;
      if (grounded && c.top - prevFeet <= P.stepUp) continue; // 低い段差は壁にせず、そのまま乗り上がる
      if (!grounded && c.top - prevFeet <= P.edgeForgive && Math.hypot(this.vel.x, this.vel.z) < P.edgeForgiveSpeed) continue; // 空中でも、上面すれすれ(足が上面の0.45m以内)の低速接触は壁にせず、上へ乗り上げる
      const cx = clamp(this.pos.x, c.minX, c.maxX), cz = clamp(this.pos.z, c.minZ, c.maxZ);
      let nx = this.pos.x - cx, nz = this.pos.z - cz, pen: number;
      const d = Math.sqrt(nx * nx + nz * nz);
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
        const hs = Math.hypot(this.vel.x, this.vel.z), graze = this.wallRecovery && -vn / Math.max(hs, 0.1) < P.grazeIncidence;
        const bounce = graze ? 1 : this.wallRecovery ? P.wallBounce : 1.2; this.vel.x -= bounce * vn * nx; this.vel.z -= bounce * vn * nz; // かすりは壁に沿って滑る(跳ね返さない)
        if (-vn > P.wallCrashSpeed) {
          if (graze) { this.vel.x *= P.grazeDrag; this.vel.z *= P.grazeDrag; this.grazes++; } // 翼先がかする程度: 軽い減速だけ
          else if (this.wallRecovery) { if (this.escapeGuard <= 0) { this.crash(); this.stun = P.wallStunTime; this.beginEscape(nx, nz, hs); } }
          else this.crash();
        }
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
