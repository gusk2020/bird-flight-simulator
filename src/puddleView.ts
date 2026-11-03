import * as THREE from "three";
import { Puddles, PUDDLE } from "./puddles";

/** 水たまりの表示。単色の薄い青の円(反射なし)。深度の衝突を避けるため、地面から少し浮かせ、書き込みを止め、ポリゴンオフセットをかける。
 *  雨のあいだは波紋の輪、水浴びのときは水しぶきの輪を出す。 */
export class PuddleView {
  group = new THREE.Group();
  private discs: THREE.Mesh[] = []; private rings: THREE.Mesh[] = []; private splashes: { m: THREE.Mesh; t: number }[] = [];
  private mat = new THREE.MeshBasicMaterial({ color: 0x7fa6c8, transparent: true, opacity: 0.72, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  private ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
  private t = 0;
  constructor(private pd: Puddles, private heightAt: (x: number, z: number) => number) {
    const disc = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2), ring = new THREE.RingGeometry(0.85, 1, 24).rotateX(-Math.PI / 2);
    for (const p of pd.list) {
      const d = new THREE.Mesh(disc, this.mat); d.position.set(p.x, heightAt(p.x, p.z) + PUDDLE.y, p.z); d.renderOrder = 3; d.visible = false; d.frustumCulled = true;
      const r = new THREE.Mesh(ring, this.ringMat); r.position.copy(d.position); r.position.y += 0.004; r.renderOrder = 4; r.visible = false;
      this.group.add(d, r); this.discs.push(d); this.rings.push(r);
    }
    for (let i = 0; i < 4; i++) { const m = new THREE.Mesh(ring, this.ringMat.clone()); m.visible = false; m.renderOrder = 4; this.group.add(m); this.splashes.push({ m, t: 9 }); }
  }
  splash(x: number, z: number) { const s = this.splashes.find(q => q.t >= 1) ?? this.splashes[0]; s.t = 0; s.m.position.set(x, this.heightAt(x, z) + PUDDLE.y + 0.01, z); }
  update(dt: number, rain: number, color?: number) {
    this.t += dt; if (color !== undefined) this.mat.color.setHex(color);
    this.pd.list.forEach((p, i) => {
      const r = this.pd.radius(p), d = this.discs[i], rg = this.rings[i];
      d.visible = r > 0.05; if (d.visible) d.scale.set(r, 1, r);
      rg.visible = d.visible && (rain > 0.3 || p.perm);
      if (rg.visible) { const ph = (this.t * 0.7 + i * 0.37) % 1; rg.scale.set(r * (0.15 + 0.5 * ph), 1, r * (0.15 + 0.5 * ph)); (rg.material as THREE.Material); }
    });
    for (const s of this.splashes) { if (s.t >= 1) { s.m.visible = false; continue; } s.t += dt / 0.8; s.m.visible = true; const k = 0.2 + s.t * 1.1; s.m.scale.set(k, 1, k); (s.m.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - s.t); }
  }
}
