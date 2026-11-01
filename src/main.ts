import { Puddles, buildPuddles, PUDDLE } from "./puddles";
import { PuddleView } from "./puddleView";
import { Life } from "./life";
import { RingDiag, ringVisible, edgePosition } from "./ringdiag";
import { ProxLand } from "./proxland";
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
import { PHYS } from "./params";
import { Autopilot } from "./autopilot";
import { buildSurfaces, type Surface } from "./perches";
import { Forage } from "./forage";
import { SeasonClock, seasonBias, seasonLook, type SeasonSpeed } from "./season";
import { PerchAssist, PERCH } from "./perchassist";
import { AutoLand } from "./autoland";
import { CruiseGuard } from "./avoid";
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
const puddles = new Puddles(buildPuddles(world)), puddleView = new PuddleView(puddles, world.heightAt); scene.add(puddleView.group);
const life = new Life();
let splashT = 0;
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
const surfaces = buildSurfaces(world);
const perchAssist = new PerchAssist(surfaces);
// G1-5: ◯をタップしたときの自動着地(手動飛行の一部。オート周遊とは別)
const autoLand = new AutoLand(surfaces, perchAssist, world.heightAt);
// H1: 巡航中の自動制動(壁・地面へ止まり切れない速さで向かっているとき、ブレーキ・機首上げ・羽ばたき・舵を足す。回避が間に合わない条件の衝突は残る)
const cruiseGuard = new CruiseGuard();
// 自動ついばみ(草地・土・あぜ道で、数歩ごとに止まって頭を下げる)。手動もオートも同じ仕組みで、強い入力(羽ばたき・大きなスティック)があれば中断する
const forage = new Forage(world.groundAt, (Date.now() & 0xffff) + 11);
// 着地できそうな場所を示す、控えめな半透明の目印(最も狙っている候補だけ)
const perchMarker = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0.4, depthWrite: false, fog: false }));
perchMarker.visible = false; perchMarker.renderOrder = 2; scene.add(perchMarker);
const markerPt = { x: 0, z: 0, top: 0, d: 0, on(pa: PerchAssist, f: Flight) { return pa.markerPoint(f, markerPt); } }; const markerV = new THREE.Vector3();
/** ◯の画面上の位置(CSS px)。タップの当たり判定に使う: 見た目より広く(指で押しやすい約48dp相当の半径) */
/** 縁の◯の置き場所が、ボタンなどのUIの上になるときは、横(次に上)へずらして空いている所へ置く。UIの上では◯を押しても、ボタンのほうが反応してしまう */
const isUiAt = (x: number, y: number) => { const el = document.elementFromPoint(x, y); return !!(el && el.closest && el.closest("button,.btn,#overlay")); };
function freeEdgeSpot(p: { x: number; y: number }) {
  if (!isUiAt(p.x, p.y)) return p;
  for (const d of [60, -60, 120, -120, 180, -180, 240, -240, 320, -320]) { const x = Math.min(innerWidth - 36, Math.max(36, p.x + d)); if (!isUiAt(x, p.y)) return { x, y: p.y }; }
  for (const dy of [-60, -120]) if (!isUiAt(p.x, p.y + dy)) return { x: p.x, y: p.y + dy };
  return p;
}
const RING_HIT = { base: 48, extra: 72, perSpeed: 0.2 }; // ◯の当たり判定の半径(px): 止まっているとき48、動いているほど広げる(速さ px/秒 × 0.2、最大 +72)
const ring = { visible: false, x: 0, y: 0, hit: 48 }; let ringSpeed = 0, ringT = 0, edgeShown = false; const edgeP = { x: 0, y: 0 };
const ringDiag = new RingDiag(), RINGLOG = /[?&]ringlog\b/.test(location.search) || (() => { try { return localStorage.getItem("ringlog") === "1"; } catch { return false; } })(); let ringLogN = 0;
const proxLand = new ProxLand(perchAssist, autoLand);
const autolandBar = document.getElementById("autoland")!;
let tapMarker: Surface | null = null; // 押した瞬間の候補(押している間に候補が入れ替わる・期限切れになっても、押した足場を対象にする。開始の可否は start() があらためて検査する)
input.ringHit = (x, y) => { const hit = ring.visible && !autoLand.active && Math.hypot(x - ring.x, y - ring.y) <= ring.hit; if (hit) tapMarker = perchAssist.marker; return hit; };
input.onRingTap = () => {
  const m = tapMarker ?? perchAssist.marker; tapMarker = null; if (autopilot.enabled) return;
  if (!m) { autoLand.stats.refused++; autoLand.lastRefusal = "no candidate"; toast("着地できる場所が見つかりません"); return; } // 押したあとで候補が消えた: 無言にせず、拒否として数える
  if (autoLand.start(flight, m)) { toast("自動着地"); return; }
  const why: Record<string, string> = { "too far": "遠すぎます", "too high": "高すぎます", "dangerous path": "途中に建物があります", "unreachable (below)": "足場より低い位置です" }; // 開始を断った理由を短く知らせる
  toast("ここへは安全に降りられません" + (why[autoLand.lastRefusal] ? "(" + why[autoLand.lastRefusal] + ")" : ""));
};
const CTL_NAMES: Record<ControlMode, string> = { both: "両手", right: "右手", left: "左手" };
/** 片手操作の巡航◎・近接◎の位置と大きさを画面に合わせる(両手操作では非表示) */
function layoutPads() {
  const L = input.layout(); if (!L) return;
  for (const [id, r] of [["padCruise", L.cruise], ["padProx", L.prox]] as const) { const el = document.getElementById(id)!; el.style.left = r.cx - r.r + "px"; el.style.top = r.cy - r.r + "px"; el.style.width = el.style.height = r.r * 2 + "px"; }
  dirty = true;
}
input.getHeading = () => (flight.vel.length() > 2 ? Math.atan2(-flight.vel.x, -flight.vel.z) : flight.yaw); // 触れ始めの進行方向(近接◎の基準)
function applyControl() {
  const m = settings.ctl as ControlMode;
  input.setMode(m); assist.enabled = m !== "both"; assist.reset();
  document.body.dataset.ctl = m; document.getElementById("btnCtl")!.textContent = CTL_NAMES[m]; layoutPads();
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
  const raw = input.read();
  if (!autoLand.active && proxLand.update(flight, 1 / 60, !!raw.prox)) toast("自動着地");
  if (autoLand.active) raw.prox = undefined; // 自動着地中は近接機動の指示を使わない
  if (flight.mode === "air" && !flight.prox.on && !flight.hopping && flight.stun <= 0 && !autoLand.active) cruiseGuard.apply(world, flight, raw);
  autoLand.drive(flight, raw); // 自動着地中だけ、手動入力を進入の入力に置き換える(大きなスティック・羽ばたきがあれば手動へ戻る)
  return forage.apply(assist.apply(perchAssist.apply(raw, flight), flight, autoLand.active || (!!perchAssist.target && perchAssist.aimD < 5)), flight, true);
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
    autopilot.stop(); flight.turnKeep = PHYS.turnKeep; flight.wallRecovery = true; director.reset(); cam.setShot(0, 1, 0); if (cam.mode === "third") bird.setVisible(true);
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
addEventListener("resize", () => { resize(); layoutPads(); }); addEventListener("orientationchange", () => { resize(); layoutPads(); }); resize();

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
  { // H3: 水たまり・生活動作
    const wd2 = weatherAtLevel(wxLevel);
    puddles.update(vdt, wd2.rain, wd2.sun); puddleView.update(vdt, wd2.rain);
    const wn = puddles.nearest(flight.pos.x, flight.pos.z), st = input.state;
    const pose = life.update(vdt, { landed: flight.mode === "landed" && !autoLand.active && !flight.hopping, moving: flight.walkV > 0.05, input: !autopilot.enabled && (Math.abs(st.x) > 0.15 || Math.abs(st.y) > 0.15 || st.flapHeld || st.flapTap || st.brake), sitting: flight.sitting, water: !!wn && wn.d <= PUDDLE.drinkRange, onWaterEdge: !!wn && wn.d === 0 });
    if (life.act === "bathe" && vdt > 0) { splashT -= vdt; if (splashT <= 0) { splashT = 0.45; puddleView.splash(flight.pos.x, flight.pos.z); } }
    bird.update(vdt, flight, bp, gh, forage.head, pose);
  }
  // 速度演出: 高速時のみ。強度は急に変えず滑らかに追従
  const fxTarget = flight.mode === "air" ? speedIntensity(flight.speed) * fxLevel : 0;
  fxSmooth += (fxTarget - fxSmooth) * (1 - Math.exp(-6 * vdt));
  const fxc = Math.min(1, fxSmooth);
  world.updateLOD(bp.x, bp.z);
  const tn = performance.now(); if (running) npc.update(dt, npcPlayer(), hour); npcView.update(npc, camera.position, 220, world.lightsLevel()); stats.npcMs += (performance.now() - tn - stats.npcMs) * 0.05;
  if (autopilot.enabled && cam.mode === "third") { // オートのカット(危険な場面では自動で追従へ戻る)
    const sh = director.update(vdt, flight); cam.setShot(sh.yaw, sh.dist, sh.h); bird.setVisible(cam.shotDist >= FIRST_PERSON_BELOW);
  }
  cam.update(vdt, flight, bp, fxc);
  { const d = document.getElementById("padDot")!, v = input.proxVisual, on = v.on && input.mode !== "both" && !autopilot.enabled; if (on) { d.style.display = "block"; d.style.left = v.x + "px"; d.style.top = v.y + "px"; } else if (d.style.display !== "none") d.style.display = "none"; } // 近接◎の指の位置(目印)
  { // 着地候補の目印(◯): 手動・空中のときだけ。候補が一瞬見えなくなっても数秒は保つ(PerchAssist.marker)。◯をタップすると自動着地
    const mk = perchAssist.marker, hasPt = !!mk && markerPt.on(perchAssist, flight);
    if (hasPt) markerV.set(markerPt.x, markerPt.top + 0.05, markerPt.z).project(camera);
    const rv = ringVisible({ auto: autopilot.enabled, mode: flight.mode, hopping: flight.hopping, stun: flight.stun, hasMarker: hasPt, d: markerPt.d, maxD: PERCH.showRange * 1.6, sx: markerV.x, sy: markerV.y, sz: markerV.z, autoLand: autoLand.active });
    const show = rv.show, stale = !!mk && perchAssist.target !== mk && !autoLand.active; // 保持中だけで、いまの候補選別では選ばれていない(古い)目印は薄く表示。タップしても着地の開始は毎回あらためて検査する
    ringDiag.update(flight.clock, rv.reason, mk ? mk.kind : "", markerPt.d, perchAssist.markerAge(flight.clock), stale);
    if (RINGLOG && ringDiag.log.length !== ringLogN) { ringLogN = ringDiag.log.length; console.log("[ring]", JSON.stringify(ringDiag.log[ringDiag.log.length - 1]), JSON.stringify(perchAssist.pickWhy)); }
    const edge = rv.reason === "edge", edgeEl = document.getElementById("ringEdge")!;
    if (edge) { const ep = freeEdgeSpot(edgePosition(markerV.x, markerV.y, markerV.z, innerWidth, innerHeight)), kk = edgeShown ? 1 - Math.exp(-Math.min(0.1, dt) / 0.12) : 1; /* 縁の◯は、向きが急に変わっても飛び回らないよう滑らかに動かす */ edgeP.x += (ep.x - edgeP.x) * kk; edgeP.y += (ep.y - edgeP.y) * kk; edgeShown = true; edgeEl.style.display = "block"; edgeEl.style.left = edgeP.x + "px"; edgeEl.style.top = edgeP.y + "px"; edgeEl.style.opacity = stale ? "0.45" : "0.85"; } else { edgeShown = false; if (edgeEl.style.display !== "none") edgeEl.style.display = "none"; }
    if ((show && !edge) !== perchMarker.visible) { perchMarker.visible = show && !edge; dirty = true; }
    if (show) { // ◯の画面位置と動く速さ。動いている◯は、見てから指が届くまでの間(約0.1〜0.2秒)に動くので、当たり判定を速さに応じて広げる(止まっていれば半径48 px のまま)
      const ep2 = edge ? edgeP : null, nx = ep2 ? ep2.x : (markerV.x * 0.5 + 0.5) * innerWidth, ny = ep2 ? ep2.y : (-markerV.y * 0.5 + 0.5) * innerHeight, dtr = Math.max(1e-3, now / 1000 - ringT);
      if (ring.visible && ringT > 0 && dtr < 0.25) ringSpeed += (Math.hypot(nx - ring.x, ny - ring.y) / dtr - ringSpeed) * 0.3; else ringSpeed = 0;
      ring.x = nx; ring.y = ny; ringT = now / 1000; ring.hit = RING_HIT.base + Math.min(RING_HIT.extra, RING_HIT.perSpeed * ringSpeed);
    } else { ringSpeed = 0; ringT = 0; ring.hit = RING_HIT.base; }
    ring.visible = show;
    if (show) {
      const k = 1 + 0.12 * Math.sin(now * 0.006), sz = Math.min(1.6, Math.max(0.8, Math.min(mk!.maxX - mk!.minX, mk!.maxZ - mk!.minZ) + 0.6));
      perchMarker.position.set(markerPt.x, markerPt.top + 0.05, markerPt.z); perchMarker.scale.setScalar(k * sz);
      (perchMarker.material as THREE.MeshBasicMaterial).color.setHex(autoLand.active ? 0x9be8b0 : 0xfff1b0); // 自動着地中は緑
      (perchMarker.material as THREE.MeshBasicMaterial).opacity = stale ? 0.2 : 0.4;
    }
    const lbl = autoLand.active ? "自動着地中(操作でやめる)" : "", el = autolandBar; if (el.textContent !== lbl) { el.textContent = lbl; el.style.opacity = lbl ? "0.8" : "0"; }
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
    const st = flight.stun > 0 ? "衝突!" : flight.prox.on && flight.mode === "air" ? "近接機動" : flight.sitting ? "座っている" : flight.mode === "perch" ? "電線に止まり中" : flight.hopping ? "ジャンプ" : flight.walking ? "歩行中" : flight.mode === "landed" ? "着地中" : flight.mode === "rollout" ? "滑走中" :
      flight.stall ? "失速!" : flight.braking ? "減速" : flight.strokeT >= 0 ? "羽ばたき" : "滑空";
    hud.textContent = `${st}　速度 ${flight.speed.toFixed(0)} m/s　高度 ${Math.max(0, flight.agl).toFixed(0)} m　${flight.windVec.length() > 0.1 ? `　風 ${bearingName(wind.bearing)} ${flight.windVec.length().toFixed(0)}m/s${flight.windVec.y > 1 ? " 上昇気流!" : ""}` : ""}　${fps.toFixed(0)}fps Q${quality.level}`;
    msg.style.opacity = game.state === "running" && game.gameTime < 9 ? "1" : "0";
  }
}
renderer.setAnimationLoop(frame);
// テスト・デバッグ用
(window as unknown as Record<string, unknown>).__game = { game, flight, world, input, cam, camera, renderer, scene, frame, env: () => envAt(hour), stats, npc, lines, streaks, speedIntensity, setHour: (h: number) => { hour = h; targetHour = null; applyEnv(); }, settings, applySettings, assist, prefs, autopilot, setAuto, season, applySeasonLook, saveSeason, forage, perchAssist, perchMarker, autoLand, proxLand, ringDiag, puddles, puddleView, life, ring, surfaces, cruiseGuard, npcView, npcUpdate: () => npcView.update(npc, camera.position, 220, world.lightsLevel()), hour: () => hour, director, drift, uiHider, wxLevel: () => wxLevel, wind, rain, quality };
