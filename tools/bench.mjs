// 性能計測(CI対象外): node tools/bench.mjs <出力json>
// ヘッドレスChromium + ソフトウェアGL(swiftshader)。GPU時間ではなく「JS/CPU側の処理量」と「描画コール・三角形数」を比較するための道具で、
// 絶対FPSは実機(Pixel 7a)の値ではない。同一マシン・同一条件で変更前後を比べる用途。
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

const out = process.argv[2] || "bench.json", PORT = Number(process.env.BENCH_PORT || 4175);
const srv = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore", detached: true }); // 子プロセスごと確実に止めるため独立グループ
const stopSrv = () => { try { process.kill(-srv.pid); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {} await sleep(250); }
const t0 = Date.now();
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport: { width: 892, height: 412 }, deviceScaleFactor: 1 });
const p = await ctx.newPage(); const cdp = await ctx.newCDPSession(p); await cdp.send("Performance.enable");
await p.goto(`http://localhost:${PORT}/`); await p.waitForFunction(() => window.__game, null, { timeout: 30000 });
const startupMs = await p.evaluate(() => performance.now());
await p.click("#ovGo"); await sleep(500);
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));

async function scenario(name, setup, ms = 4000) {
  await p.evaluate(setup); await sleep(1200);                       // ウォームアップ
  await p.evaluate(() => { window.__ft = []; let l = performance.now(); const t = n => { window.__ft.push(n - l); l = n; window.__raf = requestAnimationFrame(t); }; window.__raf = requestAnimationFrame(t); });
  const heap = []; const m0 = await metrics(); const s0 = await p.evaluate(() => __game.game.steps); const tt = Date.now();
  while (Date.now() - tt < ms) { heap.push((await metrics()).JSHeapUsedSize); await sleep(25); }
  const m1 = await metrics(); const s1 = await p.evaluate(() => __game.game.steps);
  const r = await p.evaluate(() => { cancelAnimationFrame(window.__raf); const f = window.__ft.slice(2).sort((a, c) => a - c), g = __game, i = g.renderer.info.render;
    return { frames: f.length, meanMs: f.reduce((a, c) => a + c, 0) / f.length, p95Ms: f[Math.floor(f.length * 0.95)], maxMs: f[f.length - 1],
      calls: i.calls, tris: i.triangles, npcMs: g.stats.npcMs, fxMs: g.stats.fxMs, renderMs: g.stats.renderMs, level: g.quality.level }; });
  let alloc = 0; for (let i = 1; i < heap.length; i++) if (heap[i] > heap[i - 1]) alloc += heap[i] - heap[i - 1];
  const res = { ...r, stepsPerFrame: (s1 - s0) / r.frames, fps: 1000 / r.meanMs, scriptMsPerFrame: (m1.ScriptDuration - m0.ScriptDuration) * 1000 / r.frames, taskMsPerFrame: (m1.TaskDuration - m0.TaskDuration) * 1000 / r.frames, allocKBPerFrame: alloc / 1024 / r.frames };
  console.log(name.padEnd(14), `fps=${res.fps.toFixed(1)} mean=${res.meanMs.toFixed(1)}ms p95=${res.p95Ms.toFixed(1)}ms max=${res.maxMs.toFixed(0)}ms script=${res.scriptMsPerFrame.toFixed(2)}ms/f task=${res.taskMsPerFrame.toFixed(2)}ms/f alloc=${res.allocKBPerFrame.toFixed(1)}KB/f steps/f=${res.stepsPerFrame.toFixed(1)} calls=${res.calls} tris=${res.tris} npc=${res.npcMs.toFixed(3)} fx=${res.fxMs.toFixed(3)} render(js)=${res.renderMs.toFixed(1)} Q${res.level}`);
  return res;
}
const forceQ = `__game.settings.gfx = 1;`; // 画質を「高」固定(自動調整を止め、変更前後で同一解像度)
const base = (extra = "") => `(() => { ${forceQ} const g = __game; g.settings.weather = "clear"; g.settings.npc = 2; g.settings.fx = 2; g.applySettings(); g.input.state.y = 0; g.input.state.brake = false; g.setHour(12); ${extra} })()`;
const results = {};
results.normal = await scenario("normal", base("g.flight.reset();"));
results.dive = await scenario("dive", base("const f = g.flight; f.reset(); f.pos.set(28, 150, 110); f.prevPos.copy(f.pos); f.vel.set(0, -25, -10); g.input.state.y = -1;"), 3000);
results.walk = await scenario("walk", base("const f = g.flight; f.pos.set(28, 0.32, 60); f.prevPos.copy(f.pos); f.vel.set(0, 0, 0); f.mode = 'landed'; f.walkV = 0; g.input.state.brake = true;"));
results.perch = await scenario("perch", base("g.input.state.brake = false; const f = g.flight, w = g.world, id = w.wires.findIndex(q => q.alongX && q.off === 0 && Math.abs(q.ax + 14) < 0.1 && Math.abs(q.az - 33.8) < 0.1), o = { x: 0, y: 0, z: 0 }; w.perchPoint(id, 0.4, o); f.reset(); f.mode = 'perch'; f.perchId = id; f.perchT = 0.4; f.pos.set(o.x, o.y + 0.32, o.z); f.prevPos.copy(f.pos); f.vel.set(0, 0, 0);"));
results.npcMax = await scenario("npc-max", base("g.settings.npc = 3; g.applySettings(); g.flight.reset();"));
results.npcOff = await scenario("npc-off", base("g.settings.npc = 0; g.applySettings(); g.flight.reset();"));
results.rain = await scenario("rain+wind", base("g.settings.weather = 'rain'; g.settings.wind = 2; g.applySettings(); g.flight.reset();"));
results.paused = await scenario("paused", base("g.flight.reset(); document.getElementById('btnPause').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));"));
// ビルドサイズ
const dist = "dist/assets"; let js = 0; for (const f of fs.readdirSync(dist)) if (f.endsWith(".js")) js += fs.statSync(`${dist}/${f}`).size;
results.meta = { startupMs, bundleJsBytes: js, node: process.version, chromium: b.version(), viewport: "892x412 dpr1", renderer: "swiftshader (software GL)", wall: (Date.now() - t0) / 1000 };
console.log("meta", JSON.stringify(results.meta));
fs.writeFileSync(out, JSON.stringify(results, null, 1));
await b.close(); stopSrv(); process.exit(0);
