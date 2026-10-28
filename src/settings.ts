/** 保存する設定(localStorage)。壊れた値・未知の値は項目ごとに既定値へ戻す。ゲームは必ず開始待ちで起動する(オートも自動開始しない)。 */
export type ControlMode = "both" | "right" | "left";
export type AutoPolicy = "life" | "scenic" | "adventure" | "random";
export type TimeSpeed = "slow" | "normal" | "fast";
export interface Prefs { control: ControlMode; autoPolicy: AutoPolicy; autoTimeSpeed: TimeSpeed; autoHideUi: boolean }
export const DEFAULT_PREFS: Prefs = { control: "both", autoPolicy: "random", autoTimeSpeed: "normal", autoHideUi: true };
export const PREFS_KEY = "vindving.prefs.v1";
const CONTROLS: ControlMode[] = ["both", "right", "left"], POLICIES: AutoPolicy[] = ["life", "scenic", "adventure", "random"], SPEEDS: TimeSpeed[] = ["slow", "normal", "fast"];
type Store = Pick<Storage, "getItem" | "setItem">;

const pick = <T extends string>(v: unknown, ok: T[], d: T): T => (ok as unknown[]).includes(v) ? (v as T) : d;
export function sanitizePrefs(raw: unknown): Prefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { control: pick(o.control, CONTROLS, DEFAULT_PREFS.control), autoPolicy: pick(o.autoPolicy, POLICIES, DEFAULT_PREFS.autoPolicy),
    autoTimeSpeed: pick(o.autoTimeSpeed, SPEEDS, DEFAULT_PREFS.autoTimeSpeed), autoHideUi: typeof o.autoHideUi === "boolean" ? o.autoHideUi : DEFAULT_PREFS.autoHideUi };
}
const defaultStore = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } }; // プライベートモード等では例外になりうる
export function loadPrefs(store: Store | null = defaultStore()): Prefs {
  try { const s = store?.getItem(PREFS_KEY); return s ? sanitizePrefs(JSON.parse(s)) : { ...DEFAULT_PREFS }; } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(p: Prefs, store: Store | null = defaultStore()) { try { store?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* 保存できなくても遊べる */ } }
