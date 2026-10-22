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
  await p.click("#ovGo"); await sleep(300); const ra = await S();
  check("resume: runs again without teleport", ra.st === "running" && dist(pa, ra) < 6, `moved=${dist(pa, ra).toFixed(2)}m`);
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
  check("dive: camera distance stable", dive.maxD - dive.minD < 1.5, `${dive.minD.toFixed(1)}..${dive.maxD.toFixed(1)}`);
  check("dive: bird stays on screen", dive.maxNdc < 0.5 && dive.y < 150, `ndc=${dive.maxNdc.toFixed(2)} y=${dive.y.toFixed(0)}`);
  console.log(`  info draw calls=${dive.info.calls} triangles=${dive.info.tris} (software GL; not device FPS)`);

  console.log("\n# weather / wind / time settings (B)");
  await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200);
  await p.click('[data-set="weather"][data-val="rain"]'); await p.click('[data-set="wind"][data-val="2"]'); await p.click('[data-set="bearing"][data-val="90"]');
  let B = await p.evaluate(() => ({ rain: __game.rain.mesh.visible, lift: __game.flight.liftScale, fog: __game.scene.fog.far, bear: __game.wind.bearing, sp: __game.wind.speed, on: [...document.querySelectorAll("[data-set].on")].length }));
  check("rain: particles on, lift reduced, visibility shortened", B.rain && B.lift < 1 && B.fog < 500, JSON.stringify(B));
  check("wind: strong east wind set, buttons highlighted", B.bear === 90 && B.sp > 7 && B.on === 4);
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
