import type { Flight, FlightInput } from "./flight";

export type GameState = "ready" | "running" | "paused";
export const STEP = 1 / 60;
const MAX_FRAME = 0.1, MAX_STEPS = 6;

/**
 * ゲーム進行(開始・一時停止・固定時間刻み)。描画・DOMには依存しない。
 * 一時停止中は物理時間もゲーム時間も進めず、再開時は経過時間を捨てる(瞬間移動防止)。
 */
export class Game {
  state: GameState = "ready";
  gameTime = 0;   // 実際に物理を進めた秒数 (停止中は増えない)
  steps = 0;      // 物理ステップ総数
  acc = 0;
  onPause: () => void = () => {};   // 入力解除など
  constructor(private flight: Flight, private readInput: () => FlightInput, private clearTap: () => void) {}

  start() { if (this.state === "ready") { this.state = "running"; this.acc = 0; } }
  pause() { if (this.state === "running") { this.state = "paused"; this.acc = 0; this.onPause(); } }
  resume() { if (this.state === "paused") { this.state = "running"; this.acc = 0; } }
  /** 画面OFF・アプリ切替など。開始前なら何もしない */
  suspend() { this.pause(); }
  reset() { this.flight.reset(); this.acc = 0; }

  /** 実時間 dt(秒) を渡す。実行した物理ステップ数を返す。 */
  update(dt: number): number {
    if (this.state !== "running") return 0;
    this.acc += Math.min(Math.max(dt, 0), MAX_FRAME);
    let n = 0;
    while (this.acc >= STEP) {
      this.flight.step(STEP, this.readInput()); this.clearTap();
      this.acc -= STEP; this.gameTime += STEP; this.steps++;
      if (++n >= MAX_STEPS) { this.acc = 0; break; }
    }
    return n;
  }
  /** 描画補間係数 */
  get alpha() { return this.state === "running" ? this.acc / STEP : 0; }
}
