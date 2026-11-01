import type { FlightInput } from "./flight";
import { GESTURE, OneHandGesture } from "./gesture";
import { ProxPad, padLayout, inProxRegion, type PadLayout } from "./proxpad";
import type { ControlMode } from "./settings";

/** 片手操作のスティックのなめらかさ(秒) */
export const SMOOTH_S = 0.1;
/** タッチ/キーボード入力。指を離す・取消・画面外・アプリ切替で必ず解除する。 */
export class Input {
  state: FlightInput = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
  onReset = () => {}; onCamera = () => {}; onTime = () => {}; onPause = () => {};
  /** G1-5: 画面の座標が着地候補の◯の上か(main が毎フレーム、◯の画面位置から判定する)と、◯がタップされたとき */
  ringHit: (x: number, y: number) => boolean = () => false; onRingTap = () => {};
  /** テスト用の計数: ◯タップになった回数 / 片手操作のタップ(=羽ばたき)になった回数 */
  stats = { ringTaps: 0, gestureTaps: 0 };
  /** 診断用: 押している最中の◯候補の数(テストの記録に使う) */
  ringCandCount() { return this.ringCand.size; }
  /** H1: 近接◎(画面の下側)。片手操作のときだけ。触れた場所が近接◎の領域なら近接、そうでなければ今までの巡航(スライド=スティック、タップ=羽ばたき、長押し=減速) */
  readonly prox = new ProxPad(); proxVisual = { x: 0, y: 0, on: false };
  /** 触れ始めの進行方向(世界のyaw)。main が設定する */
  getHeading: () => number = () => 0;
  /** 近接◎の配置(片手操作のとき)。画面の大きさと左右から決まる */
  layout(): PadLayout | null { return this.mode === "both" ? null : padLayout(innerWidth, innerHeight, this.mode); }
  private ringCand = new Map<number, { x: number; y: number; t: number }>(); private ringFired = new Set<number>();
  private out: FlightInput = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
  mode: ControlMode = "both"; readonly gesture = new OneHandGesture();
  private stickId = -1; private ox = 0; private oy = 0; private R = 60;
  private keys = new Set<string>();
  private base = document.getElementById("stickBase")!; private knob = document.getElementById("stickKnob")!;

  constructor() {
    const zone = document.getElementById("stick")!;
    // ◯のタップ(G1-5): スティックや羽ばたきタップより先(キャプチャ段階)に見る。◯の上で押して、ほとんど動かさず短く離したときだけ「◯タップ」。
    // 動かせばスティック、長く押せば減速/歩行として今までどおり扱う。◯タップになった指は、羽ばたきタップにも歩行にもしない
    const RING_TAP_MS = 300, RING_SLOP_PX = 14;
    document.addEventListener("pointerdown", e => {
      this.ringFired.delete(e.pointerId); // 前に使った指番号の取り残しを消す
      const el = e.target as Element | null; if (el && el.closest && el.closest("button,.btn,#overlay")) return;
      if (this.ringHit(e.clientX, e.clientY)) this.ringCand.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    }, true);
    document.addEventListener("pointermove", e => { const c = this.ringCand.get(e.pointerId); if (c && Math.hypot(e.clientX - c.x, e.clientY - c.y) > RING_SLOP_PX) this.ringCand.delete(e.pointerId); }, true);
    document.addEventListener("pointerup", e => {
      const c = this.ringCand.get(e.pointerId); this.ringCand.delete(e.pointerId);
      if (c && e.timeStamp - c.t < RING_TAP_MS && Math.hypot(e.clientX - c.x, e.clientY - c.y) <= RING_SLOP_PX) { // 押した時点で◯の当たり判定の中だったことは確かめ済み(◯は飛びながら動く・消えることがあるので、離した時点では確かめ直さない)
         this.ringFired.add(e.pointerId); this.stats.ringTaps++; this.onRingTap(); }
    }, true);
    document.addEventListener("pointercancel", e => { this.ringCand.delete(e.pointerId); this.ringFired.delete(e.pointerId); }, true);
    zone.addEventListener("pointerdown", e => {
      if (this.mode !== "both") {
        const L = this.layout()!;
        if (inProxRegion(L, e.clientX, e.clientY)) { // 近接◎: 中心を基準に、触れた向きと距離で方向を決める。◯のタップ候補なら、タップかどうか決まるまで(約0.3秒)指示を出さない
          if (!this.prox.active && !this.gesture.active) {
            this.prox.down(e.pointerId, e.clientX, e.clientY, L.prox, this.getHeading(), this.ringCand.has(e.pointerId) ? 0.3 : 0);
            try { zone.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
            this.proxVisual.on = true; this.proxVisual.x = e.clientX; this.proxVisual.y = e.clientY;
          }
          return;
        }
        // 巡航◎(従来): スライド=スティック、短いタップ=羽ばたき、長押し=減速(地上では歩く)
        if (this.prox.active) return;
        if (this.gesture.down(e.pointerId, e.clientX, e.clientY, e.timeStamp, GESTURE.radiusPx(innerWidth, innerHeight))) {
          try { zone.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
          this.ox = e.clientX; this.oy = e.clientY; this.R = this.gesture.R; this.showStick(true); this.syncKnob();
        }
        return;
      }
      if (this.stickId >= 0) return;
      this.stickId = e.pointerId; try { zone.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
      this.R = Math.max(45, Math.min(75, Math.min(innerWidth, innerHeight) * 0.13));
      this.ox = e.clientX; this.oy = e.clientY; this.move(e.clientX, e.clientY); this.showStick(true);
    });
    zone.addEventListener("pointermove", e => {
      if (e.pointerId === this.prox.id) { this.prox.move(e.clientX, e.clientY); this.proxVisual.x = e.clientX; this.proxVisual.y = e.clientY; return; }
      if (this.mode !== "both") { if (e.pointerId === this.gesture.id) { this.gesture.move(e.pointerId, e.clientX, e.clientY); this.syncKnob(); } return; }
      if (e.pointerId === this.stickId) this.move(e.clientX, e.clientY);
    });
    // 描画が重くても、タップ/長押しは指が触れた実際の時刻(e.timeStamp)で判定する
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.prox.id) { // 近接◎から指を離した(◯タップになった指も含む): 近接の指示をやめる
        this.ringFired.delete(e.pointerId); this.prox.up(); this.proxVisual.on = false; return;
      }
      if (e.type === "pointerup" && this.ringFired.delete(e.pointerId)) { // ◯タップ: 羽ばたきにも歩行にもしない
        if (this.mode !== "both") { if (e.pointerId === this.gesture.id) { this.gesture.cancel(); this.showStick(false); } } else if (e.pointerId === this.stickId) this.endStick();
        return;
      }
      if (this.mode !== "both") { if (e.pointerId === this.gesture.id) { if (e.type === "pointerup") this.gesture.up(e.pointerId, e.timeStamp); else this.gesture.cancel(); this.showStick(false); } return; }
      if (e.pointerId === this.stickId) this.endStick();
    };
    zone.addEventListener("pointerup", end); zone.addEventListener("pointercancel", end); zone.addEventListener("lostpointercapture", end);

    this.hold("flap", d => { this.state.flapHeld = d; if (d) this.state.flapTap = true; });
    this.hold("brake", d => { this.state.brake = d; });
    this.tap("btnReset", () => this.onReset()); this.tap("btnCam", () => this.onCamera()); this.tap("btnTime", () => this.onTime());

    addEventListener("blur", () => this.releaseAll());
    addEventListener("pagehide", () => this.releaseAll());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.releaseAll(); });
    document.addEventListener("contextmenu", e => e.preventDefault());
    addEventListener("keydown", e => {
      if (e.repeat) return; this.keys.add(e.code);
      if (e.code === "Space") { this.state.flapHeld = true; this.state.flapTap = true; }
      if (e.code === "KeyC") this.onCamera(); if (e.code === "KeyR") this.onReset(); if (e.code === "KeyT") this.onTime(); if (e.code === "KeyP" || e.code === "Escape") this.onPause();
    });
    addEventListener("keyup", e => { this.keys.delete(e.code); if (e.code === "Space") this.state.flapHeld = false; });
  }
  private hold(id: string, set: (down: boolean) => void) {
    const el = document.getElementById(id)!; const ids = new Set<number>();
    const upd = () => { set(ids.size > 0); el.classList.toggle("on", ids.size > 0); };
    el.addEventListener("pointerdown", e => { ids.add(e.pointerId); try { el.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ } upd(); });
    const up = (e: PointerEvent) => { ids.delete(e.pointerId); upd(); };
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up); el.addEventListener("lostpointercapture", up);
    this.releasers.push(() => { ids.clear(); upd(); });
  }
  private releasers: (() => void)[] = [];
  private tap(id: string, fn: () => void) { document.getElementById(id)!.addEventListener("pointerdown", e => { e.preventDefault(); fn(); }); }
  private showStick(v: boolean) {
    this.base.style.display = this.knob.style.display = v ? "block" : "none";
    if (v) { this.base.style.left = this.ox + "px"; this.base.style.top = this.oy + "px"; }
  }
  private move(cx: number, cy: number) {
    let dx = (cx - this.ox) / this.R, dy = (cy - this.oy) / this.R;
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    const dz = (v: number) => Math.abs(v) < 0.12 ? 0 : v;
    this.state.x = dz(dx); this.state.y = dz(-dy);
    this.knob.style.left = this.ox + dx * this.R + "px"; this.knob.style.top = this.oy + dy * this.R + "px";
  }
  /** 操作方式の切替。押しっぱなし・途中のスティックを残さない */
  setMode(m: ControlMode) { if (m === this.mode) return; this.releaseAll(); this.mode = m; this.gesture.clearTaps(); }
  private syncKnob() { const g = this.gesture; this.knob.style.left = this.ox + g.x * this.R + "px"; this.knob.style.top = this.oy - g.y * this.R + "px"; }
  private endStick() { this.stickId = -1; this.state.x = this.state.y = 0; this.showStick(false); }
  releaseAll() {
    this.prox.up(); this.proxVisual.on = false; this.endStick(); this.gesture.cancel(); this.gesture.clearTaps(); this.releasers.forEach(r => r()); this.keys.clear();
    this.state.flapHeld = this.state.flapTap = this.state.brake = false;
  }
  /** 毎物理ステップ前に呼ぶ: キーボード分を合成した入力を返す */
  read(): FlightInput {
    const k = this.keys, s = this.state;
    if (this.mode !== "both") { // 片手: ジェスチャの結果を状態へ反映(長押し判定もここで進める)
      const g = this.gesture; g.poll(performance.now()); s.brake = g.brake; if (g.consumeTap()) { s.flapTap = true; this.stats.gestureTaps++; }
      // 指の動きを約0.1秒でなめらかにして渡す(急な旋回・昇降を防ぐ)。指を離したら、その場で中立へ戻す
      if (g.active) { const k = 1 - Math.exp(-(1 / 60) / SMOOTH_S); s.x += (g.x - s.x) * k; s.y += (g.y - s.y) * k; }
      else s.x = s.y = 0;
    }
    const kx = (k.has("ArrowRight") || k.has("KeyD") ? 1 : 0) - (k.has("ArrowLeft") || k.has("KeyA") ? 1 : 0);
    const ky = (k.has("ArrowUp") || k.has("KeyW") ? 1 : 0) - (k.has("ArrowDown") || k.has("KeyS") ? 1 : 0);
    this.prox.tick(1 / 60);
    const o = this.out; o.prox = this.mode === "both" ? null : this.prox.cmd(); o.x = s.x || kx; o.y = s.y || ky; o.flapHeld = s.flapHeld; o.flapTap = s.flapTap; o.brake = s.brake || k.has("ShiftLeft");
    return o; // 物理ステップごとに新しいオブジェクトを作らない(呼び出し側は読むだけ)
  }
}
