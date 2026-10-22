import * as THREE from "three";
import type { Flight } from "./flight";

const mat = (c: number, side: THREE.Side = THREE.FrontSide) => new THREE.MeshLambertMaterial({ color: c, side });
const ball = (r: number, m: THREE.Material, sx = 1, sy = 1, sz = 1, p: [number, number, number] = [0, 0, 0]) => {
  const g = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 9), m); g.scale.set(sx, sy, sz); g.position.set(...p); return g;
};

function wingShape(pts: [number, number][], m: THREE.Material, s: number) {
  const sh = new THREE.Shape(); pts.forEach(([x, y], i) => (i ? sh.lineTo(x * s, y) : sh.moveTo(x * s, y)));
  const g = new THREE.ShapeGeometry(sh); g.rotateX(-Math.PI / 2); // 形状のyが前方(-z)になる
  return new THREE.Mesh(g, m);
}

/** 低ポリのハト。-Z が前。翼・脚・尾は姿勢に応じて動かす。 */
export class BirdModel {
  group = new THREE.Group();
  private root = new THREE.Group();
  private wings: { shoulder: THREE.Group; elbow: THREE.Group; s: number }[] = [];
  private legs: THREE.Group[] = [];
  private tail = new THREE.Group();
  private shadow: THREE.Mesh;
  private wingAng = 0.15; private fold = 0; private legExt = 0; private tailPitch = 0;
  private parts: THREE.Object3D[] = [];

  constructor() {
    const grey = mat(0x8d94a0), dark = mat(0x5f6a7a), light = mat(0xb7bcc6), sheen = mat(0x5f9a8c), wingM = mat(0x858c98, THREE.DoubleSide), bar = mat(0x2b303a, THREE.DoubleSide);
    const r = this.root;
    r.add(ball(0.3, grey, 1, 0.85, 1.55, [0, 0, 0.05]));
    r.add(ball(0.22, light, 1, 0.95, 1.1, [0, -0.02, -0.28]));
    r.add(ball(0.14, dark, 1, 1, 1, [0, 0.17, -0.52]));
    r.add(ball(0.13, sheen, 1.1, 0.7, 0.9, [0, 0.09, -0.42]));
    r.add(ball(0.12, mat(0xe8e8ee), 1.1, 0.4, 1.0, [0, 0.1, 0.33]));
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.13, 6), mat(0xcbbba0)); beak.rotation.x = -Math.PI / 2; beak.position.set(0, 0.16, -0.69); r.add(beak);
    for (const s of [-1, 1]) r.add(ball(0.03, mat(0xe0892a), 1, 1, 1, [s * 0.085, 0.2, -0.58]));
    // 尾
    this.tail.position.set(0, 0.02, 0.5);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.4), dark); t.position.z = 0.2;
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.021, 0.07), bar); band.position.z = 0.36;
    this.tail.add(t, band); r.add(this.tail);
    // 翼 (肩 → 肘)
    const inner: [number, number][] = [[0, 0.2], [0.5, 0.18], [0.56, -0.2], [0, -0.28]];
    const outer: [number, number][] = [[0, 0.18], [0.5, 0.1], [0.74, -0.02], [0.66, -0.12], [0.48, -0.2], [0, -0.2]];
    for (const s of [-1, 1]) {
      const shoulder = new THREE.Group(); shoulder.position.set(s * 0.2, 0.08, -0.05);
      const elbow = new THREE.Group(); elbow.position.x = s * 0.56;
      shoulder.add(wingShape(inner, wingM, s), elbow);
      const stripe = wingShape([[0.1, 0.1], [0.5, 0.08], [0.52, 0.02], [0.1, 0.03]], bar, s); stripe.position.y = 0.004; shoulder.add(stripe);
      elbow.add(wingShape(outer, mat(0x777e8b, THREE.DoubleSide), s));
      r.add(shoulder); this.wings.push({ shoulder, elbow, s });
    }
    // 脚
    for (const s of [-1, 1]) {
      const leg = new THREE.Group(); leg.position.set(s * 0.08, -0.14, 0.02);
      const l = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.18, 5), mat(0xc9657c)); l.position.y = -0.09;
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.015, 0.12), mat(0xc9657c)); foot.position.set(0, -0.18, -0.03);
      leg.add(l, foot); r.add(leg); this.legs.push(leg);
    }
    this.group.add(r);
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false, fog: false }));
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.renderOrder = 2;
  }
  attach(scene: THREE.Scene) { scene.add(this.group, this.shadow); }
  setVisible(v: boolean) { this.group.visible = v; }

  update(dt: number, f: Flight, pos: THREE.Vector3, groundY: number) {
    this.group.position.copy(pos);
    this.group.rotation.set(f.pitch, f.yaw, f.roll, "YXZ");
    const air = f.mode === "air";
    // 翼
    let target: number, foldT = 0;
    if (!air) { target = 0; foldT = 1; }
    else if (f.strokeT >= 0) target = Math.cos(f.strokeT * Math.PI * 2) * 0.85 + 0.1;
    else target = f.braking ? 0.9 : 0.15; // 滑空: わずかに上反角 / ブレーキ: 翼を立てる
    this.wingAng += (target - this.wingAng) * (1 - Math.exp(-(f.strokeT >= 0 ? 30 : 10) * dt));
    this.fold += (foldT - this.fold) * (1 - Math.exp(-8 * dt));
    for (const w of this.wings) {
      w.shoulder.rotation.set(0, -w.s * this.fold * 1.45, w.s * this.wingAng * (1 - this.fold * 0.6));
      w.elbow.rotation.set(0, -w.s * this.fold * 0.9, w.s * (f.strokeT >= 0 ? -this.wingAng * 0.5 : 0.05));
    }
    // 脚: 離着陸付近で降ろす
    const ext = !air || (f.agl < 2.2 && f.speed < 13) ? 1 : 0;
    this.legExt += (ext - this.legExt) * (1 - Math.exp(-9 * dt));
    for (const l of this.legs) { l.rotation.x = (1 - this.legExt) * 1.4; l.scale.y = 0.6 + 0.4 * this.legExt; }
    // 尾: ブレーキで下げる
    this.tailPitch += ((f.braking ? 0.5 : 0) - this.tailPitch) * (1 - Math.exp(-10 * dt));
    this.tail.rotation.x = this.tailPitch; this.tail.scale.x = 1 + this.tailPitch * 0.8;
    // 影
    const agl = Math.max(0, pos.y - groundY);
    this.shadow.position.set(pos.x, groundY + 0.04, pos.z);
    const sc = 1 + agl * 0.04; this.shadow.scale.setScalar(sc);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.08, 0.38 - agl * 0.012);
    this.shadow.visible = this.group.visible;
  }
}
