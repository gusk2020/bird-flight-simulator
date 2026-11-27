/**
 * 地域マップ(試作)の入口。region.html から読まれる。標準のワールド(main.ts / world.ts)には触れず、同じ飛行物理(Flight)・操作(Input)・
 * 鳥(BirdModel)・カメラ(FollowCam)を、KFMの地域地形の上で使う。
 * 地面・水面の判定は TerrainField(regionTerrain.ts)、描画は同じ配列から作る(regionView.ts)。建物・電線・着地面は作らない。
 */
import * as THREE from "three";
import { Flight } from "./flight";
import { BirdModel } from "./birdModel";
import { Input } from "./input";
import { FollowCam } from "./camera";
import { Game } from "./game";
import { envAt, TIME_PRESETS } from "./env";
import {
  REGION_SCALES, DEFAULT_REGION_SCALE, buildTerrainField, parseRegionText, pickSpawn, nearestPlace,
  type KfmDecoded, type RegionScale, type TerrainField,
} from "./regionTerrain";
import { buildRegionView, type RegionView } from "./regionView";
import { setFlightLimits } from "./regionTerrain";

/** 画面に出す尺度の説明は、ここでも regionTerrain.ts の REGION_SCALES だけを見る */
const SAMPLE_URL = "https://raw.githubusercontent.com/gusk2020/kudo-fudo-miseisen/claude/s43-overhaul/docs/data/region-sample-kanto-1900.json";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- 現在の地域(未読込の間は、地面0 mの平らな水なし面。飛べない) ----
interface Loaded { region: KfmDecoded; field: TerrainField; view: RegionView; text: string; label: string }
let cur: Loaded | null = null;
let scale: RegionScale = DEFAULT_REGION_SCALE;
const worldQuery = { colliders: [] as never[], heightAt: (x: number, z: number) => (cur ? cur.field.heightAt(x, z) : 0), waterAt: (x: number, z: number) => (cur ? cur.field.waterAt(x, z) : false) };

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", logarithmicDepthBuffer: true });
document.body.prepend(renderer.domElement);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(66, 1, 0.3, 20000);
const hemi = new THREE.HemisphereLight(0xffffff, 0x667755, 1.5), sun = new THREE.DirectionalLight(0xffffff, 1.7);
scene.add(hemi, sun);
const skyGeo = new THREE.SphereGeometry(1, 16, 10);
skyGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(skyGeo.attributes.position.count * 3), 3));
const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
sky.renderOrder = -1; scene.add(sky);
scene.fog = new THREE.Fog(0xcfe6f5, 1000, 8000);

const flight = new Flight(worldQuery);
const bird = new BirdModel(); bird.attach(scene);
const input = new Input();
const cam = new FollowCam(camera, worldQuery);
const game = new Game(flight, () => input.read(), () => { input.state.flapTap = false; });

// ---- 空と光 ----
let hour: number = TIME_PRESETS[1].hour, preset = 1;
function applyEnv() {
  const e = envAt(hour), top = new THREE.Color(e.top), hor = new THREE.Color(e.hor), c = new THREE.Color();
  const pos = skyGeo.attributes.position, col = skyGeo.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) { const h = Math.max(0, pos.getY(i)); c.lerpColors(hor, top, Math.pow(h, 0.6)); col.setXYZ(i, c.r, c.g, c.b); }
  col.needsUpdate = true; (scene.fog as THREE.Fog).color.setHex(e.fog);
  hemi.color.setHex(e.hemiSky); hemi.groundColor.setHex(e.hemiGround); hemi.intensity = e.hemiI;
  sun.color.setHex(e.sun); sun.intensity = e.sunI; sun.position.set(...e.sunDir);
}
applyEnv();
input.onTime = () => { preset = (preset + 1) % TIME_PRESETS.length; hour = TIME_PRESETS[preset].hour; $("btnTime").textContent = TIME_PRESETS[preset].name; applyEnv(); };

// ---- 読み込み ----
const err = $("err"), info = $("info"), go = $<HTMLButtonElement>("ovGo");
const fmt = (n: number, d = 0) => n.toLocaleString("ja-JP", { maximumFractionDigits: d });
function line(label: string, text: string) { const d = document.createElement("div"), b = document.createElement("b"); b.textContent = label; d.append(b, " " + text); info.append(d); }
function showInfo(L: Loaded) {
  const r = L.region, f = r.file, g = f.grid, s = L.field.stats; info.replaceChildren(); info.hidden = false;
  line("出典", `${f.source.game} ${f.source.year}年 乱数の種${f.source.seed}　${f.source.note}`);
  line("座標", `${f.frame.kind}　原点 東経${fmt(f.frame.lon0, 3)}° 北緯${fmt(f.frame.lat0, 3)}°　1度=${fmt(f.frame.kmPerDegLon, 2)} / ${fmt(f.frame.kmPerDegLat, 2)} km　x=東・y=北、格子の行0=南`);
  line("高さ基準", f.frame.heightDatum);
  line("格子", `名目格子間隔 ${fmt(g.cellKm, 2)} km(スキーマの値)×${g.nx}×${g.ny}セル=約${fmt(g.nx * g.cellKm)}×${fmt(g.ny * g.cellKm)} km`);
  line("解像度の注意", "名目格子間隔は、地形の有効な解像度ではありません。この書き出しにはどのセルが実測由来か補間・生成かの区別がなく、有効な元データ解像度も書かれていません(KFMの資料では、元の標高データは約9.8 km間隔で、5 km格子はその補間、細部の一部はKFMの生成値)。この画面は格子点の間を三角形で直線に結ぶだけで、細部は足していません。細かい凹凸は実測ではありません。");
  line("尺度", `${L.field.tf.scale.label}(1 km→${fmt(L.field.tf.scale.metresPerKm)} m。標高も同じ倍率で強調なし)。${L.field.tf.scale.reason}`);
  line("標高", `陸の頂点 ${fmt(s.landVertices)}個の標高 ${fmt(s.minReal)}〜${fmt(s.maxReal)} m(縮める前)。海・湖の頂点 ${fmt(s.waterVertices)}個は水面0 m。陸で海面下の値だった頂点 ${fmt(s.clampedBelowSea)}個は0 mに切りました。`);
  const open = f.lines.filter(l => l.state === "open" && l.facility !== "ferry").length;
  line("収録", `場所${f.places.length}、道路・鉄道${f.lines.length}本(開通中${open}本を線で表示)。これはKFMのゲーム内の架空史で、その年の実在の道路ではありません。`);
  line("未収録", "建物・電線・着地面・障害物は元データに無いため、出ません。飛行・着地・衝突の対象は地面と水面だけです。色は標高による飾りです。");
  line("尺度の範囲", `範囲の外は地面0 m・データなし。範囲は約${fmt((L.field.bounds.maxX - L.field.bounds.minX) / 1000, 1)}×${fmt((L.field.bounds.maxZ - L.field.bounds.minZ) / 1000, 1)} km(この尺度)。`);
  line("利用条件(出典)", f.licence.join(" ／ "));
}
function loadText(text: string, label: string) {
  err.textContent = "";
  let region: KfmDecoded;
  try { region = parseRegionText(text); } catch (e) { err.textContent = `「${label}」を読み込めません: ${(e as Error).message}`; return; }
  install(region, text, label);
}
function install(region: KfmDecoded, text: string, label: string) {
  const field = buildTerrainField(region, scale), view = buildRegionView(region, field);
  if (cur) { scene.remove(cur.view.group); cur.view.dispose(); }
  cur = { region, field, view, text, label }; scene.add(view.group);
  // 見える範囲(far)・霧・空は、この尺度での範囲の大きさから決める
  const span = Math.hypot(field.bounds.maxX - field.bounds.minX, field.bounds.maxZ - field.bounds.minZ);
  camera.far = Math.max(4000, span * 3); camera.updateProjectionMatrix();
  const fog = scene.fog as THREE.Fog; fog.far = Math.max(3000, span * 1.2); fog.near = fog.far * 0.12;
  sky.scale.setScalar(camera.far * 0.9);
  setFlightLimits(flight, field);
  showInfo(cur); go.disabled = false; go.textContent = game.state === "ready" ? "飛ぶ" : "再開"; spawn();
  document.body.dataset.loaded = label;
}
function spawn() {
  if (!cur) return;
  const sp = pickSpawn(cur.region, cur.field); flight.reset();
  const gh = cur.field.heightAt(sp.x, sp.z);
  flight.pos.set(sp.x, gh + 30, sp.z); flight.prevPos.copy(flight.pos); flight.yaw = 0; flight.pitch = 0.05; flight.vel.set(0, 0, -12); // 北向き(-z)
  cam.snap();
}
$("btnSample").addEventListener("click", async () => {
  err.textContent = "";
  const emb = (window as unknown as { __REGION_SAMPLE__?: string }).__REGION_SAMPLE__;
  if (emb) { loadText(emb, "KFM公開サンプル(関東1900年)"); return; }
  try { const res = await fetch(SAMPLE_URL); if (!res.ok) throw new Error(`HTTP ${res.status}`); loadText(await res.text(), "KFM公開サンプル(関東1900年)"); }
  catch (e) { err.textContent = `サンプルを取得できません(${(e as Error).message})。「ファイルを選ぶ」から、KFMの docs/data/region-sample-kanto-1900.json などを選んでください。`; }
});
$<HTMLInputElement>("file").addEventListener("change", async e => {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  err.textContent = ""; let text = "";
  try { text = await f.text(); } catch (x) { err.textContent = `「${f.name}」を読めません(${(x as Error).message})`; return; }
  loadText(text, f.name); (e.target as HTMLInputElement).value = "";
});
function markScale() { document.querySelectorAll<HTMLButtonElement>("[data-scale]").forEach(b => b.classList.toggle("on", b.dataset.scale === scale.id)); }
document.querySelectorAll<HTMLButtonElement>("[data-scale]").forEach(b => b.addEventListener("click", () => {
  const s = REGION_SCALES.find(q => q.id === b.dataset.scale); if (!s || s === scale) return; scale = s; markScale();
  if (cur) { const c = cur; err.textContent = ""; install(c.region, c.text, c.label); }
}));
markScale();

// ---- ゲームの流れ ----
const overlay = $("overlay");
function showOverlay(v: boolean) { overlay.hidden = !v; }
go.addEventListener("click", () => { if (!cur) return; if (game.state === "ready") game.start(); else game.resume(); input.releaseAll(); showOverlay(false); });
input.onPause = () => { if (game.state === "running") { game.pause(); showOverlay(true); go.textContent = "再開"; } else if (cur && overlay.hidden === false && game.state === "paused") go.click(); };
$("btnPause").addEventListener("pointerdown", e => { e.preventDefault(); input.onPause(); });
input.onReset = () => { spawn(); };
input.onCamera = () => { cam.mode = cam.mode === "third" ? "first" : "third"; bird.setVisible(cam.mode === "third"); $("btnCam").textContent = cam.mode === "third" ? "三人称" : "一人称"; };
game.onPause = () => input.releaseAll();
document.addEventListener("visibilitychange", () => { if (document.hidden) { game.suspend(); if (game.state === "paused") { showOverlay(true); go.textContent = "再開"; } } });

function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener("resize", resize); addEventListener("orientationchange", resize); resize();

// ---- 毎フレーム ----
const bp = new THREE.Vector3(); let last = performance.now(), hudT = 0;
const hud = $("hud"), warn = $("warn");
function frame(now: number) {
  input.noteFrame(now);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
  const running = game.state === "running";
  game.update(dt);
  bp.lerpVectors(flight.prevPos, flight.pos, game.alpha || 1); if (!running) bp.copy(flight.pos);
  const gh = worldQuery.heightAt(bp.x, bp.z), vdt = running ? dt : 0;
  bird.update(vdt, flight, bp, gh);
  cam.update(vdt, flight, bp, 0);
  sky.position.copy(camera.position);
  renderer.render(scene, camera);
  hudT += dt;
  if (hudT > 0.15) {
    hudT = 0;
    if (cur) {
      const f = cur.field, inside = f.inside(flight.pos.x, flight.pos.z), real = f.tf.heightToReal(gh), np = nearestPlace(cur.region, f, flight.pos.x, flight.pos.z);
      const st = flight.mode === "air" ? (flight.stall ? "失速!" : flight.braking ? "減速" : flight.strokeT >= 0 ? "羽ばたき" : "滑空") : (inside && f.waterAt(flight.pos.x, flight.pos.z) ? "水面に着地" : "着地");
      hud.textContent = `${st}　速度 ${flight.speed.toFixed(0)} m/s　対地高度 ${Math.max(0, flight.agl).toFixed(0)} m\n地面標高 ${fmt(real)} m(縮める前) ${scale.id}　${np ? `最寄り ${np.name} ${(np.distM / f.tf.scale.metresPerKm).toFixed(1)} km(縮める前の距離)` : ""}`;
      hud.style.whiteSpace = "pre-line";
      warn.textContent = inside ? "" : "地域の外です(データなし・地面0 m)"; warn.style.opacity = inside ? "0" : "1";
    }
  }
}
renderer.setAnimationLoop(frame);
(window as unknown as Record<string, unknown>).__region = {
  flight, game, camera, renderer, scene, input, cam, worldQuery, frame,
  get loaded() { return cur; }, loadText, spawn, setScale: (id: string) => { const b = document.querySelector<HTMLButtonElement>(`[data-scale="${id}"]`); b?.click(); },
};
