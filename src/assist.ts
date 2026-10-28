import type { Flight, FlightInput } from "./flight";

export const ASSIST = {
  minSpeed: 7,      // この対地速度を下回ったら自動で羽ばたく(通常の滑空は約9m/s)
  lowAgl: 10,       // 地面・屋根からこの高さ以下で
  sinkRate: -0.6,   // これ以上の速さで沈んでいれば羽ばたく(着地したいときは長押しで減速=補助停止)
  cooldown: 0.8,    // 自動羽ばたきの最短間隔(秒)。連打にならない
};

/**
 * 片手操作用の羽ばたき補助。飛行物理の定数は変えず、入力(flapTap)だけを足す。
 * 減速(長押し)中・地上・小ジャンプ中・電線上・衝突直後は何もしない。失速を消すほど強くはない(速度と高さが足りないときだけ)。
 */
export class FlapAssist {
  enabled = false; autoFlaps = 0; private last = -10;
  reset() { this.last = -10; }
  apply(inp: FlightInput, f: Flight): FlightInput {
    if (!this.enabled || f.mode !== "air" || f.hopping || f.stun > 0 || inp.brake || inp.flapTap || inp.flapHeld || f.strokeT >= 0) return inp;
    if (f.clock - this.last < ASSIST.cooldown) return inp;
    const low = f.speed < ASSIST.minSpeed || (f.agl < ASSIST.lowAgl && f.vel.y < ASSIST.sinkRate);
    if (low) { inp.flapTap = true; this.last = f.clock; this.autoFlaps++; }
    return inp;
  }
}
