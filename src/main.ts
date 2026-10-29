import * as THREE from "three";
import { Flight } from "./flight";
import { buildWorld } from "./world";
import { BirdModel } from "./birdModel";
import { Input } from "./input";
import { FollowCam } from "./camera";
import { Game } from "./game";
import { envAt, TIME_PRESETS } from "./env";
import { Wind, bearingName } from "./wind";
import { WEATHER, applyWeatherDef, Weather } from "./weather";
import { CameraDirector, WeatherDrift, UiHider, weatherAtLevel, autoHoursPerSecond, FIRST_PERSON_BELOW } from "./autoview";
import type { TimeSpeed } from "./settings";
import { Rain } from "./rain";
import { Quality } from "./quality";
import { loadPrefs, savePrefs, ControlMode } from "./settings";
import { FlapAssist } from "./assist";
import { Autopilot } from "./autopilot";
import { buildSurfaces } from "./perches";
import { Forage } from "./forage";
import { SeasonClock, seasonBias, seasonLook, type SeasonSpeed } from "./season";
import { PerchAssist, PERCH } from "./perchassist";
import type { AutoPolicy } from "./settings";
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
const prefs = loadPrefs(); // 前回の操作方式など(壊れていれば既定値)。ゲーム自体は必ず開始待ちで始まる
const settings = { weather: "clear" as Weather, wind: 1, bearing: 270, time: 0, fx: 2, npc: 2, gfx: 0, ctl: prefs.control as string, apol: prefs.autoPolicy as string, ats: prefs.autoTimeSpeed as string, ahide: prefs.autoHideUi ? "1" : "0", ss: prefs.seasonSpeed as string };
const WX_INDEX: Record<Weather, number> = { clear: 0, cloudy: 1, rain: 2 }, WX_NAMES: Weather[] = ["clear", "cloudy", "rain"];
// 天気の連続値(0晴/1曇/2雨)。手動ではボタンの値、オート中はゆっくり移り変わる
let wxLevel = 0, appliedWeather: Weather = "clear";
const WIND_SPEED = [0, 3, 7], WIND_GUST = [0, 0.3, 0.6], TIME_RATE = [0, 24 / 1800, 24 / 180]; // 時間: 停止 / 等速(24h=30分) / 高速(24h=3分)
const season = new SeasonClock(); season.phase = prefs.seasonPhase; season.speed = prefs.seasonSpeed;
let seasonApplied = -1, daylightApplied = -1, seasonSaveT = 0;
let dirty = true; // 一時停止中は、見た目が変わったときだけ再描画する(バッテリー・発熱対策)
let envHour = -1;
function applyEnv() {
  dirty = true; envHour = hour;
  const wd = weatherAtLevel(wxLevel), e = applyWeatherDef(envAt(hour), wd), top = new THREE.Color(e.top), hor = new THREE.Color(e.hor), c = new THREE.Color();
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
const assist = new FlapAssist();
// 着地補助: 常時オン(切替UIなし)。手動操作のときだけ働き、オート周遊は自分の判断で降りる
const perchAssist = new PerchAssist(buildSurfaces(world));
// 自動ついばみ(草地・土・あぜ道で、数歩ごとに止まって頭を下げる)。手動もオートも同じ仕組みで、強い入力(羽ばたき・大きなスティック)があれば中断する
const forage = new Forage(world.groundAt, (Date.now() & 0xffff) + 11);
// 着地できそうな場所を示す、控えめな半透明の目印(最も狙っている候補だけ)
const perchMarker = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0.4, depthWrite: false, fog: false }));
perchMarker.visible = false; perchMarker.renderOrder = 2; scene.add(perchMarker);
const CTL_NAMES: Record<ControlMode, string> = { both: "両手", right: "右手", left: "左手" };
function applyControl() {
  const m = settings.ctl as ControlMode;
  input.setMode(m); assist.enabled = m !== "both"; assist.reset();
  document.body.dataset.ctl = m; document.getElementById("btnCtl")!.textContent = CTL_NAMES[m];
  if (prefs.control !== m) { prefs.control = m; savePrefs(prefs); }
  const p = settings.apol as AutoPolicy;
  if (p !== autopilot.policy) autopilot.setPolicy(p);
  if (prefs.autoPolicy !== p) { prefs.autoPolicy = p; savePrefs(prefs); }
  dirty = true;
}
function syncWeatherLevel() { if (settings.weather !== appliedWeather) { appliedWeather = settings.weather; wxLevel = WX_INDEX[settings.weather]; drift.level = drift.target = wxLevel; } }
function applyWeatherOnly() {
  const wd = weatherAtLevel(wxLevel);
  wind.set(settings.bearing, Math.min(12, WIND_SPEED[settings.wind] * wd.windMul), WIND_GUST[settings.wind]);
  flight.liftScale = wd.liftScale; flight.dragScale = wd.dragScale; rain.setIntensity(wd.rain); applyEnv();
}
// --- 季節: 見た目(材質・樹冠・田んぼ)と行動の偏りを、季節が少し進んだとき・昼夜の明るさが変わったときだけ更新する
function saveSeason() { prefs.seasonPhase = season.phase; prefs.seasonSpeed = season.speed; savePrefs(prefs); seasonSaveT = 0; }
const SEASON_ORDER: SeasonSpeed[] = ["slow", "normal", "fast"], SEASON_SPEED_NAME: Record<SeasonSpeed, string> = { slow: "ゆったり(60分で1年)", normal: "標準(30分で1年)", fast: "高速(10分で1年)" };
function updateSeasonButton() { const b = document.getElementById("btnSeason"); if (b) b.textContent = season.name; }
let toastT = 0; function toast(t: string) { const el = document.getElementById("toast")!; el.textContent = t; el.style.opacity = "1"; toastT = 2; dirty = true; }
function applySeasonLook(force = false) {
  const dl = Math.min(1, Math.max(0, envAt(hour).sunI / 1.4));
  const dp = Math.abs(season.phase - seasonApplied); if (!force && Math.min(dp, 1 - dp) < 0.0015 && Math.abs(dl - daylightApplied) < 0.08) return;
  seasonApplied = season.phase; daylightApplied = dl; world.setSeason(seasonLook(season.phase), dl);
  const b = seasonBias(season.phase); autopilot.setSeasonBias(b); npc.setSeasonBias(b); updateSeasonButton(); dirty = true;
}
function applySettings() {
  applyControl(); syncWeatherLevel();
  const ts = settings.ats as TimeSpeed, hide = settings.ahide === "1";
  if (prefs.autoTimeSpeed !== ts || prefs.autoHideUi !== hide) { prefs.autoTimeSpeed = ts; prefs.autoHideUi = hide; savePrefs(prefs); }
  if (season.speed !== settings.ss) { season.setSpeed(settings.ss as SeasonSpeed); saveSeason(); updateSeasonButton(); }
  const wd = weatherAtLevel(wxLevel);
  wind.set(settings.bearing, Math.min(12, WIND_SPEED[settings.wind] * wd.windMul), WIND_GUST[settings.wind]);
  flight.liftScale = wd.liftScale; flight.dragScale = wd.dragScale;
  rain.setIntensity(wd.rain); fxLevel = FX_MUL[settings.fx]; npc.setLevel(settings.npc, npcPlayer()); quality.force(settings.gfx === 0 ? null : [0, 0, 2, 3][settings.gfx]); applyQuality(); applyEnv();
  document.querySelectorAll<HTMLElement>("[data-set]").forEach(b => b.classList.toggle("on", String(settings[b.dataset.set as keyof typeof settings]) === b.dataset.val));
  document.getElementById("rowBearing")!.hidden = settings.wind === 0;
}
document.querySelectorAll<HTMLElement>("[data-set]").forEach(b => b.addEventListener("click", () => {
  (settings as Record<string, unknown>)[b.dataset.set!] = b.dataset.set === "weather" || b.dataset.set === "ctl" || b.dataset.set === "apol" || b.dataset.set === "ats" || b.dataset.set === "ahide" || b.dataset.set === "ss" ? b.dataset.val : Number(b.dataset.val); applySettings();
}));
applyEnv();
input.onTime = () => {
  preset = (preset + 1) % TIME_PRESETS.length; targetHour = TIME_PRESETS[preset].hour;
  document.getElementById("btnTime")!.textContent = TIME_PRESETS[preset].name;
};
input.onReset = () => { forage.reset(); if (autopilot.enabled) setAuto(false); dirty = true; game.reset(); input.releaseAll(); cam.snap(); };
input.onCamera = () => {
  dirty = true;
  cam.mode = cam.mode === "third" ? "first" : "third"; bird.setVisible(cam.mode === "third");
  document.getElementById("btnCam")!.textContent = cam.mode === "third" ? "三人称" : "一人称";
};

// --- 開始 / 一時停止 ---
const autopilot = new Autopilot(world, (Date.now() & 0xffff) + 1); autopilot.setPolicy(prefs.autoPolicy);
const director = new CameraDirector((Date.now() >>> 3) + 7), drift = new WeatherDrift(0, (Date.now() >>> 5) + 3), uiHider = new UiHider();
const TS_NAMES: Record<TimeSpeed, string> = { slow: "ゆったり", normal: "標準", fast: "高速" }, TS_ORDER: TimeSpeed[] = ["slow", "normal", "fast"];
document.getElementById("btnSeason")!.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); settings.ss = SEASON_ORDER[(SEASON_ORDER.indexOf(season.speed) + 1) % 3]; applySettings(); toast("季節の速さ: " + SEASON_SPEED_NAME[season.speed]); });
applySeasonLook(true);
const autoIn = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
const POL_NAMES: Record<AutoPolicy, string> = { life: "自然生活", scenic: "景色観賞", adventure: "冒険探索", random: "おまかせ" };
// オート中は手動入力を読まない(スティックやタップは無視)。解除しても飛行状態はそのまま続く
const readInput = () => {
  if (autopilot.enabled) { autoIn.flapTap = false; autoIn.flapHeld = false; autoIn.brake = false; autopilot.busy = forage.active; return forage.apply(autopilot.drive(flight, autoIn, 1 / 60), flight, false); }
  return forage.apply(assist.apply(perchAssist.apply(input.read(), flight), flight), flight, true);
};
const game = new Game(flight, readInput, () => { input.state.flapTap = false; });
function applyAuto() {
  const on = autopilot.enabled;
  document.body.dataset.auto = on ? "1" : "0";
  document.getElementById("btnAutoOff")!.hidden = !on; document.getElementById("btnPol")!.hidden = !on;
  document.getElementById("btnPol")!.textContent = POL_NAMES[autopilot.policy];
  document.getElementById("btnTs")!.hidden = !on; document.getElementById("btnTs")!.textContent = "時間 " + TS_NAMES[settings.ats as TimeSpeed];
  document.body.classList.toggle("ui-hidden", on && uiHider.hidden);
  dirty = true;
}
function setAuto(on: boolean) {
  if (on === autopilot.enabled) return;
  if (on) { autopilot.setPolicy(settings.apol as AutoPolicy); autopilot.start(flight); drift.level = drift.target = wxLevel; director.reset(); uiHider.touch(); }
  else { // 解除: 到達した時刻・天気はそのまま。カメラは追従へなめらかに戻る
    autopilot.stop(); director.reset(); cam.setShot(0, 1, 0); if (cam.mode === "third") bird.setVisible(true);
    settings.weather = appliedWeather = WX_NAMES[Math.round(wxLevel)]; applySettingsLight();
  }
  input.releaseAll(); applyAuto();
}
// 解除時: 天気ボタンの見た目だけ合わせる(連続値の天気はそのまま保つ)
function applySettingsLight() { document.querySelectorAll<HTMLElement>("[data-set]").forEach(b => b.classList.toggle("on", String(settings[b.dataset.set as keyof typeof settings]) === b.dataset.val)); }
document.getElementById("btnTs")!.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); settings.ats = TS_ORDER[(TS_ORDER.indexOf(settings.ats as TimeSpeed) + 1) % 3]; applySettings(); applyAuto(); });
const POLS: AutoPolicy[] = ["life", "scenic", "adventure", "random"];
function setPolicy(p: AutoPolicy) { settings.apol = p; applySettings(); applyAuto(); }
addEventListener("pointerdown", () => { if (uiHider.hidden) { uiHider.touch(); document.body.classList.remove("ui-hidden"); dirty = true; } else uiHider.touch(); }, true);
document.getElementById("btnAutoOff")!.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); setAuto(false); });
document.getElementById("btnPol")!.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); setPolicy(POLS[(POLS.indexOf(autopilot.policy) + 1) % 4]); });
document.getElementById("btnCtl")!.addEventListener("pointerdown", e => { e.preventDefault(); const order: ControlMode[] = ["both", "right", "left"]; settings.ctl = order[(order.indexOf(settings.ctl as ControlMode) + 1) % 3]; applySettings(); });
const overlay = document.getElementById("overlay")!, ovTitle = document.getElementById("ovTitle")!, ovGo = document.getElementById("ovGo")!, ovReset = document.getElementById("ovReset")!;
function showOverlay() {
  const ready = game.state === "ready";
  overlay.hidden = game.state === "running";
  ovTitle.textContent = ready ? "Vind Ving" : "一時停止中";
  ovGo.textContent = ready ? "開始" : "再開"; ovReset.hidden = ready;
}
game.onPause = () => input.releaseAll();
const go = () => { if (game.state === "ready") game.start(); else game.resume(); input.releaseAll(); showOverlay(); };
const pause = () => { game.pause(); saveSeason(); showOverlay(); };
ovGo.addEventListener("click", go);
ovReset.addEventListener("click", () => { input.onReset(); go(); });
document.getElementById("ovAuto")!.addEventListener("click", () => { go(); setAuto(true); });
document.getElementById("btnPause")!.addEventListener("pointerdown", e => { e.preventDefault(); pause(); });
input.onPause = () => (game.state === "running" ? pause() : go());
// 画面OFF・アプリ切替・バックグラウンドでは必ず一時停止
const away = () => { game.suspend(); saveSeason(); showOverlay(); };
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
  season.advance(gdt); if (gdt > 0) { applySeasonLook(); seasonSaveT += dt; if (seasonSaveT > 10) saveSeason(); }
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) document.getElementById("toast")!.style.opacity = "0"; }
  if (targetHour !== null) {
    const diff = (targetHour - hour + 24) % 24;
    if (diff < 1e-3) { hour = targetHour; targetHour = null; } else hour = (hour + Math.min(diff, 10 * dt)) % 24;
    applyEnv();
  } else if (gdt > 0 && (autopilot.enabled || TIME_RATE[settings.time] > 0)) { hour = (hour + gdt * (autopilot.enabled ? autoHoursPerSecond(settings.ats as TimeSpeed) : TIME_RATE[settings.time])) % 24; const dh = Math.abs(hour - envHour); if (Math.min(dh, 24 - dh) >= 0.01) applyEnv(); } // 0.01時間(36秒/高速で4.5秒)ごとに空の色などを更新
  if (autopilot.enabled && gdt > 0) { // オート中の天気: ゆっくり連続的に変化(0.02以上動いたときだけ反映)
    const lv = drift.update(gdt);
    if (Math.abs(lv - wxLevel) >= 0.02 || (lv === drift.target && lv !== wxLevel)) { wxLevel = lv; applyWeatherOnly(); }
  }
  if (autopilot.enabled && running && uiHider.update(dt, settings.ahide === "1") !== document.body.classList.contains("ui-hidden")) { document.body.classList.toggle("ui-hidden", uiHider.hidden); dirty = true; }
  if (!running && document.body.classList.contains("ui-hidden")) { uiHider.touch(); document.body.classList.remove("ui-hidden"); }
  if (running && quality.update(dt)) applyQuality();
  if (!running && !dirty) { updateHud(dt, now); return; } // 一時停止中で見た目が変わっていなければ、物理・NPC・描画をすべて省く
  rain.update(running ? dt : 0, camera.position, flight.windVec);
  bp.lerpVectors(flight.prevPos, flight.pos, game.alpha || 1);
  if (!running && game.state === "paused") bp.copy(flight.pos);
  const gh = world.heightAt(bp.x, bp.z);
  const vdt = running ? dt : 0;
  bird.update(vdt, flight, bp, gh, forage.head);
  // 速度演出: 高速時のみ。強度は急に変えず滑らかに追従
  const fxTarget = flight.mode === "air" ? speedIntensity(flight.speed) * fxLevel : 0;
  fxSmooth += (fxTarget - fxSmooth) * (1 - Math.exp(-6 * vdt));
  const fxc = Math.min(1, fxSmooth);
  world.updateLOD(bp.x, bp.z);
  const tn = performance.now(); if (running) npc.update(dt, npcPlayer(), hour); npcView.update(npc, camera.position); stats.npcMs += (performance.now() - tn - stats.npcMs) * 0.05;
  if (autopilot.enabled && cam.mode === "third") { // オートのカット(危険な場面では自動で追従へ戻る)
    const sh = director.update(vdt, flight); cam.setShot(sh.yaw, sh.dist, sh.h); bird.setVisible(cam.shotDist >= FIRST_PERSON_BELOW);
  }
  cam.update(vdt, flight, bp, fxc);
  { // 着地候補の目印: 手動・空中・近くに候補があるときだけ
    const tg = perchAssist.target, show = !!tg && !autopilot.enabled && flight.mode === "air" && !flight.hopping && perchAssist.aimD < PERCH.showRange && flight.stun <= 0;
    if (show !== perchMarker.visible) { perchMarker.visible = show; dirty = true; }
    if (show) { const k = 1 + 0.12 * Math.sin(now * 0.006); perchMarker.position.set(perchAssist.aimX, tg!.top + 0.05, perchAssist.aimZ); perchMarker.scale.setScalar(k * Math.min(1.6, Math.max(0.8, Math.min(tg!.maxX - tg!.minX, tg!.maxZ - tg!.minZ) + 0.6))); }
  }
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
(window as unknown as Record<string, unknown>).__game = { game, flight, world, input, cam, camera, renderer, scene, frame, env: () => envAt(hour), stats, npc, lines, streaks, speedIntensity, setHour: (h: number) => { hour = h; targetHour = null; applyEnv(); }, settings, applySettings, assist, prefs, autopilot, setAuto, season, applySeasonLook, saveSeason, forage, perchAssist, perchMarker, hour: () => hour, director, drift, uiHider, wxLevel: () => wxLevel, wind, rain, quality };
