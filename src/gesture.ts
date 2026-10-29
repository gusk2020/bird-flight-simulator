/** 片手操作のタッチ判定(DOM非依存)。しきい値はここに集約: 実機で調整するときはこの定数だけ触る。 */
export const GESTURE = {
  moveThresholdPx: 16,   // これ以上動いたら「スティック操作」(タップ・長押しにはならない)。親指の小さなぶれをタップとして残すため12→16
  longPressMs: 300,      // 動かさずこれ以上押し続けたら長押し(減速/地上では歩く)。これより短く離せばタップ(羽ばたき/小ジャンプ)=間に「どちらでもない」空白時間は作らない
  deadzone: 0.12,
  expo: 1.5,             // 小さな倒しをより小さく(中央付近は穏やか、端まで倒せば最大)。急な旋回・昇降を防ぐ
  radiusPx(w: number, h: number) { return Math.max(45, Math.min(75, Math.min(w, h) * 0.13)); },
};
/** 不感帯の外側を0から始まるよう詰め直し、指数カーブをかける(不感帯の境目で値が跳ばない) */
const shape = (v: number) => { const a = Math.abs(v), d = GESTURE.deadzone; if (a <= d) return 0; return Math.sign(v) * Math.pow((a - d) / (1 - d), GESTURE.expo); };
type Phase = "idle" | "pending" | "stick" | "brake";

/**
 * 1本の指(最初に触れたpointerId)だけを追う。
 *  pending → 動いた: stick(以後は時間が経っても長押しにならない) / 時間が経った: brake(離しても羽ばたかない) / 短く離した: タップ
 */
export class OneHandGesture {
  phase: Phase = "idle"; x = 0; y = 0; brake = false;
  id = -1; ox = 0; oy = 0; R = 60; private t0 = 0; private taps = 0;
  get active() { return this.phase !== "idle"; }
  get stickShown() { return this.phase !== "idle"; }
  down(id: number, x: number, y: number, t: number, radius = 60): boolean {
    if (this.phase !== "idle") return false; // 2本目以降の指は無視
    this.id = id; this.ox = x; this.oy = y; this.t0 = t; this.R = radius; this.phase = "pending"; this.x = this.y = 0; this.brake = false; return true;
  }
  move(id: number, x: number, y: number) {
    if (id !== this.id || this.phase === "idle") return;
    const dx = x - this.ox, dy = y - this.oy;
    if (this.phase === "pending" || this.phase === "brake") {
      if (dx * dx + dy * dy < GESTURE.moveThresholdPx ** 2) return;
      this.phase = "stick"; this.brake = false; // 長押し中に動かした場合も、スティックに切り替わり減速は解除
    }
    let nx = dx / this.R, ny = dy / this.R; const m = Math.sqrt(nx * nx + ny * ny); if (m > 1) { nx /= m; ny /= m; }
    this.x = shape(nx); this.y = -shape(ny);
  }
  /** 時間経過の判定(物理ステップごとに呼ぶ) */
  poll(t: number) { if (this.phase === "pending" && t - this.t0 >= GESTURE.longPressMs) { this.phase = "brake"; this.brake = true; } }
  up(id: number, t: number) {
    if (id !== this.id || this.phase === "idle") return;
    if (this.phase === "pending" && t - this.t0 < GESTURE.longPressMs) this.taps++; // 長押し成立後・スティック後は羽ばたかない
    this.reset();
  }
  cancel() { this.reset(); }
  private reset() { this.phase = "idle"; this.id = -1; this.x = this.y = 0; this.brake = false; }
  consumeTap(): boolean { if (this.taps > 0) { this.taps--; return true; } return false; }
  clearTaps() { this.taps = 0; }
}
