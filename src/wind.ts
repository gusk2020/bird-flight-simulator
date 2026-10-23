import * as THREE from "three";
import type { Collider } from "./layout";

/** 風。bearing は「風が吹いてくる方位」(0=北,90=東,180=南,270=西)。簡略化した建物上昇気流つき。 */
export const BEARING_NAMES = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
export const bearingName = (b: number) => BEARING_NAMES[Math.round((((b % 360) + 360) % 360) / 45) % 8];

export class Wind {
  bearing = 270; speed = 2.5; gust = 0.3;
  private from = new THREE.Vector3(); private toward = new THREE.Vector3();
  private blds: { x: number; z: number; hw: number; hd: number; top: number }[] = [];
  constructor(colliders: Collider[] = []) {
    this.blds = colliders.map(c => ({ x: (c.minX + c.maxX) / 2, z: (c.minZ + c.maxZ) / 2, hw: (c.maxX - c.minX) / 2, hd: (c.maxZ - c.minZ) / 2, top: c.top }));
    this.set(this.bearing, this.speed, this.gust);
  }
  set(bearing: number, speed: number, gust: number) {
    this.bearing = bearing; this.speed = speed; this.gust = gust;
    const r = (bearing * Math.PI) / 180;
    this.from.set(Math.sin(r), 0, -Math.cos(r)); this.toward.copy(this.from).multiplyScalar(-1);
  }
  /** 地点(x,y,z)・時刻tの風ベクトル (m/s, 風が向かう方向) */
  at(x: number, y: number, z: number, t: number, out = new THREE.Vector3()) {
    const s = this.speed;
    if (s <= 0) return out.set(0, 0, 0);
    const base = s * (0.6 + 0.4 * Math.min(1, Math.max(0, y) / 40));
    const g = this.gust * s * 0.5 * (Math.sin(t * 0.7 + x * 0.02) + Math.sin(t * 1.3 + z * 0.03 + 1.7)) * 0.5;
    out.copy(this.toward).multiplyScalar(base + g);
    out.x += -this.toward.z * g * 0.4; out.z += this.toward.x * g * 0.4; // 横風の揺らぎ
    // 建物の風上側: 壁に当たった風が上へ抜ける
    const fx = this.from.x, fz = this.from.z, FACE = 12;
    for (const b of this.blds) {
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx) > b.hw + FACE + 6 || Math.abs(dz) > b.hd + FACE + 6) continue;
      const along = dx * fx + dz * fz, across = dx * -fz + dz * fx;
      const halfAlong = Math.abs(fx) * b.hw + Math.abs(fz) * b.hd, halfAcross = Math.abs(fz) * b.hw + Math.abs(fx) * b.hd;
      const face = along - halfAlong; // 風上面からの距離
      if (Math.abs(across) > halfAcross + 3 || y > b.top + 6 || y < 0) continue;
      if (face > 0 && face < FACE) out.y += Math.min(4, s * 0.45) * (1 - face / FACE) * Math.min(1, (b.top + 6 - y) / 6);
      else if (face <= 0 && along > -halfAlong - 3 && y > b.top - 1) out.y += s * 0.15; // 屋根の縁
    }
    return out;
  }
}
