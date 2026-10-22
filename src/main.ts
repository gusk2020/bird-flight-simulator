import * as THREE from "three";
import { Flight } from "./flight";
import { buildWorld } from "./world";
import { BirdModel } from "./birdModel";
import { Input } from "./input";
import { FollowCam } from "./camera";

const STEP = 1 / 60;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(66, 1, 0.1, 1800);
const hemi = new THREE.HemisphereLight(0xffffff, 0x667755, 1.5);
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
scene.add(hemi, sun);

const world = buildWorld(); scene.add(world.group);
const flight = new Flight(world);
const bird = new BirdModel(); bird.attach(scene);
const input = new Input();
const cam = new FollowCam(camera, world);

// --- 空 (頂点カラーのグラデーション球) と時間帯 ---
const skyGeo = new THREE.SphereGeometry(1500, 16, 10);
skyGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(skyGeo.attributes.position.count * 3), 3));
const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
sky.renderOrder = -1; scene.add(sky);
const TOD = [
  { name: "昼", top: 0x4f95d8, hor: 0xcfe6f5, fog: 0xcfe6f5, hs: 0xffffff, hg: 0x667755, hi: 1.5, sc: 0xffffff, si: 1.7, sp: [50, 100, 30], cloud: 0xffffff },
  { name: "夕", top: 0x34457f, hor: 0xf2a263, fog: 0xd9967a, hs: 0xffc79a, hg: 0x554466, hi: 1.0, sc: 0xff9a55, si: 1.5, sp: [-90, 30, 40], cloud: 0xffb090 },
  { name: "夜", top: 0x050a1c, hor: 0x1b2540, fog: 0x141b33, hs: 0x6070a0, hg: 0x222233, hi: 0.9, sc: 0x7f96d8, si: 0.6, sp: [30, 80, -40], cloud: 0x4a5578 },
] as const;
let tod = 0;
function applyTod() {
  const p = TOD[tod], top = new THREE.Color(p.top), hor = new THREE.Color(p.hor), c = new THREE.Color();
  const pos = skyGeo.attributes.position, col = skyGeo.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) { const h = Math.max(0, pos.getY(i) / 1500); c.lerpColors(hor, top, Math.pow(h, 0.6)); col.setXYZ(i, c.r, c.g, c.b); }
  col.needsUpdate = true;
  scene.fog = new THREE.Fog(p.fog, 140, 900);
  hemi.color.setHex(p.hs); hemi.groundColor.setHex(p.hg); hemi.intensity = p.hi;
  sun.color.setHex(p.sc); sun.intensity = p.si; sun.position.set(...(p.sp as unknown as [number, number, number]));
  (world.clouds.children[0] as THREE.Mesh).material && ((world.clouds.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(p.cloud);
  document.getElementById("btnTime")!.textContent = p.name;
}
applyTod();
input.onTime = () => { tod = (tod + 1) % TOD.length; applyTod(); };
input.onReset = () => { flight.reset(); input.releaseAll(); cam.snap(); };
input.onCamera = () => {
  cam.mode = cam.mode === "third" ? "first" : "third"; bird.setVisible(cam.mode === "third");
  document.getElementById("btnCam")!.textContent = cam.mode === "third" ? "三人称" : "一人称";
};

function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener("resize", resize); addEventListener("orientationchange", resize); resize();

const hud = document.getElementById("hud")!, msg = document.getElementById("msg")!;
let acc = 0, last = performance.now(), fpsT = 0, fpsN = 0, fps = 0, hudT = 0, t0 = last;
const bp = new THREE.Vector3();
renderer.setAnimationLoop(now => {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  acc += dt;
  for (let n = 0; acc >= STEP; acc -= STEP) {
    flight.step(STEP, input.read()); input.state.flapTap = false;
    if (++n >= 6) { acc = 0; break; }
  }
  bp.lerpVectors(flight.prevPos, flight.pos, acc / STEP);
  const gh = world.heightAt(bp.x, bp.z);
  bird.update(dt, flight, bp, gh);
  cam.update(dt, flight, bp);
  renderer.render(scene, camera);
  fpsN++; fpsT += dt; hudT += dt;
  if (fpsT >= 0.5) { fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }
  if (hudT > 0.1) {
    hudT = 0;
    const st = flight.stun > 0 ? "衝突!" : flight.mode === "landed" ? "着地中" : flight.mode === "rollout" ? "滑走中" :
      flight.stall ? "失速!" : flight.braking ? "減速" : flight.strokeT >= 0 ? "羽ばたき" : "滑空";
    hud.textContent = `${st}　速度 ${flight.speed.toFixed(0)} m/s　高度 ${Math.max(0, flight.agl).toFixed(0)} m　${fps.toFixed(0)}fps`;
    msg.style.opacity = now - t0 < 9000 ? "1" : "0";
  }
});
// テスト・デバッグ用
(window as unknown as Record<string, unknown>).__game = { flight, world, input, cam, camera, renderer, scene };
