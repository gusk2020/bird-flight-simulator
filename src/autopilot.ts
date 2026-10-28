import type { Flight, FlightInput } from "./flight";
import type { Layout } from "./layout";
import { PHYS as P } from "./params";
import type { AutoPolicy } from "./settings";

/**
 * オート周遊。既存のFlight物理に「入力」だけを与えて飛ばす(位置の直接書き換えはしない)。
 * 判断は約5Hzに間引き、毎ステップは舵の平滑化だけ。経路探索はせず、目標点・高度の更新と前方の高さ確認だけで障害物を避ける。
 */
export type PilotState = "cruise" | "approach" | "rest" | "walk" | "takeoff";
type Kind = "ground" | "roof" | "wire";
interface Target { x: number; y: number; z: number; kind: Kind; wire: number; dirx: number; dirz: number; box: number; tries: number }
interface Weights { alt: [number, number]; leg: [number, number]; landP: number; rest: [number, number]; walkP: number; walk: [number, number]; spots: [number, number] } // spots: 地面の確率, 屋根の確率(残りは電線)
export const WEIGHTS: Record<Exclude<AutoPolicy, "random">, Weights> = {
  life:      { alt: [14, 26], leg: [50, 110],  landP: 0.85, rest: [8, 22], walkP: 0.8, walk: [8, 20], spots: [0.6, 0.2] },   // 自然生活: 着地・歩行・休憩が多い
  scenic:    { alt: [35, 65], leg: [110, 200], landP: 0.12, rest: [3, 7],  walkP: 0.2, walk: [3, 6],  spots: [0.1, 0.7] },   // 景色観賞: 高く長く飛ぶ
  adventure: { alt: [9, 22],  leg: [40, 90],   landP: 0.55, rest: [3, 9],  walkP: 0.4, walk: [4, 10], spots: [0.2, 0.35] },  // 冒険探索: 低く、屋根・電線を巡る
};
const SUB: Exclude<AutoPolicy, "random">[] = ["life", "scenic", "adventure"];
const BOUND = 165; // これより外へは向かわない(物理の境界は205)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export class Autopilot {
  state: PilotState = "cruise"; policy: AutoPolicy = "random"; active: Exclude<AutoPolicy, "random"> = "life"; enabled = false;
  stats = { landings: 0, walks: 0, perches: 0, takeoffs: 0, flaps: 0, replans: 0, teleports: 0, avoids: 0, switches: 0 };
  private r: () => number; private t = 0; private decideT = 0; private stateT = 0; private policyT = 0;
  private wx = 0; private wz = 0; private alt = 20; private tgt: Target | null = null;
  private sx = 0; private sy = 0; private lastFlap = -10; private lastGoal = 0;
  private px = 0; private pz = 0; private progT = 0; private watchT = 0; private wpx = 0; private wpz = 0;
  private restFor = 5; private walkFor = 0; private walkYaw = 0; private blocked = 0; private takeoffT = 0; private hopped = false;
  private lastCrashes = 0; private emerg = 0; private emergDir = 1;
  constructor(private L: Layout, seed = 1) { this.r = rng(seed); }

  setPolicy(p: AutoPolicy) { this.policy = p; if (p !== "random") this.active = p; else this.policyT = 0; } // 次の判断から変わるだけ(位置・速度は変えない)
  start(f: Flight) {
    this.enabled = true; this.t = 0; this.decideT = 0; this.sx = this.sy = 0; this.tgt = null; this.px = f.pos.x; this.pz = f.pos.z; this.progT = 0; this.watchT = 0; this.lastCrashes = f.crashes; this.emerg = 0;
    if (this.policy === "random") this.pickActive();
    if (f.mode === "air") { this.enter("cruise"); this.newWaypoint(f); } else { this.enter("rest"); this.restFor = 1 + this.r() * 2; }
  }
  stop() { this.enabled = false; this.sx = this.sy = 0; this.tgt = null; }
  private pickActive() { this.active = SUB[Math.floor(this.r() * 3)]; this.policyT = 60 + this.r() * 60; this.stats.switches++; }
  private w() { return WEIGHTS[this.active]; }
  private enter(s: PilotState) { this.state = s; this.stateT = 0; }
  private between(a: [number, number]) { return a[0] + (a[1] - a[0]) * this.r(); }

  // ------------------------------------------------------------------ 判断(約5Hz)
  private newWaypoint(f: Flight, away = false) {
    const w = this.w(), len = this.between(w.leg); let yaw = f.yaw + (this.r() - 0.5) * 2 * 1.0; // 現在の向きから±約57°
    if (away) yaw = f.yaw + Math.PI + (this.r() - 0.5);
    let x = f.pos.x - Math.sin(yaw) * len, z = f.pos.z - Math.cos(yaw) * len;
    if (Math.abs(x) > BOUND || Math.abs(z) > BOUND) { // 外へ向かわない: 街の中心側へ
      const cx = (this.r() - 0.5) * 120, cz = (this.r() - 0.5) * 120; x = cx; z = cz;
    }
    this.wx = x; this.wz = z; this.alt = this.between(w.alt); this.stats.replans++; this.lastGoal = this.t;
  }
  private heightsAhead(f: Flight, yaw: number, dist: number, ignore: Target | null) {
    const ax = -Math.sin(yaw), az = -Math.cos(yaw); let top = 0;
    for (let k = 1; k <= 3; k++) {
      const d = (dist * k) / 3, x = f.pos.x + ax * d, z = f.pos.z + az * d;
      if (ignore && ignore.box > 0 && Math.abs(x - ignore.x) < ignore.box && Math.abs(z - ignore.z) < ignore.box) continue; // 着地目標の建物自体は避けない
      top = Math.max(top, this.L.heightAt(x, z), this.L.heightAt(x + az * 3, z - ax * 3), this.L.heightAt(x - az * 3, z + ax * 3)); // 両翼分も見る
    }
    return top;
  }
  private pickTarget(f: Flight): Target | null {
    const w = this.w(), r = this.r;
    for (let tries = 0; tries < 14; tries++) {
      const roll = r(), ang = f.yaw + (r() - 0.5) * 1.6, dist = 35 + r() * 80, x = f.pos.x - Math.sin(ang) * dist, z = f.pos.z - Math.cos(ang) * dist;
      if (Math.abs(x) > BOUND || Math.abs(z) > BOUND) continue;
      if (roll < w.spots[0]) { // 地面(歩道・敷地): 周囲に建物がない開けた場所
        const gy = this.L.heightAt(x, z); if (gy > 0.2 || [[4, 0], [-4, 0], [0, 4], [0, -4]].some(([ox, oz]) => this.L.heightAt(x + ox, z + oz) > 0.2)) continue;
        return { x, y: gy, z, kind: "ground", wire: -1, dirx: 0, dirz: 0, box: 0, tries: 0 };
      }
      if (roll < w.spots[0] + w.spots[1]) { // 屋根
        const cs = this.L.colliders; const c = cs[Math.floor(r() * cs.length)];
        if (c.top < 3 || c.maxX - c.minX < 4 || c.maxZ - c.minZ < 4) continue;
        const tx = (c.minX + c.maxX) / 2, tz = (c.minZ + c.maxZ) / 2, hy = this.L.heightAt(tx, tz);
        if (hy !== c.top) continue; // 屋上設備の上などは避ける
        return { x: tx, y: c.top, z: tz, kind: "roof", wire: -1, dirx: 0, dirz: 0, box: Math.max(c.maxX - c.minX, c.maxZ - c.minZ) / 2 + 1, tries: 0 };
      }
      const id = Math.floor(r() * this.L.wires.length), o = { x: 0, y: 0, z: 0 }; this.L.perchPoint(id, 0.5, o);
      if (Math.abs(o.x) > BOUND || Math.abs(o.z) > BOUND) continue;
      if ([[4, 0], [-4, 0], [0, 4], [0, -4]].some(([ox, oz]) => this.L.heightAt(o.x + ox, o.z + oz) > o.y - 1)) continue; // 近くに高い建物がある電線は避ける
      const d = this.L.wireDir(id); const sign = (-Math.sin(f.yaw) * d[0] - Math.cos(f.yaw) * d[1]) >= 0 ? 1 : -1; // 進入は電線の向きに近い側から
      return { x: o.x, y: o.y, z: o.z, kind: "wire", wire: id, dirx: d[0] * sign, dirz: d[1] * sign, box: 0, tries: 0 };
    }
    return null;
  }
  private decide(f: Flight) {
    const dx = this.wx - f.pos.x, dz = this.wz - f.pos.z;
    if (this.policy === "random" && this.t > 0) { this.policyT -= 0.2; if (this.policyT <= 0) this.pickActive(); }
    if (f.mode === "perch" && this.state !== "rest" && this.state !== "takeoff" && this.state !== "walk") { this.stats.perches++; this.enter("rest"); this.restFor = this.between(this.w().rest); return; }
    if (this.state === "cruise") {
      if (Math.hypot(dx, dz) < 18 || this.t - this.lastGoal > 40) {
        if (this.r() < this.w().landP) { const tg = this.pickTarget(f); if (tg) { this.tgt = tg; this.enter("approach"); return; } }
        this.newWaypoint(f);
      }
    } else if (this.state === "approach" && this.tgt) {
      const g = this.tgt, d = Math.hypot(g.x - f.pos.x, g.z - f.pos.z);
      if (this.stateT > 45) { this.stats.replans++; this.tgt = null; this.enter("cruise"); this.newWaypoint(f); }
      else if (g.kind === "wire" && d < 3 && f.pos.y > g.y + 1.5) { if (++g.tries > 2) { this.tgt = null; this.enter("cruise"); this.newWaypoint(f); } else this.stateT = 20; }
    }
  }

  // ------------------------------------------------------------------ 毎ステップの舵
  private steer(f: Flight, tx: number, tz: number, hardness = 1.6) {
    const e = wrap(Math.atan2(-(tx - f.pos.x), -(tz - f.pos.z)) - f.yaw);
    return -clamp(e * hardness, -1, 1) * (Math.abs(e) < 0.04 ? 0 : 1);
  }
  private flap(f: Flight, o: FlightInput, force = false) { if (f.clock - this.lastFlap > P.strokeTime * 2.2 || force) { if (f.strokeT < 0) { o.flapTap = true; this.lastFlap = f.clock; this.stats.flaps++; } } }

  drive(f: Flight, o: FlightInput, dt: number): FlightInput {
    o.x = o.y = 0; o.flapTap = o.flapHeld = o.brake = false;
    if (!this.enabled) return o;
    this.t += dt; this.stateT += dt; this.decideT += dt; this.watchT += dt; this.progT += dt;
    if (this.decideT >= 0.2) { this.decideT = 0; this.decide(f); }
    if (f.crashes !== this.lastCrashes) { this.lastCrashes = f.crashes; this.emerg = 1.2; this.stats.avoids++; if (this.state === "cruise" || this.state === "approach") { this.alt = Math.max(this.alt, f.pos.y + 12); } }
    if (this.emerg > 0) this.emerg -= dt;
    // 見張り: 動かなくなったら新しい目標へ。最終手段のみ安全な空中へ戻す(テレポート)
    if (this.watchT >= 3) {
      const moved = Math.hypot(f.pos.x - this.px, f.pos.z - this.pz); this.px = f.pos.x; this.pz = f.pos.z; this.watchT = 0;
      const airborne = f.mode === "air", still = moved < 2.5;
      if (airborne && this.state !== "takeoff" && moved < 6) { this.blocked++; this.stats.replans++; this.newWaypoint(f, true); this.alt = Math.max(this.alt, f.pos.y + 10); if (this.state === "approach") { this.tgt = null; this.enter("cruise"); } }
      else if (still && (this.state === "walk" || this.state === "takeoff")) this.blocked++;
      else if (!still || this.state === "rest") this.blocked = 0;
      if (this.blocked >= 10) { this.blocked = 0; this.stats.teleports++; this.teleport(f); }
    }
    switch (this.state) {
      case "cruise": this.fly(f, o, this.wx, this.wz, this.alt); break;
      case "approach": this.approach(f, o); break;
      case "rest": this.rest(f, o); break;
      case "walk": this.walkStep(f, o, dt); break;
      case "takeoff": this.takeoff(f, o); break;
    }
    // 舵の平滑化(小刻みな操作・進路の反転を防ぐ)
    const k = 1 - Math.exp(-dt / 0.25); this.sx += (o.x - this.sx) * k; this.sy += (o.y - this.sy) * (1 - Math.exp(-dt / 0.35));
    o.x = this.sx; o.y = this.sy;
    return o;
  }

  private fly(f: Flight, o: FlightInput, tx: number, tz: number, alt: number, ignore: Target | null = null) {
    if (f.mode !== "air") { this.afterLanding(f); return; }
    let want = alt, sx = this.steer(f, tx, tz);
    // 前方の建物: 越えられる高度を確保。間に合わないなら横へかわす
    const look = clamp(f.speed * 2.4, 16, 46), top = this.heightsAhead(f, f.yaw, look, ignore) + 7;
    if (top > 7.5) want = Math.max(want, top);
    if (f.pos.y < top - 5 && this.heightsAhead(f, f.yaw, look / 2, ignore) + 3 > f.pos.y) { // 近すぎる壁: 低い側へ旋回
      const l = this.heightsAhead(f, f.yaw + 0.8, look, ignore), rr = this.heightsAhead(f, f.yaw - 0.8, look, ignore); this.emergDir = l < rr ? -1 : 1; this.stats.avoids++;
      sx = this.emergDir; want = Math.max(want, top + 3);
    }
    if (this.emerg > 0) sx = this.emergDir;
    const err = want - f.pos.y;
    o.x = sx; o.y = clamp(err * 0.07, -0.5, 0.8);
    const slow = f.speed < 7.5, needLift = err > 1.5 && f.vel.y < 0.8;
    if (slow || needLift || (f.agl < 6 && f.vel.y < -1)) this.flap(f, o);
    // 低速で機首を上げると失速する: 遅いときは機首を上げず、羽ばたきで速度・高度を得る
    if (f.speed < 8.5) o.y = Math.min(o.y, 0.05);
    if (f.speed < 6.5 || f.stall) o.y = Math.min(o.y, -0.15);
  }

  private approach(f: Flight, o: FlightInput) {
    const g = this.tgt; if (!g) { this.enter("cruise"); this.newWaypoint(f); return; }
    if (f.mode !== "air") { this.afterLanding(f); return; }
    const dx = g.x - f.pos.x, dz = g.z - f.pos.z, d = Math.hypot(dx, dz);
    if (g.kind === "wire") return this.approachWire(f, o, g, d);
    const slope = g.kind === "roof" ? 0.3 : 0.22, alt = g.y + 0.9 + Math.max(0, d - 4) * slope + (g.kind === "roof" ? 2.5 : 0); // 目標へ向けて浅く降りる
    this.fly(f, o, g.x, g.z, d > 70 ? Math.max(alt, 12) : alt, g);
    if (d < 20 && f.speed > 8) o.brake = true;               // 手前で減速(失速しない範囲まで)
    if (f.speed < 7.5) o.brake = false;
    if (d < 14 && f.pos.y - f.agl > 0) o.y = clamp(o.y, -0.35, 0.4); // 着地前は急な上下をしない
    if (o.brake) o.flapTap = false;
  }
  private approachWire(f: Flight, o: FlightInput, g: Target, d: number) {
    const ex = g.x - g.dirx * 14, ez = g.z - g.dirz * 14, lat = (f.pos.x - g.x) * -g.dirz + (f.pos.z - g.z) * g.dirx, along = (f.pos.x - g.x) * g.dirx + (f.pos.z - g.z) * g.dirz;
    if (along < -8 || Math.hypot(ex - f.pos.x, ez - f.pos.z) > 10 && along < -2) { // まず進入点(電線の手前)へ。高さは電線の少し上
      this.fly(f, o, ex, ez, g.y + 3.5, g); return;
    }
    // 電線に沿って進み、横ずれを直しながら電線の高さへ降りる。減速して捕まえる
    const aim = this.steer(f, g.x + g.dirx * 10 - lat * 0 , g.z + g.dirz * 10, 1.6);
    const corr = clamp(-lat * 0.35, -1, 1); // 横ずれ補正(電線の左右どちらかにいる分だけ寄せる)
    o.x = clamp(aim * 0.5 + corr * 0.8, -1, 1);
    const target = g.y + 0.32 + 0.1, err = target - f.pos.y; o.y = clamp(err * 0.25, -0.4, 0.5);
    if (f.speed > 6.5) o.brake = true; else o.brake = f.pos.y - target < 1.2;  // 近づいたら減速を保つ(これが着地の意思表示)
    if (f.speed < 5 && err > 0.3) { this.flap(f, o); o.brake = false; }
    if (along > 12) { this.tgt = null; this.stats.replans++; this.enter("cruise"); this.newWaypoint(f); }
  }
  private afterLanding(f: Flight) {
    if (f.mode === "air") return;
    if (this.state === "approach") { this.stats.landings++; if (f.mode === "perch") this.stats.perches++; }
    this.tgt = null; this.enter("rest"); this.restFor = this.between(this.w().rest);
  }

  private rest(f: Flight, o: FlightInput) {
    if (f.mode === "air") { this.enter("cruise"); this.newWaypoint(f); return; }
    if (f.mode === "rollout") { o.brake = true; return; }
    if (f.mode === "landed" || f.mode === "perch") {
      // 休憩中はときどきゆっくり向きを変える
      if (Math.sin(this.stateT * 0.9) > 0.97) o.x = 0.4;
      if (this.stateT > this.restFor) {
        if (f.mode === "landed" && this.r() < this.w().walkP) { this.enter("walk"); this.walkFor = this.between(this.w().walk); this.walkYaw = f.yaw + (this.r() - 0.5) * 3; this.stats.walks++; this.blocked = 0; }
        else { this.enter("takeoff"); this.takeoffT = 0; this.hopped = false; }
      }
    }
  }
  private walkStep(f: Flight, o: FlightInput, dt: number) {
    if (f.mode !== "landed") { if (f.mode === "air") { this.enter("cruise"); this.newWaypoint(f); } else this.enter("rest"); return; }
    if (this.stateT > this.walkFor) { this.enter("rest"); this.restFor = 1 + this.r() * 4; if (this.r() < 0.5) { this.enter("takeoff"); this.takeoffT = 0; this.hopped = false; } return; }
    // 向きを保って前進。壁・段差で止まったら向きを変えるか、低い段なら小ジャンプ
    const e = wrap(this.walkYaw - f.yaw); o.x = -clamp(e * 2, -1, 1); o.brake = Math.abs(e) < 0.5;
    if (f.walkV < 0.3 && this.stateT > 1) { this.blocked += dt; if (this.blocked > 1.2) { this.blocked = 0; if (this.r() < 0.4) o.flapTap = true; else this.walkYaw = f.yaw + (this.r() < 0.5 ? 1 : -1) * (1.6 + this.r() * 1.4); } } else this.blocked = 0;
  }
  private takeoff(f: Flight, o: FlightInput) {
    this.takeoffT += 1 / 60;
    if (f.mode === "air" && !f.hopping && f.pos.y - f.agl >= -1 && f.agl > 7 && f.speed > 8) { this.stats.takeoffs++; this.enter("cruise"); this.newWaypoint(f); return; }
    if (!this.hopped && f.mode !== "air" && this.takeoffT < 5) { // 壁に向いたまま飛ぶと衝突して失速する: まず開けた向きへ体を回す
      const lim = f.pos.y + 2.5;
      if (this.heightsAhead(f, f.yaw, 18, null) > lim) { // 向きを回しながら、最も回転の少ない「開けた向き」を探す
        let best = 0, bd = 9;
        for (let k = 0; k < 16; k++) { const y = f.yaw + (k / 16) * Math.PI * 2, d = Math.abs(wrap(y - f.yaw)); if (d < bd && this.heightsAhead(f, y, 18, null) <= lim) { bd = d; best = y; } }
        if (bd < 9) { o.x = this.steer(f, f.pos.x - Math.sin(best) * 30, f.pos.z - Math.cos(best) * 30); if (Math.abs(o.x) < 0.2) o.x = Math.sign(o.x || 1) * 0.2; return; }
      }
    }
    if (!this.hopped) { o.flapTap = true; this.hopped = true; this.takeoffT = 0; this.newWaypoint(f); this.alt = Math.max(this.alt, 14); return; }   // まず小ジャンプ(行き先も決めておく)
    if (this.takeoffT > 0.1) o.flapHeld = true;                                        // 押し続け=離陸の羽ばたき
    if (f.mode === "air" && !f.hopping) { // 離陸直後: 羽ばたき続けて速度を稼ぎ、機首は水平より少し下。前方の建物は避ける
      this.fly(f, o, this.wx, this.wz, Math.max(this.alt, f.pos.y + 4)); if (f.agl < 7 && this.emerg <= 0) o.x *= 0.35;
      if (f.speed < 9) { o.flapHeld = true; o.flapTap = false; o.y = Math.min(o.y, -0.05); } else o.y = Math.max(o.y, 0.2);
    }
    if (this.takeoffT > 12) { this.hopped = false; this.takeoffT = 0; if (f.speed < 4) this.blocked += 3; }
  }
  private teleport(f: Flight) { // 最終手段: 安全な空中へ(通常は発生しない)
    f.reset(); f.pos.set((this.r() - 0.5) * 100, 30, (this.r() - 0.5) * 100); f.prevPos.copy(f.pos); this.enter("cruise"); this.newWaypoint(f);
  }
}
