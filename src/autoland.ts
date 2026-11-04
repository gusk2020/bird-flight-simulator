import type { Flight, FlightInput } from "./flight";
import { PHYS as P } from "./params";
import type { PerchAssist } from "./perchassist";
import type { Surface, SurfaceIndex } from "./perches";

/** G1-5 ◯をタップしたときの自動着地。手動飛行の一部で、オート周遊(Autopilot)とは別。 */
export const AUTOLAND = {
  maxRange: 18,        // 始められる水平距離 m(これより遠い足場へは行かない: 遠距離吸着の禁止)
  maxTime: 14,         // この秒数で打ち切る
  maxSlope: 0.45,       // 足場へ降りる最大の勾配(高さ/距離)。これより高いところからは始めない
  cancelStick: 0.45,   // 手動のスティックがこれ以上なら、すぐ手動へ戻す
  loseMargin: 6,       // 足場までの距離が、始めたときよりこれ以上遠ざかったら中止
  dangerEvery: 0.25,   // 前方の危険を調べる間隔 s
  // --- 進入の調整値(tools/autoland_success.ts の計測で決めた)
  vBase: 3.63, vK: 0.507, vMin: 5.29, vMax: 7.38,      // 距離 d での目標の速さ = clamp(vBase + vK*d, vMin, vMax)
  brakeMargin: 1.17,                           // 目標の速さをこれ(m/s)超えたら減速
  hSlope: 0.176, hFinal: 0.426,                // 目標の高さ = 足場の上 hFinal + (d-2.5)*hSlope
  downFast: -0.165, downSlow: -0.564, upMax: 0.134, // 降下の勾配の下限(速すぎるとき/ふつう)と上限
  vBig: 6.6,                                   // 広い面(12 m²超)の手前での最低の目標速度
  railForBalcony: true, // 外からベランダへ来たときは手すりの上へ降りる
  windLead: 0, windLeadMax: 2.5, // 風の先読み: 流される分(風×着くまでの時間)の割合 / 時間の上限 s
  trackGain: 6, // 軌跡のずれを機首の向きの指示へ足す割合(0で無効)
  dangerGoAround: true, // 前方に建物などが近づいて中止するはずの場面でも、回り込む余地が確かめられれば、中止せずに上がって回り込む
  goAroundClear: 6, goArounds: 2, goAroundKinds: ["sign", "pole", "branch", "rock", "fence", "wall"] as string[], // 外したときのやり直しの回数と、対象の足場の種類
  upwindApproach: true, upwindKinds: ["sign", "pole", "branch", "rock"] as string[], // 回り込みを使う足場(単独で立つ小さなもの。壁際のベンチなどは、回り込みで悪化した)
  tailMin: 1.5, smallWidth: 3, wpDist: 9, wpAbove: 3, wpReach: 3, wpMax: 6, wpTurnRoom: 10, wpClear: 12, // 追い風の小さな足場: 風下の中継点を回って風上から入る
  yGain: 0.235, flapSpeed: 6.82, flapSink: 1.9,
};
export type AutoLandEnd = "success" | "user" | "danger" | "lost" | "timeout" | "crash" | "fail";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * ◯を押した足場へ、短時間で降りる。やることは遠くからの「進入」だけ:
 *   足場の方へ向き、降下角を保ち、速さを落とす(減速・羽ばたき・昇降の入力を作る)。
 *   最後の数メートル(縁に沿った進入・減速・短距離スナップ)は、手動と同じ PerchAssist が足場を指定されて受け持つ。
 * 位置を直接動かすことはしない。入力を作るだけなので、壁の貫通・瞬間移動はない。
 */
export class AutoLand {
  active = false; target: Surface | null = null; end: AutoLandEnd | "" = ""; t = 0;
  /** 直近に開始を断った理由(表示・診断用) */
  lastRefusal = "";
  stats = { starts: 0, refused: 0, success: 0, ended: { user: 0, danger: 0, lost: 0, timeout: 0, crash: 0, fail: 0 } as Record<string, number>, time: 0 };
  /** 最後に始めた自動着地の目的地の ID(終わって target が空になったあとも残る。診断・テスト用) */ lastTargetId = -1;
  dbg = ""; /** 風上から進入するための中継点(追い風で小さな足場へ来たときだけ) */ wp: { x: number; z: number } | null = null; private wpT = 0; private tries = 0; private d0 = 0; private c0 = 0; private danger = 0; private lastFlap = -9; private under: Surface[] = [];
  private get all() { return this.idx.all; }
  constructor(private idx: SurfaceIndex, private pa: PerchAssist, private heightAt: (x: number, z: number) => number) {}

  private dist(f: Flight, s: Surface) { return Math.hypot(f.pos.x - clamp(f.pos.x, s.minX, s.maxX), f.pos.z - clamp(f.pos.z, s.minZ, s.maxZ)); }

  /** 始めてよいか。理由つきで返す(テスト・表示用)。 */
  check(f: Flight, s: Surface): { ok: boolean; why: string } {
    if (f.mode !== "air" || f.hopping) return { ok: false, why: "not flying" };
    if (f.stun > 0) return { ok: false, why: "stunned" };
    const d = this.dist(f, s), feet = f.pos.y - P.feetOffset, above = feet - s.top;
    if (d > AUTOLAND.maxRange) return { ok: false, why: "too far" };
    if (above < -0.3) return { ok: false, why: "unreachable (below)" };
    if (above / Math.max(d, 1.5) > AUTOLAND.maxSlope && above > 3) return { ok: false, why: "too high" };
    if (this.pathDanger(f, s)) return { ok: false, why: "dangerous path" };
    return { ok: true, why: "" };
  }

  /** 現在位置から足場の手前までの直線(降下しながら)の上に、その高さより高い建物がないか。足場の真上と縁の周り0.9 m は除く */
  private pathDanger(f: Flight, s: Surface, from?: { x: number; z: number; feet: number }): boolean {
    const px = from ? from.x : f.pos.x, pz = from ? from.z : f.pos.z, feet = from ? from.feet : f.pos.y - P.feetOffset;
    const ax = clamp(px, s.minX + 0.2, s.maxX - 0.2), az = clamp(pz, s.minZ + 0.2, s.maxZ - 0.2), d = Math.hypot(ax - px, az - pz);
    const n = Math.max(4, Math.ceil(d / 1.5));
    for (let i = 1; i < n; i++) {
      const u = i / n, x = px + (ax - px) * u, z = pz + (az - pz) * u, alt = feet + (s.top + 0.4 - feet) * u;
      if (x > s.minX - 0.9 && x < s.maxX + 0.9 && z > s.minZ - 0.9 && z < s.maxZ + 0.9) continue; // 目標の足場とその周り
      for (const o of [-0.8, 0, 0.8]) { // 経路の左右も少し見る
        const ox = (az - pz) / Math.max(d, 1e-3) * o, oz = -(ax - px) / Math.max(d, 1e-3) * o;
        if (this.heightAt(x + ox, z + oz) > alt - 0.5) return true;
      }
    }
    return false;
  }

  /** ベランダは、手すりと建物の壁のあいだの約1 mの床。手すり(床から1 m上)を越えて、止まり切れないまま壁に近づくより、外から来たなら手すりの上に降りるほうが確実。
   *  手すり(と床)は一つの構造物なので、成功は手すりでも床でも数える(下の same)。外から来ていない(横から)ときは床のまま */
  private retarget(f: Flight, s: Surface): Surface {
    if (s.kind !== "balcony") return s;
    const cz = (s.minZ + s.maxZ) / 2;
    for (const r of this.all) {
      if (r.kind !== "rail" || r.top <= s.top || r.maxX <= s.minX || r.minX >= s.maxX || Math.abs((r.minZ + r.maxZ) / 2 - cz) > 0.9) continue;
      if (Math.sign(f.pos.z - cz) === Math.sign((r.minZ + r.maxZ) / 2 - cz) && Math.abs(f.pos.z - cz) > 1.0) return r;
    }
    return s;
  }

  start(f: Flight, s0: Surface): boolean {
    const s = AUTOLAND.railForBalcony ? this.retarget(f, s0) : s0, c = this.check(f, s);
    if (!c.ok) { this.stats.refused++; this.end = ""; this.lastRefusal = c.why; return false; }
    this.active = true; this.target = s; this.lastTargetId = s.id; this.t = 0; this.end = ""; this.d0 = this.dist(f, s); this.c0 = f.crashes; this.danger = 0; this.lastFlap = f.clock - 9;
    this.pa.forced = s; this.stats.starts++; this.wp = null; this.wpT = 0; this.tries = 0;
    // 追い風で小さな足場へ向かうとき: 追い風のままでは、失速しない対気速度を保つと対地速度が高すぎて止まれない。足場の風下側の点を回ってから、風上(向かい風)へ向けて進入する。回り込む道に建物があるときはやらない
    if (f.wind) f.wind.at(f.pos.x, f.pos.y, f.pos.z, f.clock, f.windVec);
    const wvx = f.windVec.x, wvz = f.windVec.z, wm = Math.hypot(wvx, wvz), hs0 = Math.hypot(f.vel.x, f.vel.z) || 1, tail = (wvx * f.vel.x + wvz * f.vel.z) / hs0;
    if (AUTOLAND.upwindApproach && AUTOLAND.upwindKinds.includes(s.kind) && wm >= 1.5 && tail >= AUTOLAND.tailMin && Math.min(s.maxX - s.minX, s.maxZ - s.minZ) < AUTOLAND.smallWidth) this.planWaypoint(f, s, wvx / wm, wvz / wm);
    return true;
  }

  /** 足場の (dirx,dirz) 側 wpDist m の点を中継点にできるか調べ、できれば立てる(経路・折り返しの広がり・最後の進入路が空いているとき)。立てたら true */
  private planWaypoint(f: Flight, s: Surface, dirx: number, dirz: number, clear = AUTOLAND.wpClear): boolean {
    const wx = (s.minX + s.maxX) / 2 + dirx * AUTOLAND.wpDist, wz = (s.minZ + s.maxZ) / 2 + dirz * AUTOLAND.wpDist, hw = s.top + AUTOLAND.wpAbove; let free = true;
    const n = Math.ceil(Math.hypot(wx - f.pos.x, wz - f.pos.z) / 1.5);
    for (let i = 1; i <= n && free; i++) { const u = i / n; for (const o of [-0.8, 0, 0.8]) if (this.heightAt(f.pos.x + (wx - f.pos.x) * u + o, f.pos.z + (wz - f.pos.z) * u) > hw - 0.8) { free = false; break; } }
    // 折り返しに使う広がり(中継点の周り wpClear m)にも、高い建物がないこと
    for (let k = 0; k < 8 && free; k++) for (const r of [clear * 0.5, clear]) if (this.heightAt(wx + Math.cos(k * Math.PI / 4) * r, wz + Math.sin(k * Math.PI / 4) * r) > hw - 0.8) { free = false; break; }
    // 中継点から足場までの最後の進入路にも、(通常の進入と同じ検査で)建物がないこと
    if (free && this.pathDanger(f, s, { x: wx, z: wz, feet: hw })) free = false;
    if (free && this.heightAt(wx, wz) < hw - 0.8) { this.wp = { x: wx, z: wz }; this.wpT = 0; this.pa.forced = null; return true; }
    return false;
  }
  /** 外した(面より低くなった・遠ざかった)ときの「やり直し」: 一度だけ、上がって回り込み、風上(風がなければ来た側)から入り直す。できなければ false(今までどおり中止) */
  private goAround(f: Flight, s: Surface, d: number, anyKind = false): boolean {
    if (d > AUTOLAND.maxRange || this.tries >= AUTOLAND.goArounds || (!anyKind && !AUTOLAND.goAroundKinds.includes(s.kind))) return false;
    let dx: number, dz: number; const wm = Math.hypot(f.windVec.x, f.windVec.z);
    if (wm >= 1.5) { dx = f.windVec.x / wm; dz = f.windVec.z / wm; } else { dx = f.pos.x - (s.minX + s.maxX) / 2; dz = f.pos.z - (s.minZ + s.maxZ) / 2; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
    if (!this.planWaypoint(f, s, dx, dz, AUTOLAND.goAroundClear)) { return false; }
    this.tries++; this.d0 = d + AUTOLAND.wpTurnRoom + AUTOLAND.wpDist; this.dbg = "go-around"; return true;
  }

  cancel(why: AutoLandEnd) {
    if (!this.active) return;
    this.active = false; this.end = why; this.pa.forced = null; const s = this.target; this.target = null;
    if (why === "success") this.stats.success++; else this.stats.ended[why] = (this.stats.ended[why] || 0) + 1;
    this.stats.time += this.t; void s;
  }

  /** 毎物理ステップ、補助(着地補助・羽ばたき補助)より前に呼ぶ。raw は手動の入力で、自動着地中はここで書き換える。 */
  drive(f: Flight, raw: FlightInput, dt = 1 / 60) {
    if (!this.active || !this.target) return;
    const s = this.target; this.t += dt;
    // 手動へ戻す: 大きなスティック・羽ばたき操作
    if (Math.abs(raw.x) > AUTOLAND.cancelStick || Math.abs(raw.y) > AUTOLAND.cancelStick || raw.flapTap || raw.flapHeld) { this.cancel("user"); return; }
    if (f.crashes !== this.c0 || f.stun > 0) { this.cancel("crash"); return; }
    if (f.mode !== "air") { // 降りた: 目標の足場の上なら成功
      const u = this.idx.under(f.pos.x, f.pos.y - P.feetOffset, f.pos.z, this.under);
      // ベランダは床と外側の手すりで一つの構造物: 手すりに止まってもベランダへの着地とみなす(逆も)
      const same = !!u && (u === s || (((s.kind === "balcony" && u.kind === "rail") || (s.kind === "rail" && u.kind === "balcony")) && u.maxX > s.minX && u.minX < s.maxX && u.maxZ > s.minZ - 0.8 && u.minZ < s.maxZ + 0.8));
      this.cancel(same ? "success" : "fail"); return;
    }
    if (f.hopping) { this.cancel("lost"); return; }
    if (this.t > AUTOLAND.maxTime) { this.cancel("timeout"); return; }
    const px = f.pos.x, pz = f.pos.z, feet = f.pos.y - P.feetOffset, d = this.dist(f, s), hs = Math.hypot(f.vel.x, f.vel.z);
    if (!this.wp && d > this.d0 + AUTOLAND.loseMargin) { if (this.goAround(f, s, d)) return; this.dbg = `far d=${d.toFixed(1)} d0=${this.d0.toFixed(1)}`; this.cancel("lost"); return; }
    if (feet - s.top < (this.wp ? -1.5 : -0.6)) { if (!this.wp && this.goAround(f, s, d)) return; this.dbg = `low ${(feet - s.top).toFixed(1)} d=${d.toFixed(1)}`; this.cancel("lost"); return; } // 面より低くなった(降りられない)
    this.danger += dt;
    if (this.danger >= AUTOLAND.dangerEvery) { this.danger = 0; if (!this.wp && d > 2.5 && this.pathDanger(f, s)) { if (AUTOLAND.dangerGoAround && this.goAround(f, s, d)) return; this.cancel("danger"); return; } }

    if (this.wp) { // 風上から入るための回り込み: 中継点へ向かい、着いたら(または時間切れで)通常の進入へ
      const dx = this.wp.x - px, dz = this.wp.z - pz, dw = Math.hypot(dx, dz);
      if (dw < AUTOLAND.wpReach || this.wpT > AUTOLAND.wpMax) { this.wp = null; this.pa.forced = s; this.d0 = d + AUTOLAND.wpTurnRoom; }
      else {
        this.wpT += dt; raw.x = -clamp(wrap(Math.atan2(-dx, -dz) - f.yaw) * 1.8, -1, 1);
        const hw = s.top + AUTOLAND.wpAbove, vyW = clamp((hw - feet) / Math.max(dw, 3), -0.15, 0.2) * Math.max(hs, 5);
        raw.y = clamp((vyW - f.vel.y) * AUTOLAND.yGain, -0.6, 0.5); raw.brake = false; raw.flapTap = false;
        if ((hs < AUTOLAND.flapSpeed + 1 || f.vel.y < vyW - AUTOLAND.flapSink) && f.vel.y < 0.5 && f.clock - this.lastFlap > 0.7 && f.strokeT < 0) { raw.flapTap = true; this.lastFlap = f.clock; }
        return;
      }
    }
    // --- 進入: 足場の内側の点へ向き、降下角を保ち、速さを落とす
    // 目標点: 着地補助が立てた計画(細長い面は端から長手方向に入る点)があればそれ、なければ足場の内側でいちばん近い点
    const pl = this.pa.plan, usePlan = !!pl && f.clock - pl.t < 0.15 && d < 14;
    const ax = usePlan ? pl!.tx : clamp(px, s.minX + 0.2, s.maxX - 0.2), az = usePlan ? pl!.tz : clamp(pz, s.minZ + 0.2, s.maxZ - 0.2), da = Math.hypot(ax - px, az - pz);
    // 横風: 機首を目標へ向けても、風で流されて軌跡(対地速度の向き)がずれ、細い足場を外す。軌跡の向きと目標の向きの差を機首の向きの指示へ足す(風上へ少し機首を向けて進む)。風のない条件では軌跡=機首なので変化しない
    // 風の先読み: 着くまでの時間(ttg)のあいだに風で流される分だけ、風上へずらした点を狙う。流されてから直すより、最初から風上へ向けて進む
    const ttg = clamp(da / Math.max(hs, 3), 0, AUTOLAND.windLeadMax), wx = ax - f.windVec.x * AUTOLAND.windLead * ttg, wz = az - f.windVec.z * AUTOLAND.windLead * ttg;
    let e = da > 0.3 ? wrap(Math.atan2(-(wx - px), -(wz - pz)) - f.yaw) : 0;
    if (da > 1.2 && hs > 2.5) e += AUTOLAND.trackGain * clamp(wrap(Math.atan2(-(ax - px), -(az - pz)) - Math.atan2(-f.vel.x, -f.vel.z)), -0.6, 0.6);
    raw.x = -clamp(e * 1.8, -1, 1) * (Math.abs(e) < 0.03 ? 0 : 1);
    const big = (s.maxX - s.minX) * (s.maxZ - s.minZ) > 12;
    const hDes = usePlan ? Math.max(pl!.h, s.top + 0.25) + Math.max(0, da - 2.5) * AUTOLAND.hSlope * 0.5 : s.top + AUTOLAND.hFinal + Math.max(0, d - 2.5) * AUTOLAND.hSlope, vT0 = clamp(AUTOLAND.vBase + da * AUTOLAND.vK, AUTOLAND.vMin, AUTOLAND.vMax), vT = big ? Math.max(vT0, AUTOLAND.vBig) : vT0; // 屋根のような広い面は、縁を越えるまで失速速度に近づけない(縁の手前で沈むため)。減速は面の上で着地補助が行う
    // 降下: 目標の高さへ向かう勾配(下り最大約19度)を決め、その縦速度に合わせて機首を上下する(高さの差に直接比例させると、遠くで急降下して足場より低くなる)
    const slope = clamp((hDes - feet) / Math.max(da - 1.5, 1.5), hs > vT + 1.5 ? AUTOLAND.downFast : AUTOLAND.downSlow, AUTOLAND.upMax); // 速すぎるうちは急降下しない(降下で速さが増す)
    raw.y = clamp((slope * Math.max(hs, 4) - f.vel.y) * AUTOLAND.yGain, -0.6, 0.5);
    raw.brake = hs > vT + AUTOLAND.brakeMargin;   // 速すぎるときは減速(機首が上がるぶんは、上の降下制御が補う)
    raw.flapTap = false;
    // 羽ばたき: 速さが足りない、または狙った降下より速く沈んでいるときは羽ばたく(遠いうちだけ。最後の2.5 mでは上がらない)
    const vyWant = slope * Math.max(hs, 4);
    if ((hs < AUTOLAND.flapSpeed || f.vel.y < vyWant - AUTOLAND.flapSink) && f.vel.y < 0.5 && d > 2.5 && feet - s.top < 6 && f.clock - this.lastFlap > 0.7 && f.strokeT < 0) { raw.flapTap = true; this.lastFlap = f.clock; }
  }
}
