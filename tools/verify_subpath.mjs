// 試遊用ビルド(dist)を、GitHub Pages のサブパス(例 /vind-ving-playtest/)配下に置いたときに起動するかを確かめる(実在の URL ではなく、同じ配置の模擬)。
//   node tools/verify_subpath.mjs <dist> [<base>] [<port>]      例: node tools/verify_subpath.mjs dist /vind-ving-playtest/ 4390
// 確かめること: (1) index.html が参照するアセットがすべて相対パス(サブパスで白画面にならない) (2) すべて取得できる (3) Pixel 7a 相当の縦画面で起動し、ページエラー・失敗した読み込みがない
//   (4) H9 の 5 機能の存在(起動 3 画面・◎位置の編集・着地点マーカー・飛行ガイド・低速巡航)。実機の操作感ではない。結果は JSON で標準出力に出す。失敗時は exit 1。
// 配信側は、base の外のパスはすべて 404 にする(絶対パスの参照があれば、ここで失敗する)。
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { chromium } from "playwright";

const dist = process.argv[2], base = (process.argv[3] || "/vind-ving-playtest/").replace(/\/?$/, "/"), port = Number(process.argv[4] || 4390);
if (!dist) { console.error("usage: verify_subpath.mjs <dist> [<base>] [<port>]"); process.exit(2); }
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const served = [];
const srv = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"); let p = decodeURIComponent(url.pathname);
  if (!p.startsWith(base)) { served.push([p, 404]); res.writeHead(404); return res.end("outside base"); }
  p = p.slice(base.length) || "index.html"; if (p.endsWith("/")) p += "index.html";
  const f = normalize(join(dist, p)); if (!f.startsWith(normalize(dist))) { res.writeHead(403); return res.end(); }
  try { const s = await stat(f); if (!s.isFile()) throw 0; const b = await readFile(f); served.push([url.pathname, 200]); res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" }); res.end(b); }
  catch { served.push([url.pathname, 404]); res.writeHead(404); res.end("not found"); }
});
await new Promise(r => srv.listen(port, r));
const report = { base, dist, checks: {}, errors: [], failedRequests: [] };
const ok = (name, v, detail) => { report.checks[name] = detail === undefined ? !!v : { ok: !!v, detail }; };
try {
  // (1)(2) index.html が参照するアセット
  const html = await readFile(join(dist, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(u => !/^(https?:|data:|#|mailto:)/.test(u));
  const absolute = refs.filter(u => u.startsWith("/"));
  ok("index.html のアセット参照がすべて相対パス(先頭が / でない)", absolute.length === 0, { refs, absolute });
  const sw = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  // Pixel 7a 相当: 412x915(CSS px)、タッチ、モバイル。縦画面で開く
  const ctx = await sw.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", e => report.errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") report.errors.push("console: " + m.text()); });
  page.on("requestfailed", r => report.failedRequests.push(r.url() + " " + (r.failure() && r.failure().errorText)));
  page.on("response", r => { if (r.status() >= 400) report.failedRequests.push(r.url() + " " + r.status()); });
  await page.goto(`http://localhost:${port}${base}`);
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
  ok("ゲームが起動した(白画面ではない: window.__game がある)", await page.evaluate(() => !!window.__game));
  const assets = served.filter(([p]) => p.startsWith(base) && p !== base).map(([p, s]) => ({ p, s }));
  ok("サブパス配下のアセットがすべて 200 で取得できた", assets.length > 0 && assets.every(a => a.s === 200), { n: assets.length, bad: assets.filter(a => a.s !== 200) });
  ok("base の外への要求がない(絶対パス参照がない)", served.every(([p]) => p.startsWith(base)), served.filter(([p]) => !p.startsWith(base)).slice(0, 5));
  // (4) H9 の 5 機能
  const f = await page.evaluate(() => {
    const q = id => !!document.getElementById(id), g = window.__game;
    return {
      startup3: q("pgEnv") && q("pgCtl") && q("pgStart") && q("ovBack") && q("ovAuto") && q("ovGo"),
      headings: ["pgEnv", "pgCtl", "pgStart"].map(id => (document.querySelector("#" + id + " h2") || {}).textContent),
      padEdit: q("padSetup") && q("padPreview") && q("padReset"),
      guideButtons: [...document.querySelectorAll('button[data-set="guide"]')].map(b => b.dataset.val),
      markers: q("spots") && !!g && !!g.spots && !!g.autoLand && typeof g.autoLand.canStart === "function",
      cruise: !!g && !!g.CRUISE ? { enabled: g.CRUISE.enabled, scale0: g.CRUISE.scale0 } : null,
    };
  });
  ok("H9 起動 3 画面(環境設定・操作UI設定・開始 / 設定に戻る・オート・自分で操作)が DOM にある", f.startup3, f.headings);
  ok("H9 ◎位置の編集(配置プレビュー・初期位置へ戻す)が DOM にある", f.padEdit);
  ok("H9 飛行ガイドの 3 択(非表示・計器・HUD)がある", f.guideButtons.length === 3, f.guideButtons);
  ok("H9 着地点マーカー(キャンバスと、緑の判定 canStart)がある", f.markers);
  ok("H9 低速巡航(CRUISE が有効で、巡航の速度係数 0.5)", !!f.cruise && f.cruise.enabled && f.cruise.scale0 === 0.5, f.cruise);
  // 起動して 3 秒進める(「自分で操作」= ovGo)。ゲーム内時間が進み、速度係数が低速巡航になっている
  await page.evaluate(() => { const ui = window.__ui; if (ui && ui.revealFor) ui.revealFor("#ovGo"); document.getElementById("ovGo").click(); });
  await new Promise(r => setTimeout(r, 3500));
  const run = await page.evaluate(() => { const g = window.__game, f = g.flight; return { state: g.game.state, t: +g.game.gameTime.toFixed(2), mode: f.mode, speedScale: +f.speedScale.toFixed(2), speed: +f.speed.toFixed(1) }; });
  ok("「自分で操作」で開始し、ゲーム内時間が進む(running)", run.state === "running" && run.t > 0.5, run);
  ok("開始後の速度係数が低速巡航(0.5 付近)", run.speedScale >= 0.45 && run.speedScale <= 0.6, run);
  await page.screenshot({ path: process.env.SHOT || "/tmp/verify_subpath.png" });
  ok("ページエラー・コンソールエラー・失敗した読み込みが 0 件", report.errors.length === 0 && report.failedRequests.length === 0, { errors: report.errors.slice(0, 5), failed: report.failedRequests.slice(0, 5) });
  await sw.close();
} catch (e) { report.errors.push("verify script: " + (e && e.stack || e)); report.checks["検証スクリプトが最後まで動いた"] = false; }
srv.close();
const bad = Object.entries(report.checks).filter(([, v]) => v === false || (v && v.ok === false));
console.log(JSON.stringify({ ...report, passed: bad.length === 0, failedChecks: bad.map(([k]) => k) }, null, 1));
process.exit(bad.length ? 1 : 0);
