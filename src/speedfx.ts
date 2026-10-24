import * as THREE from "three";

/** 速度演出の強さ 0..1。通常飛行(約9〜20m/s)では 0、急降下などの高速でのみ立ち上がる。 */
export function speedIntensity(speed: number): number {
  const t = Math.min(1, Math.max(0, (speed - 22) / 12)); // 22m/s未満は出さない、34m/sで最大
  return t * t * (3 - 2 * t);
}

/**
 * 漫画風の集中線(画面周辺) + 周辺の暗り。2Dキャンバスに最大約60本の線を描くだけで、3D描画負荷は増やさない。
 * 強度0のときは何も描かない。線は約14Hzで描き直して手描きアニメ風にする。
 */
export class SpeedLines {
  private ctx: CanvasRenderingContext2D; private seeds: number[] = []; private t = 0; private lastDrawn = 0;
  constructor(private canvas: HTMLCanvasElement, private vignette: HTMLElement) {
    this.ctx = canvas.getContext("2d")!;
    for (let i = 0; i < 64 * 4; i++) this.seeds.push(Math.random());
  }
  resize(w: number, h: number) { this.canvas.width = Math.max(2, Math.round(w / 3)); this.canvas.height = Math.max(2, Math.round(h / 3)); }
  /** @returns 描いた線の数 */
  update(dt: number, intensity: number): number {
    this.vignette.style.opacity = String(Math.min(0.6, intensity * 0.6));
    const c = this.canvas, g = this.ctx;
    if (intensity < 0.02) { if (this.lastDrawn > 0) { g.clearRect(0, 0, c.width, c.height); this.lastDrawn = 0; } return 0; }
    this.t += dt;
    if (this.t < 1 / 14 && this.lastDrawn > 0) return this.lastDrawn; // コマを保持(再描画しない)
    this.t = 0;
    for (let i = 0; i < this.seeds.length; i++) this.seeds[i] = Math.random();
    g.clearRect(0, 0, c.width, c.height);
    const cx = c.width / 2, cy = c.height * 0.46, R = Math.hypot(cx, cy);
    const n = Math.round(12 + 52 * intensity);
    g.strokeStyle = "rgba(255,255,255,0.85)"; g.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const a = this.seeds[i * 4] * Math.PI * 2, r0 = R * (0.5 + 0.25 * this.seeds[i * 4 + 1] * (1 - 0.4 * intensity));
      const r1 = R * (0.95 + 0.25 * this.seeds[i * 4 + 2]);
      g.globalAlpha = 0.25 + 0.55 * intensity * (0.5 + this.seeds[i * 4 + 3] * 0.5);
      g.lineWidth = 0.6 + 1.6 * this.seeds[i * 4 + 3] * intensity;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.stroke();
    }
    g.globalAlpha = 1; this.lastDrawn = n; return n;
  }
}

/** 視線(進行)方向に沿う流線。ワールド固定の点がカメラ周囲の箱の中にあるため、カメラが動くと自然にパララックスで流れる。 */
export class Streaks {
  static N = 90; mesh: THREE.LineSegments; private p = new Float32Array(Streaks.N * 3); private pos = new Float32Array(Streaks.N * 6);
  private box = 22;
  constructor() {
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.mesh.frustumCulled = false; this.mesh.visible = false;
    for (let i = 0; i < Streaks.N * 3; i++) this.p[i] = (Math.random() - 0.5) * 2 * this.box;
  }
  update(cam: THREE.Vector3, vel: THREE.Vector3, intensity: number) {
    this.mesh.visible = intensity > 0.02; if (!this.mesh.visible) return;
    (this.mesh.material as THREE.LineBasicMaterial).opacity = 0.5 * intensity;
    const b = this.box, sp = vel.length() || 1, k = Math.min(3, sp * 0.06) / sp, p = this.p, o = this.pos;
    const wrap = (d: number) => d - Math.round(d / (2 * b)) * 2 * b;
    for (let i = 0; i < Streaks.N; i++) {
      // 点はワールド固定。カメラ周囲 ±b の箱に折り返す(カメラが進むと後方で再出現)
      const x = cam.x + wrap(p[i * 3] - cam.x), y = cam.y + wrap(p[i * 3 + 1] - cam.y), z = cam.z + wrap(p[i * 3 + 2] - cam.z);
      o[i * 6] = x; o[i * 6 + 1] = y; o[i * 6 + 2] = z; o[i * 6 + 3] = x - vel.x * k; o[i * 6 + 4] = y - vel.y * k; o[i * 6 + 5] = z - vel.z * k;
    }
    (this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
