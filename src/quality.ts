/** 描画負荷の自動調整。実測FPSが低ければ解像度を段階的に下げ、余裕が続けば戻す。 */
export const PIXEL_RATIOS = [1.5, 1.25, 1.0, 0.8];
export class Quality {
  level = 0; private t = 0; private n = 0; private good = 0; private cooldown = 0;
  constructor(public lowFps = 38, public highFps = 56, public window = 2) {}
  /** 実行中のフレーム時間だけ渡す。レベルが変わったら true */
  update(dt: number): boolean {
    if (dt <= 0 || dt > 0.5) return false; // 停止明け・タブ復帰の異常値は無視
    this.t += dt; this.n++; this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.t < this.window) return false;
    const fps = this.n / this.t; this.t = 0; this.n = 0;
    if (fps < this.lowFps && this.level < PIXEL_RATIOS.length - 1) { this.level++; this.good = 0; this.cooldown = 6; return true; }
    if (fps > this.highFps) this.good++; else this.good = 0;
    if (this.good >= 3 && this.level > 0 && this.cooldown === 0) { this.level--; this.good = 0; this.cooldown = 6; return true; }
    return false;
  }
  get pixelRatio() { return PIXEL_RATIOS[this.level]; }
  get rainDensity() { return this.level >= 2 ? 0.5 : 1; }
}
