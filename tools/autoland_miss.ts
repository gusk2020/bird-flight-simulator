// H7: 失敗した試行を「最接近の時点」で分類する。APPWIND=1 node dist-test/autoland_miss.cjs [kinds] [tune|measure]
import { trial, idx, open } from "./autoland_success";
const kinds = (process.argv[2] || "pole,sign,bench,rail,balcony").split(","), off = process.argv[3] === "tune" ? 0 : 1000;
for (const kind of kinds) {
  const ss = idx.all.filter(s => s.kind === kind && (kind === "balcony" || kind === "rail" || open(s)) && (kind !== "roof" || s.top < 12)); if (!ss.length) continue;
  const tab: Record<string, number> = {}; let n = 0, ok = 0, ref = 0;
  for (let i = 0; i < 200; i++) {
    const tr: Record<string, number | string>[] = []; const t = trial(ss[(i + off) % ss.length], i + off, tr); n++;
    if (t.refused) { ref++; continue; } if (t.ok) { ok++; continue; }
    let m = tr[0]; for (const r of tr) if (Number(r.d) < Number(m.d)) m = r;
    const d = Number(m.d), fe = Number(m.feet), hs = Number(m.hs);
    const cls = d > 1.5 ? "横に外した(最接近>1.5m)" : fe > 1.2 ? "高すぎて通過(>1.2m上)" : fe < -0.3 ? "最接近で既に低い" : hs > 7 ? "速すぎて通過" : "近くまで来たが止まれず";
    const k = `${t.crash ? "衝突/" : ""}${cls}`; tab[k] = (tab[k] || 0) + 1;
  }
  console.log(kind.padEnd(8), `n=${n} refused=${ref} ok=${ok}/${n - ref}`, JSON.stringify(Object.entries(tab).sort((a, b) => b[1] - a[1])));
}
