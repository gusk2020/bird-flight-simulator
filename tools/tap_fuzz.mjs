// 実タップの取りこぼしを探す: CPUを絞った実ブラウザで、飛行中の◯を実タップし、押下→離しの各段階の計数(ringDiag)を出す。使い方: npm run build && node tools/tap_fuzz.mjs [CPU絞り倍率=4] [回数=28]
import { chromium } from "playwright"; import { spawn } from "child_process";
const srv = spawn("npx", ["vite", "preview", "--port", "4183", "--strictPort"], { cwd: process.cwd(), stdio: "ignore" });
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://localhost:4183/")).ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport: { width: 892, height: 412 }, hasTouch: true }); const p = await ctx.newPage(); const cdp = await ctx.newCDPSession(p);
await p.goto("http://localhost:4183/"); await p.waitForFunction(() => window.__game, null, { timeout: 30000 }); await new Promise(r => setTimeout(r, 1500)); await p.click("#ovGo"); await new Promise(r => setTimeout(r, 500));
await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.argv[2] || 4) });
for (let i = 0; i < 3 && (await p.evaluate(() => document.body.dataset.ctl)) !== "right"; i++) { await p.evaluate(() => document.getElementById("btnCtl").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); await new Promise(r => setTimeout(r, 300)); }
const kinds = ["rock", "roof", "bench", "balcony", "rail", "branch", "pole"]; const out = [];
for (let n = 0; n < Number(process.argv[3] || 28); n++) {
  const kind = kinds[n % kinds.length];
  const ok = await p.evaluate(([kind, n]) => { const g = __game, f = g.flight; f.reset(); g.setAuto(false); g.input.releaseAll(); g.autoLand.cancel("user"); const all = g.surfaces.all.filter(s => s.kind === kind); const t = all[(n * 5 + 1) % all.length]; if (!t) return false;
    const cx = (t.minX + t.maxX) / 2, cz = (t.minZ + t.maxZ) / 2; let sd = (n * 7919 + 13) >>> 0; const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    const ang = t.outward ? Math.atan2(t.outward[1], t.outward[0]) + (rnd() - 0.5) * 1.6 : rnd() * Math.PI * 2, dist = 6 + rnd() * 10, h0 = t.top + 0.8 + rnd() * 4.2;
    const dxs = Math.cos(ang), dzs = Math.sin(ang), hx = (t.maxX - t.minX) / 2, hz = (t.maxZ - t.minZ) / 2, tE = Math.min(hx / Math.max(Math.abs(dxs), 1e-6), hz / Math.max(Math.abs(dzs), 1e-6));
    f.pos.set(cx + dxs * (tE + dist), h0, cz + dzs * (tE + dist)); f.prevPos.copy(f.pos); f.yaw = Math.atan2(-(cx - f.pos.x), -(cz - f.pos.z)) + (rnd() - 0.5) * 1.57; const v0 = 6 + rnd() * 5; f.vel.set(-Math.sin(f.yaw) * v0, -0.5, -Math.cos(f.yaw) * v0); g.cam.snap(); return true; }, [kind, n]);
  if (!ok) continue;
  const shown = await p.waitForFunction(() => __game.ring.visible, null, { timeout: 6000 }).then(() => true).catch(() => false); if (!shown) { out.push({ n, kind, r: "noring" }); continue; }
  await new Promise(r => setTimeout(r, 120));
  const r0 = await p.evaluate(() => ({ x: __game.ring.x, y: __game.ring.y, hit: __game.ring.hit, rd: { ...__game.input.ringDiag }, taps: __game.input.stats.ringTaps, st: __game.autoLand.stats.starts, rf: __game.autoLand.stats.refused }));
  await cdp.send("Input.synthesizeTapGesture", { x: Math.round(r0.x), y: Math.round(r0.y), duration: 50, tapCount: 1, gestureSourceType: "touch" });
  await new Promise(r => setTimeout(r, 250));
  const r1 = await p.evaluate(() => ({ rd: { ...__game.input.ringDiag }, taps: __game.input.stats.ringTaps, st: __game.autoLand.stats.starts, rf: __game.autoLand.stats.refused, vis: __game.ring.visible }));
  const counted = r1.taps > r0.taps, acted = r1.st > r0.st || r1.rf > r0.rf;
  const dn = r1.rd.downHit - r0.rd.downHit;
  out.push({ n, kind, counted, acted, downHit: dn, up: r1.rd.up - r0.rd.up, noCand: r1.rd.upNoCand - r0.rd.upNoCand, slow: r1.rd.upSlow - r0.rd.upSlow, far: r1.rd.upFar - r0.rd.upFar, ok: r1.rd.upOk - r0.rd.upOk, moveDrop: r1.rd.moveDrop - r0.rd.moveDrop, cancel: r1.rd.cancel - r0.rd.cancel, last: r1.rd.last });
  await p.evaluate(() => __game.autoLand.cancel("user"));
}
for (const o of out) console.log(JSON.stringify(o));
await b.close(); srv.kill();
