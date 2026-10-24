import * as THREE from "three";
import type { NpcWorld } from "./npc";

const KIND_COLOR = { pigeon: 0x8d94a0, sparrow: 0x9a6a45, crow: 0x24262c };
const MAX_BIRDS = 16, MAX_PEDS = 44, MAX_CARS = 18;

/** NPCの描画: 種類ごとにInstancedMeshを1つずつ。毎フレーム行列を書き換えるだけ(個体数が少ないので軽い)。 */
export class NpcView {
  group = new THREE.Group();
  private body: THREE.InstancedMesh; private wing: THREE.InstancedMesh;
  private pedBody: THREE.InstancedMesh; private pedHead: THREE.InstancedMesh; private carBody: THREE.InstancedMesh; private carCabin: THREE.InstancedMesh;
  private o = new THREE.Object3D(); private m = new THREE.Matrix4(); private w = new THREE.Matrix4(); private c = new THREE.Color();
  constructor() {
    const lam = (color: number, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
    const mk = (g: THREE.BufferGeometry, mat: THREE.Material, n: number) => { const m = new THREE.InstancedMesh(g, mat, n); m.count = 0; m.frustumCulled = false; m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); this.group.add(m); return m; };
    const bg = new THREE.SphereGeometry(0.3, 8, 6); bg.scale(1, 0.85, 1.6);
    const wg = new THREE.PlaneGeometry(0.55, 0.32); wg.rotateX(-Math.PI / 2); wg.translate(0.28, 0, 0);
    this.body = mk(bg, lam(0xffffff), MAX_BIRDS); this.wing = mk(wg, lam(0xffffff, { side: THREE.DoubleSide }), MAX_BIRDS * 2);
    const pb = new THREE.CylinderGeometry(0.22, 0.26, 1.05, 6); pb.translate(0, 0.65, 0); const ph = new THREE.SphereGeometry(0.15, 7, 5); ph.translate(0, 1.45, 0);
    this.pedBody = mk(pb, lam(0xffffff), MAX_PEDS); this.pedHead = mk(ph, lam(0xe0b894), MAX_PEDS);
    const cb = new THREE.BoxGeometry(1.8, 0.8, 4.2); cb.translate(0, 0.65, 0); const cc = new THREE.BoxGeometry(1.5, 0.6, 2.2); cc.translate(0, 1.3, -0.1);
    this.carBody = mk(cb, lam(0xffffff), MAX_CARS); this.carCabin = mk(cc, lam(0x2c3a48), MAX_CARS);
  }
  update(npc: NpcWorld, camera: THREE.Vector3, maxDist = 220) {
    const o = this.o, c = this.c; let nb = 0, nw = 0;
    for (const b of npc.birds) {
      if (!b.active || nb >= MAX_BIRDS || Math.hypot(b.x - camera.x, b.z - camera.z) > maxDist) continue;
      o.position.set(b.x, b.y + 0.3 * b.scale, b.z); o.rotation.set(b.state === "fly" ? -0.1 : 0, b.yaw, 0); o.scale.setScalar(b.scale); o.updateMatrix();
      this.body.setMatrixAt(nb, o.matrix); this.body.setColorAt(nb, c.setHex(KIND_COLOR[b.kind])); nb++;
      const flap = b.state === "fly" ? Math.sin(b.phase) * 0.8 : -0.9; // 止まっているときは翼をたたむ
      for (const s of [1, -1]) {
        this.w.makeRotationZ(s * flap); this.w.setPosition(s * 0.18, 0.05, -0.05);
        const sc = new THREE.Matrix4().makeScale(s, 1, 1); this.m.multiplyMatrices(o.matrix, this.w).multiply(sc);
        if (nw < MAX_BIRDS * 2) { this.wing.setMatrixAt(nw, this.m); this.wing.setColorAt(nw, c.setHex(KIND_COLOR[b.kind])); nw++; }
      }
    }
    this.body.count = nb; this.wing.count = nw;
    let np = 0;
    for (const q of npc.visiblePeds()) {
      if (np >= MAX_PEDS || Math.hypot(q.x - camera.x, q.z - camera.z) > maxDist) continue;
      const bob = q.walking ? Math.abs(Math.sin(q.phase)) * 0.03 : 0;
      o.position.set(q.x, 0.12 + bob, q.z); o.rotation.set(0, q.yaw, 0); o.scale.set(1, 1, 1); o.updateMatrix();
      this.pedBody.setMatrixAt(np, o.matrix); this.pedBody.setColorAt(np, c.setHSL(q.hue, 0.45, 0.45)); this.pedHead.setMatrixAt(np, o.matrix); this.pedHead.setColorAt(np, c.setHex(0xffffff)); np++;
    }
    this.pedBody.count = this.pedHead.count = np;
    let nc = 0;
    for (const car of npc.visibleCars()) {
      if (nc >= MAX_CARS || Math.hypot(car.x - camera.x, car.z - camera.z) > maxDist) continue;
      o.position.set(car.x, 0, car.z); o.rotation.set(0, car.yaw, 0); o.scale.set(1, 1, 1); o.updateMatrix();
      this.carBody.setMatrixAt(nc, o.matrix); this.carBody.setColorAt(nc, c.setHex(car.color)); this.carCabin.setMatrixAt(nc, o.matrix); this.carCabin.setColorAt(nc, c.setHex(0xffffff)); nc++;
    }
    this.carBody.count = this.carCabin.count = nc;
    for (const m of [this.body, this.wing, this.pedBody, this.pedHead, this.carBody, this.carCabin]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
  }
}
