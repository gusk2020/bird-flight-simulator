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
  vBase: 3.75, vK: 0.556, vMin: 5.33, vMax: 8.64,      // 距離 d での目標の速さ = clamp(vBase + vK*d, vMin, vMax)
  brakeMargin: 1.03,                           // 目標の速さをこれ(m/s)超えたら減速
  hSlope: 0.168, hFinal: 0.393,                // 目標の高さ = 足場の上 hFinal + (d-2.5)*hSlope
  downFast: -0.192, downSlow: -0.483, upMax: 0.18, // 降下の勾配の下限(速すぎるとき/ふつう)と上限
  yGain: 0.214, flapSpeed: 6.97, flapSink: 1.76,
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
  stats = { starts: 0, refused: 0, success: 0, ended: { user: 0, danger: 0, lost: 0, timeout: 0, crash: 0, fail: 0 } as Record<string, number>, time: 0 };
  dbg = ""; private d0 = 0; private c0 = 0; private danger = 0; private lastFlap = -9; private under: Surface[] = [];
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
  private pathDanger(f: Flight, s: Surface): boolean {
    const px = f.pos.x, pz = f.pos.z, feet = f.pos.y - P.feetOffset;
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

  start(f: Flight, s: Surface): boolean {
    const c = this.check(f, s);
    if (!c.ok) { this.stats.refused++; this.end = ""; return false; }
    this.active = true; this.target = s; this.t = 0; this.end = ""; this.d0 = this.dist(f, s); this.c0 = f.crashes; this.danger = 0; this.lastFlap = f.clock - 9;
    this.pa.forced = s; this.stats.starts++; return true;
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
    if (d > this.d0 + AUTOLAND.loseMargin) { this.dbg = `far d=${d.toFixed(1)} d0=${this.d0.toFixed(1)}`; this.cancel("lost"); return; }
    if (feet - s.top < -0.6) { this.dbg = `low ${(feet - s.top).toFixed(1)} d=${d.toFixed(1)}`; this.cancel("lost"); return; } // 面より低くなった(降りられない)
    this.danger += dt;
    if (this.danger >= AUTOLAND.dangerEvery) { this.danger = 0; if (d > 2.5 && this.pathDanger(f, s)) { this.cancel("danger"); return; } }

    // --- 進入: 足場の内側の点へ向き、降下角を保ち、速さを落とす
    // 目標点: 着地補助が立てた計画(細長い面は端から長手方向に入る点)があればそれ、なければ足場の内側でいちばん近い点
    const pl = this.pa.plan, usePlan = !!pl && f.clock - pl.t < 0.15 && d < 14;
    const ax = usePlan ? pl!.tx : clamp(px, s.minX + 0.2, s.maxX - 0.2), az = usePlan ? pl!.tz : clamp(pz, s.minZ + 0.2, s.maxZ - 0.2), da = Math.hypot(ax - px, az - pz);
    const e = da > 0.3 ? wrap(Math.atan2(-(ax - px), -(az - pz)) - f.yaw) : 0;
    raw.x = -clamp(e * 1.8, -1, 1) * (Math.abs(e) < 0.03 ? 0 : 1);
    const hDes = usePlan ? Math.max(pl!.h, s.top + 0.25) + Math.max(0, da - 2.5) * AUTOLAND.hSlope * 0.5 : s.top + AUTOLAND.hFinal + Math.max(0, d - 2.5) * AUTOLAND.hSlope, vT = clamp(AUTOLAND.vBase + da * AUTOLAND.vK, AUTOLAND.vMin, AUTOLAND.vMax);
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
