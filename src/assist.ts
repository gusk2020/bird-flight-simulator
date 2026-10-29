import type { Flight, FlightInput } from "./flight";

export const ASSIST = {
  minSpeed: 7.5,     // この対気速度を下回ったら自動で羽ばたく(通常の滑空は約9m/s)
  lowAgl: 10,        // 地面・屋根からこの高さ以下で
  sinkRate: -0.6,    // これ以上の速さで沈んでいれば羽ばたく(着地したいときは長押しで減速=補助停止)
  cooldown: 0.8,     // 自動羽ばたきの最短間隔(秒)。連打にならない
  // F4: 先読み。少し先の高さ(前方の建物を含む)が足りなくなりそうなら、早めに羽ばたく
  lookSec: 1.6,      // 何秒先まで見るか
  clearance: 5,      // 先読みした足元の余裕がこれ(m)を切りそうなら羽ばたく
  urgentCooldown: 0.5, // 余裕がないときの間隔
  // 指を離している間: しばらくは沈み込みを抑えて高度を保つ。長く離したままなら、ゆっくり降りていく(無限飛行にしない)
  handsOffHold: 8,   // 離してからこの秒数までは、緩い沈下(-0.8m/s)でも羽ばたく
  handsOffSink: -2.2, // それ以降は、この沈下より速いときだけ(ゆっくり滑空して降りる)
  diveStick: -0.3,   // これより下へ倒している=意図的な降下・急降下: 補助しない(地面すれすれを除く)
  neutralY: 0.15,    // 昇降がこの範囲(中立)のときだけ、旋回中に機首を少し上げる
  turnSlow: 8,       // これより遅いときは旋回入力を弱める
  turnSink: -1.8,
  alphaWarn: 0.22,   // 迎え角がこれを超えたら(失速0.3の手前)機首を少し下げる    // 操作中でも、これより速く沈んでいれば羽ばたく
};

/**
 * 片手操作用の羽ばたき補助。飛行物理の定数は変えず、入力(flapTap)だけを足す。
 * 減速(長押し)中・地上・小ジャンプ中・電線上・衝突直後・着地の直前(着地補助が狙っている足場の近く)は何もしない。
 * 速さと高さが足りなくなりそうなときだけ羽ばたく。指を長く離したままなら、ゆっくり降りていく。
 */
export class FlapAssist {
  enabled = false; autoFlaps = 0; turnAssists = 0; private last = -10; private touchT = 0;
  reset() { this.last = -10; this.touchT = 0; }
  /** landing=着地補助が近くの足場を狙っている(高度を上げすぎない) */
  apply(inp: FlightInput, f: Flight, landing = false): FlightInput {
    if (Math.abs(inp.x) > 0.05 || Math.abs(inp.y) > 0.05 || inp.flapTap || inp.flapHeld || inp.brake) this.touchT = f.clock;
    if (!this.enabled || f.mode !== "air" || f.hopping || f.stun > 0 || inp.brake || landing) return inp;
    const dive = inp.y < ASSIST.diveStick; // 本人の入力で判断(補助が足した分は含めない)
    // 失速中は翼を水平に戻して回復させる。遅いときは急旋回を少し緩める(旋回で速度を失って失速→落下するのを防ぐ)
    if (f.stall) { inp.x *= 0.2; inp.y = Math.min(inp.y, 0); }
    else if (f.speed < ASSIST.turnSlow) inp.x *= Math.max(0.3, (f.speed - 4) / (ASSIST.turnSlow - 4));
    // 失速の手前(迎え角が大きい)で、上昇を強く指示していなければ、機首を少し下げて失速を防ぐ
    if (!f.stall && f.alpha > ASSIST.alphaWarn && inp.y < 0.5 && f.agl > 2) { inp.y -= Math.min(0.5, (f.alpha - ASSIST.alphaWarn) * 6); this.turnAssists++; }
    if (dive && f.agl > 3) return inp; // 急降下の楽しさは残す
    if (inp.flapTap || inp.flapHeld || f.strokeT >= 0) return inp;
    // 先読み: 少し先の足元の余裕(前方の建物・地形も見る)
    const T = ASSIST.lookSec, hx = f.vel.x, hz = f.vel.z, feet = f.pos.y + f.vel.y * T;
    let ground = f.pos.y - f.agl;
    if (f.world.heightAt) for (const k of [0.5, 1]) ground = Math.max(ground, f.world.heightAt(f.pos.x + hx * T * k, f.pos.z + hz * T * k));
    const margin = feet - ground, urgent = margin < ASSIST.clearance || (f.speed < ASSIST.minSpeed && Math.abs(inp.x) > 0.2); // 旋回中の失速は早めに
    if (f.clock - this.last < (urgent ? ASSIST.urgentCooldown : ASSIST.cooldown)) return inp;
    const off = f.clock - this.touchT, hold = off < ASSIST.handsOffHold;
    const low = f.speed < ASSIST.minSpeed || urgent || (f.agl < ASSIST.lowAgl && f.vel.y < ASSIST.sinkRate)
      || (!dive && off > 0.3 && f.vel.y < (hold ? -0.8 : ASSIST.handsOffSink) && f.agl < 40)
      || (!dive && f.vel.y < ASSIST.turnSink && f.agl < 40); // 旋回などで沈み込みが大きいとき
    if (low) { inp.flapTap = true; this.last = f.clock; this.autoFlaps++; }
    return inp;
  }
}
