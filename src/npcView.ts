import * as THREE from "three";
import type { NpcWorld } from "./npc";

const KIND_COLOR = { pigeon: 0x8d94a0, sparrow: 0x9a6a45, crow: 0x24262c };
const MAX_BIRDS = 16, MAX_PEDS = 44, MAX_CARS = 18;

/** NPCの描画: 種類ごとにInstancedMeshを1つずつ。毎フレーム行列を書き換えるだけ(個体数が少ないので軽い)。 */
export class NpcView {
  group = new THREE.Group();
  private body: THREE.InstancedMesh; private wing: THREE.InstancedMesh;
  private pedBody: THREE.InstancedMesh; private pedHead: THREE.InstancedMesh; private carBody: THREE.InstancedMesh; private carCabin: THREE.InstancedMesh;
  /** 車のヘッドライト: 左右2灯(小さな発光体)と、道路を軽く照らす疑似光円錐(地面に敷く1枚の板)。動的ライトも影も使わない */
  readonly lamp!: THREE.InstancedMesh; readonly beam!: THREE.InstancedMesh; private lampMat: THREE.MeshBasicMaterial; private beamMat: THREE.MeshBasicMaterial;
  /** いま点灯している(描画している)ヘッドライトの数(テスト・計測用) */
  headlamps = 0;
  private o = new THREE.Object3D(); private m = new THREE.Matrix4(); private w = new THREE.Matrix4(); private c = new THREE.Color(); private sc = new THREE.Matrix4();
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
    // ヘッドライト(車の前=ローカル-z。左右0.65m、高さ0.62m、先端から少し前)
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1c4, toneMapped: false, fog: false });
    (this as { lamp: THREE.InstancedMesh }).lamp = mk(new THREE.BoxGeometry(0.32, 0.18, 0.08), this.lampMat, MAX_CARS * 2); (this.lamp.instanceColor!.array as Float32Array).fill(1); // mk は色を0で作るので、白(=素材の色そのまま)にしておく
    // 光円錐: 車の前の路面に敷く台形(手前が狭く明るく、遠くへ広がりながら消える)。加算合成・深度書き込みなし
    const bgm = new THREE.BufferGeometry(), y = 0.07, z0 = -2.15, z1 = -12.5, w0 = 0.9, w1 = 3.6;
    bgm.setAttribute("position", new THREE.Float32BufferAttribute([-w0, y, z0, w0, y, z0, w1, y, z1, -w1, y, z1], 3));
    bgm.setAttribute("color", new THREE.Float32BufferAttribute([1, 0.93, 0.7, 1, 0.93, 0.7, 0, 0, 0, 0, 0, 0], 3));
    bgm.setIndex([0, 2, 1, 0, 3, 2]);
    this.beamMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide });
    (this as { beam: THREE.InstancedMesh }).beam = new THREE.InstancedMesh(bgm, this.beamMat, MAX_CARS); this.beam.count = 0; this.beam.frustumCulled = false; this.beam.renderOrder = 1; this.group.add(this.beam);
  }
  /** lights: 窓・街灯と同じ点灯度 0..1(夕方から夜にかけて上がり、朝に0へ戻る)。0.02未満の間は何も描かない */
  update(npc: NpcWorld, camera: THREE.Vector3, maxDist = 220, lights = 0) {
    const o = this.o, c = this.c; let nb = 0, nw = 0;
    for (const b of npc.birds) {
      if (!b.active || nb >= MAX_BIRDS || (b.x - camera.x) ** 2 + (b.z - camera.z) ** 2 > maxDist * maxDist) continue;
      o.position.set(b.x, b.y + 0.3 * b.scale, b.z); o.rotation.set(b.state === "fly" ? -0.1 : 0, b.yaw, 0); o.scale.setScalar(b.scale); o.updateMatrix();
      this.body.setMatrixAt(nb, o.matrix); this.body.setColorAt(nb, c.setHex(KIND_COLOR[b.kind])); nb++;
      const flap = b.state === "fly" ? Math.sin(b.phase) * 0.8 : -0.9; // 止まっているときは翼をたたむ
      for (const s of [1, -1]) {
        this.w.makeRotationZ(s * flap); this.w.setPosition(s * 0.18, 0.05, -0.05);
        this.sc.makeScale(s, 1, 1); this.m.multiplyMatrices(o.matrix, this.w).multiply(this.sc);
        if (nw < MAX_BIRDS * 2) { this.wing.setMatrixAt(nw, this.m); this.wing.setColorAt(nw, c.setHex(KIND_COLOR[b.kind])); nw++; }
      }
    }
    this.body.count = nb; this.wing.count = nw;
    let np = 0;
    for (const q of npc.visiblePeds()) {
      if (np >= MAX_PEDS || (q.x - camera.x) ** 2 + (q.z - camera.z) ** 2 > maxDist * maxDist) continue;
      const bob = q.walking ? Math.abs(Math.sin(q.phase)) * 0.03 : 0;
      o.position.set(q.x, 0.12 + bob, q.z); o.rotation.set(0, q.yaw, 0); o.scale.set(1, 1, 1); o.updateMatrix();
      this.pedBody.setMatrixAt(np, o.matrix); this.pedBody.setColorAt(np, c.setHSL(q.hue, 0.45, 0.45)); this.pedHead.setMatrixAt(np, o.matrix); this.pedHead.setColorAt(np, c.setHex(0xffffff)); np++;
    }
    this.pedBody.count = this.pedHead.count = np;
    let nc = 0;
    for (const car of npc.visibleCars()) {
      if (nc >= MAX_CARS || (car.x - camera.x) ** 2 + (car.z - camera.z) ** 2 > maxDist * maxDist) continue;
      o.position.set(car.x, 0, car.z); o.rotation.set(0, car.yaw, 0); o.scale.set(1, 1, 1); o.updateMatrix();
      this.carBody.setMatrixAt(nc, o.matrix); this.carBody.setColorAt(nc, c.setHex(car.color)); this.carCabin.setMatrixAt(nc, o.matrix); this.carCabin.setColorAt(nc, c.setHex(0xffffff)); nc++;
    }
    this.carBody.count = this.carCabin.count = nc;
    // ヘッドライト(表示している車だけ。昼は個数0=描画なし)
    const on = lights >= 0.02; let nl = 0, nbm = 0;
    if (on) {
      this.beamMat.opacity = 0.5 * lights; this.lampMat.color.setHex(0xfff1c4).multiplyScalar(0.4 + 0.6 * lights);
      for (let i = 0; i < nc; i++) {
        this.carBody.getMatrixAt(i, this.m);
        for (const sx of [-0.65, 0.65]) { this.w.makeTranslation(sx, 0.62, -2.12); this.sc.multiplyMatrices(this.m, this.w); this.lamp.setMatrixAt(nl++, this.sc); }
        this.beam.setMatrixAt(nbm++, this.m);
      }
    }
    this.lamp.count = nl; this.beam.count = nbm; this.headlamps = nl;
    this.lamp.instanceMatrix.needsUpdate = true; this.beam.instanceMatrix.needsUpdate = true;
    for (const m of [this.body, this.wing, this.pedBody, this.pedHead, this.carBody, this.carCabin]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
  }
}
