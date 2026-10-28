import * as THREE from "three";
import type { Flight } from "./flight";

/** 高さフィルタの調整値(tools/camera_tune.ts で既存のカメラ試験を全て満たす範囲から探した) */
export const CAM_TUNE = { tauS: 1.051, corr: 0.3, corrFirst: 0.5, softK: 4.76, softOff: 0.302, pkLo: 2.646, pkRange: 6.066, swUp: 2.04, swDown: 0.5, cpSlow: 3.245, maxLag: 0.205 };
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
  /**
   * 羽ばたきの細かな上下動をカメラへ伝えない(鳥の体・物理はそのまま)。
   * 注視点の高さだけを低域通過フィルタに通す: 羽ばたき周期(約3Hz)の揺れは落とし、上昇・下降のような持続的な高度変化には追従する。
   * 遅れが大きくなりすぎないよう、鳥との高さの差には上限(CAM_TUNE.maxLag)を設ける。
   */
  stableHeight = true; private ay = 0; private vyPk = 0; private vyF = 0; private vyS = 0; private cpSlow = 0; private sw = 0; private fp = 0;
  snap() { this.ready = false; this.sYaw = this.tYaw = 0; this.sDist = this.tDist = 1; this.sH = this.tH = 0; }
  // オートのカット(演出): 目標値へなめらかに寄せる。既定(0,1,0)は従来の追従と完全に同じ
  private sYaw = 0; private tYaw = 0; private sDist = 1; private tDist = 1; private sH = 0; private tH = 0;
  setShot(yaw: number, dist: number, h: number) { this.tYaw = yaw; this.tDist = dist; this.tH = h; }
  get shotDist() { return this.sDist; }

  private anchorY(dt: number, f: Flight, y: number) {
    if (!this.stableHeight || dt <= 0) { if (!this.stableHeight) this.ay = y; return this.ay; }
    if (f.mode !== "air") { this.vyF = this.vyS = 0; this.vyPk = 0; this.ay += (y - this.ay) * (1 - Math.exp(-9 * dt)); return this.ay; } // 着地・歩行中は素早く追従(地面の近くで浮いたり沈んだりしない)
    // 空中: 鳥の上下速度をゆっくり均した値で高さを進める(上昇・下降の持続的な動きには遅れなく追従、羽ばたきの往復運動は打ち消される)。位置のずれは穏やかに補正。
    this.vyF += (f.vel.y - this.vyF) * (1 - Math.exp(-dt / 0.3)); // 急な上下の検出用(速い)
    this.vyS += (f.vel.y - this.vyS) * (1 - Math.exp(-dt / CAM_TUNE.tauS)); // 高さを進める用(遅い=羽ばたきの往復を強く打ち消す)
    this.ay += (this.vyS + (this.vyF - this.vyS) * this.sw) * dt; // 持続的な上下動(sw大)では速い方で進め、遅れを作らない
    const e = y - this.ay, soft = e / CAM_TUNE.maxLag; // ずれが大きいほど強く引き戻す(上限で急に止めると加速度が跳ねるので、なめらかな非線形)
    this.ay += e * (1 - Math.exp(-((this.mode === "first" ? CAM_TUNE.corrFirst : CAM_TUNE.corr) + CAM_TUNE.softK * Math.pow(Math.max(0, Math.min(1.5, Math.abs(soft) - CAM_TUNE.softOff)), 2)) * dt));
    // 急な上昇・急降下(上下速度が大きい)ときは鳥の本当の高さへ滑らかに寄せる: 鳥を画面中央に保ち、背景が遅れて見えるのを防ぐ
    // 上下速度の「ピーク保持」(立ち上がりは即時、戻りはゆっくり)で急な上下を検出。羽ばたきの往復(±3m/s程度)では動かない
    this.vyPk = Math.max(Math.abs(f.vel.y), this.vyPk * Math.exp(-dt / 0.6));
    const w = Math.min(1, Math.max(0, (this.vyPk - CAM_TUNE.pkLo) / CAM_TUNE.pkRange)), target = w * w * (3 - 2 * w);
    const sw = this.sw + Math.max(-CAM_TUNE.swDown * dt, Math.min(CAM_TUNE.swUp * dt, target - this.sw)); // 切り替えの速さに上限(寄せ方が急に変わって画面が跳ねない)
    this.sw = sw;
    return this.ay + (y - this.ay) * sw;
  }
  update(dt: number, f: Flight, bp: THREE.Vector3, fx = 0) {
    const k = (rate: number) => 1 - Math.exp(-rate * dt);
    const wantCp = Math.max(-0.8, Math.min(0.6, f.pitch * 0.75));
    if (!this.ready) { this.ay = bp.y; this.vyF = this.vyS = f.vel.y; this.cpSlow = wantCp; this.fp = f.pitch; this.yaw = f.yaw; this.cp = wantCp; this.dist = 5.2; this.t = 1; this.ready = true; }
    this.yaw += wrap(f.yaw - this.yaw) * k(this.mode === "first" ? 14 : 5);
    // 羽ばたきで機首がわずかに上下するのをカメラ角へ伝えない(安定時は時定数を長く)。急降下・急上昇の大きな変化には約0.5秒で追従
    this.cp += (wantCp - this.cp) * k(5);
    this.cpSlow += (wantCp - this.cpSlow) * k(CAM_TUNE.cpSlow); // 羽ばたきで機首が揺れるぶんを、カメラの高さ(周回角)へ伝えないための遅い追従
    this.fp += (f.pitch - this.fp) * (this.stableHeight ? k(f.mode === "air" ? 4.5 : 10) : 1);
    const fov = 66 + Math.min(4, f.speed * 0.2) + 14 * fx; // 高速では視野を広げて速度感を出す
    if (Math.abs(this.cam.fov - fov) > 0.05) { this.cam.fov += (fov - this.cam.fov) * k(3); this.cam.updateProjectionMatrix(); }
    const ay = this.anchorY(dt, f, bp.y), by = this.stableHeight ? ay : bp.y;
    if (this.mode === "first") {
      this.cam.position.set(bp.x - Math.sin(f.yaw) * 0.6, by + 0.28, bp.z - Math.cos(f.yaw) * 0.6);
      this.cam.rotation.set((this.stableHeight ? this.fp : f.pitch) * 0.85, this.yaw, f.roll * 0.6, "YXZ");
      return;
    }
    this.dist += ((f.mode === "air" ? 5.2 + 2.2 * fx : 4.0) - this.dist) * k(3);
    if (this.sYaw !== this.tYaw || this.sDist !== this.tDist || this.sH !== this.tH) { // カットの切替も、角度・距離・高さを連続的に動かす
      const ks = k(1.4); this.sYaw += wrap(this.tYaw - this.sYaw) * ks; this.sDist += (this.tDist - this.sDist) * ks; this.sH += (this.tH - this.sH) * ks;
      if (Math.abs(wrap(this.tYaw - this.sYaw)) < 1e-3 && Math.abs(this.tDist - this.sDist) < 1e-3 && Math.abs(this.tH - this.sH) < 1e-3) { this.sYaw = this.tYaw; this.sDist = this.tDist; this.sH = this.tH; }
    }
    const vyaw = this.yaw + this.sYaw, d = this.dist * this.sDist;
    const cpEff = this.stableHeight ? this.cpSlow + (this.cp - this.cpSlow) * this.sw : this.cp; // 持続的な急上昇・急降下(sw大)では素早い追従、巡航中の機首の揺れでは遅い追従 // 持続的な上昇・降下(sw大)では素早い追従、巡航中の機首の揺れでは遅い追従
    const cc = Math.cos(cpEff), dx = -Math.sin(vyaw) * cc, dy = Math.sin(cpEff), dz = -Math.cos(vyaw) * cc;
    this._o.set(-dx * d, -dy * d + 1.3 * Math.max(0.3, this.sDist) + this.sH, -dz * d);
    // 遮蔽: 鳥からカメラへ線を引き、建物・地面に入る手前で止める
    let free = 1;
    for (let i = 1; i <= 10; i++) {
      const s = i / 10, x = bp.x + this._o.x * s, y = by + this._o.y * s, z = bp.z + this._o.z * s;
      if (y < this.world.heightAt(x, z) + 0.35) { free = (i - 1) / 10; break; }
    }
    this.t += (free - this.t) * (free < this.t ? k(30) : k(4));
    this._p.set(bp.x, by, bp.z).addScaledVector(this._o, this.t);
    const gh = this.world.heightAt(this._p.x, this._p.z);
    if (this._p.y < gh + 0.4) this._p.y = gh + 0.4;
    this.cam.position.copy(this._p);
    this._b.set(bp.x + dx * 4, by + 0.3 + dy * 4, bp.z + dz * 4);
    this.cam.up.set(0, 1, 0); this.cam.lookAt(this._b);
  }
}
