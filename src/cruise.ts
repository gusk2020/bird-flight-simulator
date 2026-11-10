import type { Flight, FlightInput } from "./flight";

/**
 * H9: 通常巡航の低速化と、操作による加速(ブースト)。
 * 仕組み: 飛行物理の空力を 1/speedScale² 倍にすると、揚力と重力・抗力の釣り合う速さが speedScale 倍になる(Flight.speedScale)。
 * 手動飛行の speedScale は、巡航のとき scale0(例 0.6)、羽ばたきの操作で boost(0〜1)が上がるほど 1(従来の物理=従来の最高速度)へ近づく。
 * 操作をやめると boost が少しずつ減り、加速した速さから徐々に低速巡航へ戻る。補助・操舵のしきい値は Flight.speedN(speed/speedScale)で比べるので、
 * どの boost でも「従来の物理での同じ状態」として扱える(失速・補助羽ばたき・上昇の制限が低速巡航でも従来どおり働く)。
 * オート周遊・自動着地・近接機動・地上では使わず、speedScale=1(従来の物理)のまま。オートの速さは従来と同じ。
 */
export const CRUISE = {
  enabled: true,
  scale0: 0.5,        // 巡航時の speedScale(従来の滑空 約10 m/s → 約 5 m/s)
  tapBoost: 0.12,     // 羽ばたき1回(タップ)で boost に足す量。約 1.2 秒に 1 回の羽ばたき(高度を保つだけ)では加速せず、それより速い連打で加速する
  holdRate: 0.9,      // 羽ばたきを押し続けている間に boost が増える速さ(1/s)
  grace: 0.6,         // 最後の羽ばたきから boost が減り始めるまでの秒数
  decay: 0.25,        // 減る速さ(1/s)。boost 1 → 0 に約 4 秒(速さが戻るのはさらに空気抵抗でゆっくり)
  slewUp: 0.9,        // speedScale の変化の速さの上限(1/s)。空力が急に変わって機体が跳ねないように
  slewDown: 0.12,
  brakeDecay: 0.5,    // ブレーキ中は boost が速く減る
  maxN: 16,           // 速さ/speedScale がこれ(従来の釣り合う滑空速度)を超える状態にはしない。急降下の速さ・開始時の速さのまま空力だけ強くすると、揚力が大きすぎて機体が跳ね上がるため、速いうちは speedScale を速さに合わせて持ち上げ、減速に合わせて徐々に下げる
};

export class CruiseGovernor {
  boost = 0; last = -99; private prevTap = false; taps = 0;
  reset(f?: Flight) { this.boost = 0; this.last = -99; this.prevTap = false; if (f) f.speedScale = CRUISE.enabled ? CRUISE.scale0 : 1; }
  /** 物理 1 ステップごとに呼ぶ。inp は人の操作(補助が足す前)。full=true のときは従来の物理(オート・自動着地・近接機動・地上) */
  update(f: Flight, inp: FlightInput, dt: number, full: boolean, hold = false) {
    if (!CRUISE.enabled) { f.speedScale = 1; return; }
    if (hold) return; // 自動着地の進入中は、空力を変えない(進入の途中で揚力が変わらないように)
    const air = f.mode === "air";
    const tap = air && (inp.flapTap || inp.flapHeld);
    if (inp.flapTap && !this.prevTap) { this.boost = Math.min(1, this.boost + CRUISE.tapBoost); this.last = f.clock; this.taps++; }
    if (air && inp.flapHeld) { this.boost = Math.min(1, this.boost + CRUISE.holdRate * dt); this.last = f.clock; }
    this.prevTap = !!inp.flapTap && tap;
    if (f.clock - this.last > CRUISE.grace) this.boost = Math.max(0, this.boost - (inp.brake ? CRUISE.brakeDecay : CRUISE.decay) * dt);
    else if (inp.brake) this.boost = Math.max(0, this.boost - CRUISE.brakeDecay * dt);
    const target = full || !air ? 1 : CRUISE.scale0 + (1 - CRUISE.scale0) * this.boost;
    const floor = Math.min(1, Math.max(CRUISE.scale0, f.speed / CRUISE.maxN)); // 速さに対する下限(これより下げない)
    if (f.speedScale < floor) f.speedScale = floor;
    const d = Math.max(target, floor) - f.speedScale, r = d > 0 ? CRUISE.slewUp : CRUISE.slewDown;
    f.speedScale += Math.max(-r * dt, Math.min(r * dt, d));
  }
}
