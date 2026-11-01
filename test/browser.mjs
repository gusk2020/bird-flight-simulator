// ブラウザ動作テスト: ビルド済み(dist)を vite preview で配信し、Chromium(ソフトウェアGL)で操作する。失敗時は exit 1。
//
// 検査は6つのグループに分かれ、グループごとに新しいブラウザコンテキスト(保存データも空)から始める。
// グループ同士は状態を引き継がないので、順序に関係なく・別プロセス(CIのシャード)でも同じ結果になる。
//   node test/browser.mjs                 全グループを順に実行(ローカル)
//   node test/browser.mjs --shard 1/5     CI用: 5分割の1番目(各シャードの内訳は SHARD_PLAN)
//   node test/browser.mjs --only g1,g4    指定したグループだけ
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const args = process.argv.slice(2), arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const PORT = Number(arg("--port") || process.env.PORT || 4173);
let fails = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`); if (!ok) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 新しいコンテキスト(保存データ空)でページを開く。start=true なら開始ボタンまで押す(物理が動いている状態) */
async function open(b, start) {
  const ctx = await b.newContext({ viewport: { width: 892, height: 412 }, hasTouch: true, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(`http://localhost:${PORT}/`); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(1500);
  const cdp = await ctx.newCDPSession(p);
  if (start) { await p.click("#ovGo"); await sleep(800); }
  return { ctx, p, cdp, errs };
}


// ---- g1: 基本(開始・タッチ・一時停止・着地復帰)
async function g1({ p, cdp, errs }) {
  const S = () => p.evaluate(() => { const g = __game, f = g.flight; return { st: g.game.state, t: g.game.gameTime, steps: g.game.steps, x: f.pos.x, y: f.pos.y, z: f.pos.z, mode: f.mode, speed: f.speed, inx: g.input.state.x, iny: g.input.state.y, flap: g.input.state.flapHeld, brake: g.input.state.brake, ov: !document.getElementById("overlay").hidden }; });
  const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });

  console.log("\n# start screen");
  let s0 = await S(); await sleep(800); let s1 = await S();
  check("ready: overlay shown, physics frozen", s0.st === "ready" && s0.ov && s1.steps === 0 && dist(s0, s1) === 0);
  await p.click("#ovGo"); await sleep(800); let s2 = await S();
  check("start: overlay hidden, physics runs", s2.st === "running" && !s2.ov && s2.steps > 0 && dist(s1, s2) > 0.5);

  console.log("\n# touch input");
  await tp("touchStart", [{ x: 150, y: 300, id: 1 }, { x: 800, y: 350, id: 2 }]);
  await tp("touchMove", [{ x: 210, y: 300, id: 1 }, { x: 800, y: 350, id: 2 }]); await sleep(400);
  let s = await S(); check("multi-touch: stick + flap held", s.inx > 0.5 && s.flap);
  await tp("touchEnd", []); await sleep(150); s = await S(); check("release clears input", s.inx === 0 && !s.flap);
  await tp("touchStart", [{ x: 150, y: 300, id: 1 }]); await tp("touchMove", [{ x: -50, y: 300, id: 1 }]); await tp("touchCancel", []); await sleep(150);
  s = await S(); check("touchcancel clears stick", s.inx === 0 && s.iny === 0);

  console.log("\n# pause / resume (A3)");
  await tp("touchStart", [{ x: 150, y: 300, id: 1 }, { x: 800, y: 350, id: 2 }]); await tp("touchMove", [{ x: 210, y: 260, id: 1 }, { x: 800, y: 350, id: 2 }]); await sleep(200);
  await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await sleep(200); const pa = await S(); await sleep(1500); const pb = await S();
  check("pause: overlay shown, input cleared", pa.st === "paused" && pa.ov && pa.inx === 0 && pa.iny === 0 && !pa.flap && !pa.brake);
  check("pause: game time and physics frozen 1.5 s", pb.t === pa.t && pb.steps === pa.steps && dist(pa, pb) === 0);
  await tp("touchEnd", []);
  const tResume = Date.now(); await p.click("#ovGo"); await sleep(300); const ra = await S(); const wallS = (Date.now() - tResume) / 1000;
  // 瞬間移動の判定は壁時計ではなく「実際に進んだ物理ステップ数」と速度で行う:
  //  (1) 停止中の時間(約2秒)が加算されていない = 進んだゲーム時間 <= 再開後の実経過時間 (+1フレーム上限0.1秒)
  //  (2) 移動距離 <= そのステップ数での最大速度 x 時間 (速度は再開前後の大きい方 + 余裕3m/s)
  const stepsRun = ra.steps - pa.steps, gameS = stepsRun / 60, vmax = Math.max(pa.speed, ra.speed) + 3, moved = dist(pa, ra);
  check("resume: runs again, no paused time is replayed", ra.st === "running" && stepsRun > 0 && gameS <= wallS + 0.1, `steps=${stepsRun} (${gameS.toFixed(2)}s of game time) wall=${wallS.toFixed(2)}s`);
  check("resume: no teleport (distance consistent with steps x speed)", moved <= vmax * gameS + 0.25, `moved=${moved.toFixed(2)}m limit=${(vmax * gameS + 0.25).toFixed(2)}m v=${vmax.toFixed(1)}`);
  // 画面OFF / アプリ切替の模擬
  await p.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await sleep(100); const h1 = await S(); await sleep(1200); const h2 = await S();
  check("screen off: auto-paused and frozen", h1.st === "paused" && h2.steps === h1.steps && dist(h1, h2) === 0);
  await p.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  await sleep(1200); const h3 = await S(); check("returning does not auto-resume", h3.st === "paused" && h3.steps === h1.steps);
  await p.click("#ovGo"); await sleep(300);
  await p.evaluate(() => window.dispatchEvent(new Event("blur"))); await sleep(100); check("app switch (blur) pauses", (await S()).st === "paused");
  await p.click("#ovReset"); await sleep(400); s = await S();
  check("reset from pause: resumes at spawn", s.st === "running" && Math.abs(s.x - 28) < 3 && s.y > 8);
  await p.click("#btnPause", { force: true }).catch(() => {}); await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(100);
  check("pause button works again", (await S()).st === "paused"); await p.click("#ovGo"); await sleep(200);

  console.log("\n# landing / recovery");
  await p.evaluate(() => { const f = __game.flight; f.pos.set(28, 6, 60); f.prevPos.copy(f.pos); f.vel.set(0, 0, -9); });
  await p.waitForFunction(() => __game.flight.mode !== "air", null, { timeout: 40000 }).catch(() => {}); await sleep(300); s = await S(); check("lands and stops", s.mode === "landed" || s.mode === "rollout", s.mode);
  await tp("touchStart", [{ x: 800, y: 350, id: 2 }]); await p.waitForFunction(() => __game.flight.mode === "air" && __game.flight.pos.y > 2, null, { timeout: 20000 }).catch(() => {}); s = await S(); await tp("touchEnd", []);
  check("re-takeoff with flap", s.mode === "air" && s.y > 2, `y=${s.y.toFixed(1)}`);
  await p.evaluate(() => { const f = __game.flight; f.pos.set(0, 100, 0); f.vel.set(NaN, 0, 0); }); await sleep(600); s = await S();
  check("NaN injection recovers", Number.isFinite(s.x) && Number.isFinite(s.y) && s.y > 0);
  await p.evaluate(() => { __game.flight.pos.y = -50; }); await sleep(500); s = await S(); check("falling out of world recovers", s.y > -1);
  await p.click("#btnReset"); await sleep(300); s = await S(); check("reset button keeps working", s.y > 8 && s.mode === "air");
}


// ---- g2: 見た目(急降下カメラ・天気風時間・速度演出LOD)
async function g2({ p, cdp, errs }) {
  const S = () => p.evaluate(() => { const g = __game, f = g.flight; return { st: g.game.state, t: g.game.gameTime, steps: g.game.steps, x: f.pos.x, y: f.pos.y, z: f.pos.z, mode: f.mode, speed: f.speed, inx: g.input.state.x, iny: g.input.state.y, flap: g.input.state.flapHeld, brake: g.input.state.brake, ov: !document.getElementById("overlay").hidden }; });
  const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });

  console.log("\n# dive view stability (A1, in browser)");
  const dive = await p.evaluate(() => new Promise(res => {
    const g = __game, f = g.flight, cam = g.camera; f.pos.set(28, 150, 110); f.prevPos.copy(f.pos); f.vel.set(0, 0, -10); g.cam.snap(); g.input.state.y = -1;
    let n = 0, minD = 1e9, maxD = 0, maxNdc = 0; const v = cam.position.clone();
    const tick = () => { const bp = g.flight.pos; const d = cam.position.distanceTo(bp); minD = Math.min(minD, d); maxD = Math.max(maxD, d);
      v.copy(bp).project(cam); maxNdc = Math.max(maxNdc, Math.hypot(v.x, v.y)); if (++n < 60) requestAnimationFrame(tick); else { g.input.state.y = 0; res({ minD, maxD, maxNdc, y: bp.y, info: { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles } }); } };
    requestAnimationFrame(tick); }));
  check("dive: camera distance stable", dive.maxD - dive.minD < 3.4, `${dive.minD.toFixed(1)}..${dive.maxD.toFixed(1)}`);
  check("dive: bird stays on screen", dive.maxNdc < 0.5 && dive.y < 150, `ndc=${dive.maxNdc.toFixed(2)} y=${dive.y.toFixed(0)}`);
  console.log(`  info draw calls=${dive.info.calls} triangles=${dive.info.tris} (software GL; not device FPS)`);

  console.log("\n# weather / wind / time settings (B)");
  await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200);
  await p.click('[data-set="weather"][data-val="rain"]'); await p.click('[data-set="wind"][data-val="2"]'); await p.click('[data-set="bearing"][data-val="90"]');
  let B = await p.evaluate(() => ({ rain: __game.rain.mesh.visible, lift: __game.flight.liftScale, fog: __game.scene.fog.far, bear: __game.wind.bearing, sp: __game.wind.speed, on: [...document.querySelectorAll("[data-set].on")].length }));
  check("rain: particles on, lift reduced, visibility shortened", B.rain && B.lift < 1 && B.fog < 500, JSON.stringify(B));
  check("wind: strong east wind set, buttons highlighted", B.bear === 90 && B.sp > 7 && B.on === 12);
  await p.click('[data-set="time"][data-val="2"]'); await p.click("#ovGo"); await sleep(300);
  const h0 = await p.evaluate(() => __game.env().lights + "|" + __game.game.gameTime);
  await sleep(2500); const w1 = await p.evaluate(() => ({ wv: __game.flight.windVec.length(), rc: __game.rain.count, q: __game.quality.level, hud: document.getElementById("hud").textContent }));
  check("wind acts on the bird, rain draws, quality controller alive", w1.wv > 1 && w1.rc > 0 && w1.q >= 0, w1.hud);
  await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200);
  const e1 = await p.evaluate(() => JSON.stringify(__game.env())); await sleep(1500); const e2 = await p.evaluate(() => JSON.stringify(__game.env()));
  check("game clock does not advance while paused", e1 === e2);
  await p.click('[data-set="weather"][data-val="clear"]'); await p.click('[data-set="wind"][data-val="1"]'); await p.click('[data-set="bearing"][data-val="270"]'); await p.click('[data-set="time"][data-val="0"]');
  check("clear weather turns rain off", !(await p.evaluate(() => __game.rain.mesh.visible)));
  await p.click("#ovGo"); await sleep(200);

  console.log("\n# speed feel / LOD (C1)");
  const px = () => p.evaluate(() => { const c = document.getElementById("fx"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n; });
  await p.evaluate(() => { const g = __game; g.flight.reset(); g.input.state.y = 0; }); await sleep(800);
  await p.waitForFunction(() => document.getElementById("fx").getContext("2d").getImageData(0, 0, 4, 4) && true); for (let i = 0; i < 40 && (await px()) > 0; i++) await sleep(250);
  check("normal flight: no speed lines", (await px()) === 0 && (await p.evaluate(() => !__game.streaks.mesh.visible)));
  await p.evaluate(() => { const g = __game, f = g.flight; f.pos.set(28, 150, 110); f.prevPos.copy(f.pos); f.vel.set(0, -30, -10); g.input.state.y = -1; });
  await sleep(2500); const fxs = await p.evaluate(() => ({ sp: __game.flight.speed, vis: __game.streaks.mesh.visible, vig: getComputedStyle(document.getElementById("vig")).opacity, ms: __game.stats.fxMs, fov: __game.camera.fov }));
  const lit = await px();
  check("fast dive: speed lines, streaks and vignette appear", fxs.sp > 24 && fxs.vis && Number(fxs.vig) > 0.1 && lit > 50 && fxs.fov > 70, JSON.stringify({ ...fxs, lit }));
  check("effect CPU cost is small (<1.5 ms/frame)", fxs.ms < 1.5, `${fxs.ms.toFixed(3)}ms`);
  await p.evaluate(() => { __game.input.state.y = 0; });
  await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200);
  await p.click('[data-set="fx"][data-val="0"]'); await p.click("#ovGo"); await sleep(200);
  await p.evaluate(() => { const g = __game, f = g.flight; f.pos.set(28, 150, 110); f.prevPos.copy(f.pos); f.vel.set(0, -30, -10); g.input.state.y = -1; }); await sleep(2000);
  check("setting 'なし' disables the effects even in a dive", (await px()) === 0 && (await p.evaluate(() => !__game.streaks.mesh.visible)));
  await p.evaluate(() => { __game.input.state.y = 0; });
  await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200);
  await p.click('[data-set="fx"][data-val="2"]'); await p.click("#ovGo"); await sleep(200);
  const lod = await p.evaluate(() => { const w = __game.world; w.updateLOD(0, 0, true); const a = w.lodCounts(); w.updateLOD(190, 190, true); const b = w.lodCounts(); return { a, b, n: w.trees.length, tris: __game.renderer.info.render.triangles }; });
  check("tree LOD: near+far always equals the tree count, near set is a subset", lod.a.near + lod.a.far === lod.n && lod.b.near + lod.b.far === lod.n && lod.a.near < lod.n / 2, JSON.stringify(lod));
  check("triangle budget (LOD) under 80k", lod.tris < 80000, `tris=${lod.tris}`);
}


// ---- g3: 地上・電線・街の動き・一時停止中の描画
async function g3({ p, cdp, errs }) {
  const S = () => p.evaluate(() => { const g = __game, f = g.flight; return { st: g.game.state, t: g.game.gameTime, steps: g.game.steps, x: f.pos.x, y: f.pos.y, z: f.pos.z, mode: f.mode, speed: f.speed, inx: g.input.state.x, iny: g.input.state.y, flap: g.input.state.flapHeld, brake: g.input.state.brake, ov: !document.getElementById("overlay").hidden }; });
  const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  let s;

  console.log("\n# walking / hop / dawn lights (C2)");
  await p.evaluate(() => { const g = __game, f = g.flight; f.pos.set(28, 6, 60); f.prevPos.copy(f.pos); f.vel.set(0, 0, -9); });
  await p.waitForFunction(() => __game.flight.mode !== "air", null, { timeout: 40000 }).catch(() => {});
  await p.waitForFunction(() => __game.flight.mode === "landed", null, { timeout: 15000 }).catch(() => {}); await sleep(300);
  check("landed: brake button becomes 歩く", (await p.textContent("#brake")) === "歩く" && (await S()).mode === "landed");
  await p.evaluate(() => { const g = __game, f = g.flight; let best = f.yaw, bd = -1; for (let k = 0; k < 16; k++) { const y = k * Math.PI / 8; let d = 0; while (d < 6 && g.world.heightAt(f.pos.x - Math.sin(y) * (d + 1), f.pos.z - Math.cos(y) * (d + 1)) < 0.3) d++; if (d > bd) { bd = d; best = y; } } f.yaw = best; }); await sleep(100); // 目の前が開けた向きにしてから歩く
  const wA = await S(); await tp("touchStart", [{ x: 740, y: 350, id: 3 }]); await sleep(1100); const wB = await S(); const wk = await p.evaluate(() => ({ w: __game.flight.walkV, hud: document.getElementById("hud").textContent })); await tp("touchEnd", []);
  check("holding 歩く walks forward, stays on the ground", dist(wA, wB) > 1 && wB.mode === "landed" && wk.hud.includes("歩行中"), `pos=${wA.x.toFixed(1)},${wA.z.toFixed(1)}>${wB.x.toFixed(1)},${wB.z.toFixed(1)} moved=${dist(wA, wB).toFixed(2)} hud=${wk.hud}`);
  await sleep(600);
  await p.evaluate(() => { window.__peak = 0; const t = () => { const f = __game.flight; window.__peak = Math.max(window.__peak, f.pos.y - 0.32 - __game.world.heightAt(f.pos.x, f.pos.z)); requestAnimationFrame(t); }; t(); });
  await p.evaluate(() => { const el = document.getElementById("flap"); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 77 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 77 })); }); await sleep(2500); // 一瞬のタップ(ソフトウェア描画は低FPSなので同一タスクで押して離す)
  const hp = await p.evaluate(() => ({ peak: window.__peak, mode: __game.flight.mode }));
  check("short tap hops (does not take off)", hp.peak > 0.15 && hp.peak < 1.2 && hp.mode !== "air", JSON.stringify(hp));
  await tp("touchStart", [{ x: 800, y: 350, id: 2 }]); await p.waitForFunction(() => __game.flight.mode === "air" && __game.flight.pos.y > 2, null, { timeout: 20000 }).catch(() => {}); await tp("touchEnd", []);
  check("long press takes off", (await S()).mode === "air");
  check("in the air the button reads 減速", await p.waitForFunction(() => document.getElementById("brake").textContent === "減速", null, { timeout: 3000 }).then(() => true).catch(() => false));
  await p.evaluate(() => __game.setHour(6)); await sleep(200);
  check("dawn: building and street lights are off", (await p.evaluate(() => __game.world.lightsLevel())) === 0);
  await p.evaluate(() => __game.setHour(0)); await sleep(200);
  check("night: lights on", (await p.evaluate(() => __game.world.lightsLevel())) === 1);
  await p.evaluate(() => __game.setHour(12));

  console.log("\n# wire perching (C3)");
  await p.evaluate(() => { const g = __game, w = g.world, id = w.wires.findIndex(q => q.alongX && q.off === 0 && Math.abs(q.ax + 14) < 0.1 && Math.abs(q.az - 33.8) < 0.1), o = { x: 0, y: 0, z: 0 }; w.perchPoint(id, 0.4, o); const d = w.wireDir(id), f = g.flight;
    window.__wire = id; f.reset(); f.pos.set(o.x, o.y + 0.32 + 0.5, o.z); f.prevPos.copy(f.pos); f.vel.set(d[0] * 3, -1, d[1] * 3); f.yaw = Math.atan2(-d[0], -d[1]); g.input.state.brake = true; });
  await p.waitForFunction(() => __game.flight.mode === "perch", null, { timeout: 20000 }).catch(() => {});
  await p.evaluate(() => { __game.input.state.brake = false; }); await sleep(1500);
  let pc = await p.evaluate(() => ({ m: __game.flight.mode, hud: document.getElementById("hud").textContent, lab: document.getElementById("brake").textContent, y: __game.flight.pos.y }));
  check("brake near a wire at low speed: bird perches (HUD shows it)", pc.m === "perch" && pc.hud.includes("電線") && pc.lab === "歩く", JSON.stringify(pc));
  const q1 = await S(); await sleep(1500); const q2 = await S(); check("perched bird does not slide", dist(q1, q2) < 1e-6);
  await tp("touchStart", [{ x: 800, y: 350, id: 2 }]); await p.waitForFunction(() => __game.flight.mode === "air" && __game.flight.pos.y > 8.5, null, { timeout: 25000 }).catch(() => {}); await tp("touchEnd", []);
  check("long press takes off from the wire", (await S()).mode === "air");
  await p.evaluate(() => { const g = __game, f = g.flight, w = g.world, o = { x: 0, y: 0, z: 0 }; w.perchPoint(window.__wire, 0.4, o); f.reset(); f.pos.set(o.x, o.y + 0.32 + 0.5, o.z); f.prevPos.copy(f.pos); f.vel.set(0, -1, 0); f.mode = "air"; g.input.state.brake = true; });
  await p.waitForFunction(() => __game.flight.mode === "perch", null, { timeout: 20000 }).catch(() => {});
  await p.evaluate(() => { __game.input.state.brake = false; });
  await p.click("#btnReset"); await sleep(400); s = await S(); check("reset while perched recovers to normal flight", s.mode === "air" && s.y > 8);
  await p.evaluate(() => __game.setHour(12));

  console.log("\n# living town / graphics setting (C4)");
  const openMenu = async () => { await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200); };
  await p.evaluate(() => { __game.flight.reset(); __game.setHour(12); }); await sleep(2500);
  const nc = await p.evaluate(() => { const n = __game.npc, c = n.activeCounts(); return { c, vp: n.visiblePeds().length, vc: n.visibleCars().length, fin: n.birds.every(b => Number.isFinite(b.x + b.y + b.z)) && n.cars.every(q => Number.isFinite(q.x + q.z)) && n.peds.every(q => Number.isFinite(q.x + q.z)), ms: __game.stats.npcMs }; });
  check("NPCs active by default (標準): birds, pedestrians, cars", nc.c.birds === 8 && nc.vp > 10 && nc.vc > 4 && nc.fin, JSON.stringify(nc));
  check("NPC update+draw CPU cost is small (<2 ms/frame, browser)", nc.ms < 2, `${nc.ms.toFixed(3)} ms`);
  await openMenu(); await p.click('[data-set="npc"][data-val="0"]'); await p.click("#ovGo"); await sleep(600);
  const z = await p.evaluate(() => { const c = __game.npc.activeCounts(); return c.birds + c.peds + c.cars + __game.npc.visiblePeds().length + __game.npc.visibleCars().length; });
  check("街の動き=なし removes all NPCs", z === 0);
  await openMenu(); await p.click('[data-set="npc"][data-val="3"]'); await p.click('[data-set="gfx"][data-val="3"]'); await p.click("#ovGo"); await sleep(1500);
  const hi = await p.evaluate(() => ({ c: __game.npc.activeCounts(), pr: __game.renderer.getPixelRatio(), lvl: __game.quality.level }));
  check("街の動き=多 and 画質=低 are applied (auto quality stays out of the way)", hi.c.birds === 14 && hi.c.cars === 16 && hi.pr <= 0.8 + 1e-9 && hi.lvl === 3, JSON.stringify(hi));
  await openMenu(); await p.click('[data-set="npc"][data-val="2"]'); await p.click('[data-set="gfx"][data-val="0"]'); await p.click("#ovGo"); await sleep(300);

  console.log("\n# rendering is skipped while paused (audit)");
  const fr = () => p.evaluate(() => __game.renderer.info.render.frame);
  await p.evaluate(() => { __game.flight.reset(); }); await sleep(600);
  await openMenu(); await sleep(500); const f1 = await fr(); await sleep(1500); const f2 = await fr(); const sp1 = await S(); await sleep(300);
  check("paused with nothing changing: no frames are drawn and no physics runs", f2 === f1 && (await S()).steps === sp1.steps, `frames ${f1}->${f2}`);
  await p.click('[data-set="weather"][data-val="cloudy"]'); await sleep(500); const f3 = await fr();
  check("a setting change while paused is redrawn behind the menu", f3 > f2, `frames ${f2}->${f3}`);
  await sleep(1000); const f4 = await fr(); check("...and then drawing stops again", f4 === f3);
  await p.click('[data-set="weather"][data-val="clear"]'); await p.click("#ovGo"); await sleep(800); const f5 = await fr();
  check("resume draws every frame again", f5 > f4 + 2, `frames ${f4}->${f5}`);
}


// ---- g4: 片手操作(D1)と歩行(F1)
async function g4({ p, cdp, errs }) {
  const S = () => p.evaluate(() => { const g = __game, f = g.flight; return { st: g.game.state, t: g.game.gameTime, steps: g.game.steps, x: f.pos.x, y: f.pos.y, z: f.pos.z, mode: f.mode, speed: f.speed, inx: g.input.state.x, iny: g.input.state.y, flap: g.input.state.flapHeld, brake: g.input.state.brake, ov: !document.getElementById("overlay").hidden }; });
  const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });

  console.log("\n# one-hand controls (D1)");
  const G = () => p.evaluate(() => { const g = __game, i = g.input; return { ctl: document.body.dataset.ctl, x: i.state.x, y: i.state.y, brake: i.state.brake, tap: i.state.flapTap, ph: i.gesture.phase, strokes: g.flight.strokes, af: g.assist.autoFlaps, mode: g.flight.mode, hop: g.flight.hopping, flapDisp: getComputedStyle(document.getElementById("flap")).display, zone: (() => { const r = document.getElementById("stick").getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; })() }; });
  // 一瞬のタップは、ソフトウェアGLの遅い描画でCDPの2回の送信が数百msずれないよう、同一タスク内の合成イベントで行う(長押し・スライドは実タッチ)
  const tapAt = (x, y, id) => p.evaluate(([x, y, id]) => { const z = document.getElementById("stick"), o = { bubbles: true, pointerId: id, clientX: x, clientY: y, pointerType: "touch" }; z.dispatchEvent(new PointerEvent("pointerdown", o)); z.dispatchEvent(new PointerEvent("pointerup", o)); }, [x, y, id]);
  const fly = () => p.evaluate(() => { const g = __game; g.flight.reset(); g.flight.pos.set(28, 60, 150); g.flight.prevPos.copy(g.flight.pos); g.input.releaseAll(); });
  let d = await G(); check("default is two-hand: left stick zone, flap/brake buttons visible", d.ctl === "both" && d.zone.l === 0 && d.flapDisp !== "none", JSON.stringify(d.zone));
  await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200);
  d = await G(); check("top button switches to right-hand: right half is the stick area, flap/brake buttons hidden", d.ctl === "right" && d.zone.l >= 440 && d.zone.w >= 440 && d.zone.h >= 400 && d.flapDisp === "none", JSON.stringify(d));
  await fly(); await sleep(300);
  await tp("touchStart", [{ x: 650, y: 190, id: 5 }]); await tp("touchMove", [{ x: 720, y: 140, id: 5 }]); await sleep(250); d = await G();
  check("right-hand: sliding right/up gives stick x>0, y>0", d.x > 0.5 && d.y > 0.2 && d.ph === "stick", JSON.stringify({ x: d.x, y: d.y, ph: d.ph }));
  await sleep(900); d = await G(); check("holding a slid stick for a long time never turns into a brake", !d.brake && d.ph === "stick");
  await tp("touchEnd", []); await sleep(200); d = await G(); check("release returns the stick to neutral", d.x === 0 && d.y === 0 && d.ph === "idle");
  await fly(); await sleep(300); const st0 = (await G()).strokes;
  await tapAt(650, 190, 6); await sleep(400); d = await G();
  check("short tap = exactly one flap", d.strokes === st0 + 1, `strokes ${st0}->${d.strokes}`);
  await tp("touchStart", [{ x: 650, y: 190, id: 7 }]); await sleep(550); d = await G(); const stL = d.strokes - d.af;
  check("long press = brake (physics sees it)", d.brake && d.ph === "brake" && (await p.evaluate(() => __game.flight.braking)));
  await tp("touchEnd", []); await sleep(400); d = await G();
  check("releasing after a long press gives no flap and clears the brake", !d.brake && d.strokes - d.af === stL, `manual strokes ${stL}->${d.strokes - d.af}`); // 減速後の速度低下で自動羽ばたき(assist)が入るのは正常
  const hit = (x, y) => p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id || document.elementFromPoint(x, y)?.tagName, [x, y]);
  check("the unused (left) half is not part of the stick area in right-hand mode", (await hit(200, 190)) !== "stick" && (await hit(650, 190)) === "stick", `${await hit(200, 190)} / ${await hit(650, 190)}`);
  await tp("touchStart", [{ x: 650, y: 190, id: 9 }, { x: 700, y: 300, id: 10 }]); await tp("touchMove", [{ x: 700, y: 190, id: 9 }, { x: 760, y: 340, id: 10 }]); await sleep(200); d = await G();
  check("a second finger is ignored (touch id tracked)", d.ph === "stick" && d.x > 0.3 && d.y >= -0.2, JSON.stringify({ x: d.x, y: d.y }));
  await tp("touchEnd", []); await sleep(150);
  await tp("touchStart", [{ x: 650, y: 190, id: 11 }]); await tp("touchMove", [{ x: 740, y: 190, id: 11 }]); await sleep(150);
  await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200); d = await G();
  check("pausing while the stick is held clears the input", d.x === 0 && d.ph === "idle" && !d.brake);
  await tp("touchEnd", []); await p.click("#ovGo"); await sleep(300);
  await tp("touchStart", [{ x: 650, y: 190, id: 12 }]); await tp("touchMove", [{ x: 740, y: 190, id: 12 }]); await sleep(150);
  await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200); d = await G();
  check("switching the control mode mid-game releases the stick (right -> left)", d.ctl === "left" && d.x === 0 && d.ph === "idle" && d.zone.l === 0 && d.zone.w >= 440, JSON.stringify({ ctl: d.ctl, ph: d.ph }));
  await tp("touchEnd", []); await sleep(100);
  await fly(); await sleep(300); const stR = (await G()).strokes;
  await tapAt(200, 190, 13); await sleep(400); d = await G();
  check("left-hand: a tap on the left half flaps", d.strokes === stR + 1, `strokes ${stR}->${d.strokes}`);
  check("left-hand: the right half is not part of the stick area", (await hit(800, 190)) !== "stick" && (await hit(200, 190)) === "stick");
  // 地上: タップは小ジャンプ、長押しは歩く
  await p.evaluate(() => { const g = __game, f = g.flight; f.pos.set(28, 0.32, 60); f.prevPos.copy(f.pos); f.vel.set(0, 0, 0); f.mode = "landed"; f.walkV = 0; g.input.releaseAll(); }); await sleep(300);
  await tp("touchStart", [{ x: 200, y: 190, id: 15 }]); await sleep(700); const gw0 = await S(); await sleep(500); const gw1 = await S(); await tp("touchEnd", []);
  check("on the ground a long press walks (no auto flapping)", Math.hypot(gw1.x - gw0.x, gw1.z - gw0.z) > 0.3 && gw1.mode === "landed", `moved=${Math.hypot(gw1.x - gw0.x, gw1.z - gw0.z).toFixed(2)}`);
  // F1: 地上でスティックを前へスライドしたまま歩く・斜めで曲がりながら歩く・指を離すと止まる(実際のタッチ入力)
  await sleep(300); await p.evaluate(() => { const g = __game, f = g.flight; f.pos.set(28, 0.32, 60); f.prevPos.copy(f.pos); f.vel.set(0, 0, 0); f.yaw = 0; f.mode = "landed"; f.walkV = 0; g.input.releaseAll(); }); await sleep(300);
  const Y = () => p.evaluate(() => __game.flight.yaw);
  await tp("touchStart", [{ x: 200, y: 215, id: 30 }]); await tp("touchMove", [{ x: 200, y: 155, id: 30 }]); await sleep(400); const sw0 = await S(); await sleep(1200); const sw1 = await S(); d = await G();
  const swd = Math.hypot(sw1.x - sw0.x, sw1.z - sw0.z);
  check("F1: on the ground, sliding the thumb forward walks (no long press)", swd > 0.8 && sw1.mode === "landed" && d.ph === "stick" && d.y > 0.5, `moved=${swd.toFixed(2)} m y=${d.y.toFixed(2)} ph=${d.ph}`);
  const yw0 = await Y(); await tp("touchMove", [{ x: 245, y: 160, id: 30 }]); await sleep(1200); const yw1 = await Y(); const sw2 = await S();
  check("F1: diagonal thumb turns while walking", Math.abs(yw1 - yw0) > 0.3 && Math.hypot(sw2.x - sw1.x, sw2.z - sw1.z) > 0.8, `turned=${Math.abs(yw1 - yw0).toFixed(2)} rad`);
  await tp("touchEnd", []); await sleep(500); const sw3 = await S(); await sleep(400); const sw4 = await S();
  check("F1: lifting the thumb stops walking (still controllable, landed)", Math.hypot(sw4.x - sw3.x, sw4.z - sw3.z) < 0.05 && sw4.mode === "landed");
  await sleep(600); await p.evaluate(() => { const f = __game.flight; f.vel.set(0, 0, 0); f.walkV = 0; }); await sleep(300);
  await tapAt(200, 190, 16); await p.waitForFunction(() => __game.flight.hopping || __game.flight.mode === "air", null, { timeout: 5000 }).catch(() => {});
  d = await G(); check("on the ground a tap becomes a small hop (not swallowed by the assist)", d.hop || d.mode === "air", JSON.stringify({ hop: d.hop, mode: d.mode }));
  // UIボタンの上のタッチはスティックにならない
  await sleep(1500);
  await tp("touchStart", [{ x: 840, y: 25, id: 17 }]); await sleep(100); d = await G(); await tp("touchEnd", []);
  check("a touch on a top UI button never starts a stick", d.ph === "idle");
  // 保存と復元: 再読み込みしても開始待ち
  const saved = await p.evaluate(() => localStorage.getItem("vindving.prefs.v1")); check("the control mode is saved", !!saved && JSON.parse(saved).control === "left", saved);
  await p.reload(); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(800);
  const rs = await p.evaluate(() => ({ ctl: document.body.dataset.ctl, st: __game.game.state, ov: !document.getElementById("overlay").hidden, on: document.querySelector('[data-set="ctl"].on')?.dataset.val }));
  check("reload restores the control mode but waits at the start screen", rs.ctl === "left" && rs.st === "ready" && rs.ov && rs.on === "left", JSON.stringify(rs));
  // ページを閉じる/離れるときに保存し直すので、壊れた値は「次の読み込みの直前」に差し込む(1回だけ)
  await p.context().addInitScript(() => { if (!sessionStorage.getItem("brokenOnce")) { sessionStorage.setItem("brokenOnce", "1"); localStorage.setItem("vindving.prefs.v1", "{broken"); } }); await p.evaluate(() => sessionStorage.removeItem("brokenOnce")); await p.reload(); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(600);
  check("a corrupted saved value starts safely with defaults", (await p.evaluate(() => document.body.dataset.ctl)) === "both");
  await p.click("#ovGo"); await sleep(500);
}


// ---- g5: オート周遊(D2)とオート演出(D3)
async function g5({ p, cdp, errs }) {
  const S = () => p.evaluate(() => { const g = __game, f = g.flight; return { st: g.game.state, t: g.game.gameTime, steps: g.game.steps, x: f.pos.x, y: f.pos.y, z: f.pos.z, mode: f.mode, speed: f.speed, inx: g.input.state.x, iny: g.input.state.y, flap: g.input.state.flapHeld, brake: g.input.state.brake, ov: !document.getElementById("overlay").hidden }; });
  const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  const tapAt = (x, y, id) => p.evaluate(([x, y, id]) => { const z = document.getElementById("stick"), o = { bubbles: true, pointerId: id, clientX: x, clientY: y, pointerType: "touch" }; z.dispatchEvent(new PointerEvent("pointerdown", o)); z.dispatchEvent(new PointerEvent("pointerup", o)); }, [x, y, id]);

  console.log("\n# autopilot (D2)");
  await p.setViewportSize({ width: 892, height: 412 });
  await p.evaluate(() => { localStorage.clear(); }); await p.reload(); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(500);
  const A = () => p.evaluate(() => { const g = __game; return { auto: g.autopilot.enabled, st: g.game.state, ap: document.body.dataset.auto, off: !document.getElementById("btnAutoOff").hidden, pol: document.getElementById("btnPol").textContent, steps: g.game.steps, mode: g.flight.mode, x: g.flight.pos.x, z: g.flight.pos.z, finite: Number.isFinite(g.flight.pos.x + g.flight.pos.y + g.flight.pos.z) }; });
  let a = await A(); check("auto never starts by itself (waiting at the start screen)", !a.auto && a.st === "ready" && !a.off);
  await p.click('[data-set="apol"][data-val="scenic"]'); check("policy selectable from the menu", (await p.evaluate(() => __game.autopilot.policy)) === "scenic");
  await p.click("#ovAuto"); await sleep(300); a = await A(); check("オートで飛ぶ starts the game with auto on and shows オート解除", a.auto && a.st === "running" && a.off && a.ap === "1");
  const ast0 = a.steps; await p.waitForFunction(s => __game.game.steps > s + 240, ast0, { timeout: 60000 }); a = await A();
  check("auto flies by itself (steps advance, state finite)", a.finite && a.steps > ast0);
  await tapAt(650, 250, 31); await sleep(200); a = await A(); check("tapping the screen does not cancel auto", a.auto);
  await p.click("#btnPol"); a = await A(); check("policy button cycles the policy during auto without stopping", a.auto && a.pol !== "景色観賞");
  const abef = await p.evaluate(() => ({ p: __game.flight.pos.clone(), v: __game.flight.vel.clone() }));
  await p.click("#btnAutoOff"); a = await A(); const aaft = await p.evaluate(() => ({ p: __game.flight.pos.clone(), v: __game.flight.vel.clone() }));
  check("オート解除 stops auto; flight state continues (no jump)", !a.auto && !a.off && a.ap === "0" && Math.hypot(aaft.p.x - abef.p.x, aaft.p.z - abef.p.z) < 40);
  await p.evaluate(() => __game.setAuto(true)); await p.evaluate(() => { __game.input.state.x = 1; __game.input.state.y = 1; });
  const ayaw0 = await p.evaluate(() => __game.flight.yaw); await sleep(300); a = await A(); check("auto can be turned on again and ignores manual stick state", a.auto);
  await p.evaluate(() => __game.setAuto(false));
  check("policy was saved in prefs", (await p.evaluate(() => JSON.parse(localStorage.getItem("vindving.prefs.v1") || "{}").autoPolicy)) !== undefined);
  await p.reload(); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(500); a = await A(); check("after reload auto is off and the game waits at the start", !a.auto && a.st === "ready");
  await p.click("#ovGo"); await sleep(500);

  console.log("\n# auto view (D3)");
  await p.evaluate(() => { localStorage.clear(); }); await p.reload(); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(500);
  if (await p.evaluate(() => document.getElementById("overlay").hidden)) { await p.evaluate(() => __game.input.onPause()); await sleep(300); }
  await p.click('[data-set="ats"][data-val="fast"]'); await p.click('[data-set="ahide"][data-val="1"]');
  check("auto time speed + UI-hide are saved in prefs", await p.evaluate(() => { const o = JSON.parse(localStorage.getItem("vindving.prefs.v1")); return o.autoTimeSpeed === "fast" && o.autoHideUi === true; }));
  await p.evaluate(() => __game.setHour(6)); await p.click("#ovAuto"); await sleep(300);
  const T0 = await p.evaluate(() => ({ h: __game.hour(), gt: __game.game.gameTime }));
  await p.waitForFunction(g => __game.game.gameTime > g + 3, T0.gt, { timeout: 60000 });
  const T1 = await p.evaluate(() => ({ h: __game.hour(), gt: __game.game.gameTime }));
  const hrs = ((T1.h - T0.h + 24) % 24) / (T1.gt - T0.gt);
  check("auto time advances at 高速 (24h / 3 min)", Math.abs(hrs - 24 / 180) < 0.01, hrs.toFixed(4));
  await p.evaluate(() => { __game.drift.target = 2; __game.drift.level = 0; });
  const wx0 = await p.evaluate(() => __game.wxLevel()); await p.waitForFunction(() => __game.wxLevel() > 0.05, null, { timeout: 60000 }); const wx1 = await p.evaluate(() => __game.wxLevel());
  check("auto weather changes gradually (continuous, not a jump)", wx1 > wx0 && wx1 < 1, `${wx0} -> ${wx1}`);
  await p.waitForFunction(() => __game.director.switches > 0 || __game.game.gameTime > 40, null, { timeout: 90000 }).catch(() => {});
  check("camera director is active (shots chosen)", await p.evaluate(() => __game.director.switches >= 0 && __game.autopilot.enabled));
  await p.evaluate(() => { __game.uiHider.idle = 4.95; });
  await p.waitForFunction(() => document.body.classList.contains("ui-hidden"), null, { timeout: 20000 });
  const hv = await p.evaluate(() => ({ steps: __game.game.steps, auto: __game.autopilot.enabled, op: getComputedStyle(document.getElementById("btnAutoOff")).pointerEvents }));
  check("UI hides ~5 s after the last touch while auto continues", hv.auto && hv.op === "none");
  await tapAt(650, 250, 41); await sleep(300);
  check("tap shows the UI again (オート解除 / 方針 / 時間速度) and does not cancel auto", await p.evaluate(() => !document.body.classList.contains("ui-hidden") && __game.autopilot.enabled && !document.getElementById("btnAutoOff").hidden && !document.getElementById("btnPol").hidden && !document.getElementById("btnTs").hidden));
  await p.click("#btnTs"); check("時間 button cycles the speed", (await p.evaluate(() => __game.settings.ats)) === "slow");
  const R = await p.evaluate(() => ({ h: __game.hour(), w: __game.wxLevel() }));
  await p.click("#btnAutoOff"); await sleep(300);
  const R2 = await p.evaluate(() => ({ h: __game.hour(), w: __game.wxLevel(), auto: __game.autopilot.enabled, vis: __game.cam.mode }));
  check("after オート解除 the reached time and weather are kept", !R2.auto && Math.abs(R2.h - R.h) < 0.5 && Math.abs(R2.w - R.w) < 0.1, JSON.stringify([R, R2]));
  // 監査対応: UI非表示中の一時停止・再開、一時停止中の描画省略(PR #11)
  await p.evaluate(() => { __game.setAuto(true); __game.uiHider.idle = 4.95; });
  await p.waitForFunction(() => document.body.classList.contains("ui-hidden"), null, { timeout: 20000 });
  await p.evaluate(() => __game.input.onPause()); await sleep(400);
  check("UI hidden + pause: the UI comes back and the timer is reset", await p.evaluate(() => !document.body.classList.contains("ui-hidden") && __game.uiHider.idle === 0 && !document.getElementById("overlay").hidden));
  await sleep(600); const fr0 = await p.evaluate(() => __game.renderer.info.render.frame); await sleep(800); const fr1 = await p.evaluate(() => __game.renderer.info.render.frame);
  check("paused: no rendering while nothing changes (PR #11 optimisation kept)", fr1 === fr0, `${fr0}->${fr1}`);
  await p.click("#ovGo"); await sleep(400);
  check("resume: auto still on, UI shown, timer restarted (not instantly hidden)", await p.evaluate(() => __game.autopilot.enabled && !document.body.classList.contains("ui-hidden") && __game.uiHider.idle < 3));
  await p.evaluate(() => __game.setAuto(false)); await sleep(200);
  await p.click("#btnPause"); await sleep(300);
  check("paused: UI is shown", await p.evaluate(() => !document.body.classList.contains("ui-hidden")));
  await p.click("#ovGo"); await sleep(300);
  check("D3: no page errors", errs.length === 0, errs.join(" | "));
}


// ---- g6: 着地補助・田んぼ・季節・時刻
async function g6({ p, cdp, errs }) {
  const S = () => p.evaluate(() => { const g = __game, f = g.flight; return { st: g.game.state, t: g.game.gameTime, steps: g.game.steps, x: f.pos.x, y: f.pos.y, z: f.pos.z, mode: f.mode, speed: f.speed, inx: g.input.state.x, iny: g.input.state.y, flap: g.input.state.flapHeld, brake: g.input.state.brake, ov: !document.getElementById("overlay").hidden }; });
  const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });

  console.log("\n# perch assist (E2)");
  if (await p.evaluate(() => document.getElementById("overlay").hidden === false)) { await p.click("#ovGo"); await sleep(300); }
  await p.evaluate(() => { __game.setAuto(false); __game.settings.weather = "clear"; });
  const house = await p.evaluate(() => { const a = __game.world.apts[0]; return { x: a.x, z: a.z, top: __game.world.heightAt(a.x, a.z) }; });
  await p.evaluate(h => { const f = __game.flight; f.reset(); f.pos.set(h.x + 20, h.top + 3, h.z); f.prevPos.copy(f.pos); f.yaw = Math.PI / 2; f.vel.set(-9, -0.5, 0); __game.input.state.brake = true; }, house);
  await p.waitForFunction(() => __game.perchAssist.stats.guided > 0, null, { timeout: 15000 }).catch(() => {}); await sleep(100);
  const mk = await p.evaluate(() => ({ vis: __game.perchMarker.visible, tgt: __game.perchAssist.target && __game.perchAssist.target.kind, guided: __game.perchAssist.stats.guided }));
  check("approaching a roof with the brake held: a candidate marker is shown and guidance is active", mk.vis && mk.tgt === "roof" && mk.guided > 0, JSON.stringify(mk));
  await p.evaluate(() => { __game.input.state.brake = false; __game.setAuto(true); }); await sleep(400);
  check("the marker is hidden during auto flight", await p.evaluate(() => !__game.perchMarker.visible));
  await p.evaluate(() => { __game.setAuto(false); const f = __game.flight; f.reset(); f.pos.set(28, 60, 150); f.prevPos.copy(f.pos); f.vel.set(0, 0, -10); }); // 建物のない上空(以前の(-60,30,-60)は高層アパートの壁に当たる位置で、衝突の復帰でカメラ距離が変わっていた)
  await sleep(500);
  check("far from any landing candidate the marker is not shown", await p.evaluate(() => !__game.perchMarker.visible));
  // 着地中のカメラは鳥を近く(大きく)映す
  const dAir = await p.evaluate(() => __game.camera.position.distanceTo(__game.flight.pos));
  await p.evaluate(() => { const f = __game.flight; f.reset(); f.pos.set(0, __game.world.heightAt(0, 0) + 0.5, 0); f.prevPos.copy(f.pos); f.mode = "landed"; f.vel.set(0, 0, 0); __game.cam.snap(); });
  await sleep(1500);
  const dGround = await p.evaluate(() => __game.camera.position.distanceTo(__game.flight.pos));
  check("landed: the camera is closer to the bird than in flight", dGround < dAir - 0.8, `${dAir.toFixed(2)} -> ${dGround.toFixed(2)}`);
  check("E2: no page errors", errs.length === 0, errs.join(" | "));

  console.log("\n# fields and foraging (E4)");
  await p.evaluate(() => { __game.setAuto(false); __game.input.state.brake = false; });
  const vac = await p.evaluate(() => { const l = __game.world.lots.find(q => q.use === "vacant"); return { x: l.x, z: l.z }; });
  await p.evaluate(v => { const f = __game.flight; f.reset(); f.pos.set(v.x - 12, __game.world.heightAt(v.x - 12, v.z) + 0.32, v.z); f.prevPos.copy(f.pos); f.mode = "landed"; f.vel.set(0, 0, 0); f.yaw = -Math.PI / 2; __game.forage.reset(); __game.forage.stats.sequences = 0; __game.forage.stats.pecks = 0; __game.input.state.brake = true; }, vac);
  await p.waitForFunction(() => __game.forage.stats.pecks >= 2, null, { timeout: 60000 }).catch(() => {});
  const fg = await p.evaluate(() => ({ seq: __game.forage.stats.sequences, pecks: __game.forage.stats.pecks, ground: __game.world.groundAt(__game.flight.pos.x, __game.flight.pos.z) }));
  check("walking on a vacant lot (soil): the bird stops and pecks", fg.pecks >= 2 && fg.seq >= 1 && fg.ground === "soil", JSON.stringify(fg));
  const pad = await p.evaluate(() => { const l = __game.world.lots.find(q => q.use === "paddy"); return { x: l.x, z: l.z }; });
  await p.evaluate(v => { const f = __game.flight; f.reset(); f.pos.set(v.x + 21.5, __game.world.heightAt(v.x + 21.5, v.z) + 0.32, v.z); f.prevPos.copy(f.pos); f.mode = "landed"; f.vel.set(0, 0, 0); f.yaw = Math.PI / 2; __game.input.state.brake = true; }, pad);
  await p.waitForFunction(() => __game.game.steps > 0, null, { timeout: 5000 }); const pst0 = await p.evaluate(() => __game.game.steps); await p.waitForFunction(s => __game.game.steps > s + 300, pst0, { timeout: 60000 });
  check("walking toward a paddy: the bird stays out of the water", await p.evaluate(() => !__game.world.waterAt(__game.flight.pos.x, __game.flight.pos.z) && __game.flight.mode === "landed"));
  await p.evaluate(() => { __game.input.state.brake = false; });
  check("E4: no page errors", errs.length === 0, errs.join(" | "));

  console.log("\n# seasons (E5)");
  await p.evaluate(() => { __game.setAuto(false); __game.input.state.brake = false; __game.season.phase = 0.9; __game.applySeasonLook(true); });
  const s5_snowW = await p.evaluate(() => __game.world.group.children.some(c => c.material && c.material.emissiveIntensity > 0.1 && c.material.emissive.getHex() === 0xffffff));
  await p.evaluate(() => { __game.season.phase = 0.3; __game.applySeasonLook(true); });
  const s5_snowS = await p.evaluate(() => __game.world.group.children.some(c => c.material && c.material.emissiveIntensity > 0.1 && c.material.emissive.getHex() === 0xffffff && c.material.map));
  check("winter shows snow (white emissive on ground/roofs), summer does not", s5_snowW && !s5_snowS, `${s5_snowW} ${s5_snowS}`);
  check("the season button shows the current season (summer = 夏)", (await p.evaluate(() => document.getElementById("btnSeason").textContent)) === "夏");
  const s5_sp0 = await p.evaluate(() => ({ ph: __game.season.phase, sp: __game.season.speed }));
  await p.evaluate(() => document.getElementById("btnSeason").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  const s5_sp1 = await p.evaluate(() => ({ ph: __game.season.phase, sp: __game.season.speed, toast: document.getElementById("toast").textContent }));
  check("tapping the season button cycles the speed (標準→高速), keeps the position, and shows a short message", s5_sp0.sp === "normal" && s5_sp1.sp === "fast" && Math.abs(s5_sp1.ph - s5_sp0.ph) < 0.01 && s5_sp1.toast.includes("高速"), JSON.stringify([s5_sp0, s5_sp1]));
  const s5_gt0 = await p.evaluate(() => __game.game.gameTime), s5_ph0 = await p.evaluate(() => __game.season.phase);
  await p.waitForFunction(g => __game.game.gameTime > g + 2, s5_gt0, { timeout: 60000 });
  const s5_ph1 = await p.evaluate(() => __game.season.phase), s5_gt1 = await p.evaluate(() => __game.game.gameTime);
  check("the season advances with game time at the chosen speed (高速: 600 s per year)", Math.abs((((s5_ph1 - s5_ph0) + 1) % 1) - (s5_gt1 - s5_gt0) / 600) < 0.004, `${s5_ph0.toFixed(4)} -> ${s5_ph1.toFixed(4)} over ${(s5_gt1 - s5_gt0).toFixed(1)} s`);
  await p.evaluate(() => __game.input.onPause()); await sleep(300); const s5_pa0 = await p.evaluate(() => __game.season.phase); await sleep(1500); const s5_pa1 = await p.evaluate(() => __game.season.phase);
  check("paused: the season does not advance", s5_pa0 === s5_pa1);
  check("the menu has the 季節の速さ row with the current speed highlighted", await p.evaluate(() => document.querySelector('[data-set="ss"][data-val="fast"]').classList.contains("on")));
  await p.click('[data-set="ss"][data-val="slow"]'); check("changing the speed from the menu works and is saved with the position", await p.evaluate(() => { const o = JSON.parse(localStorage.getItem("vindving.prefs.v1")); return o.seasonSpeed === "slow" && typeof o.seasonPhase === "number"; }));
  const s5_keep = await p.evaluate(() => __game.season.phase); await p.reload(); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(500);
  check("after a reload the season position and speed are restored (the game still waits at the start)", await p.evaluate(k => Math.abs(__game.season.phase - k) < 0.02 && __game.season.speed === "slow" && __game.game.state === "ready", s5_keep));
  await p.click("#ovGo"); await sleep(300);
  check("E5: no page errors", errs.length === 0, errs.join(" | "));

  console.log("\n# time of day (A2)");
  const seen = [];
  for (let i = 0; i < 4; i++) { await p.click("#btnTime"); await sleep(1500); seen.push(await p.evaluate(() => ({ label: document.getElementById("btnTime").textContent, e: __game.env() }))); }
  check("cycle includes 朝 and returns to 昼", seen.map(x => x.label).join() === "夕,夜,朝,昼", seen.map(x => x.label).join());
  const dawn = seen[2].e; check("dawn: warm horizon", ((dawn.hor >> 16) & 255) - (dawn.hor & 255) > 40);
  await p.setViewportSize({ width: 412, height: 892 }); await sleep(600);
  check("portrait: no errors", errs.length === 0, errs.join(" | "));
}


// ---- g7: G1(ヘッドライト・◯タップの自動着地・壁衝突からの復帰)
async function g7({ p, cdp, errs }) {
  const S = () => p.evaluate(() => { const g = __game, f = g.flight; return { x: f.pos.x, y: f.pos.y, z: f.pos.z, mode: f.mode, speed: f.speed, crashes: f.crashes, escapes: f.escapes, grazes: f.grazes }; });
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  console.log("\n# headlights (G1-1)");
  const lamps = h => p.evaluate(hh => { __game.setHour(hh); const g = __game; g.npcUpdate(); return { lamps: g.npcView.headlamps, cars: g.npc.visibleCars().length }; }, h);
  await p.evaluate(() => { __game.flight.reset(); }); await sleep(1500);
  const day = await lamps(12), night = await lamps(0), dawn = await lamps(7), eve = await lamps(18.3);
  check("daytime (12h) and morning (7h): no headlamps", day.lamps === 0 && dawn.lamps === 0, `day=${day.lamps} dawn=${dawn.lamps}`);
  check("night (0h): exactly two lamps per drawn car (cars drawn <= visible cars)", night.lamps >= 2 && night.lamps % 2 === 0 && night.lamps / 2 <= night.cars, `lamps=${night.lamps} cars=${night.cars}`);
  check("evening (18.3h): lit", eve.lamps >= 2 && eve.lamps % 2 === 0, `lamps=${eve.lamps}`);
  const lm = await p.evaluate(() => { __game.setHour(0); const g = __game; let t = 0; for (let i = 0; i < 30; i++) { const a = performance.now(); g.npcUpdate(); t += performance.now() - a; } return t / 30; });
  check("headlight update cost is small (< 1 ms per update)", lm < 1, `${lm.toFixed(3)} ms`);
  await p.evaluate(() => __game.setHour(12));

  console.log("\n# wall hit recovery (G1-2 / G1-3)");
  const wallRun = (alt, v, sideAng) => p.evaluate(async ([alt, v, sideAng]) => {
    const g = __game, f = g.flight, a = g.world.apts.find(q => q.floors >= 9) || g.world.apts[0];
    const c = g.world.colliders.find(k => Math.abs((k.minX + k.maxX) / 2 - a.x) < 0.01 && Math.abs((k.minZ + k.maxZ) / 2 - a.z) < 0.01);
    f.reset(); const dx = -Math.sin(sideAng), dz = -Math.cos(sideAng); f.pos.set((c.minX + c.maxX) / 2 + Math.sin(sideAng) * 9, alt, c.maxZ + Math.cos(sideAng) * 9); f.prevPos.copy(f.pos); f.yaw = Math.atan2(-dx, -dz); f.vel.set(dx * v, 0, dz * v);
    g.cam.snap(); const c0 = f.crashes; let inside = false, maxStun = 0, t0 = performance.now();
    return await new Promise(res => { const tick = () => { for (const k of g.world.colliders) if (f.pos.x > k.minX && f.pos.x < k.maxX && f.pos.z > k.minZ && f.pos.z < k.maxZ && f.pos.y - 0.32 < k.top - 0.3) inside = true; maxStun = Math.max(maxStun, f.stun);
      if (performance.now() - t0 > 3500) res({ crashes: f.crashes - c0, esc: f.escapes, inside, mode: f.mode, maxStun, away: Math.hypot(f.pos.x - Math.max(c.minX, Math.min(c.maxX, f.pos.x)), f.pos.z - Math.max(c.minZ, Math.min(c.maxZ, f.pos.z))), finite: Number.isFinite(f.pos.x + f.pos.y + f.pos.z) }); else requestAnimationFrame(tick); }; tick(); });
  }, [alt, v, sideAng]);
  const w1 = await wallRun(20, 14, 0);
  check("a frontal hit into a tall wall: one crash, then it backs off and flies on, never inside", w1.crashes === 1 && w1.esc >= 1 && !w1.inside && w1.finite && w1.maxStun <= 0.31 && w1.away > 1, JSON.stringify(w1));
  const w2 = await wallRun(20, 14, 0.7);
  check("a diagonal hit: also recovers (no repeated crash)", w2.crashes <= 1 && !w2.inside && w2.finite, JSON.stringify(w2));

  console.log("\n# tap the ring to land automatically (G1-4 / G1-5)");
  // 一瞬のタップは、ソフトウェア描画の遅いフレームでCDPの2回の送信がずれないよう、同一タスク内の合成イベントで行う版(tapAtXY)と、実際のタッチ入力経路(CDP Input.dispatchTouchEvent。tp)の両方を使う
  const tapAtXY = (dx, dy, id) => p.evaluate(([dx, dy, id]) => { const r = __game.ring, x = r.x + dx, y = r.y + dy, el = document.elementFromPoint(x, y) || document.body, o = { bubbles: true, pointerId: id, clientX: x, clientY: y, pointerType: "touch" }; el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o)); return { x, y }; }, [dx, dy, id]);
  /** 足場 kind を選び、その縁の東側 dist m・面の上 up m から、速さ v で西へ向かって飛び出す。side>0 なら足場が画面の右寄りに見える位置から(片手のスティック領域に◯が入る) */
  const setup = (kind, dist = 11, up = 2.6, v = 8, side = 0) => p.evaluate(([kind, dist, up, v, side]) => {
    const g = __game, f = g.flight, w = g.world; f.reset(); g.setAuto(false); g.settings.weather = "clear"; g.input.releaseAll();
    const open = s => !w.colliders.some(c => c.maxX - c.minX > 3 && c.maxZ - c.minZ > 3 && c.top > s.top + 0.3 && c.maxX > s.minX - 16 && c.minX < s.maxX + 16 && c.maxZ > s.minZ - 16 && c.minZ < s.maxZ + 16);
    const cand = g.surfaces.all.filter(s => s.kind === kind && open(s) && (kind !== "roof" || (s.maxX - s.minX) * (s.maxZ - s.minZ) > 40 && s.top < 12));
    const t = cand[0]; if (!t) return null; window.__target = t;
    f.pos.set(t.maxX + dist, t.top + up, (t.minZ + t.maxZ) / 2 + side); f.prevPos.copy(f.pos); f.yaw = Math.PI / 2; f.vel.set(-v, -0.3, 0); g.cam.snap();
    return { kind: t.kind, w: +(t.maxX - t.minX).toFixed(2), d: +(t.maxZ - t.minZ).toFixed(2), top: t.top };
  }, [kind, dist, up, v, side]);
  /** 実際のタッチ入力経路(CDP Input.synthesizeTapGesture): ブラウザ側が押す→離すの間隔(duration ms)を守って届けるので、描画が遅くても押している時間が狂わない */
  const realTap = (x, y, duration = 50) => cdp.send("Input.synthesizeTapGesture", { x, y, duration, tapCount: 1, gestureSourceType: "touch" });
  const waitRing = () => p.waitForFunction(() => __game.ring.visible, null, { timeout: 8000 }).catch(() => {});
  const ringXY = () => p.evaluate(() => ({ vis: __game.ring.visible, x: __game.ring.x, y: __game.ring.y, w: innerWidth }));
  const AL = () => p.evaluate(() => ({ refusal: __game.autoLand.lastRefusal, refused: __game.autoLand.stats.refused, active: __game.autoLand.active, starts: __game.autoLand.stats.starts, ok: __game.autoLand.stats.success, ended: { ...__game.autoLand.stats.ended }, mode: __game.flight.mode, crashes: __game.flight.crashes, ringTaps: __game.input.stats.ringTaps, flapTaps: __game.input.stats.gestureTaps, strokes: __game.flight.strokes, label: document.getElementById("autoland").textContent }));
  const finishLanding = async () => { await p.waitForFunction(() => !__game.autoLand.active, null, { timeout: 30000 }).catch(() => {}); await sleep(1500); };
  const onTarget = () => p.evaluate(() => { const f = __game.flight, t = window.__target; return { mode: f.mode, onTop: Math.abs(f.pos.y - 0.32 - t.top) < 0.06, inside: f.pos.x >= t.minX - 0.3 && f.pos.x <= t.maxX + 0.3 && f.pos.z >= t.minZ - 0.3 && f.pos.z <= t.maxZ + 0.3, x: f.pos.x, z: f.pos.z, walkV: f.walkV }; });

  // (1) 広い足場(屋根): 自動着地のあと、実際のタッチ(スティックを前へ)で歩ける。移動距離と状態を確かめる
  const roofInfo = await setup("roof", 10, 2.6, 8);
  check("a roof with open surroundings exists for the walking test", !!roofInfo && roofInfo.w * roofInfo.d > 40, JSON.stringify(roofInfo));
  await waitRing(); const rr = await ringXY();
  check("the ring shows up for the roof ahead (screen position known)", rr.vis && rr.x > 0 && rr.x < rr.w && rr.y > 0, JSON.stringify(rr));
  const c0 = (await AL()).crashes; await tapAtXY(6, -5, 71); await sleep(150);
  let al = await AL();
  check("tapping near the ring (6 px off) starts an automatic landing; a small label shows", al.starts === 1 && al.label.includes("自動着地"), JSON.stringify({ starts: al.starts, label: al.label }));
  await finishLanding(); al = await AL(); let ot = await onTarget();
  check("the bird lands on the roof by itself, with no crash, and control returns to manual", al.ok === 1 && ot.mode !== "air" && ot.onTop && ot.inside && al.crashes === c0 && al.label === "", JSON.stringify({ ok: al.ok, ...ot, crashes: al.crashes - c0, label: al.label }));
  const stand = { x: ot.x, z: ot.z };
  await sleep(500); const still = await onTarget();
  check("it stays where it landed when nothing is touched (stands, no drift)", Math.hypot(still.x - stand.x, still.z - stand.z) < 0.3 && still.onTop, JSON.stringify({ moved: Math.hypot(still.x - stand.x, still.z - stand.z).toFixed(2), ...still }));
  // 歩く: 実際のタッチ入力(CDP)で、左側のスティック領域を上へスライド
  const walkable = roofInfo.w * roofInfo.d > 12 || Math.max(roofInfo.w, roofInfo.d) >= 3;
  await p.evaluate(() => { __game.flight.walkV = 0; __game.input.releaseAll(); });
  const ww0 = await onTarget(); await tp("touchStart", [{ x: 120, y: 330, id: 80 }]); await tp("touchMove", [{ x: 120, y: 268, id: 80 }]); await sleep(1600);
  const ww1 = await onTarget(); const stickY = await p.evaluate(() => __game.input.state.y); await tp("touchEnd", []); await sleep(300);
  const walked = Math.hypot(ww1.x - ww0.x, ww1.z - ww0.z);
  check("WALKABLE perch (roof): stick forward moves the bird at least 1.5 m, still landed on the roof top", walkable && stickY > 0.4 && walked >= 1.5 && ww1.mode === "landed" && ww1.onTop, `walked ${walked.toFixed(2)} m, stickY ${stickY.toFixed(2)}, ${JSON.stringify(ww1)}`);
  const ww2 = await onTarget(); await sleep(400); const ww3 = await onTarget();
  check("lifting the thumb stops the walk (it stays on the roof)", Math.hypot(ww3.x - ww2.x, ww3.z - ww2.z) < 0.1 && ww3.mode === "landed" && ww3.onTop);

  // (2) 狭い足場(岩など): 「立てる」と「歩ける」を分ける。歩ける広さがなければ、足場の上に立って動かないことを確かめる
  const narrowInfo = await setup("rock", 11, 2.6, 8);
  check("a narrow perch (rock) with open surroundings exists", !!narrowInfo, JSON.stringify(narrowInfo));
  await waitRing(); const nrr = await ringXY(); const cN = (await AL()).crashes; await tapAtXY(0, 0, 72); await sleep(150);
  await finishLanding(); const alN = await AL(); const otN = await onTarget(); const nwalkable = narrowInfo.w * narrowInfo.d > 12 || Math.max(narrowInfo.w, narrowInfo.d) >= 3;
  check("NARROW perch: it lands and stands on top (this is 'stands', not 'walks'), no crash", !nwalkable && alN.ok >= 1 && otN.mode !== "air" && otN.onTop && otN.inside && alN.crashes === cN, JSON.stringify({ narrow: narrowInfo, ...otN }));
  const nw0 = await onTarget(); await tp("touchStart", [{ x: 120, y: 330, id: 81 }]); await tp("touchMove", [{ x: 120, y: 268, id: 81 }]); await sleep(900); const nw1 = await onTarget(); await tp("touchEnd", []);
  await sleep(1200); const nw2 = await onTarget(); const alN2 = await AL();
  check("NARROW perch: pushing the stick walks off the end within ~2 m and lands safely (no crash, not stuck in the air)", Math.hypot(nw1.x - nw0.x, nw1.z - nw0.z) <= 2.5 && nw2.mode !== "air" && alN2.crashes === cN, JSON.stringify({ moved: Math.hypot(nw1.x - nw0.x, nw1.z - nw0.z).toFixed(2), ...nw2 }));

  // (3) 取消: 自動着地中に大きなスティック操作で手動へ戻る(実際のタッチ入力)
  await setup("rock", 12, 2.6, 8); await waitRing(); await tapAtXY(0, 0, 73); await sleep(100);
  const on2 = (await AL()).active;
  await tp("touchStart", [{ x: 150, y: 300, id: 74 }]); await tp("touchMove", [{ x: 230, y: 300, id: 74 }]); await sleep(300);
  const c2 = await p.evaluate(() => ({ active: __game.autoLand.active, user: __game.autoLand.stats.ended.user || 0, stickX: __game.input.state.x })); await tp("touchEnd", []);
  check("a big stick input (real touch) during the automatic landing hands control back at once", on2 && !c2.active && c2.user >= 1 && c2.stickX > 0.3, JSON.stringify({ on2, ...c2 }));

  // (4) 実際のタッチ入力経路(CDP)で◯をタップ: 範囲内/範囲外/羽ばたきの誤発火/スティックとの競合。
  //     画面を小さくしてフレームを速くする(ソフトウェア描画が遅いと、押す→離すの間が300 msを超えるため)。片手操作(右手)にして、◯がスティック領域に入るようにする
  await p.setViewportSize({ width: 480, height: 222 }); await sleep(800);
  await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(300);
  await p.evaluate(() => { if (!document.getElementById("overlay").hidden) document.getElementById("ovGo").click(); }); await sleep(300);
  check("one-hand right mode is on for the touch-path tests", (await p.evaluate(() => document.body.dataset.ctl)) === "right");
  const attempt = async (fn, tries = 4) => { // 環境の遅さで1回目が外れても、4回までやり直す(試行回数も報告する)。毎回新しい進入から
    let last; for (let i = 1; i <= tries; i++) { const info = await setup("rock", 12, 2.6, 8, 6); await waitRing(); await sleep(200); last = await fn(i, info); if (last.ok) return { ...last, tries: i }; } return { ...last, tries };
  };
  // 4a 範囲内(◯から約30 px)の実タッチ: 自動着地が始まり、羽ばたき(片手のタップ)は発生しない
  const r4a = await attempt(async () => {
    const before = await AL(); const r = await ringXY(); if (!r.vis || r.x < r.w / 2 + 20) return { ok: false, why: "ring not in the stick zone " + JSON.stringify(r) };
    const x = Math.round(r.x + 22), y = Math.round(r.y - 20); // 距離 約30 px
    await realTap(x, y, 50); await sleep(250); const after = await AL();
    return { ok: after.starts === before.starts + 1 && after.ringTaps === before.ringTaps + 1 && after.flapTaps === before.flapTaps, before, after, x, y };
  });
  check("REAL TOUCH 30 px from the ring: the automatic landing starts, counted as a ring tap and not as a flap tap", r4a.ok, `tries ${r4a.tries}; refusal=${r4a.after && r4a.after.refusal}; ringTaps ${r4a.before && r4a.before.ringTaps}->${r4a.after && r4a.after.ringTaps}, flapTaps ${r4a.before && r4a.before.flapTaps}->${r4a.after && r4a.after.flapTaps}${r4a.why ? " " + r4a.why : ""}`);
  await p.waitForFunction(() => !__game.autoLand.active, null, { timeout: 30000 }).catch(() => {});
  // 4b 範囲外(◯から約110 px)の実タッチ: 自動着地は始まらず、ふつうの羽ばたきタップになる
  const r4b = await attempt(async () => {
    const before = await AL(); const r = await ringXY(); if (!r.vis || r.x < r.w / 2 + 20) return { ok: false, why: "ring not in the stick zone" };
    const L = await p.evaluate(() => __game.input.layout()); // 巡航◎の領域(分割線より上)で、◯から110 px以上離れた点
    const x = Math.round(Math.min(r.w - 12, Math.max(r.w / 2 + 20, r.x + 110))), y = Math.round(Math.max(70, Math.min(L.split - 15, r.y - 70)));
    if (Math.hypot(x - r.x, y - r.y) < 100) return { ok: false, why: "no cruise-region point far from the ring" };
    await realTap(x, y, 50); await sleep(300); const after = await AL();
    return { ok: after.starts === before.starts && after.ringTaps === before.ringTaps && after.flapTaps === before.flapTaps + 1, before, after };
  });
  check("REAL TOUCH 110 px away from the ring (cruise region): no automatic landing; it is an ordinary flap tap", r4b.ok, `tries ${r4b.tries}; starts ${r4b.before && r4b.before.starts}->${r4b.after && r4b.after.starts}, flapTaps ${r4b.before && r4b.before.flapTaps}->${r4b.after && r4b.after.flapTaps}${r4b.why ? " " + r4b.why : ""}`);
  // 4c/4d ◯の上で押したまま動かす / 長押し: ◯が巡航の領域にあれば従来どおり(スティック/減速)、近接◎の領域にあれば近接の指示(H1)になる。どちらでも自動着地にも羽ばたきにもならない
  const r4c = await attempt(async () => {
    const before = await AL(); const r = await ringXY(); if (!r.vis || r.x < r.w / 2 + 20) return { ok: false, why: "ring not in the stick zone" };
    const L = await p.evaluate(() => __game.input.layout()), inProx = r.y >= L.split;
    const x = Math.round(r.x), y = Math.round(r.y);
    await tp("touchStart", [{ x, y, id: 92 }]); await tp("touchMove", [{ x: x + 60, y, id: 92 }]); await sleep(300);
    const mid = await p.evaluate(() => ({ stickX: __game.input.state.x, phase: __game.input.gesture.phase, prox: __game.input.prox.active, cmdYaw: __game.input.prox.cmd() && __game.input.prox.cmd().zone })); await tp("touchEnd", []); await sleep(250); const after = await AL();
    const regionOk = inProx ? (mid.prox && mid.cmdYaw !== null) : (mid.stickX > 0.3 && mid.phase === "stick");
    return { ok: regionOk && after.starts === before.starts && after.ringTaps === before.ringTaps && after.flapTaps === before.flapTaps, before, after, mid, inProx };
  });
  check("REAL TOUCH pressing on the ring and sliding: the pad under it takes over (cruise stick or proximity), no automatic landing, no flap tap", r4c.ok, `tries ${r4c.tries}; inProxRegion=${r4c.inProx} ${JSON.stringify(r4c.mid)} ringTaps ${r4c.before && r4c.before.ringTaps}->${r4c.after && r4c.after.ringTaps}${r4c.why ? " " + r4c.why : ""}`);
  const r4d = await attempt(async () => {
    const before = await AL(); const r = await ringXY(); if (!r.vis || r.x < r.w / 2 + 20) return { ok: false, why: "ring not in the stick zone" };
    const L = await p.evaluate(() => __game.input.layout()), inProx = r.y >= L.split;
    await tp("touchStart", [{ x: Math.round(r.x), y: Math.round(r.y), id: 93 }]); await sleep(600);
    const mid = await p.evaluate(() => ({ brake: __game.input.state.brake, phase: __game.input.gesture.phase, prox: __game.input.prox.active, proxOn: __game.flight.prox.on })); await tp("touchEnd", []); await sleep(250); const after = await AL();
    const regionOk = inProx ? (mid.prox && mid.proxOn) : (mid.brake && mid.phase === "brake");
    return { ok: regionOk && after.starts === before.starts && after.ringTaps === before.ringTaps, before, after, mid, inProx };
  });
  check("REAL TOUCH long press (0.6 s) on the ring: brake (cruise region) or a proximity maneuver (proximity region); never an automatic landing", r4d.ok, `tries ${r4d.tries}; inProxRegion=${r4d.inProx} ${JSON.stringify(r4d.mid)}${r4d.why ? " " + r4d.why : ""}`);
  // 4e 左手モードの切替で取り残しがない: 一度◯タップになった指番号をもう一度使っても、ふつうに動く(ringFiredの取り残し)
  await p.evaluate(() => { __game.input.releaseAll(); }); await p.setViewportSize({ width: 892, height: 412 }); await sleep(500);
  check("G1: no page errors", errs.length === 0, errs.join(" | "));
}

// ---- g8: H1(上下2つの◎・近接機動)を、実際のタッチ入力(CDP)で
async function g8({ p, cdp, errs }) {
  const F = () => p.evaluate(() => { const f = __game.flight; return { mode: f.mode, x: f.pos.x, y: f.pos.y, z: f.pos.z, yaw: f.yaw, speed: f.speed, prox: f.prox.on, state: f.prox.state, sitting: f.sitting, crashes: f.crashes, escapes: f.escapes }; });
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  const L = () => p.evaluate(() => __game.input.layout());
  const rectOf = id => p.evaluate(id => { const r = document.getElementById(id).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, vis: getComputedStyle(document.getElementById(id)).display !== "none" }; }, id);
  const goto = (x, y, z, yaw, v) => p.evaluate(([x, y, z, yaw, v]) => { const g = __game, f = g.flight; f.reset(); g.setAuto(false); g.input.releaseAll(); f.pos.set(x, y, z); f.prevPos.copy(f.pos); f.yaw = yaw; f.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v); g.cam.snap(); }, [x, y, z, yaw, v]);
  const sw = async () => { await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(250); };

  console.log("\n# two pads (H1)");
  let mode = await p.evaluate(() => document.body.dataset.ctl);
  const bothVis = await rectOf("padProx");
  check("two-hand mode (the default): no pads are shown (the cruise controls are unchanged)", mode === "both" && !bothVis.vis);
  await sw(); await p.evaluate(() => { if (!document.getElementById("overlay").hidden) document.getElementById("ovGo").click(); }); await sleep(300);
  mode = await p.evaluate(() => document.body.dataset.ctl);
  const c = await rectOf("padCruise"), q = await rectOf("padProx"), top = await rectOf("top"), lay = await L();
  check("right-hand mode: the cruise pad (upper) and the proximity pad (lower) are both shown, stacked, in the right half", mode === "right" && c.vis && q.vis && c.b < q.t && c.l >= 446 && q.l >= 446 && q.b <= 412 && c.t > top.b - 2, JSON.stringify({ c, q, topBottom: top.b }));
  check("the pads do not overlap each other or the top button row, and each is at least 100 px wide (a thumb-sized target)", c.b <= q.t && q.r - q.l >= 100 && c.r - c.l >= 100 && c.t >= top.b - 2, `cruise ${Math.round(c.r - c.l)} px, prox ${Math.round(q.r - q.l)} px`);

  console.log("\n# proximity maneuver by real touch (H1)");
  await goto(28, 60, 150, 0, 12); await sleep(300);
  const before = await F(); const cx = Math.round(lay.prox.cx), cy = Math.round(lay.prox.cy);
  await tp("touchStart", [{ x: cx, y: cy, id: 11 }]);
  await p.waitForFunction(() => __game.flight.prox.on, null, { timeout: 8000 }).catch(() => {});
  await p.waitForFunction(() => __game.flight.speed < 4, null, { timeout: 8000 }).catch(() => {});
  const braked = await F(); const info = await p.evaluate(() => ({ active: __game.input.prox.active, strokes: __game.flight.strokes, hud: document.getElementById("hud").textContent }));
  check("touching the lower pad (center) brakes from 12 m/s to a creep within a few frames, staying in the air, near the same altitude", braked.prox && braked.speed < 4 && braked.mode === "air" && Math.abs(braked.y - before.y) < 2.5 && info.active, `speed ${braked.speed.toFixed(1)} dy ${(braked.y - before.y).toFixed(2)} ${info.hud.slice(0, 30)}`);
  // 右へ(環状): 約90度右へ向く
  const yawBefore = (await F()).yaw; await tp("touchMove", [{ x: Math.round(lay.prox.cx + lay.prox.r * 0.75), y: cy, id: 11 }]);
  await p.waitForFunction(y0 => { const d = Math.atan2(Math.sin(__game.flight.yaw - y0), Math.cos(__game.flight.yaw - y0)); return d < -1.2; }, yawBefore, { timeout: 10000 }).catch(() => {});
  const turned = await F(); const dYaw = Math.atan2(Math.sin(turned.yaw - yawBefore), Math.cos(turned.yaw - yawBefore)) / Math.PI * 180;
  check("sliding to the right side of the ring turns the bird about 90 degrees to the right and it moves that way slowly", dYaw < -80 && dYaw > -100 && turned.speed < 4 && turned.mode === "air", `turned ${dYaw.toFixed(0)} deg, speed ${turned.speed.toFixed(1)}`);
  // 離す: 止まらずゆっくり前進、高度を保つ
  await tp("touchEnd", []); const rel0 = await F(); await sleep(1500); const rel1 = await F();
  check("lifting the finger does not stop the bird: it keeps creeping forward and holds its altitude", rel1.prox && rel1.state === "creep" && rel1.speed > 1.5 && Math.hypot(rel1.x - rel0.x, rel1.z - rel0.z) > 0.8 && Math.abs(rel1.y - rel0.y) < 1.0, `speed ${rel1.speed.toFixed(1)} moved ${Math.hypot(rel1.x - rel0.x, rel1.z - rel0.z).toFixed(1)} m dy ${(rel1.y - rel0.y).toFixed(2)}`);
  // 巡航◎に触れると、通常飛行へ(スティックで舵)
  const up = lay.cruise; await tp("touchStart", [{ x: Math.round(up.cx), y: Math.round(up.cy), id: 12 }]); await tp("touchMove", [{ x: Math.round(up.cx + 60), y: Math.round(up.cy), id: 12 }]);
  await p.waitForFunction(() => !__game.flight.prox.on, null, { timeout: 12000 }).catch(() => {});
  const back = await F(); const cr = await p.evaluate(() => ({ stickX: __game.input.state.x, phase: __game.input.gesture.phase })); await tp("touchEnd", []);
  check("touching the upper (cruise) pad uses the usual stick and returns the bird to normal flight, no crash", !back.prox && back.mode === "air" && cr.phase === "stick" && back.crashes === before.crashes, JSON.stringify({ back: { prox: back.prox, mode: back.mode, speed: +back.speed.toFixed(1) }, cr }));

  console.log("\n# one finger at a time");
  await goto(28, 60, 150, 0, 12); await sleep(300);
  await tp("touchStart", [{ x: cx, y: cy, id: 21 }]); await p.waitForFunction(() => __game.input.prox.active, null, { timeout: 5000 }).catch(() => {});
  await tp("touchStart", [{ x: cx, y: cy, id: 21 }, { x: Math.round(up.cx), y: Math.round(up.cy), id: 22 }]); await tp("touchMove", [{ x: cx, y: cy, id: 21 }, { x: Math.round(up.cx + 50), y: Math.round(up.cy), id: 22 }]); await sleep(300);
  const two = await p.evaluate(() => ({ prox: __game.input.prox.active, cruise: __game.input.gesture.active, stickX: __game.input.state.x }));
  check("while the lower pad is held, a second finger on the upper pad is ignored (the pad touched first is the one used)", two.prox && !two.cruise && Math.abs(two.stickX) < 0.01, JSON.stringify(two));
  await tp("touchEnd", []); await sleep(200);

  console.log("\n# walls and the ground (H1)");
  const wallInfo = await p.evaluate(() => { const g = __game, a = g.world.apts.find(q => q.floors >= 9) || g.world.apts[0], c = g.world.colliders.find(k => Math.abs((k.minX + k.maxX) / 2 - a.x) < 0.01 && Math.abs((k.minZ + k.maxZ) / 2 - a.z) < 0.01); return { x: (c.minX + c.maxX) / 2, z: c.maxZ, top: c.top }; });
  await goto(wallInfo.x, 20, wallInfo.z + 14, 0, 14); const w0 = await F();
  await tp("touchStart", [{ x: cx, y: cy, id: 31 }]); await sleep(300);
  await p.waitForFunction(w => __game.flight.speed < 3.5 || __game.flight.crashes > w, w0.crashes, { timeout: 8000 }).catch(() => {});
  await sleep(2500); const w1 = await F(); await tp("touchEnd", []);
  check("a close maneuver straight at a tall wall from 14 m/s: the bird stops in front of it (no crash, not inside)", w1.crashes === w0.crashes && w1.z > wallInfo.z + 0.6 && w1.mode === "air", `distance to the wall ${(w1.z - wallInfo.z).toFixed(2)} m`);
  // 地上: 下方向で座る
  await p.evaluate(() => { const g = __game, f = g.flight; f.reset(); g.input.releaseAll(); f.pos.set(28, 0.32, 60); f.prevPos.copy(f.pos); f.vel.set(0, 0, 0); f.mode = "landed"; f.walkV = 0; f.yaw = 0; });
  await sleep(300); await tp("touchStart", [{ x: cx, y: Math.round(lay.prox.cy + lay.prox.r * 0.7), id: 41 }]);
  await p.waitForFunction(() => __game.flight.sitting, null, { timeout: 6000 }).catch(() => {});
  const sit = await F(); await sleep(500); const sit2 = await F(); await tp("touchEnd", []);
  check("on the ground, touching the downward side of the lower pad makes the bird sit down (no walking)", sit.sitting && sit.mode === "landed" && Math.hypot(sit2.x - sit.x, sit2.z - sit.z) < 0.05, JSON.stringify({ sitting: sit.sitting, mode: sit.mode }));
  await tp("touchStart", [{ x: Math.round(up.cx), y: Math.round(up.cy + 20), id: 42 }]); await tp("touchMove", [{ x: Math.round(up.cx), y: Math.round(up.cy - 30), id: 42 }]); await sleep(1200);
  const stand = await F(); await tp("touchEnd", []);
  check("walking with the upper pad (stick forward) stands the bird up and walks, as before", !stand.sitting && Math.hypot(stand.x - sit.x, stand.z - sit.z) > 0.8, `moved ${Math.hypot(stand.x - sit.x, stand.z - sit.z).toFixed(2)} m`);
  // 中心の長押し: 短く飛んで微速前進
  await p.evaluate(() => { const g = __game, f = g.flight; f.reset(); g.input.releaseAll(); f.pos.set(28, 0.32, 60); f.prevPos.copy(f.pos); f.vel.set(0, 0, 0); f.mode = "landed"; f.walkV = 0; f.yaw = 0; });
  await sleep(300); await tp("touchStart", [{ x: cx, y: cy, id: 51 }]);
  await p.waitForFunction(() => __game.flight.mode === "air" && __game.flight.prox.on, null, { timeout: 8000 }).catch(() => {});
  const hop = await F(); await sleep(800); const hop2 = await F(); await tp("touchEnd", []);
  await p.waitForFunction(() => __game.flight.mode === "landed" && !__game.flight.prox.on, null, { timeout: 15000 }).catch(() => {});
  const land = await F();
  check("a long press on the center of the lower pad on the ground: a short flight with a slow forward creep, then a soft landing after lifting the finger", hop.mode === "air" && hop.y > 0.4 && hop.y < 4 && Math.hypot(hop2.x - hop.x, hop2.z - hop.z) > 0.8 && land.mode === "landed" && land.crashes === hop.crashes, JSON.stringify({ hopY: +hop.y.toFixed(2), landed: land.mode }));
  check("H1: no page errors", errs.length === 0, errs.join(" | "));
}

async function g9({ p, cdp, errs }) {
  console.log("\n# puddles and bird life (H3)");
  const goto = (x, z) => p.evaluate(([x, z]) => { const g = __game, f = g.flight; f.reset(); g.setAuto(false); g.input.releaseAll(); const y = g.world.heightAt(x, z) + 0.32; f.pos.set(x, y, z); f.prevPos.copy(f.pos); f.mode = "landed"; f.vel.set(0, 0, 0); g.cam.snap(); }, [x, z]);
  const pool = await p.evaluate(() => { const q = __game.puddles.list.find(q => q.perm); return { x: q.x, z: q.z, r: q.r }; });
  const vis = await p.evaluate(() => { const g = __game; g.puddles.wet = 0; g.puddleView.update(0.016, 0); const dry = g.puddleView.group.children.filter(c => c.visible && c.geometry.type === "CircleGeometry").length; g.puddles.wet = 1; g.puddleView.update(0.016, 0); const wet = g.puddleView.group.children.filter(c => c.visible && c.geometry.type === "CircleGeometry").length; g.puddles.wet = 0; g.puddleView.update(0.016, 0); return { dry, wet, perm: g.puddles.list.filter(q => q.perm).length, all: g.puddles.list.length }; });
  check("dry: only the park pool is drawn; after rain every puddle is drawn; dried again, back to the pool only", vis.dry === vis.perm && vis.wet === vis.all, JSON.stringify(vis));
  const lift = await p.evaluate(() => { const g = __game; let lo = 9, hi = -9; for (const m of g.puddleView.group.children) if (m.geometry.type === "CircleGeometry") { const q = g.puddles.list.find(z => Math.abs(z.x - m.position.x) < 1e-6 && Math.abs(z.z - m.position.z) < 1e-6); if (!q) continue; const d = m.position.y - g.world.heightAt(q.x, q.z); lo = Math.min(lo, d); hi = Math.max(hi, d); } const mt = g.puddleView.group.children[0].material; return { lo, hi, depthWrite: mt.depthWrite, po: mt.polygonOffset }; });
  check("puddles float a fixed small height above their ground (no sinking, no hovering) with depth write off and polygon offset on", lift.lo > 0.03 && lift.hi < 0.06 && !lift.depthWrite && lift.po, JSON.stringify(lift));
  await goto(pool.x + pool.r + 0.6, pool.z);
  await p.evaluate(() => { __game.life.wait = 0.2; __game.flight.sitting = true; }); // 座って休む
  const t0 = Date.now(); let by = {};
  while (Date.now() - t0 < 60000) { by = await p.evaluate(() => ({ ...__game.life.stats.byAct })); if (by.drink && by.bathe) break; await sleep(250); }
  check("resting beside the pool: the bird drinks and bathes by itself (no button)", !!by.drink && !!by.bathe, JSON.stringify(by));
  const was = await p.evaluate(async () => { const g = __game; for (let i = 0; i < 600 && g.life.act === "none"; i++) await new Promise(r => setTimeout(r, 30)); return g.life.act; });
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  await tp("touchStart", [{ x: 120, y: 250, id: 71 }]); await tp("touchMove", [{ x: 120, y: 190, id: 71 }]); await sleep(300);
  const now = await p.evaluate(() => ({ act: __game.life.act, sit: __game.flight.sitting })); await tp("touchEnd", []);
  check("a stick input cancels any life action at once and stands the bird up", was !== "none" && now.act === "none" && !now.sit, JSON.stringify({ was, now }));
  check("H3: no page errors", errs.length === 0, errs.join(" | "));
}

const GROUPS = [
  ["g1", g1, false], ["g2", g2, true], ["g3", g3, true], ["g4", g4, true], ["g5", g5, false], ["g6", g6, true], ["g7", g7, true], ["g8", g8, true], ["g9", g9, true],
];
// CIの5分割(各シャードの所要時間がほぼ等しくなるように)
const SHARD_PLAN = [["g1", "g3"], ["g2", "g5"], ["g4", "g8"], ["g6", "g9"], ["g7"]];

let want = GROUPS.map(g => g[0]);
const only = arg("--only"), shard = arg("--shard");
if (only) want = only.split(",");
if (shard) { const [i, n] = shard.split("/").map(Number); want = n === SHARD_PLAN.length ? SHARD_PLAN[i - 1] : want.filter((_, k) => k % n === i - 1); }

const srv = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await sleep(250); }
  const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  for (const [id, fn, start] of GROUPS) {
    if (!want.includes(id)) continue;
    const t0 = Date.now(), s = await open(b, start);
    try { await fn(s); } catch (e) { console.log(`  FAIL exception in ${id}`, e); fails++; }
    await s.ctx.close();
    console.log(`  (${id} ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  await b.close();
} catch (e) { console.log("  FAIL exception", e); fails++; }
finally { srv.kill(); }
console.log(fails ? `\n${fails} browser check(s) failed` : "\nbrowser checks passed");
process.exit(fails ? 1 : 0);
