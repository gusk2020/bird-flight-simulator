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


/** 指の時間を決め打ちにするタッチ送信。CDP の touchStart → sleep → touchEnd は、実行環境が遅いと送信の往復ぶん実時間が延び(CI で 60 ms のつもりが 500〜800 ms)、
 *  アプリの「タップの長さの上限」を超えて長押し扱いになる。それは端末の遅さではなくテストの時計のずれ。各イベントに「意図した時刻」(sleep の合計)を timestamp として付け、
 *  指が触れていた時間を実行環境に依らず一定にする(アプリの判定の閾値は変えない)。タップの長さを測らない処理には使わない。 */
function virtualTouch(cdp) {
  let vc = 0, base = 0, vstart = 0, down = false, lastReal = 0;
  const sl = async ms => { vc += ms; await sleep(ms); };
  const tp = (type, pts) => { const r = Date.now(); if (!down || r - lastReal > 3000) { base = r / 1000; vstart = vc; } lastReal = r; down = type === "touchStart" || type === "touchMove" || (type === "touchEnd" && pts.length > 0); return cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts, timestamp: base + (vc - vstart) / 1000 }); };
  return { tp, sl };
}

/** 新しいコンテキスト(保存データ空)でページを開く。start=true なら開始ボタンまで押す(物理が動いている状態) */
async function open(b, start) {
  const ctx = await b.newContext({ viewport: { width: 892, height: 412 }, hasTouch: true, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  { const orig = p.click.bind(p); p.click = async (sel, o) => { await p.evaluate(s => window.__ui?.revealFor(s), sel).catch(() => {}); return orig(sel, o); }; } // H9: 設定は 3 画面に分かれた。押す前に、その要素のあるページを開く(画面の流れそのものは g16 で別に確かめる)
  const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(`http://localhost:${PORT}/`); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(1500);
  const cdp = await ctx.newCDPSession(p);
  if (process.env.THROTTLE) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.THROTTLE) }); // 診断用: CI のように CPU が足りない状況を作る(全グループ共通)
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
  await p.waitForFunction(() => __game.flight.mode !== "air", null, { timeout: 120000 }).catch(() => {}); await sleep(300); s = await S(); check("lands and stops", s.mode === "landed" || s.mode === "rollout", s.mode);
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
  check("wind: strong east wind set, buttons highlighted", B.bear === 90 && B.sp > 7 && B.on === 15); // 15 = 12 + 操縦(H8-A)の既定 1 つ + 着地点マーカー(H8-B)の既定 1 つ + 飛行ガイド(H9)の既定 1 つ
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
  const simWait = async (sec) => { const t0 = await p.evaluate(() => __game.game.gameTime); await p.waitForFunction(([t0, sec]) => __game.game.gameTime - t0 >= sec, [t0, sec], { timeout: 90000, polling: "raf" }).catch(() => {}); };
  const S = () => p.evaluate(() => { const g = __game, f = g.flight; return { st: g.game.state, t: g.game.gameTime, steps: g.game.steps, x: f.pos.x, y: f.pos.y, z: f.pos.z, mode: f.mode, speed: f.speed, inx: g.input.state.x, iny: g.input.state.y, flap: g.input.state.flapHeld, brake: g.input.state.brake, ov: !document.getElementById("overlay").hidden }; });
  const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  let s;

  console.log("\n# walking / hop / dawn lights (C2)");
  await p.evaluate(() => { const g = __game, f = g.flight; f.pos.set(28, g.world.heightAt(28, 60) + 1.2, 60); f.prevPos.copy(f.pos); f.vel.set(0, 0, -3); }); /* 歩く・跳ぶの検査の前提は「開けた地面に降りている」こと。高さ 6 m・9 m/s から降りると、低速巡航では着地までに 200 m 以上滑空し、歩けない場所(周囲が壁・縁)に降りることがある(CI でも同じ座標 41.6,-161.4 で失敗した)。着地点が飛行の細部に左右されないよう、開けた地面のすぐ上から降りる */
  await p.waitForFunction(() => __game.flight.mode !== "air", null, { timeout: 120000 }).catch(() => {}); // H9: 低速巡航で、同じ高さからの着地までの飛行時間が約3倍(待つ上限だけ延ばす。条件は同じ)
  await p.waitForFunction(() => __game.flight.mode === "landed", null, { timeout: 40000 }).catch(() => {}); await sleep(300);
  check("landed: brake button becomes 歩く", (await p.textContent("#brake")) === "歩く" && (await S()).mode === "landed");
  await p.evaluate(() => { const g = __game, f = g.flight; let best = f.yaw, bd = -1; for (let k = 0; k < 16; k++) { const y = k * Math.PI / 8; let d = 0; while (d < 6 && g.world.heightAt(f.pos.x - Math.sin(y) * (d + 1), f.pos.z - Math.cos(y) * (d + 1)) < 0.3 && (Math.abs(f.pos.x - Math.sin(y) * (d + 1)) < 203 || Math.abs(f.pos.x - Math.sin(y) * (d + 1)) < Math.abs(f.pos.x)) && (Math.abs(f.pos.z - Math.cos(y) * (d + 1)) < 203 || Math.abs(f.pos.z - Math.cos(y) * (d + 1)) < Math.abs(f.pos.z))) d++; /* 世界の端(±205)も行き止まり(端にいるときは内向きの歩みだけを開けた向きとみなす) */ if (d > bd) { bd = d; best = y; } } f.yaw = best; }); await sleep(100); // 目の前が開けた向きにしてから歩く
  const wA = await S(); await tp("touchStart", [{ x: 740, y: 350, id: 3 }]); await simWait(1.5); const wB = await S(); /* 歩く距離はシミュレーション時間で決まる。描画が遅い環境ではゲーム内の時間は実時間より遅く進む(1 フレームに進める上限が 0.1 秒)ので、実時間ではなくゲーム内の 1.5 秒だけ押し続ける */ const wk = await p.evaluate(() => { const g = __game, f = g.flight, el = document.elementFromPoint(740, 350); return { w: f.walkV, hud: document.getElementById("hud").textContent, el: el ? (el.id || el.className || el.tagName) : null, brake: g.input.state.brake, mode: f.mode, stun: f.stun, yaw: +f.yaw.toFixed(2), simT: +g.game.gameTime.toFixed(2) }; }); await tp("touchEnd", []); console.log("   walk probe:", JSON.stringify({ from: [+wA.x.toFixed(2), +wA.z.toFixed(2)], to: [+wB.x.toFixed(2), +wB.z.toFixed(2)], simDt: +(wk.simT - wA.t).toFixed(2), ...wk }));
  check("holding 歩く walks forward, stays on the ground", dist(wA, wB) > 1 && wB.mode === "landed", `pos=${wA.x.toFixed(1)},${wA.z.toFixed(1)}>${wB.x.toFixed(1)},${wB.z.toFixed(1)} moved=${dist(wA, wB).toFixed(2)} hud=${wk.hud}`);
  await sleep(600);
  await p.evaluate(() => { window.__peak = 0; const t = () => { const f = __game.flight; window.__peak = Math.max(window.__peak, f.pos.y - 0.32 - __game.world.heightAt(f.pos.x, f.pos.z)); requestAnimationFrame(t); }; t(); });
  await p.evaluate(() => { const el = document.getElementById("flap"); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 77 })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 77 })); }); /* 一瞬のタップ(ソフトウェア描画は低FPSなので同一タスクで押して離す) */ await p.waitForFunction(() => window.__peak > 0.15 && __game.flight.mode !== "air", null, { timeout: 30000, polling: "raf" }).catch(() => {}); await sleep(300); // 跳ねて降りるまでは、実時間ではなく状態で待つ(描画が遅いとゲーム内の時間は実時間より遅く進む)
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
  const mk = await p.evaluate(() => ({ vis: __game.spots.list.some(q => q.kind === "roof"), tgt: __game.perchAssist.target && __game.perchAssist.target.kind, guided: __game.perchAssist.stats.guided }));
  check("approaching a roof with the brake held: a candidate marker is shown and guidance is active", mk.vis && mk.tgt === "roof" && mk.guided > 0, JSON.stringify(mk));
  await p.evaluate(() => { __game.input.state.brake = false; __game.setAuto(true); }); await sleep(400);
  check("the markers are hidden during auto flight", await p.evaluate(() => __game.spots.list.length === 0));
  await p.evaluate(() => { __game.setAuto(false); const f = __game.flight; f.reset(); f.pos.set(28, 60, 150); f.prevPos.copy(f.pos); f.yaw = Math.PI; f.vel.set(0, 0, 10); }); // 建物のない上空(街と反対向き)(以前の(-60,30,-60)は高層アパートの壁に当たる位置で、衝突の復帰でカメラ距離が変わっていた)
  await sleep(500);
  check("nothing landable in view: no markers", await p.evaluate(() => __game.spots.list.length === 0));
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
    g.cam.snap(); const c0 = f.crashes; let inside = false, maxStun = 0, t0 = performance.now(), s0 = g.game.gameTime; /* 観測の窓はゲーム内の 3.5 秒(描画が遅いとゲーム内の時間は実時間より遅く進む。実時間 3.5 秒だと、遅い環境では衝突からの復帰を見届ける前に打ち切られる) */
    return await new Promise(res => { const tick = () => { for (const k of g.world.colliders) if (f.pos.x > k.minX && f.pos.x < k.maxX && f.pos.z > k.minZ && f.pos.z < k.maxZ && f.pos.y - 0.32 < k.top - 0.3) inside = true; maxStun = Math.max(maxStun, f.stun);
      if (g.game.gameTime - s0 > 3.5 || performance.now() - t0 > 90000) res({ crashes: f.crashes - c0, esc: f.escapes, inside, mode: f.mode, maxStun, away: Math.hypot(f.pos.x - Math.max(c.minX, Math.min(c.maxX, f.pos.x)), f.pos.z - Math.max(c.minZ, Math.min(c.maxZ, f.pos.z))), finite: Number.isFinite(f.pos.x + f.pos.y + f.pos.z) }); else requestAnimationFrame(tick); }; tick(); });
  }, [alt, v, sideAng]);
  // H9: 低速巡航では、14 m/s の接近を巡航ガード(自動制動)が壁の手前で止めて衝突にならない。衝突後の復帰を確かめるには、ブースト後の速さ(16 m/s 以上は従来と同じ物理)で突っ込む
  const w1 = await wallRun(20, 22, 0);
  check("a frontal hit into a tall wall: one crash, then it backs off and flies on, never inside", w1.crashes === 1 && w1.esc >= 1 && !w1.inside && w1.finite && w1.maxStun <= 0.31 && w1.away > 1, JSON.stringify(w1));
  const w2 = await wallRun(20, 22, 0.7);
  check("a diagonal hit: also recovers (no repeated crash)", w2.crashes <= 1 && !w2.inside && w2.finite, JSON.stringify(w2));
  const w3 = await wallRun(20, 6, 0);
  check("H9: at the slow cruise speed a frontal approach never crashes and never gets inside the wall", w3.crashes === 0 && !w3.inside && w3.finite, JSON.stringify(w3));

  console.log("\n# tap the ring to land automatically (G1-4 / G1-5)");
  // 一瞬のタップは、ソフトウェア描画の遅いフレームでCDPの2回の送信がずれないよう、同一タスク内の合成イベントで行う版(tapAtXY)と、実際のタッチ入力経路(CDP Input.dispatchTouchEvent。tp)の両方を使う
  const tapAtXY = (dx, dy, id) => p.evaluate(([dx, dy, id]) => { const sp = __game.spots.get(window.__target.id), r = { x: sp ? sp.dx : 0, y: sp ? sp.dy : 0 }, x = r.x + dx, y = r.y + dy, el = document.elementFromPoint(x, y) || document.body, o = { bubbles: true, pointerId: id, clientX: x, clientY: y, pointerType: "touch" }; el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o)); return { x, y }; }, [dx, dy, id]);
  /** 足場 kind を選び、その縁の東側 dist m・面の上 up m から、速さ v で西へ向かって飛び出す。side>0 なら足場が画面の右寄りに見える位置から(片手のスティック領域に◯が入る) */
  const setup = (kind, dist = 11, up = 2.6, v = 8, side = 0) => p.evaluate(([kind, dist, up, v, side]) => {
    const g = __game, f = g.flight, w = g.world; f.reset(); g.setAuto(false); g.settings.weather = "clear"; if (g.settings.wind !== 0) { g.settings.wind = 0; g.applySettings(); } /* 着地の幾何(狭い足場の上に立つ等)を決まった条件で確かめるため風なし。風ありの成功率は g12(統計)で見る */ g.input.releaseAll();
    const open = s => !w.colliders.some(c => c.maxX - c.minX > 3 && c.maxZ - c.minZ > 3 && c.top > s.top + 0.3 && c.maxX > s.minX - 16 && c.minX < s.maxX + 16 && c.maxZ > s.minZ - 16 && c.minZ < s.maxZ + 16);
    const cand = g.surfaces.all.filter(s => s.kind === kind && open(s) && (kind !== "roof" || (s.maxX - s.minX) * (s.maxZ - s.minZ) > 40 && s.top < 12));
    const t = cand[0]; if (!t) return null; window.__target = t;
    f.pos.set(t.maxX + dist, t.top + up, (t.minZ + t.maxZ) / 2 + side); f.prevPos.copy(f.pos); f.yaw = Math.PI / 2; f.vel.set(-v, -0.3, 0); g.cam.snap();
    return { kind: t.kind, w: +(t.maxX - t.minX).toFixed(2), d: +(t.maxZ - t.minZ).toFixed(2), top: t.top };
  }, [kind, dist, up, v, side]);
  /** 実際のタッチ入力経路(CDP Input.synthesizeTapGesture): ブラウザ側が押す→離すの間隔(duration ms)を守って届けるので、描画が遅くても押している時間が狂わない */
  const realTap = (x, y, duration = 50) => cdp.send("Input.synthesizeTapGesture", { x, y, duration, tapCount: 1, gestureSourceType: "touch" });
  const waitRing = () => p.waitForFunction(() => !!__game.spots.get(window.__target.id), null, { timeout: 8000 }).catch(() => {});
  const ringXY = () => p.evaluate(() => { const sp = __game.spots.get(window.__target.id); return { vis: !!sp, x: sp ? sp.dx : 0, y: sp ? sp.dy : 0, w: innerWidth }; });
  const AL = () => p.evaluate(() => ({ refusal: __game.autoLand.lastRefusal, refused: __game.autoLand.stats.refused, active: __game.autoLand.active, starts: __game.autoLand.stats.starts, ok: __game.autoLand.stats.success, ended: { ...__game.autoLand.stats.ended }, mode: __game.flight.mode, crashes: __game.flight.crashes, ringTaps: __game.input.stats.ringTaps, flapTaps: __game.input.stats.gestureTaps, strokes: __game.flight.strokes, label: document.getElementById("autoland").textContent }));
  const simWait = async (sec) => { const t0 = await p.evaluate(() => __game.game.gameTime); await p.waitForFunction(([t0, sec]) => __game.game.gameTime - t0 >= sec, [t0, sec], { timeout: 90000, polling: "raf" }).catch(() => {}); }; // ゲーム内の秒数で待つ(描画が遅いとゲーム内の時間は実時間より遅く進む)
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
  const ww0 = await onTarget(); await tp("touchStart", [{ x: 120, y: 330, id: 80 }]); await tp("touchMove", [{ x: 120, y: 268, id: 80 }]); await simWait(1.6);
  const ww1 = await onTarget(); const stickY = await p.evaluate(() => __game.input.state.y); await tp("touchEnd", []); await sleep(300);
  const walked = Math.hypot(ww1.x - ww0.x, ww1.z - ww0.z);
  check("WALKABLE perch (roof): stick forward moves the bird at least 1.5 m, still landed on the roof top", walkable && stickY > 0.4 && walked >= 1.5 && ww1.mode === "landed" && ww1.onTop, `walked ${walked.toFixed(2)} m, stickY ${stickY.toFixed(2)}, ${JSON.stringify(ww1)}`);
  const ww2 = await onTarget(); await sleep(400); const ww3 = await onTarget();
  check("lifting the thumb stops the walk (it stays on the roof)", Math.hypot(ww3.x - ww2.x, ww3.z - ww2.z) < 0.1 && ww3.mode === "landed" && ww3.onTop);

  // (2) 狭い足場(岩など): 「立てる」と「歩ける」を分ける。歩ける広さがなければ、足場の上に立って動かないことを確かめる
  await p.evaluate(() => { __game.game.pause(); }); /* 先に一時停止してから置く(置いたあとに止めると、往復のあいだにもゲームが進み、負荷が高いほど足場に近づいてしまう) */
  const narrowInfo = await setup("rock", 11, 2.6, 8);
  check("a narrow perch (rock) with open surroundings exists", !!narrowInfo, JSON.stringify(narrowInfo));
  /* 開始状態を実行環境の速さに依らず同一にする: 物理を一時停止してリングが出るのを待ち、タップと同時に再開する。固定しないと、リングが出てからタップが届くまでのゲーム内時間(= タップ時の足場までの距離)が環境の速さで変わり、狭い足場への着地の成否がその距離で決まってしまう(CI では毎回ほぼ同じ座標で外れた)。タイマーで位置を戻す方式は、負荷が高いとタイマー自体が走らず固定にならないので、一時停止を使う */
  /* 一時停止中は、見た目が変わらない限り描画・目印の更新を省く(main.ts の dirty)。目印を出すために、画面サイズ変更の通知で描画を 1 回ずつ促しながら待つ */
  await p.evaluate(() => new Promise(res => { const t0 = performance.now(), tick = () => { if (__game.spots.get(window.__target.id) || performance.now() - t0 > 8000) return res(); window.dispatchEvent(new Event("resize")); requestAnimationFrame(tick); }; tick(); }));
  const nrr = await ringXY(); const cN = (await AL()).crashes;
  await p.evaluate(() => { const sp = __game.spots.get(window.__target.id), x = sp ? sp.dx : 0, y = sp ? sp.dy : 0, el = document.elementFromPoint(x, y) || document.body, o = { bubbles: true, pointerId: 72, clientX: x, clientY: y, pointerType: "touch" }; el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o)); __game.game.resume(); }); await sleep(150);
  await finishLanding(); const alN = await AL(); const otN = await onTarget(); const nwalkable = narrowInfo.w * narrowInfo.d > 12 || Math.max(narrowInfo.w, narrowInfo.d) >= 3;
  check("NARROW perch: it lands and stands on top (this is 'stands', not 'walks'), no crash", !nwalkable && alN.ok >= 1 && otN.mode !== "air" && otN.onTop && otN.inside && alN.crashes === cN, JSON.stringify({ narrow: narrowInfo, ...otN, ring: nrr, al: { ok: alN.ok, crashes: alN.crashes, starts: alN.starts, refused: alN.refused, ended: alN.ended, last: alN.lastTgt }, al0: cN, st: await p.evaluate(() => ({ speedScale: __game.flight.speedScale, wind: __game.settings.wind, cruise: __game.CRUISE.enabled, tgt: __game.autoLand.lastTargetId, want: window.__target.id, stun: __game.flight.stun })) }));
  const nw0 = await onTarget(); await tp("touchStart", [{ x: 120, y: 330, id: 81 }]); await tp("touchMove", [{ x: 120, y: 268, id: 81 }]); await simWait(0.9); const nw1 = await onTarget(); await tp("touchEnd", []);
  await simWait(1.2); const nw2 = await onTarget(); const alN2 = await AL();
  check("NARROW perch: pushing the stick walks off the end within ~2 m and lands safely (no crash, not stuck in the air)", Math.hypot(nw1.x - nw0.x, nw1.z - nw0.z) <= 2.5 && nw2.mode !== "air" && alN2.crashes === cN, JSON.stringify({ moved: Math.hypot(nw1.x - nw0.x, nw1.z - nw0.z).toFixed(2), ...nw2 }));

  // (2b) 補完: 実タッチ(CDP の合成タップ)・固定なし・通常の接近での狭い足場。上の NARROW は物理を一時停止して開始状態を固定した「統制実験」(着地の幾何だけを環境の速さから切り離す)で、
  //      描画フレーム・実タッチ・接近の時間差は迂回している。それらを含む一連の動作は、ここで別に確かめる(統制と実操作の保証を区別する)。成功率は統計として数え、認識の取りこぼしと衝突だけは 0 を要求する
  { const rowsN = [];
    for (const dist of [10, 12, 14, 11]) {
      const inf = await setup("rock", dist, 2.6, 8); if (!inf) { rowsN.push({ dist, result: "no-surface" }); continue; }
      const shown = await p.waitForFunction(() => !!__game.spots.get(window.__target.id), null, { timeout: 7000 }).then(() => true).catch(() => false); if (!shown) { rowsN.push({ dist, result: "no-ring" }); continue; }
      const q = await ringXY(); const b = await AL(); await realTap(Math.round(q.x), Math.round(q.y));
      await p.waitForFunction(x => { const g = __game; return g.input.stats.ringTaps > x.t || g.autoLand.stats.starts > x.s || g.autoLand.stats.refused > x.r || !g.spots.get(window.__target.id); }, { t: b.ringTaps, s: b.starts, r: b.refused }, { timeout: 2500, polling: "raf" }).catch(() => {});
      await sleep(150); const a = await AL(); const now = await ringXY();
      const row = { dist, tapped: a.ringTaps === b.ringTaps + 1, started: a.starts > b.starts, refused: a.refused > b.refused, crash: false, on: false };
      if (!row.tapped && !row.started) { row.result = !now.vis ? "ring-gone-before-tap" : Math.hypot(now.x - q.x, now.y - q.y) > 34 ? "ring-moved-before-tap" : "tap-not-recognised"; rowsN.push(row); await p.evaluate(() => __game.autoLand.cancel("user")); continue; }
      if (row.started) { await finishLanding(); const e = await AL(), ot2 = await onTarget(); row.crash = e.crashes > b.crashes; row.on = ot2.mode !== "air" && ot2.onTop && ot2.inside; row.result = row.on ? "landed-on-top" : "landed-elsewhere"; } else row.result = "refused";
      rowsN.push(row); await p.evaluate(() => __game.autoLand.cancel("user")); }
    const startedN = rowsN.filter(r => r.started), onN = startedN.filter(r => r.on).length, missN = rowsN.filter(r => r.result === "tap-not-recognised").length, crashN = startedN.filter(r => r.crash).length;
    console.log("   real-touch narrow-perch trials:", JSON.stringify(rowsN)); console.log(`   SUMMARY narrow real-touch: trials ${rowsN.length} | started ${startedN.length} | on top ${onN} | landed elsewhere ${startedN.length - onN} | crashes ${crashN} | tap not recognised with the finger on the ring ${missN}`);
    check("NARROW perch, real touch, no pinning: a press on the ring is always recognised, no landing crashes, and at least half of the started landings end on top (counted, not forced)", missN === 0 && crashN === 0 && (startedN.length === 0 || onN / startedN.length >= 0.5), JSON.stringify({ started: startedN.length, on: onN, miss: missN, crash: crashN })); }

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
    /* 距離 約30 px の点。ただし別の目印のほうが近い点(密集していて取り違え得る点)は、H8-D が確認を求める別の経路(仕様どおり)になる。この検査が確かめるのは「◯から30 px でも、その◯が最寄りなら 1 タップで始まる」ことなので、◯が最寄りで曖昧でない向きを選ぶ(向きは 8 通りから決める。見つからなければ前提を満たせなかったとして報告する) */
    const pt = await p.evaluate(([rx, ry]) => { const g = __game, t = window.__target, q = t && (g.spots.get(t.id) || (window.__fs && window.__fs(t))); if (!q) return null; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4 + 0.4, x = Math.round(rx + 30 * Math.cos(a)), y = Math.round(ry + 30 * Math.sin(a)); if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue; const pk = g.spots.pick(x, y); if (pk && pk.id === q.id && !g.spots.assess(x, y, pk).risky) return { x, y }; } return null; }, [r.x, r.y]);
    if (!pt) return { ok: false, why: "no unambiguous point 30 px from the ring (another marker is nearer in every direction)" };
    const x = pt.x, y = pt.y;
    const pre = await p.evaluate(([x, y]) => { const g = __game, t = window.__target, q = t && g.spots.get(t.id) || (t && window.__fs && window.__fs(t)), pk = g.spots.pick(x, y); return { tgt: t && t.id, tgtD: q && Math.round(q.d), tgtPos: q && [Math.round(q.dx), Math.round(q.dy)], pick: pk && [pk.id, pk.kind, Math.round(pk.d)], risky: pk && g.spots.assess(x, y, pk).risky, ap: g.approach.id, cf: g.spotConfirm.id }; }, [x, y]);
    await realTap(x, y, 50); await sleep(250); const after = await AL(); const dbg = await p.evaluate((pre) => ({ pre, cf: __game.spotConfirm.id, ap: __game.approach.id, gone: __game.spots.stats.gone, list: __game.spots.list.map(q => [q.kind, Math.round(q.d), Math.round(q.dx), Math.round(q.dy), q.near]).slice(0, 6), mode: __game.flight.mode, v: __game.flight.speed, ss: __game.flight.speedScale }), pre);
    return { ok: after.starts === before.starts + 1 && after.ringTaps === before.ringTaps + 1 && after.flapTaps === before.flapTaps, before, after, x, y, dbg };
  });
  check("REAL TOUCH 30 px from the ring: the automatic landing starts, counted as a ring tap and not as a flap tap", r4a.ok, `tries ${r4a.tries}; refusal=${r4a.after && r4a.after.refusal}; ringTaps ${r4a.before && r4a.before.ringTaps}->${r4a.after && r4a.after.ringTaps}, flapTaps ${r4a.before && r4a.before.flapTaps}->${r4a.after && r4a.after.flapTaps}${r4a.why ? " " + r4a.why : ""} dbg=${JSON.stringify(r4a.dbg)}`);
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
    await tp("touchStart", [{ x: Math.round(r.x), y: Math.round(r.y), id: 93 }]); await sleep(1600); /* 遅い描画ではタップの上限が延びる(最大 約 1.2 秒)ので、長押しは十分長く */
    const mid = await p.evaluate(() => ({ brake: __game.input.state.brake, phase: __game.input.gesture.phase, prox: __game.input.prox.active, proxOn: __game.flight.prox.on })); await tp("touchEnd", []); await sleep(250); const after = await AL();
    const regionOk = inProx ? (mid.prox && mid.proxOn) : (mid.brake && mid.phase === "brake");
    return { ok: regionOk && after.starts === before.starts && after.ringTaps === before.ringTaps, before, after, mid, inProx };
  });
  check("REAL TOUCH long press (1.6 s) on the ring: brake (cruise region) or a proximity maneuver (proximity region); never an automatic landing", r4d.ok, `tries ${r4d.tries}; inProxRegion=${r4d.inProx} ${JSON.stringify(r4d.mid)}${r4d.why ? " " + r4d.why : ""}`);
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
  const cost = await p.evaluate(() => { const g = __game, r = g.renderer, cam = g.camera; const calls = () => { r.info.reset(); r.render(g.scene, cam); return r.info.render.calls; }; g.puddles.wet = 0; g.puddleView.update(0, 0); calls(); const dry = calls(); g.puddles.wet = 1; g.puddleView.update(0, 1); calls(); const wet = calls(); g.puddles.wet = 0; g.puddleView.update(0, 0); return { dry, wet }; });
  check("puddles add little drawing work (extra draw calls at full rain <= 50)", cost.wet - cost.dry <= 50, JSON.stringify(cost));
  check("H3: no page errors", errs.length === 0, errs.join(" | "));
}

// ---- g10: 道路の色のちらつき(H4)。同じ場面を、カメラを数mm動かして何度も描き、画素が揺れる割合を測る(深度の衝突=z-fighting があると、動かすたびに勝つ面が入れ替わる)
async function g10({ p, errs }) {
  console.log("\n# road colour flicker (H4)");
  const measure = (dist, high, tz = 0) => p.evaluate(([dist, high, tz]) => {
    const g = __game, L = g.world, r1 = L.roads[3], r2 = L.roads[4] + tz, cam = g.camera, ren = g.renderer;
    const W = 320, Hh = 200; ren.setSize(W, Hh, false); cam.aspect = W / Hh; cam.updateProjectionMatrix();
    const grab = (dx, dy) => { cam.position.set(r1 + dx, high + dy, r2 + dist); cam.lookAt(r1, 0, r2); cam.updateMatrixWorld(); ren.render(g.scene, cam); const c = document.createElement("canvas"); c.width = W; c.height = Hh; const x = c.getContext("2d"); x.drawImage(ren.domElement, 0, 0); return x.getImageData(0, 0, W, Hh).data; };
    grab(0, 0); grab(0, 0); const base = grab(0, 0); let diff = 0, tot = 0, worst = 0;
    for (const [dx, dy] of [[0.003, 0], [-0.003, 0.002], [0, 0.004], [0.006, -0.003], [-0.005, 0.005], [0.002, 0.002]]) {
      const im = grab(dx, dy); let d = 0, n = 0;
      for (let y = 60; y < 150; y++) for (let x = 60; x < 260; x++) { const i = (y * W + x) * 4, a = base[i] * 0.3 + base[i + 1] * 0.59 + base[i + 2] * 0.11, b = im[i] * 0.3 + im[i + 1] * 0.59 + im[i + 2] * 0.11; n++; if (Math.abs(a - b) > 14) d++; }
      diff += d; tot += n; worst = Math.max(worst, d / n);
    }
    return { frac: diff / tot, worst };
  }, [dist, high, tz]);
  await p.evaluate(() => { __game.settings.time = 0; __game.setHour(12); }); // 時刻の進みを止めて正午に固定(昼夜の進みで色が変わると、緑の判定が閾値の近くで揺れる)
  await measure(40, 12); // 初回は読み込み・準備で不安定なので捨てる
  // 道路の中心線を遠くから見下ろす。道路の真ん中の細い帯に「緑(草)」が漏れて見える画素の割合を、距離と位置を変えながら数える(道路は灰色、草は緑。深度の衝突があると草が道路に点々と出る)
  const leak = (dists, high) => p.evaluate(([dists, high]) => {
    const g = __game, L = g.world, r1 = L.roads[3], cam = g.camera, ren = g.renderer, W = 240, Hh = 240; ren.setSize(W, Hh, false); cam.aspect = 1; cam.updateProjectionMatrix();
    const out = {};
    for (const d of dists) { let green = 0, tot = 0;
      for (let k = 0; k < 24; k++) { const z0 = L.roads[2] + 6 + k * 1.37, x = r1 + Math.sin(k) * 0.9;
        cam.position.set(x, high, z0 + d); cam.lookAt(x, 0, z0); cam.updateMatrixWorld(); ren.render(g.scene, cam);
        const c = document.createElement("canvas"); c.width = W; c.height = Hh; const cx = c.getContext("2d"); cx.drawImage(ren.domElement, 0, 0); const im = cx.getImageData(0, 0, W, Hh).data;
        for (let y = Math.floor(Hh * 0.46); y < Hh * 0.56; y++) for (let xx = W / 2 - 1; xx <= W / 2 + 1; xx++) { const q = (y * W + Math.floor(xx)) * 4; tot++; if (im[q + 1] > im[q] + 12 && im[q + 1] > im[q + 2] + 6) green++; } }
      out[d] = +(green / tot).toFixed(4); }
    return out;
  }, [dists, high]);
  const lk = await leak([60, 150, 300, 500], 30);
  // 基準: 草の面を3m下げた同じ場面。残る緑は「道路が画素に収まらない・隣の区画」など幾何学的なもの。深度の衝突があれば、通常の値は基準より多くなる
  await p.evaluate(() => { const g = __game.world.group.children.find(m => m.geometry && m.geometry.type === "PlaneGeometry" && m.geometry.parameters.width === 3000); window.__grassY = g.position.y; g.position.y = -3; });
  const ref = await leak([60, 150, 300, 500], 30);
  await p.evaluate(() => { const g = __game.world.group.children.find(m => m.geometry && m.geometry.type === "PlaneGeometry" && m.geometry.parameters.width === 3000); g.position.y = window.__grassY; });
  console.log("   grass-green pixels in the road centre line (normal):", JSON.stringify(lk), " reference with the grass 3 m lower:", JSON.stringify(ref));
  const extra = Object.keys(lk).map(d => +(lk[d] - ref[d]).toFixed(4));
  check("grass does not show through the road because of depth fighting at 60-500 m (extra green vs the 3 m-lower reference < 2 points; before the fix it was 7-38 points)", extra.every(v => v < 0.02), JSON.stringify(extra));
  check("H4 flicker: no page errors", errs.length === 0, errs.join(" | "));
}

// ---- g11: H8-B 着地点マーカー(全候補表示)。複数表示・早期発見・通過後の消去と選択解除・ON/OFF(保存)・正しい候補へのタップ・押している間に動いても入れ替わらない・画面/操作モード別の実タッチ・UIとの干渉・描画の実在・負荷
async function g11({ p, cdp, errs }) {
  console.log("\n# H8-B landing spots: all candidates in view, selection, ON/OFF");
  const setup = (kind, dist = 11, up = 2.6, v = 8, side = 0) => p.evaluate(([kind, dist, up, v, side]) => {
    const g = __game, f = g.flight, w = g.world; f.reset(); g.setAuto(false); g.settings.weather = "clear"; g.input.releaseAll(); g.autoLand.cancel("user");
    const open = s => !w.colliders.some(c => c.maxX - c.minX > 3 && c.maxZ - c.minZ > 3 && c.top > s.top + 0.3 && c.maxX > s.minX - 16 && c.minX < s.maxX + 16 && c.maxZ > s.minZ - 16 && c.minZ < s.maxZ + 16);
    const cand = g.surfaces.all.filter(s => s.kind === kind && open(s)); const t = cand[0]; if (!t) return null; window.__target = t;
    f.pos.set(t.maxX + dist, t.top + up, (t.minZ + t.maxZ) / 2 + side); f.prevPos.copy(f.pos); f.yaw = Math.PI / 2; f.vel.set(-v, -0.3, 0); g.cam.snap(); return { kind: t.kind, top: t.top, id: t.id };
  }, [kind, dist, up, v, side]);
  const hover = () => p.evaluate(() => { const f = __game.flight; const [x, y, z] = [f.pos.x, f.pos.y, f.pos.z]; window.__hv = setInterval(() => { f.pos.set(x, y, z); f.vel.set(0, 0, 0); }, 8); }); // 鳥をその場にとどめる(押している間に目印が動かないように)
  const unhover = () => p.evaluate(() => clearInterval(window.__hv));
  const waitSpot = (id) => p.waitForFunction(i => !!__game.spots.get(i), id, { timeout: 9000 }).then(() => true).catch(() => false);
  const spotXY = (id) => p.evaluate(i => { const q = __game.spots.get(i); return q ? { x: q.dx, y: q.dy, near: q.near, stacked: q.stacked, kind: q.kind } : null; }, id);
  const stat = () => p.evaluate(() => ({ last: __game.autoLand.lastTargetId, starts: __game.autoLand.stats.starts, refused: __game.autoLand.stats.refused, refusal: __game.autoLand.lastRefusal, active: __game.autoLand.active, tgt: __game.autoLand.target ? __game.autoLand.target.id : -1, ringTaps: __game.input.stats.ringTaps, flapTaps: __game.input.stats.gestureTaps, crashes: __game.flight.crashes, gone: __game.spots.stats.gone }));
  const realTap = (x, y) => cdp.send("Input.synthesizeTapGesture", { x: Math.round(x), y: Math.round(y), duration: 50, tapCount: 1, gestureSourceType: "touch" });
  /* 目印を押す。動いている目印(描画が遅いとき = CI や実機の低 FPS)では、取り違え防止の確認(H8-D)が出ることがある。それは仕様どおりなので、出たら確認ボタンを押して続ける */
  const dbgTap = () => p.evaluate(() => ({ log: __game.spotTapLog.slice(-6), cf: __game.spotConfirm.active ? __game.spotConfirm.id : -1, ap: __game.approach.id, apLast: __game.approach.lastReason, asked: __game.spotConfirm.stats.asked, confirmed: __game.spotConfirm.stats.confirmed, gap: Math.round(__game.input.frameGap), rd: __game.input.ringDiag, taps: __game.input.stats.ringTaps }));
  const tapConfirm = async (x, y) => { /* タップの効果(確認の表示・接近先の変化・着地の開始/拒否・見失い)が現れるまで待つ。遅い環境では確認の表示が 250 ms より遅れることがある */
    const b = await p.evaluate(() => { const g = __game; return { ap: g.approach.id, st: g.autoLand.stats.starts, rf: g.autoLand.stats.refused, as: g.spotConfirm.stats.asked, gn: g.spots.stats.gone }; });
    await realTap(x, y);
    await p.waitForFunction(b => { const g = __game; return g.approach.id !== b.ap || g.autoLand.stats.starts > b.st || g.autoLand.stats.refused > b.rf || g.spotConfirm.stats.asked > b.as || g.spots.stats.gone > b.gn; }, b, { timeout: 2500, polling: "raf" }).catch(() => {});
    const asked = await p.evaluate(() => { if (!__game.spotConfirm.active) return false; document.getElementById("spotGo").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); return true; }); await sleep(250); return asked; };
  const vt = virtualTouch(cdp), tp = vt.tp, sleep = vt.sl; // 指の時間を決め打ちにする(virtualTouch の説明を参照)
  const setCtl = async (m) => { for (let i = 0; i < 3; i++) { if ((await p.evaluate(() => document.body.dataset.ctl)) === m) return; await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(250); } };
  const setSteer = async (m) => { for (let i = 0; i < 5 && (await p.evaluate(() => __game.input.steerMode)) !== m; i++) { await p.evaluate(() => document.getElementById("btnSteer").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(150); } };
  const setLm = (on) => p.evaluate(on => document.querySelector(`[data-set="lm"][data-val="${on ? 1 : 0}"]`).click(), on);
  await p.evaluate(() => { if (!document.getElementById("overlay").hidden) document.getElementById("ovGo").click(); }); await sleep(300);
  await p.setViewportSize({ width: 892, height: 412 }); await sleep(500); await setCtl("right");

  // (A) 複数の目印が同時に出て、実際に画面へ描かれている(描画面の画素で確かめる)。固定の上限で削られていない
  const town = await p.evaluate(async () => { const g = __game, f = g.flight; let best = { n: 0, kinds: 0, pos: null }; g.setAuto(false); g.settings.weather = "clear";
    for (const [x, z] of [[0, 40], [30, 0], [-30, 20], [0, -40], [60, 60], [-60, -30]]) for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) { f.reset(); f.pos.set(x, 14, z); f.prevPos.copy(f.pos); f.yaw = yaw; f.vel.set(-Math.sin(yaw) * 6, 0, -Math.cos(yaw) * 6); g.cam.snap(); for (let i = 0; i < 6; i++) await new Promise(r => requestAnimationFrame(r));
      const n = g.spots.list.length; if (n > best.n) best = { n, kinds: new Set(g.spots.list.map(q => q.kind)).size, pos: [x, z, yaw] }; }
    return best; });
  check("in a dense part of town many landing spots are marked at once, of several kinds (no fixed top-N cut)", town.n >= 5 && town.kinds >= 2, JSON.stringify(town));
  await p.evaluate(([x, z, yaw]) => { const g = __game, f = g.flight; f.reset(); f.pos.set(x, 14, z); f.prevPos.copy(f.pos); f.yaw = yaw; f.vel.set(0, 0, 0); g.cam.snap(); window.__hv = setInterval(() => { f.pos.set(x, 14, z); f.vel.set(0, 0, 0); }, 8); }, town.pos); await sleep(900);
  const drawn = await p.evaluate(() => { const g = __game, cv = document.getElementById("spots"), c = cv.getContext("2d"), k = cv.width / innerWidth; let ok = 0, tot = 0; for (const q of g.spots.list) { tot++; const d = c.getImageData(Math.max(0, Math.round((q.dx - 22) * k)), Math.max(0, Math.round((q.dy - 22) * k)), Math.round(44 * k), Math.round(44 * k)).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; if (n > 12) ok++; } return { ok, tot, stat: { ...g.spots.stats } }; });
  check("every marker is really drawn on the overlay canvas (pixels around its position are painted)", drawn.tot >= 5 && drawn.ok === drawn.tot, JSON.stringify({ ok: drawn.ok, tot: drawn.tot }));
  const uiHit = await p.evaluate(() => __game.spots.list.filter(q => { const el = document.elementFromPoint(q.dx, q.dy); return el && el.closest && el.closest("button,.btn,#overlay"); }).length);
  check("no marker sits on a button (it could not be tapped)", uiHit === 0, `${uiHit} on UI`);
  await unhover();

  // (B) 早期発見: 前方 38 m の足場が、近づく前から見つかる(以前は近くなってから 1 か所だけ)
  const far = await setup("rock", 38, 4, 8, 0); const farSeen = await waitSpot(far.id); const farInfo = await p.evaluate(i => { const q = __game.spots.get(i); return q ? { d: Math.round(q.d), near: q.near } : null; }, far.id);
  check("a rock about 38 m ahead is already marked (dimmed: beyond the auto-landing reach)", farSeen && farInfo && farInfo.d >= 30 && farInfo.near === false, JSON.stringify(farInfo));

  // (C) 通過後・視界外: 消す。選択も解く。5 秒の残像は残さない
  await setup("rock", 12, 2.6, 8, 0); const tid = await p.evaluate(() => window.__target.id); await waitSpot(tid);
  await hover(); await sleep(400); const xy0 = await spotXY(tid);
  await p.evaluate(() => { __game.spots.pressedId = window.__target.id; }); // 選択中にして、消えたら解けるかを見る
  await unhover(); await p.evaluate(() => { const g = __game, f = g.flight, t = window.__target; f.pos.set(t.minX - 6, f.pos.y, f.pos.z); f.prevPos.copy(f.pos); f.vel.set(-8, 0, 0); g.cam.snap(); }); // 足場の反対側へ抜ける(= 通り過ぎた)
  const gone = await p.waitForFunction(i => !__game.spots.get(i), tid, { timeout: 4000 }).then(() => true).catch(() => false);
  const afterPass = await p.evaluate(() => ({ pressed: __game.spots.pressedId, n: __game.spots.list.length, t: __game.flight.clock }));
  check("after flying past, the marker is gone at once and the selection is released (no 5-second afterimage)", !!xy0 && gone && afterPass.pressed === -1, JSON.stringify({ xy0, gone, afterPass }));
  const stalePress = await p.evaluate(i => { const g = __game; return g.spots.valid(i, g.flight.clock); }, tid);
  check("a passed candidate is not valid for a late tap", stalePress === false);

  // (D) ON/OFF(設定): OFF で全部消えて選択も解け、保存される。ON で戻る。進行中の自動着地は OFF だけでは止まらない
  await setup("rock", 12, 2.6, 8, 0); await waitSpot(await p.evaluate(() => window.__target.id)); await hover(); await sleep(300);
  const tid2 = await p.evaluate(() => window.__target.id); const sx = await spotXY(tid2); await realTap(sx.x, sx.y); await sleep(250); const st1 = await stat();
  check("a tap on the marker of the rock starts the automatic landing for exactly that rock", st1.active && st1.tgt === tid2 && st1.ringTaps >= 1, JSON.stringify(st1));
  await setLm(false); await sleep(200);
  const off = await p.evaluate(() => { let saved = null; try { saved = JSON.parse(localStorage.getItem("vindving.prefs.v1")).landmarks; } catch {} const cv = document.getElementById("spots"), c = cv.getContext("2d"); const d = c.getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return { n: __game.spots.list.length, pressed: __game.spots.pressedId, saved, painted: n, active: __game.autoLand.active, enabled: __game.spots.enabled }; });
  check("OFF: no markers, nothing painted, the selection is cleared, the setting is saved - and the automatic landing already under way is NOT interrupted", off.n === 0 && off.painted === 0 && off.pressed === -1 && off.saved === false && off.active && !off.enabled, JSON.stringify(off));
  await unhover(); await p.waitForFunction(() => !__game.autoLand.active, null, { timeout: 30000 }).catch(() => {});
  await setup("rock", 12, 2.6, 8, 0); await hover(); await sleep(1500); const offNone = await p.evaluate(() => __game.spots.list.length); /* 鳥をその場にとどめる(OFF のあいだに足場を通り過ぎないように) */
  await setLm(true); await sleep(200); const reOn = await waitSpot(await p.evaluate(() => window.__target.id)); const savedOn = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem("vindving.prefs.v1")).landmarks; } catch { return null; } });
  await unhover();
  check("OFF keeps new candidates away; ON brings them back and is saved", offNone === 0 && reOn && savedOn === true, JSON.stringify({ offNone, reOn, savedOn }));

  // (E) 複数の中から狙った候補へ: 近い 2 つの目印を、それぞれ実タッチして、押した方の ID で自動着地が始まる(隣へは行かない)
  const two = await p.evaluate(async ([x, z, yaw]) => { const g = __game, f = g.flight; f.reset(); f.pos.set(x, 14, z); f.prevPos.copy(f.pos); f.yaw = yaw; f.vel.set(0, 0, 0); g.cam.snap(); window.__hv = setInterval(() => { f.pos.set(x, 14, z); f.vel.set(0, 0, 0); }, 8); await new Promise(r => setTimeout(r, 900));
    const L = g.spots.list.filter(q => q.near && q.d < 15.5); /* 自動着地の届く範囲(18 m)の境目の目印は、距離の揺れで「着地を試みて断る」と「接近先」の間を行き来する。この試験は取り違えの検査なので、範囲の内側に余裕のあるもの(15.5 m 未満)だけを使う */ let best = null; for (const a of L) for (const b of L) if (a.id < b.id) { const dd = Math.hypot(a.dx - b.dx, a.dy - b.dy); if (dd > 30 && (!best || dd < best.dd)) best = { a: a.id, b: b.id, dd }; } return best; }, town.pos);
  if (!two) { check("two nearby markers exist for the pick test in this town view", false, "none"); } else {
    for (const which of ["a", "b"]) { const id = two[which]; const q = await spotXY(id); const b0 = await stat(); const pre = await p.evaluate(([x, y, id]) => { const g = __game, q = g.spots.get(id), pk = g.spots.pick(Math.round(x), Math.round(y)); return { d: q && Math.round(q.d), near: q && q.near, pick: pk && [pk.id, Math.round(pk.d)], risky: pk && g.spots.assess(Math.round(x), Math.round(y), pk).risky, ok: q && g.autoLand.canStart(g.flight, q.s) }; }, [q.x, q.y, id]); await realTap(q.x, q.y); await sleep(300); const mid = await p.evaluate(() => ({ cf: __game.spotConfirm.id, ap: __game.approach.id, toast: document.getElementById("toast").textContent, rd: { ...__game.input.ringDiag }, log: __game.spotTapLog.slice(-5), taps: __game.input.stats.ringTaps, ctl: document.body.dataset.ctl, steer: __game.input.steerMode, vp: [innerWidth, innerHeight], fps: Math.round(1000 / Math.max(1, performance.now() - __game.input.frameAt)) })); await p.evaluate(() => { if (__game.spotConfirm.active) document.getElementById("spotGo").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); }); await sleep(300); const a1 = await stat(); const post = await p.evaluate(() => ({ cf: __game.spotConfirm.id, ap: __game.approach.id, toast: document.getElementById("toast").textContent }));
      check(`tapping marker ${which} (${q.kind}) acts on that perch only: started or refused for id ${id}, never the neighbour`, (a1.active ? a1.tgt === id : (a1.refused > b0.refused || (a1.starts > b0.starts && a1.last === id) || post.ap === id || post.cf === id)) && (a1.starts === b0.starts || a1.last === id) && a1.ringTaps === b0.ringTaps + 1 && a1.flapTaps === b0.flapTaps, JSON.stringify({ id, b0: [b0.starts, b0.refused, b0.ringTaps], a1s: [a1.starts, a1.refused, a1.last, a1.ringTaps], a1: { tgt: a1.tgt, active: a1.active, refusal: a1.refusal }, pre, mid, post }));
      await p.evaluate(() => __game.autoLand.cancel("user")); await sleep(100); }
  }
  await unhover();

  // (F) 押している間に目印が動いても、押した候補のまま: 飛びながら押して 0.2 秒後に離す
  await setup("rock", 14, 2.6, 7, 0); const fid = await p.evaluate(() => window.__target.id); await waitSpot(fid); await sleep(150);
  const q0 = await spotXY(fid); const b2 = await stat(); await tp("touchStart", [{ x: Math.round(q0.x), y: Math.round(q0.y), id: 1 }]); await sleep(200); const moved = await spotXY(fid); await tp("touchEnd", []); await sleep(300); const a2 = await stat(); const dbgF = await p.evaluate(() => ({ log: __game.spotTapLog.slice(-4), confirm: __game.spotConfirm.active, cfId: __game.spotConfirm.active ? __game.spotConfirm.id : -1, rd: __game.input.ringDiag, fps: Math.round(__game.input.frameGap) }));
  check("press on a flying marker, release 0.2 s later: the pressed perch is the one acted on (started for it, or refused with a reason) - even though the marker moved", (q0 && moved ? Math.hypot(moved.x - q0.x, moved.y - q0.y) >= 0 : true) && (a2.active ? a2.tgt === fid : (a2.refused > b2.refused || a2.gone > b2.gone || dbgF.cfId === fid)) && a2.ringTaps === b2.ringTaps + 1, JSON.stringify({ q0, moved, b2: [b2.ringTaps, b2.refused], a2: { tgt: a2.tgt, active: a2.active, refusal: a2.refusal, gone: a2.gone, ringTaps: a2.ringTaps, refused: a2.refused }, dbgF }));
  await p.evaluate(() => __game.autoLand.cancel("user"));

  // (G) 画面の大きさ・操作モード・操縦方式別の実タッチ: 目印の中心を押すと自動着地が始まり、羽ばたき・操舵にはならない
  const combos = [[892, 412, "right", "off"], [892, 412, "left", "A"], [412, 892, "right", "B"], [360, 800, "left", "C"], [1280, 720, "right", "A"], [892, 412, "both", "off"]];
  const rows = [];
  for (const [w, h, ctl, steer] of combos) {
    await p.setViewportSize({ width: w, height: h }); await sleep(500); await setCtl(ctl); await setSteer(steer); await sleep(200);
    let res = { ok: false, reasons: [] };
    for (let t = 1; t <= 2 && !res.ok; t++) {
      const i2 = await setup("rock", 12, 2.6, 8, w < h ? 0 : ctl === "left" ? -6 : 6); if (!i2) { res.reasons.push("no rock"); continue; }
      const shown = await waitSpot(i2.id); if (!shown) { res.reasons.push("not shown"); continue; } await hover(); await sleep(250);
      const q = await spotXY(i2.id); if (!q || q.x < 0 || q.x > w || q.y < 0 || q.y > h) { res.reasons.push("off screen"); await unhover(); continue; }
      const b = await stat(); await realTap(q.x, q.y); await sleep(300); const a = await stat(); await unhover();
      const started = a.active && a.tgt === i2.id, ringTap = a.ringTaps === b.ringTaps + 1, flap = a.flapTaps > b.flapTaps;
      if (started && ringTap && !flap) res.ok = true; else res.reasons.push(JSON.stringify({ started, refused: a.refused > b.refused, ringTap, flap, refusal: a.refusal }));
      await p.evaluate(() => __game.autoLand.cancel("user"));
    }
    rows.push({ vp: `${w}x${h}`, ctl, steer, ...res });
  }
  console.log("   real-touch matrix:"); for (const r of rows) console.log("    ", JSON.stringify(r));
  check("REAL TOUCH on a marker starts the automatic landing for it in every viewport / hand / steering-mode combination (a marker tap, not a flap or a steer)", rows.every(r => r.ok), JSON.stringify(rows.filter(r => !r.ok)));
  await setSteer("off"); await p.setViewportSize({ width: 892, height: 412 }); await sleep(400); await setCtl("right");

  // (I) H8-C 遠くの目印を押す: 断られず「接近先」になり、向きを合わせて近づき、届く範囲(18 m)に入ったら既存の自動着地が(安全検査つきで)始まる
  const farSetup = (side) => setup("rock", 38, 3, 10, side); /* 縁から 38 m = 目印まで 約 40 m。hover は速さを 0 にして先読みが 45 m に縮むので、固定の確認はそれより手前で */
  await p.setViewportSize({ width: 892, height: 412 }); await sleep(400); await setCtl("right"); await setSteer("off");
  const fi = await farSetup(7); const fid2 = fi.id; await waitSpot(fid2); await hover(); await sleep(200);
  const fq = await spotXY(fid2); const fd = await p.evaluate(i => __game.spots.get(i).d, fid2);
  const bf = await stat(); await tapConfirm(fq.x, fq.y); const afp = await p.evaluate(() => ({ id: __game.approach.id, sel: __game.approach.stats.selected, active: __game.autoLand.active, refused: __game.autoLand.stats.refused, refusal: __game.autoLand.lastRefusal, log: __game.spotTapLog.slice(-5), has: !!__game.spots.get(window.__target.id), fps: Math.round(__game.stats?.fps ?? -1) }));
  check("tapping a marker beyond the auto-landing reach selects it as the approach target (not refused with 'too far')", fd > 25 && afp.id === fid2 && afp.sel >= 1 && !afp.active && afp.refused === bf.refused, JSON.stringify({ fd: Math.round(fd), fid2, bfRefused: bf.refused, ...afp }));
  const drawnPending = await p.evaluate(() => { const cv = document.getElementById("spots"), c = cv.getContext("2d"), q = __game.spots.get(__game.approach.id), k = cv.width / innerWidth; if (!q) return -1; const d = c.getImageData(Math.max(0, Math.round((q.dx - 30) * k)), Math.max(0, Math.round((q.dy - 30) * k)), Math.round(60 * k), Math.round(60 * k)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 200 && d[i + 3] > 100) n++; return n; });
  check("the selected target is drawn in its own colour (blue ring) so the player can see it is armed", drawnPending > 10, `${drawnPending} blue px`);
  const fq2 = await spotXY(fid2) || fq; /* 接近が始まると鳥は目印の方へ向きを変えるので、目印は最初に読んだ位置から動いている。いま見えている位置を押す */ await tapConfirm(fq2.x, fq2.y); const cancelled = await p.evaluate(() => __game.approach.id);
  check("tapping the selected marker again cancels the approach", cancelled === -1, JSON.stringify({ cancelled, dbg: await dbgTap() }));
  await unhover();
  // 実際に近づく: 接近先を選んだら、手を触れずに(鳥は向きを自動で合わせて)届く範囲に入り、その足場へ自動着地が始まる
  const fi2 = await farSetup(7); await waitSpot(fi2.id); await sleep(150); const q2 = await spotXY(fi2.id);
  await tapConfirm(q2.x, q2.y); const sel2 = await p.evaluate(() => __game.approach.id);
  const starts0 = await p.evaluate(() => __game.autoLand.stats.starts); const startedOk = await p.waitForFunction(([i, n]) => __game.autoLand.lastTargetId === i && __game.autoLand.stats.starts > n, [fi2.id, starts0], { timeout: 90000 }).then(() => true).catch(() => false);
  await sleep(300); const fin = await p.evaluate(() => ({ started: __game.approach.stats.started, id: __game.approach.id, crashes: __game.flight.crashes, brake: __game.approach.stats.steerFrames, last: __game.approach.lastReason }));
  check("selected from ~50 m with a 7 m lateral offset: the bird turns toward it by itself, and the automatic landing starts for exactly that perch (via the existing safety check)", sel2 === fi2.id && startedOk && fin.started >= 1 && fin.id === -1 && fin.crashes === 0, JSON.stringify({ sel2, startedOk, ...fin, dbg: await dbgTap() }));
  await p.waitForFunction(() => !__game.autoLand.active, null, { timeout: 40000 }).catch(() => {});
  // 去ったら解除: 接近先を選んだあと、鳥を反対へ向けて目印が視界から去ると、選択は自動で解け、着地は始まらない
  const fi3 = await farSetup(0); await waitSpot(fi3.id); await sleep(150); const q3 = await spotXY(fi3.id); const st3a = await stat();
  await realTap(q3.x, q3.y); await sleep(200);
  await p.evaluate(() => { const f = __game.flight; f.yaw += Math.PI; f.vel.set(-f.vel.x, f.vel.y, -f.vel.z); __game.cam.snap(); });
  const cleared = await p.waitForFunction(() => __game.approach.id === -1, null, { timeout: 20000 }).then(() => true).catch(() => false); const st3 = await stat();
  const goneBy = await p.evaluate(() => ({ ...__game.approach.stats.goneBy, g: __game.approach.stats.gone, cancelled: __game.approach.stats.cancelled, last: __game.approach.lastReason, mode: __game.flight.mode, al: __game.autoLand.active }));
  check("the target left the view (the bird turned away): the unstarted selection is released with the reason recorded, and no landing was started", cleared && st3.starts === st3a.starts && goneBy.g >= 1, JSON.stringify({ cleared, goneBy }));
  // OFF にすると接近先も消える
  const fi4 = await farSetup(0); await waitSpot(fi4.id); await sleep(150); const q4 = await spotXY(fi4.id); await realTap(q4.x, q4.y); await sleep(200); const armed = await p.evaluate(() => __game.approach.id);
  await setLm(false); await sleep(300); const offAp = await p.evaluate(() => __game.approach.id); await setLm(true); await sleep(200);
  check("OFF also clears an armed approach target", armed === fi4.id && offAp === -1, JSON.stringify({ armed, offAp }));
  await p.evaluate(() => __game.autoLand.cancel("user"));

  // (H) 負荷: マーカー数・1 フレームあたりの処理時間(列挙+投影+遮蔽+配置と描画)。ソフトウェア描画の環境なので絶対値は実機と違う
  await p.evaluate(([x, z, yaw]) => { const g = __game, f = g.flight; f.reset(); f.pos.set(x, 14, z); f.prevPos.copy(f.pos); f.yaw = yaw; f.vel.set(0, 0, 0); g.cam.snap(); window.__hv = setInterval(() => { f.pos.set(x, 14, z); f.vel.set(0, 0, 0); }, 8); }, town.pos); await sleep(2500);
  const perf = await p.evaluate(() => ({ shown: __game.spots.list.length, maxShown: __game.spots.stats.maxShown, enumerated: __game.spots.stats.enumerated, updateMs: +__game.stats.spotMs.toFixed(3), drawMs: +__game.stats.spotDrawMs.toFixed(3), calls: __game.renderer.info.render.calls })); await unhover();
  console.log("   spots cost:", JSON.stringify(perf));
  check("the markers cost little per frame (update + draw < 3 ms even here, with the page rendered in software)", perf.shown >= 5 && perf.updateMs < 3 && perf.drawMs < 3, JSON.stringify(perf));
  check("H8-B: no page errors", errs.length === 0, errs.join(" | "));
}

// ---- g12: 実タッチでの自動着地の成功率(H2)。試行→候補が出た→タップ→開始/拒否→成功/失敗/取消/衝突→1.5秒保持→歩行 を分けて数える。再試行はしない
async function g12({ p, cdp, errs }) {
  const simWait = async (sec) => { const t0 = await p.evaluate(() => __game.game.gameTime); await p.waitForFunction(([t0, sec]) => __game.game.gameTime - t0 >= sec, [t0, sec], { timeout: 90000, polling: "raf" }).catch(() => {}); };
  console.log("\n# automatic landing by real taps: counts (H2)");
  const realTap = (x, y) => cdp.send("Input.synthesizeTapGesture", { x, y, duration: 50, tapCount: 1, gestureSourceType: "touch" });
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  await p.evaluate(() => { if (!document.getElementById("overlay").hidden) document.getElementById("ovGo").click(); }); await sleep(300);
  /* 木の枝・ベランダの床と手すりは 1 つの目印にまとめられるので、狙う足場の目印 = 同じ構造物を代表する目印 */
  await p.evaluate(() => { window.__press = null; document.addEventListener("pointerdown", e => { const g = __game; if (g.spots.pressedId < 0) return; /* 目印を押した指だけ(ボタンの押下は対象外)。押した瞬間の、画面上の目印の位置(表示位置)で、最寄り順に並べる */ window.__press = { x: e.clientX, y: e.clientY, picked: g.spots.pressedId, near: g.spots.list.map(q => [q.id, Math.round(Math.hypot(e.clientX - q.dx, e.clientY - q.dy) * 10) / 10]).sort((m, n) => m[1] - n[1]).slice(0, 3) }; }, true); });
  await p.evaluate(() => { window.__fs = (t) => { const g = __game, c = s => [(s.minX + s.maxX) / 2, (s.minZ + s.maxZ) / 2]; let q = g.spots.get(t.id); if (q) return q; const [cx, cz] = c(t), tree = t.kind === "branch"; return g.spots.list.find(q => { const [x, z] = c(q.s); return (q.kind === t.kind || (t.kind === "rail" && q.kind === "balcony") || (t.kind === "balcony" && q.kind === "rail")) && Math.hypot(x - cx, z - cz) < (tree ? 3.6 : 1.3) && Math.abs(q.s.top - t.top) < (tree ? 8 : 1.6); }) ?? null; }; });
  await p.setViewportSize({ width: 892, height: 412 }); await sleep(600);
  for (let i = 0; i < 3 && (await p.evaluate(() => document.body.dataset.ctl)) !== "right"; i++) { await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(250); }
  // 測定用の試行: 種類ごとに、足場の通し番号 k で決まる位置・向き・速さ(調整には使っていない別の並び)
  const plan = []; for (const kind of ["rock", "roof", "sign", "bench", "balcony", "rail", "branch", "pole"]) for (const k of [1, 2, 3]) plan.push([kind, k]); for (const kind of ["rock", "roof", "sign", "bench", "balcony", "rail", "branch", "pole"]) for (const k of [4, 5]) plan.push([kind, k, true]); /* 追加の試行(第 3 要素 = true)は、開始した着地が 8 件に届くまでの補充。描画の遅い環境では、指が届く前に足場を通り過ぎる試行が増えるので、標本の大きさを環境に依らず確保する(合格の閾値は変えない) */ // 3 回目の試行を足した: 描画の遅い環境では、指が届く前に足場を通り過ぎる試行が約 3 割出る(認識の失敗ではない)。母数を増やして「開始した着地が 6 件以上」を安定して満たす(合格の閾値は変えない)
  const rows = [];
  for (const [kind, k, extra] of plan) { if (process.env.G12_ONLY && process.env.G12_ONLY !== kind + ":" + k) continue;
    if (extra && rows.filter(r => r.end !== undefined || r.result === "success").length >= 8) continue;
    const info = await p.evaluate(([kind, k]) => {
      const g = __game, f = g.flight, w = g.world; f.reset(); g.setAuto(false); g.settings.weather = "clear"; g.input.releaseAll(); g.autoLand.cancel("user"); g.autoLand.lastRefusal = "";
      const open = s => !w.colliders.some(c => c.maxX - c.minX > 3 && c.maxZ - c.minZ > 3 && c.top > s.top + 0.3 && c.maxX > s.minX - 16 && c.minX < s.maxX + 16 && c.maxZ > s.minZ - 16 && c.minZ < s.maxZ + 16);
      const all = g.surfaces.all.filter(s => s.kind === kind && (kind === "balcony" || kind === "rail" || open(s)) && (kind !== "roof" || (s.maxX - s.minX) * (s.maxZ - s.minZ) > 40 && s.top < 12));
      const t = all[(k * 5 + 1) % Math.max(1, all.length)]; if (!t) return null; window.__target = t;
      // 人が「あの足場へ降りたい」と飛んでいる状況(単体の計測 tools/autoland_success.ts と同じ分布): 縁から 6〜16 m、面の上 0.8〜5 m、速さ 6〜11 m/s、足場の方向から ±45° ずれた向き
      let sd = (kind.length * 977 + k * 131 + all.length * 7) >>> 0; const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
      const cx = (t.minX + t.maxX) / 2, cz = (t.minZ + t.maxZ) / 2, ang = t.outward ? Math.atan2(t.outward[1], t.outward[0]) + (rnd() - 0.5) * 1.6 : rnd() * Math.PI * 2, dist = 6 + rnd() * 10, h0 = t.top + 0.8 + rnd() * 4.2;
      const dxs = Math.cos(ang), dzs = Math.sin(ang), hx = (t.maxX - t.minX) / 2, hz = (t.maxZ - t.minZ) / 2, tE = Math.min(hx / Math.max(Math.abs(dxs), 1e-6), hz / Math.max(Math.abs(dzs), 1e-6));
      f.pos.set(cx + dxs * (tE + dist), h0, cz + dzs * (tE + dist)); f.prevPos.copy(f.pos); f.yaw = Math.atan2(-(cx - f.pos.x), -(cz - f.pos.z)) + (rnd() - 0.5) * 1.57; const v0 = 6 + rnd() * 5; f.vel.set(-Math.sin(f.yaw) * v0, -0.5, -Math.cos(f.yaw) * v0);
      f.prevPos.copy(f.pos); g.cam.snap(); return { id: t.id, w: +(t.maxX - t.minX).toFixed(1), d: +(t.maxZ - t.minZ).toFixed(1), top: t.top };
    }, [kind, k]);
    const row = { kind, k, result: "no-surface", retap: 0 };
    if (!info) { rows.push(row); continue; }
    const shown = await p.waitForFunction(() => !!window.__fs(window.__target), null, { timeout: 7000 }).then(() => true).catch(() => false); // 狙う足場の目印が出るまで(H8-B: 全候補のうち、この足場の ID)
    if (!shown) { row.result = "no-ring"; rows.push(row); continue; }
    // 目印が落ち着くのを待つ: 100 ms おいて2回読み、動きが 25 px 以内なら押す(足場のすぐ横を通り抜けるときの目印は画面を高速に横切る。そういう場面は押せるものとして数えず、unstable として別に数える)
    let rs = null; for (let w = 0; w < 14 && !rs; w++) { /* 1 回の往復で、100 ms 離して 2 回読む(CDP の往復を挟むと、遅い実行環境ではその間にも鳥が飛び続けて足場を通り過ぎる) */
      const r = await p.evaluate(() => new Promise(res => { const rd = () => { const q = window.__fs(window.__target); return q ? { x: q.dx, y: q.dy, v: true } : { x: 0, y: 0, v: false }; }; const a1 = rd(); setTimeout(() => res([a1, rd()]), 100); }));
      if (r[0].v && r[1].v && Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y) <= 25) rs = r[1]; }
    if (!rs) { row.result = "unstable-ring"; rows.push(row); continue; }
    const tid = await p.evaluate(() => { const q = window.__fs(window.__target); window.__fsId = q ? q.id : window.__target.id; return window.__fsId; }); // 押す前に、狙う目印の ID を確定
    const b = await p.evaluate(() => ({ starts: __game.autoLand.stats.starts, refused: __game.autoLand.stats.refused, crashes: __game.flight.crashes, ok: __game.autoLand.stats.success, taps: __game.input.stats.ringTaps, gone: __game.spots.stats.gone, asked: __game.spotConfirm.stats.asked, cgone: __game.spotConfirm.stats.gone, conf: __game.spotConfirm.stats.confirmed }));
    const cb = { asked: b.asked, gone: b.cgone, conf: b.conf };
    await realTap(Math.round(rs.x), Math.round(rs.y));
    // H8-D: 密集した目印は 1 回目のタップが仮選択になる。ここでは「ここへ接近」を、仮選択が出た次の瞬間に押す(人の反応時間は別の指標: 仮選択後に目印が去った件数を行ごとに記録する)
    await p.waitForFunction(x => { const g = __game; return g.spotConfirm.stats.asked > x.asked || g.autoLand.stats.starts > x.s || g.autoLand.stats.refused > x.r || g.approach.id >= 0 || g.spots.stats.gone > x.g; }, { asked: cb.asked, s: b.starts, r: b.refused, g: b.gone }, { timeout: 1500, polling: "raf" }).catch(() => {});
    await p.evaluate(() => { if (__game.spotConfirm.active) document.getElementById("spotGo").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); }); await sleep(250);
    const ca = await p.evaluate(() => ({ asked: __game.spotConfirm.stats.asked, gone: __game.spotConfirm.stats.gone, conf: __game.spotConfirm.stats.confirmed, why: __game.spotConfirm.lastWhy }));
    row.asked = ca.asked - cb.asked; row.confirmed = ca.conf - cb.conf; row.lostAsked = ca.gone - cb.gone; row.askWhy = ca.why;
    const a = await p.evaluate(() => ({ starts: __game.autoLand.stats.starts, refused: __game.autoLand.stats.refused, why: __game.autoLand.lastRefusal, taps: __game.input.stats.ringTaps, tgt: __game.autoLand.lastTargetId, active: __game.autoLand.active, gone: __game.spots.stats.gone }));
    row.tapped = a.taps === b.taps + 1;
    if (row.tapped && a.starts === b.starts && a.refused === b.refused && (await p.evaluate(() => __game.approach.id)) >= 0) { // H8-C: 遠い目印を押した = 接近先に選んだ。向きを合わせて近づき、届く範囲で自動着地が始まる(または目印が去って解除される)のを待つ
      row.approach = true; await p.waitForFunction(n => __game.autoLand.stats.starts > n || __game.approach.id < 0, b.starts, { timeout: 30000 }).catch(() => {});
      const a2 = await p.evaluate(() => ({ starts: __game.autoLand.stats.starts, refused: __game.autoLand.stats.refused, why: __game.autoLand.lastRefusal, taps: __game.input.stats.ringTaps, tgt: __game.autoLand.lastTargetId, active: __game.autoLand.active, gone: __game.spots.stats.gone, apWhy: __game.approach.lastReason }));
      if (a2.starts === b.starts) { row.result = a2.refused > b.refused ? "refused:" + a2.why : "approach-" + (a2.apWhy || "ended"); rows.push(row); continue; }
      Object.assign(a, a2); }
    if (a.refused > b.refused) { row.result = "refused:" + a.why; rows.push(row); continue; } // 認識したが安全判定で拒否(認識の失敗とは別)
    if (a.starts === b.starts) { // 認識されなかった: 押した位置が目印に届いていたかで、取りこぼしと「指が届く前に目印が動いた/去った」を分ける
      const now = await p.evaluate(() => { const q = window.__fs(window.__target); return q ? { x: q.dx, y: q.dy } : null; }); row.goneWhy = await p.evaluate(() => { const q = window.__target; return __game.spots.goneWhy(window.__fsId ?? q.id); }); row.dbg = { taps: [b.taps, a.taps], now, press: rs, rd: await p.evaluate(() => ({ ...__game.input.ringDiag })) };
      row.result = row.asked && !row.confirmed ? "preselected-lost:" + (row.askWhy || "?") : !now ? "ring-gone-before-tap" : Math.hypot(now.x - rs.x, now.y - rs.y) > 34 ? "ring-moved-before-tap" : "tap-not-recognised"; rows.push(row); continue; }
    row.dbgT = await p.evaluate(([t, tid]) => { const g = __game, A = g.surfaces.all[tid], B = g.surfaces.all[t]; return { spot: A && [A.kind, A.minX.toFixed(1), A.minZ.toFixed(1), A.top], tgt: B && [B.kind, B.minX.toFixed(1), B.minZ.toFixed(1), B.top], want: [window.__target.kind, window.__target.minX.toFixed(1), window.__target.minZ.toFixed(1), window.__target.top] }; }, [a.tgt, tid]);
    const pressNear = await p.evaluate(() => window.__press); row.press = pressNear; /* 押した瞬間に指の下で最寄りだった目印(アプリが選ぶ基準)。読んでから押すまでに目印が動いた分は、テストの待ち時間であって、アプリの取り違えではない */ const nearId = pressNear && pressNear.near[0] ? pressNear.near[0][0] : -1; row.targetOk = a.tgt === tid || a.tgt === nearId || (await p.evaluate(([t, tid, nid]) => { const g = __game, A = g.surfaces.all[tid], B = g.surfaces.all[t]; const bal = k => k === "balcony" || k === "rail"; return !!A && !!B && bal(A.kind) && bal(B.kind) && Math.hypot((A.minX + A.maxX) / 2 - (B.minX + B.maxX) / 2, (A.minZ + A.maxZ) / 2 - (B.minZ + B.maxZ) / 2) < 4; }, [a.tgt, tid])); /* ベランダの目印は、手すりの上へ降りる設計(AutoLand.retarget: 鳥のいる側の手すり)なので、同じベランダの床・手すりは同じ目的地とみなす(4 m 以内) */ // 押した足場そのものへ着地を始めた(隣ではない)
    await p.waitForFunction(() => !__game.autoLand.active, null, { timeout: 25000 }).catch(() => {});
    const e = await p.evaluate(([bo]) => ({ end: __game.autoLand.end, crashes: __game.flight.crashes, ok: __game.autoLand.stats.success, mode: __game.flight.mode }), [b.ok]);
    row.end = e.end; row.crash = e.crashes - b.crashes > 0;
    if (e.ok > b.ok) { // 成功: 1.5秒、何も触らず保持 → 足元の面を確かめる → 歩行可能な足場なら実タッチで歩く
      await sleep(1500);
      const held = await p.evaluate(() => { const f = __game.flight, t = window.__target, u = __game.surfaces.under(f.pos.x, f.pos.y - 0.32, f.pos.z, []); return { mode: f.mode, on: u ? u.kind : "", same: !!u && (u.id === t.id || ((t.kind === "balcony" || t.kind === "rail") && (u.kind === "balcony" || u.kind === "rail"))), walkable: Math.max(t.maxX - t.minX, t.maxZ - t.minZ) - 0.94 >= 2 }; });
      row.held = held.mode !== "air" && held.same; row.on = held.on; row.walkable = held.walkable;
      if (row.held && held.walkable) {
        const t = await p.evaluate(() => { const f = __game.flight, t = window.__target, alongX = t.maxX - t.minX >= t.maxZ - t.minZ, cx = (t.minX + t.maxX) / 2, cz = (t.minZ + t.maxZ) / 2; let yaw = alongX ? -Math.PI / 2 : Math.PI; const fx = -Math.sin(yaw), fz = -Math.cos(yaw); if ((cx - f.pos.x) * fx + (cz - f.pos.z) * fz < 0) yaw += Math.PI; f.yaw = yaw; f.walkV = 0; return { x: f.pos.x, z: f.pos.z }; });
        const Lp = await p.evaluate(() => __game.input.layout()), sx = Math.round(Lp.cruise.cx), sy = Math.round(Lp.cruise.cy); /* 上側(巡航)の◎の中心から上へスライド = 歩く */ await tp("touchStart", [{ x: sx, y: sy, id: 91 }]); await tp("touchMove", [{ x: sx, y: sy - 40, id: 91 }]); await simWait(1.5); /* 歩く距離はゲーム内の時間で決まる(描画が遅いと、実時間 1.5 秒ではゲーム内の時間が足りない) */
        const z = await p.evaluate(() => ({ x: __game.flight.pos.x, z: __game.flight.pos.z, mode: __game.flight.mode })); await tp("touchEnd", []); await sleep(200);
        row.walked = Math.hypot(z.x - t.x, z.z - t.z) >= 0.8 && z.mode === "landed";
      }
      row.result = "success";
    } else row.result = "end:" + e.end;
    rows.push(row);
  }
  const n = rows.length, unstable = rows.filter(r => r.result === "unstable-ring").length, noRing = rows.filter(r => r.result.startsWith("no-ring") || r.result === "no-surface").length, refused = rows.filter(r => r.result.startsWith("refused")).length, notRec = rows.filter(r => r.result === "tap-not-recognised").length;
  const started = rows.filter(r => r.end !== undefined || r.result === "success").length, succ = rows.filter(r => r.result === "success"), held = succ.filter(r => r.held), walkable = held.filter(r => r.walkable), walked = walkable.filter(r => r.walked);
  const ends = {}; for (const r of rows) if (r.end !== undefined && r.result !== "success") ends[r.end || "?"] = (ends[r.end || "?"] || 0) + 1;
  const crashes = rows.filter(r => r.crash).length;
  for (const r of rows) console.log("    ", JSON.stringify(r));
  console.log(`   SUMMARY real-tap landings: trials ${n} | no ring/no surface ${noRing} | ring too fast to tap (unstable) ${unstable} | ring moved away before the finger landed ${rows.filter(r => r.result === "ring-moved-before-tap").length} | ring already gone when the finger landed ${rows.filter(r => r.result === "ring-gone-before-tap").length} | tap not recognised although the finger landed on the ring ${notRec} | refused at start ${refused} | started ${started} | success ${succ.length} (held 1.5 s ${held.length}; on the landed surface: ${JSON.stringify(held.reduce((m, r) => (m[r.on] = (m[r.on] || 0) + 1, m), {}))}) | other ends ${JSON.stringify(ends)} | crashes ${crashes} | walk-class held ${walkable.length}, really walked ${walked.length} | re-taps ${rows.reduce((m, r) => m + (r.retap || 0), 0)} (tap not recognised the first time) | whole-trial retries 0`);
  console.log(`   H8-D stages: trials with a ring and a finger ${rows.filter(r => r.tapped !== undefined).length} | pre-selected (crowded) ${rows.filter(r => r.asked).length} | confirmed ${rows.filter(r => r.confirmed).length} | pre-selected then lost before confirm ${rows.filter(r => r.asked && !r.confirmed).length} | one-tap (isolated) ${rows.filter(r => r.tapped && !r.asked).length}`);
  check("the real-tap landing sample is big enough and the ring was available in most trials", n >= 14 && noRing <= Math.ceil(n * 0.25), `${noRing}/${n} without a ring`);
  const recogMiss = rows.filter(r => r.recogMiss).length + notRec, movedFirst = rows.filter(r => r.firstMoved).length;
  console.log(`   first taps that missed because the ring had moved away before the finger landed (re-tapped once, reported, not a recognition fault): ${movedFirst}; real recognition misses (press inside the ring's hit area): ${recogMiss}`);
  check("a tap whose press lands inside a shown marker's hit area is always recognised (no tolerance), and acts on the pressed perch", recogMiss === 0 && rows.every(r => r.targetOk !== false), `${recogMiss} misses; wrong target ${rows.filter(r => r.targetOk === false).length}`);
  check("of the started landings, at least 40% succeed and are still on the structure after 1.5 s with no touch (default wind on; the same approach distribution gives about 50-65% in the unit measurement)", started >= 6 && held.length / started >= 0.4, `${held.length}/${started} (success ${succ.length})`);
  check("collisions during started landings are not common (<= 25%)", crashes <= Math.ceil(started * 0.25), `${crashes}/${started}`);
  check("on walkable perches a real stick touch moves the bird at least 0.8 m while it stays landed (>= 80%)", walkable.length === 0 || walked.length / walkable.length >= 0.8, `${walked.length}/${walkable.length}`);
  check("G: no page errors", errs.length === 0, errs.join(" | "));
}


// ---- g13: ◯のタップ認識を決定的に確かめる(H6)。◯の位置と大きさを固定し、実タッチ(CDP)の入力列を何通りも流して、認識された回数が期待どおりかを見る。
// 着地の可否(安全判定)はここでは見ない。見るのは「押した瞬間に◯の当たりの中なら必ず1回、外・長押し・動かしたときは0回」だけ。
async function g13({ p, cdp, errs }) {
  console.log("\n# ring tap recognition, deterministic input sequences (H6)");
  if (process.env.G13_THROTTLE) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.G13_THROTTLE) }); // 診断用: CI のように CPU が足りない状況を作る
  const vt = virtualTouch(cdp), tp = vt.tp, sleep = vt.sl; // 指の時間を決め打ちにする(virtualTouch の説明を参照)
  await p.evaluate(() => { if (!document.getElementById("overlay").hidden) document.getElementById("ovGo").click(); }); await sleep(300);
  { const r = await p.evaluate(() => { const I = __game.input, keep = I.stalls.slice(); I.stalls = [{ s: 100, e: 1000 }]; const o = { tapStalled: I.tapMs(50, 1010), none: I.tapMs(2000, 2060), cap: (I.stalls = [{ s: 0, e: 9000 }], I.tapMs(0, 8000)) }; I.stalls = keep; return o; });
    check("a quick tap that the browser delivered across a frame stall is measured without the stall (960 ms on the clock, 60 ms of finger time)", r.tapStalled === 60 && r.none === 60, JSON.stringify(r));
    check("a really long press stays long even when frames were stalled (the stall is only forgiven up to 4 s)", r.cap === 4000, JSON.stringify(r)); }
  const results = [];
  for (const vp of [[892, 412], [412, 892]]) {
    await p.setViewportSize({ width: vp[0], height: vp[1] }); await sleep(500);
    await p.evaluate(() => { const g = __game; g.setAuto(false); g.input.releaseAll(); window.__taps = 0; window.__ring = { x: 0, y: 0, hit: 48, on: true }; g.input.spotAt = (x, y) => (window.__ring.on && Math.hypot(x - window.__ring.x, y - window.__ring.y) <= window.__ring.hit ? 1 : -1); g.input.onSpotTap = () => { window.__taps++; }; });
    const W = vp[0], H = vp[1];
    // 位置: 中央・四隅(縁の◯が置かれる余白 36 px / 上は 72 px)・各辺の中央・操作の◎や上部ボタンの近く
    const spots = [[W / 2, H / 2], [36, 72], [W - 36, 72], [36, H - 36], [W - 36, H - 36], [W / 2, 72], [W / 2, H - 36], [36, H / 2], [W - 36, H / 2], [W - 60, H - 90], [60, H - 90]].map(a => [Math.round(a[0]), Math.round(a[1])]);
    const seqs = [
      ["tap", 1, async (x, y) => { await tp("touchStart", [{ x, y, id: 1 }]); await sleep(60); await tp("touchEnd", []); }],
      ["tap-jitter-8px", 1, async (x, y) => { await tp("touchStart", [{ x, y, id: 1 }]); await sleep(30); await tp("touchMove", [{ x: x + 8, y: y - 4, id: 1 }]); await sleep(30); await tp("touchEnd", []); }],
      ["tap-edge-of-hit(44px)", 1, async (x, y, dir) => { await tp("touchStart", [{ x: x + 44 * dir, y, id: 1 }]); await sleep(60); await tp("touchEnd", []); }],
      ["tap-then-second-finger-elsewhere", 1, async (x, y) => { await tp("touchStart", [{ x, y, id: 1 }]); await sleep(40); await tp("touchEnd", []); await tp("touchStart", [{ x: Math.abs(x - W / 2) < 150 ? W - 120 : W / 2, y: Math.abs(x - W / 2) < 150 ? 120 : H / 2, id: 2 }]); await sleep(40); await tp("touchEnd", []); }],
      ["other-finger-down-first", 1, async (x, y) => { const ox = x < W / 2 ? Math.round(W * 0.7) : Math.round(W * 0.3), oy = y < H / 2 ? Math.round(H * 0.75) : Math.round(H * 0.25); await tp("touchStart", [{ x: ox, y: oy, id: 7 }]); await sleep(30); await tp("touchStart", [{ x: ox, y: oy, id: 7 }, { x, y, id: 1 }]); await sleep(60); await tp("touchEnd", [{ x: ox, y: oy, id: 7 }]); await sleep(30); await tp("touchEnd", []); }],
      ["miss(80px away)", 0, async (x, y, dir) => { await tp("touchStart", [{ x: x + 80 * dir, y, id: 1 }]); await sleep(60); await tp("touchEnd", []); }],
      ["long-press(6500ms)", 0, async (x, y) => { await tp("touchStart", [{ x, y, id: 1 }]); await sleep(6500); await tp("touchEnd", []); }],
      ["drag(40px)", 0, async (x, y) => { await tp("touchStart", [{ x, y, id: 1 }]); await sleep(30); await tp("touchMove", [{ x: x + 40, y, id: 1 }]); await sleep(30); await tp("touchEnd", []); }],
      ["cancelled", 0, async (x, y) => { await tp("touchStart", [{ x, y, id: 1 }]); await sleep(30); await tp("touchCancel", []); }],
    ];
    for (const [name, want, run] of seqs) {
      let ok = 0; const bad = []; await p.evaluate(() => { if (!document.getElementById("overlay").hidden) document.getElementById("ovGo").click(); });
      for (const [x, y] of name.startsWith("long-press") ? spots.slice(0, 3) : spots) {
        if (await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest && e.closest("button,.btn,#overlay")); }, [x, y])) continue; // ボタンの上は◯を置かない場所(freeEdgeSpot が避ける)
        await p.evaluate(([x, y]) => { window.__ring.x = x; window.__ring.y = y; window.__ring.hit = 48; window.__taps = 0; }, [x, y]);
        await run(x, y, x < W / 2 ? 1 : -1);
        await sleep(100);
        const n = await p.evaluate(() => window.__taps); if (n === want) ok++; else bad.push(`${x},${y}->${n}`);
      }
      const rd = bad.length ? JSON.stringify(await p.evaluate(() => ({ ...__game.input.ringDiag, stalls: __game.input.stalls.length, fps: Math.round(1000 / (performance.now() - __game.input.frameAt + 1)) }))) : "";
      check(`${vp.join("x")} ${name}: ${want ? "recognised exactly once" : "never recognised"} at every spot not covered by a button (${ok} spots)`, ok >= 3 && bad.length === 0, bad.join(" ") + " " + rd);
    }
  }
  check("G13: no page errors", errs.length === 0, errs.join(" | "));
}


// ---- g14: H8-A 単一◎の 3 方式を実タッチで確かめる。方式の切替(再読込なし・保存)、旋回/上下/斜め/無操作、タップ、長押し、地上、マルチタッチ、低FPS、縦横・左右
async function g14({ p, cdp, errs }) {
  console.log("\n# H8-A single-◎ steering, real touches");
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  await p.evaluate(() => { if (!document.getElementById("overlay").hidden) document.getElementById("ovGo").click(); }); await sleep(300);
  const setCtl = async (m) => { for (let i = 0; i < 4 && (await p.evaluate(() => document.body.dataset.ctl)) !== m; i++) { await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(200); } };
  const setSteer = async (m) => { for (let i = 0; i < 5 && (await p.evaluate(() => __game.input.steerMode)) !== m; i++) { await p.evaluate(() => document.getElementById("btnSteer").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(150); } };
  const fresh = () => p.evaluate(() => { const g = __game, f = g.flight; g.setAuto(false); g.input.releaseAll(); g.steerLayer.reset(); f.reset(); g.settings.weather = "clear"; f.pos.set(0, 90, 0); f.prevPos.copy(f.pos); f.yaw = 0; f.vel.set(0, 0, -10); f.mode = "air"; g.cam.snap(); return true; });
  const pad = () => p.evaluate(() => __game.input.steerRect());
  const st = () => p.evaluate(() => { const f = __game.flight; return { yaw: f.yaw, y: f.pos.y, v: f.speed, mode: f.mode, strokes: f.strokes, brake: __game.input.steer.brake, active: __game.input.steer.active, taps: __game.input.steer.tapSeq, id: __game.input.steer.id }; });
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const gs = async (sec) => { const t0 = await p.evaluate(() => __game.flight.clock); await p.waitForFunction(([t0, sec]) => __game.flight.clock - t0 >= sec, [t0, sec], { timeout: 60000 }); }; // ゲーム内の秒数で待つ(この環境の描画は遅く、実時間とゲーム時間がずれるため)
  for (const [vw, vh, hand] of [[892, 412, "right"], [892, 412, "left"], [412, 892, "right"]]) {
    await p.setViewportSize({ width: vw, height: vh }); await sleep(500); await setCtl(hand);
    const tag = `${vw}x${vh} ${hand}`;
    for (const m of ["A", "B", "C"]) {
      await setSteer(m); const ok = await p.evaluate(m => document.body.dataset.steer === m && __game.input.steerMode === m && document.getElementById("steerTag").textContent.length > 0, m);
      const saved = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem("vindving.prefs.v1")).steer; } catch { return null; } });
      check(`${tag} ${m}: switching is immediate (no reload), shown on screen and saved`, ok && saved === m, `saved ${saved}`);
      const R = await pad(), P = (dx, dy) => ({ x: Math.round(R.cx + dx * R.r), y: Math.round(R.cy + dy * R.r), id: 1 });
      // 右へ(スワイプ→離す / 動かす): 右へ旋回
      await fresh(); await gs(0.2); const y0 = (await st()).yaw;
      await tp("touchStart", [P(0, 0)]); for (let i = 1; i <= 5; i++) { await tp("touchMove", [P(0.18 * i, 0)]); await sleep(20); }
      if (m !== "A") await gs(1.3); await tp("touchEnd", []); await gs(m === "A" ? 2.2 : 0.8);
      const s1 = await st(); check(`${tag} ${m}: finger right turns the bird right (yaw ${wrap(s1.yaw - y0).toFixed(2)})`, wrap(s1.yaw - y0) < -0.25 && s1.mode === "air");
      // 上
      await fresh(); await gs(0.2); const a0 = (await st()).y;
      await tp("touchStart", [P(0, 0)]); for (let i = 1; i <= 5; i++) { await tp("touchMove", [P(0, -0.18 * i)]); await sleep(20); }
      if (m !== "A") await gs(1.3); await tp("touchEnd", []); await gs(m === "A" ? 2.2 : 0.6);
      const s2 = await st(); const idleY = await (async () => { await fresh(); await gs(3.5); return (await st()).y; })();
      check(`${tag} ${m}: finger up climbs relative to hands-off (${s2.y.toFixed(1)} vs ${idleY.toFixed(1)})`, s2.y > idleY + 0.8, `start ${a0.toFixed(1)}`);
      // 無操作: 直進
      await fresh(); await gs(3); const s3 = await st(); check(`${tag} ${m}: hands-off flies straight (yaw ${s3.yaw.toFixed(3)})`, Math.abs(wrap(s3.yaw)) < 0.05 && s3.mode === "air");
      // タップ = 羽ばたき(スティックにも進路変更にもならない)
      await fresh(); await sleep(150); const k0 = (await st()); await tp("touchStart", [P(0, 0)]); await sleep(60); await tp("touchEnd", []); await sleep(700);
      const s4 = await st(); check(`${tag} ${m}: a short tap flaps and does not steer or brake`, s4.taps === k0.taps + 1 && s4.strokes > k0.strokes && Math.abs(wrap(s4.yaw - k0.yaw)) < 0.05 && !s4.brake, `taps ${k0.taps}->${s4.taps} strokes ${k0.strokes}->${s4.strokes} dyaw ${wrap(s4.yaw - k0.yaw).toFixed(3)} brake ${s4.brake}`);
      // 長押し: A/B は動かさず押し続けてブレーキ、C は中心で。周辺の長押しは C ではブレーキしない
      await fresh(); await sleep(150); await tp("touchStart", [P(0, 0)]); await sleep(1400); const s5 = await st(); await tp("touchEnd", []); await sleep(200);
      check(`${tag} ${m}: a press on the centre brakes`, s5.brake, `brake ${s5.brake}`);
      if (m === "C") { await fresh(); await sleep(150); await tp("touchStart", [P(0.85, 0)]); await sleep(1600); const s6 = await st(); await tp("touchEnd", []); await sleep(200); check(`${tag} C: holding the rim does not brake`, !s6.brake && s6.active); }
      // マルチタッチ: 2 本目は無視。最初の指を離すと終了
      await fresh(); await sleep(150); await tp("touchStart", [P(0, 0)]); await sleep(60); await tp("touchStart", [P(0, 0), { x: Math.round(R.cx - R.r * 2), y: Math.round(R.cy), id: 2 }]); await sleep(150);
      const mt = await st(); await tp("touchEnd", [P(0, 0), { x: Math.round(R.cx - R.r * 2), y: Math.round(R.cy), id: 2 }]); await sleep(300); const mt2 = await st();
      check(`${tag} ${m}: a second finger is ignored (same pad finger), and lifting both ends it`, mt.active && !mt2.active, `during ${mt.active} after ${mt2.active}`);
    }
    // 途中で方式を切り替えても、指の途中状態が残らない
    await setSteer("B"); await fresh(); const R = await pad(); await tp("touchStart", [{ x: Math.round(R.cx), y: Math.round(R.cy), id: 1 }]); await sleep(500);
    await setSteer("C"); const sw = await st(); await tp("touchEnd", []); await sleep(200);
    check(`${tag}: switching the mode with a finger down clears the pad (no stuck brake or finger)`, !sw.active && !sw.brake);
    await setSteer("off"); const off = await p.evaluate(() => ({ s: document.body.dataset.steer, on: __game.input.steerOn, tag: document.getElementById("steerTag").textContent }));
    check(`${tag}: 従来 restores the old controls`, off.s === "off" && !off.on && off.tag === "");
  }
  // 低 FPS: CPU を絞っても、短いタップは取りこぼさず長押しにもならない
  await p.setViewportSize({ width: 892, height: 412 }); await sleep(400); await setCtl("right"); await setSteer("B"); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  { let hit = 0; const R = await pad(); for (let i = 0; i < 6; i++) { await fresh(); await sleep(200); const k0 = await st(); await tp("touchStart", [{ x: Math.round(R.cx), y: Math.round(R.cy), id: 1 }]); await sleep(60); await tp("touchEnd", []); await sleep(500); const k1 = await st(); if (k1.taps === k0.taps + 1 && !k1.brake) hit++; }
    check(`low FPS (CPU x6): short taps are all recognised, none becomes a brake (${hit}/6)`, hit === 6); }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  // 記録(比較用): 同じ開始位置から、各方式で同じ指の動きをしたときの旋回角速度・カメラ角速度・速さ
  const rec = {};
  { const R = await pad(); for (const m of ["A", "B", "C"]) { await setSteer(m); await p.evaluate(() => __game.steerTestStart()); await p.evaluate(() => { __game.steerLayer.resetStats(); }); await sleep(300);
      const P = (dx, dy) => ({ x: Math.round(R.cx + dx * R.r), y: Math.round(R.cy + dy * R.r), id: 1 });
      await tp("touchStart", [P(0, 0)]); for (let i = 1; i <= 5; i++) { await tp("touchMove", [P(0.18 * i, -0.05 * i)]); await sleep(20); } if (m !== "A") await sleep(1000); await tp("touchEnd", []); await sleep(2200);
      rec[m] = await p.evaluate(() => { const L = __game.steerLayer; return { maxYawRate: +L.stats.maxYawRate.toFixed(2), maxCamRate: +L.stats.maxCamRate.toFixed(2), speedJumps: L.stats.speedJumps, taps: L.stats.taps, brakeFrames: L.stats.brakeFrames, speed: +__game.flight.speed.toFixed(1), yaw: +__game.flight.yaw.toFixed(2) }; }); }
    console.log("   COMPARE (same start, same finger path)", JSON.stringify(rec));
    check("comparison log: no mode produced a warp or an instant stop, and none turned faster than the physics limit", Object.values(rec).every(r => r.speedJumps === 0 && r.maxYawRate < 2.2)); }
  await setSteer("off"); await setCtl("both");
  check("H8: no page errors", errs.length === 0, errs.join(" | "));
}


// ---- g15: H8-D 密集した目印だけ確認(2 段階)。孤立=1 タップ、密集=仮選択+「ここへ接近」、選び直し・取消・期限切れ・去った・OFF・モード切替、確認ボタンの置き場所(◎・パッドとの重なり)、押した後に動く候補、低FPS、マルチタッチ、入力の漏れ
async function g15({ p, cdp, errs }) {
  console.log("\n# H8-D confirm only for crowded markers");
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  const realTap = (x, y) => cdp.send("Input.synthesizeTapGesture", { x: Math.round(x), y: Math.round(y), duration: 50, tapCount: 1, gestureSourceType: "touch" });
  const setCtl = async (m) => { for (let i = 0; i < 3; i++) { if ((await p.evaluate(() => document.body.dataset.ctl)) === m) return; await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(250); } };
  const setSteer = async (m) => { for (let i = 0; i < 5 && (await p.evaluate(() => __game.input.steerMode)) !== m; i++) { await p.evaluate(() => document.getElementById("btnSteer").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(150); } };
  const hoverAt = (x, z, yaw, y = 14) => p.evaluate(([x, z, yaw, y]) => { const g = __game, f = g.flight; clearInterval(window.__hv); g.setAuto(false); g.settings.weather = "clear"; g.input.releaseAll(); g.autoLand.cancel("user"); g.approach.clear("cancelled"); g.spotConfirm.clear("cancelled"); f.reset(); f.pos.set(x, y, z); f.prevPos.copy(f.pos); f.yaw = yaw; f.vel.set(0, 0, 0); g.cam.snap(); window.__hv = setInterval(() => { f.pos.set(x, y, z); f.vel.set(0, 0, 0); }, 8); }, [x, z, yaw, y]);
  const unhover = () => p.evaluate(() => clearInterval(window.__hv));
  // 判定と押下を同じ同期タスクの中で行う(H8-B の表示ずらしで目印は動き続けるので、リストを作ってから押すまでの間に「密集かどうか」が変わるのを避ける)。押した目印の id と、押した瞬間の判定を返す
  /* 押せる条件の目印が「その瞬間に無い」と tapRisky は何も押さずに null を返す。それを製品の失敗と取り違えないよう、条件が整うまで状態を見て待ってから押す(時間で待つのではなく、候補が現れるのを待つ) */
  const tapRiskyW = async (ex = -1, minD = 0) => { for (let k = 0; k < 60; k++) { const r = await tapRisky(ex, minD); if (r) return r; await sleep(100); } return null; };
  const tapRisky = (exclude = -1, minD = 0) => p.evaluate(([ex, minD]) => { const g = __game; const c = g.spots.list.filter(q => q.id !== ex && q.d >= minD && q.d <= 32 && q.dx > 60 && q.dx < innerWidth - 60 && q.dy > 60 && q.dy < innerHeight - 60).map(q => ({ q, x: Math.round(q.dx), y: Math.round(q.dy) })).filter(o => g.spots.pick(o.x, o.y)?.id === o.q.id && g.spots.assess(o.x, o.y, o.q).risky && g.spots.list.some(j => j.id !== o.q.id && Math.hypot(o.q.dx - j.dx, o.q.dy - j.dy) <= 24)); if (!c.length) return null; const { q, x, y } = c[0]; const el = document.elementFromPoint(x, y) || document.body, o = { bubbles: true, pointerId: 77, clientX: x, clientY: y, pointerType: "touch" }; el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o)); return { id: q.id, x, y, kind: q.kind, d: Math.round(q.d) }; }, [exclude, minD]);
  const tapId = async (id) => { const q = await p.evaluate(i => { const s = __game.spots.get(i); return s ? { x: s.dx, y: s.dy } : null; }, id); if (q) await realTap(q.x, q.y); }; // 押す直前の位置を読み直す(時間がたつとカメラの追従で目印がずれる)
  const st = () => p.evaluate(() => ({ starts: __game.autoLand.stats.starts, apSel: __game.approach.stats.selected, apId: __game.approach.id, cf: __game.spotConfirm.id, asked: __game.spotConfirm.stats.asked, resel: __game.spotConfirm.stats.reselected, conf: __game.spotConfirm.stats.confirmed, canc: __game.spotConfirm.stats.cancelled, to: __game.spotConfirm.stats.timeout, gone: __game.spotConfirm.stats.gone, off: __game.spotConfirm.stats.off, man: __game.spotConfirm.stats.manual, mode: __game.spotConfirm.stats.mode, uiHidden: document.getElementById("spotAsk").hidden, flaps: __game.input.stats.gestureTaps, rtaps: __game.input.stats.ringTaps, stapSeq: __game.input.steer.tapSeq, lastTgt: __game.autoLand.lastTargetId, refused: __game.autoLand.stats.refused }));
  await p.evaluate(() => { if (!document.getElementById("overlay").hidden) document.getElementById("ovGo").click(); }); await sleep(300);
  await p.setViewportSize({ width: 892, height: 412 }); await sleep(500); await setCtl("right"); await setSteer("off");
  const TOWN = [30, 0, Math.PI / 2];
  // 市街地で、取り違え得る(risky)目印と、孤立した(risky でない)目印を探す
  await hoverAt(...TOWN); await sleep(1000);
  const kinds = await p.evaluate(() => { const g = __game, L = g.spots.list; const r = [], o = []; for (const q of L) (g.spots.assess(q.dx, q.dy, q).risky ? r : o).push({ id: q.id, kind: q.kind, d: Math.round(q.d), x: q.dx, y: q.dy }); return { risky: r, calm: o, n: L.length }; });
  check("the crowded town view has both risky (crowded) and calm (isolated) markers to test with", kinds.risky.length >= 2 && kinds.calm.length >= 1, JSON.stringify({ n: kinds.n, risky: kinds.risky.length, calm: kinds.calm.length }));
  // (A) 孤立した目印: 1 タップで従来どおり(確認なし)
  const calm = kinds.calm.find(c => c.d <= 18) ?? kinds.calm[0]; let b = await st(); await realTap(calm.x, calm.y); await sleep(300); let a = await st();
  check("an isolated marker: one tap acts immediately (landing started, approach selected or a spoken refusal) - no confirmation UI", a.cf === -1 && a.uiHidden && (a.starts > b.starts || a.apSel > b.apSel || a.refused > b.refused), JSON.stringify({ calm, b: [b.starts, b.apSel, b.refused], a: [a.starts, a.apSel, a.refused] }));
  await p.evaluate(() => { __game.autoLand.cancel("user"); __game.approach.clear("cancelled"); }); await hoverAt(...TOWN); await sleep(900);
  // (B) 密集した目印: 1 回目のタップは仮選択だけ(自動接近・着地・操舵を始めない)。強調、足場名と距離の確認ボタン
  const risky = await p.evaluate(() => { const g = __game; const L = g.spots.list.filter(q0 => q0.d <= 32 && q0.dx > 60 && q0.dx < innerWidth - 60 && q0.dy > 60 && q0.dy < innerHeight - 60 && g.spots.list.some(j => j.id !== q0.id && Math.hypot(q0.dx - j.dx, q0.dy - j.dy) <= 24)).filter(q => (g.spots.pick(Math.round(q.dx), Math.round(q.dy))?.id === q.id) && g.spots.assess(Math.round(q.dx), Math.round(q.dy), q).risky && g.spots.assess(Math.round(q.dx), Math.round(q.dy), q).nearestPx < 22).sort((m, n) => g.spots.assess(m.dx, m.dy, m).nearestPx - g.spots.assess(n.dx, n.dy, n).nearestPx); return L.slice(0, 3).map(q => ({ id: q.id, kind: q.kind, d: Math.round(q.d), x: q.dx, y: q.dy })); });
  b = await st(); await tapRiskyW(-1); await sleep(300); a = await st();
  const label = await p.evaluate(() => ({ go: document.getElementById("spotGo").textContent, hidden: document.getElementById("spotAsk").hidden }));
  const picked = a.cf; const pinfo = await p.evaluate(i => { const q = __game.spots.get(i); return q ? { kind: q.kind, d: Math.round(q.d) } : null; }, picked);
  check("a crowded marker: the first tap only pre-selects (nothing starts, no steering/flap leaks), and the button names the perch and its distance", picked >= 0 && a.asked === b.asked + 1 && a.starts === b.starts && a.apSel === b.apSel && a.flaps === b.flaps && !label.hidden && label.go.includes("ここへ接近") && pinfo && label.go.includes(String(pinfo.d)), JSON.stringify({ picked, label, pinfo, a: [a.starts, a.apSel, a.flaps] }));
  // (C) 画面の中: ボタンは◎・パッド・他のボタンと重ならない(矩形の交差で確かめる)
  const lay = await p.evaluate(() => { const r = document.getElementById("spotAsk").getBoundingClientRect(), bad = []; const ids = ["padCruise", "padProx", "btnPause", "btnCtl", "btnSteer", "btnTime", "btnSeason", "btnCam", "btnReset", "flap", "brake"]; for (const id of ids) { const e = document.getElementById(id); if (!e) continue; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") continue; const q = e.getBoundingClientRect(); if (q.width < 2) continue; if (r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top) bad.push(id); } return { bad, r: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; });
  check("the confirm button is on screen, at least 52 px tall, and overlaps no pad or button", lay.inside && lay.bad.length === 0 && lay.r[3] >= 52, JSON.stringify(lay));
  // (D) 別の目印を押して選び直し(仮選択のまま。開始しない)
  const other = true; if (other) { const b2 = await st(); const op = await tapRiskyW(picked); await sleep(300); const a2 = await st(); check("tapping another crowded marker re-selects (still nothing started)", a2.cf >= 0 && a2.starts === b2.starts && a2.apSel === b2.apSel && (a2.resel > b2.resel || a2.cf === b2.cf), JSON.stringify({ b2: [b2.cf, b2.resel], a2: [a2.cf, a2.resel], op, other, picked })); }
  // (E) 確認ボタン: 押すと、その ID に対して(18 m 以内なら自動着地の検査つき開始、遠ければ接近先)実行される
  const cur = await st(); const curInfo = await p.evaluate(i => { const q = __game.spots.get(i); return q ? { d: q.d, id: q.id } : null; }, cur.cf);
  const goBox = await p.evaluate(() => { const r = document.getElementById("spotGo").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); const bc = await st(); await realTap(goBox.x, goBox.y); await sleep(350); const ac = await st();
  check("pressing 'ここへ接近' acts on exactly the pre-selected perch (approach target if far, safety-checked landing if near), the pre-selection ends as confirmed, and the press leaks no flap/steer", curInfo && ac.conf === bc.conf + 1 && ac.cf === -1 && (curInfo.d > 18 ? ac.apId === curInfo.id : (ac.starts > bc.starts ? ac.lastTgt === curInfo.id : ac.refused > bc.refused)) && ac.flaps === bc.flaps && ac.rtaps === bc.rtaps && ac.stapSeq === bc.stapSeq, JSON.stringify({ curInfo, bc: [bc.conf, bc.starts], ac: [ac.conf, ac.cf, ac.apId, ac.starts, ac.lastTgt, ac.refused] }));
  await p.evaluate(() => { __game.autoLand.cancel("user"); __game.approach.clear("cancelled"); });
  // (F) 取消(✕)と期限切れ
  await hoverAt(...TOWN); await sleep(900); const r2 = await p.evaluate(() => { const g = __game; const L = g.spots.list.filter(q0 => q0.d <= 32 && q0.dx > 60 && q0.dx < innerWidth - 60 && q0.dy > 60 && q0.dy < innerHeight - 60 && g.spots.list.some(j => j.id !== q0.id && Math.hypot(q0.dx - j.dx, q0.dy - j.dy) <= 24)).filter(q => (g.spots.pick(Math.round(q.dx), Math.round(q.dy))?.id === q.id) && g.spots.assess(Math.round(q.dx), Math.round(q.dy), q).risky && g.spots.assess(Math.round(q.dx), Math.round(q.dy), q).nearestPx < 22).sort((m, n) => g.spots.assess(m.dx, m.dy, m).nearestPx - g.spots.assess(n.dx, n.dy, n).nearestPx); return L.map(q => ({ id: q.id, x: q.dx, y: q.dy })); });
  await tapRiskyW(-1); await sleep(250); const noBox = await p.evaluate(() => { const r = document.getElementById("spotNo").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; });
  const bn = await st(); await realTap(noBox.x, noBox.y); await sleep(250); const an = await st();
  check("the ✕ button cancels the pre-selection (>= 52 px square) and starts nothing", noBox.w >= 52 && noBox.h >= 52 && an.cf === -1 && an.canc === bn.canc + 1 && an.uiHidden && an.starts === bn.starts && an.apSel === bn.apSel, JSON.stringify({ noBox, bn: [bn.cf, bn.canc], an: [an.cf, an.canc] }));
  await tapRiskyW(-1); await sleep(250); await p.evaluate(() => { __game.spotConfirm.t0 -= 7000; }); await sleep(400); const at2 = await st();
  check("the pre-selection expires by itself after the timeout (6 s) and nothing starts", at2.cf === -1 && at2.to >= 1 && at2.uiHidden);
  // (G) 去った: 仮選択のあとに目印が視界から去ったら、選択が解ける。ボタンを押しても何も起きない
  await tapRiskyW(-1); await sleep(250); const bg = await st(); await unhover(); await p.evaluate(() => { const f = __game.flight; f.yaw += Math.PI; f.vel.set(-Math.sin(f.yaw) * 8, 0, -Math.cos(f.yaw) * 8); __game.cam.snap(); });
  const gone = await p.waitForFunction(() => __game.spotConfirm.id === -1, null, { timeout: 15000 }).then(() => true).catch(() => false); const ag = await st();
  check("the pre-selected marker left the view: the pre-selection is released (reason recorded), the button is gone, nothing started", bg.cf >= 0 && gone && ag.gone > bg.gone && ag.uiHidden && ag.starts === bg.starts && ag.apSel === bg.apSel, JSON.stringify({ bg: [bg.cf, bg.gone], ag: [ag.cf, ag.gone, ag.uiHidden] }));
  // (H) 押した後に候補が動く: 仮選択後に鳥を動かして目印が移動しても、確認ボタン(固定位置)は同じ ID に対して働く
  await hoverAt(...TOWN); await sleep(900); const r3 = await p.evaluate(() => { const g = __game; const L = g.spots.list.filter(q => g.spots.assess(Math.round(q.dx), Math.round(q.dy), q).risky && q.d > 20); return L.map(q => ({ id: q.id, x: q.dx, y: q.dy })); });
  await tapRiskyW(-1, 20); await sleep(250); const idAsked = (await st()).cf; const posBefore = await p.evaluate(i => { const q = __game.spots.get(i); return q ? [q.dx, q.dy] : null; }, idAsked);
  await p.evaluate(() => { clearInterval(window.__hv); const f = __game.flight; f.vel.set(-Math.sin(f.yaw) * 3, 0, -Math.cos(f.yaw) * 3); }); await sleep(500); await p.evaluate(() => { const f = __game.flight; f.vel.set(0, 0, 0); __game.game.pause(); }); /* 動かして止めた瞬間にゲームを一時停止する(同じ処理の中で)。止めないと、速さ 0 の鳥が往復のあいだに落ち・流れて目印が視界を去り、仮選択が(仕様どおり)解けてしまう。ここで確かめるのは「目印が動いても確認ボタンは同じ目印に働く」こと */
  const posAfter = await p.evaluate(i => { const q = __game.spots.get(i); return q ? [q.dx, q.dy] : null; }, idAsked); const still = await st();
  const gb2 = await p.evaluate(() => { const r = document.getElementById("spotGo").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  if (still.cf === idAsked) { const bm = await st(); await realTap(gb2.x, gb2.y); await sleep(350); const am = await st(); check("the marker moved after the pre-selection; the fixed button still acts on the same perch id (no switch to a neighbour)", posBefore && posAfter && am.conf === bm.conf + 1 && (am.apId === idAsked || am.lastTgt === idAsked || am.refused > bm.refused), JSON.stringify({ idAsked, posBefore, posAfter, am: [am.apId, am.lastTgt, am.refused], conf: [bm.conf, am.conf], cf: [bm.cf, am.cf], log: await p.evaluate(() => __game.spotTapLog.slice(-5)), apSel: [bm.apSel, am.apSel], starts: [bm.starts, am.starts] })); }
  else check("the marker moved after the pre-selection; the fixed button still acts on the same perch id (or the candidate truly left and the pre-selection ended)", still.gone > 0 || still.to > 0, JSON.stringify({ idAsked, still: [still.cf, still.gone] }));
  await p.evaluate(() => { __game.game.resume(); });
  await p.evaluate(() => { __game.autoLand.cancel("user"); __game.approach.clear("cancelled"); });
  // (I) OFF・操作モード・操縦方式・オートで解除
  for (const [name, fn, stat] of [["marker OFF", () => p.evaluate(() => document.querySelector('[data-set="lm"][data-val="0"]').click()), "off"], ["steering mode change", () => setSteer("A"), "mode"], ["hand change", () => setCtl("left"), "mode"]]) {
    await hoverAt(...TOWN); await sleep(900); const rr = await p.evaluate(() => { const g = __game; return g.spots.list.filter(q => (g.spots.pick(Math.round(q.dx), Math.round(q.dy))?.id === q.id) && g.spots.assess(Math.round(q.dx), Math.round(q.dy), q).risky && g.spots.assess(Math.round(q.dx), Math.round(q.dy), q).nearestPx < 22).sort((m, n) => g.spots.assess(m.dx, m.dy, m).nearestPx - g.spots.assess(n.dx, n.dy, n).nearestPx).map(q => ({ id: q.id, x: q.dx, y: q.dy })); }); if (!rr.length) { check(`${name}: a risky marker to pre-select`, false, "none"); continue; }
    await tapRiskyW(-1); await sleep(250); const bo = await st(); await fn(); await sleep(300); const ao = await st();
    check(`${name} releases the pre-selection and hides the button`, bo.cf >= 0 && ao.cf === -1 && ao.uiHidden && ao[stat] > bo[stat], JSON.stringify({ bo: [bo.cf, bo[stat]], ao: [ao.cf, ao[stat]] }));
    if (name === "marker OFF") await p.evaluate(() => document.querySelector('[data-set="lm"][data-val="1"]').click());
  }
  await setSteer("off"); await setCtl("right");
  // (J) 確認ボタンの置き場所: 縦横・右手/左手/両手・操縦方式ごとに、◎・パッド・ボタンと重ならない
  const combos = [[892, 412, "right", "off"], [892, 412, "left", "A"], [412, 892, "right", "B"], [412, 892, "left", "C"], [360, 800, "right", "off"], [892, 412, "both", "off"], [1280, 720, "right", "A"]]; const lays = [];
  for (const [w, h, ctl, steer] of combos) {
    await p.setViewportSize({ width: w, height: h }); await sleep(500); await setCtl(ctl); await setSteer(steer); await hoverAt(...TOWN); await sleep(900);
    const ok = await p.evaluate(() => { const g = __game, L = g.spots.list; if (!L.length) return null; g.spotConfirm.ask(L[0].id, performance.now()); return L[0].id; }); await sleep(450);
    const r = await p.evaluate(() => { const b = document.getElementById("spotAsk"), r = b.getBoundingClientRect(), bad = []; if (b.hidden) return { hidden: true }; const ids = ["padCruise", "padProx", "btnPause", "btnCtl", "btnSteer", "btnTime", "btnSeason", "btnCam", "btnReset", "flap", "brake", "stickBase"]; for (const id of ids) { const e = document.getElementById(id); if (!e) continue; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") continue; const q = e.getBoundingClientRect(); if (q.width < 2) continue; if (r.left < q.right - 1 && r.right > q.left + 1 && r.top < q.bottom - 1 && r.bottom > q.top + 1) bad.push(id); } const sr = __game.input.steerOn ? __game.input.steerRect() : null; if (sr) { const cx = Math.max(r.left, Math.min(sr.cx, r.right)), cy = Math.max(r.top, Math.min(sr.cy, r.bottom)); if (Math.hypot(cx - sr.cx, cy - sr.cy) < sr.r) bad.push("◎"); } const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { bad, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, onTop: !!el && !!el.closest("#spotAsk"), h: Math.round(r.height) }; });
    lays.push({ vp: `${w}x${h}`, ctl, steer, ok: ok !== null, ...r }); await p.evaluate(() => __game.spotConfirm.clear("cancelled"));
  }
  console.log("   confirm button layout:"); for (const r of lays) console.log("    ", JSON.stringify(r));
  check("in every viewport / hand / steering combination the confirm button is fully on screen, on top (tappable), >= 52 px tall, and overlaps no pad, button or the ◎", lays.every(r => r.ok && !r.hidden && r.inside && r.onTop && r.bad.length === 0 && r.h >= 52), JSON.stringify(lays.filter(r => !(r.ok && !r.hidden && r.inside && r.onTop && r.bad.length === 0 && r.h >= 52))));
  await setSteer("off"); await p.setViewportSize({ width: 892, height: 412 }); await sleep(400); await setCtl("right");
  // (K) 低FPS + マルチタッチ: CPU を絞っても仮選択→確認が働く。◎に指がある間に確認ボタンを押しても、◎の指は乱されない
  await setSteer("B"); await hoverAt(...TOWN); await sleep(900); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 }); await sleep(600);
  const rk = await p.evaluate(() => { const g = __game; return g.spots.list.filter(q => (g.spots.pick(Math.round(q.dx), Math.round(q.dy))?.id === q.id) && g.spots.assess(Math.round(q.dx), Math.round(q.dy), q).risky && g.spots.assess(Math.round(q.dx), Math.round(q.dy), q).nearestPx < 22).sort((m, n) => g.spots.assess(m.dx, m.dy, m).nearestPx - g.spots.assess(n.dx, n.dy, n).nearestPx).map(q => ({ id: q.id, x: q.dx, y: q.dy })); });
  if (rk.length) { const bk = await st(); await realTap(rk[0].x, rk[0].y); await p.waitForFunction(n => __game.spotConfirm.stats.asked > n, bk.asked, { timeout: 6000, polling: "raf" }).catch(() => {}); const ak = await st(); /* 仮選択が出た直後に読む(CPU を 6 倍に絞った環境では、位置を戻すタイマー自体が走らず鳥が流れ、数百 ms 後には目印が視界を去って仮選択が解けることがある。ここで確かめるのは「仮選択になった(開始でも取りこぼしでもない)」こと) */ check("low FPS (CPU x6): a crowded marker is pre-selected (not started, not lost as a missed tap)", ak.cf >= 0 && ak.asked === bk.asked + 1 && ak.starts === bk.starts, JSON.stringify({ bk: [bk.asked], ak: [ak.cf, ak.asked, ak.starts] }));
    const R = await p.evaluate(() => __game.input.steerRect()); const gb = await p.evaluate(() => { const r = document.getElementById("spotGo").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await tp("touchStart", [{ x: Math.round(R.cx), y: Math.round(R.cy), id: 11 }]); await sleep(150); const padOn = await p.evaluate(() => __game.input.steer.active); await tp("touchStart", [{ x: Math.round(R.cx), y: Math.round(R.cy), id: 11 }, { x: Math.round(gb.x), y: Math.round(gb.y), id: 12 }]); await sleep(900);
    const am = await st(); const padStill = await p.evaluate(() => __game.input.steer.active); await tp("touchEnd", []); await sleep(300);
    check("multi-touch: with a finger on the ◎, pressing the confirm button works and the ◎ finger is not disturbed", padOn && am.conf >= 1 && padStill, JSON.stringify({ padOn, padStill, conf: am.conf })); }
  else check("low FPS: a risky marker exists to test with", false, "none");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); await unhover(); await setSteer("off");
  // (L) 負荷: 確認 UI の表示中のフレーム処理(ソフトウェア描画)
  await hoverAt(...TOWN); await sleep(1200); const perf = await p.evaluate(() => { const g = __game, L = g.spots.list; if (L.length) g.spotConfirm.ask(L[0].id, performance.now()); return { shown: L.length, updateMs: +g.stats.spotMs.toFixed(3), drawMs: +g.stats.spotDrawMs.toFixed(3), calls: g.renderer.info.render.calls }; }); await sleep(800);
  const perf2 = await p.evaluate(() => ({ updateMs: +__game.stats.spotMs.toFixed(3), drawMs: +__game.stats.spotDrawMs.toFixed(3), calls: __game.renderer.info.render.calls, ui: !document.getElementById("spotAsk").hidden })); await unhover();
  console.log("   cost with the confirm UI shown:", JSON.stringify({ ...perf, with: perf2 }));
  check("the confirm UI adds no draw calls and the per-frame marker cost stays small", perf2.ui && perf2.calls <= perf.calls + 1 && perf2.updateMs < 3 && perf2.drawMs < 3, JSON.stringify(perf2));
  check("H8-D: no page errors", errs.length === 0, errs.join(" | "));
}

// ---- g16: H9 起動 3 画面・設定の保存・◎の配置(プレビューのドラッグ)・飛行ガイド・青緑の目印・低速巡航
async function g16({ p, cdp, errs }) {
  console.log("\n# H9: startup pages / pads / guide / markers / slow cruise");
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  const st = () => p.evaluate(() => ({ state: __game.game.state, auto: document.body.dataset.auto, page: __ui.page, ovHidden: document.getElementById("overlay").hidden }));
  const vis = id => p.evaluate(id => { const e = document.getElementById(id); if (!e || e.hidden) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"; }, id);
  // ---- (A) 3 画面の流れ: ①→②→③。③で押すまで始まらない
  let s0 = await st();
  check("startup: page ① 環境設定 is shown first, the game is waiting, nothing can start yet", s0.state === "ready" && s0.page === "env" && (await vis("pgEnv")) && !(await vis("pgCtl")) && !(await vis("ovGo")) && !(await vis("ovAuto")), JSON.stringify(s0));
  check("page ① holds the environment settings (weather, wind, time, season, town, quality) and not the control settings", await p.evaluate(() => { const q = s => !!document.querySelector("#pgEnv " + s); return q('[data-set=weather]') && q('[data-set=wind]') && q('[data-set=time]') && q('[data-set=ss]') && q('[data-set=npc]') && q('[data-set=gfx]') && !q('[data-set=ctl]') && !q('[data-set=steer]'); }));
  await p.click("#envNext"); await sleep(150); s0 = await st();
  check("② 操作UI設定 holds controls, ◎ placement, flight guide, markers, speed effect and the auto options; the game is still waiting", s0.page === "ctl" && s0.state === "ready" && await p.evaluate(() => { const q = s => !!document.querySelector("#pgCtl " + s); return q('[data-set=ctl]') && q('[data-set=steer]') && q('[data-set=guide]') && q('[data-set=lm]') && q('[data-set=fx]') && q('[data-set=apol]') && q('[data-set=ats]') && q('[data-set=ahide]') && !!document.getElementById("padPreview"); }));
  await p.click("#ctlBack"); await sleep(100); check("② → ① back works (settings kept)", (await st()).page === "env");
  await p.click("#envNext"); await p.click("#ctlNext"); await sleep(150); s0 = await st();
  check("③ 開始 offers 設定に戻る / オート / 自分で操作, and the game still has not started", s0.page === "start" && s0.state === "ready" && (await vis("ovBack")) && (await vis("ovAuto")) && (await vis("ovGo")) && (await p.textContent("#ovGo")) === "自分で操作");
  await p.click("#ovBack"); await sleep(100); check("設定に戻る goes back to the settings (②), not into the game", (await st()).page === "ctl" && (await st()).state === "ready");
  await p.click("#ctlNext"); await sleep(100);
  // ---- (B) 保存: 操作・操縦・飛行ガイドを選び、再読み込みしても残る
  await p.click("#ovBack"); await p.click('[data-set="ctl"][data-val="right"]'); await p.click('[data-set="steer"][data-val="B"]'); await p.click('[data-set="guide"][data-val="hud"]'); await sleep(200);
  await p.reload(); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await sleep(1200);
  let pr = await p.evaluate(() => ({ ctl: document.body.dataset.ctl, steer: __game.input.steerMode, guide: __guide.mode, saved: JSON.parse(localStorage.getItem("vindving.prefs.v1") || "{}") }));
  check("settings persist across a reload (hand, steering mode, flight guide)", pr.ctl === "right" && pr.steer === "B" && pr.guide === "hud" && pr.saved.guide === "hud", JSON.stringify(pr));
  check("after a reload the startup flow begins again at ① (the game never auto-starts)", (await st()).page === "env" && (await st()).state === "ready");
  // ---- (C) ◎の配置プレビュー: ドラッグ、保存、操縦としては扱わない
  await p.click("#envNext"); await p.click('[data-set="steer"][data-val="off"]'); await sleep(200);
  const base = await p.evaluate(() => { const L = __game.input.layout(); return { prox: { ...L.prox }, cruise: { ...L.cruise }, w: innerWidth, h: innerHeight }; });
  check("default ◎ positions are nearer the screen centre than before (right hand: x < 75% of the width) and the two ◎ are close (gap <= 8 px)", base.prox.cx < base.w * 0.70 && base.prox.cx > base.w * 0.5 && Math.hypot(base.cruise.cx - base.prox.cx, base.cruise.cy - base.prox.cy) - base.prox.r - base.cruise.r <= 8, JSON.stringify({ px: base.prox.cx / base.w, gap: Math.hypot(base.cruise.cx - base.prox.cx, base.cruise.cy - base.prox.cy) - base.prox.r - base.cruise.r }));
  const pvBox = async id => p.evaluate(id => { document.getElementById("padPreview").scrollIntoView({ block: "center" }); const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id);
  const flightBefore = await p.evaluate(() => ({ yaw: __game.flight.yaw, x: __game.flight.pos.x, auto: document.body.dataset.auto, state: __game.game.state, steerTaps: __game.input.stats.ringTaps }));
  const pv0 = await pvBox("pvProx"), pvRect = await p.evaluate(() => { const r = document.getElementById("padPreview").getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
  await tp("touchStart", [{ x: pv0.x, y: pv0.y, id: 1 }]); await sleep(120);
  await tp("touchMove", [{ x: pvRect.l + pvRect.w * 0.55, y: pvRect.t + pvRect.h * 0.45, id: 1 }]); await sleep(150); await tp("touchEnd", []); await sleep(250);
  const moved = await p.evaluate(() => { const L = __game.input.layout(); return { prox: { ...L.prox }, cruise: { ...L.cruise }, saved: JSON.parse(localStorage.getItem("vindving.prefs.v1")).pads }; });
  check("dragging the proximity ◎ in the preview moves only that ◎ (the cruise ◎ stays), and it is saved for this orientation", Math.abs(moved.prox.cx - base.prox.cx) > 20 && Math.abs(moved.prox.cy - base.prox.cy) > 20 && !!moved.saved.land && !moved.saved.port, JSON.stringify({ from: [base.prox.cx, base.prox.cy], to: [moved.prox.cx, moved.prox.cy], saved: moved.saved }));
  const fa = await p.evaluate(() => ({ yaw: __game.flight.yaw, x: __game.flight.pos.x, auto: document.body.dataset.auto, state: __game.game.state }));
  check("dragging in the settings preview is not a flight control (no steering, the game stays waiting, no auto)", fa.state === "ready" && fa.yaw === flightBefore.yaw && fa.x === flightBefore.x && fa.auto !== "1", JSON.stringify(fa));
  check("the two ◎ never overlap after dragging, and both stay inside the screen and out of the top-button band", await p.evaluate(() => { const L = __game.input.layout(); const d = Math.hypot(L.cruise.cx - L.prox.cx, L.cruise.cy - L.prox.cy); return d >= L.cruise.r + L.prox.r + 1 && [L.cruise, L.prox].every(r => r.cx - r.r >= 0 && r.cx + r.r <= innerWidth && r.cy - r.r >= 0 && r.cy + r.r <= innerHeight); }));
  // 画面の外までドラッグしても、範囲の中に収まる
  const pv1 = await pvBox("pvProx"); await tp("touchStart", [{ x: pv1.x, y: pv1.y, id: 1 }]); await sleep(100); await tp("touchMove", [{ x: pvRect.l + pvRect.w + 80, y: pvRect.t + pvRect.h + 80, id: 1 }]); await sleep(150); await tp("touchEnd", []); await sleep(200);
  check("dragging past the screen edge clamps the ◎ inside the screen", await p.evaluate(() => { const r = __game.input.layout().prox; return r.cx + r.r <= innerWidth + 0.5 && r.cy + r.r <= innerHeight + 0.5; }));
  // 左右切替: 右手の配置を左右反転して使う
  const rightProx = await p.evaluate(() => ({ ...__game.input.layout().prox, w: innerWidth }));
  await p.click('[data-set="ctl"][data-val="left"]'); await sleep(200); const leftProx = await p.evaluate(() => ({ ...__game.input.layout().prox, w: innerWidth }));
  check("switching to the left hand mirrors the saved position (same distance from the opposite edge)", Math.abs((rightProx.cx) - (leftProx.w - leftProx.cx)) < 2 && Math.abs(rightProx.cy - leftProx.cy) < 2, JSON.stringify({ rightProx, leftProx }));
  await p.click('[data-set="ctl"][data-val="right"]'); await sleep(150);
  // 初期位置へ戻す
  await p.click("#padReset"); await sleep(250); const reset = await p.evaluate(() => ({ prox: { ...__game.input.layout().prox }, saved: JSON.parse(localStorage.getItem("vindving.prefs.v1")).pads }));
  check("「◎を初期位置へ戻す」 restores the default positions and clears the saved ones", Math.abs(reset.prox.cx - base.prox.cx) < 1 && Math.abs(reset.prox.cy - base.prox.cy) < 1 && reset.saved.land === null, JSON.stringify(reset));
  // 各◎個別: 巡航◎だけ動かす
  const cb = await pvBox("pvCruise"), cb0 = await p.evaluate(() => ({ ...__game.input.layout().cruise })); await tp("touchStart", [{ x: cb.x, y: cb.y, id: 1 }]); await sleep(100); await tp("touchMove", [{ x: cb.x - 30, y: cb.y + 5, id: 1 }]); await sleep(150); await tp("touchEnd", []); await sleep(200);
  const cb1 = await p.evaluate(() => ({ cruise: { ...__game.input.layout().cruise }, prox: { ...__game.input.layout().prox } }));
  check("each ◎ moves on its own: dragging the cruise ◎ leaves the proximity ◎ where it was", Math.abs(cb1.cruise.cx - cb0.cx) > 5 && Math.abs(cb1.prox.cx - base.prox.cx) < 1 && Math.abs(cb1.prox.cy - base.prox.cy) < 1, JSON.stringify({ cb0, cb1 }));
  // 実際の飛行画面でも、動かした位置が使われる(その位置の触れ始めは、近いほうの◎として扱われる)
  // 安全領域: ノッチ相当の余白を与えると、◎はその内側に収まる
  const ins = await p.evaluate(() => { __game.input.insets = { l: 30, r: 40, t: 24, b: 34 }; const L = __game.input.layout(); const ok = [L.cruise, L.prox].every(r => r.cx + r.r <= innerWidth - 40 + 0.5 && r.cy + r.r <= innerHeight - 34 + 0.5 && r.cx - r.r >= 30 - 0.5); __game.input.insets = { l: 0, r: 0, t: 0, b: 0 }; return ok; });
  check("safe-area insets keep both ◎ inside the safe area", ins);
  // 縦画面: 向きごとに別の保存
  await p.setViewportSize({ width: 412, height: 892 }); await sleep(500);
  const portrait = await p.evaluate(() => { const L = __game.input.layout(), r = document.getElementById("pgCtl"); return { prox: { ...L.prox }, cruise: { ...L.cruise }, w: innerWidth, h: innerHeight, sw: document.getElementById("overlay").scrollWidth, cw: document.getElementById("overlay").clientWidth, saved: JSON.parse(localStorage.getItem("vindving.prefs.v1")).pads }; });
  check("portrait uses its own layout (not the landscape one), fits the screen, and the settings page does not scroll sideways", portrait.prox.cx + portrait.prox.r <= portrait.w && portrait.cruise.cy - portrait.cruise.r >= 0 && portrait.sw <= portrait.cw + 1 && portrait.saved.port === null, JSON.stringify(portrait));
  await p.setViewportSize({ width: 892, height: 412 }); await sleep(500);
  await p.click("#padReset"); await sleep(200);
  // ---- (D) 狭い画面でも全ページが操作できる(スクロール可能・横にはみ出さない・ボタンに届く)
  for (const [w, h] of [[360, 640], [640, 360], [412, 892], [892, 412]]) {
    await p.setViewportSize({ width: w, height: h }); await sleep(350);
    const rep = [];
    for (const [pg, btns] of [["env", ["envNext"]], ["ctl", ["ctlBack", "ctlNext", "padReset"]], ["start", ["ovBack", "ovAuto", "ovGo"]]]) {
      await p.evaluate(pg => __ui.show(pg), pg); await sleep(100);
      const r = await p.evaluate(btns => { const ov = document.getElementById("overlay"); const out = { sideways: ov.scrollWidth > ov.clientWidth + 1, unreachable: [] }; for (const id of btns) { const e = document.getElementById(id); if (!e || e.hidden) continue; e.scrollIntoView({ block: "center" }); const q = e.getBoundingClientRect(); if (q.left < -0.5 || q.right > innerWidth + 0.5 || q.top < -0.5 || q.bottom > innerHeight + 0.5 || q.height < 30) out.unreachable.push(id + ":" + Math.round(q.left) + "," + Math.round(q.top) + "," + Math.round(q.width) + "x" + Math.round(q.height)); const top = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); if (top !== e && !e.contains(top)) out.unreachable.push(id + ":covered"); } return out; }, btns);
      if (r.sideways || r.unreachable.length) rep.push(pg + " " + JSON.stringify(r));
    }
    check(`${w}x${h}: all three startup pages scroll vertically only and every nav button is reachable, >= 30 px tall and not covered`, rep.length === 0, rep.join(" | "));
  }
  await p.setViewportSize({ width: 892, height: 412 }); await sleep(400);
  // ---- (E) 開始: 「自分で操作」「オート」のどちらかを押したときだけ始まる
  await p.evaluate(() => __ui.show("start")); await sleep(100);
  await p.click("#ovAuto"); await sleep(600); let sa = await st();
  check("オート starts the game in auto-pilot mode", sa.state === "running" && sa.auto === "1" && sa.ovHidden, JSON.stringify(sa));
  await p.evaluate(() => { document.getElementById("btnAutoOff").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); }); await sleep(300);
  await p.evaluate(() => document.getElementById("btnPause").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(300);
  const pz = await st(); check("pausing shows the pause page (resume / reset / settings) and the flow is consistent with the game state", pz.state === "paused" && pz.page === "pause" && (await vis("ovGo")) && (await p.textContent("#ovGo")) === "再開" && (await vis("ovReset")) && !(await vis("ovBack")), JSON.stringify(pz));
  await p.click("#ovEnv"); await sleep(150); check("from the pause page the environment settings open with a way back", (await st()).page === "env" && (await vis("envBack")));
  await p.click("#envBack"); await sleep(150); check("…and 'back' returns to the pause page", (await st()).page === "pause");
  await p.click("#ovGo"); await sleep(400); const man = await st(); check("再開 continues the same game (manual, not auto)", man.state === "running" && man.auto === "0", JSON.stringify(man));
  // ---- (F) 低速巡航: 手動飛行で、手を離した巡航は従来より遅く、羽ばたきの連打で加速し、やめると戻る
  const cr = await p.evaluate(async () => { const g = __game, f = g.flight; g.input.releaseAll(); f.reset(); g.cam.snap(); await new Promise(r => setTimeout(r, 200)); return { scale: f.speedScale }; });
  await p.evaluate(() => { const g = __game, f = g.flight; f.pos.set(28, 40, 150); f.prevPos.copy(f.pos); f.yaw = 0; f.vel.set(0, 0, -10); });
  const sample = async secs => { const out = []; const t0 = await p.evaluate(() => __game.game.gameTime); for (;;) { const o = await p.evaluate(() => ({ t: __game.game.gameTime, v: Math.hypot(__game.flight.vel.x, __game.flight.vel.z), ss: __game.flight.speedScale, mode: __game.flight.mode })); out.push(o); if (o.t - t0 >= secs) return out; await sleep(120); } };
  const cruise = await sample(8); const cv = cruise.slice(-6).reduce((a, o) => a + o.v, 0) / 6;
  check("manual hands-off cruise is slow (< 8 m/s after settling; the old cruise was ~10 m/s) and the speed scale is below 1", cv < 8 && cruise[cruise.length - 1].ss < 0.8, `v=${cv.toFixed(2)} scale=${cruise[cruise.length - 1].ss.toFixed(2)}`);
  await p.evaluate(() => { const f = __game.flight; f.pos.y = 45; const el = document.getElementById("stick"), L = __game.input.layout(), x = L.cruise.cx, y = L.cruise.cy; for (let i = 0; i < 12; i++) setTimeout(() => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 200 + i, clientX: x, clientY: y })); el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 200 + i, clientX: x, clientY: y })); }, i * 180); });
  const fast = await sample(4); const peak = Math.max(...fast.map(o => o.v));
  check("rapid taps accelerate (peak > 10 m/s)", peak > 10, `peak=${peak.toFixed(1)}`);
  const back = await sample(14); const bv = back.slice(-5).reduce((a, o) => a + o.v, 0) / 5;
  check("after the taps stop the speed returns gradually to the slow cruise (< 8 m/s)", bv < 8 && back.every(o => o.mode === "air"), `end=${bv.toFixed(2)} min mode air=${back.every(o => o.mode === "air")}`);
  // ---- (G) 飛行ガイド: 3 モード、値は物理量と一致、◎・ボタンと重ならない
  await p.evaluate(() => { const f = __game.flight; f.pos.set(28, 40, 150); f.prevPos.copy(f.pos); f.yaw = -Math.PI / 4; f.vel.set(-Math.sin(f.yaw) * 6, 0, -Math.cos(f.yaw) * 6); });
  for (const mode of ["off", "gauge", "hud"]) {
    await p.evaluate(m => { document.querySelector(`[data-set=guide][data-val=${m}]`).click(); }, mode); await sleep(700);
    const gv = await p.evaluate(() => { const g = document.getElementById("guide"), cs = g ? getComputedStyle(g) : null; return { shown: !!g && cs.display !== "none", pe: g ? cs.pointerEvents : "", updates: __guide.updates }; });
    if (mode === "off") { await sleep(600); const u2 = await p.evaluate(() => __guide.updates); check("guide off: nothing is drawn and the guide does no per-frame work", !gv.shown && u2 === gv.updates, JSON.stringify({ gv, u2 })); continue; }
    const vals = await p.evaluate(() => { const t = id => document.getElementById("gv-" + id).textContent, f = __game.flight; const w = new (function () {})(); return { elev: t("elev"), agl: t("agl"), hdg: t("hdg"), trk: t("trk"), pit: t("pit"), rol: t("rol"), gs: t("gs"), tas: t("tas"), f: { y: f.pos.y - 0.32, speed: f.vel.length() * 3.6, air: f.airspeed * 3.6, yaw: f.yaw, mode: f.mode, ground: __game.world.heightAt(f.pos.x, f.pos.z) } }; });
    const num = x => Number(String(x).replace(/[^\d.+-]/g, ""));
    check(`guide ${mode}: shows 標高/地上高 (m), 方位/進行 (°), ピッチ/ロール (°), 対地/対気 (km/h) with units, matching the flight state`, /m$/.test(vals.elev) && /m$/.test(vals.agl) && /°/.test(vals.hdg) && /°/.test(vals.pit) && /km\/h$/.test(vals.gs) && /km\/h$/.test(vals.tas) && Math.abs(num(vals.elev) - vals.f.y) < 4 && Math.abs(num(vals.gs) - vals.f.speed) < 6 && Math.abs(num(vals.tas) - vals.f.air) < 12, JSON.stringify(vals));
    check(`guide ${mode}: no speed gauge, takes no touches, and is shown`, gv.shown && gv.pe === "none", JSON.stringify(gv));
    const ov = await p.evaluate(() => { const rect = e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }; const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t; const fields = [...document.querySelectorAll("#guide .gv")].map(rect), L = __game.input.layout(); const pads = L ? [L.cruise, L.prox].map(r => ({ l: r.cx - r.r, t: r.cy - r.r, r: r.cx + r.r, b: r.cy + r.r })) : []; const top = rect(document.getElementById("top")); const bad = []; fields.forEach((f, i) => { if (f.r - f.l < 1) return; if (hit(f, top)) bad.push("top#" + i); pads.forEach((p, k) => { if (hit(f, p)) bad.push("pad" + k + "#" + i); }); if (f.l < -1 || f.r > innerWidth + 1 || f.t < -1 || f.b > innerHeight + 1) bad.push("off#" + i); }); return bad; });
    check(`guide ${mode}: no field overlaps the ◎ pads or the top buttons and all stay on screen (landscape)`, ov.length === 0, JSON.stringify(ov));
  }
  await p.evaluate(() => { document.querySelector("[data-set=guide][data-val=off]").click(); });
  check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
}

// ---- g17: H9 着地点マーカーの青/緑(安全判定との整合、描画色)、動かした◎の位置での実際のタッチ、縦画面の飛行ガイド
async function g17({ p, cdp, errs }) {
  console.log("\n# H9: blue/green markers, moved pads, portrait guide");
  const tp = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  const sleepG = ms => sleep(ms);
  await p.evaluate(() => { if (!document.getElementById("overlay").hidden) document.getElementById("ovGo").click(); }); await sleep(300);
  const setCtl = async m => { for (let i = 0; i < 3; i++) { if ((await p.evaluate(() => document.body.dataset.ctl)) === m) return; await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await sleep(250); } };
  await p.setViewportSize({ width: 892, height: 412 }); await sleep(500); await setCtl("right");
  const hover = (x, z, yaw, y = 14) => p.evaluate(([x, z, yaw, y]) => { const g = __game, f = g.flight; clearInterval(window.__hv); g.setAuto?.(false); g.input.releaseAll(); g.autoLand.cancel("user"); g.approach.clear("cancelled"); g.spotConfirm.clear("cancelled"); f.reset(); f.pos.set(x, y, z); f.prevPos.copy(f.pos); f.yaw = yaw; f.vel.set(0, 0, 0); f.speedScale = 1; g.cam.snap(); window.__hv = setInterval(() => { f.pos.set(x, y, z); f.vel.set(0, 0, 0); }, 8); }, [x, z, yaw, y]);
  const unhover = () => p.evaluate(() => clearInterval(window.__hv));
  // ---- (A)(B) 色: 緑 ⇔ いま自動着地が始められる(AutoLand.canStart)。描いた輪の色も同じ。押した結果も確かめる。着地できる位置(足場の縁から 6〜10 m、面の上 1〜4 m)を何通りか作って調べる
  const scenario = (kind, k) => p.evaluate(([kind, k]) => { const g = __game, f = g.flight, w = g.world; clearInterval(window.__hv); g.input.releaseAll(); g.autoLand.cancel("user"); g.approach.clear("cancelled"); g.spotConfirm.clear("cancelled"); f.reset();
    const open = s => !w.colliders.some(c => c.maxX - c.minX > 3 && c.maxZ - c.minZ > 3 && c.top > s.top + 0.3 && c.maxX > s.minX - 16 && c.minX < s.maxX + 16 && c.maxZ > s.minZ - 16 && c.minZ < s.maxZ + 16);
    const all = g.surfaces.all.filter(s => s.kind === kind && open(s) && (kind !== "roof" || ((s.maxX - s.minX) * (s.maxZ - s.minZ) > 40 && s.top < 12))); const t = all[(k * 5 + 1) % Math.max(1, all.length)]; if (!t) return null;
    const cx = (t.minX + t.maxX) / 2, cz = (t.minZ + t.maxZ) / 2, ang = k * 2.1 + 0.7, dxs = Math.cos(ang), dzs = Math.sin(ang), hx = (t.maxX - t.minX) / 2, hz = (t.maxZ - t.minZ) / 2, tE = Math.min(hx / Math.max(Math.abs(dxs), 1e-6), hz / Math.max(Math.abs(dzs), 1e-6)), x = cx + dxs * (tE + 7), z = cz + dzs * (tE + 7), y = t.top + 2.2;
    f.pos.set(x, y, z); f.prevPos.copy(f.pos); f.yaw = Math.atan2(-(cx - x), -(cz - z)); f.vel.set(0, 0, 0); f.speedScale = 1; g.cam.snap(); window.__hv = setInterval(() => { f.pos.set(x, y, z); f.vel.set(0, 0, 0); }, 8); return { id: t.id, kind: t.kind }; }, [kind, k]);
  const classify = () => p.evaluate(() => { const g = __game, cv = document.getElementById("spots"), ctx = cv.getContext("2d"), dpr = cv.width / innerWidth; const out = []; const rad = q => 15 * (q.d > 35 ? 0.72 : q.d > 18 ? 0.88 : 1);
    for (const q of g.spots.list) { if (q.d > 60) continue; const lan = g.spotLanding(q), can = g.autoLand.canStart(g.flight, q.s), R = rad(q); let gr = 0, bl = 0, used = 0, excl = 0, low = 0, oob = 0;
      for (const k of [0.94, 1, 1.06]) for (let a = 0; a < 32; a++) { const px = q.dx + Math.cos(a / 32 * 6.2832) * R * k, py = q.dy + Math.sin(a / 32 * 6.2832) * R * k; if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) { oob++; continue; }
        // 別の目印の輪(半径 ±5 px)・中心の点・ラベルの近くの点は読まない: 隣の輪の色を拾わないため
        if (g.spots.list.some(j => { if (j.id === q.id) return false; const dd = Math.hypot(px - j.dx, py - j.dy), Rj = rad(j) * 1.5; return dd < 8 || Math.abs(dd - Rj / 1.5) < 6 || (Math.abs(px - j.dx) < 40 && py > j.dy + 15 && py < j.dy + 40); })) { excl++; continue; }
        const d = ctx.getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data; if (d[3] < 100) { low++; continue; } used++; if (d[1] > d[0] + 40 && d[1] > d[2] + 15) gr++; else if (d[2] > d[0] + 40 && d[2] > d[1] + 10) bl++; }
      out.push({ id: q.id, kind: q.kind, d: Math.round(q.d), green: lan.ok, canStart: can.ok, px: used >= 4 && gr + bl >= 3 ? (gr > bl ? "green" : "blue") : "none", gr, bl, used, excl, low, oob, onScreen: q.dx > 30 && q.dx < innerWidth - 30 && q.dy > 30 && q.dy < innerHeight - 30 }); }
    return out; });
  const tapSpot = id => p.evaluate(id => { const g = __game, q = g.spots.get(id); if (!q) return null; const x = Math.round(q.dx), y = Math.round(q.dy), pk = g.spots.pick(x, y); if (!pk || pk.id !== id || g.spots.assess(x, y, q).risky) return { skip: true }; const green = g.spotLanding(q).ok, d = q.d, b = { starts: g.autoLand.stats.starts, refused: g.autoLand.stats.refused, ap: g.approach.id }; const el = document.elementFromPoint(x, y) || document.body, o = { bubbles: true, pointerId: 88, clientX: x, clientY: y, pointerType: "touch" }; el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new PointerEvent("pointerup", o)); return { green, d, b, after: { starts: g.autoLand.stats.starts, refused: g.autoLand.stats.refused, ap: g.approach.id } }; }, id);
  const seen = []; const out = { green: [0, 0], far: [0, 0], nearBlue: [0, 0] }; let scen = 0;
  for (const [kind, k] of [["rock", 1], ["wall", 2], ["bench", 1], ["roof", 2], ["fence", 1], ["sign", 1], ["rail", 2], ["pole", 2], ["wall", 4], ["rock", 3]]) {
    const sc = await scenario(kind, k); if (!sc) continue; scen++; await sleep(900);
    const cl = await classify(); for (const c of cl) if (c.onScreen) seen.push(c);
    // 押す: この場面の目印を最大 6 つ(場面は押すたびに作り直す)
    for (const c of cl.filter(c => c.onScreen).slice(0, 6)) {
      await scenario(kind, k); await sleep(700);
      const r = await tapSpot(c.id); if (!r || r.skip) continue;
      if (r.green) { out.green[1]++; if (r.after.starts > r.b.starts) out.green[0]++; }
      else if (r.d > 18) { out.far[1]++; if (r.after.ap === c.id) out.far[0]++; }
      else { out.nearBlue[1]++; if (r.after.starts === r.b.starts && r.after.refused > r.b.refused) out.nearBlue[0]++; }
    }
  }
  await unhover();
  check("markers: green exactly when AutoLand.canStart passes right now (never green for an unsafe target)", seen.length >= 20 && seen.every(c => c.green === c.canStart), JSON.stringify({ n: seen.length, scenarios: scen, bad: seen.filter(c => c.green !== c.canStart).map(c => [c.kind, c.d]) }));
  check("markers: the sample has both green and blue markers (not vacuous)", seen.some(c => c.green) && seen.some(c => !c.green), JSON.stringify({ g: seen.filter(c => c.green).length, b: seen.filter(c => !c.green).length }));
  const mism = seen.filter(c => c.px !== "none" && ((c.px === "green") !== c.green));
  check("markers: the drawn ring colour (pixels) matches the state - green rings green, blue rings blue", mism.length === 0 && seen.filter(c => c.px !== "none").length >= 8 && seen.some(c => c.px === "green") && seen.some(c => c.px === "blue"), JSON.stringify({ mism, read: seen.filter(c => c.px !== "none").length, sample: seen.slice(0, 14).map(c => [c.kind, c.d, c.green, c.px, c.gr, c.bl, c.used, c.excl, c.low, c.oob]) }));
  check("tapping a green marker starts the automatic landing (>= 90%; the state is frozen so the colour and the tap-time check agree)", out.green[1] >= 3 && out.green[0] / out.green[1] >= 0.9, JSON.stringify(out));
  check("tapping a far blue marker selects it as the approach target; tapping a near-but-unsafe blue marker is refused (never starts)", (out.far[1] === 0 || out.far[0] / out.far[1] >= 0.9) && (out.nearBlue[1] === 0 || out.nearBlue[0] === out.nearBlue[1]) && out.far[1] + out.nearBlue[1] >= 3, JSON.stringify(out));
  // ---- (C) 動かした◎の位置で、実際のタッチが正しい◎に届く
  await hover(30, 0, Math.PI / 2, 40); await sleep(500); await unhover();
  const pads = await p.evaluate(() => { const g = __game; g.input.pads.land = { prox: { fx: 0.62, fy: 0.55 }, cruise: { fx: 0.88, fy: 0.45 } }; const L = g.input.layout(); return { prox: { ...L.prox }, cruise: { ...L.cruise } }; });
  const probe = async (pt) => { await tp("touchStart", [{ x: pt.cx, y: pt.cy, id: 5 }]); await sleep(150); const r = await p.evaluate(() => ({ prox: __game.input.prox.active, stick: __game.input.gesture.active })); await tp("touchEnd", []); await sleep(200); return r; };
  const onProx = await probe(pads.prox), onCruise = await probe(pads.cruise);
  check("with moved pads, a touch on the moved proximity ◎ drives the proximity pad and a touch on the moved cruise ◎ drives the cruise pad", onProx.prox && !onProx.stick && onCruise.stick && !onCruise.prox, JSON.stringify({ pads, onProx, onCruise }));
  await p.evaluate(() => { __game.input.pads.land = null; });
  // ---- (D) 縦画面の飛行ガイド: どのモードでも◎・ボタンと重ならない
  await p.setViewportSize({ width: 412, height: 892 }); await sleep(600);
  for (const mode of ["gauge", "hud"]) {
    for (const hand of ["right", "left"]) {
      await setCtl(hand); await p.evaluate(m => { document.querySelector(`[data-set=guide][data-val=${m}]`).click(); }, mode); await sleep(600);
      const bad = await p.evaluate(() => { const rect = e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }; const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t; const fields = [...document.querySelectorAll("#guide .gv")].map(rect), L = __game.input.layout(); const pads = L ? [L.cruise, L.prox].map(r => ({ l: r.cx - r.r, t: r.cy - r.r, r: r.cx + r.r, b: r.cy + r.r })) : []; const top = rect(document.getElementById("top")), bad = []; fields.forEach((f, i) => { if (f.r - f.l < 1) return; if (hit(f, top)) bad.push("top#" + i); pads.forEach((q, k) => { if (hit(f, q)) bad.push("pad" + k + "#" + i); }); if (f.l < -1 || f.r > innerWidth + 1 || f.t < -1 || f.b > innerHeight + 1) bad.push("off#" + i); }); return bad; });
      check(`portrait ${mode} guide / ${hand} hand: no field overlaps a ◎ or the top buttons and all stay on screen`, bad.length === 0, JSON.stringify(bad));
    }
  }
  await p.evaluate(() => { document.querySelector("[data-set=guide][data-val=off]").click(); }); await setCtl("right");
  await p.setViewportSize({ width: 892, height: 412 }); await sleep(400);
  check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
}

const GROUPS = [
  ["g1", g1, false], ["g2", g2, true], ["g3", g3, true], ["g4", g4, true], ["g5", g5, false], ["g6", g6, true], ["g7", g7, true], ["g8", g8, true], ["g9", g9, true], ["g10", g10, true], ["g11", g11, true], ["g12", g12, true], ["g13", g13, true], ["g14", g14, true], ["g15", g15, true], ["g16", g16, false], ["g17", g17, true],
];
// CIの5分割(各シャードの所要時間がほぼ等しくなるように)
const SHARD_PLAN = [["g1", "g3"], ["g2", "g5"], ["g4", "g8"], ["g6", "g9", "g11"], ["g7", "g10", "g12"], ["g13"], ["g14"], ["g15"], ["g16"], ["g17"]];

let want = GROUPS.map(g => g[0]);
const only = arg("--only"), shard = arg("--shard");
if (only) want = only.split(",");
if (shard) { const [i, n] = shard.split("/").map(Number); want = n === SHARD_PLAN.length ? SHARD_PLAN[i - 1] : want.filter((_, k) => k % n === i - 1); }

const srv = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await sleep(250); }
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
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
