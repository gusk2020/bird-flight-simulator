import * as THREE from "three";

/** 時刻(0-24h)で決まる空・光・街灯のパラメータ。キーフレーム補間なので連続的な昼夜サイクルにそのまま使える。 */
export interface Env {
  top: number; hor: number; fog: number; hemiSky: number; hemiGround: number; hemiI: number;
  sun: number; sunI: number; sunDir: [number, number, number]; cloud: number;
  lights: number; // 窓・街灯の点灯度 0..1
}
type Key = { h: number } & Env;
const KEYS: Key[] = [
  { h: 0,    top: 0x050a1c, hor: 0x1b2540, fog: 0x141b33, hemiSky: 0x6070a0, hemiGround: 0x222233, hemiI: 0.9, sun: 0x7f96d8, sunI: 0.6, sunDir: [30, 80, -40], cloud: 0x4a5578, lights: 1 },
  { h: 4.5,  top: 0x0a1230, hor: 0x2a3358, fog: 0x1c2440, hemiSky: 0x6a78a8, hemiGround: 0x262a3a, hemiI: 0.9, sun: 0x8aa0e0, sunI: 0.6, sunDir: [30, 80, -40], cloud: 0x555f82, lights: 1 },
  { h: 5.6,  top: 0x3f4f8c, hor: 0xf4a483, fog: 0xd69a88, hemiSky: 0xffc9aa, hemiGround: 0x5a5470, hemiI: 1.0, sun: 0xffa868, sunI: 1.2, sunDir: [90, 18, 20], cloud: 0xffb99c, lights: 0 },
  { h: 6.6,  top: 0x5c88c8, hor: 0xf8d2ac, fog: 0xe6c7b0, hemiSky: 0xffe4cf, hemiGround: 0x667060, hemiI: 1.3, sun: 0xffd6a8, sunI: 1.5, sunDir: [80, 45, 25], cloud: 0xffe6d0, lights: 0 },
  { h: 9,    top: 0x4f95d8, hor: 0xcfe6f5, fog: 0xcfe6f5, hemiSky: 0xffffff, hemiGround: 0x667755, hemiI: 1.5, sun: 0xffffff, sunI: 1.7, sunDir: [50, 100, 30], cloud: 0xffffff, lights: 0 },
  { h: 15,   top: 0x4f95d8, hor: 0xcfe6f5, fog: 0xcfe6f5, hemiSky: 0xffffff, hemiGround: 0x667755, hemiI: 1.5, sun: 0xffffff, sunI: 1.7, sunDir: [-40, 100, 30], cloud: 0xffffff, lights: 0 },
  { h: 17.5, top: 0x34457f, hor: 0xf2a263, fog: 0xd9967a, hemiSky: 0xffc79a, hemiGround: 0x554466, hemiI: 1.0, sun: 0xff9a55, sunI: 1.5, sunDir: [-90, 30, 40], cloud: 0xffb090, lights: 0.6 },
  { h: 19,   top: 0x161d48, hor: 0x6a4a6a, fog: 0x4a3c5a, hemiSky: 0x8a7aa8, hemiGround: 0x333044, hemiI: 0.9, sun: 0xb08ab0, sunI: 0.8, sunDir: [-90, 8, 40], cloud: 0x6a5a80, lights: 1 },
  { h: 24,   top: 0x050a1c, hor: 0x1b2540, fog: 0x141b33, hemiSky: 0x6070a0, hemiGround: 0x222233, hemiI: 0.9, sun: 0x7f96d8, sunI: 0.6, sunDir: [30, 80, -40], cloud: 0x4a5578, lights: 1 },
];
export const TIME_PRESETS = [
  { name: "朝", hour: 6 }, { name: "昼", hour: 12 }, { name: "夕", hour: 17.5 }, { name: "夜", hour: 0 },
] as const;

const A = new THREE.Color(), B = new THREE.Color();
const mixCol = (a: number, b: number, t: number) => A.setHex(a).lerp(B.setHex(b), t).getHex();
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function envAt(hour: number): Env {
  const h = ((hour % 24) + 24) % 24;
  let i = 0; while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
  const a = KEYS[i], b = KEYS[i + 1], t = (h - a.h) / (b.h - a.h), e = t * t * (3 - 2 * t);
  return {
    top: mixCol(a.top, b.top, e), hor: mixCol(a.hor, b.hor, e), fog: mixCol(a.fog, b.fog, e),
    hemiSky: mixCol(a.hemiSky, b.hemiSky, e), hemiGround: mixCol(a.hemiGround, b.hemiGround, e), hemiI: mix(a.hemiI, b.hemiI, e),
    sun: mixCol(a.sun, b.sun, e), sunI: mix(a.sunI, b.sunI, e), cloud: mixCol(a.cloud, b.cloud, e), lights: mix(a.lights, b.lights, e),
    sunDir: [0, 1, 2].map(k => mix(a.sunDir[k], b.sunDir[k], e)) as [number, number, number],
  };
}
