import * as THREE from "three";
import type { Flight } from "./flight";
import type { World } from "./world";

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** 三人称追従 / 一人称。壁・地面へのめり込みを抑える。 */
export class FollowCam {
  mode: "third" | "first" = "third";
  private yaw = 0; private pos = new THREE.Vector3(); private t = 1; private ready = false;
  private _a = new THREE.Vector3(); private _b = new THREE.Vector3();
  constructor(public cam: THREE.PerspectiveCamera, private world: World) {}
  snap() { this.ready = false; }

  update(dt: number, f: Flight, bp: THREE.Vector3) {
    const k = (rate: number) => 1 - Math.exp(-rate * dt);
    if (!this.ready) { this.yaw = f.yaw; this.ready = true; this.t = 1; this.pos.set(bp.x + Math.sin(f.yaw) * 5, bp.y + 2, bp.z + Math.cos(f.yaw) * 5); }
    this.yaw += wrap(f.yaw - this.yaw) * k(this.mode === "first" ? 14 : 3.5);
    const fov = 66 + Math.min(10, f.speed * 0.4);
    if (Math.abs(this.cam.fov - fov) > 0.05) { this.cam.fov += (fov - this.cam.fov) * k(3); this.cam.updateProjectionMatrix(); }
    if (this.mode === "first") {
      this.cam.position.set(bp.x - Math.sin(f.yaw) * 0.6, bp.y + 0.28, bp.z - Math.cos(f.yaw) * 0.6);
      this.cam.rotation.set(f.pitch * 0.85, this.yaw, f.roll * 0.6, "YXZ");
      return;
    }
    const dist = (f.mode === "air" ? 5.2 : 4.0) + f.speed * 0.04;
    this._a.set(bp.x + Math.sin(this.yaw) * dist, bp.y + 1.5 + Math.max(0, -f.pitch) * 1.2, bp.z + Math.cos(this.yaw) * dist);
    this.pos.lerp(this._a, k(9));
    // 遮蔽: 鳥からカメラへ線を引き、建物・地面に入る手前で止める
    let free = 1;
    for (let i = 1; i <= 10; i++) {
      const s = i / 10, x = bp.x + (this.pos.x - bp.x) * s, y = bp.y + (this.pos.y - bp.y) * s, z = bp.z + (this.pos.z - bp.z) * s;
      if (y < this.world.heightAt(x, z) + 0.35) { free = (i - 1) / 10; break; }
    }
    this.t += (free - this.t) * (free < this.t ? k(30) : k(4));
    this.cam.position.set(bp.x + (this.pos.x - bp.x) * this.t, bp.y + (this.pos.y - bp.y) * this.t, bp.z + (this.pos.z - bp.z) * this.t);
    const gh = this.world.heightAt(this.cam.position.x, this.cam.position.z);
    if (this.cam.position.y < gh + 0.4) this.cam.position.y = gh + 0.4;
    this._b.set(bp.x - Math.sin(this.yaw) * 4, bp.y + 0.3 + f.pitch * 2, bp.z - Math.cos(this.yaw) * 4);
    this.cam.up.set(0, 1, 0); this.cam.lookAt(this._b);
  }
}
