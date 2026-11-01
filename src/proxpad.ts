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
export interface PadLayout { cruise: PadRect; prox: PadRect; /** これより下で触れ始めたら近接、上なら巡航 */ split: number; zoneLeft: number; zoneRight: number }

const DEG = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * 画面の使える範囲(片手操作の半面)に、巡航◎(上)と近接◎(下)を縦に並べる。
 * 巡航は従来どおり指を置いた場所が中心(フローティング)なので、◎は目安。近接は◎の中心が基準(固定)。
 * 横画面(412px高)でも2つの◎と上のボタン列(約56px)が重ならないように、半径は高さから決める。
 */
export function padLayout(w: number, h: number, mode: "right" | "left"): PadLayout {
  const zoneLeft = mode === "right" ? w / 2 : 0, zoneRight = mode === "right" ? w : w / 2, cx = (zoneLeft + zoneRight) / 2;
  const top = Math.min(60, h * 0.15), usable = h - top - 10;
  const r = clamp(Math.min(usable * 0.21, (zoneRight - zoneLeft) * 0.3), 36, 72);
  const proxCy = h - r - 14, cruiseCy = top + (proxCy - r - 10 - top) / 2 + 2;
  return { cruise: { cx, cy: Math.max(top + r * 0.9, cruiseCy), r: r * 0.92 }, prox: { cx, cy: proxCy, r }, split: proxCy - r - 12, zoneLeft, zoneRight };
}

/** 触れた場所が近接◎の領域か(それ以外の半面は巡航) */
export const inProxRegion = (L: PadLayout, x: number, y: number) => y >= L.split && x >= L.zoneLeft && x <= L.zoneRight;

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
