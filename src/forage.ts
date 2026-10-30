import type { Flight, FlightInput } from "./flight";
import type { GroundKind } from "./layout";

/** 自動ついばみ: 草地・土・あぜ道を数歩歩くと、少し止まって頭を下げ、1〜3回ついばんでから歩き出す。 */
export const FORAGE = {
  stepMin: 1.4, stepMax: 3.6,    // 次のついばみまでに歩く距離 m(約5〜12歩)
  pauseMin: 0.5, pauseMax: 1.0,  // 止まっている時間 s
  peckMin: 1, peckMax: 3,        // ついばむ回数
  peckTime: 0.5,                 // 1回のついばみ s
  idleMin: 2.5, idleMax: 5,      // 立ち止まったままのときに、ついばみ始めるまで s
  stick: 0.4, stickY: 0.35,      // ついばみ開始時からこれ以上スティックを動かした(手動)ら「強い入力」として中断
};
export type ForageState = "idle" | "pause" | "peck";
const FORAGE_GROUND: GroundKind[] = ["grass", "soil", "ridge"];
const DT = 1 / 60;

export class Forage {
  state: ForageState = "idle";
  head = 0;                       // 頭の下がり具合 0..1(モデル用)
  stats = { sequences: 0, pecks: 0, interrupts: 0 };
  private walked = 0; private target = 2; private t = 0; private left = 0; private phase = 0; private idleT = 0; private idleGoal = 3; private seed: number; private x0 = 0; private y0 = 0;
  constructor(private groundAt: (x: number, z: number) => GroundKind, seed = 1) { this.seed = seed >>> 0; this.target = this.rnd(FORAGE.stepMin, FORAGE.stepMax); this.idleGoal = this.rnd(FORAGE.idleMin, FORAGE.idleMax); }
  private rnd(a: number, b: number) { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return a + (b - a) * (this.seed / 4294967296); }
  get active() { return this.state !== "idle"; }
  reset() { this.state = "idle"; this.head = 0; this.walked = 0; this.idleT = 0; this.phase = 0; }

  /** 物理の1ステップごとに入力へ重ねる。stickStrong=手動操作のスティックを「強い入力」として扱うか(オートはfalse)。 */
  apply(inp: FlightInput, f: Flight, stickStrong: boolean): FlightInput {
    const onGround = f.mode === "landed" && !f.hopping && f.stun <= 0 && f.agl < 0.15 && FORAGE_GROUND.includes(this.groundAt(f.pos.x, f.pos.z));
    if (!onGround) { if (this.state !== "idle") this.reset(); else this.head += (0 - this.head) * 0.2; return inp; }
    // 強い入力=羽ばたき、またはついばみ開始時から大きく変えたスティック(前へ倒したまま歩き続けている指は「変えていない」ので、ついばみは成立する)
    if (this.state === "idle") { this.x0 = inp.x; this.y0 = inp.y; }
    const strong = inp.flapTap || inp.flapHeld || (stickStrong && (Math.abs(inp.x - this.x0) > FORAGE.stick || inp.y - this.y0 > FORAGE.stickY));
    if (strong && this.state !== "idle") { this.state = "idle"; this.walked = 0; this.idleT = 0; this.stats.interrupts++; }
    switch (this.state) {
      case "idle": {
        if (f.walkV > 0.3) { this.walked += f.walkV * DT; this.idleT = 0; if (this.walked >= this.target && !strong) this.begin(); }
        else if (!inp.brake) { this.idleT += DT; if (this.idleT >= this.idleGoal && !strong) this.begin(true); }
        break;
      }
      case "pause": {
        inp.brake = false; inp.y = Math.min(inp.y, 0); this.t += DT;
        if (this.t >= this.left) { this.state = "peck"; this.phase = 0; this.t = 0; this.left = Math.round(this.rnd(FORAGE.peckMin - 0.49, FORAGE.peckMax + 0.49)); this.left = Math.max(FORAGE.peckMin, Math.min(FORAGE.peckMax, this.left)); }
        break;
      }
      case "peck": {
        inp.brake = false; inp.y = Math.min(inp.y, 0); this.phase += DT / FORAGE.peckTime;
        if (this.phase >= 1) { this.phase -= 1; this.stats.pecks++; if (--this.left <= 0) { this.state = "idle"; this.walked = 0; this.idleT = 0; this.target = this.rnd(FORAGE.stepMin, FORAGE.stepMax); this.idleGoal = this.rnd(FORAGE.idleMin, FORAGE.idleMax); } }
        break;
      }
    }
    const want = this.state === "peck" ? Math.sin(Math.PI * Math.min(1, this.phase)) : 0;
    this.head += (want - this.head) * (want > this.head ? 0.5 : 0.3); // 下げるのは素早く、戻すのは少しゆっくり
    return inp;
  }
  private begin(standing = false) { this.state = standing ? "peck" : "pause"; this.t = 0; this.phase = 0; this.left = standing ? Math.max(FORAGE.peckMin, Math.min(FORAGE.peckMax, Math.round(this.rnd(0.51, 3.49)))) : this.rnd(FORAGE.pauseMin, FORAGE.pauseMax); this.stats.sequences++; }
}
