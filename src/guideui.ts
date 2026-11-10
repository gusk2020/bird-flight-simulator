import type { GuideMode } from "./settings";
import type { GuideValues } from "./guide";
import { compassName } from "./guide";

/**
 * H9: 飛行ガイドの表示。off=何も作らず・更新しない(描画負荷なし) / gauge=画面の左上の小さな計器 / hud=飛行画面に重ねる HUD。
 * どのモードも、標高・地上高(m)、方位と進行方位(度)、ピッチ・ロール(度)、対地速度・対気速度(km/h)を数値で並べる。段階ゲージは出さない。
 * タッチは受けない(pointer-events: none)。◎・ボタンのある画面の下の隅と右上のボタン列には置かない。
 */
const FIELDS: [string, string][] = [["elev", "標高"], ["agl", "地上高"], ["hdg", "方位"], ["trk", "進行"], ["pit", "ピッチ"], ["rol", "ロール"], ["gs", "対地"], ["tas", "対気"]];
export class GuideView {
  mode: GuideMode = "off"; private root: HTMLElement | null = null; private txt: Record<string, HTMLElement> = {}; private horizon: HTMLElement | null = null; private last: Record<string, string> = {}; private acc = 0; updates = 0;
  setMode(m: GuideMode) { this.mode = m; if (m === "off") { if (this.root) this.root.style.display = "none"; return; } this.build(); this.root!.dataset.mode = m; this.root!.style.display = "block"; this.last = {}; this.acc = 1; }
  private build() {
    if (this.root) return;
    const r = document.createElement("div"); r.id = "guide"; this.root = r;
    r.innerHTML = `<div id="gvHorizon"><div id="gvSky"></div><div id="gvLine"></div></div>` + FIELDS.map(([k, n]) => `<div class="gv gv-${k}"><span class="gl">${n}</span><b id="gv-${k}">-</b></div>`).join("");
    document.body.appendChild(r); for (const [k] of FIELDS) this.txt[k] = document.getElementById("gv-" + k)!; this.horizon = document.getElementById("gvLine");
  }
  private set(k: string, v: string) { if (this.last[k] !== v) { this.last[k] = v; this.txt[k].textContent = v; } }
  /** 毎フレーム呼んでよい(内部で約 15 Hz に間引く)。values は guideValues の結果 */
  update(dt: number, get: () => GuideValues) {
    if (this.mode === "off" || !this.root) return;
    this.acc += dt; if (this.acc < 1 / 15) return; this.acc = 0; this.updates++;
    const v = get();
    this.set("elev", Math.round(v.elevM) + " m"); this.set("agl", Math.round(v.aglM) + " m");
    this.set("hdg", Math.round(v.headingDeg) % 360 + "° " + compassName(v.headingDeg)); this.set("trk", Math.round(v.trackDeg) % 360 + "° " + compassName(v.trackDeg));
    this.set("pit", (v.pitchDeg >= 0 ? "+" : "") + Math.round(v.pitchDeg) + "°"); this.set("rol", (v.rollDeg >= 0 ? "右 " : "左 ") + Math.abs(Math.round(v.rollDeg)) + "°");
    this.set("gs", Math.round(v.gsKmh) + " km/h"); this.set("tas", Math.round(v.tasKmh) + " km/h");
    if (this.horizon) { const py = Math.max(-40, Math.min(40, v.pitchDeg)) * 1.2; this.horizon.style.transform = `translateY(${py.toFixed(1)}px) rotate(${(-v.rollDeg).toFixed(1)}deg)`; }
  }
}
