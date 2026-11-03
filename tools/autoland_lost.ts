// H6: 風ありで「lost(見失い)」になった試行の内訳を、足場の種類×中止の理由(dbg の先頭語)×風向で数える。
// APPWIND=1 node dist-test/autoland_lost.cjs [kind,kind]
import { trial, idx, open } from "./autoland_success";
const kinds = (process.argv[2] || "pole,sign,fence,wall,bench,rail,balcony,branch,rock,roof").split(",");
for (const kind of kinds) {
  const ss = idx.all.filter(s => s.kind === kind && (kind === "balcony" || kind === "rail" || open(s)) && (kind !== "roof" || s.top < 12)); if (!ss.length) continue;
  const tab: Record<string, number> = {};
  for (let i = 0; i < 200; i++) {
    const t = trial(ss[(i + 1000) % ss.length], i + 1000); if (t.refused || t.ok) continue;
    const dir = (t.tail ?? 0) > 1.5 ? "追い風" : (t.tail ?? 0) < -1.5 ? "向かい風" : "横風/無風";
    const key = `${t.crash ? "crash" : t.why}:${String((globalThis as any).__dbg || "").split(" ")[0]} ${dir}`; tab[key] = (tab[key] || 0) + 1;
  }
  console.log(kind.padEnd(8), JSON.stringify(Object.entries(tab).sort((a, b) => b[1] - a[1])));
}
