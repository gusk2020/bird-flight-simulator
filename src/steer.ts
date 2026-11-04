import type { Flight, FlightInput } from "./flight";
import type { PadRect } from "./proxpad";

/**
 * H8-A: 単一◎の操縦 3 方式(A: スワイプ指定 / B: 動かして操舵 / C: 中心でブレーキ)。
 * 構成は 2 層。どの方式も物理(flight.ts)・操縦補助(FlapAssist など)・障害物回避は同じで、違うのは入力の読み取り(SteerPad)だけ。
 *   SteerPad   : 指の動きを「進みたい方向・ブレーキ・タップ」に読み取る(DOM 非依存の状態機械)。方式ごとの違いはここだけ。
 *   SteerLayer : その結果を、いまの鳥の向きから見た操舵の入力(x, y)に直す。既存の FlightInput を作るだけで、飛行の計算には触らない。
 * 実機(Pixel 7a)での操作感は未確認。しきい値は STEER に集約している。
 */
export type SteerMode = "off" | "A" | "B" | "C";
export const STEER_MODES: SteerMode[] = ["off", "A", "B", "C"];
export const STEER_NAMES: Record<SteerMode, string> = { off: "従来", A: "A スワイプ", B: "B 動かして操舵", C: "C 中心でブレーキ" };
export const STEER_SHORT: Record<SteerMode, string> = { off: "従来", A: "A", B: "B", C: "C" };

export const STEER = {
  tapMs: 300,          // これより短く、動かさずに離せばタップ(羽ばたき/加速)
  swipePx: 16,         // 触れ始めからこれ以上動いたら「動かした」(タップ・長押しにはならない)
  jitterPx: 6,         // これ未満の動きは指の揺れとして無視する(B: 止まっている判定)
  dead: 0.2,           // ◎の半径に対する不感帯(この内側は方向なし)
  centerFrac: 0.3,     // C: ◎の中心とみなす範囲(半径比)
  maxYawDeg: 110,      // 指が真横(端)のとき、触れ始めの進行方向から曲がる角度
  maxPitchDeg: 25,     // 指が真上/真下(端)のときの上昇/降下の角度
  frameK: 6, maxNeedMs: 1500, // 描画が遅いとき(1フレームが長いとき)は、ブレーキの判定に必要な長さを「1フレームの長さ×frameK」まで延ばす(指を離すイベントが数フレーム遅れて届いても、タップを長押しと誤判定しない。60fpsなら300msのまま)
  holdBrakeMs: 300,    // 動かさず押し続けたらブレーキ(A・B)
  stopBrakeMs: 650,    // B: 動かしたあと、指が止まってからブレーキになるまで
  centerBrakeMs: 300,  // C: 中心を押し続けたらブレーキ
  trackDeferMs: 140,   // C: 周辺を押してから進路を更新し始めるまで(短いタップで進路が動かないように)
  turnGain: 1.6, pitchGain: 2.5, slewX: 2.5, slewY: 2.0, // 操舵の強さと、入力の変化の速さの上限(1/s)。ふらつきを抑える
  pitchFull: 0.45, pitchHoldS: 2.5, climbMaxRad: 0.3, climbV0: 8, climbV1: 3, climbFlapV: 12, climbFlapGap: 0.4, // 上昇の目標角の上限(速さが climbV0 以下ならゼロ、climbV0+climbV1 以上で全開)
  reachYaw: 0.04, reachPitch: 0.04, courseMaxS: 5,        // 目標に着いたとみなす誤差と、目標を保つ最長時間
  chainMs: 1200, chainTaps: 3, chainHoldS: 0.7, speedCap: 15, // 連打: この間隔に chainTaps 回で、羽ばたきを一定時間続ける。速さの上限(これ以上は加速しない)
  groundUpDeg: 30, groundUpMag: 0.5, jumpCooldownS: 0.9, groundWalkMag: 0.25, groundWalkY: 0.7,
};
const DEG = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

type Phase = "idle" | "pending" | "steer" | "brake";
export interface SteerVec { mag: number; lateral: number; vertical: number; yawOff: number; pitch: number; centre: boolean; upSector: boolean }

/** 1 本の指(最初に触れた pointerId)だけを追う。2 本目以降は無視。 */
export class SteerPad {
  mode: SteerMode = "A";
  phase: Phase = "idle"; id = -1; refYaw = 0; x = 0; y = 0;
  brake = false; tapSeq = 0; courseSeq = 0; moved = false;
  /** 方式 A: 離した時点で確定した進路(世界の向き)。SteerLayer が受け取る */
  course: { yaw: number; pitch: number } | null = null;
  /** 描画が固まった区間を引いた経過ms(Input が与える)。既定は引かない */
  stall: (t0: number, t1: number) => number = (a, b) => b - a;
  /** タップかどうかの判定に使う経過ms(H6: 描画が固まった間に入った短いタップを、長押しと誤判定しない)。既定は stall と同じ */
  tapStall: (t0: number, t1: number) => number = (a, b) => b - a;
  private rect: PadRect = { cx: 0, cy: 0, r: 60 };
  private x0 = 0; private y0 = 0; private tDown = 0; private tSeen = 0; private lastPoll = -1; private gap = 0; private lastMoveT = 0; private ax = 0; private ay = 0; private centreSince = -1;
  get active() { return this.phase !== "idle"; }
  /** seen: このイベントを実際に処理した時刻(イベントの時刻 t より遅れて届くことがある)。ブレーキの時間は、届いた時刻から数える */
  down(id: number, x: number, y: number, t: number, rect: PadRect, refYaw: number, seen = t): boolean {
    if (this.phase !== "idle") return false;
    this.id = id; this.rect = rect; this.refYaw = refYaw; this.x = this.x0 = this.ax = x; this.y = this.y0 = this.ay = y; this.tDown = t; this.tSeen = this.lastMoveT = Math.max(t, seen); this.gap = this.gap || 0;
    this.phase = "pending"; this.brake = false; this.moved = false; this.centreSince = this.inCentre() ? Math.max(t, seen) : -1; return true;
  }
  private inCentre() { const { cx, cy, r } = this.rect; return Math.hypot(this.x - cx, this.y - cy) / r < STEER.centerFrac; }
  move(id: number, x: number, y: number, t: number, seen = t) {
    if (id !== this.id || this.phase === "idle") return;
    t = Math.max(t, seen); // 動きのタイミングも、届いた時刻で数える
    this.x = x; this.y = y;
    if (!this.moved && Math.hypot(x - this.x0, y - this.y0) > STEER.swipePx) { this.moved = true; this.phase = "steer"; this.brake = false; this.lastMoveT = t; this.ax = x; this.ay = y; } // 動かした: 長押し(ブレーキ)にはならない
    if (this.moved && Math.hypot(x - this.ax, y - this.ay) >= STEER.jitterPx) { this.ax = x; this.ay = y; this.lastMoveT = t; if (this.phase === "brake") this.phase = "steer"; } // 揺れより大きく動いた: 止まっていない
    if (this.mode === "C") { // C: 中心に入った時刻を覚える(中心から出れば、ブレーキは解ける)
      if (this.inCentre()) { if (this.centreSince < 0) this.centreSince = t; } else { this.centreSince = -1; if (this.phase === "brake") this.phase = this.moved ? "steer" : "pending"; }
    }
    this.brake = this.phase === "brake";
  }
  /** 時間による判定(物理ステップごと。now は performance.now() と同じ時計) */
  private need(ms: number) { return Math.max(ms, Math.min(STEER.maxNeedMs, STEER.frameK * this.gap)); }
  poll(now: number) {
    if (this.lastPoll >= 0 && now - this.lastPoll > 4) this.gap += (now - this.lastPoll - this.gap) * 0.3; // 1 フレームの長さ(同じフレーム内の物理ステップは数えない)
    this.lastPoll = now;
    if (this.phase === "idle") return;
    if (this.mode === "A") { if (this.phase === "pending" && !this.moved && this.stall(this.tSeen, now) >= this.need(STEER.holdBrakeMs)) this.phase = "brake"; }
    else if (this.mode === "B") {
      if (this.phase === "pending" && !this.moved && this.stall(this.tSeen, now) >= this.need(STEER.holdBrakeMs)) this.phase = "brake";
      else if (this.phase === "steer" && this.moved && this.stall(this.lastMoveT, now) >= this.need(STEER.stopBrakeMs)) this.phase = "brake";
    } else if (this.mode === "C") {
      if ((this.phase === "pending" || this.phase === "steer") && this.centreSince >= 0 && this.stall(this.centreSince, now) >= this.need(STEER.centerBrakeMs)) this.phase = "brake";
    }
    this.brake = this.phase === "brake";
  }
  up(id: number, t: number) {
    if (id !== this.id || this.phase === "idle") return;
    if ((this.phase === "pending" || this.phase === "brake") && !this.moved && this.tapStall(this.tDown, t) < STEER.tapMs) this.tapSeq++; // ブレーキが早く入ってしまっても、指を離したときのイベントの時刻で見て短ければタップ(描画が遅れて「離した」の到着が遅れた場合の救済) // 短く離した = タップ(長押し成立後・動かしたあとは羽ばたかない)
    if (this.mode === "A" && this.moved) { const v = this.vec(); if (v.mag > 0) { this.course = { yaw: wrap(this.refYaw + v.yawOff), pitch: v.pitch }; this.courseSeq++; } } // スワイプして離した: 進路を確定
    this.reset();
  }
  cancel() { this.reset(); }
  private reset() { this.lastPoll = -1; this.phase = "idle"; this.id = -1; this.brake = false; this.moved = false; this.centreSince = -1; }
  /** いまの指の位置 → 方向(◎の中心から見て。上=天、右=進行方向に対して右) */
  vec(): SteerVec {
    const { cx, cy, r } = this.rect, dx = (this.x - cx) / r, dy = (this.y - cy) / r, d = Math.hypot(dx, dy);
    const mag = d <= STEER.dead ? 0 : clamp((d - STEER.dead) / (1 - STEER.dead), 0, 1), ux = d > 1e-6 ? dx / d : 0, uy = d > 1e-6 ? dy / d : 0;
    const lateral = ux * mag, vertical = -uy * mag, phi = Math.atan2(ux, -uy); // 画面の真上=0
    return { mag, lateral, vertical, yawOff: -lateral * STEER.maxYawDeg * DEG, pitch: vertical * STEER.maxPitchDeg * DEG, centre: d < STEER.centerFrac, upSector: mag >= STEER.groundUpMag && Math.abs(phi) <= STEER.groundUpDeg * DEG };
  }
  /** いまの指の位置で進路(目標)を更新してよいか */
  steering(now: number): boolean {
    if (this.phase === "idle" || this.phase === "brake") return false;
    const v = this.vec(); if (v.mag <= 0) return false;
    if (this.mode === "A") return false; // A は離した時点で決める
    if (this.mode === "B") return this.moved;
    return !v.centre && this.stall(this.tDown, now) >= STEER.trackDeferMs; // C: 周辺を押している間
  }
}

export interface SteerSample { t: number; speed: number; yawRate: number; camRate: number; brake: boolean; finger: boolean }
/** 3 方式に共通の操舵層。既存の飛行物理・操縦補助の上に、FlightInput(x, y, 羽ばたき, ブレーキ)を作る。 */
export class SteerLayer {
  yawT: number | null = null; pitchT: number | null = null;
  private tCourse = 0; private lx = 0; private ly = 0; private tapSeq = 0; private courseSeq = 0; private chain: number[] = []; private holdUntil = -1; private lastJump = -9; private lastFlap = -9; private wasUp = false; private prevYaw = 0; private prevSpeed = 0;
  /** 開発用の記録: 1 秒ごとの速さ・旋回の角速度・カメラの角速度・ブレーキ・指 */
  samples: SteerSample[] = []; private acc = { n: 0, speed: 0, yaw: 0, cam: 0, brake: false, finger: false, t: 0 };
  resetStats() { this.stats = { taps: 0, chains: 0, capped: 0, brakeFrames: 0, courseSets: 0, climbFlaps: 0, maxYawRate: 0, maxCamRate: 0, speedJumps: 0 }; }
  stats = { taps: 0, chains: 0, capped: 0, brakeFrames: 0, courseSets: 0, climbFlaps: 0, maxYawRate: 0, maxCamRate: 0, speedJumps: 0 };
  reset() { this.yawT = this.pitchT = null; this.lx = this.ly = 0; this.chain.length = 0; this.holdUntil = -1; this.wasUp = false; }
  camSample(rate: number) { this.acc.cam = Math.max(this.acc.cam, rate); this.stats.maxCamRate = Math.max(this.stats.maxCamRate, rate); }
  /** 物理ステップごと。raw は Input.read() の結果(キーボード分を含む)。f.clock は秒 */
  apply(f: Flight, raw: FlightInput, pad: SteerPad, dt: number, autoLandActive: boolean, now: number): FlightInput {
    const v = pad.vec(), act = pad.active, t = f.clock;
    // --- タップ(羽ばたき/加速)と連打 ---
    while (this.tapSeq < pad.tapSeq) { this.tapSeq++; this.stats.taps++; this.chain.push(t); }
    while (this.chain.length && t - this.chain[0] > STEER.chainMs / 1000) this.chain.shift();
    if (this.chain.length >= STEER.chainTaps && this.holdUntil < t) { this.holdUntil = t + STEER.chainHoldS; this.stats.chains++; this.chain.length = 0; }
    if (this.holdUntil > t && f.mode === "air") raw.flapHeld = true;
    if (f.mode === "air" && f.speed > STEER.speedCap) { if (raw.flapTap || raw.flapHeld) this.stats.capped++; raw.flapTap = false; raw.flapHeld = false; } // 加速には上限(これ以上は羽ばたいても速くならない)
    raw.brake = raw.brake || pad.brake; if (pad.brake) this.stats.brakeFrames++;
    if (autoLandActive) { // 自動着地の進入中: 方向の指示は使わない。指が大きく動いたら手動へ戻れるよう、スティックと同じ形で渡す(取消は AutoLand が判断)
      this.reset(); if (act) { raw.x = v.lateral; raw.y = v.vertical; } this.record(f, dt, raw, act); return raw;
    }
    if (f.mode === "air") {
      while (this.courseSeq < pad.courseSeq && pad.course) { this.courseSeq++; this.yawT = pad.course.yaw; this.pitchT = pad.course.pitch; this.tCourse = t; this.stats.courseSets++; }
      const live = act && pad.steering(now);
      if (live) { this.yawT = wrap(pad.refYaw + v.yawOff); this.pitchT = v.pitch; this.tCourse = t; }
      if ((this.yawT !== null || this.pitchT !== null) && t - this.tCourse > STEER.courseMaxS) { this.yawT = this.pitchT = null; }
      let x = 0, y = 0;
      if (this.yawT !== null) { const ex = wrap(this.yawT - f.yaw); if (Math.abs(ex) < STEER.reachYaw && !live) this.yawT = null; else x = -clamp(ex * STEER.turnGain, -1, 1); } // 右へ曲がる = x が正 = yaw が減る
      if (this.pitchT !== null) {
        // 上下は「目標の角度に比例した操舵」(開ループ)。飛行経路角を追いかけるフィードバックにすると、失速ぎみのときに機首を引き上げ続けて失速から出られなくなる(実測)
        if (this.pitchT > 0.1 && f.speed < STEER.climbFlapV && f.strokeT < 0 && t - this.lastFlap > STEER.climbFlapGap) { raw.flapTap = true; this.lastFlap = t; this.stats.climbFlaps++; } // 上昇には羽ばたきが要る: 速さが足りなければ自動で羽ばたく
        const pT = this.pitchT > 0 ? Math.min(this.pitchT, STEER.climbMaxRad * clamp((f.speed - STEER.climbV0) / STEER.climbV1, 0, 1)) : this.pitchT; // 遅いときは上昇を弱める
        y = clamp(pT / STEER.pitchFull, -1, 1);
        if (!live && t - this.tCourse > STEER.pitchHoldS) this.pitchT = null; // 離したあと、上下の指示は少しのあいだだけ保つ(ずっと上がり続けない)
      }
      // 入力の変化の速さに上限(カメラのふらつき・左右の振れを抑える)
      this.lx += clamp(x - this.lx, -STEER.slewX * dt, STEER.slewX * dt); this.ly += clamp(y - this.ly, -STEER.slewY * dt, STEER.slewY * dt);
      raw.x += this.lx; raw.y += this.ly;
    } else { // 地上・電線・走り出し: 同じ◎で向き直って前進歩行(後退しない)。上=小ジャンプ。短いタップ=羽ばたき(小ジャンプ→離陸)
      this.yawT = this.pitchT = null; this.lx = this.ly = 0;
      if (act) {
        raw.x += v.lateral;
        if (v.upSector) { if (!this.wasUp && t - this.lastJump > STEER.jumpCooldownS) { raw.flapTap = true; this.lastJump = t; } }
        else if (v.mag >= STEER.groundWalkMag) raw.y += STEER.groundWalkY; // 後退はない: 下でも前へ歩く
        this.wasUp = v.upSector;
      } else this.wasUp = false;
    }
    this.record(f, dt, raw, act); return raw;
  }
  private record(f: Flight, dt: number, raw: FlightInput, finger: boolean) {
    const yr = Math.abs(wrap(f.yaw - this.prevYaw)) / Math.max(dt, 1e-3); this.prevYaw = f.yaw;
    if (this.prevSpeed > 0 && Math.abs(f.speed - this.prevSpeed) / Math.max(dt, 1e-3) > 90) this.stats.speedJumps++; this.prevSpeed = f.speed; // 1 ステップで 90 m/s² を超える速さの変化(ワープ・急停止の検出)
    this.stats.maxYawRate = Math.max(this.stats.maxYawRate, yr);
    const a = this.acc; a.n++; a.speed += f.speed; a.yaw = Math.max(a.yaw, yr); a.brake = a.brake || raw.brake; a.finger = a.finger || finger; a.t += dt;
    if (a.t >= 1) { this.samples.push({ t: +f.clock.toFixed(1), speed: +(a.speed / a.n).toFixed(2), yawRate: +a.yaw.toFixed(2), camRate: +a.cam.toFixed(2), brake: a.brake, finger: a.finger }); if (this.samples.length > 600) this.samples.shift(); this.acc = { n: 0, speed: 0, yaw: 0, cam: 0, brake: false, finger: false, t: 0 }; }
  }
}
