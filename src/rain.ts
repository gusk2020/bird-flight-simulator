import * as THREE from "three";

/** カメラ周囲の雨粒(線分)。ワールド全体ではなくプレイヤー周辺だけ計算する。 */
export class Rain {
  static MAX = 600;
  mesh: THREE.LineSegments; private p = new Float32Array(Rain.MAX * 3); private pos = new Float32Array(Rain.MAX * 6);
  private intensity = 0; private density = 1;
  constructor() {
    for (let i = 0; i < Rain.MAX; i++) { this.p[i * 3] = (Math.random() - 0.5) * 50; this.p[i * 3 + 1] = Math.random() * 30 - 10; this.p[i * 3 + 2] = (Math.random() - 0.5) * 50; }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xb8c4d8, transparent: true, opacity: 0.45, fog: false, depthWrite: false }));
    this.mesh.frustumCulled = false; this.mesh.visible = false;
  }
  setIntensity(v: number) { this.intensity = v; this.mesh.visible = v > 0; }
  setDensity(d: number) { this.density = d; }
  get count() { return this.intensity > 0 ? Math.floor(Rain.MAX * this.density) : 0; }
  update(dt: number, cam: THREE.Vector3, wind: THREE.Vector3) {
    const n = this.count; if (n === 0) return;
    const fall = 22, vx = wind.x * 0.6, vz = wind.z * 0.6, p = this.p, o = this.pos;
    for (let i = 0; i < n; i++) {
      let x = p[i * 3] + vx * dt, y = p[i * 3 + 1] - fall * dt, z = p[i * 3 + 2] + vz * dt;
      if (y < -12) y += 30; // 周囲の箱の中で循環 (カメラ相対)
      p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
      const wx = cam.x + x, wy = cam.y + y, wz = cam.z + z, k = 0.035;
      o[i * 6] = wx; o[i * 6 + 1] = wy; o[i * 6 + 2] = wz; o[i * 6 + 3] = wx - vx * k; o[i * 6 + 4] = wy + fall * k; o[i * 6 + 5] = wz - vz * k;
    }
    this.mesh.geometry.setDrawRange(0, n * 2);
    (this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
