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
  snap() { this.ready = false; this.sYaw = this.tYaw = 0; this.sDist = this.tDist = 1; this.sH = this.tH = 0; }
  // オートのカット(演出): 目標値へなめらかに寄せる。既定(0,1,0)は従来の追従と完全に同じ
  private sYaw = 0; private tYaw = 0; private sDist = 1; private tDist = 1; private sH = 0; private tH = 0;
  setShot(yaw: number, dist: number, h: number) { this.tYaw = yaw; this.tDist = dist; this.tH = h; }
  get shotDist() { return this.sDist; }

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
    if (this.sYaw !== this.tYaw || this.sDist !== this.tDist || this.sH !== this.tH) { // カットの切替も、角度・距離・高さを連続的に動かす
      const ks = k(1.4); this.sYaw += wrap(this.tYaw - this.sYaw) * ks; this.sDist += (this.tDist - this.sDist) * ks; this.sH += (this.tH - this.sH) * ks;
      if (Math.abs(wrap(this.tYaw - this.sYaw)) < 1e-3 && Math.abs(this.tDist - this.sDist) < 1e-3 && Math.abs(this.tH - this.sH) < 1e-3) { this.sYaw = this.tYaw; this.sDist = this.tDist; this.sH = this.tH; }
    }
    const vyaw = this.yaw + this.sYaw, d = this.dist * this.sDist;
    const cc = Math.cos(this.cp), dx = -Math.sin(vyaw) * cc, dy = Math.sin(this.cp), dz = -Math.cos(vyaw) * cc;
    this._o.set(-dx * d, -dy * d + 1.3 * Math.max(0.3, this.sDist) + this.sH, -dz * d);
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
