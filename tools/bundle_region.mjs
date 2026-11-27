// 地域マップ(試作)を、1枚のHTMLにまとめる(スマホ試遊の共有用。claude.ai の Artifact など、他のファイルを読めない場所向け)。
// 使い方: node tools/bundle_region.mjs <出力.html> [サンプルJSON]
//   サンプルJSONを渡すと、ページに埋め込み、「KFMの公開サンプルを読み込む」ボタンがネットワークではなくそれを読む。
// 標準のビルド(npm run build)・公開(Pages)には使われない。標準ワールドへ戻るリンクは、この形では外す。
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
const [out, samplePath] = process.argv.slice(2);
if (!out) { console.error("usage: node tools/bundle_region.mjs <out.html> [sample.json]"); process.exit(1); }
const r = await build({ entryPoints: ["src/regionMain.ts"], bundle: true, format: "iife", minify: true, write: false, target: "es2020", logLevel: "error" });
const js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
let html = readFileSync("region.html", "utf8");
const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
let body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script type="module"[^>]*><\/script>/, "").replace(/<a class="back"[^>]*>.*?<\/a>/, "");
const sample = samplePath ? `<script>window.__REGION_SAMPLE__=${JSON.stringify(readFileSync(samplePath, "utf8")).replace(/<\/script/gi, "<\\/script")};</script>` : "";
writeFileSync(out, `<title>Vind Ving 地域マップ</title>\n${style}\n${body}\n${sample}\n<script>${js}</script>\n`);
console.log("wrote", out, (readFileSync(out).length / 1024).toFixed(0) + " KB");
