import type { Flight } from "./flight";
import type { PerchAssist } from "./perchassist";
import type { AutoLand } from "./autoland";

/** H2 近接機動で足場へゆっくり寄っている(着地の意図がある)ときだけ自動着地を始める。通りすがりでは始めない。 */
export const PROXLAND = {
  maxSpeed: 4.5,     // 水平速度がこれ以下(クリープ〜低速)
  maxDist: 5,        // 目印の面までの水平距離 m
  maxAngleDeg: 40,   // 向きが面の方向からこの角度以内
  maxAbove: 5,       // 足が面よりこの高さ以内
  holdTime: 0.6,     // 上の条件が途切れず続いた秒数
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class ProxLand {
  t = 0; starts = 0;
  constructor(private pa: PerchAssist, private al: AutoLand) {}
  /** 毎物理ステップ。条件が連続したら自動着地を開始し true を返す */
  update(f: Flight, dt: number, proxHeld: boolean): boolean {
    const s = this.pa.marker;
    if (s && this.pa.target !== s) { this.t = 0; return false; } // 保持中だけの古い候補では、近接からの自動着地を始めない(いまの候補選別で選ばれているときだけ)
    if (!proxHeld || !s || this.al.active || f.mode !== "air" || f.hopping || f.stun > 0) { this.t = 0; return false; }
    const hs = Math.hypot(f.vel.x, f.vel.z);
    const cx = Math.min(Math.max(f.pos.x, s.minX), s.maxX), cz = Math.min(Math.max(f.pos.z, s.minZ), s.maxZ), d = Math.hypot(cx - f.pos.x, cz - f.pos.z);
    const above = f.pos.y - 0.0 - s.top;
    const ang = d > 0.3 ? Math.abs(wrap(Math.atan2(-(cx - f.pos.x), -(cz - f.pos.z)) - f.yaw)) : 0;
    const ok = hs <= PROXLAND.maxSpeed && d <= PROXLAND.maxDist && ang <= PROXLAND.maxAngleDeg * Math.PI / 180 && above < PROXLAND.maxAbove + 1.2 && above > -0.3;
    this.t = ok ? this.t + dt : 0;
    if (this.t >= PROXLAND.holdTime && this.al.start(f, s)) { this.t = 0; this.starts++; return true; }
    return false;
  }
}
