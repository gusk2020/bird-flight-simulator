import * as THREE from "three";
import type { Flight } from "./flight";

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * 三人称追従 / 一人称。
 * カメラ位置を直接なめらかにせず、「鳥からの相対オフセット」を向き(yaw/pitch)で決めてなめらかにする。
 * 位置のなめらか化は速度×遅れ分だけ鳥から離れ、急降下・急減速で距離が伸び縮みして背景が遅れて見えるため。
 */
export class FollowCam {
  mode: "third" | "first" = "third";
  private yaw = 0; private cp = 0; private dist = 5.2; private t = 1; private ready = false;
  private _o = new THREE.Vector3(); private _b = new THREE.Vector3(); private _p = new THREE.Vector3();
  constructor(public cam: THREE.PerspectiveCamera, private world: { heightAt(x: number, z: number): number }) {}
  snap() { this.ready = false; }

  update(dt: number, f: Flight, bp: THREE.Vector3, fx = 0) {
    const k = (rate: number) => 1 - Math.exp(-rate * dt);
    const wantCp = Math.max(-0.8, Math.min(0.6, f.pitch * 0.75));
    if (!this.ready) { this.yaw = f.yaw; this.cp = wantCp; this.dist = 5.2; this.t = 1; this.ready = true; }
    this.yaw += wrap(f.yaw - this.yaw) * k(this.mode === "first" ? 14 : 5);
    this.cp += (wantCp - this.cp) * k(5);
    const fov = 66 + Math.min(4, f.speed * 0.2) + 14 * fx; // 高速では視野を広げて速度感を出す
    if (Math.abs(this.cam.fov - fov) > 0.05) { this.cam.fov += (fov - this.cam.fov) * k(3); this.cam.updateProjectionMatrix(); }
    if (this.mode === "first") {
      this.cam.position.set(bp.x - Math.sin(f.yaw) * 0.6, bp.y + 0.28, bp.z - Math.cos(f.yaw) * 0.6);
      this.cam.rotation.set(f.pitch * 0.85, this.yaw, f.roll * 0.6, "YXZ");
      return;
    }
    this.dist += ((f.mode === "air" ? 5.2 + 2.2 * fx : 4.0) - this.dist) * k(3);
    const cc = Math.cos(this.cp), dx = -Math.sin(this.yaw) * cc, dy = Math.sin(this.cp), dz = -Math.cos(this.yaw) * cc;
    this._o.set(-dx * this.dist, -dy * this.dist + 1.3, -dz * this.dist);
    // 遮蔽: 鳥からカメラへ線を引き、建物・地面に入る手前で止める
    let free = 1;
    for (let i = 1; i <= 10; i++) {
      const s = i / 10, x = bp.x + this._o.x * s, y = bp.y + this._o.y * s, z = bp.z + this._o.z * s;
      if (y < this.world.heightAt(x, z) + 0.35) { free = (i - 1) / 10; break; }
    }
    this.t += (free - this.t) * (free < this.t ? k(30) : k(4));
    this._p.copy(bp).addScaledVector(this._o, this.t);
    const gh = this.world.heightAt(this._p.x, this._p.z);
    if (this._p.y < gh + 0.4) this._p.y = gh + 0.4;
    this.cam.position.copy(this._p);
    this._b.set(bp.x + dx * 4, bp.y + 0.3 + dy * 4, bp.z + dz * 4);
    this.cam.up.set(0, 1, 0); this.cam.lookAt(this._b);
  }
}
