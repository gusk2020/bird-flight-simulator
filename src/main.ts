import * as THREE from "three";
import { Flight } from "./flight";
import { buildWorld } from "./world";
import { BirdModel } from "./birdModel";
import { Input } from "./input";
import { FollowCam } from "./camera";
import { Game } from "./game";
import { envAt, TIME_PRESETS } from "./env";
import { Wind, bearingName } from "./wind";
import { WEATHER, applyWeather, Weather } from "./weather";
import { Rain } from "./rain";
import { Quality } from "./quality";
import { SpeedLines, Streaks, speedIntensity } from "./speedfx";
import { NpcWorld } from "./npc";
import { NpcView } from "./npcView";

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(66, 1, 0.1, 1800);
const hemi = new THREE.HemisphereLight(0xffffff, 0x667755, 1.5);
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
scene.add(hemi, sun);

const world = buildWorld(); scene.add(world.group);
const flight = new Flight(world);
const wind = new Wind(world.colliders); flight.wind = wind;
const rain = new Rain(); scene.add(rain.mesh);
const quality = new Quality();
const npc = new NpcWorld(world, 11); const npcView = new NpcView(); scene.add(npcView.group);
const streaks = new Streaks(); scene.add(streaks.mesh);
const lines = new SpeedLines(document.getElementById("fx") as HTMLCanvasElement, document.getElementById("vig")!);
let fxLevel = 1, fxSmooth = 0; const FX_MUL = [0, 0.6, 1, 1.4];
renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatio));
const bird = new BirdModel(); bird.attach(scene);
const input = new Input();
const cam = new FollowCam(camera, world);

// --- 空 (頂点カラーのグラデーション球) と時刻 ---
const skyGeo = new THREE.SphereGeometry(1500, 16, 10);
skyGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(skyGeo.attributes.position.count * 3), 3));
const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
sky.renderOrder = -1; scene.add(sky);
const cloudMat = (world.clouds.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
let hour: number = TIME_PRESETS[1].hour, preset = 1, targetHour: number | null = null;
const settings = { weather: "clear" as Weather, wind: 1, bearing: 270, time: 0, fx: 2, npc: 2, gfx: 0 };
const WIND_SPEED = [0, 3, 7], WIND_GUST = [0, 0.3, 0.6], TIME_RATE = [0, 24 / 1800, 24 / 180]; // 時間: 停止 / 等速(24h=30分) / 高速(24h=3分)
let dirty = true; // 一時停止中は、見た目が変わったときだけ再描画する(バッテリー・発熱対策)
let envHour = -1;
function applyEnv() {
  dirty = true; envHour = hour;
  const wd = WEATHER[settings.weather], e = applyWeather(envAt(hour), settings.weather), top = new THREE.Color(e.top), hor = new THREE.Color(e.hor), c = new THREE.Color();
  const pos = skyGeo.attributes.position, col = skyGeo.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) { const h = Math.max(0, pos.getY(i) / 1500); c.lerpColors(hor, top, Math.pow(h, 0.6)); col.setXYZ(i, c.r, c.g, c.b); }
  col.needsUpdate = true;
  if (!scene.fog) scene.fog = new THREE.Fog(e.fog, 140, 900);
  const fg = scene.fog as THREE.Fog; fg.color.setHex(e.fog); fg.near = wd.fogNear; fg.far = wd.fogFar;
  hemi.color.setHex(e.hemiSky); hemi.groundColor.setHex(e.hemiGround); hemi.intensity = e.hemiI;
  sun.color.setHex(e.sun); sun.intensity = e.sunI; sun.position.set(...e.sunDir);
  cloudMat.color.setHex(e.cloud); cloudMat.opacity = wd.cloudOpacity; world.setLights(e.lights);
}
const npcP = { x: 0, y: 0, z: 0, speed: 0, yaw: 0, air: false }; // 毎フレーム新しいオブジェクトを作らず使い回す
const npcPlayer = () => { npcP.x = flight.pos.x; npcP.y = flight.pos.y; npcP.z = flight.pos.z; npcP.speed = flight.speed; npcP.yaw = flight.yaw; npcP.air = flight.mode === "air"; return npcP; };
function applyQuality() { renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatio)); resize(); rain.setDensity(quality.rainDensity); }
function applySettings() {
  const wd = WEATHER[settings.weather];
  wind.set(settings.bearing, Math.min(12, WIND_SPEED[settings.wind] * wd.windMul), WIND_GUST[settings.wind]);
  flight.liftScale = wd.liftScale; flight.dragScale = wd.dragScale;
  rain.setIntensity(wd.rain); fxLevel = FX_MUL[settings.fx]; npc.setLevel(settings.npc, npcPlayer()); quality.force(settings.gfx === 0 ? null : [0, 0, 2, 3][settings.gfx]); applyQuality(); applyEnv();
  document.querySelectorAll<HTMLElement>("[data-set]").forEach(b => b.classList.toggle("on", String(settings[b.dataset.set as keyof typeof settings]) === b.dataset.val));
  document.getElementById("rowBearing")!.hidden = settings.wind === 0;
}
document.querySelectorAll<HTMLElement>("[data-set]").forEach(b => b.addEventListener("click", () => {
  (settings as Record<string, unknown>)[b.dataset.set!] = b.dataset.set === "weather" ? b.dataset.val : Number(b.dataset.val); applySettings();
}));
applyEnv();
input.onTime = () => {
  preset = (preset + 1) % TIME_PRESETS.length; targetHour = TIME_PRESETS[preset].hour;
  document.getElementById("btnTime")!.textContent = TIME_PRESETS[preset].name;
};
input.onReset = () => { dirty = true; game.reset(); input.releaseAll(); cam.snap(); };
input.onCamera = () => {
  dirty = true;
  cam.mode = cam.mode === "third" ? "first" : "third"; bird.setVisible(cam.mode === "third");
  document.getElementById("btnCam")!.textContent = cam.mode === "third" ? "三人称" : "一人称";
};

// --- 開始 / 一時停止 ---
const game = new Game(flight, () => input.read(), () => { input.state.flapTap = false; });
const overlay = document.getElementById("overlay")!, ovTitle = document.getElementById("ovTitle")!, ovGo = document.getElementById("ovGo")!, ovReset = document.getElementById("ovReset")!;
function showOverlay() {
  const ready = game.state === "ready";
  overlay.hidden = game.state === "running";
  ovTitle.textContent = ready ? "Vind Ving" : "一時停止中";
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
document.addEventListener("visibilitychange", () => { if (document.hidden) away(); else dirty = true; });
addEventListener("pagehide", away); addEventListener("blur", away);
showOverlay(); applySettings();

function resize() { dirty = true; renderer.setSize(innerWidth, innerHeight, false); lines.resize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener("resize", resize); addEventListener("orientationchange", resize); resize();

const hud = document.getElementById("hud")!, msg = document.getElementById("msg")!;
const brakeBtn = document.getElementById("brake")!; let brakeLabel = "減速";
const stats = { npcMs: 0, fxMs: 0, updateMs: 0, renderMs: 0, lines: 0 };
let lastGT = 0, last = performance.now(), fpsT = 0, fpsN = 0, fps = 0, hudT = 0;
const bp = new THREE.Vector3();
function frame(now: number) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
  const running = game.state === "running";
  game.update(dt);
  // 時間帯の切替アニメーション(実時間・常に前向き)
  const gdt = game.gameTime - lastGT; lastGT = game.gameTime;
  if (targetHour !== null) {
    const diff = (targetHour - hour + 24) % 24;
    if (diff < 1e-3) { hour = targetHour; targetHour = null; } else hour = (hour + Math.min(diff, 10 * dt)) % 24;
    applyEnv();
  } else if (gdt > 0 && TIME_RATE[settings.time] > 0) { hour = (hour + gdt * TIME_RATE[settings.time]) % 24; const dh = Math.abs(hour - envHour); if (Math.min(dh, 24 - dh) >= 0.01) applyEnv(); } // 0.01時間(36秒/高速で4.5秒)ごとに空の色などを更新
  if (running && quality.update(dt)) applyQuality();
  if (!running && !dirty) { updateHud(dt, now); return; } // 一時停止中で見た目が変わっていなければ、物理・NPC・描画をすべて省く
  rain.update(running ? dt : 0, camera.position, flight.windVec);
  bp.lerpVectors(flight.prevPos, flight.pos, game.alpha || 1);
  if (!running && game.state === "paused") bp.copy(flight.pos);
  const gh = world.heightAt(bp.x, bp.z);
  const vdt = running ? dt : 0;
  bird.update(vdt, flight, bp, gh);
  // 速度演出: 高速時のみ。強度は急に変えず滑らかに追従
  const fxTarget = flight.mode === "air" ? speedIntensity(flight.speed) * fxLevel : 0;
  fxSmooth += (fxTarget - fxSmooth) * (1 - Math.exp(-6 * vdt));
  const fxc = Math.min(1, fxSmooth);
  world.updateLOD(bp.x, bp.z);
  const tn = performance.now(); if (running) npc.update(dt, npcPlayer(), hour); npcView.update(npc, camera.position); stats.npcMs += (performance.now() - tn - stats.npcMs) * 0.05;
  cam.update(vdt, flight, bp, fxc);
  const tfx = performance.now();
  streaks.update(camera.position, flight.vel, running ? fxc : 0); stats.fxMs += (performance.now() - tfx - stats.fxMs) * 0.05;
  if (running || fxc === 0) lines.update(vdt, running ? fxc : 0);
  const tr = performance.now(); renderer.render(scene, camera); stats.renderMs += (performance.now() - tr - stats.renderMs) * 0.05;
  if (!running) dirty = false;
  updateHud(dt, now);
}
function updateHud(dt: number, now: number) {
  fpsN++; fpsT += dt; hudT += dt;
  if (fpsT >= 0.5) { fps = fpsN / fpsT; fpsN = 0; fpsT = 0; }
  const lab = flight.mode === "air" ? "減速" : "歩く"; if (lab !== brakeLabel) { brakeLabel = lab; brakeBtn.textContent = lab; }
  if (hudT > 0.1) {
    hudT = 0;
    const st = flight.stun > 0 ? "衝突!" : flight.mode === "perch" ? "電線に止まり中" : flight.hopping ? "ジャンプ" : flight.walking ? "歩行中" : flight.mode === "landed" ? "着地中" : flight.mode === "rollout" ? "滑走中" :
      flight.stall ? "失速!" : flight.braking ? "減速" : flight.strokeT >= 0 ? "羽ばたき" : "滑空";
    hud.textContent = `${st}　速度 ${flight.speed.toFixed(0)} m/s　高度 ${Math.max(0, flight.agl).toFixed(0)} m　${flight.windVec.length() > 0.1 ? `　風 ${bearingName(wind.bearing)} ${flight.windVec.length().toFixed(0)}m/s${flight.windVec.y > 1 ? " 上昇気流!" : ""}` : ""}　${fps.toFixed(0)}fps Q${quality.level}`;
    msg.style.opacity = game.state === "running" && game.gameTime < 9 ? "1" : "0";
  }
}
renderer.setAnimationLoop(frame);
// テスト・デバッグ用
(window as unknown as Record<string, unknown>).__game = { game, flight, world, input, cam, camera, renderer, scene, frame, env: () => envAt(hour), stats, npc, lines, streaks, speedIntensity, setHour: (h: number) => { hour = h; targetHour = null; applyEnv(); }, settings, applySettings, wind, rain, quality };
