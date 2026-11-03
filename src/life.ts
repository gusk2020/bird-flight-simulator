/** H3 鳥の生活動作。止まっているとき、ときどき首をかしげる・羽づくろい・伸び・ふくらみ・ぶるぶる、水辺では水を飲む・水浴びをする。
 *  専用ボタンはない。歩く・羽ばたく・スティックを倒すと、すぐやめる。 */
export type LifeAct = "none" | "look" | "preen" | "stretch" | "fluff" | "shake" | "drink" | "bathe";
export const LIFE = {
  idleMin: 2.5, idleMax: 7,            // 動作の間隔 s(立っているとき)
  restIdleMin: 1.2, restIdleMax: 3.5,  // 座って休んでいるときの間隔 s(動作が続く)
  dur: { look: 2.4, preen: 3.2, stretch: 2.0, fluff: 1.6, shake: 0.9, drink: 3.0, bathe: 4.0 } as Record<Exclude<LifeAct, "none">, number>,
  drinkChance: 0.7,                    // 水辺で動作を選ぶとき、水を飲む確率
  bathChance: 0.35,                    // 座って休んでいるとき、水辺なら水浴びを選ぶ確率
  ease: 10,                            // 姿勢の追従の速さ(1/s)
};
export interface LifePose { headYaw: number; headDip: number; wingSpread: number; fluff: number; shake: number; tilt: number }
export const NEUTRAL: LifePose = { headYaw: 0, headDip: 0, wingSpread: 0, fluff: 0, shake: 0, tilt: 0 };
export interface LifeCtx { landed: boolean; moving: boolean; input: boolean; sitting: boolean; water: boolean; onWaterEdge: boolean }
const smooth = (u: number) => Math.sin(Math.PI * Math.min(1, Math.max(0, u)));

export class Life {
  act: LifeAct = "none"; t = 0; wait = 3; pose: LifePose = { ...NEUTRAL };
  stats = { started: 0, cancelled: 0, byAct: {} as Record<string, number> };
  constructor(private rnd: () => number = Math.random) { this.wait = this.gap(false); }
  private gap(rest: boolean) { return rest ? LIFE.restIdleMin + this.rnd() * (LIFE.restIdleMax - LIFE.restIdleMin) : LIFE.idleMin + this.rnd() * (LIFE.idleMax - LIFE.idleMin); }
  cancel() { if (this.act !== "none") { this.stats.cancelled++; this.act = "none"; this.t = 0; this.wait = 0.6; } }
  private choose(c: LifeCtx): LifeAct {
    if (c.water) { if (c.sitting && this.rnd() < LIFE.bathChance) return "bathe"; if (this.rnd() < LIFE.drinkChance) return "drink"; }
    const r = this.rnd(), pool: LifeAct[] = c.sitting ? ["preen", "preen", "stretch", "fluff", "look", "shake"] : ["look", "look", "preen", "stretch", "fluff", "shake"];
    return pool[Math.min(pool.length - 1, Math.floor(r * pool.length))];
  }
  update(dt: number, c: LifeCtx): LifePose {
    if (!c.landed || c.moving || c.input) this.cancel();
    else if (this.act === "none") {
      this.wait -= dt;
      if (this.wait <= 0) { this.act = this.choose(c); this.t = 0; this.stats.started++; this.stats.byAct[this.act] = (this.stats.byAct[this.act] || 0) + 1; }
    } else {
      this.t += dt;
      if (this.t >= LIFE.dur[this.act as Exclude<LifeAct, "none">]) { this.act = "none"; this.t = 0; this.wait = this.gap(c.sitting); }
    }
    const a = this.act, u = a === "none" ? 0 : this.t / LIFE.dur[a as Exclude<LifeAct, "none">], tg: LifePose = { ...NEUTRAL };
    switch (a) {
      case "look": tg.headYaw = Math.sin(u * Math.PI * 2.5) * 0.9; tg.tilt = Math.sin(u * Math.PI * 3) * 0.12; break;
      case "preen": tg.headYaw = 1.0 * smooth(u * 1.2); tg.headDip = 0.4 * smooth(u * 1.2) * (0.6 + 0.4 * Math.sin(u * 26)); break;
      case "stretch": tg.wingSpread = smooth(u); tg.headDip = -0.3 * smooth(u); break;
      case "fluff": tg.fluff = smooth(u); break;
      case "shake": tg.shake = smooth(u); break;
      case "drink": tg.headDip = 0.5 + 0.5 * Math.max(0, Math.sin(u * Math.PI * 6)); break;
      case "bathe": tg.wingSpread = 0.5 * smooth(u); tg.shake = 0.8 * smooth(u * 2) * Math.abs(Math.sin(u * 40)); tg.headDip = 0.3; break;
    }
    const k = 1 - Math.exp(-LIFE.ease * dt), p = this.pose;
    (Object.keys(p) as (keyof LifePose)[]).forEach(key => { p[key] += (tg[key] - p[key]) * k; });
    return p;
  }
}
