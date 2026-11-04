import type { Flight, FlightInput } from "./flight";
import type { Surface } from "./perches";
import { AUTOLAND } from "./autoland";

/**
 * H8-C 遠くの目印を押したときの「接近先」。自動着地(AutoLand)は届く範囲が 18 m までなので、それより遠い目印は今までは「遠すぎ」と断られていた。
 * 押した目印を一時的な接近先に選び、(1) その方向へゆるやかに向きを合わせて近づき、(2) 自動着地の届く範囲に入ったら、既存の AutoLand.start()
 * で着地を始める。着地の開始の可否は AutoLand がこれまでどおり毎回検査する(この層は着地そのものには関わらない)。
 *  ・手動の操作(スティック・◎)が入っているあいだは操舵しない(押した人の操作が優先)。ワープ・急減速はしない: 出すのは通常の操舵入力(x, y)だけ。
 *  ・目印が背後・画面外・遮蔽・ボタンの上へ去ったら選択を解く(未開始のまま古い候補へ降りない)。
 *  ・開始した自動着地は、目印が消えても中断しない(それは AutoLand の状態)。
 */
export const APPROACH = {
  turnGain: 1.6, slewX: 2.2, slewY: 1.6,   // 向きの合わせ方の強さと、入力の変化の速さの上限(1/s)
  glideMaxRad: 0.2, pitchFull: 0.45, climbV: 9.5, // 降下/上昇の目標角の上限、上昇に必要な最低の速さ(これ未満では上げない = 失速させない)
  aimAbove: 3,                              // 足場の上面よりこれだけ高い点を狙って降りてくる(m)
  startEveryS: 0.2, giveUpS: 1.5, maxS: 30,  // 開始の試行間隔、「遠すぎ」以外の理由で断られ続けたら諦めるまで、最長の接近時間
  alignRad: 0.45, minStartD: 9,             // 開始は、足場の方を向いて(誤差 alignRad 以内)から。ただし近づきすぎ(minStartD m 未満)ならそのまま検査する
  brakeV: 9.5, brakeD: 40,                  // brakeD m 以内で brakeV m/s を超えていたら減速(通常のブレーキ入力)。計測: 減速なしで始めた着地の成功 60% → 85-90%
  manualX: 0.35, manualY: 0.35,             // 手動入力とみなす大きさ(これ以上なら操舵しない)
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Approach {
  id = -1; since = 0; lastReason = "";
  stats = { selected: 0, started: 0, gone: 0, goneBy: {} as Record<string, number>, refused: 0, cancelled: 0, timeout: 0, steerFrames: 0 };
  private lx = 0; private ly = 0; private nextTry = 0; private refuseSince = -1;
  get active() { return this.id >= 0; }
  select(id: number, t: number) { this.id = id; this.since = t; this.lx = this.ly = 0; this.nextTry = t; this.refuseSince = -1; this.lastReason = ""; this.stats.selected++; }
  clear(why: string) { if (this.id < 0) return; if (why.startsWith("gone")) { this.stats.gone++; const k = why.slice(5) || "other"; this.stats.goneBy[k] = (this.stats.goneBy[k] || 0) + 1; } else if (why === "timeout") this.stats.timeout++; else if (why !== "started") this.stats.cancelled++; this.lastReason = why; this.id = -1; this.lx = this.ly = 0; }
  /** 足場の方を向いているか(開始してよい向きか)。近すぎるときは向きを問わない */
  ready(f: Flight, s: Surface): boolean { const dx = (s.minX + s.maxX) / 2 - f.pos.x, dz = (s.minZ + s.maxZ) / 2 - f.pos.z; return Math.hypot(dx, dz) < APPROACH.minStartD || Math.abs(wrap(Math.atan2(-dx, -dz) - f.yaw)) < APPROACH.alignRad; }
  /** 物理ステップごと: 接近先の方向へ、通常の操舵入力(x: 旋回、y: 上下)を足す。手動の入力があれば足さない */
  steer(f: Flight, raw: FlightInput, s: Surface, dt: number) {
    if (this.id < 0 || f.mode !== "air") { this.lx = this.ly = 0; return; }
    const manual = Math.abs(raw.x) > APPROACH.manualX || Math.abs(raw.y) > APPROACH.manualY;
    if (manual) { this.lx = this.ly = 0; return; } // 手動の操作が入っているあいだは何も足さない(残っていた操舵もすぐ手放す)
    let x = 0, y = 0;
    {
      const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, dx = cx - f.pos.x, dz = cz - f.pos.z, d = Math.hypot(dx, dz);
      const want = Math.atan2(-dx, -dz); x = -clamp(wrap(want - f.yaw) * APPROACH.turnGain, -1, 1);
      const feet = f.pos.y - 0.32, g = Math.atan2(s.top + APPROACH.aimAbove - feet, Math.max(d - AUTOLAND.maxRange * 0.6, 4)), gc = clamp(g, -APPROACH.glideMaxRad, APPROACH.glideMaxRad);
      y = gc > 0 && f.speed < APPROACH.climbV ? 0 : clamp(gc / APPROACH.pitchFull, -1, 1); // 上昇が必要でも、速さが足りなければ上げない(失速させない)
      if (d < APPROACH.brakeD && f.speed > APPROACH.brakeV) raw.brake = true;
      this.stats.steerFrames++;
    }
    this.lx += clamp(x - this.lx, -APPROACH.slewX * dt, APPROACH.slewX * dt); this.ly += clamp(y - this.ly, -APPROACH.slewY * dt, APPROACH.slewY * dt);
    raw.x += this.lx; raw.y += this.ly;
  }
  /** フレームごと: 目印が去ったら解く。自動着地の届く範囲に入ったら AutoLand.start を試す(0.2 秒ごと)。start が true を返したら、その目印で自動着地が始まっている。 */
  update(t: number, visible: { s: Surface; d: number; near: boolean; ready?: boolean } | null, whyGone: string | null, start: (s: Surface) => boolean, refusal: () => string): "started" | "waiting" | "cleared" | "idle" {
    if (this.id < 0) return "idle";
    if (!visible) { this.clear("gone:" + (whyGone ?? "other")); return "cleared"; }
    if (t - this.since > APPROACH.maxS) { this.clear("timeout"); return "cleared"; }
    if (visible.d > AUTOLAND.maxRange || t < this.nextTry || visible.ready === false) return "waiting";
    this.nextTry = t + APPROACH.startEveryS;
    if (start(visible.s)) { this.stats.started++; this.clear("started"); return "started"; }
    const why = refusal(); this.lastReason = why;
    if (why === "too far") { this.refuseSince = -1; return "waiting"; }
    if (this.refuseSince < 0) this.refuseSince = t;
    if (t - this.refuseSince > APPROACH.giveUpS) { this.stats.refused++; this.clear("refused:" + why); return "cleared"; }
    return "waiting";
  }
}
