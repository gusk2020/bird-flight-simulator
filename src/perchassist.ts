import type { Flight, FlightInput } from "./flight";
import { PHYS as P } from "./params";
import type { Surface, SurfaceIndex } from "./perches";

/** 着地補助の強さ(標準)。常時オン・切替UIなし。 */
export const PERCH = {
  strength: 0.6,         // 誘導入力と本人入力の混ぜ具合(最大)
  range: 14,             // 候補を探す水平距離 m
  cone: 0.95,            // 進行方向からこの角度(rad ≒55°)以内の候補だけ
  showRange: 10,         // 目印を出す距離
  hopRange: 2.4,         // 地上の小ジャンプで飛び乗りを手伝う距離 m
  hopMaxRise: 1.5,       // 飛び乗れる最大の段差 m(これ以上は羽ばたき離陸が必要)
  edgeAlign: 1.0,        // 縁に沿って歩く補助: 向きが縁の軸から rad 以内のとき
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * 着地補助(手動操作用)。飛行物理は変えず、入力(スティック・減速)と小ジャンプの初速だけを穏やかに足す。
 *  ・空中: 減速か羽ばたきをすると、前方の着地面へ向きと降下を寄せる(遠くから吸い寄せない・急な座標変更なし)
 *  ・地上: 低い段差へのタップは、高さと前進量を少し手伝う(候補がなければ従来のジャンプ)
 *  ・縁(壁・ベンチ・手すり等)の上: 縁に沿って歩きやすく、端では止まる
 */
export class PerchAssist {
  enabled = true;
  target: Surface | null = null;           // 目印の対象(最も狙っている候補)
  aimX = 0; aimZ = 0; aimD = 99;            // 目印を置く点(面の内側)と、そこまでの水平距離
  stats = { guided: 0, hopAssists: 0, edgeStops: 0, edgeAligns: 0, captures: 0 };
  private near: Surface[] = []; private under: Surface[] = []; private t = -1;
  constructor(private idx: SurfaceIndex) {}

  /** 進行方向(速度があれば速度、なければ向き)に対する候補の選別。毎フレームではなく約8Hzで更新。 */
  private pick(f: Flight) {
    const px = f.pos.x, pz = f.pos.z, feet = f.pos.y - P.feetOffset;
    const hs = Math.hypot(f.vel.x, f.vel.z), hx = hs > 3 ? f.vel.x / hs : -Math.sin(f.yaw), hz = hs > 3 ? f.vel.z / hs : -Math.cos(f.yaw);
    let best: Surface | null = null, bs = 1e9;
    this.idx.near(px, pz, PERCH.range, this.near);
    for (const s of this.near) {
      const cx = clamp(px, s.minX, s.maxX), cz = clamp(pz, s.minZ, s.maxZ), dx = cx - px, dz = cz - pz, d = Math.hypot(dx, dz);
      if (d > PERCH.range) continue;
      const above = feet - s.top; // 面より上にいる高さ
      if (above < -0.4 || above > 2.5 + d * 0.5) continue;      // 面より低い/高すぎる(降りられない)候補は除く
      let bearing = 0; if (d > 0.4) bearing = Math.acos(clamp((dx * hx + dz * hz) / d, -1, 1));
      if (bearing > PERCH.cone) continue;
      const score = d + bearing * 4 + (s.kind === "planter" ? 3 : 0) + (s.edge ? 0.5 : 0);
      if (score < bs) { bs = score; best = s; }
    }
    this.target = best;
    if (best) {
      const mx = Math.min(0.35, (best.maxX - best.minX) * 0.3), mz = Math.min(0.35, (best.maxZ - best.minZ) * 0.3);
      this.aimX = clamp(px, best.minX + mx, best.maxX - mx); this.aimZ = clamp(pz, best.minZ + mz, best.maxZ - mz); this.aimD = Math.hypot(this.aimX - px, this.aimZ - pz);
    }
  }

  apply(inp: FlightInput, f: Flight): FlightInput {
    if (!this.enabled) return inp;
    if (f.mode === "air" && !f.hopping && f.stun <= 0) { this.air(inp, f); return inp; }
    this.target = null;
    if (f.stun > 0) return inp;
    if ((f.mode === "landed" || f.mode === "rollout") && inp.flapTap && !inp.flapHeld) this.hop(f);
    else if (f.mode === "landed") this.edge(inp, f);
    return inp;
  }

  private air(inp: FlightInput, f: Flight) {
    if (f.clock - this.t > 0.12 || this.t < 0) { this.t = f.clock; this.pick(f); }
    const s = this.target; if (!s) return;
    const px = f.pos.x, pz = f.pos.z, feet = f.pos.y - P.feetOffset;
    if (!(inp.brake || inp.flapTap)) return; // 意図(減速か羽ばたき)があるときだけ誘導する
    // 面の内側の少し奥を狙う(縁ぎりぎりを避ける)
    const mx = Math.min(0.35, (s.maxX - s.minX) * 0.3), mz = Math.min(0.35, (s.maxZ - s.minZ) * 0.3);
    const tx = clamp(px, s.minX + mx, s.maxX - mx), tz = clamp(pz, s.minZ + mz, s.maxZ - mz), dx = tx - px, dz = tz - pz, d = Math.hypot(dx, dz);
    const e = d > 0.3 ? wrap(Math.atan2(-dx, -dz) - f.yaw) : 0;
    const hDes = s.top + 0.45 + Math.max(0, d - 1) * 0.3;
    let k = PERCH.strength * (d < 0.3 ? 0 : 1) * (d < 4 ? 1.5 : 1); // 近づくほど誘導を強めに(小さな面でも外れにくい)
    const gx = -clamp(e * 1.8, -1, 1), gy = clamp((hDes - feet) * 0.3, -0.8, 0.45);
    if (inp.x * gx < 0 && Math.abs(inp.x) > 0.6) k *= 0.3; // 反対へ強く操作しているなら、その意思を優先
    inp.x += (gx - inp.x) * k; inp.y += (gy - inp.y) * Math.min(1, k * 1.5); // 高さの誘導は少し強め(減速で機首が上がって浮きやすいので)
    const hs = Math.hypot(f.vel.x, f.vel.z);
    // 終端の「受け止め」: 面のすぐ上(足が上面から0.7m以内)で面の真上にいて低速なら、水平速度を落として面に降ろす(ふわっと止まる着地)
    // 面のすぐ手前・すぐ上(水平2.2m・高さ1.8m以内)では、水平速度を落とし、面へ向けて降りる速さを高さに比例させる(小さな面にも降りられる「ふわっと」した着地)
    const above = feet - s.top;
    if (d < 2.2 && above < 1.8 && above > -0.3 && hs < 9) {
      const k = Math.exp(-6 / 60); f.vel.x *= k; f.vel.z *= k;
      const want = -clamp(above * 1.4, 0.5, 2.5); if (f.vel.y > want) f.vel.y += (want - f.vel.y) * 0.25;
      if (d > 0.25) { f.vel.x += (dx / d) * 0.15; f.vel.z += (dz / d) * 0.15; }
      if (d < 1.2 && above < 1.0) { // ごく近く: 面の中の狙い点へ、ゆっくり(最大1.5m/s)寄せて小さな面にも降りられるようにする
        const sp = Math.min(1.5, d * 2.5), tvx = d > 0.05 ? (dx / d) * sp : 0, tvz = d > 0.05 ? (dz / d) * sp : 0;
        f.vel.x += (tvx - f.vel.x) * 0.35; f.vel.z += (tvz - f.vel.z) * 0.35;
      }
      this.stats.captures++;
    }
    if (!inp.brake && d < 13 && hs > 6.5 && feet - s.top < 4) inp.brake = true;      // 近づいたら速度を落として降りる
    this.stats.guided++;
  }

  /** 地上の小ジャンプ: 前方の低い段差に乗れるよう、高さ・前進量を足す */
  private hop(f: Flight) {
    const px = f.pos.x, pz = f.pos.z, feet = f.pos.y - P.feetOffset, hx = -Math.sin(f.yaw), hz = -Math.cos(f.yaw);
    this.idx.near(px, pz, PERCH.hopRange + 1, this.near);
    let best: Surface | null = null, bd = 1e9, bdd = 0;
    for (const s of this.near) {
      const rise = s.top - feet; if (rise < 0.25 || rise > PERCH.hopMaxRise) continue;
      const cx = clamp(px, s.minX, s.maxX), cz = clamp(pz, s.minZ, s.maxZ), dx = cx - px, dz = cz - pz, d = Math.hypot(dx, dz);
      if (d > PERCH.hopRange || (d > 0.3 && Math.acos(clamp((dx * hx + dz * hz) / d, -1, 1)) > 0.7)) continue;
      if (d < bd) { bd = d; best = s; bdd = d; }
    }
    if (!best) return;
    const rise = best.top - feet, vy = Math.sqrt(2 * P.gravity * (rise + 0.4));
    // 小ジャンプの放物線を物理と同じ刻み(1/60秒・半陰的オイラー)で先に数え、面の高さまで降りてくる時刻を求める
    let ty = feet + 0.03, tv = vy, tLand = 0; for (let i = 0; i < 240; i++) { tv -= P.gravity / 60; ty += tv / 60; tLand += 1 / 60; if (tv < 0 && ty <= best.top) break; }
    // 面の内側(縁の細い面なら中心線)の手前側を狙って向きを合わせる(向きの誤差が±0.35rad程度でも細い壁に乗れる)
    const tx = best.axisAlongX ? clamp(px, best.minX + 0.2, best.maxX - 0.2) : (best.minX + best.maxX) / 2, tz = best.axisAlongX ? (best.minZ + best.maxZ) / 2 : clamp(pz, best.minZ + 0.2, best.maxZ - 0.2);
    const ddx = (best.edge ? tx : clamp(px, best.minX + 0.3, best.maxX - 0.3)) - px, ddz = (best.edge ? tz : clamp(pz, best.minZ + 0.3, best.maxZ - 0.3)) - pz, dd = Math.hypot(ddx, ddz);
    f.hopHint = { up: Math.max(P.hopUp, vy), fwd: clamp((best.edge ? Math.max(dd - 0.08, bdd + 0.05) : Math.max(dd, bdd + 0.2) + 0.3) / tLand, 0.6, 3.5), yaw: dd > 0.2 ? Math.atan2(-ddx, -ddz) : undefined };
    this.stats.hopAssists++;
  }

  /** 縁の上の歩行: 縁の軸へ向きを寄せ、端では止まる */
  private edge(inp: FlightInput, f: Flight) {
    const s = this.idx.under(f.pos.x, f.pos.y - P.feetOffset, f.pos.z, this.under);
    if (!s || !s.edge) return;
    if (inp.brake) { // 歩いている
      // 縁の軸に沿う向き(前向き/後ろ向きのうち近い方)へ。中心線からずれているぶん、中心へ少し斜めに向ける
      const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, a1 = s.axisAlongX ? -Math.PI / 2 : 0;
      const e1 = wrap(a1 - f.yaw), e2 = wrap(a1 + Math.PI - f.yaw), plus = Math.abs(e1) < Math.abs(e2), sgn = plus ? 1 : -1;
      const lat = s.axisAlongX ? f.pos.z - cz : f.pos.x - cx, dl = clamp(Math.abs(lat) * 3, 0, 0.6), sl = lat >= 0 ? 1 : -1;
      const hx = s.axisAlongX ? sgn * Math.cos(dl) : -sl * Math.sin(dl), hz = s.axisAlongX ? -sl * Math.sin(dl) : -sgn * Math.cos(dl); // 軸方向の単位ベクトルに、中心向きの成分を足したもの
      const yawDes = Math.atan2(-hx, -hz), e = wrap(yawDes - f.yaw);
      if (Math.abs(wrap((plus ? e1 : e2))) < PERCH.edgeAlign && Math.abs(inp.x) < 0.8) { inp.x += (-clamp(e * 2.5, -1, 1) - inp.x) * 0.8; this.stats.edgeAligns++; }
      const ax = f.pos.x - Math.sin(f.yaw) * 0.5, az = f.pos.z - Math.cos(f.yaw) * 0.5; // 0.5m先
      if (ax < s.minX - 0.02 || ax > s.maxX + 0.02 || az < s.minZ - 0.02 || az > s.maxZ + 0.02) { inp.brake = false; this.stats.edgeStops++; } // 端: 空中へ歩き出さない
    }
  }
}
