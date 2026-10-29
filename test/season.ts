import { check, suite } from "./harness";
import { SEASON_NAMES, SEASON_YEAR_SECONDS, SNOW_MAX, SeasonClock, seasonBias, seasonIndex, seasonLook, wrap01 } from "../src/season";
import { DEFAULT_PREFS, PREFS_KEY, loadPrefs, sanitizePrefs, savePrefs } from "../src/settings";

const chan = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const dist = (a: number, b: number) => Math.hypot(...chan(a).map((v, i) => v - chan(b)[i]));
export function seasonTests() {
  suite("seasons (E5)");
  check("year length: 高速 10 min, 標準 30 min, ゆったり 60 min", SEASON_YEAR_SECONDS.fast === 600 && SEASON_YEAR_SECONDS.normal === 1800 && SEASON_YEAR_SECONDS.slow === 3600);
  { const c = new SeasonClock(); check("first launch starts in spring at the default speed 標準", c.phase === 0 && c.name === "春" && c.speed === "normal");
    for (const [sp, secs] of [["fast", 600], ["normal", 1800], ["slow", 3600]] as const) { const k = new SeasonClock(); k.setSpeed(sp); for (let i = 0; i < secs * 60; i++) k.advance(1 / 60); check(`${sp}: one full year in ${secs} s returns to spring start`, Math.abs(wrap01(k.phase + 1e-6)) < 1e-4 || Math.abs(k.phase - 1) < 1e-4, k.phase.toFixed(5)); }
    const k = new SeasonClock(); k.setSpeed("fast"); const names: string[] = []; for (let i = 0; i < 600 * 60; i++) { k.advance(1 / 60); if (i % (150 * 60) === 75 * 60) names.push(k.name); }
    check("spring -> summer -> autumn -> winter order", names.join("") === "春夏秋冬" && SEASON_NAMES.join("") === "春夏秋冬", names.join("")); }
  { const k = new SeasonClock(); k.phase = 0.4; const p0 = k.phase; k.setSpeed("fast"); const p1 = k.phase; k.advance(1 / 60); k.setSpeed("slow"); const p2 = k.phase;
    check("changing the speed mid-season keeps the position (no jump), and only the rate changes", p0 === p1 && Math.abs(p2 - p1 - 1 / 60 / 600) < 1e-12 && (() => { k.advance(60); return Math.abs(k.phase - p2 - 60 / 3600) < 1e-9; })()); }
  { const k = new SeasonClock(); k.phase = 0.3; k.advance(0); k.advance(-5); check("paused (dt=0) or negative time never advances the season", k.phase === 0.3); }
  check("seasonIndex and wrap01 handle the boundaries", seasonIndex(0) === 0 && seasonIndex(0.2499) === 0 && seasonIndex(0.25) === 1 && seasonIndex(0.999) === 3 && wrap01(1.25) === 0.25 && wrap01(-0.25) === 0.75);
  // 景観は連続(季節境界でも急に切り替わらない)
  { let maxColor = 0, maxNum = 0; const N = 4000; let prev = seasonLook(0);
    for (let i = 1; i <= N; i++) { const k = seasonLook(i / N); for (const key of ["grassTint", "weedTint", "leaf"] as const) maxColor = Math.max(maxColor, dist(k[key], prev[key])); maxColor = Math.max(maxColor, dist(k.paddy.rice, prev.paddy.rice));
      maxNum = Math.max(maxNum, Math.abs(k.leafAmount - prev.leafAmount), Math.abs(k.snow - prev.snow), Math.abs(k.paddy.growth - prev.paddy.growth), Math.abs(k.paddy.water - prev.paddy.water), Math.abs(k.blossom - prev.blossom), Math.abs(k.weedScale - prev.weedScale)); prev = k; }
    check("the look is continuous over the whole year, including across the year wrap (colour step < 3/255, values < 0.02 per 1/4000 year)", maxColor < 3 && maxNum < 0.02, `color ${maxColor.toFixed(2)} num ${maxNum.toFixed(4)}`);
    const a = seasonLook(0), b = seasonLook(1); check("the year closes: phase 0 and 1 look the same", a.grassTint === b.grassTint && a.leaf === b.leaf && a.paddy.rice === b.paddy.rice && a.snow === b.snow); }
  { const sp = seasonLook(0.12), su = seasonLook(0.3), au = seasonLook(0.55), wi = seasonLook(0.9);
    check("spring: cherry blossoms, fresh leaves, the paddy is flooded with seedlings", seasonLook(0.07).blossom > 0.7 && sp.paddy.water > 0.8 && sp.paddy.growth < 0.3 && sp.snow === 0);
    check("summer: deep green, full foliage, tall rice, no snow", su.leafAmount > 0.95 && su.paddy.growth > 0.6 && su.snow === 0 && chan(su.leaf)[1] > chan(su.leaf)[0]);
    check("autumn: golden rice, then harvested (stubble, drained); leaves turn red/orange and thin out", seasonLook(0.53).paddy.growth > 0.9 && chan(seasonLook(0.53).paddy.rice)[0] > chan(seasonLook(0.53).paddy.rice)[2] + 60 && seasonLook(0.62).paddy.growth < 0.2 && seasonLook(0.62).paddy.water < 0.05 && chan(seasonLook(0.65).leaf)[0] > chan(seasonLook(0.65).leaf)[1] && au.leafAmount < su.leafAmount);
    check("winter: bare trees, fallow paddy (no water), moderate snow (capped)", wi.leafAmount < 0.35 && wi.paddy.water === 0 && wi.paddy.growth < 0.15 && wi.snow > 0.4 && wi.snow <= SNOW_MAX + 1e-9 && SNOW_MAX < 0.7);
    check("snow builds up gradually in winter and melts in early spring (never appears suddenly)", seasonLook(0.74).snow === 0 && seasonLook(0.8).snow > 0 && seasonLook(0.8).snow < wi.snow && seasonLook(0.03).snow > 0 && seasonLook(0.03).snow < SNOW_MAX && seasonLook(0.12).snow === 0); }
  { const w = seasonBias(0.9), s = seasonBias(0.3), sp = seasonBias(0.08), au = seasonBias(0.55);
    check("behaviour bias is modest (0.7-1.5 everywhere) and follows the seasons", [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85].every(p => Object.values(seasonBias(p)).every(v => v >= 0.7 && v <= 1.5)) && w.roof > 1.1 && w.forage < 1 && sp.forage > 1.1 && au.forage > 1.2 && s.water > 1.2 && s.roof < 1);
    for (let i = 1; i <= 400; i++) { const a = seasonBias(i / 400), b = seasonBias((i - 1) / 400); if (Math.abs(a.forage - b.forage) > 0.03) check("bias continuous", false); } }
  // 設定の保存・復元
  { const store: Record<string, string> = {}; const st = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
    const p = { ...DEFAULT_PREFS, seasonPhase: 0.62, seasonSpeed: "fast" as const }; savePrefs(p, st);
    const q = loadPrefs(st); check("season position and speed are saved and restored", Math.abs(q.seasonPhase - 0.62) < 1e-12 && q.seasonSpeed === "fast" && JSON.parse(store[PREFS_KEY]).seasonPhase === 0.62);
    check("bad saved values fall back (speed->標準, phase->spring, wraps into 0..1)", sanitizePrefs({ seasonSpeed: "x", seasonPhase: "y" }).seasonSpeed === "normal" && sanitizePrefs({ seasonPhase: NaN }).seasonPhase === 0 && Math.abs(sanitizePrefs({ seasonPhase: 1.25 }).seasonPhase - 0.25) < 1e-12 && Math.abs(sanitizePrefs({ seasonPhase: -0.25 }).seasonPhase - 0.75) < 1e-12);
    check("old saved prefs (without season keys) still load with spring/標準", loadPrefs({ getItem: () => JSON.stringify({ control: "right" }), setItem: () => {} }).seasonPhase === 0); }
}
