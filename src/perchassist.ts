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
  // 接触直前の着地成立(短距離スナップ)。通常の物理とは別に、条件を満たしたときだけ足場の上へ置く
  snapTol: 0.45,         // 足場の縁から水平にこれだけ外れていても着地にする m
  snapBelow: 0.45,       // 足が上面よりこれだけ低くても(側面に当たる前なら)上へ乗せる m
  snapAbove: 0.9,        // 上面よりこれだけ上から、降りてくる途中なら着地にする m
  snapMaxSpeed: 8.5,     // これより速い水平速度は着地にしない(高速衝突は衝突のまま)
  markerHold: 5,         // G1-4: 目印(◯)を、候補が一時的に見えなくなっても保つ秒数
  markerKeepRange: 18,   // …保つのは、この水平距離以内のあいだ
  markerSwitchGain: 1.5, // 別の候補へ切り替えるのは、新しい候補がこれ(m)以上近いとき(ちらつき防止)
  snapLook: 0.12,        // 何秒先まで見て「もうすぐ触れる」とみなすか
  settleAbove: 1.8,      // 足場の真上をこの高さ以内で、
  settleSpeed: 5.5,      // この速さ以下で通るときは、その場で穏やかに降ろす(位置は動かさない)
};
const dIn = (x: number, z: number, s: Surface) => x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ;
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
  stats = { snaps: 0, settles: 0, guided: 0, hopAssists: 0, edgeStops: 0, edgeAligns: 0, captures: 0, maxStep: 0, rolloutStops: 0, brakeHolds: 0 };
  /** G1-4: 目印の足場。候補選別(8Hz)が一瞬ほかを選んだり見失っても、markerHold 秒は保つ。着地・遠ざかり・到達不能・時間切れで解除 */
  marker: Surface | null = null; private markerUntil = 0;
  /** G1-5: 自動着地が指定した足場。あるとき pick() は進行方向の円錐に関係なくこの足場を選び、空中の誘導は減速/羽ばたきの意図がなくても働く */
  forced: Surface | null = null;
  /** 直近の空中誘導が立てた着地計画(目標点・その高さ・長手方向に沿って入るか)。自動着地が進入の目標に使う */
  plan: { tx: number; tz: number; h: number; lengthwise: boolean; t: number } | null = null;
  private near: Surface[] = []; private fromId = -1; private fromT = -9; private under: Surface[] = []; private t = -1;
  constructor(private idx: SurfaceIndex) {}

  /** 進行方向(速度があれば速度、なければ向き)に対する候補の選別。毎フレームではなく約8Hzで更新。 */
  private pick(f: Flight) {
    const px = f.pos.x, pz = f.pos.z, feet = f.pos.y - P.feetOffset;
    const hs = Math.hypot(f.vel.x, f.vel.z), hx = hs > 3 ? f.vel.x / hs : -Math.sin(f.yaw), hz = hs > 3 ? f.vel.z / hs : -Math.cos(f.yaw);
    let best: Surface | null = null, bs = 1e9;
    if (this.forced) { // 自動着地: 指定された足場だけ(範囲外・面より低いときは外す)
      const s = this.forced, cx = clamp(px, s.minX, s.maxX), cz = clamp(pz, s.minZ, s.maxZ), d = Math.hypot(cx - px, cz - pz);
      this.target = d <= PERCH.range * 1.6 && feet - s.top > -0.4 ? s : null;
      if (this.target) { this.setAim(this.target, px, pz); this.marker = this.target; this.markerUntil = f.clock + PERCH.markerHold; }
      return;
    }
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
    if (best) this.setAim(best, px, pz);
    this.updateMarker(f, best);
  }
  private setAim(s: Surface, px: number, pz: number) {
    const mx = Math.min(0.35, (s.maxX - s.minX) * 0.3), mz = Math.min(0.35, (s.maxZ - s.minZ) * 0.3);
    this.aimX = clamp(px, s.minX + mx, s.maxX - mx); this.aimZ = clamp(pz, s.minZ + mz, s.maxZ - mz); this.aimD = Math.hypot(this.aimX - px, this.aimZ - pz);
  }
  /** 目印の更新(pick のたびに呼ぶ)。新しい候補を見つけたら期限を延ばす。見失っても期限内で、まだ着地できる位置にいる間は同じ足場を保つ。 */
  private updateMarker(f: Flight, cand: Surface | null) {
    const px = f.pos.x, pz = f.pos.z, feet = f.pos.y - P.feetOffset;
    const dist = (s: Surface) => Math.hypot(clamp(px, s.minX, s.maxX) - px, clamp(pz, s.minZ, s.maxZ) - pz);
    const m = this.marker;
    if (m && (f.clock > this.markerUntil || dist(m) > PERCH.markerKeepRange || feet - m.top < -0.5)) this.marker = null; // 時間切れ・遠い・面より低い(到達不能)
    if (cand) {
      if (!this.marker) { this.marker = cand; this.markerUntil = f.clock + PERCH.markerHold; }
      else if (cand === this.marker) this.markerUntil = f.clock + PERCH.markerHold;
      else if (dist(cand) < dist(this.marker) - PERCH.markerSwitchGain) { this.marker = cand; this.markerUntil = f.clock + PERCH.markerHold; } // 明らかに近い別の候補へ
    }
  }
  /** 目印を置く点(足場の内側で、いまの位置にいちばん近い点)。毎フレーム計算するので、鳥が動いても足場とずれない */
  markerPoint(f: Flight, out: { x: number; z: number; top: number; d: number } ): boolean {
    const s = this.marker; if (!s) return false;
    const mx = Math.min(0.35, (s.maxX - s.minX) * 0.3), mz = Math.min(0.35, (s.maxZ - s.minZ) * 0.3);
    out.x = clamp(f.pos.x, s.minX + mx, s.maxX - mx); out.z = clamp(f.pos.z, s.minZ + mz, s.maxZ - mz); out.top = s.top; out.d = Math.hypot(out.x - f.pos.x, out.z - f.pos.z); return true;
  }
  clearMarker() { this.marker = null; }

  apply(inp: FlightInput, f: Flight): FlightInput {
    if (!this.enabled) return inp;
    if (f.mode !== "air") { this.marker = null; const u = this.idx.under(f.pos.x, f.pos.y - P.feetOffset, f.pos.z, this.under); this.fromId = u ? u.id : -1; this.fromT = f.clock; }
    if (f.mode === "air" && f.stun <= 0 && this.snap(inp, f)) return inp;
    if (f.mode === "air" && !f.hopping && f.stun <= 0) { this.air(inp, f); return inp; }
    this.target = null;
    if (f.stun > 0) return inp;
    if (f.mode === "rollout") this.rollout(f);
    if ((f.mode === "landed" || f.mode === "rollout") && inp.flapTap && !inp.flapHeld) this.hop(f);
    else if (f.mode === "landed") this.edge(inp, f);
    return inp;
  }

  /**
   * 接触直前の着地成立判定。足場の縁から数十cm以内・上面付近を、ゆっくり(低速で)通る/降りるとき、
   * 側面にぶつかったり縁から滑り落ちたりする前に、足場の上へ短く置き直す(最大でも水平 snapTol・垂直 snapBelow/snapAbove)。
   * 遠くからの吸着・ワープ・壁の貫通はしない。速すぎる・上昇中・羽ばたいて上がっている、ときは何もしない(通常の物理のまま)。
   */
  private snap(inp: FlightInput, f: Flight): boolean {
    const px = f.pos.x, pz = f.pos.z, feet = f.pos.y - P.feetOffset, vx = f.vel.x, vz = f.vel.z, vy = f.vel.y, hs = Math.hypot(vx, vz);
    if (hs > PERCH.snapMaxSpeed || vy > 1.2 || -vy > P.safeSink || (inp.flapHeld && vy > 0.3)) return false;
    const T = PERCH.snapLook, qx = px + vx * T, qz = pz + vz * T, qFeet = feet + vy * T, tol = PERCH.snapTol;
    this.idx.near(px, pz, 2, this.near);
    let best: Surface | null = null, bd = 1e9;
    for (const s of this.near) {
      if (s.kind === "roof" || s.kind === "tank") continue; // 広い面は通常の着地で十分
      if (s.id === this.fromId && f.clock - this.fromT < 0.8) continue; // いま降りた/飛び立った足場へは引き戻さない
      const a = feet - s.top, aq = qFeet - s.top;
      const above = s.kind === "balcony" ? 1.4 : PERCH.snapAbove; // ベランダは手すり(+1m)を越えてから降りるので、少し上から受け止める
      if (a < -PERCH.snapBelow || a > above) continue;
      if (a > 0.08 && aq > 0.08 && !(s.kind === "balcony" && dIn(px, pz, s) && vy < 0.3)) continue; // まだ上空を通過中(もうすぐ触れる高さまで降りていない)。ベランダの真上に入ったら受け止める
      const dNow = Math.hypot(px - clamp(px, s.minX, s.maxX), pz - clamp(pz, s.minZ, s.maxZ));
      const dNext = Math.hypot(qx - clamp(qx, s.minX, s.maxX), qz - clamp(qz, s.minZ, s.maxZ)), d = Math.min(dNow, dNext);
      if (d > tol + (Math.min(s.maxX - s.minX, s.maxZ - s.minZ) < 0.7 ? 0.15 : 0)) continue; // 細い物(手すり・柵・枝・電柱の頭)は少し広めに許す
      if (dNow > 0.05 && dNext > dNow + 0.02 && a < 0.08) continue; // 横から: 離れていく向きなら乗せない
      if (dNow > tol + 0.3) continue; // 置き直す距離は短く(先読みぶんを含めても0.75m程度まで)
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) return this.settle(inp, f);
    const s = best, inX = Math.min(0.12, (s.maxX - s.minX) * 0.35), inZ = Math.min(0.12, (s.maxZ - s.minZ) * 0.35);
    const tx = clamp(px, s.minX + inX, s.maxX - inX), tz = clamp(pz, s.minZ + inZ, s.maxZ - inZ); // 今いる位置から最も近い足場上の点(最短距離)
    if (this.cover(tx, tz, s.top)) return false; // 上に別の物がある(ベランダの下など)
    // 速度: 細い縁は軸方向だけ残して歩く速さへ、広い面は少し残して止まる。滑り落ちない
    let ux = vx, uz = vz;
    if (s.edge) { const ax = s.axisAlongX ? 1 : 0, az = s.axisAlongX ? 0 : 1, va = vx * ax + vz * az; ux = ax * va; uz = az * va; }
    const us = Math.hypot(ux, uz), keep = Math.min(us, s.edge ? P.walkSpeed : 3);
    f.pos.set(tx, s.top + P.feetOffset, tz);
    f.vel.set(us > 1e-6 ? ux / us * keep : 0, 0, us > 1e-6 ? uz / us * keep : 0);
    f.mode = "landed"; f.walkV = keep; f.hopping = false; f.hopT = -1; f.stall = false; f.strokeT = -1; f.agl = 0;
    if (keep > 0.3) f.yaw = Math.atan2(-f.vel.x, -f.vel.z);
    else if (s.edge) { const a1 = s.axisAlongX ? -Math.PI / 2 : 0; f.yaw = Math.abs(wrap(a1 - f.yaw)) < Math.PI / 2 ? a1 : a1 + Math.PI; } // 細い縁へ横から降りたら、縁に沿う向きへ向き直る(すぐ歩ける)
    this.stats.snaps++; this.target = null;
    return true;
  }
  /**
   * 足場の真上(縁から snapTol 以内)を、ゆっくり(低速で)少し高めに通っているとき: その場で穏やかに降ろす。
   * 位置は動かさず速度だけを、加速度の上限つきで変える(急停止・急降下にしない)。触れる直前になれば snap が受け止める。
   */
  private settle(inp: FlightInput, f: Flight): boolean {
    const px = f.pos.x, pz = f.pos.z, feet = f.pos.y - P.feetOffset, hs = Math.hypot(f.vel.x, f.vel.z);
    if (hs > PERCH.settleSpeed || f.vel.y > 0.5 || inp.flapHeld || f.hopping) return false;
    let best: Surface | null = null, ba = 1e9;
    for (const s of this.near) {
      if (s.kind === "roof" || s.kind === "tank" || (s.id === this.fromId && f.clock - this.fromT < 0.8)) continue;
      const a = feet - s.top, d = Math.hypot(px - clamp(px, s.minX, s.maxX), pz - clamp(pz, s.minZ, s.maxZ));
      if (a <= 0.05 || a > PERCH.settleAbove || d > PERCH.snapTol * 0.8) continue;
      if (this.cover(clamp(px, s.minX, s.maxX), clamp(pz, s.minZ, s.maxZ), s.top)) continue;
      if (a < ba) { ba = a; best = s; }
    }
    if (!best) return false;
    const s = best, tx = clamp(px, s.minX + 0.1, s.maxX - 0.1), tz = clamp(pz, s.minZ + 0.1, s.maxZ - 0.1);
    // 水平: 足場の内側へ寄せつつ歩く速さ程度まで落とす / 垂直: 少し速めに降りる。どちらも1ステップの変化に上限
    const k = Math.min(1, hs > 1e-6 ? P.walkSpeed / hs : 1), want = Math.max(1.6, ba * 3.5);
    this.ease(f, f.vel.x * k + (tx - px) * 3, f.vel.z * k + (tz - pz) * 3, PERCH.maxDecel);
    f.vel.y += clamp(-want - f.vel.y, -PERCH.maxDecel / 60, PERCH.maxDecel / 60);
    inp.brake = false; inp.flapTap = false; this.stats.settles++;
    return false; // 物理はそのまま進める(位置は物理が動かす)
  }
  private cover(x: number, z: number, top: number) { return this.idx.heightAt ? this.idx.heightAt(x, z) > top + 0.1 : false; }

  private air(inp: FlightInput, f: Flight) {
    if (f.clock - this.t > 0.12 || this.t < 0) { this.t = f.clock; this.pick(f); }
    const s = this.target; if (!s) return;
    if (!(inp.brake || inp.flapTap || this.forced)) return; // 意図(減速か羽ばたき)があるとき、または自動着地のときだけ誘導する
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
    this.plan = { tx, tz, h: hDes, lengthwise, t: f.clock };
    const dx = tx - px, dz = tz - pz, d = Math.hypot(dx, dz), e = d > 0.3 ? wrap(Math.atan2(-dx, -dz) - f.yaw) : 0;
    let k = (this.forced ? 0.85 : PERCH.strength) * (d < 0.3 ? 0 : 1) * (d < 4 ? 1.5 : 1); // 近づくほど誘導を強めに(小さな面でも外れにくい)
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
