import * as THREE from "three";
import type { Flight } from "./flight";
import { PHYS as P } from "./params";

/**
 * H9: 飛行ガイドの値。すべて Flight の物理量から計算する(表示専用で、物理には触れない)。
 *  標高   = 足元の高さ(m)。ワールドの高さ 0 m を海面とみなす(水平位置・ワールド原点は標高に影響しない)
 *  地上高 = 足元から真下の地形(Flight.world.heightAt)までの高さ(m)。建物の屋根は地形に含めない(屋根の上でも地形基準)
 *  方位   = 機首の向き(0=北, 90=東。ワールドの -z を北、+x を東とする: 風向 Wind.bearing と同じ規約)
 *  進行方位 = 地面に対する水平の移動方向。ほぼ静止(0.5 m/s 未満)のときは機首方位と同じ
 *  ピッチ = 機首の上下角(度, 上が +)。ロール = 左右の傾き(度, 右翼が下がる=右へ傾くが +)
 *  対地速度 = 地面に対する速さ(3 次元, km/h)。対気速度 = 空気に対する速さ(3 次元, km/h)= |速度 − 風|。無風なら一致する
 */
export interface GuideValues { elevM: number; aglM: number; headingDeg: number; trackDeg: number; pitchDeg: number; rollDeg: number; gsKmh: number; tasKmh: number }
export interface WindAt { at(x: number, y: number, z: number, t: number, out?: THREE.Vector3): THREE.Vector3 }
const RAD = 180 / Math.PI, _w = new THREE.Vector3();
const norm360 = (d: number) => ((d % 360) + 360) % 360;
export function guideValues(f: Flight, wind: WindAt | null, out: GuideValues = { elevM: 0, aglM: 0, headingDeg: 0, trackDeg: 0, pitchDeg: 0, rollDeg: 0, gsKmh: 0, tasKmh: 0 }): GuideValues {
  const feet = f.pos.y - P.feetOffset;
  out.elevM = feet; out.aglM = Math.max(0, feet - f.world.heightAt(f.pos.x, f.pos.z));
  out.headingDeg = norm360(-f.yaw * RAD);
  const hs = Math.hypot(f.vel.x, f.vel.z);
  out.trackDeg = hs >= 0.5 ? norm360(Math.atan2(f.vel.x, -f.vel.z) * RAD) : out.headingDeg;
  out.pitchDeg = f.pitch * RAD; out.rollDeg = -f.roll * RAD;
  if (wind) wind.at(f.pos.x, f.pos.y, f.pos.z, f.clock, _w); else _w.set(0, 0, 0);
  out.gsKmh = f.vel.length() * 3.6;
  out.tasKmh = Math.hypot(f.vel.x - _w.x, f.vel.y - _w.y, f.vel.z - _w.z) * 3.6;
  return out;
}
export const COMPASS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
export const compassName = (deg: number) => COMPASS[Math.round(norm360(deg) / 45) % 8];
