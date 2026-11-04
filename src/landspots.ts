import type { Surface, SurfaceIndex } from "./perches";

/**
 * H8-B 着地点マーカー(全候補表示)。視界の中にある「着地できる足場」を、早い段階からすべて個別にマーキングする。
 * 責務は 3 つに分けている:
 *   LandSpots  (ここ)       : どの足場を、画面のどこに、どう見せるか。候補の発見・消去・重なりの整理・タップ対象の決定。飛行・着地の判断はしない。
 *   AutoLand.check/start    : 安全に降りられるか(タップした時に毎回あらためて検査する)。「見つける」と「降りてよい」は別。
 *   main.ts                 : カメラの投影と描画、入力との接続。
 * 候補の ID は Surface.id(街の生成で決まり、ゲーム中は変わらない)。固定件数の上限は設けない(欠落は stats に数える)。
 */
export const SPOTS = {
  range: 45,         // 鳥から足場の縁までの水平距離がこれ以内の足場を探す(m)。遅いときの下限
  rangeMax: 90,      // H8-C: 速いときの先読みの上限(m)
  lookS: 7,          // H8-C: 先読みの時間(秒)。範囲 = clamp(対地速度 × lookS, range, rangeMax)。速いほど遠方の候補を早く見せる
  nearRange: 18,     // AutoLand の maxRange と同じ: これより遠い足場は、押しても「遠すぎ」と断られるので薄く描く
  behindM: -0.5,     // 鳥の進行方向に対して、これより後ろにある足場は消す(m)
  screenMargin: 0.0, // 画面(NDC ±1)の外にある足場は消す。出る側にだけ少し余裕(下のヒステリシス)
  leaveMargin: 0.06, // いったん見えた足場は、画面の外へ 6% はみ出すまで消さない(縁でのちらつき防止)
  graceS: 0.25,      // 指を押してから離すまでの間に一瞬(描画が遅いとき)見えなくなっても、押した候補として扱う猶予(秒)
  mergeTreeXZ: 3.5, mergeTreeY: 8, // 同じ木の枝は 1 つにまとめる(枝は 1 本の木に何本もある)
  mergeXZ: 1.2, mergeY: 1.5, // 同じ構造物の重複(ベランダの床と手すりなど)を 1 つにまとめる距離(m)
  radiusPx: 15,      // 描く大きさ(半径 px)
  hitPx: 34, ambigPx: 6, // 触れた点に近い目印が 2 つあり、その距離の差が ambigPx 未満なら「紛らわしい押し方」として数える(選択は最も近いほう)
          // 触れたとき、この半径(px)に入る最寄りの目印を選ぶ
  trailPx: 24,       // 動く目印が指の届く前に動いた分を拾う半径(直近 trailS 秒の位置)
  trailS: 0.25,
  sepPx: 40,         // 目印どうしがこれより近いと、重ならないようにずらす
  shiftPx: 26,       // 本来の位置からずらしてよい最大(px)
  losEveryS: 0.15,   // 遮蔽の判定の間隔(秒)。結果は次の判定まで使う
  losStepM: 4,
};
const LABEL: Record<string, string> = { bench: "ベンチ", wall: "塀", planter: "花壇", roof: "屋根", tank: "タンク", balcony: "ベランダ", rail: "手すり", fence: "柵", pole: "電柱", sign: "看板", branch: "枝", rock: "岩" };
export const spotLabel = (kind: string) => LABEL[kind] ?? kind;

export interface Spot {
  id: number; s: Surface; kind: string;
  /** 本来の画面位置(CSS px)と、重なりを避けてずらした表示位置 */
  x: number; y: number; dx: number; dy: number;
  d: number;         // 鳥から足場の縁までの水平距離 m
  rise: number;      // 足場の上面 − 鳥の足元(m)。正なら足場のほうが高い
  near: boolean;     // 自動着地の届く範囲(遠すぎ・高すぎでない)に見える
  stacked: boolean;  // 近くの目印と重なっている(名前を添えて見分ける)
  alpha: number;     // 表示の濃さ(出る・消えるをなめらかに)
  trail: { x: number; y: number; t: number }[];
  seen: number;      // 最後に見えていた時刻
}
export interface SpotFrame {
  /** 鳥(足元でなく体の位置)と進行方向(単位ベクトル xz)、カメラ位置 */
  bx: number; by: number; bz: number; fx: number; fz: number; feetY: number; cx: number; cy: number; cz: number;
  w: number; h: number; t: number;
  /** H8-C: 鳥の対地速度 m/s(先読みの範囲を決める) */ speed?: number;
  /** ワールド座標 → 正規化画面座標(NDC: x,y ∈ [-1,1]、z<1 でカメラの前) */
  project: (x: number, y: number, z: number, out: { x: number; y: number; z: number }) => void;
  heightAt: (x: number, z: number) => number;
  /** UI ボタンなどの矩形(画面 px)。この上の目印は押せないので出さない */
  ui?: { x0: number; y0: number; x1: number; y1: number }[];
}

export class LandSpots {
  enabled = true;
  /** いま見えている候補(遠い順でなく、近い順) */
  list: Spot[] = [];
  /** 押している間の選択(押した瞬間に決めた ID)。-1 は何も選んでいない */
  pressedId = -1;
  /** 自動着地の目的地(自動着地中は、この目印だけを緑で見せる) */
  targetId = -1;
  stats = { frames: 0, enumerated: 0, shown: 0, maxShown: 0, merged: 0, behind: 0, offscreen: 0, occluded: 0, ui: 0, stacked: 0, pickNone: 0, picks: 0, ambig: 0, gone: 0, resets: 0 };
  private all = new Map<number, Spot>(); private tmp: Surface[] = []; private p = { x: 0, y: 0, z: 0 };
  /** 見えなくなった候補の記録(いつ・通り過ぎたか)。押している最中の候補が一瞬消えただけか、本当に去ったかの判断に使う */
  private lost = new Map<number, { t: number; behind: boolean; why: string }>(); private why = new Map<number, string>(); rangeNow = SPOTS.range; private behindIds = new Set<number>();
  private los = new Map<number, { t: number; hidden: boolean }>();
  constructor(private idx: SurfaceIndex) {}

  /** 表示の ON/OFF。OFF にすると、目印と選択をすべて消す(進行中の自動着地は止めない: それは AutoLand の状態) */
  setEnabled(on: boolean) { if (on === this.enabled) return; this.enabled = on; if (!on) this.clear("off"); }
  clear(_why = "") { if (this.list.length || this.pressedId >= 0) this.stats.resets++; this.list.length = 0; this.all.clear(); this.lost.clear(); this.pressedId = -1; this.los.clear(); }

  /** 毎フレーム。active=false(オート飛行中・地上・衝突直後など)なら、目印を出さない */
  update(F: SpotFrame, active: boolean) {
    this.stats.frames++;
    if (!this.enabled || !active) { if (this.list.length) this.clear(); else this.pressedId = -1; return; }
    const R = Math.min(SPOTS.rangeMax, Math.max(SPOTS.range, (F.speed ?? 0) * SPOTS.lookS)); this.rangeNow = R; // H8-C: 速いほど遠くから
    const near = this.idx.near(F.bx, F.bz, R, this.tmp); this.behindIds.clear(); this.why.clear();
    this.stats.enumerated = near.length;
    const hs = Math.hypot(F.fx, F.fz) || 1, fx = F.fx / hs, fz = F.fz / hs;
    // --- 発見: 前方・視界の中・遮蔽されていない足場 ---
    const cand: Spot[] = [];
    for (const s of near) {
      const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
      const ex = Math.max(s.minX - F.bx, 0, F.bx - s.maxX), ez = Math.max(s.minZ - F.bz, 0, F.bz - s.maxZ), d = Math.hypot(ex, ez);
      if (d > R) continue;
      const prev = this.all.get(s.id);
      // 通り過ぎた(鳥の進行方向の後ろ): すぐ消す。足場の近い縁でなく、中心で見る(大きな屋根の上を飛んでいる間は、真上 = 後ろではない)
      const ahead = (cx - F.bx) * fx + (cz - F.bz) * fz, edgeAhead = Math.max((s.maxX - F.bx) * fx, (s.minX - F.bx) * fx) + Math.max((s.maxZ - F.bz) * fz, (s.minZ - F.bz) * fz);
      const big = Math.max(s.maxX - s.minX, s.maxZ - s.minZ) > 4; // 大きな屋根などは、体のどこかが前にある間は残す。小さな足場は、中心が後ろに回ったら消す
      if ((big ? Math.max(ahead, edgeAhead) : ahead) < SPOTS.behindM) { this.stats.behind++; this.behindIds.add(s.id); this.why.set(s.id, "behind"); continue; }
      F.project(cx, s.top + 0.05, cz, this.p);
      const m = prev ? SPOTS.leaveMargin : SPOTS.screenMargin;
      if (!(this.p.z < 1) || Math.abs(this.p.x) > 1 + m || Math.abs(this.p.y) > 1 + m) { this.stats.offscreen++; this.why.set(s.id, "offscreen"); continue; }
      const px = (this.p.x * 0.5 + 0.5) * F.w, py = (-this.p.y * 0.5 + 0.5) * F.h;
      if (F.ui && F.ui.some(r => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1)) { this.stats.ui++; this.why.set(s.id, "ui"); continue; }
      // 遮蔽: カメラから足場の中心までのあいだに、街(建物・地形)が入っていないか。判定は間引き、結果は次の判定まで使う
      let lo = this.los.get(s.id);
      if (!lo || F.t - lo.t >= SPOTS.losEveryS || F.t < lo.t) { lo = { t: F.t, hidden: this.occluded(F, s, cx, cz) }; this.los.set(s.id, lo); }
      if (lo.hidden) { this.stats.occluded++; this.why.set(s.id, "occluded"); continue; }
      const sp = prev ?? { id: s.id, s, kind: s.kind, x: px, y: py, dx: px, dy: py, d, rise: 0, near: false, stacked: false, alpha: 0, trail: [], seen: F.t };
      sp.x = px; sp.y = py; sp.d = d; sp.rise = s.top - F.feetY; sp.near = d <= SPOTS.nearRange && sp.rise <= 0.5; sp.seen = F.t;
      if (!prev) { sp.dx = px; sp.dy = py; this.all.set(s.id, sp); }
      sp.trail.push({ x: px, y: py, t: F.t }); while (sp.trail.length > 1 && F.t - sp.trail[0].t > SPOTS.trailS) sp.trail.shift();
      cand.push(sp);
    }
    // --- 整理: 同じ構造物の重複を 1 つにする(ベランダの床と手すりなど。面積の大きいほうを残す) ---
    cand.sort((a, b) => (b.s.maxX - b.s.minX) * (b.s.maxZ - b.s.minZ) - (a.s.maxX - a.s.minX) * (a.s.maxZ - a.s.minZ) || a.id - b.id);
    const kept: Spot[] = [];
    for (const c of cand) {
      const ccx = (c.s.minX + c.s.maxX) / 2, ccz = (c.s.minZ + c.s.maxZ) / 2;
      const tree = c.kind === "branch"; // 1 本の木には枝がいくつもあるので、同じ木の枝は 1 つにまとめる(代表は面積・ID の順で毎回同じ枝 = 目印が跳ばない)
      const mxz = tree ? SPOTS.mergeTreeXZ : SPOTS.mergeXZ, my = tree ? SPOTS.mergeTreeY : SPOTS.mergeY;
      const dup = kept.some(k => (!tree || k.kind === "branch") && Math.abs((k.s.minX + k.s.maxX) / 2 - ccx) < mxz && Math.abs((k.s.minZ + k.s.maxZ) / 2 - ccz) < mxz && Math.abs(k.s.top - c.s.top) < my);
      if (dup) { this.stats.merged++; this.why.set(c.id, "merged"); continue; }
      kept.push(c);
    }
    kept.sort((a, b) => a.d - b.d || a.id - b.id); // 近い順(重なったときは近いほうを動かさない)
    // --- 重なりを避ける: 近い目印は動かさず、遠い目印を重ならない向きへずらす(本来の位置から shiftPx まで) ---
    for (const a of kept) { a.stacked = false; }
    for (let i = 0; i < kept.length; i++) {
      const a = kept[i]; let tx = a.x, ty = a.y;
      for (let it = 0; it < 4; it++) for (let j = 0; j < i; j++) {
        const b = kept[j], ex = tx - b.dx, ey = ty - b.dy, dd = Math.hypot(ex, ey);
        if (dd < SPOTS.sepPx) { a.stacked = b.stacked = true; const u = dd > 0.5 ? [ex / dd, ey / dd] : [i % 2 ? 1 : -1, 0.3]; tx = b.dx + u[0] * SPOTS.sepPx; ty = b.dy + u[1] * SPOTS.sepPx; }
      }
      const sx = tx - a.x, sy = ty - a.y, sd = Math.hypot(sx, sy); if (sd > SPOTS.shiftPx) { tx = a.x + sx / sd * SPOTS.shiftPx; ty = a.y + sy / sd * SPOTS.shiftPx; }
      tx = Math.min(F.w - 14, Math.max(14, tx)); ty = Math.min(F.h - 14, Math.max(14, ty));
      if (F.ui && F.ui.some(r => tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1)) { tx = a.x; ty = a.y; } // ずらした先がボタンの上なら、本来の位置に戻す(ボタンの上の目印は押せない)
      const k = 1 - Math.exp(-Math.min(0.1, 1 / 60) / 0.08); // ずらした位置へなめらかに動く(目印が跳ばない)
      a.dx += (tx - a.dx) * (a.alpha > 0 ? k : 1); a.dy += (ty - a.dy) * (a.alpha > 0 ? k : 1);
      a.alpha = Math.min(1, a.alpha + 0.2);
    }
    this.stats.stacked = kept.filter(a => a.stacked).length;
    // 見えなくなった候補は、その場で消す(5 秒の残像は残さない)。選択も、その候補なら解く
    for (const [id, sp] of this.all) if (!kept.includes(sp)) { this.all.delete(id); sp.alpha = 0; this.lost.set(id, { t: F.t, behind: this.behindIds.has(id), why: this.why.get(id) ?? (this.idx.all[id] && Math.hypot(Math.max(this.idx.all[id].minX - F.bx, 0, F.bx - this.idx.all[id].maxX), Math.max(this.idx.all[id].minZ - F.bz, 0, F.bz - this.idx.all[id].maxZ)) > R ? "range" : "other") }); }
    for (const sp of kept) this.lost.delete(sp.id);
    if (this.lost.size > 400) for (const [id, l] of this.lost) if (F.t - l.t > 5) this.lost.delete(id);
    this.list = kept; this.stats.shown = kept.length; this.stats.maxShown = Math.max(this.stats.maxShown, kept.length);
    if (this.pressedId >= 0 && !this.valid(this.pressedId, F.t)) { this.pressedId = -1; this.stats.resets++; }
  }
  private occluded(F: SpotFrame, s: Surface, cx: number, cz: number): boolean {
    const y1 = s.top + 0.3, dx = cx - F.cx, dz = cz - F.cz, dy = y1 - F.cy, len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.floor(len / SPOTS.losStepM));
    for (let i = 1; i < n; i++) {
      const u = i / n, x = F.cx + dx * u, z = F.cz + dz * u, y = F.cy + dy * u;
      if (x >= s.minX - 0.3 && x <= s.maxX + 0.3 && z >= s.minZ - 0.3 && z <= s.maxZ + 0.3) continue; // 足場自身の真上は遮蔽としない
      if (F.heightAt(x, z) > y + 0.3) return true;
    }
    return false;
  }
  /** 押せる目印か(いま見えている、または、押した直後に一瞬だけ見えなくなった) */
  valid(id: number, t: number): boolean { if (this.list.some(q => q.id === id)) return true; const l = this.lost.get(id); return !!l && !l.behind && t - l.t <= SPOTS.graceS; }
  /** 見えなくなった理由(診断用): behind / offscreen / ui / occluded / merged / range。まだ見えているときは null */
  goneWhy(id: number): string | null { return this.list.some(q => q.id === id) ? null : this.lost.get(id)?.why ?? null; }
  get(id: number): Spot | null { return this.list.find(q => q.id === id) ?? null; }
  /** 画面の (x,y) に触れたとき、狙われた候補。表示位置が近い順(同じなら、鳥に近いほう)。見つからなければ null。 */
  pick(x: number, y: number): Spot | null {
    let best: Spot | null = null, bd = 1e9, second = 1e9;
    for (const sp of this.list) {
      let dd = Math.hypot(x - sp.dx, y - sp.dy);
      if (dd > SPOTS.hitPx) { // 動く目印が、指の届く前に動いた分: 直近の本来の位置も当たりにする(表示位置が優先)
        let tr = 1e9; for (const q of sp.trail) tr = Math.min(tr, Math.hypot(x - q.x, y - q.y)); if (tr <= SPOTS.trailPx) dd = SPOTS.hitPx + tr * 0.01; else continue;
      }
      if (dd < bd - 1e-6) { second = bd; bd = dd; best = sp; } else if (dd < second) second = dd;
    }
    if (best) { this.stats.picks++; if (second - bd < SPOTS.ambigPx) this.stats.ambig++; } else this.stats.pickNone++; // ambig: 最も近い目印と 2 番目の距離の差が小さい = 紛らわしい押し方(選ぶのは最も近いほう)
    return best;
  }
}
