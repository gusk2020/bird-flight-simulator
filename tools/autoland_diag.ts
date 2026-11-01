// H2修正: 自動着地の成功率を「試行 / 開始拒否 / 開始許可 / 成功(1.5秒保持) / 衝突 / 中止理由」に分けて出す。
// 調整用(tune)と測定用(measure)の試行番号を分ける: tune=0..59, measure=1000..1199 (進入の乱数は試行番号から決まる)
// npx esbuild tools/autoland_diag.ts --bundle --platform=node --outfile=dist-test/autoland_diag.cjs && node dist-test/autoland_diag.cjs [measure|tune] [kind,kind,...]
import { run } from "./autoland_success";
const mode = process.argv[2] === "tune" ? "tune" : "measure";
const kinds = process.argv[3]?.split(",");
const n = mode === "tune" ? 60 : 200, offset = mode === "tune" ? 0 : 1000;
const r = run(n, offset);
console.log(`[${mode}] 試行番号 ${offset}..${offset + n - 1}`);
for (const [k, v] of Object.entries(r)) {
  if (kinds && !kinds.includes(k)) continue;
  const started = v.n - v.refused;
  console.log(`${k.padEnd(8)} 試行${v.n} 開始拒否${v.refused} 開始許可${started} → 成功(1.5秒保持)${v.ok} = ${started ? (100 * v.ok / started).toFixed(1) : "-"}% of 開始許可 / ${(100 * v.ok / v.n).toFixed(1)}% of 試行  衝突${v.crash}  歩行可能な足場で実際に歩けた${v.walked}/${v.walkable}(立位のみの足場は歩行を主張しない)  内訳${JSON.stringify(v.ends)} 着地した面${JSON.stringify(v.on)} 進入速度別(成功/開始許可)${JSON.stringify(v.byV)}`);
}
