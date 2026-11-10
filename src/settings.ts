/** 保存する設定(localStorage)。壊れた値・未知の値は項目ごとに既定値へ戻す。ゲームは必ず開始待ちで起動する(オートも自動開始しない)。 */
import { STEER_MODES, type SteerMode } from "./steer";
import { sanitizePadCustom, type PadCustom } from "./proxpad";
export type GuideMode = "off" | "gauge" | "hud";
export const GUIDE_MODES: GuideMode[] = ["off", "gauge", "hud"];
export type ControlMode = "both" | "right" | "left";
export type AutoPolicy = "life" | "scenic" | "adventure" | "random";
export type TimeSpeed = "slow" | "normal" | "fast";
export type SeasonSpeedPref = "fast" | "normal" | "slow";
export interface Prefs { control: ControlMode; autoPolicy: AutoPolicy; autoTimeSpeed: TimeSpeed; autoHideUi: boolean; seasonSpeed: SeasonSpeedPref; seasonPhase: number; /** H8-A: 単一◎の操縦方式(off=従来) */ steer: SteerMode; /** H8-B: 着地点マーカーを表示するか */ landmarks: boolean; /** H9: ◎の位置(縦横の向きごと。null=既定の位置) */ pads: { land: PadCustom | null; port: PadCustom | null }; /** H9: 飛行ガイド(非表示/計器型/HUD型) */ guide: GuideMode }
export const DEFAULT_PREFS: Prefs = { control: "both", autoPolicy: "random", autoTimeSpeed: "normal", autoHideUi: true, seasonSpeed: "normal", steer: "off", landmarks: true, seasonPhase: 0, pads: { land: null, port: null }, guide: "off" };
export const PREFS_KEY = "vindving.prefs.v1";
const CONTROLS: ControlMode[] = ["both", "right", "left"], POLICIES: AutoPolicy[] = ["life", "scenic", "adventure", "random"], SPEEDS: TimeSpeed[] = ["slow", "normal", "fast"], SPEEDS_SEASON: SeasonSpeedPref[] = ["fast", "normal", "slow"];
type Store = Pick<Storage, "getItem" | "setItem">;

const pick = <T extends string>(v: unknown, ok: T[], d: T): T => (ok as unknown[]).includes(v) ? (v as T) : d;
export function sanitizePrefs(raw: unknown): Prefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { control: pick(o.control, CONTROLS, DEFAULT_PREFS.control), autoPolicy: pick(o.autoPolicy, POLICIES, DEFAULT_PREFS.autoPolicy),
    autoTimeSpeed: pick(o.autoTimeSpeed, SPEEDS, DEFAULT_PREFS.autoTimeSpeed), autoHideUi: typeof o.autoHideUi === "boolean" ? o.autoHideUi : DEFAULT_PREFS.autoHideUi,
    seasonSpeed: pick(o.seasonSpeed, SPEEDS_SEASON, DEFAULT_PREFS.seasonSpeed), steer: pick(o.steer, STEER_MODES, DEFAULT_PREFS.steer), landmarks: typeof o.landmarks === "boolean" ? o.landmarks : DEFAULT_PREFS.landmarks, pads: { land: sanitizePadCustom((o.pads as Record<string, unknown> | undefined)?.land), port: sanitizePadCustom((o.pads as Record<string, unknown> | undefined)?.port) }, guide: pick(o.guide, GUIDE_MODES, DEFAULT_PREFS.guide), seasonPhase: typeof o.seasonPhase === "number" && Number.isFinite(o.seasonPhase) ? ((o.seasonPhase % 1) + 1) % 1 : DEFAULT_PREFS.seasonPhase };
}
const defaultStore = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } }; // プライベートモード等では例外になりうる
export function loadPrefs(store: Store | null = defaultStore()): Prefs {
  try { const s = store?.getItem(PREFS_KEY); return s ? sanitizePrefs(JSON.parse(s)) : { ...DEFAULT_PREFS }; } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(p: Prefs, store: Store | null = defaultStore()) { try { store?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* 保存できなくても遊べる */ } }
