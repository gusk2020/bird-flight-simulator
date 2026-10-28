// カメラ上下揺れの定量比較: node でフライトを進め、FollowCam の高さの動きを測る(修正前=stableHeight:false / 修正後=true)。
// npx esbuild tools/camera_shake.ts --bundle --platform=node --outfile=dist-test/shake.cjs && node dist-test/shake.cjs
import * as THREE from "three";
import { Flight } from "../src/flight";
import { FollowCam } from "../src/camera";
import { generateLayout } from "../src/layout";

const L = generateLayout();
const world = { colliders: L.colliders, heightAt: L.heightAt, perchAt: L.perchAt, perchPoint: L.perchPoint, wireDir: L.wireDir };
export interface Shake { birdP2P: number; camP2P: number; ratio: number; birdHF: number; camHF: number; hfRatio: number; viewHF: number; maxLag: number; minAboveGround: number; frames: number }
/** 羽ばたき周波数(タップ間隔42フレーム=約1.43Hz)とその倍音での振幅(ロックイン検出、p2p換算)。ゆっくりした高度変化は含まない。 */
function hf(v0: number[]) { const W = 42, v: number[] = []; for (let i = W; i < v0.length - W; i++) { let m = 0; for (let k = -W; k <= W; k++) m += v0[i + k]; v.push(v0[i] - m / (2 * W + 1)); } let tot = 0; for (const mult of [1, 2]) { const w = 2 * Math.PI * mult * 60 / 42 / 60; let c = 0, s = 0; for (let i = 0; i < v.length; i++) { c += v[i] * Math.cos(w * i); s += v[i] * Math.sin(w * i); } tot += (2 * Math.hypot(c, s) / v.length) ** 2; } return 2 * Math.sqrt(tot); }
export function measure(opts: { stable: boolean; mode?: "third" | "first"; secs?: number; pitchInput?: (t: number) => number; speed?: number; y?: number; flap?: "hold" | "tap" | "none"; from?: number }): Shake {
  const f = new Flight(world); f.pos.set(0, opts.y ?? 40, 0); f.prevPos.copy(f.pos); f.yaw = 0; f.vel.set(0, 0, -(opts.speed ?? 14));
  const cam = new THREE.PerspectiveCamera(66, 1.8, 0.1, 1800), fc = new FollowCam(cam, { heightAt: L.heightAt }); fc.stableHeight = opts.stable; fc.mode = opts.mode ?? "third";
  const bp = new THREE.Vector3(), secs = opts.secs ?? 14; const by: number[] = [], cy: number[] = [], vp: number[] = [], dirv = new THREE.Vector3(); let maxLag = 0, minG = 1e9;
  for (let i = 0; i < secs * 60; i++) {
    const t = i / 60;
    f.step(1 / 60, { x: 0, y: opts.pitchInput ? opts.pitchInput(t) : 0, flapHeld: (opts.flap ?? "tap") === "hold", flapTap: (opts.flap ?? "tap") === "tap" && i % 42 === 0, brake: false });
    bp.copy(f.pos); fc.update(1 / 60, f, bp, 0);
    if (t > (opts.from ?? 4)) { by.push(bp.y); cy.push(cam.position.y); cam.getWorldDirection(dirv); vp.push(Math.asin(dirv.y) * 57.2958); const lag = Math.abs((cam.position.y - bp.y) - (cy.length > 1 ? 0 : 0)); maxLag = Math.max(maxLag, lag); minG = Math.min(minG, cam.position.y - L.heightAt(cam.position.x, cam.position.z)); }
  }
  const p2p = (v: number[]) => Math.max(...v) - Math.min(...v), bh = hf(by), ch = hf(cy);
  return { birdP2P: p2p(by), camP2P: p2p(cy), ratio: p2p(cy) / Math.max(1e-9, p2p(by)), birdHF: bh, camHF: ch, hfRatio: ch / Math.max(1e-9, bh), viewHF: hf(vp), maxLag, minAboveGround: minG, frames: cy.length };
}
if (typeof process !== "undefined" && process.argv[1]?.includes("shake")) {
  const fmt = (s: Shake) => `bird上下(羽ばたき周波数の上下) ${s.birdHF.toFixed(3)} m → カメラ ${s.camHF.toFixed(3)} m (${(100 * s.hfRatio).toFixed(0)}%)  視線の上下角の揺れ ${s.viewHF.toFixed(2)}°`;
  for (const [name, o] of [["三人称・約0.7秒ごとの羽ばたき", { mode: "third" as const }], ["一人称・約0.7秒ごとの羽ばたき", { mode: "first" as const }]] as const) {
    console.log(name); console.log("  修正前: " + fmt(measure({ ...o, stable: false }))); console.log("  修正後: " + fmt(measure({ ...o, stable: true })));
  }
}
