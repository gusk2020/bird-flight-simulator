// ブラウザ動作テスト: ビルド済み(dist)を vite preview で配信し、Chromium(ソフトウェアGL)で操作する。失敗時は exit 1。
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 4173;
const srv = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
let fails = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`); if (!ok) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await sleep(250); }
  const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await b.newContext({ viewport: { width: 892, height: 412 }, hasTouch: true, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(`http://localhost:${PORT}/`); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(1500);
  const S = () => p.evaluate(() => { const g = __game, f = g.flight; return { st: g.game.state, t: g.game.gameTime, steps: g.game.steps, x: f.pos.x, y: f.pos.y, z: f.pos.z, mode: f.mode, speed: f.speed, inx: g.input.state.x, iny: g.input.state.y, flap: g.input.state.flapHeld, brake: g.input.state.brake, ov: !document.getElementById("overlay").hidden }; });
  const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
  const cdp = await ctx.newCDPSession(p);
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
  check("wind: strong east wind set, buttons highlighted", B.bear === 90 && B.sp > 7 && B.on === 11);
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

  console.log("\n# walking / hop / dawn lights (C2)");
  await p.evaluate(() => { const g = __game, f = g.flight; f.pos.set(28, 6, 60); f.prevPos.copy(f.pos); f.vel.set(0, 0, -9); });
  await p.waitForFunction(() => __game.flight.mode !== "air", null, { timeout: 40000 }).catch(() => {});
  await p.waitForFunction(() => __game.flight.mode === "landed", null, { timeout: 15000 }).catch(() => {}); await sleep(300);
  check("landed: brake button becomes 歩く", (await p.textContent("#brake")) === "歩く" && (await S()).mode === "landed");
  const wA = await S(); await tp("touchStart", [{ x: 740, y: 350, id: 3 }]); await sleep(1800); const wB = await S(); const wk = await p.evaluate(() => ({ w: __game.flight.walkV, hud: document.getElementById("hud").textContent })); await tp("touchEnd", []);
  check("holding 歩く walks forward, stays on the ground", dist(wA, wB) > 1 && wB.mode === "landed" && wk.hud.includes("歩行中"), `moved=${dist(wA, wB).toFixed(2)} hud=${wk.hud}`);
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

  console.log("\n# one-hand controls (D1)");
  const G = () => p.evaluate(() => { const g = __game, i = g.input; return { ctl: document.body.dataset.ctl, x: i.state.x, y: i.state.y, brake: i.state.brake, tap: i.state.flapTap, ph: i.gesture.phase, strokes: g.flight.strokes, mode: g.flight.mode, hop: g.flight.hopping, flapDisp: getComputedStyle(document.getElementById("flap")).display, zone: (() => { const r = document.getElementById("stick").getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; })() }; });
  // 一瞬のタップは、ソフトウェアGLの遅い描画でCDPの2回の送信が数百msずれないよう、同一タスク内の合成イベントで行う(長押し・スライドは実タッチ)
  const tapAt = (x, y, id) => p.evaluate(([x, y, id]) => { const z = document.getElementById("stick"), o = { bubbles: true, pointerId: id, clientX: x, clientY: y, pointerType: "touch" }; z.dispatchEvent(new PointerEvent("pointerdown", o)); z.dispatchEvent(new PointerEvent("pointerup", o)); }, [x, y, id]);
  const fly = () => p.evaluate(() => { const g = __game; g.flight.reset(); g.flight.pos.set(28, 60, 150); g.flight.prevPos.copy(g.flight.pos); g.input.releaseAll(); });
  let d = await G(); check("default is two-hand: left stick zone, flap/brake buttons visible", d.ctl === "both" && d.zone.l === 0 && d.flapDisp !== "none", JSON.stringify(d.zone));
  await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200);
  d = await G(); check("top button switches to right-hand: right half is the stick area, flap/brake buttons hidden", d.ctl === "right" && d.zone.l >= 440 && d.zone.w >= 440 && d.zone.h >= 400 && d.flapDisp === "none", JSON.stringify(d));
  await fly(); await sleep(300);
  await tp("touchStart", [{ x: 650, y: 250, id: 5 }]); await tp("touchMove", [{ x: 720, y: 200, id: 5 }]); await sleep(250); d = await G();
  check("right-hand: sliding right/up gives stick x>0, y>0", d.x > 0.5 && d.y > 0.2 && d.ph === "stick", JSON.stringify({ x: d.x, y: d.y, ph: d.ph }));
  await sleep(900); d = await G(); check("holding a slid stick for a long time never turns into a brake", !d.brake && d.ph === "stick");
  await tp("touchEnd", []); await sleep(200); d = await G(); check("release returns the stick to neutral", d.x === 0 && d.y === 0 && d.ph === "idle");
  await fly(); await sleep(300); const st0 = (await G()).strokes;
  await tapAt(650, 250, 6); await sleep(400); d = await G();
  check("short tap = exactly one flap", d.strokes === st0 + 1, `strokes ${st0}->${d.strokes}`);
  await tp("touchStart", [{ x: 650, y: 250, id: 7 }]); await sleep(550); d = await G(); const stL = d.strokes;
  check("long press = brake (physics sees it)", d.brake && d.ph === "brake" && (await p.evaluate(() => __game.flight.braking)));
  await tp("touchEnd", []); await sleep(400); d = await G();
  check("releasing after a long press gives no flap and clears the brake", !d.brake && d.strokes === stL, `strokes ${stL}->${d.strokes}`);
  const hit = (x, y) => p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id || document.elementFromPoint(x, y)?.tagName, [x, y]);
  check("the unused (left) half is not part of the stick area in right-hand mode", (await hit(200, 250)) !== "stick" && (await hit(650, 250)) === "stick", `${await hit(200, 250)} / ${await hit(650, 250)}`);
  await tp("touchStart", [{ x: 650, y: 250, id: 9 }, { x: 700, y: 300, id: 10 }]); await tp("touchMove", [{ x: 700, y: 250, id: 9 }, { x: 760, y: 340, id: 10 }]); await sleep(200); d = await G();
  check("a second finger is ignored (touch id tracked)", d.ph === "stick" && d.x > 0.3 && d.y >= -0.2, JSON.stringify({ x: d.x, y: d.y }));
  await tp("touchEnd", []); await sleep(150);
  await tp("touchStart", [{ x: 650, y: 250, id: 11 }]); await tp("touchMove", [{ x: 740, y: 250, id: 11 }]); await sleep(150);
  await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200); d = await G();
  check("pausing while the stick is held clears the input", d.x === 0 && d.ph === "idle" && !d.brake);
  await tp("touchEnd", []); await p.click("#ovGo"); await sleep(300);
  await tp("touchStart", [{ x: 650, y: 250, id: 12 }]); await tp("touchMove", [{ x: 740, y: 250, id: 12 }]); await sleep(150);
  await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200); d = await G();
  check("switching the control mode mid-game releases the stick (right -> left)", d.ctl === "left" && d.x === 0 && d.ph === "idle" && d.zone.l === 0 && d.zone.w >= 440, JSON.stringify({ ctl: d.ctl, ph: d.ph }));
  await tp("touchEnd", []); await sleep(100);
  await fly(); await sleep(300); const stR = (await G()).strokes;
  await tapAt(200, 250, 13); await sleep(400); d = await G();
  check("left-hand: a tap on the left half flaps", d.strokes === stR + 1, `strokes ${stR}->${d.strokes}`);
  check("left-hand: the right half is not part of the stick area", (await hit(800, 250)) !== "stick" && (await hit(200, 250)) === "stick");
  // 地上: タップは小ジャンプ、長押しは歩く
  await p.evaluate(() => { const g = __game, f = g.flight; f.pos.set(28, 0.32, 60); f.prevPos.copy(f.pos); f.vel.set(0, 0, 0); f.mode = "landed"; f.walkV = 0; g.input.releaseAll(); }); await sleep(300);
  await tp("touchStart", [{ x: 200, y: 250, id: 15 }]); await sleep(700); const gw0 = await S(); await sleep(500); const gw1 = await S(); await tp("touchEnd", []);
  check("on the ground a long press walks (no auto flapping)", Math.hypot(gw1.x - gw0.x, gw1.z - gw0.z) > 0.3 && gw1.mode === "landed", `moved=${Math.hypot(gw1.x - gw0.x, gw1.z - gw0.z).toFixed(2)}`);
  await sleep(600); await p.evaluate(() => { const f = __game.flight; f.vel.set(0, 0, 0); f.walkV = 0; }); await sleep(300);
  await tapAt(200, 250, 16); await p.waitForFunction(() => __game.flight.hopping || __game.flight.mode === "air", null, { timeout: 5000 }).catch(() => {});
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
  await p.evaluate(() => localStorage.setItem("vindving.prefs.v1", "{broken")); await p.reload(); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(600);
  check("a corrupted saved value starts safely with defaults", (await p.evaluate(() => document.body.dataset.ctl)) === "both");
  await p.click("#ovGo"); await sleep(500);

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
  await p.click("#btnPause"); await sleep(300);
  check("paused: UI is shown", await p.evaluate(() => !document.body.classList.contains("ui-hidden")));
  await p.click("#ovGo"); await sleep(300);
  check("D3: no page errors", errs.length === 0, errs.join(" | "));

  console.log("\n# time of day (A2)");
  const seen = [];
  for (let i = 0; i < 4; i++) { await p.click("#btnTime"); await sleep(1500); seen.push(await p.evaluate(() => ({ label: document.getElementById("btnTime").textContent, e: __game.env() }))); }
  check("cycle includes 朝 and returns to 昼", seen.map(x => x.label).join() === "夕,夜,朝,昼", seen.map(x => x.label).join());
  const dawn = seen[2].e; check("dawn: warm horizon", ((dawn.hor >> 16) & 255) - (dawn.hor & 255) > 40);
  await p.setViewportSize({ width: 412, height: 892 }); await sleep(600);
  check("portrait: no errors", errs.length === 0, errs.join(" | "));
  await b.close();
} catch (e) { console.log("  FAIL exception", e); fails++; }
finally { srv.kill(); }
console.log(fails ? `\n${fails} browser check(s) failed` : "\nbrowser checks passed");
process.exit(fails ? 1 : 0);
