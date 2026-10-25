// ホットパスのCPU時間とGC負荷(node, V8)。npm run microbench。実機の値ではなく、変更前後の比較用。
import * as THREE from "three";
import { Flight } from "../src/flight";
import { generateLayout } from "../src/layout";
import { Wind } from "../src/wind";
import { FollowCam } from "../src/camera";
import { NpcWorld } from "../src/npc";
const L = generateLayout(); const world = { colliders: L.colliders, heightAt: L.heightAt, perchAt: L.perchAt, perchPoint: L.perchPoint, wireDir: L.wireDir };
const inp = { x: 0.3, y: 0, flapHeld: false, flapTap: false, brake: false };
function bench(name: string, n: number, fn: (i: number) => void) {
  for (let i = 0; i < Math.min(2000, n); i++) fn(i); // warm up
  (globalThis as { gc?: () => void }).gc?.(); const h0 = process.memoryUsage().heapUsed; const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const dt = performance.now() - t0, h1 = process.memoryUsage().heapUsed;
  console.log(`${name.padEnd(34)} ${((dt / n) * 1000).toFixed(2).padStart(8)} us/call   heapDelta=${((h1 - h0) / n).toFixed(0).padStart(5)} B/call`);
}
const f = new Flight(world); f.pos.set(28, 12, 110); f.prevPos.copy(f.pos); f.vel.set(0, 0, -10); f.wind = new Wind(L.colliders);
bench("Flight.step (air, wind, 60Hz step)", 60000, () => { f.step(1 / 60, inp); if (f.pos.y < 5 || f.pos.z < -150) { f.reset(); } });
bench("world.heightAt", 200000, i => { L.heightAt((i % 400) - 200, ((i * 7) % 400) - 200); });
const w = new Wind(L.colliders); const out = new THREE.Vector3();
bench("Wind.at (all buildings)", 100000, i => { w.at((i % 400) - 200, 10, ((i * 7) % 400) - 200, i * 0.01, out); });
bench("layout.perchAt (wire band)", 20000, i => { L.perchAt((i % 300) - 150, 7.5, ((i * 7) % 300) - 150, 0.8); });
const cam = new THREE.PerspectiveCamera(66, 2, 0.1, 1800), fc = new FollowCam(cam, world), bp = new THREE.Vector3(28, 12, 110);
bench("FollowCam.update", 60000, i => { bp.z -= 0.15; if (bp.z < -150) bp.z = 110; fc.update(1 / 60, f, bp, 0); });
const npc = new NpcWorld(L, 3); const pl = { x: 28, y: 15, z: 110, speed: 8, yaw: 0, air: true }; npc.setLevel(3, pl);
bench("NpcWorld.update (max: 14/40/16)", 30000, () => { npc.update(1 / 60, pl, 12); });
bench("NpcWorld.visiblePeds+Cars (view)", 100000, () => { npc.visiblePeds(); npc.visibleCars(); });
