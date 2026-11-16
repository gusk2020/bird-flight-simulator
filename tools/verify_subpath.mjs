// GitHub Pages に載せる複合サイト(ルート / = 正式版、/h9/ = H9 試遊版)を、Pages と同じ配置(プロジェクトのサブパス)で配信して確かめる。実在の URL ではなく、同じ配置の模擬。
//   node tools/verify_subpath.mjs <サイトのディレクトリ> [<配信パス>] [<ポート>]     例: node tools/verify_subpath.mjs site /bird-flight-simulator/ 4390
// 確かめること:
//   ルート(正式版): アセット参照が相対パス・全アセット取得・Pixel 7a 相当の縦画面で起動・ページエラー 0。H9 の機能が混ざっていないこと(正式版のまま)。
//   /h9/(試遊版):  同じ起動確認 + H9 の 5 機能の存在(起動 3 画面・◎位置の編集・着地点マーカー・飛行ガイド・低速巡航)+「自分で操作」で開始して低速巡航の係数 0.5 + build-info.json。
//   保存データの分離: 同じブラウザ(同じオリジン)で、ルートの設定を保存 → /h9/ で別の設定を保存 → ルートの保存が変わっていないこと(およびその逆)。
// 配信側は、配信パスの外はすべて 404 にする(絶対パス参照があれば失敗する)。結果は JSON で標準出力に出し、失敗時は exit 1。実機の操作感の代替ではない。
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { chromium } from "playwright";

const dir = process.argv[2], prefix = (process.argv[3] || "/bird-flight-simulator/").replace(/\/?$/, "/"), port = Number(process.argv[4] || 4390);
if (!dir) { console.error("usage: verify_subpath.mjs <site dir> [<prefix>] [<port>]"); process.exit(2); }
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const served = [];
const srv = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"); let p = decodeURIComponent(url.pathname);
  if (!p.startsWith(prefix)) { served.push([p, 404]); res.writeHead(404); return res.end("outside prefix"); }
  p = p.slice(prefix.length) || "index.html"; if (p.endsWith("/")) p += "index.html";
  const f = normalize(join(dir, p)); if (!f.startsWith(normalize(dir))) { res.writeHead(403); return res.end(); }
  try { const s = await stat(f); if (!s.isFile()) throw 0; const b = await readFile(f); served.push([url.pathname, 200]); res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" }); res.end(b); }
  catch { served.push([url.pathname, 404]); res.writeHead(404); res.end("not found"); }
});
await new Promise(r => srv.listen(port, r));
const report = { prefix, dir, checks: {} };
const ok = (name, v, detail) => { report.checks[name] = detail === undefined ? !!v : { ok: !!v, detail }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  // 同じ context(= 同じオリジン・同じ保存領域)で、ルートと /h9/ を順に開く。Pixel 7a 相当: 412x915(CSS px)、タッチ、モバイル、縦画面
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const open = async (sub, label) => {
    const page = await ctx.newPage(), errors = [], failed = [];
    page.on("pageerror", e => errors.push("pageerror: " + e.message)); page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
    page.on("requestfailed", r => failed.push(r.url() + " " + (r.failure() && r.failure().errorText))); page.on("response", r => { if (r.status() >= 400) failed.push(r.url() + " " + r.status()); });
    const before = served.length;
    await page.goto(`http://localhost:${port}${prefix}${sub}`);
    await page.waitForFunction(() => window.__game, null, { timeout: 60000 }).catch(() => {}); await sleep(1500);
    const html = await readFile(join(dir, sub, "index.html"), "utf8");
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(u => !/^(https?:|data:|#|mailto:)/.test(u)), absolute = refs.filter(u => u.startsWith("/"));
    const here = served.slice(before).filter(([p]) => p.startsWith(prefix + sub) && p !== prefix + sub), booted = await page.evaluate(() => !!window.__game);
    ok(`${label}: index.html のアセット参照がすべて相対パス`, absolute.length === 0, { refs, absolute });
    ok(`${label}: ゲームが起動した(白画面ではない)`, booted);
    ok(`${label}: アセットがすべて 200 で取得できた`, here.length > 0 && here.every(([, s]) => s === 200), { n: here.length, bad: here.filter(([, s]) => s !== 200).slice(0, 5) });
    return { page, errors, failed };
  };
  // ---- ルート(正式版)
  const R = await open("", "ルート(正式版)");
  const rootInfo = await R.page.evaluate(() => ({ h9: !!window.__game.CRUISE, guide: document.querySelectorAll('button[data-set="guide"]').length, pg: !!document.getElementById("pgEnv") }));
  ok("ルート: 正式版のまま(H9 の低速巡航・飛行ガイド・起動 3 画面が混ざっていない)", !rootInfo.h9 && rootInfo.guide === 0 && !rootInfo.pg, rootInfo);
  ok("ルート: ページエラー・失敗した読み込みが 0 件", R.errors.length === 0 && R.failed.length === 0, { errors: R.errors.slice(0, 3), failed: R.failed.slice(0, 3) });
  // 正式版の保存: 操作方式を変えて保存させる(正式版の設定ボタンを押す)
  await R.page.evaluate(() => { const b = document.getElementById("btnCtl"); b && b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); }); await sleep(600);
  const rootStore1 = await R.page.evaluate(() => ({ keys: Object.keys(localStorage).filter(k => k.startsWith("vindving")), v1: localStorage.getItem("vindving.prefs.v1") }));
  // ---- /h9/(試遊版)
  const H = await open("h9/", "/h9/(試遊版)");
  const f = await H.page.evaluate(() => { const q = id => !!document.getElementById(id), g = window.__game;
    return { startup3: q("pgEnv") && q("pgCtl") && q("pgStart") && q("ovBack") && q("ovAuto") && q("ovGo"), headings: ["pgEnv", "pgCtl", "pgStart"].map(id => (document.querySelector("#" + id + " h2") || {}).textContent),
      padEdit: q("padSetup") && q("padPreview") && q("padReset"), guide: [...document.querySelectorAll('button[data-set="guide"]')].map(b => b.dataset.val),
      markers: q("spots") && !!g.spots && !!g.autoLand && typeof g.autoLand.canStart === "function", cruise: g.CRUISE ? { enabled: g.CRUISE.enabled, scale0: g.CRUISE.scale0 } : null }; });
  ok("/h9/: 起動 3 画面(環境設定・操作UI設定・開始 / 設定に戻る・オート・自分で操作)", f.startup3, f.headings);
  ok("/h9/: ◎位置の編集(配置プレビュー・初期位置へ戻す)", f.padEdit);
  ok("/h9/: 飛行ガイドの 3 択(非表示・計器・HUD)", f.guide.length === 3, f.guide);
  ok("/h9/: 着地点マーカー(キャンバスと、緑の判定 canStart)", f.markers);
  ok("/h9/: 低速巡航(CRUISE 有効・係数 0.5)", !!f.cruise && f.cruise.enabled && f.cruise.scale0 === 0.5, f.cruise);
  // 試遊版で設定を保存させる(飛行ガイド = HUD)
  await H.page.evaluate(() => { const b = document.querySelector('button[data-set="guide"][data-val="hud"]'); b && b.click(); }); await sleep(800);
  await H.page.evaluate(() => { const ui = window.__ui; if (ui && ui.revealFor) ui.revealFor("#ovGo"); document.getElementById("ovGo").click(); }); await sleep(3500);
  const run = await H.page.evaluate(() => { const g = window.__game, f = g.flight; return { state: g.game.state, t: +g.game.gameTime.toFixed(2), speedScale: +f.speedScale.toFixed(2), speed: +f.speed.toFixed(1) }; });
  ok("/h9/: 「自分で操作」で開始し、ゲーム内時間が進む", run.state === "running" && run.t > 0.5, run);
  ok("/h9/: 開始後の速度係数が低速巡航(0.5 付近)", run.speedScale >= 0.45 && run.speedScale <= 0.6, run);
  ok("/h9/: ページエラー・失敗した読み込みが 0 件", H.errors.length === 0 && H.failed.length === 0, { errors: H.errors.slice(0, 3), failed: H.failed.slice(0, 3) });
  let info = null; try { info = JSON.parse(await readFile(join(dir, "h9", "build-info.json"), "utf8")); } catch {}
  ok("/h9/build-info.json がある(ビルド元の ref と SHA)", !!info && !!info.h9_source_sha, info);
  await H.page.screenshot({ path: process.env.SHOT || "/tmp/verify_subpath.png" });
  // ---- 保存データの分離(同じオリジン)
  const hStore = await H.page.evaluate(() => ({ keys: Object.keys(localStorage).filter(k => k.startsWith("vindving")), h9: localStorage.getItem("vindving.h9.prefs.v1"), v1: localStorage.getItem("vindving.prefs.v1") }));
  ok("保存の分離: /h9/ で保存した設定は、/h9/ 専用のキーに入った", !!hStore.h9 && JSON.parse(hStore.h9).guide === "hud", hStore.keys);
  ok("保存の分離: /h9/ での保存は、ルート(正式版)の保存データを変えていない", hStore.v1 === rootStore1.v1, { before: rootStore1.v1 && rootStore1.v1.slice(0, 80), after: hStore.v1 && hStore.v1.slice(0, 80) });
  const R2 = await ctx.newPage(); await R2.goto(`http://localhost:${port}${prefix}`); await R2.waitForFunction(() => window.__game, null, { timeout: 60000 }).catch(() => {}); await sleep(800);
  const rootStore2 = await R2.evaluate(() => ({ v1: localStorage.getItem("vindving.prefs.v1"), h9: localStorage.getItem("vindving.h9.prefs.v1") }));
  ok("保存の分離: ルートを開き直しても、ルートの保存は /h9/ の影響を受けていない", rootStore2.v1 === rootStore1.v1, {});
  await browser.close();
} catch (e) { report.checks["検証スクリプトが最後まで動いた"] = { ok: false, detail: String(e && e.stack || e).slice(0, 400) }; try { await browser.close(); } catch {} }
srv.close();
const bad = Object.entries(report.checks).filter(([, v]) => v === false || (v && v.ok === false));
const outside = served.filter(([p]) => !p.startsWith(prefix));
report.checks["配信パスの外への要求がない(絶対パス参照がない)"] = { ok: outside.length === 0, detail: outside.slice(0, 5) };
if (outside.length) bad.push(["配信パスの外への要求がない(絶対パス参照がない)"]);
console.log(JSON.stringify({ ...report, passed: bad.length === 0, failedChecks: bad.map(([k]) => k) }, null, 1));
process.exit(bad.length ? 1 : 0);
