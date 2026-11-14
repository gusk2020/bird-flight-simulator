import { PROX } from "./params";

/** 近接機動の指示。flight.step の入力に載せる。yaw/pitch は世界の向き(ラジアン)で、触れ始めの進行方向を基準にしている。 */
export interface ProxCmd {
  yaw: number; pitch: number; speed: number;
  /** 中心(不感帯)に触れている */ center: boolean;
  /** 下向き(地上では座り込み・休息) */ down: boolean;
  /** 触れ続けている秒数 */ held: number;
  zone: "center" | "inner" | "ring" | "outer";
}
export interface PadRect { cx: number; cy: number; r: number }
export interface PadLayout { cruise: PadRect; prox: PadRect; /** 既定の配置で、これより下で触れ始めたら近接、上なら巡航(位置を動かしたときは inProxRegion の「近いほう」の規則を使う) */ split: number; zoneLeft: number; zoneRight: number }
/** H9: ◎の位置の保存形式。右手を基準にした画面の割合(0〜1)。左手では左右を反転して使う */
export interface PadPos { fx: number; fy: number }
export interface PadCustom { prox: PadPos; cruise: PadPos }
export interface Insets { l: number; r: number; t: number; b: number }
export const NO_INSETS: Insets = { l: 0, r: 0, t: 0, b: 0 };
/** H9: 既定の配置と、動かせる範囲 */
export const PADCFG = {
  inwardFrac: 0.34,  // 既定: 自分の側の半面の中で、内側(画面中央)寄りにこの割合(旧 0.5=半面の真ん中)
  gapPx: 2,          // 巡航◎と近接◎のあいだ(縁と縁)。旧は ◎ 1 つ分以上空いていた
  bottomPx: 22,      // 近接◎の下の余白
  minXFrac: 0.40,    // 動かせる範囲: 右手なら画面の右 60% の中(左手はその反対)。反対側の手の領域には入れない
  edgePx: 4,         // 画面端(安全領域の内側)からの最小の余白
};
const DEG = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const frac = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, 0, 1) : d);

/** 保存された値を検査する。壊れていれば null(既定位置) */
export function sanitizePadCustom(raw: unknown): PadCustom | null {
  const o = raw as Record<string, Record<string, unknown>> | null; if (!o || typeof o !== "object") return null;
  const p = o.prox, c = o.cruise; if (!p || !c || typeof p !== "object" || typeof c !== "object") return null;
  const px = frac(p.fx, NaN), py = frac(p.fy, NaN), cx = frac(c.fx, NaN), cy = frac(c.fy, NaN);
  return [px, py, cx, cy].some(Number.isNaN) ? null : { prox: { fx: px, fy: py }, cruise: { fx: cx, fy: cy } };
}

/**
 * 画面の使える範囲(片手操作の半面)に、巡航◎(上)と近接◎(下)を並べる。custom があれば、その位置(画面からはみ出さないよう補正)。
 * 巡航は従来どおり指を置いた場所が中心(フローティング)なので、◎は目安。近接は◎の中心が基準(固定)。
 * 横画面(412px高)でも2つの◎と上のボタン列(約56px)が重ならないように、半径は高さから決める。
 */
export function padLayout(w: number, h: number, mode: "right" | "left", custom: PadCustom | null = null, ins: Insets = NO_INSETS): PadLayout {
  const zoneLeft = mode === "right" ? w / 2 : 0, zoneRight = mode === "right" ? w : w / 2, zw = zoneRight - zoneLeft;
  const top = Math.min(60, h * 0.15) + ins.t, usable = h - top - 10 - ins.b;
  const r = clamp(Math.min(usable * 0.21, zw * 0.3), 36, 72), rc = r * 0.92, E = PADCFG.edgePx;
  const place = (p: PadPos, rr: number) => { // 保存値(右手基準) → 画面の中心。範囲内へ補正
    const fx = mode === "right" ? p.fx : 1 - p.fx;
    const lo = mode === "right" ? Math.max(w * PADCFG.minXFrac, ins.l + rr + E) : ins.l + rr + E, hi = mode === "right" ? w - ins.r - rr - E : Math.min(w * (1 - PADCFG.minXFrac), w - ins.r - rr - E);
    return { cx: clamp(fx * w, lo, Math.max(lo, hi)), cy: clamp(p.fy * h, top + rr * 0.9, Math.max(top + rr * 0.9, h - ins.b - rr - E)) };
  };
  let prox: PadRect, cruise: PadRect;
  if (custom) {
    const a = place(custom.prox, r), b = place(custom.cruise, rc); prox = { ...a, r }; cruise = { ...b, r: rc };
    const need = r + rc + PADCFG.gapPx, d = Math.hypot(cruise.cx - prox.cx, cruise.cy - prox.cy); // 2 つが重ならないように、巡航◎を離す
    if (d < need) { const ux = d > 1e-6 ? (cruise.cx - prox.cx) / d : 0, uy = d > 1e-6 ? (cruise.cy - prox.cy) / d : -1; cruise = { ...cruise, cx: prox.cx + ux * need, cy: prox.cy + uy * need }; const c2 = place({ fx: mode === "right" ? cruise.cx / w : 1 - cruise.cx / w, fy: cruise.cy / h }, rc); cruise = { ...cruise, ...c2 };
      if (Math.hypot(cruise.cx - prox.cx, cruise.cy - prox.cy) < need - 0.5) { const p2 = place({ fx: mode === "right" ? prox.cx / w : 1 - prox.cx / w, fy: (cruise.cy + need) / h }, r); prox = { ...prox, ...p2 }; } }
  } else {
    const cx = zoneLeft + zw * (mode === "right" ? PADCFG.inwardFrac : 1 - PADCFG.inwardFrac), proxCy = h - ins.b - r - PADCFG.bottomPx;
    prox = { cx, cy: proxCy, r }; cruise = { cx, cy: Math.max(top + rc * 0.9, proxCy - r - rc - PADCFG.gapPx), r: rc };
  }
  return { cruise, prox, split: prox.cy - prox.r - 1, zoneLeft, zoneRight };
}

/** 触れた場所が近接◎の側か。自分の側の半面の中で、縁までの距離が近いほうの◎(既定の配置では「split より下」と同じ)。それ以外の半面は巡航でも近接でもない */
export const inProxRegion = (L: PadLayout, x: number, y: number) => {
  if (x < L.zoneLeft || x > L.zoneRight) return false;
  return Math.hypot(x - L.prox.cx, y - L.prox.cy) - L.prox.r <= Math.hypot(x - L.cruise.cx, y - L.cruise.cy) - L.cruise.r;
};

/**
 * 近接◎のタッチ → 3次元の方向。
 *  ・中心からの距離で「どれだけ向きを変えるか」: 中心=変えない / 内側=小さく(距離に比例) / 環状=約90度 / 外側=約120度
 *  ・中心からの向き(画面の上下左右・斜め)で向き先: 左右→水平に曲がる、上→上昇、下→下降。斜めは両方
 *  ・基準は触れ始めの進行方向(refYaw)。指を動かしても基準は動かない
 */
export class ProxPad {
  active = false; id = -1; refYaw = 0; t = 0; x = 0; y = 0;
  private rect: PadRect = { cx: 0, cy: 0, r: 60 };
  /** defer 秒のあいだ(または指が14px以上動くまで)は指示を出さない: ◯のタップかどうかを決めるため */
  private defer = 0; private x0 = 0; private y0 = 0; private armed = true;
  down(id: number, x: number, y: number, rect: PadRect, refYaw: number, defer = 0) { this.active = true; this.id = id; this.rect = rect; this.refYaw = refYaw; this.t = 0; this.x = x; this.y = y; this.x0 = x; this.y0 = y; this.defer = defer; this.armed = defer <= 0; }
  move(x: number, y: number) { this.x = x; this.y = y; if (!this.armed && Math.hypot(x - this.x0, y - this.y0) > 14) this.armed = true; }
  up() { this.active = false; this.id = -1; }
  tick(dt: number) { if (this.active) { this.t += dt; if (!this.armed && this.t >= this.defer) this.armed = true; } }
  /** いまの指の位置 → 指示 */
  cmd(): ProxCmd | null {
    if (!this.active || !this.armed) return null;
    const { cx, cy, r } = this.rect, dx = this.x - cx, dy = this.y - cy, d = Math.hypot(dx, dy), f = d / r;
    let zone: ProxCmd["zone"], deg: number;
    if (f < PROX.centerFrac) { zone = "center"; deg = 0; }
    else if (f < PROX.innerFrac) { zone = "inner"; deg = PROX.innerMinDeg + (PROX.innerMaxDeg - PROX.innerMinDeg) * (f - PROX.centerFrac) / (PROX.innerFrac - PROX.centerFrac); }
    else if (f < PROX.ringFrac) { zone = "ring"; deg = PROX.ringDeg; }
    else { zone = "outer"; deg = PROX.outerDeg; }
    const phi = Math.atan2(dx, -dy);            // 画面の真上=0、右=+90度
    const yawOff = -deg * DEG * Math.sin(phi);   // 右へ曲がる = yaw が減る
    const pitch = clamp(deg * DEG * Math.cos(phi), -PROX.maxPitchDeg * DEG, PROX.maxPitchDeg * DEG);
    const down = zone !== "center" && Math.abs(wrap(phi - Math.PI)) <= PROX.restDownDeg * DEG;
    return { yaw: wrap(this.refYaw + yawOff), pitch, speed: zone === "center" ? PROX.holdSpeed : PROX.creepSpeed, center: zone === "center", down, held: this.t, zone };
  }
}
