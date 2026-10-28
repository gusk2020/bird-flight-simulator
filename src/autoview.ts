import type { Flight } from "./flight";
import type { TimeSpeed } from "./settings";
import { WEATHER, type WeatherDef } from "./weather";

/** オート中の「見せ方」: カメラの演出・時間の進み・天気の移り変わり。どれも物理には触れない(純粋な状態とロジック)。 */

// ---------------------------------------------------------------- カメラ
export interface Shot { yaw: number; dist: number; h: number; name: string }
/** yaw: 鳥の向きに対するカメラの周回角(0=真後ろ)  dist: 通常距離に対する倍率(0.12=ほぼ一人称)  h: 追加の高さ(m) */
export const SHOTS: Record<string, Shot> = {
  chase: { yaw: 0, dist: 1, h: 0, name: "chase" },
  wideChase: { yaw: 0, dist: 2.1, h: 1.5, name: "wideChase" },
  sideL: { yaw: 1.25, dist: 1.5, h: 0.5, name: "sideL" },
  sideR: { yaw: -1.25, dist: 1.5, h: 0.5, name: "sideR" },
  high: { yaw: 0.35, dist: 1.9, h: 4.5, name: "high" },
  front: { yaw: 3.0, dist: 1.5, h: 0.6, name: "front" },
  first: { yaw: 0, dist: 0.12, h: 0, name: "first" },
};
const CALM = ["wideChase", "sideL", "sideR", "high", "front", "first", "chase"];
const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
export const FIRST_PERSON_BELOW = 0.3; // dist倍率がこれ未満なら鳥を隠す

export class CameraDirector {
  shot: Shot = SHOTS.chase; held = 0; switches = 0; private r: () => number; private next = 6;
  constructor(seed = 1) { this.r = rng(seed); }
  /** 危険な場面(急降下・着地・衝突・低空)では必ず追従に戻す。それ以外は10〜20秒ごとに別のカットへ。 */
  safe(f: Flight) { return f.mode === "air" && f.stun <= 0 && f.vel.y > -7 && f.agl > 9 && !f.stall; }
  update(dt: number, f: Flight): Shot {
    this.held += dt;
    if (!this.safe(f)) { if (this.shot !== SHOTS.chase) this.set(SHOTS.chase); this.next = Math.max(this.next, this.held + 4); return this.shot; }
    if (this.held >= this.next) {
      let pick = SHOTS[CALM[Math.floor(this.r() * CALM.length)]];
      if (pick === this.shot) pick = SHOTS.chase;
      if (pick.name === "first" && f.agl < 18) pick = SHOTS.wideChase; // 一人称は十分な高さがあるときだけ
      this.set(pick);
    }
    return this.shot;
  }
  private set(s: Shot) { this.shot = s; this.held = 0; this.switches++; this.next = 10 + this.r() * 10; }
  reset() { this.shot = SHOTS.chase; this.held = 0; this.next = 6; }
}

// ---------------------------------------------------------------- 時間
/** オート中に1日(24時間)にかける秒数。ゆったり=20分/標準=10分/高速=3分 */
export const AUTO_DAY_SECONDS: Record<TimeSpeed, number> = { slow: 20 * 60, normal: 10 * 60, fast: 3 * 60 };
export const autoHoursPerSecond = (s: TimeSpeed) => 24 / AUTO_DAY_SECONDS[s];

// ---------------------------------------------------------------- 天気
/** 天気の連続値: 0=晴 1=曇 2=雨。定義(WEATHER)の間を線形補間するので、切替で画面がパッと変わらない。 */
export function weatherAtLevel(level: number): WeatherDef {
  const l = Math.max(0, Math.min(2, level)), i = Math.min(1, Math.floor(l)), t = l - i;
  const a = WEATHER[(["clear", "cloudy", "rain"] as const)[i]], b = WEATHER[(["clear", "cloudy", "rain"] as const)[i + 1]];
  const m = (x: number, y: number) => x + (y - x) * t;
  return { name: t < 0.5 ? a.name : b.name, sun: m(a.sun, b.sun), hemi: m(a.hemi, b.hemi), grey: m(a.grey, b.grey), fogNear: m(a.fogNear, b.fogNear), fogFar: m(a.fogFar, b.fogFar), cloudOpacity: m(a.cloudOpacity, b.cloudOpacity), liftScale: m(a.liftScale, b.liftScale), dragScale: m(a.dragScale, b.dragScale), rain: m(a.rain, b.rain), windMul: m(a.windMul, b.windMul) };
}
/** ゆっくり移り変わる天気。目標を30〜90秒おきに決め、連続値を一定の速さで寄せていく(毎秒の点滅はしない)。 */
export class WeatherDrift {
  level: number; target: number; private r: () => number; private wait = 0; changes = 0;
  static readonly RATE = 1 / 60; // 晴→曇を約60秒かけて変える
  constructor(start: number, seed = 1) { this.level = start; this.target = start; this.r = rng(seed); this.wait = 30 + this.r() * 40; }
  update(dt: number): number {
    this.wait -= dt;
    if (this.wait <= 0) {
      this.wait = 45 + this.r() * 75;
      const x = this.r(); // 晴を多め、雨は少なめ
      const t = x < 0.5 ? 0 : x < 0.85 ? 1 : 2;
      if (t !== this.target) { this.target = t; this.changes++; }
    }
    const d = this.target - this.level, step = WeatherDrift.RATE * dt;
    this.level = Math.abs(d) <= step ? this.target : this.level + Math.sign(d) * step;
    return this.level;
  }
}

// ---------------------------------------------------------------- UI自動非表示
export const UI_HIDE_AFTER_S = 5;
export class UiHider {
  idle = 0; hidden = false;
  /** 触れた/動かした */ touch() { this.idle = 0; this.hidden = false; }
  /** active=オート中かつ自動非表示が有効。戻り値=いま隠すべきか */
  update(dt: number, active: boolean): boolean {
    if (!active) { this.idle = 0; this.hidden = false; return false; }
    this.idle += dt; if (this.idle >= UI_HIDE_AFTER_S) this.hidden = true;
    return this.hidden;
  }
}
