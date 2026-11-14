import type { Input } from "./input";
import { padLayout, type PadCustom, type PadLayout, type PadRect } from "./proxpad";
import type { ControlMode, Prefs } from "./settings";

/**
 * H9: 起動時の 3 画面(① 環境設定 → ② 操作UI設定 → ③ 開始)と、一時停止中の設定の出し入れ、◎の配置プレビュー(ドラッグで位置を決める)。
 * 設定の項目そのものは main.ts の data-set ボタンのまま(削らず、画面に振り分け直しただけ)。ここは画面の切替と配置プレビューだけを受け持つ。
 * 「オート」「自分で操作」は③でだけ押せる。どちらかを押したときだけ開始する。
 */
export type Page = "env" | "ctl" | "start" | "pause";
export interface SetupDeps { input: Input; prefs: Prefs; save: () => void; getCtl: () => ControlMode; getSteer: () => string; relayout: () => void }
const $ = (id: string) => document.getElementById(id)!;
const PREVIEW = { maxW: 300, maxH: 220 };

export class SetupUi {
  page: Page = "env"; private ready = true; private fromPause = false; private drag: { id: "prox" | "cruise"; pid: number } | null = null; dragEvents = 0;
  constructor(private d: SetupDeps) {
    $("envNext").addEventListener("click", () => this.show("ctl"));
    $("envBack").addEventListener("click", () => this.show("pause"));
    $("ctlBack").addEventListener("click", () => this.show("env"));
    $("ctlNext").addEventListener("click", () => this.show(this.fromPause ? "pause" : "start"));
    $("ovBack").addEventListener("click", () => this.show("ctl"));
    $("ovEnv").addEventListener("click", () => { this.fromPause = true; this.show("env"); });
    $("ovCtl").addEventListener("click", () => { this.fromPause = true; this.show("ctl"); });
    $("padReset").addEventListener("click", () => { this.setCustom(null); this.d.prefs.pads[this.key()] = null; this.d.save(); this.d.relayout(); this.render(); });
    for (const id of ["prox", "cruise"] as const) {
      const el = $(id === "prox" ? "pvProx" : "pvCruise");
      el.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); this.drag = { id, pid: e.pointerId }; try { el.setPointerCapture(e.pointerId); } catch { /* 合成イベント */ } this.dragEvents++; });
      el.addEventListener("pointermove", e => { if (!this.drag || this.drag.pid !== e.pointerId) return; e.preventDefault(); e.stopPropagation(); this.moveTo(id, e.clientX, e.clientY); });
      const end = (e: PointerEvent) => { if (!this.drag || this.drag.pid !== e.pointerId) return; e.stopPropagation(); this.drag = null; this.d.prefs.pads[this.key()] = this.custom(); this.d.save(); this.d.relayout(); };
      el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
    }
    addEventListener("resize", () => { if (!$("pgCtl").hidden) this.render(); });
  }
  private key(): "land" | "port" { return innerWidth > innerHeight ? "land" : "port"; }
  private custom(): PadCustom | null { return this.d.input.pads[this.key()]; }
  private setCustom(c: PadCustom | null) { this.d.input.pads[this.key()] = c; }
  private mode(): "right" | "left" { return this.d.getCtl() === "left" ? "left" : "right"; }
  private layout(): PadLayout { return padLayout(innerWidth, innerHeight, this.mode(), this.custom(), this.d.input.insets); }
  private toPos(r: PadRect) { const m = this.mode(); return { fx: m === "right" ? r.cx / innerWidth : 1 - r.cx / innerWidth, fy: r.cy / innerHeight }; }
  /** 設定画面の準備状態に合わせて、表示するページを選ぶ。ready=起動前(3 画面の流れ) / それ以外=一時停止中 */
  sync(ready: boolean) { const was = this.ready; this.ready = ready; if (ready !== was || this.page === (ready ? "pause" : "start")) { this.fromPause = false; this.show(ready ? "env" : "pause"); } else this.show(this.page); }
  show(p: Page) {
    this.page = p;
    for (const [id, name] of [["pgEnv", "env"], ["pgCtl", "ctl"], ["pgStart", "start"], ["pgPause", "pause"]] as const) $(id).hidden = name !== p;
    $("ovFoot").hidden = !(p === "start" || p === "pause");
    $("ovBack").hidden = !(this.ready && p === "start"); $("ovReset").hidden = this.ready; $("ovAuto").hidden = !(p === "start" || p === "pause");
    $("envBack").hidden = !this.fromPause; $("envNext").textContent = "次へ: 操作UI設定 →"; $("ctlNext").textContent = this.fromPause ? "一時停止へもどる" : "次へ: 開始 →";
    $("ctlBack").hidden = false;
    if (p === "ctl") this.render();
    if (p === "start") this.summary();
    $("ovTitle").textContent = this.ready ? "Vind Ving" : "一時停止中";
  }
  summary() {
    const ctl = this.d.getCtl(), st = this.d.getSteer(), names: Record<string, string> = { both: "両手", right: "右手", left: "左手" };
    $("startSummary").textContent = "操作: " + names[ctl] + (ctl !== "both" ? "(" + (st === "off" ? "従来の2つの◎" : "単一◎ " + st) + ")" : "") + "　設定は「← 設定に戻る」でいつでも変えられます";
  }
  private moveTo(id: "prox" | "cruise", cx: number, cy: number) {
    const pv = $("padPreview").getBoundingClientRect(), sc = pv.width / innerWidth, L0 = this.layout();
    const base = this.custom() ?? { prox: this.toPos(L0.prox), cruise: this.toPos(L0.cruise) };
    const m = this.mode(), x = (cx - pv.left) / sc, y = (cy - pv.top) / sc, pos = { fx: Math.min(1, Math.max(0, m === "right" ? x / innerWidth : 1 - x / innerWidth)), fy: Math.min(1, Math.max(0, y / innerHeight)) };
    this.setCustom({ ...base, [id]: pos } as PadCustom);
    // 補正後(範囲内・重なりなし)の位置を保存する値へ戻す: 画面の外へ出した指が、見えている位置と食い違わないように
    const L = this.layout(); this.setCustom({ prox: this.toPos(L.prox), cruise: this.toPos(L.cruise) }); this.render();
  }
  /** 配置プレビューを現在の画面(縦/横)の縮尺で描く */
  render() {
    const ctl = this.d.getCtl(), steer = this.d.getSteer(), one = ctl !== "both", single = one && steer !== "off";
    const box = $("padPreview"), note = $("padNote"), aspect = innerWidth / Math.max(1, innerHeight);
    let w = Math.min(PREVIEW.maxW, innerWidth - 40), h = w / aspect; if (h > PREVIEW.maxH) { h = PREVIEW.maxH; w = h * aspect; }
    box.style.width = Math.round(w) + "px"; box.style.height = Math.round(h) + "px"; box.hidden = !one; $("padReset").hidden = !one;
    note.textContent = !one ? "両手操作では◎は使いません(左: スティック / 右: 羽ばたき・減速ボタン)" : (single ? "◎をドラッグして位置を決めます(単一◎ " + steer + ")" : "2つの◎をそれぞれドラッグして位置を決めます") + "　" + (innerWidth > innerHeight ? "横画面" : "縦画面") + "の配置";
    if (!one) return;
    const L = this.layout(), sc = w / innerWidth;
    $("padBand").style.height = Math.round((Math.min(60, innerHeight * 0.15) + this.d.input.insets.t) * sc) + "px";
    const put = (id: string, r: PadRect, show: boolean, text: string) => { const el = $(id); el.style.display = show ? "flex" : "none"; const dpx = Math.max(26, r.r * 2 * sc); el.style.width = el.style.height = Math.round(dpx) + "px"; el.style.left = Math.round(r.cx * sc) + "px"; el.style.top = Math.round(r.cy * sc) + "px"; el.textContent = text; };
    put("pvProx", L.prox, true, single ? steer : "近接"); put("pvCruise", L.cruise, !single, "巡航");
  }
  /** 試験用: 指定した要素を含むページを表示する(overlay が出ているときだけ) */
  revealFor(sel: string) { if ($("overlay").hidden) return; const el = document.querySelector(sel); const pg = el?.closest(".page") as HTMLElement | null; if (!pg || !pg.hidden) { if (el?.closest("#ovFoot") && $("ovFoot").hidden) this.show(this.ready ? "start" : "pause"); return; } const map: Record<string, Page> = { pgEnv: "env", pgCtl: "ctl", pgStart: "start", pgPause: "pause" }; this.show(map[pg.id]); }
}
