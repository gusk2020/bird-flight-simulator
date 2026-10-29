/** 保存する設定(localStorage)。壊れた値・未知の値は項目ごとに既定値へ戻す。ゲームは必ず開始待ちで起動する(オートも自動開始しない)。 */
export type ControlMode = "both" | "right" | "left";
export type AutoPolicy = "life" | "scenic" | "adventure" | "random";
export type TimeSpeed = "slow" | "normal" | "fast";
export type SeasonSpeedPref = "fast" | "normal" | "slow";
export interface Prefs { control: ControlMode; autoPolicy: AutoPolicy; autoTimeSpeed: TimeSpeed; autoHideUi: boolean; seasonSpeed: SeasonSpeedPref; seasonPhase: number }
export const DEFAULT_PREFS: Prefs = { control: "both", autoPolicy: "random", autoTimeSpeed: "normal", autoHideUi: true, seasonSpeed: "normal", seasonPhase: 0 };
export const PREFS_KEY = "vindving.prefs.v1";
const CONTROLS: ControlMode[] = ["both", "right", "left"], POLICIES: AutoPolicy[] = ["life", "scenic", "adventure", "random"], SPEEDS: TimeSpeed[] = ["slow", "normal", "fast"], SPEEDS_SEASON: SeasonSpeedPref[] = ["fast", "normal", "slow"];
type Store = Pick<Storage, "getItem" | "setItem">;

const pick = <T extends string>(v: unknown, ok: T[], d: T): T => (ok as unknown[]).includes(v) ? (v as T) : d;
export function sanitizePrefs(raw: unknown): Prefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { control: pick(o.control, CONTROLS, DEFAULT_PREFS.control), autoPolicy: pick(o.autoPolicy, POLICIES, DEFAULT_PREFS.autoPolicy),
    autoTimeSpeed: pick(o.autoTimeSpeed, SPEEDS, DEFAULT_PREFS.autoTimeSpeed), autoHideUi: typeof o.autoHideUi === "boolean" ? o.autoHideUi : DEFAULT_PREFS.autoHideUi,
    seasonSpeed: pick(o.seasonSpeed, SPEEDS_SEASON, DEFAULT_PREFS.seasonSpeed), seasonPhase: typeof o.seasonPhase === "number" && Number.isFinite(o.seasonPhase) ? ((o.seasonPhase % 1) + 1) % 1 : DEFAULT_PREFS.seasonPhase };
}
const defaultStore = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } }; // プライベートモード等では例外になりうる
export function loadPrefs(store: Store | null = defaultStore()): Prefs {
  try { const s = store?.getItem(PREFS_KEY); return s ? sanitizePrefs(JSON.parse(s)) : { ...DEFAULT_PREFS }; } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(p: Prefs, store: Store | null = defaultStore()) { try { store?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* 保存できなくても遊べる */ } }
