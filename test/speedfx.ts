import * as THREE from "three";
import { check, suite } from "./harness";
import { speedIntensity, Streaks } from "../src/speedfx";
import { at, inp } from "./common";

export function speedFxTests() {
  suite("speed effects (C1)");
  check("no effect at normal speeds (<=20 m/s)", [0, 5, 9, 14, 18, 20, 22].every(v => speedIntensity(v) === 0));
  check("effect rises monotonically and saturates at 1", speedIntensity(28) > 0 && speedIntensity(28) < speedIntensity(32) && speedIntensity(34) === 1 && speedIntensity(80) === 1);
  const f = at(28, 150, 110); let normal = 0, dive = 0;
  for (let i = 0; i < 240; i++) { f.step(1 / 60, inp()); normal = Math.max(normal, speedIntensity(f.speed)); }
  const g = at(28, 150, 110); for (let i = 0; i < 360; i++) { g.step(1 / 60, inp({ y: -1 })); dive = Math.max(dive, speedIntensity(g.speed)); }
  check("ordinary gliding never shows speed lines; a long dive does", normal === 0 && dive > 0.8, `glide=${normal} dive=${dive.toFixed(2)}`);
  const s = new Streaks(), cam = new THREE.Vector3(), vel = new THREE.Vector3(0, -30, -10); let inBox = true;
  for (let t = 0; t < 600; t++) { cam.addScaledVector(vel, 1 / 60); s.update(cam, vel, 1); const p = s.mesh.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < Streaks.N; i++) inBox = inBox && Math.abs(p[i * 6] - cam.x) <= 22.001 && Math.abs(p[i * 6 + 1] - cam.y) <= 22.001 && Math.abs(p[i * 6 + 2] - cam.z) <= 22.001; }
  check("streaks stay around the camera while it travels 300+ m", inBox);
  s.update(cam, vel, 0); check("streaks hidden at zero intensity", !s.mesh.visible);
  const p = s.mesh.geometry.attributes.position.array as Float32Array; s.update(cam, vel, 1);
  const len = Math.hypot(p[0] - p[3], p[1] - p[4], p[2] - p[5]); check("streak length scales with speed but is bounded", len > 0.5 && len <= 3.01, `len=${len.toFixed(2)}`);
}
