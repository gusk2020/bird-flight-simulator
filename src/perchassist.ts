import { WALK_STICK_DEAD, type Flight, type FlightInput } from "./flight";
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
  maxDecel: 28,          // 着地直前の速度補正の上限 m/s²(急停止・急旋回を避ける)
  slideDecel: 30,        // 足場に降りたあとの滑走を止める摩擦 m/s²
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
  stats = { guided: 0, hopAssists: 0, edgeStops: 0, edgeAligns: 0, captures: 0, maxStep: 0, rolloutStops: 0, brakeHolds: 0 };
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
    if (f.mode === "rollout") this.rollout(f);
    if ((f.mode === "landed" || f.mode === "rollout") && inp.flapTap && !inp.flapHeld) this.hop(f);
    else if (f.mode === "landed") this.edge(inp, f);
    return inp;
  }

  private air(inp: FlightInput, f: Flight) {
    if (f.clock - this.t > 0.12 || this.t < 0) { this.t = f.clock; this.pick(f); }
    const s = this.target; if (!s) return;
    if (!(inp.brake || inp.flapTap)) return; // 意図(減速か羽ばたき)があるときだけ誘導する
    const px = f.pos.x, pz = f.pos.z, feet = f.pos.y - P.feetOffset, hs = Math.hypot(f.vel.x, f.vel.z);
    // --- 着地計画: 細長い面は「長手方向に沿って入り、低く滑り込んで止まる」(短い辺へ直角に当てるより許容が大きい)。それ以外・横から近い場合は面の内側の点を狙う。
    const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, ax = s.axisAlongX ? 1 : 0, az = s.axisAlongX ? 0 : 1, nx = -az, nz = ax;
    const hl = s.axisAlongX ? (s.maxX - s.minX) / 2 : (s.maxZ - s.minZ) / 2, hw = s.axisAlongX ? (s.maxZ - s.minZ) / 2 : (s.maxX - s.minX) / 2;
    const sAlong = (px - cx) * ax + (pz - cz) * az, lat = (px - cx) * nx + (pz - cz) * nz;
    const off = (s.outward ? 0.2 * (s.outward[0] * nx + s.outward[1] * nz) : 0); // 壁際の足場は外側へ少し寄せて狙う(壁へ近づきすぎない)
    // 長手方向の向き σ=±1 ごとに計画を立て、旋回の少ない方を選ぶ。手前の端から入る/横から並走して合流する、の2通り。
    let best: { sigma: number; u: number; dStart: number; tx: number; tz: number; turn: number } | null = null;
    if (s.edge && hl > hw * 1.5) for (const sg of [1, -1]) {
      const u0 = sg * sAlong; let uAim: number, dS: number;
      if (u0 < -hl + 1) { dS = -hl - u0; uAim = dS > 2.5 ? -hl + 0.4 : Math.min(hl - 0.4, u0 + 2.5); }   // 手前の端から入る
      else { dS = 0; uAim = u0 + Math.max(3, Math.abs(lat) + 1); if (uAim > hl - 1.2) continue; }          // 横から近い: 少し先で中心線に合流できるときだけ
      if (u0 < -hl - PERCH.range) continue;
      const ttx = cx + sg * ax * uAim + nx * off, ttz = cz + sg * az * uAim + nz * off, turn = Math.abs(wrap(Math.atan2(-(ttx - px), -(ttz - pz)) - f.yaw));
      if (turn > 1.6) continue;                                                                           // 大きく逆向きに曲がらないと入れない計画は取らない
      if (!best || turn < best.turn) best = { sigma: sg, u: u0, dStart: dS, tx: ttx, tz: ttz, turn };
    }
    const lengthwise = !!best, sigma = best ? best.sigma : 1, u = best ? best.u : 0;
    let tx: number, tz: number, hDes: number, dStart = 0;
    if (best) { tx = best.tx; tz = best.tz; dStart = best.dStart; hDes = s.top + (dStart > 0 ? 0.4 + dStart * 0.3 : 0.25); }   // 入口へ向けて浅く降り、面の上では低く
    else {
      const mx = Math.min(0.35, (s.maxX - s.minX) * 0.3), mz = Math.min(0.35, (s.maxZ - s.minZ) * 0.3);
      tx = clamp(px, s.minX + mx, s.maxX - mx); tz = clamp(pz, s.minZ + mz, s.maxZ - mz); const dd0 = Math.hypot(tx - px, tz - pz);
      hDes = s.top + 0.45 + Math.max(0, dd0 - 1) * 0.3;
    }
    const dx = tx - px, dz = tz - pz, d = Math.hypot(dx, dz), e = d > 0.3 ? wrap(Math.atan2(-dx, -dz) - f.yaw) : 0;
    let k = PERCH.strength * (d < 0.3 ? 0 : 1) * (d < 4 ? 1.5 : 1); // 近づくほど誘導を強めに(小さな面でも外れにくい)
    const gx = -clamp(e * (lengthwise ? 3.5 : 1.8), -1, 1), gy = clamp((hDes - feet) * 0.3, -0.8, 0.45);
    if (inp.x * gx < 0 && Math.abs(inp.x) > 0.6) k *= 0.3; // 反対へ強く操作しているなら、その意思を優先
    inp.x += (gx - inp.x) * k; inp.y += (gy - inp.y) * Math.min(1, k * 1.5); // 高さの誘導は少し強め(減速で機首が上がって浮きやすいので)
    // --- 終端の「受け止め」(穏やかに): 速すぎる・走路が足りないときは何もしない(無理に着地へ変換しない)
    const above = feet - s.top;
    if (lengthwise && dStart > 0 && dStart < 4 && above < 2 && hs < 9 && Math.abs(lat - off) < 1.5) { // 入口の手前: 横ずれを中心線へゆるやかに寄せる(急な横移動にならない上限つき)
      const vN = f.vel.x * nx + f.vel.z * nz, dv = (clamp(-(lat - off) * 3, -1, 1) - vN) * 0.12; f.vel.x += nx * dv; f.vel.z += nz * dv;
    }
    if (lengthwise) {
      const over = dStart < 0 && Math.abs(lat - off) < hw + 0.6 && above < 1.0 && above > -0.3, rem = hl - u;
      if (over && hs < 8.5 && rem > 0.4 && 1.4 * hs / rem <= 9) {
        // 長手方向の速度を、残りの走路で止まる程度の減衰(最大約9/s)で落とし、横ずれは中心線へゆっくり寄せ、降下は高さに比例
        const kd = Math.exp(-clamp(1.4 * hs / rem, 2.5, 9) / 60), vA = f.vel.x * ax + f.vel.z * az, tl = clamp(-(lat - off) * 6, -1.5, 1.5);
        this.ease(f, ax * vA * kd + nx * tl, az * vA * kd + nz * tl);
        const want = -clamp(above * 1.4, 0.5, 2.5); if (f.vel.y > want) f.vel.y += (want - f.vel.y) * 0.25;
        this.stats.captures++;
      }
    } else if (d < 2.2 && above < 1.8 && above > -0.3 && hs < 9) {
      // 面のすぐ手前・すぐ上(水平2.2m・高さ1.8m以内)では、水平速度を落とし、面へ向けて降りる速さを高さに比例させる
      const kk = Math.exp(-6 / 60), want = -clamp(above * 1.4, 0.5, 2.5); if (f.vel.y > want) f.vel.y += (want - f.vel.y) * 0.25;
      let tvx = f.vel.x * kk + (d > 0.25 ? (dx / d) * 0.15 : 0), tvz = f.vel.z * kk + (d > 0.25 ? (dz / d) * 0.15 : 0);
      if (d < 1.2 && above < 1.0) { // ごく近く: 面の中の狙い点へゆっくり(最大1.5m/s)寄せる。細い面は幅の中に中心を入れる必要がある
        const sp = Math.min(1.5, d * 4); tvx = d > 0.02 ? (dx / d) * sp : 0; tvz = d > 0.02 ? (dz / d) * sp : 0;
      }
      this.ease(f, tvx, tvz);
      this.stats.captures++;
    }
    // 降下線より1.2m以上高いうちは、減速(機首が上がって浮く)を一時的に外して先に降りる。線に乗ったら減速して降りる。
    const high = feet - hDes > 1.2 && d > 4;
    if (inp.brake && high && hs > 7.5) { inp.brake = false; this.stats.brakeHolds++; }
    else if (!inp.brake && (lengthwise ? dStart < 9 : d < 13) && hs > 6.5 && feet - s.top < 4 && !high) inp.brake = true; // 近づいたら速度を落として降りる
    this.stats.guided++;
  }

  /** 小さな足場へ滑り込んだあと(滑走中): 残りの走路で止まれない速さなら、足場の上で止まるよう余分に摩擦をかける(落ちるまで滑らない) */
  private rollout(f: Flight) {
    const s = this.idx.under(f.pos.x, f.pos.y - P.feetOffset, f.pos.z, this.under); if (!s || !s.edge && s.maxX - s.minX > 3 && s.maxZ - s.minZ > 3) return;
    const hs = Math.hypot(f.vel.x, f.vel.z); if (hs < 0.3) return;
    const vx = f.vel.x / hs, vz = f.vel.z / hs; // 進む向きにある足場の残り(端まで)
    const ex = vx > 0 ? s.maxX - f.pos.x : f.pos.x - s.minX, ez = vz > 0 ? s.maxZ - f.pos.z : f.pos.z - s.minZ;
    const rem = Math.min(Math.abs(vx) > 1e-3 ? ex / Math.abs(vx) : 1e9, Math.abs(vz) > 1e-3 ? ez / Math.abs(vz) : 1e9);
    if (hs * hs / (2 * 14) > rem - 0.1) { this.ease(f, 0, 0, PERCH.slideDecel); this.stats.rolloutStops++; } // 足の裏の摩擦: 空中の誘導より強い制動(約30 m/s²)
  }

  /** 水平速度を目標へ寄せる。1ステップの変化に上限(約14 m/s² ≒ 1.4G)を設け、不自然な急停止・急旋回にならないようにする */
  private ease(f: Flight, tvx: number, tvz: number, maxAcc = PERCH.maxDecel) {
    const dvx = tvx - f.vel.x, dvz = tvz - f.vel.z, m = Math.hypot(dvx, dvz), lim = maxAcc / 60;
    const kq = m > lim ? lim / m : 1; f.vel.x += dvx * kq; f.vel.z += dvz * kq; if (m * kq > this.stats.maxStep) this.stats.maxStep = m * kq;
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
    if (inp.brake || inp.y > WALK_STICK_DEAD) { // 歩いている(長押し/スティック前倒し)
      // 縁の軸に沿う向き(前向き/後ろ向きのうち近い方)へ。中心線からずれているぶん、中心へ少し斜めに向ける
      const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, a1 = s.axisAlongX ? -Math.PI / 2 : 0;
      const e1 = wrap(a1 - f.yaw), e2 = wrap(a1 + Math.PI - f.yaw), plus = Math.abs(e1) < Math.abs(e2), sgn = plus ? 1 : -1;
      const lat = s.axisAlongX ? f.pos.z - cz : f.pos.x - cx, dl = clamp(Math.abs(lat) * 3, 0, 0.6), sl = lat >= 0 ? 1 : -1;
      const hx = s.axisAlongX ? sgn * Math.cos(dl) : -sl * Math.sin(dl), hz = s.axisAlongX ? -sl * Math.sin(dl) : -sgn * Math.cos(dl); // 軸方向の単位ベクトルに、中心向きの成分を足したもの
      const yawDes = Math.atan2(-hx, -hz), e = wrap(yawDes - f.yaw);
      if (Math.abs(wrap((plus ? e1 : e2))) < PERCH.edgeAlign && Math.abs(inp.x) < 0.8) { inp.x += (-clamp(e * 2.5, -1, 1) - inp.x) * 0.8; this.stats.edgeAligns++; }
      const ax = f.pos.x - Math.sin(f.yaw) * 0.5, az = f.pos.z - Math.cos(f.yaw) * 0.5; // 0.5m先
      if (ax < s.minX - 0.02 || ax > s.maxX + 0.02 || az < s.minZ - 0.02 || az > s.maxZ + 0.02) { inp.brake = false; inp.y = Math.min(inp.y, 0); this.stats.edgeStops++; } // 端: 空中へ歩き出さない
    }
  }
}
