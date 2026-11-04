/**
 * H8-D 密集した着地点マーカーの「仮選択」。混同のおそれがある押し方(LandSpots.assess)のときだけ、1 回目のタップでは自動接近・着地を始めず、
 * 候補を仮選択して強調し、足場名と距離を示す。「ここへ接近」の確認(固定位置の大きなボタン)で初めて始める。
 * この層は「どの候補が仮選択か」と、その解除の理由だけを持つ。着地・接近の判断は AutoLand / Approach が従来どおり行う(確認する瞬間にも再検証する)。
 */
export const CONFIRM = { timeoutMs: 6000 };
export class SpotConfirm {
  id = -1; t0 = 0; lastWhy = "";
  stats = { asked: 0, reselected: 0, confirmed: 0, cancelled: 0, gone: 0, timeout: 0, off: 0, manual: 0, mode: 0, rejected: 0, goneBy: {} as Record<string, number> };
  get active() { return this.id >= 0; }
  /** 仮選択(別の候補が仮選択中なら、選び直し) */
  ask(id: number, nowMs: number) { if (this.id >= 0 && this.id !== id) this.stats.reselected++; this.id = id; this.t0 = nowMs; this.stats.asked++; }
  clear(why: string) {
    if (this.id < 0) return; this.lastWhy = why;
    if (why === "confirmed") this.stats.confirmed++; else if (why.startsWith("gone")) { this.stats.gone++; const k = why.slice(5) || "other"; this.stats.goneBy[k] = (this.stats.goneBy[k] || 0) + 1; }
    else if (why === "timeout") this.stats.timeout++; else if (why === "off") this.stats.off++; else if (why === "manual") this.stats.manual++; else if (why === "mode") this.stats.mode++; else if (why === "rejected") this.stats.rejected++; else this.stats.cancelled++;
    this.id = -1;
  }
  /** 毎フレーム: 候補が見えなくなった(背後・画面外・遮蔽・ボタンの上)か、期限切れなら解く。戻り値が true なら解いた。 */
  update(nowMs: number, visible: boolean, whyGone: string | null): boolean {
    if (this.id < 0) return false;
    if (!visible) { this.clear("gone:" + (whyGone ?? "other")); return true; }
    if (nowMs - this.t0 > CONFIRM.timeoutMs) { this.clear("timeout"); return true; }
    return false;
  }
}
