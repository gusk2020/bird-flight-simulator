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
interface Weights { alt: [number, number]; leg: [number, number]; landP: number; rest: [number, number]; walkP: number; walk: [number, number]; spots: [number, number]; waterP: number; sitP: number } // spots: 地面の確率, 屋根の確率(残りは電線)
export const WEIGHTS: Record<Exclude<AutoPolicy, "random">, Weights> = {
  life:      { alt: [14, 26], leg: [50, 110],  landP: 0.85, rest: [8, 22], walkP: 0.8, walk: [8, 20], spots: [0.6, 0.2], waterP: 0.6, sitP: 0.6 },   // 自然生活: 着地・歩行・休憩が多い
  scenic:    { alt: [35, 65], leg: [110, 200], landP: 0.12, rest: [3, 7],  walkP: 0.2, walk: [3, 6],  spots: [0.1, 0.7], waterP: 0.1, sitP: 0.1 },   // 景色観賞: 高く長く飛ぶ
  adventure: { alt: [9, 22],  leg: [40, 90],   landP: 0.55, rest: [3, 9],  walkP: 0.4, walk: [4, 10], spots: [0.2, 0.35], waterP: 0.3, sitP: 0.25 },  // 冒険探索: 低く、屋根・電線を巡る
};
const SUB: Exclude<AutoPolicy, "random">[] = ["life", "scenic", "adventure"];
const RESCUE_AFTER = 14; // 3秒ごとの見張りで14回(約42秒)連続で動けないときだけ最終手段
const BOUND = 165; // これより外へは向かわない(物理の境界は205)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export class Autopilot {
  /** 自動ついばみの最中(止まって頭を下げている)。固着と見なさない */
  busy = false;
  /** H4: いちばん近い水辺(水たまり・池)の縁の点と距離。main が渡す。なければ水飲みには行かない */
  water: ((x: number, z: number) => { x: number; z: number; d: number } | null) | null = null; waterRange = 45; private toWater = false; stats2 = { drinks: 0, sits: 0 };
  /** 季節による行動の偏り(1=変化なし)。控えめ。setSeasonBias で更新 */
  bias = { forage: 1, roof: 1, ground: 1, water: 1 };
  setSeasonBias(b: { forage: number; roof: number; ground: number; water: number }) { this.bias = { ...b }; }
  state: PilotState = "cruise"; policy: AutoPolicy = "random"; active: Exclude<AutoPolicy, "random"> = "life"; enabled = false;
  stats = { landings: 0, walks: 0, perches: 0, takeoffs: 0, flaps: 0, replans: 0, teleports: 0, recoveries: 0, avoids: 0, switches: 0 }; // teleports=最終手段の再配置回数(通常0)  recoveries=物理入力による固着復帰の回数
  private r: () => number; private t = 0; private decideT = 0; private stateT = 0; private policyT = 0;
  private wx = 0; private wz = 0; private alt = 20; private tgt: Target | null = null;
  private sx = 0; private sy = 0; private lastFlap = -10; private lastGoal = 0;
  private px = 0; private pz = 0; private progT = 0; private watchT = 0; private wpx = 0; private wpz = 0;
  private restFor = 5; private walkFor = 0; private walkYaw = 0; private blocked = 0; private takeoffT = 0; private hopped = false;
  private busyWin = false; private lastPath = 0; private lastCrashes = 0; private emerg = 0; private emergDir = 1;
  constructor(private L: Layout, seed = 1) { this.r = rng(seed); }

  setPolicy(p: AutoPolicy) { this.policy = p; if (p !== "random") this.active = p; else this.policyT = 0; } // 次の判断から変わるだけ(位置・速度は変えない)
  start(f: Flight) {
    f.wallRecovery = false; // 壁衝突からの自動復帰・かすりの緩和は手動操作用。オート周遊は専用の復旧を持つので競合させない
    f.turnKeep = 0; // オート周遊は従来の旋回モデルで調整済み(手動操作へ戻すときは main が元に戻す)
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
    const n = Math.max(3, Math.min(10, Math.ceil(dist / 5))); // 細い障害物(電柱・手すり・看板)を飛ばさないよう、距離に応じて密にサンプルする
    for (let k = 1; k <= n; k++) {
      const d = (dist * k) / n, x = f.pos.x + ax * d, z = f.pos.z + az * d;
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
      const sp0 = Math.min(0.95, w.spots[0] * this.bias.ground), sp1 = w.spots[1] * this.bias.roof;
      if (roll < sp0) { // 地面(歩道・敷地): 周囲に建物がない開けた場所
        const gy = this.L.heightAt(x, z); if (gy > 0.2 || [[4, 0], [-4, 0], [0, 4], [0, -4]].some(([ox, oz]) => this.L.heightAt(x + ox, z + oz) > 0.2)) continue;
        if (this.L.waterAt(x, z) || [[3, 0], [-3, 0], [0, 3], [0, -3]].some(([ox, oz]) => this.L.waterAt(x + ox, z + oz))) continue; // 田んぼの水の上・すぐ脇には降りない
        const gk = this.L.groundAt(x, z); if (this.active !== "scenic" && gk !== "grass" && gk !== "soil" && gk !== "ridge" && r() < Math.min(0.95, (this.active === "life" ? 0.8 : 0.5) * (2 - this.bias.forage))) continue; // 草地・土・あぜ道(ついばめる地面)を好む
        return { x, y: gy, z, kind: "ground", wire: -1, dirx: 0, dirz: 0, box: 0, tries: 0 };
      }
      if (roll < sp0 + sp1) { // 屋根
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
    if (this.busy) this.busyWin = true;
    this.t += dt; this.stateT += dt; this.decideT += dt; this.watchT += dt; this.progT += dt;
    if (this.decideT >= 0.2) { this.decideT = 0; this.decide(f); }
    if (f.crashes !== this.lastCrashes) { this.lastCrashes = f.crashes; this.emerg = 1.2; this.stats.avoids++; if (this.state === "cruise" || this.state === "approach") { this.alt = Math.max(this.alt, f.pos.y + 12); } }
    if (this.emerg > 0) this.emerg -= dt;
    // 見張り: 動かなくなったら新しい目標へ。最終手段のみ安全な空中へ戻す(テレポート)
    if (this.watchT >= 3) {
      const moved = Math.hypot(f.pos.x - this.px, f.pos.z - this.pz); this.px = f.pos.x; this.pz = f.pos.z; this.watchT = 0;
      const airborne = f.mode === "air", still = moved < 2.5 && !this.busyWin; this.busyWin = false;
      if (airborne && this.state !== "takeoff" && moved < 6) { this.blocked++; this.stats.replans++; this.newWaypoint(f, true); this.alt = Math.max(this.alt, f.pos.y + 10); if (this.state === "approach") { this.tgt = null; this.enter("cruise"); } }
      else if (still && (this.state === "walk" || this.state === "takeoff")) this.blocked++;
      else if (!still || this.state === "rest") this.blocked = 0;
      // 固着の復帰は段階的: ①物理入力で何度もやり直す(離陸再試行・向き替え・目標再選択) → ②それでも約40秒動けない場合のみ最終手段
      if (this.blocked >= 3 && this.blocked < RESCUE_AFTER) this.recover(f);
      if (this.blocked >= RESCUE_AFTER) { this.blocked = 0; this.stats.teleports++; this.rescue(f); }
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
    o.x = this.sx; o.y = f.mode === "air" ? this.sy : 0; // 地上では前倒し=歩行になるので、オートは歩くボタン(brake)だけで歩く
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
    // 遠くの高い建物: 越えられない高さなら、早めに低い側へゆるやかに回り込む(急な回避を減らす)
    const far = clamp(f.speed * 5, 30, 60), farTop = this.heightsAhead(f, f.yaw, far, ignore);
    if (farTop > f.pos.y + 6 && this.emerg <= 0 && Math.abs(sx) < 0.6) {
      const l = this.heightsAhead(f, f.yaw + 0.6, far, ignore), rr = this.heightsAhead(f, f.yaw - 0.6, far, ignore);
      sx = (l < rr ? -1 : 1) * 0.7; want = Math.max(want, farTop + 6);
    }
    if (this.emerg > 0) sx = this.emergDir;
    const err = want - f.pos.y;
    o.x = sx; o.y = clamp(err * 0.07, -0.5, 0.8);
    const slow = f.speed < 7.5, needLift = err > 1.5 && f.vel.y < 0.8;
    if (slow || needLift || (f.agl < 6 && f.vel.y < -1)) this.flap(f, o);
    // 低速で機首を上げると失速する: 遅いときは機首を上げず、羽ばたきで速度・高度を得る
    // 落下中(衝突後の気絶明けなど): 地面が近いなら機首を上げて羽ばたき、衝撃を減らす。速度が十分あるので失速しにくい
    if (f.vel.y < -5 && f.agl < 16 && f.stun <= 0) { this.flap(f, o, true); o.y = Math.max(o.y, 0.9); return; }
    if (f.speed < 8.5) o.y = Math.min(o.y, 0.05);
    if (f.speed < 6.5 || f.stall) o.y = Math.min(o.y, -0.15);
  }

  /** 目標までの直線の途中に、降下しながらでは越えられない建物がないか(目標自身の建物は除く) */
  private pathClear(f: Flight, g: Target) {
    const dx = g.x - f.pos.x, dz = g.z - f.pos.z, d = Math.hypot(dx, dz);
    for (let k = 1; k <= 7; k++) {
      const s = k / 8, x = f.pos.x + dx * s, z = f.pos.z + dz * s;
      if (g.box > 0 ? Math.abs(x - g.x) < g.box + 3 && Math.abs(z - g.z) < g.box + 3 : (1 - s) * d < 6) continue;
      const h = Math.max(this.L.heightAt(x, z), this.L.heightAt(x + dz / d * 3, z - dx / d * 3), this.L.heightAt(x - dz / d * 3, z + dx / d * 3));
      const dist = (1 - s) * d, slope = g.kind === "roof" ? 0.3 : 0.22, prof = g.y + 0.9 + Math.max(0, dist - 4) * slope + (g.kind === "roof" ? 2.5 : 0); // approach() が実際に飛ぶ降下線
      if (h + 0.8 > prof && h + 0.8 > f.pos.y - 2) return false; // 降下線上でも、いまの高さからでも越えられない場合だけ
    }
    return true;
  }
  private abortApproach(f: Flight, rise = 12) { this.tgt = null; this.stats.replans++; this.enter("cruise"); this.newWaypoint(f); this.alt = Math.max(this.alt, f.pos.y + rise); }
  private approach(f: Flight, o: FlightInput) {
    const g = this.tgt; if (!g) { this.enter("cruise"); this.newWaypoint(f); return; }
    if (f.mode !== "air") { this.afterLanding(f); return; }
    const dx = g.x - f.pos.x, dz = g.z - f.pos.z, d = Math.hypot(dx, dz);
    // 着地進入の安全確認: 途中に越えられない建物がある / 屋根より低い位置で建物へ近づいた → 諦めて高度を取り直す
    if (g.kind !== "wire") {
      if (g.kind === "roof" && d < g.box + 6 && f.pos.y < g.y - 1.5) { this.abortApproach(f, g.y - f.pos.y + 8); return; }
      if (this.t - this.lastPath > 0.4) { this.lastPath = this.t; if (!this.pathClear(f, g)) { this.abortApproach(f); return; } }
    }
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
      if (this.stateT < 0.1 && f.mode === "landed" && !f.sitting && this.r() < this.w().sitP) { f.sitting = true; this.stats2.sits++; }
      if (!f.sitting && Math.sin(this.stateT * 0.9) > 0.97) o.x = 0.4;
      if (this.stateT > this.restFor) {
        const wp = f.mode === "landed" && this.water ? this.water(f.pos.x, f.pos.z) : null;
        if (wp && wp.d > 1.2 && wp.d < this.waterRange && this.r() < this.w().waterP * this.bias.water) { // 水を飲み・浴びに行く
          this.enter("walk"); this.toWater = true; this.walkFor = wp.d / 1.6 + 4; this.walkYaw = Math.atan2(-(wp.x - f.pos.x), -(wp.z - f.pos.z)); this.stats.walks++; this.blocked = 0; f.sitting = false;
        } else if (f.mode === "landed" && this.r() < this.w().walkP) { this.enter("walk"); this.walkFor = this.between(this.w().walk); this.walkYaw = f.yaw + (this.r() - 0.5) * 3; this.stats.walks++; this.blocked = 0; }
        else { this.enter("takeoff"); this.takeoffT = 0; this.hopped = false; }
      }
    }
  }
  private walkStep(f: Flight, o: FlightInput, dt: number) {
    if (f.mode !== "landed") { if (f.mode === "air") { this.enter("cruise"); this.newWaypoint(f); } else this.enter("rest"); return; }
    if (this.toWater) { // 水辺へ向かっている: 向きを水へ合わせ続け、着いたら座って長く休む(飲む・浴びるは生活動作が受け持つ)
      const wp = this.water ? this.water(f.pos.x, f.pos.z) : null;
      if (!wp) this.toWater = false;
      else if (wp.d < 0.9) { this.toWater = false; this.enter("rest"); this.restFor = 14 + this.r() * 10; f.sitting = true; this.stats2.drinks++; return; }
      else this.walkYaw = Math.atan2(-(wp.x - f.pos.x), -(wp.z - f.pos.z));
    }
    if (this.stateT > this.walkFor) { this.toWater = false; this.enter("rest"); this.restFor = 1 + this.r() * 4; if (this.r() < 0.5) { this.enter("takeoff"); this.takeoffT = 0; this.hopped = false; } return; }
    // 向きを保って前進。壁・段差で止まったら向きを変えるか、低い段なら小ジャンプ
    const e = wrap(this.walkYaw - f.yaw); o.x = -clamp(e * 2, -1, 1); o.brake = Math.abs(e) < 0.5;
    if (this.busy) return; // ついばみ中は止まっていて正常
    if (f.walkV < 0.3 && this.stateT > 1) { this.blocked += dt; if (this.blocked > 1.2) { this.blocked = 0; if (this.r() < 0.4) o.flapTap = true; else this.walkYaw = f.yaw + (this.r() < 0.5 ? 1 : -1) * (1.6 + this.r() * 1.4); } } else this.blocked = 0;
  }
  /** その向きに、足元より高い障害物(+2.5m)に当たるまでの距離(最大40m、2mごと) */
  private clearDist(f: Flight, yaw: number) {
    const ax = -Math.sin(yaw), az = -Math.cos(yaw), lim = f.pos.y + 2.5;
    for (let d = 2; d <= 40; d += 2) if (this.L.heightAt(f.pos.x + ax * d, f.pos.z + az * d) > lim) return d;
    return 40;
  }
  private takeoff(f: Flight, o: FlightInput) {
    this.takeoffT += 1 / 60;
    if (f.mode === "air" && !f.hopping && f.pos.y - f.agl >= -1 && f.agl > 7 && f.speed > 8) { this.stats.takeoffs++; this.enter("cruise"); this.newWaypoint(f); return; }
    if (!this.hopped && f.mode !== "air" && this.takeoffT < 5) { // 壁に向いたまま飛ぶと衝突して失速する: まず開けた向きへ体を回す
      const lim = f.pos.y + 2.5, blockedAhead = (y: number) => this.heightsAhead(f, y, 18, null) > lim || this.heightsAhead(f, y, 32, null) > f.pos.y + 8; // 近くの壁と、遠くの高い建物の両方を避ける
      if (blockedAhead(f.yaw)) { // 向きを回しながら、最も回転の少ない「開けた向き」を探す
        let best = 0, bd = 9;
        for (let k = 0; k < 16; k++) { const y = f.yaw + (k / 16) * Math.PI * 2, d = Math.abs(wrap(y - f.yaw)); if (d < bd && !blockedAhead(y)) { bd = d; best = y; } }
        if (bd >= 9 && f.mode === "landed" && f.pos.y - f.agl < 1) { // どの向きも塞がれている(木立・柵の中など): 一番低い向きへ歩いて抜け出してから離陸をやり直す
          let wy = f.yaw, wh = 1e9; for (let k = 0; k < 16; k++) { const y = f.yaw + (k / 16) * Math.PI * 2, h = this.heightsAhead(f, y, 18, null); if (h < wh) { wh = h; wy = y; } }
          this.enter("walk"); this.walkFor = 3 + this.r() * 2; this.walkYaw = wy; this.stats.walks++; return;
        }
        if (bd < 9) { o.x = this.steer(f, f.pos.x - Math.sin(best) * 30, f.pos.z - Math.cos(best) * 30); if (Math.abs(o.x) < 0.2) o.x = Math.sign(o.x || 1) * 0.2; return; }
        // どの向きも塞がれている(建物に囲まれた場所): 最も奥まで開けている向きへ歩いて出てから飛ぶ
        let far = 0, fy = f.yaw; for (let k = 0; k < 16; k++) { const y = f.yaw + (k / 16) * Math.PI * 2, d = this.clearDist(f, y); if (d > far) { far = d; fy = y; } }
        this.walkYaw = fy; this.walkFor = 3 + this.r() * 3; this.enter("walk"); this.stats.walks++; return;
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
  /** 物理入力による復帰。位置も速度も触らず、次の判断だけを変える。 */
  private recover(f: Flight) {
    this.stats.recoveries++;
    if (this.state === "takeoff") { this.hopped = false; this.takeoffT = 0; this.walkYaw = f.yaw + (this.r() < 0.5 ? 1 : -1) * (1.2 + this.r() * 1.5); if (f.mode !== "air") { this.enter("walk"); this.walkFor = 3 + this.r() * 2; this.stats.walks++; } } // 向きを替えるだけでなく、実際に歩いて壁際から離れる
    else if (this.state === "walk") { this.walkYaw = f.yaw + (this.r() < 0.5 ? 1 : -1) * (1.6 + this.r() * 1.4); this.stateT = 0; }
    else if (f.mode === "air") { this.tgt = null; if (this.state !== "cruise") this.enter("cruise"); this.newWaypoint(f, true); this.alt = Math.max(this.alt, f.pos.y + 14); this.emerg = 1.5; this.emergDir = this.r() < 0.5 ? -1 : 1; }
  }
  /**
   * 最終手段(通常は発生しない): 同じ水平位置のまま、周囲の建物より上の空中へ持ち上げて巡航速度を与える。
   * 触るのは位置・速度・飛行モード・気絶/ジャンプ/止まり木の状態だけ。クラッシュ数・羽ばたき数・時計など統計は消さない(Flight.reset()は使わない)。
   */
  private rescue(f: Flight) {
    let top = this.L.heightAt(f.pos.x, f.pos.z);
    for (let a = 0; a < 8; a++) for (const d of [8, 20]) top = Math.max(top, this.L.heightAt(f.pos.x - Math.sin(a * 0.785) * d, f.pos.z - Math.cos(a * 0.785) * d));
    f.pos.y = Math.max(f.pos.y, top + 8); f.prevPos.copy(f.pos);
    f.vel.set(-Math.sin(f.yaw) * 12, 0, -Math.cos(f.yaw) * 12); f.pitch = 0.05; f.roll = 0;
    f.mode = "air"; f.stun = 0; f.stall = false; f.strokeT = -1; f.hopping = false; f.hopT = -1; f.perchId = -1; f.perchCool = 0; f.walkV = 0;
    this.tgt = null; this.enter("cruise"); this.newWaypoint(f, true); this.alt = Math.max(this.alt, f.pos.y + 6);
  }
}
