import type { PaddyLook } from "./world";

/**
 * 季節。昼夜・天候とは独立した「年」の時計と、季節ごとの見た目・行動の偏りを返す純関数群。
 * 年の位置 phase は 0..1: 0=春の始まり, 0.25=夏, 0.5=秋, 0.75=冬(1で春へ戻る)。
 */
export type SeasonSpeed = "fast" | "normal" | "slow";
export const SEASON_YEAR_SECONDS: Record<SeasonSpeed, number> = { fast: 600, normal: 1800, slow: 3600 }; // 現実10分/30分/60分で1年
export const SEASON_NAMES = ["春", "夏", "秋", "冬"] as const;
export const seasonIndex = (phase: number) => Math.min(3, Math.floor(wrap01(phase) * 4));
export const wrap01 = (p: number) => ((p % 1) + 1) % 1;

export class SeasonClock {
  phase = 0;                // 初回は春から
  speed: SeasonSpeed = "normal";
  /** ゲーム内で進んだ秒数(一時停止中は0を渡す)。速度を変えても位置は飛ばない */
  advance(dt: number) { if (dt > 0) this.phase = wrap01(this.phase + dt / SEASON_YEAR_SECONDS[this.speed]); }
  setSpeed(s: SeasonSpeed) { this.speed = s; }
  get name() { return SEASON_NAMES[seasonIndex(this.phase)]; }
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mixHex = (a: number, b: number, t: number) => { const r = mix((a >> 16) & 255, (b >> 16) & 255, t), g = mix((a >> 8) & 255, (b >> 8) & 255, t), bl = mix(a & 255, b & 255, t); return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl); };
/** 区間キーフレーム(phase, 色)の間を滑らかに補間する(0と1でつながる) */
function ramp(p: number, keys: [number, number][]) {
  p = wrap01(p); for (let i = 0; i < keys.length; i++) { const [p0, c0] = keys[i], [p1, c1] = keys[(i + 1) % keys.length]; const e1 = i + 1 < keys.length ? p1 : p1 + 1; if (p >= p0 && p < e1 || (i === keys.length - 1 && p < keys[0][0])) { const pp = p < p0 ? p + 1 : p; return mixHex(c0, c1, smooth(p0, e1, pp)); } }
  return keys[0][1];
}
const rampN = (p: number, keys: [number, number][]) => { // 数値版
  p = wrap01(p); for (let i = 0; i < keys.length; i++) { const [p0, v0] = keys[i], [p1, v1] = keys[(i + 1) % keys.length]; const e1 = i + 1 < keys.length ? p1 : p1 + 1; if (p >= p0 && p < e1 || (i === keys.length - 1 && p < keys[0][0])) { const pp = p < p0 ? p + 1 : p; return mix(v0, v1, smooth(p0, e1, pp)); } }
  return keys[0][1];
};

export interface SeasonLook {
  /** 地面の草・土の色に掛ける色(0xRRGGBB、白=変化なし) */
  grassTint: number; weedTint: number; weedScale: number;
  /** 樹冠: 色の基準(落葉樹)、桜の混ざり具合、葉の量(0.25=ほぼ裸〜1) */
  leaf: number; blossom: number; leafAmount: number;
  /** 積雪 0..1(中程度。最大 SNOW_MAX) */
  snow: number;
  paddy: PaddyLook;
}
export const SNOW_MAX = 0.55;

/** 季節ごとの景観。どの量も phase に対して連続(季節境界で急に切り替わらない) */
export function seasonLook(phase: number): SeasonLook {
  const p = wrap01(phase);
  // 草・雑草: 春=明るい新緑 / 夏=濃い緑 / 秋=黄褐色 / 冬=枯れ草
  const grassTint = ramp(p, [[0, 0xe4f2cf], [0.1, 0xf3ffe0], [0.25, 0xcfe3b4], [0.42, 0xf2e3b0], [0.55, 0xf0cf93], [0.75, 0xd9c79a], [0.95, 0xe0d8b8]]);
  const weedTint = ramp(p, [[0, 0xd2f0b0], [0.12, 0xffffff], [0.3, 0xbfe39a], [0.5, 0xe8d98a], [0.62, 0xdcb779], [0.8, 0xb7a279], [0.95, 0xc9c09c]]);
  const weedScale = rampN(p, [[0, 0.7], [0.12, 1.0], [0.3, 1.5], [0.5, 1.2], [0.62, 0.9], [0.8, 0.55], [0.95, 0.6]]);
  // 樹冠: 葉の量(落葉)と色
  const leafAmount = rampN(p, [[0, 0.45], [0.12, 0.95], [0.25, 1.0], [0.45, 0.95], [0.6, 0.6], [0.72, 0.28], [0.9, 0.25], [0.97, 0.3]]);
  const leaf = ramp(p, [[0, 0xa6cf72], [0.12, 0x6fb04a], [0.25, 0x3f8036], [0.45, 0x4f7f30], [0.55, 0xc7a032], [0.65, 0xc9602a], [0.76, 0x9a6a46], [0.9, 0x7a6552], [0.97, 0x8a8a52]]);
  const blossom = rampN(p, [[0, 0.0], [0.02, 0.55], [0.07, 0.9], [0.13, 0.35], [0.18, 0.0]]); // 桜(春先)
  // 積雪: 冬の途中から積もり、春先に溶ける
  const snow = SNOW_MAX * rampN(p, [[0, 0.4], [0.05, 0.12], [0.1, 0], [0.74, 0], [0.8, 0.5], [0.87, 1.0], [0.93, 1.0]]);
  // 田んぼ: 春=水を張る→田植え(苗) / 夏=生長 / 秋=黄金→収穫(刈り株・水なし) / 冬=休耕(枯れ草・雪)
  const growth = rampN(p, [[0, 0.05], [0.04, 0.05], [0.09, 0.2], [0.25, 0.7], [0.4, 1.0], [0.5, 1.0], [0.58, 0.95], [0.6, 0.12], [0.75, 0.1], [0.97, 0.06]]);
  const rice = ramp(p, [[0, 0x8fbf5a], [0.09, 0x88c050], [0.25, 0x4f9a3a], [0.4, 0x5d9a3a], [0.5, 0xd8b64a], [0.57, 0xdcb23a], [0.6, 0xb59a5a], [0.75, 0x9b8a62], [0.97, 0x9a9468]]);
  const water = rampN(p, [[0, 0.5], [0.03, 0.88], [0.4, 0.88], [0.5, 0.6], [0.57, 0.3], [0.6, 0.0], [0.97, 0.0]]);
  return { grassTint, weedTint, weedScale, leaf, blossom, leafAmount, snow, paddy: { growth, rice, water } };
}

/** 季節ごとの行動の偏り(控えめ)。1=変化なし。どの季節でも飛行・着地・歩行はできる。 */
export interface SeasonBias { forage: number; roof: number; ground: number; water: number }
export function seasonBias(phase: number): SeasonBias {
  const p = wrap01(phase);
  return {
    forage: rampN(p, [[0, 1.25], [0.12, 1.2], [0.25, 1.0], [0.4, 1.0], [0.5, 1.3], [0.62, 1.3], [0.75, 0.8], [0.95, 0.85]]),  // ついばめる地面へ行く偏り: 春・秋に増え、冬は減る
    roof: rampN(p, [[0, 0.95], [0.25, 0.85], [0.45, 0.9], [0.62, 1.0], [0.75, 1.3], [0.95, 1.3]]),                                  // 屋根(日当たり)で休む偏り: 冬に増える
    ground: rampN(p, [[0, 1.1], [0.25, 1.1], [0.62, 1.15], [0.75, 0.85], [0.95, 0.9]]),                                             // 地面で過ごす偏り
    water: rampN(p, [[0, 1.0], [0.1, 1.05], [0.25, 1.4], [0.45, 1.3], [0.55, 1.0], [0.95, 0.8]]),                                    // 水田・水辺(夏に増える)
  };
}
