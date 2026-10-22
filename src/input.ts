import type { FlightInput } from "./flight";

/** タッチ/キーボード入力。指を離す・取消・画面外・アプリ切替で必ず解除する。 */
export class Input {
  state: FlightInput = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
  onReset = () => {}; onCamera = () => {}; onTime = () => {}; onPause = () => {};
  private stickId = -1; private ox = 0; private oy = 0; private R = 60;
  private keys = new Set<string>();
  private base = document.getElementById("stickBase")!; private knob = document.getElementById("stickKnob")!;

  constructor() {
    const zone = document.getElementById("stick")!;
    zone.addEventListener("pointerdown", e => {
      if (this.stickId >= 0) return;
      this.stickId = e.pointerId; zone.setPointerCapture(e.pointerId);
      this.R = Math.max(45, Math.min(75, Math.min(innerWidth, innerHeight) * 0.13));
      this.ox = e.clientX; this.oy = e.clientY; this.move(e.clientX, e.clientY); this.showStick(true);
    });
    zone.addEventListener("pointermove", e => { if (e.pointerId === this.stickId) this.move(e.clientX, e.clientY); });
    const end = (e: PointerEvent) => { if (e.pointerId === this.stickId) this.endStick(); };
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
    el.addEventListener("pointerdown", e => { ids.add(e.pointerId); el.setPointerCapture(e.pointerId); upd(); });
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
  private endStick() { this.stickId = -1; this.state.x = this.state.y = 0; this.showStick(false); }
  releaseAll() {
    this.endStick(); this.releasers.forEach(r => r()); this.keys.clear();
    this.state.flapHeld = this.state.flapTap = this.state.brake = false;
  }
  /** 毎物理ステップ前に呼ぶ: キーボード分を合成した入力を返す */
  read(): FlightInput {
    const k = this.keys, s = this.state;
    const kx = (k.has("ArrowRight") || k.has("KeyD") ? 1 : 0) - (k.has("ArrowLeft") || k.has("KeyA") ? 1 : 0);
    const ky = (k.has("ArrowUp") || k.has("KeyW") ? 1 : 0) - (k.has("ArrowDown") || k.has("KeyS") ? 1 : 0);
    return { x: s.x || kx, y: s.y || ky, flapHeld: s.flapHeld, flapTap: s.flapTap, brake: s.brake || k.has("ShiftLeft") };
  }
}
