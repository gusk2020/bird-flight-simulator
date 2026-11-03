// H6: 失敗した試行の時系列(0.1秒ごと)を出す。APPWIND=1 node dist-test/autoland_trace.cjs pole 3 [index]
import { trial, idx, open } from "./autoland_success";
const kind = process.argv[2] || "pole", want = Number(process.argv[3] || 1);
const ss = idx.all.filter(s => s.kind === kind && (kind === "balcony" || kind === "rail" || open(s)) && (kind !== "roof" || s.top < 12));
let shown = 0;
for (let i = 0; i < 200 && shown < want; i++) {
  const tr: Record<string, number | string>[] = []; const s = ss[(i + 1000) % ss.length], t = trial(s, i + 1000, tr);
  if (t.refused || t.ok) continue; shown++;
  console.log(`--- ${kind} trial ${i + 1000} top=${s.top.toFixed(1)} size=${(s.maxX - s.minX).toFixed(1)}x${(s.maxZ - s.minZ).toFixed(1)} v0=${t.v0?.toFixed(1)} tail=${t.tail?.toFixed(1)} end=${t.why} crash=${t.crash}`);
  for (const r of tr) console.log(JSON.stringify(r));
}
