import { Puddles, buildPuddles, PUDDLE } from "./puddles";
import { PuddleView } from "./puddleView";
import { Life } from "./life";
import { LandSpots, spotLabel, SPOTS, type SpotFrame } from "./landspots";
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
import { SteerLayer, STEER_MODES, STEER_NAMES, STEER_SHORT, type SteerMode } from "./steer";
import { FlapAssist } from "./assist";
import { PHYS } from "./params";
import { Autopilot } from "./autopilot";
import { buildSurfaces, type Surface } from "./perches";
import { Forage } from "./forage";
import { SeasonClock, seasonBias, seasonLook, type SeasonSpeed } from "./season";
import { PerchAssist, PERCH } from "./perchassist";
import { AutoLand, AUTOLAND } from "./autoland";
import { Approach } from "./approach";
import { SpotConfirm } from "./spotconfirm";
import { CruiseGuard } from "./avoid";
import { CruiseGovernor } from "./cruise";
import { SetupUi } from "./setupui";
import { guideValues } from "./guide";
import { GuideView } from "./guideui";
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
const settings = { weather: "clear" as Weather, wind: 1, bearing: 270, time: 0, fx: 2, npc: 2, gfx: 0, ctl: prefs.control as string, apol: prefs.autoPolicy as string, ats: prefs.autoTimeSpeed as string, ahide: prefs.autoHideUi ? "1" : "0", ss: prefs.seasonSpeed as string, steer: prefs.steer as string, guide: prefs.guide as string, lm: prefs.landmarks ? "1" : "0" };
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
// H9: 通常巡航の低速化(手動飛行のみ。オートは従来の物理・速さのまま)
const cruiseGov = new CruiseGovernor(); cruiseGov.reset(flight);
// 自動ついばみ(草地・土・あぜ道で、数歩ごとに止まって頭を下げる)。手動もオートも同じ仕組みで、強い入力(羽ばたき・大きなスティック)があれば中断する
const forage = new Forage(world.groundAt, (Date.now() & 0xffff) + 11);
// H8-B: 着地点マーカー。視界の中の着地できる足場を、すべて個別に示す(landspots.ts)。タップした候補に対して自動着地を始める(安全かどうかは、押した時にあらためて検査する)
const approach = new Approach(), spotConfirm = new SpotConfirm(), spots = new LandSpots(surfaces), spotCv = document.getElementById("spots") as HTMLCanvasElement, spotCtx = spotCv.getContext("2d")!;
const spotProj = new THREE.Vector3(); let uiRects: { x0: number; y0: number; x1: number; y1: number }[] = [], uiRectsT = 0;
const refreshUiRects = () => { uiRects = []; document.querySelectorAll<HTMLElement>("button,.btn,.panel,#top").forEach(e => { if (e.offsetParent === null && getComputedStyle(e).position !== "fixed") return; const r = e.getBoundingClientRect(); if (r.width > 4 && r.height > 4 && getComputedStyle(e).display !== "none") uiRects.push({ x0: r.left - 4, y0: r.top - 4, x1: r.right + 4, y1: r.bottom + 4 }); }); };
function sizeSpotCanvas() { const dpr = Math.min(2, devicePixelRatio || 1); spotCv.width = Math.round(innerWidth * dpr); spotCv.height = Math.round(innerHeight * dpr); spotCv.style.width = innerWidth + "px"; spotCv.style.height = innerHeight + "px"; spotCtx.setTransform(dpr, 0, 0, dpr, 0, 0); }
sizeSpotCanvas(); addEventListener("resize", () => { sizeSpotCanvas(); uiRectsT = 0; });
const proxLand = new ProxLand(perchAssist, autoLand);
const guideView = new GuideView(); guideView.setMode(prefs.guide);
// H9: ◎の位置(保存値)と安全領域(ノッチ・ジェスチャーバー)。安全領域は CSS の env() を、見えない要素の padding として読む
input.pads = prefs.pads;
const safeProbe = document.createElement("div"); safeProbe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"; document.body.appendChild(safeProbe);
function readInsets() { const cs = getComputedStyle(safeProbe); input.insets = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 }; }
readInsets(); addEventListener("resize", readInsets);
const autolandBar = document.getElementById("autoland")!;
/** 押した瞬間に狙われた候補の ID を決める(以後、押している間に目印が動いても入れ替わらない)。オート飛行中・自動着地中は選べない。
 *  H8-D: そのとき、別の候補と取り違え得る押し方か(LandSpots.assess)も、押した瞬間の画面で判定して覚える */
let pressRisk = { id: -1, risky: false };
input.spotAt = (x, y) => { if (autopilot.enabled || autoLand.active) return -1; const sp = spots.pick(x, y); spots.pressedId = sp ? sp.id : -1; pressRisk = { id: spots.pressedId, risky: sp ? spots.assess(x, y, sp).risky : false }; return spots.pressedId; };
input.onSpotEnd = () => { spots.pressedId = -1; };
const REFUSE_WHY: Record<string, string> = { "too far": "遠すぎます", "too high": "高すぎます", "dangerous path": "途中に建物があります", "unreachable (below)": "足場より低い位置です" }; // 開始を断った理由を短く知らせる
/** 目印の足場への自動着地(18 m 以内)または接近先の選択(18 m 超)。1 タップで始める場合と、確認ボタンを押した場合の、共通の実行部分。開始の可否は AutoLand が毎回検査する。 */
function activateSpot(id: number) {
  const sp = spots.get(id), s = sp ? sp.s : surfaces.all[id]; tapNote(id, "activateSpot d=" + (sp ? sp.d.toFixed(1) : "none") + " active=" + autoLand.active); if (!s) { autoLand.stats.refused++; autoLand.lastRefusal = "no candidate"; return; }
  // H8-C: 自動着地の届く範囲(18 m)より遠い目印は、断らずに「接近先」に選ぶ(向きを合わせて近づき、届く範囲に入ったら既存の自動着地を安全検査つきで始める)。もう一度押すと取り消す
  if (sp && sp.d > AUTOLAND.maxRange && !autoLand.active) { if (approach.id === id) { approach.clear("cancelled"); toast("接近をやめました"); } else { approach.select(id, flight.clock); toast("接近して着地します"); } return; }
  if (autoLand.start(flight, s)) { spots.targetId = s.id; toast("自動着地"); return; }
  toast("ここへは安全に降りられません" + (REFUSE_WHY[autoLand.lastRefusal] ? "(" + REFUSE_WHY[autoLand.lastRefusal] + ")" : ""));
}
/** 直近のタップの処理記録(診断用。どの分岐で何が起きたか): 目印のタップが「何もしなかった」ように見えるときの切り分けに使う */
const spotTapLog: { t: number; id: number; step: string }[] = []; const tapNote = (id: number, step: string) => { spotTapLog.push({ t: +flight.clock.toFixed(2), id, step }); if (spotTapLog.length > 12) spotTapLog.shift(); };
input.onSpotTap = (id) => {
  tapNote(id, "tap");
  if (autopilot.enabled) { tapNote(id, "autopilot-ignored"); return; }
  // 押してから離すまでに候補が視界から去った(通り過ぎた・画面の外)なら、古い候補へは降りない。拒否として数え、理由を示す(タップの取りこぼしとは別)
  if (!spots.valid(id, flight.clock)) { tapNote(id, "invalid:" + (spots.goneWhy(id) ?? "other")); spots.stats.gone++; autoLand.stats.refused++; autoLand.lastRefusal = "candidate gone"; spotConfirm.clear("gone:" + (spots.goneWhy(id) ?? "other")); toast("その場所は通り過ぎました"); return; }
  // H8-D: 他の候補と取り違え得る押し方(密集・交差・動く小さな目印)のときだけ、仮選択にして確認を求める。孤立した目印はこれまでどおり 1 タップで始める。仮選択した候補をもう一度押したときは確認とみなす
  const again = spotConfirm.id === id;
  if (pressRisk.id === id && pressRisk.risky && !again) { tapNote(id, "ask"); spotConfirm.ask(id, performance.now()); return; }
  tapNote(id, again ? "again->activate" : "activate(risk=" + (pressRisk.id === id ? pressRisk.risky : "other-press:" + pressRisk.id) + ")");
  if (spotConfirm.active) spotConfirm.clear(again ? "confirmed" : "cancelled");
  activateSpot(id);
};
/** 確認ボタン「ここへ接近」: 確認する瞬間に、候補の ID・可視性・状態をあらためて確かめてから実行する(安全検査は AutoLand / Approach がこれまでどおり行う) */
function confirmSpot() {
  if (!spotConfirm.active) return; const id = spotConfirm.id, sp = spots.get(id);
  if (autopilot.enabled || autoLand.active || flight.mode !== "air" || !spots.enabled) { spotConfirm.clear("mode"); return; }
  if (!sp || !spots.valid(id, flight.clock)) { spotConfirm.clear("gone:" + (spots.goneWhy(id) ?? "other")); spots.stats.gone++; toast("その場所は見えなくなりました"); return; }
  spotConfirm.clear("confirmed"); activateSpot(id);
}
const askBox = document.getElementById("spotAsk")!, askGo = document.getElementById("spotGo")!, askSub = document.getElementById("spotGoSub")!, askNo = document.getElementById("spotNo")!;
for (const [el, fn] of [[askGo, confirmSpot], [askNo, () => spotConfirm.clear("cancelled")]] as const) el.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); fn(); });
let askPlacedT = 0, askKey = "";
/** 確認ボタンの置き場所: 単一◎では◎の真上(同じ側の親指が届く)。それ以外の片手では、使っていない側の中央寄り(◎・巡航/近接パッドと重ならない)。両手では画面の下の中央 */
function placeAsk() {
  const w = innerWidth, h = innerHeight, bw = 122 + 6 + 54; let left: number, top: number;
  if (input.steerOn) { const r = input.steerRect(); left = r.cx - bw / 2; top = r.cy - r.r - 8 - 54; }
  else if (input.mode !== "both") { const L = input.layout()!; left = input.mode === "right" ? L.zoneLeft - bw - 6 : L.zoneRight + 6; top = h - 54 - 14; }
  else { left = (w - bw) / 2; top = h - 54 - 14; }
  left = Math.min(w - bw - 4, Math.max(4, left)); top = Math.min(h - 54 - 4, Math.max(64, top));
  askBox.style.left = left + "px"; askBox.style.top = top + "px";
}
// H9: 着地点マーカーの色。緑=いま押せば自動着地が始まる(AutoLand.canStart が通る)。青=それ以外(遠ければ押すと接近先に選ばれる。届く範囲でも安全でなければ薄く示し、押すと理由を知らせる)
const spotSafe = new Map<number, { ok: boolean; why: string; t: number }>(); const SAFE_REFRESH_S = 0.1;
function spotLanding(sp: { id: number; d: number; s: Surface }): { ok: boolean; why: string } {
  if (sp.d > AUTOLAND.maxRange) return { ok: false, why: "too far" };
  const c = spotSafe.get(sp.id); if (c && flight.clock - c.t < SAFE_REFRESH_S && flight.clock >= c.t) return c;
  const r = autoLand.canStart(flight, sp.s), e = { ok: r.ok, why: r.why, t: flight.clock }; spotSafe.set(sp.id, e); return e;
}
let spotsDrawn = false, apWhy = "";
/** 着地点マーカーの描画(2D キャンバス)。目印は半透明の輪。重なったものは名前を添え、ずらした目印は本来の位置と細い線で結ぶ。自動着地中は目的地だけ緑 */
function drawSpots(now: number) {
  const c = spotCtx, td = performance.now(); const list = spots.enabled ? spots.list : [], tgt = spots.enabled && autoLand.active ? autoLand.target : null;
  if (!list.length && !tgt) { if (spotsDrawn) { c.clearRect(0, 0, innerWidth, innerHeight); spotsDrawn = false; } return; }
  c.clearRect(0, 0, innerWidth, innerHeight); spotsDrawn = true;
  const ring = (x: number, y: number, r: number, col: string, a: number, w = 3) => { c.globalAlpha = a; c.lineWidth = w + 2.5; c.strokeStyle = "rgba(0,0,0,.55)"; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.stroke(); c.lineWidth = w; c.strokeStyle = col; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.stroke(); };
  const pulse = 1 + 0.06 * Math.sin(now * 0.006);
  for (const sp of list) {
    const green = spotLanding(sp).ok, a = sp.alpha * (green ? 0.95 : sp.d > AUTOLAND.maxRange ? 0.8 : 0.45), pressed = sp.id === spots.pressedId;
    if (Math.hypot(sp.dx - sp.x, sp.dy - sp.y) > 6) { c.globalAlpha = a * 0.7; c.strokeStyle = "rgba(255,241,176,.8)"; c.lineWidth = 1.5; c.beginPath(); c.moveTo(sp.x, sp.y); c.lineTo(sp.dx, sp.dy); c.stroke(); c.fillStyle = "rgba(255,241,176,.9)"; c.beginPath(); c.arc(sp.x, sp.y, 2.5, 0, 6.2832); c.fill(); }
    const asked = sp.id === spotConfirm.id; if (asked) { const r2 = askBox.getBoundingClientRect(); c.globalAlpha = 0.85; c.strokeStyle = "#ffb347"; c.lineWidth = 2; c.setLineDash([5, 4]); c.beginPath(); c.moveTo(sp.dx, sp.dy); c.lineTo(r2.left + r2.width / 2, r2.top + r2.height / 2); c.stroke(); c.setLineDash([]); ring(sp.dx, sp.dy, SPOTS.radiusPx * 1.7 * pulse, "#ffb347", 1, 4.5); c.globalAlpha = 1; c.font = "bold 12px sans-serif"; c.textAlign = "center"; const lb = spotLabel(sp.kind) + " " + Math.round(sp.d) + " m"; c.lineWidth = 3.5; c.strokeStyle = "rgba(0,0,0,.75)"; c.strokeText(lb, sp.dx, sp.dy - SPOTS.radiusPx * 1.7 - 8); c.fillStyle = "#ffd9a0"; c.fillText(lb, sp.dx, sp.dy - SPOTS.radiusPx * 1.7 - 8); }
    const pend = sp.id === approach.id; if (pend) ring(sp.dx, sp.dy, SPOTS.radiusPx * 1.45 * pulse, "#5ec8ff", 0.95, 3.5);
    const sc = sp.d > 35 ? 0.72 : sp.d > 18 ? 0.88 : 1; // 遠い目印は小さく(混み合いを減らす。近づくと大きくなる)
    const col = green ? "#46e08a" : "#6db7ff"; // 緑=いま着地を始められる / 青=それ以外。色だけに頼らず形も変える(緑: 実線の輪+中心が塗りつぶし、青: 破線の輪+中心が中空)
    if (!green) c.setLineDash([sc < 1 ? 5 : 7, 4]);
    ring(sp.dx, sp.dy, SPOTS.radiusPx * sc * (pressed ? 1.3 : pulse), pressed || pend ? "#d6f0ff" : col, pend ? 0.95 : a, sc < 1 ? 2.4 : 3);
    c.setLineDash([]);
    c.globalAlpha = a; c.fillStyle = col; c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); c.arc(sp.dx, sp.dy, 3.5, 0, 6.2832); if (green) c.fill(); else c.stroke();
    if (pend) { c.globalAlpha = 0.95; c.font = "bold 11px sans-serif"; c.textAlign = "center"; c.lineWidth = 3; c.strokeStyle = "rgba(0,0,0,.65)"; c.strokeText("接近中", sp.dx, sp.dy - SPOTS.radiusPx - 10); c.fillStyle = "#bfe9ff"; c.fillText("接近中", sp.dx, sp.dy - SPOTS.radiusPx - 10); }
    if (sp.stacked) { c.globalAlpha = a; c.font = "bold 11px sans-serif"; c.textAlign = "center"; const tx = spotLabel(sp.kind); c.lineWidth = 3; c.strokeStyle = "rgba(0,0,0,.65)"; c.strokeText(tx, sp.dx, sp.dy + SPOTS.radiusPx + 12); c.fillStyle = "#fff"; c.fillText(tx, sp.dx, sp.dy + SPOTS.radiusPx + 12); }
  }
  if (tgt) { spotProj.set((tgt.minX + tgt.maxX) / 2, tgt.top + 0.05, (tgt.minZ + tgt.maxZ) / 2).project(camera); if (spotProj.z < 1 && Math.abs(spotProj.x) < 1.05 && Math.abs(spotProj.y) < 1.05) ring((spotProj.x * 0.5 + 0.5) * innerWidth, (-spotProj.y * 0.5 + 0.5) * innerHeight, SPOTS.radiusPx * 1.1, "#9be8b0", 0.95); }
  c.globalAlpha = 1; stats.spotDrawMs += (performance.now() - td - stats.spotDrawMs) * 0.05;
}
const CTL_NAMES: Record<ControlMode, string> = { both: "両手", right: "右手", left: "左手" };
/** 片手操作の巡航◎・近接◎の位置と大きさを画面に合わせる(両手操作では非表示) */
function layoutPads() {
  const L = input.layout(); if (!L) return;
  if (input.steerOn) { const r = input.steerRect(), el = document.getElementById("padProx")!; el.style.left = r.cx - r.r + "px"; el.style.top = r.cy - r.r + "px"; el.style.width = el.style.height = r.r * 2 + "px"; dirty = true; return; }
  for (const [id, r] of [["padCruise", L.cruise], ["padProx", L.prox]] as const) { const el = document.getElementById(id)!; el.style.left = r.cx - r.r + "px"; el.style.top = r.cy - r.r + "px"; el.style.width = el.style.height = r.r * 2 + "px"; }
  dirty = true;
}
input.getYaw = () => flight.yaw;
input.getHeading = () => (flight.vel.length() > 2 ? Math.atan2(-flight.vel.x, -flight.vel.z) : flight.yaw); // 触れ始めの進行方向(近接◎の基準)
const steerLayer = new SteerLayer(), camDir0 = new THREE.Vector3(), camDir1 = new THREE.Vector3(); let camReady = false;
function applyControl() {
  const m = settings.ctl as ControlMode;
  input.setMode(m); assist.enabled = m !== "both"; assist.reset();
  { const on = settings.lm === "1"; spots.setEnabled(on); if (!on) { spotConfirm.clear("off"); approach.clear("cancelled"); } if (prefs.landmarks !== on) { prefs.landmarks = on; savePrefs(prefs); } } // H8-B: 着地点マーカーの表示/非表示(保存)。OFF にすると目印と選択を消す(進行中の自動着地は止めない)
  spotConfirm.clear("mode"); // 操作モード・操縦方式を変えたら仮選択は解く
  { const sm = settings.steer as SteerMode; input.setSteer(sm); steerLayer.reset(); document.body.dataset.steer = m !== "both" ? sm : "off"; // H8-A: 単一◎の操縦方式。両手操作では使わない(従来のスティック)
    document.getElementById("btnSteer")!.textContent = "操縦 " + STEER_SHORT[sm]; const tag = document.getElementById("steerTag")!; tag.textContent = m !== "both" && sm !== "off" ? "◎ " + STEER_NAMES[sm] : ""; if (prefs.steer !== sm) { prefs.steer = sm; savePrefs(prefs); } }
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
  if (prefs.guide !== settings.guide) { prefs.guide = settings.guide as typeof prefs.guide; savePrefs(prefs); }
  if (guideView.mode !== settings.guide) guideView.setMode(settings.guide as typeof prefs.guide);
  if (season.speed !== settings.ss) { season.setSpeed(settings.ss as SeasonSpeed); saveSeason(); updateSeasonButton(); }
  const wd = weatherAtLevel(wxLevel);
  wind.set(settings.bearing, Math.min(12, WIND_SPEED[settings.wind] * wd.windMul), WIND_GUST[settings.wind]);
  flight.liftScale = wd.liftScale; flight.dragScale = wd.dragScale;
  rain.setIntensity(wd.rain); fxLevel = FX_MUL[settings.fx]; npc.setLevel(settings.npc, npcPlayer()); quality.force(settings.gfx === 0 ? null : [0, 0, 2, 3][settings.gfx]); applyQuality(); applyEnv();
  document.querySelectorAll<HTMLElement>("[data-set]").forEach(b => b.classList.toggle("on", String(settings[b.dataset.set as keyof typeof settings]) === b.dataset.val));
  document.getElementById("rowBearing")!.hidden = settings.wind === 0;
}
document.querySelectorAll<HTMLElement>("[data-set]").forEach(b => b.addEventListener("click", () => {
  (settings as Record<string, unknown>)[b.dataset.set!] = b.dataset.set === "weather" || b.dataset.set === "ctl" || b.dataset.set === "apol" || b.dataset.set === "ats" || b.dataset.set === "ahide" || b.dataset.set === "ss" || b.dataset.set === "steer" || b.dataset.set === "guide" || b.dataset.set === "lm" ? b.dataset.val : Number(b.dataset.val); applySettings();
}));
applyEnv();
input.onTime = () => {
  preset = (preset + 1) % TIME_PRESETS.length; targetHour = TIME_PRESETS[preset].hour;
  document.getElementById("btnTime")!.textContent = TIME_PRESETS[preset].name;
};
input.onReset = () => { cruiseGov.reset(flight); forage.reset(); if (autopilot.enabled) setAuto(false); dirty = true; game.reset(); input.releaseAll(); cam.snap(); };
input.onCamera = () => {
  dirty = true;
  cam.mode = cam.mode === "third" ? "first" : "third"; bird.setVisible(cam.mode === "third");
  document.getElementById("btnCam")!.textContent = cam.mode === "third" ? "三人称" : "一人称";
};

// --- 開始 / 一時停止 ---
const autopilot = new Autopilot(world, (Date.now() & 0xffff) + 1); autopilot.setPolicy(prefs.autoPolicy);
autopilot.water = (x, z) => { const n = puddles.nearest(x, z); if (!n) return null; const dx = x - n.p.x, dz = z - n.p.z, h = Math.hypot(dx, dz) || 1, r = puddles.radius(n.p); return { x: n.p.x + dx / h * (r - 0.3), z: n.p.z + dz / h * (r - 0.3), d: n.d }; };
const director = new CameraDirector((Date.now() >>> 3) + 7), drift = new WeatherDrift(0, (Date.now() >>> 5) + 3), uiHider = new UiHider();
const TS_NAMES: Record<TimeSpeed, string> = { slow: "ゆったり", normal: "標準", fast: "高速" }, TS_ORDER: TimeSpeed[] = ["slow", "normal", "fast"];
document.getElementById("btnSteer")!.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); // H8-A: 操縦方式をその場で切り替える(従来→A→B→C)。両手操作のときは片手に切り替えるよう知らせる
  settings.steer = STEER_MODES[(STEER_MODES.indexOf(settings.steer as SteerMode) + 1) % STEER_MODES.length]; applySettings(); toast("操縦: " + STEER_NAMES[settings.steer as SteerMode] + (settings.ctl === "both" ? "(両手操作では使われません。右手/左手にしてください)" : "")); });
/** 開発用の固定開始: 方式を比べるとき、毎回同じ位置・向き・速さから始める */
function steerTestStart() { forage.reset(); game.reset(); input.releaseAll(); steerLayer.reset(); steerLayer.samples.length = 0; flight.yaw = 0; flight.vel.set(0, 0, -10); cam.snap(); toast("同じ開始位置へ"); }
document.getElementById("btnSteerStart")!.addEventListener("click", () => { steerTestStart(); });
document.getElementById("btnSeason")!.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); settings.ss = SEASON_ORDER[(SEASON_ORDER.indexOf(season.speed) + 1) % 3]; applySettings(); toast("季節の速さ: " + SEASON_SPEED_NAME[season.speed]); });
applySeasonLook(true);
const autoIn = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false };
const POL_NAMES: Record<AutoPolicy, string> = { life: "自然生活", scenic: "景色観賞", adventure: "冒険探索", random: "おまかせ" };
// オート中は手動入力を読まない(スティックやタップは無視)。解除しても飛行状態はそのまま続く
const readInput = () => {
  if (autopilot.enabled) { cruiseGov.update(flight, autoIn, 1 / 60, true); autoIn.flapTap = false; autoIn.flapHeld = false; autoIn.brake = false; autopilot.busy = forage.active; const ao = autopilot.drive(flight, autoIn, 1 / 60); if (autopilot.state === "cruise" && flight.mode === "air" && !flight.hopping && flight.stun <= 0) cruiseGuard.apply(world, flight, ao); /* H4: 巡航中だけ、手動と同じ衝突予測の減速・引き起こしを共有(着陸進入・離陸は自分の目標を優先) */ return forage.apply(ao, flight, false); }
  const raw = input.read();
  if (input.steerOn) steerLayer.apply(flight, raw, input.steer, 1 / 60, autoLand.active, performance.now()); // H8-A: 単一◎の指示を操舵の入力にする(物理・補助・回避はこの後も従来どおり)
  cruiseGov.update(flight, raw, 1 / 60, false, autoLand.active || flight.prox.on); // H9: 羽ばたきの操作で加速、離すと徐々に低速巡航へ
  if (spotConfirm.active && (Math.abs(raw.x) > 0.45 || Math.abs(raw.y) > 0.45)) spotConfirm.clear("manual"); // H8-D: 大きなスティック/◎の操作で仮選択を解く
  if (approach.active && !autoLand.active) { const sp = spots.get(approach.id); if (sp) approach.steer(flight, raw, sp.s, 1 / 60); } // H8-C: 接近先へ向きを合わせる(手動の操作があれば足さない)
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
const overlay = document.getElementById("overlay")!, ovGo = document.getElementById("ovGo")!, ovReset = document.getElementById("ovReset")!;
// H9: 起動時は ①環境設定 → ②操作UI設定 → ③開始(設定に戻る/オート/自分で操作)。③で押すまで始まらない。一時停止中は 再開/リセット と、設定の出し入れ
const setupUi = new SetupUi({ input, prefs, save: () => savePrefs(prefs), getCtl: () => settings.ctl as ControlMode, getSteer: () => settings.steer as string, relayout: () => layoutPads() });
function showOverlay() {
  const ready = game.state === "ready";
  overlay.hidden = game.state === "running";
  ovGo.textContent = ready ? "自分で操作" : "再開"; document.getElementById("ovAuto")!.textContent = ready ? "オート" : "オートで飛ぶ";
  if (!overlay.hidden) setupUi.sync(ready);
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
const stats = { spotMs: 0, spotDrawMs: 0, npcMs: 0, fxMs: 0, updateMs: 0, renderMs: 0, lines: 0 };
const STALL_MS = 100;
let lastGT = 0, last = performance.now(), fpsT = 0, fpsN = 0, fps = 0, hudT = 0;
const bp = new THREE.Vector3();
function frame(now: number) {
  input.noteFrame(now);
  if (now - last > STALL_MS) { input.stalls.push({ s: last, e: now }); if (input.stalls.length > 8) input.stalls.shift(); } // 画面が固まった(長いフレーム)区間を覚えておく。そのあいだに入ったタップは、押してから離すまでの時間が実際より長く測られるため
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
  { camDir1.copy(camDir0); camera.getWorldDirection(camDir0); if (vdt > 0 && camReady) steerLayer.camSample(camDir1.angleTo(camDir0) / vdt); camReady = true; } // 開発用: カメラの向きの角速度(rad/s)
  { const d = document.getElementById("padDot")!, v = input.proxVisual, on = v.on && input.mode !== "both" && !autopilot.enabled; if (on) { d.style.display = "block"; d.style.left = v.x + "px"; d.style.top = v.y + "px"; } else if (d.style.display !== "none") d.style.display = "none"; } // 近接◎の指の位置(目印)
  { // 着地点マーカー(H8-B): 視界の中の着地できる足場をすべて示す。空中の手動操作のときだけ。自動着地中は目的地だけを緑で残す
    const t0 = performance.now();
    if (now - uiRectsT > 500) { refreshUiRects(); uiRectsT = now; }
    const air = flight.mode === "air" && !flight.hopping && flight.stun <= 0 && !autopilot.enabled;
    const hs = Math.hypot(flight.vel.x, flight.vel.z), fx = hs > 2 ? flight.vel.x / hs : -Math.sin(flight.yaw), fz = hs > 2 ? flight.vel.z / hs : -Math.cos(flight.yaw);
    const F: SpotFrame = { bx: flight.pos.x, by: flight.pos.y, bz: flight.pos.z, fx, fz, feetY: flight.pos.y - PHYS.feetOffset, cx: camera.position.x, cy: camera.position.y, cz: camera.position.z, w: innerWidth, h: innerHeight, t: flight.clock, speed: hs, ui: uiRects, heightAt: world.heightAt,
      project: (x, y, z, out) => { spotProj.set(x, y, z).project(camera); out.x = spotProj.x; out.y = spotProj.y; out.z = spotProj.z; } };
    if (autoLand.active) { spots.update(F, false); if (!autoLand.target) spots.targetId = -1; } else { spots.targetId = -1; spots.update(F, air); }
    { // H8-C: 接近先の更新(目印が去ったら解除。届く範囲に入ったら安全検査をして自動着地を始める)
      if (approach.id >= 0 && (!air || autoLand.active || !spots.enabled)) approach.clear("cancelled");
      if (approach.id >= 0) { const ap = spots.get(approach.id); const r = approach.update(flight.clock, ap ? { s: ap.s, d: ap.d, near: ap.near, ready: approach.ready(flight, ap.s) } : null, spots.goneWhy(approach.id), sf => { const c = autoLand.check(flight, sf); apWhy = c.why; if (!c.ok) return false; if (autoLand.start(flight, sf)) { spots.targetId = sf.id; toast("自動着地"); return true; } return false; }, () => apWhy);
        if (r === "cleared" && approach.lastReason.startsWith("refused")) { autoLand.stats.refused++; autoLand.lastRefusal = approach.lastReason.slice(8); toast("ここへは安全に降りられません" + (REFUSE_WHY[autoLand.lastRefusal] ? "(" + REFUSE_WHY[autoLand.lastRefusal] + ")" : "")); }
        else if (r === "cleared" && approach.lastReason.startsWith("gone")) toast("接近先が見えなくなりました"); }
    }
    { // H8-D: 仮選択(確認待ち)の更新。候補が去った・期限切れ・OFF・オート・自動着地・空中でなくなったら解く。確認ボタンの表示と置き場所
      const q = spotConfirm.active ? spots.get(spotConfirm.id) : null;
      if (spotConfirm.active) { if (!air || autoLand.active || !spots.enabled) spotConfirm.clear(!spots.enabled ? "off" : "mode"); else spotConfirm.update(performance.now(), !!q, spots.goneWhy(spotConfirm.id)); }
      const show = spotConfirm.active && !!q; if (askBox.hidden === show) askBox.hidden = !show;
      if (show && q) { const sub = spotLabel(q.kind) + " " + Math.round(q.d) + " m" + (q.d > AUTOLAND.maxRange ? "(接近)" : ""); if (askSub.textContent !== sub) askSub.textContent = sub; const key = innerWidth + "x" + innerHeight + input.mode + input.steerMode; if (key !== askKey || now - askPlacedT > 400) { placeAsk(); askKey = key; askPlacedT = now; } }
    }
    guideView.update(dt, () => guideValues(flight, wind));
    drawSpots(now);
    stats.spotMs += (performance.now() - t0 - stats.spotMs) * 0.05;
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
(window as unknown as Record<string, unknown>).__ui = setupUi; (window as unknown as Record<string, unknown>).__guide = guideView;
(window as unknown as Record<string, unknown>).__game = { spotTapLog, cruiseGov, spotLanding, spotConfirm, approach, spots, steerLayer, steerTestStart, game, flight, world, input, cam, camera, renderer, scene, frame, env: () => envAt(hour), stats, npc, lines, streaks, speedIntensity, setHour: (h: number) => { hour = h; targetHour = null; applyEnv(); }, settings, applySettings, assist, prefs, autopilot, setAuto, season, applySeasonLook, saveSeason, forage, perchAssist, autoLand, proxLand, puddles, puddleView, life, surfaces, cruiseGuard, npcView, npcUpdate: () => npcView.update(npc, camera.position, 220, world.lightsLevel()), hour: () => hour, director, drift, uiHider, wxLevel: () => wxLevel, wind, rain, quality };
