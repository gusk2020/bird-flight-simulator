import * as THREE from "three";
import { Flight } from "./flight";
import { buildWorld } from "./world";
import { BirdModel } from "./birdModel";
import { Input } from "./input";
import { FollowCam } from "./camera";
import { Game } from "./game";
import { envAt, TIME_PRESETS } from "./env";

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

// --- 空 (頂点カラーのグラデーション球) と時刻 ---
const skyGeo = new THREE.SphereGeometry(1500, 16, 10);
skyGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(skyGeo.attributes.position.count * 3), 3));
const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
sky.renderOrder = -1; scene.add(sky);
const cloudMat = (world.clouds.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
let hour: number = TIME_PRESETS[1].hour, preset = 1, targetHour: number = hour;
function applyEnv() {
  const e = envAt(hour), top = new THREE.Color(e.top), hor = new THREE.Color(e.hor), c = new THREE.Color();
  const pos = skyGeo.attributes.position, col = skyGeo.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) { const h = Math.max(0, pos.getY(i) / 1500); c.lerpColors(hor, top, Math.pow(h, 0.6)); col.setXYZ(i, c.r, c.g, c.b); }
  col.needsUpdate = true;
  if (!scene.fog) scene.fog = new THREE.Fog(e.fog, 140, 900);
  (scene.fog as THREE.Fog).color.setHex(e.fog);
  hemi.color.setHex(e.hemiSky); hemi.groundColor.setHex(e.hemiGround); hemi.intensity = e.hemiI;
  sun.color.setHex(e.sun); sun.intensity = e.sunI; sun.position.set(...e.sunDir);
  cloudMat.color.setHex(e.cloud); world.setLights(e.lights);
}
applyEnv();
input.onTime = () => {
  preset = (preset + 1) % TIME_PRESETS.length; targetHour = TIME_PRESETS[preset].hour;
  document.getElementById("btnTime")!.textContent = TIME_PRESETS[preset].name;
};
input.onReset = () => { game.reset(); input.releaseAll(); cam.snap(); };
input.onCamera = () => {
  cam.mode = cam.mode === "third" ? "first" : "third"; bird.setVisible(cam.mode === "third");
  document.getElementById("btnCam")!.textContent = cam.mode === "third" ? "三人称" : "一人称";
};

// --- 開始 / 一時停止 ---
const game = new Game(flight, () => input.read(), () => { input.state.flapTap = false; });
const overlay = document.getElementById("overlay")!, ovTitle = document.getElementById("ovTitle")!, ovGo = document.getElementById("ovGo")!, ovReset = document.getElementById("ovReset")!;
function showOverlay() {
  const ready = game.state === "ready";
  overlay.hidden = game.state === "running";
  ovTitle.textContent = ready ? "Bird Flight Simulator" : "一時停止中";
  ovGo.textContent = ready ? "開始" : "再開"; ovReset.hidden = ready;
}
game.onPause = () => input.releaseAll();
const go = () => { if (game.state === "ready") game.start(); else game.resume(); input.releaseAll(); showOverlay(); };
const pause = () => { game.pause(); showOverlay(); };
ovGo.addEventListener("click", go);
ovReset.addEventListener("click", () => { input.onReset(); go(); });
document.getElementById("btnPause")!.addEventListener("pointerdown", e => { e.preventDefault(); pause(); });
input.onPause = () => (game.state === "running" ? pause() : go());
// 画面OFF・アプリ切替・バックグラウンドでは必ず一時停止
const away = () => { game.suspend(); showOverlay(); };
document.addEventListener("visibilitychange", () => { if (document.hidden) away(); });
addEventListener("pagehide", away); addEventListener("blur", away);
showOverlay();

function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener("resize", resize); addEventListener("orientationchange", resize); resize();

const hud = document.getElementById("hud")!, msg = document.getElementById("msg")!;
let last = performance.now(), fpsT = 0, fpsN = 0, fps = 0, hudT = 0;
const bp = new THREE.Vector3();
function frame(now: number) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
  const running = game.state === "running";
  game.update(dt);
  // 時間帯の切替アニメーション(実時間・常に前向き)
  if (Math.abs(hour - targetHour) > 1e-3) {
    const diff = (targetHour - hour + 24) % 24; hour = (hour + Math.min(diff, 10 * dt)) % 24; applyEnv();
  }
  bp.lerpVectors(flight.prevPos, flight.pos, game.alpha || 1);
  if (!running && game.state === "paused") bp.copy(flight.pos);
  const gh = world.heightAt(bp.x, bp.z);
  const vdt = running ? dt : 0;
  bird.update(vdt, flight, bp, gh);
  cam.update(vdt, flight, bp);
  renderer.render(scene, camera);
  fpsN++; fpsT += dt; hudT += dt;
  if (fpsT >= 0.5) { fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }
  if (hudT > 0.1) {
    hudT = 0;
    const st = flight.stun > 0 ? "衝突!" : flight.mode === "landed" ? "着地中" : flight.mode === "rollout" ? "滑走中" :
      flight.stall ? "失速!" : flight.braking ? "減速" : flight.strokeT >= 0 ? "羽ばたき" : "滑空";
    hud.textContent = `${st}　速度 ${flight.speed.toFixed(0)} m/s　高度 ${Math.max(0, flight.agl).toFixed(0)} m　${fps.toFixed(0)}fps`;
    msg.style.opacity = game.state === "running" && game.gameTime < 9 ? "1" : "0";
  }
}
renderer.setAnimationLoop(frame);
// テスト・デバッグ用
(window as unknown as Record<string, unknown>).__game = { game, flight, world, input, cam, camera, renderer, scene, frame, env: () => envAt(hour), setHour: (h: number) => { hour = targetHour = h; applyEnv(); } };
