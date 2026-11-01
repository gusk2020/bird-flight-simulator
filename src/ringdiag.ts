/** H2 着地候補(◯)の表示判定と診断。表示の可否は一か所(ringVisible)で決め、隠れている理由と直近の切り替わりを開発用ログに残す。
 *  表示の保持(PerchAssist.marker の5秒)と、安全に着地を始められるか(AutoLand.check)は別: 古い候補は薄く表示し、タップしても開始は毎回あらためて検査される。 */
export type RingReason = "shown" | "no-marker" | "autopilot" | "not-air" | "hopping" | "stunned" | "out-of-range" | "behind-camera" | "off-screen" | "edge" | "autoland-shown";
export interface RingInput { auto: boolean; mode: string; hopping: boolean; stun: number; hasMarker: boolean; d: number; maxD: number; sx: number; sy: number; sz: number; autoLand: boolean }
/** 画面の外へ出たとみなす範囲(正規化座標)。中心が画面の中にあるときだけ表示する(中心が画面の外では、押せない◯を出すことになる。縦画面の計測で実際に起きた) */
export const RING_VIEW = { limit: 1.0 };
export function ringVisible(c: RingInput): { show: boolean; reason: RingReason } {
  if (c.auto) return { show: false, reason: "autopilot" };
  if (!c.hasMarker) return { show: false, reason: "no-marker" };
  if (c.mode !== "air") return { show: false, reason: "not-air" };
  if (c.hopping) return { show: false, reason: "hopping" };
  if (c.stun > 0) return { show: false, reason: "stunned" };
  if (!(c.d < c.maxD)) return { show: false, reason: "out-of-range" };
  // 画面の外・後ろにあるときは消さずに、画面の縁に小さな◯を出して方向を示す(押せば、その足場への着地を始める)。「すぐ消える」の主な原因だった
  if (!(c.sz < 1) || !(Math.abs(c.sx) < RING_VIEW.limit && Math.abs(c.sy) < RING_VIEW.limit)) return { show: true, reason: "edge" };
  return { show: true, reason: c.autoLand ? "autoland-shown" : "shown" };
}
export interface RingEvent { t: number; reason: RingReason; kind: string; d: number; age: number; stale: boolean }
export class RingDiag {
  reason: RingReason = "no-marker"; kind = ""; d = 0; age = 0; stale = false; shownSince = -1; lastShownFor = 0;
  log: RingEvent[] = []; counts: Record<string, number> = {};
  /** 毎フレーム。reason が変わったときだけ記録する(最大40件) */
  update(t: number, reason: RingReason, kind: string, d: number, age: number, stale: boolean) {
    this.counts[reason] = (this.counts[reason] || 0) + 1;
    const vis = reason === "shown" || reason === "autoland-shown" || reason === "edge", was = this.reason === "shown" || this.reason === "autoland-shown" || this.reason === "edge";
    if (vis && !was) this.shownSince = t; if (!vis && was) this.lastShownFor = t - this.shownSince;
    if (reason !== this.reason) { this.log.push({ t: +t.toFixed(2), reason, kind, d: +d.toFixed(1), age: +age.toFixed(1), stale }); if (this.log.length > 40) this.log.shift(); }
    this.reason = reason; this.kind = kind; this.d = d; this.age = age; this.stale = stale;
  }
  text() { return `◯ ${this.reason}${this.kind ? " " + this.kind : ""} d=${this.d.toFixed(1)} age=${this.age.toFixed(1)}s${this.stale ? " stale" : ""}`; }
}

/** 画面の外・後ろにある◯を、画面の縁(余白 margin px)の上に置く位置。後ろにあるときは向きを反転する */
export function edgePosition(sx: number, sy: number, sz: number, w: number, h: number, margin = 36, top = 72): { x: number; y: number } {
  let dx = sx, dy = sy; if (sz >= 1) { dx = -dx; dy = -dy; }
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = -1; // 真後ろ・真正面でも向きを決める(下へ)
  // 上の端は、上部のボタン列(約50 px)と重ならないよう top まで下げる。縁の箱 [margin, w-margin] x [top, h-margin] の中心から dx,dy の向きへ伸ばして箱の縁に当てる
  const cx = w / 2, cy = (top + (h - margin)) / 2, hx = w / 2 - margin, hy = (h - margin - top) / 2;
  const k = Math.min(hx / Math.max(Math.abs(dx), 1e-6), hy / Math.max(Math.abs(dy), 1e-6));
  return { x: cx + dx * k, y: cy - dy * k };
}
