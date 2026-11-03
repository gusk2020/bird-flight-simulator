// H7: 失敗の前に失速(stall)があったか。失敗した試行の最初の失速時刻・そのときの対地速度・足場までの距離を集計する。
import { trial, idx, open } from "./autoland_success";
for (const kind of (process.argv[2] || "pole,sign").split(",")) {
  const ss = idx.all.filter(s => s.kind === kind && (kind === "balcony" || kind === "rail" || open(s))); const dOk: number[] = []; let nf = 0, withStall = 0, firstD: number[] = [], firstHs: number[] = [], firstT: number[] = [], stallOk = 0, okN = 0;
  for (let i = 0; i < 200; i++) {
    const tr: Record<string, number | string>[] = []; const t = trial(ss[(i + 1000) % ss.length], i + 1000, tr); if (t.refused) continue;
    const st = tr.find(r => Number(r.stall) === 1);
    if (t.ok) { okN++; if (st) { stallOk++; dOk.push(Number(st.d)); } continue; } nf++; if (st) { withStall++; firstD.push(Number(st.d)); firstHs.push(Number(st.hs)); firstT.push(Number(st.t)); }
  }
  const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]?.toFixed(1);
  console.log(kind, `失敗${nf}のうち、失速あり${withStall}(最初の失速: 距離の中央値${med(firstD)}m・対地速度${med(firstHs)}・開始から${med(firstT)}秒)。成功${okN}のうち失速あり${stallOk}(最初の失速の距離 中央値${med(dOk)}m)`);
}
