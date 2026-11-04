import { check, suite } from "./harness";
import { at, world, inp } from "./common";
import { Flight, type FlightInput } from "../src/flight";
import { FlapAssist } from "../src/assist";
import { SteerPad, SteerLayer, STEER, type SteerMode } from "../src/steer";

// 仮想時計(ms)で指の動きを流し、SteerPad → SteerLayer → 操縦補助 → 飛行物理 を 60 Hz で回す閉ループ。実機の Input と同じ並び(main の readInput と同じ順)
const RECT = { cx: 700, cy: 330, r: 70 };
type Ev = { t: number; k: "down" | "move" | "up" | "cancel"; x?: number; y?: number };
const centre = (dx: number, dy: number) => ({ x: RECT.cx + dx * RECT.r, y: RECT.cy + dy * RECT.r });
export interface Run { f: Flight; pad: SteerPad; layer: SteerLayer; ys: number[]; vs: number[]; hs: number[]; brakeSeen: boolean; strokes0: number; maxCapped: number }
function sim(mode: SteerMode, evs: Ev[], secs: number, mk: () => Flight, opts: { stallAt?: [number, number]; ground?: boolean } = {}): Run {
  const f = mk(), pad = new SteerPad(), layer = new SteerLayer(), assist = new FlapAssist(); assist.enabled = true; pad.mode = mode;
  if (opts.stallAt) { const [s0, s1] = opts.stallAt; pad.stall = (a, b) => b - a - Math.max(0, Math.min(b, s1) - Math.max(a, s0)); } // 描画が固まった区間を引く
  let T = 1000, ei = 0; const out: Run = { f, pad, layer, ys: [], vs: [], hs: [], brakeSeen: false, strokes0: f.strokes, maxCapped: 0 }; let tapSeq = 0;
  evs = evs.map(e => ({ ...e, t: e.t + 1000 })).sort((a, b) => a.t - b.t);
  for (let i = 0; i < secs * 60; i++) {
    T += 1000 / 60;
    while (ei < evs.length && evs[ei].t <= T) { const e = evs[ei++]; if (e.k === "down") pad.down(1, e.x!, e.y!, e.t, RECT, f.yaw); else if (e.k === "move") pad.move(1, e.x!, e.y!, e.t); else if (e.k === "up") pad.up(1, e.t); else pad.cancel(); }
    pad.poll(T);
    const raw: FlightInput = inp(); raw.brake = pad.brake; while (tapSeq < pad.tapSeq) { tapSeq++; raw.flapTap = true; }
    layer.apply(f, raw, pad, 1 / 60, false, T);
    f.step(1 / 60, assist.apply(raw, f));
    out.ys.push(f.yaw); out.vs.push(f.speed); out.hs.push(f.pos.y); out.brakeSeen = out.brakeSeen || pad.brake;
  }
  return out;
}
const air = (speed = 10, y = 70) => () => at(0, y, 0, 0, speed);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const hold = (dx: number, dy: number, t0 = 0, ms = 1500, moveSteps = 4): Ev[] => { // 触れて、(動かして)、押し続け、離す
  const e: Ev[] = [{ t: t0, k: "down", ...centre(0, 0) }]; for (let i = 1; i <= moveSteps; i++) e.push({ t: t0 + 20 * i, k: "move", ...centre(dx * i / moveSteps, dy * i / moveSteps) });
  e.push({ t: t0 + ms, k: "up" }); return e;
};
const swipeOnly = (dx: number, dy: number) => hold(dx, dy, 0, 300); // A: スワイプして離す

export function h8SteerTests() {
  suite("H8-A: three single-◎ steering modes on one shared physics + assist layer");
  for (const m of ["A", "B", "C"] as SteerMode[]) {
    const ev = (dx: number, dy: number) => (m === "A" ? swipeOnly(dx, dy) : hold(dx, dy, 0, 1200));
    // 旋回(右/左): 触れ始めの進行方向から、右の指なら右へ(yaw が減る)。方向を変えても速さはほぼ保つ。急回転しない
    for (const [name, dx, sign] of [["right", 0.9, -1], ["left", -0.9, 1]] as const) {
      const r = sim(m, ev(dx, 0), 5, air());
      const d = wrap(r.ys[r.ys.length - 1] - 0), maxRate = Math.max(...r.ys.map((y, i) => i ? Math.abs(wrap(y - r.ys[i - 1])) * 60 : 0)), dv = Math.abs(r.vs[r.vs.length - 1] - 10);
      check(`${m}: finger ${name} -> turns ${name} (heading change ${(d * 180 / Math.PI).toFixed(0)} deg), smooth, speed kept`, Math.sign(d) === sign && Math.abs(d) > 0.5 && maxRate < 2.1 && dv < 3.5 && r.f.stun <= 0, `rate ${maxRate.toFixed(2)} rad/s, dv ${dv.toFixed(1)}`);
    }
    // 上下: 上=天、下=地
    { const up = sim(m, ev(0, -0.9), 4, air()), dn = sim(m, ev(0, 0.9), 4, air()), idle = sim(m, [], 4, air());
      check(`${m}: finger up climbs, down descends (relative to hands-off)`, up.hs[up.hs.length - 1] > idle.hs[idle.hs.length - 1] + 1.5 && dn.hs[dn.hs.length - 1] < idle.hs[idle.hs.length - 1] - 1.5, `up ${up.hs[239].toFixed(1)} idle ${idle.hs[239].toFixed(1)} down ${dn.hs[239].toFixed(1)}`); }
    // 斜め: 右上は右へ曲がりつつ上昇
    { const r = sim(m, ev(0.7, -0.7), 4, air()), idle = sim(m, [], 4, air()), d = wrap(r.ys[r.ys.length - 1]);
      check(`${m}: diagonal (right+up) turns right and climbs`, d < -0.3 && r.hs[239] > idle.hs[239] + 1, `yaw ${d.toFixed(2)} alt ${r.hs[239].toFixed(1)} vs ${idle.hs[239].toFixed(1)}`); }
    // 無操作: 直進・高度維持(既存の補助)。2 本指目は無視
    { const r = sim(m, [], 8, air()); check(`${m}: hands-off flies straight and does not drop (semi-auto)`, Math.abs(wrap(r.ys[479])) < 0.03 && r.hs[479] > 60 && r.vs[479] > 6, `yaw ${r.ys[479].toFixed(3)} alt ${r.hs[479].toFixed(1)} v ${r.vs[479].toFixed(1)}`); }
    // タップ: 羽ばたき。連打: 加速するが上限あり
    { const taps = (n: number, gap: number): Ev[] => Array.from({ length: n }, (_, i) => [{ t: i * gap, k: "down", ...centre(0, 0) } as Ev, { t: i * gap + 80, k: "up" } as Ev]).flat();
      const one = sim(m, taps(1, 300), 2, air(8)), many = sim(m, taps(8, 220), 8, air(8)), none = sim(m, [], 8, air(8));
      check(`${m}: a short tap flaps`, one.f.strokes > one.strokes0, `strokes ${one.f.strokes - one.strokes0}`);
      check(`${m}: repeated taps accelerate, within the speed cap`, Math.max(...many.vs) > Math.max(...none.vs) + 0.8 && Math.max(...many.vs) <= STEER.speedCap + 2.5 && many.layer.stats.chains >= 1, `max ${Math.max(...many.vs).toFixed(1)} vs idle ${Math.max(...none.vs).toFixed(1)} chains ${many.layer.stats.chains}`);
      check(`${m}: taps are not mistaken for swipes or brakes`, !many.brakeSeen && many.pad.tapSeq === 8, `taps ${many.pad.tapSeq}`); }
  }
  // 長押し/ブレーキ: 方式ごとの違い
  { const press = (dx: number, dy: number, ms: number): Ev[] => [{ t: 0, k: "down", ...centre(dx, dy) }, { t: ms, k: "up" }];
    for (const m of ["A", "B"] as SteerMode[]) { const r = sim(m, press(0, 0, 4500), 5, air()), free = sim(m, [], 5, air()); check(`${m}: a press without moving brakes (speed ${r.vs[299].toFixed(1)} vs ${free.vs[299].toFixed(1)})`, r.brakeSeen && r.vs[299] < free.vs[299] - 0.6); }
    { const c = sim("C", press(0, 0, 4500), 5, air()), p = sim("C", press(0.8, 0, 1500), 3, air()), free = sim("C", [], 5, air());
      check("C: pressing the centre brakes", c.brakeSeen && c.vs[299] < free.vs[299] - 0.6, `${c.vs[299].toFixed(1)} vs ${free.vs[299].toFixed(1)}`);
      check("C: holding the rim never brakes and keeps the heading target", !p.brakeSeen && wrap(p.ys[179]) < -0.5, `yaw ${p.ys[179].toFixed(2)}`); }
    // A: スワイプはブレーキにならない(押したまま動かす/ゆっくり長く動かす)。離す前に止まっても、スワイプとして確定
    { const r = sim("A", hold(0.9, 0, 0, 1800), 4, air()); check("A: a long slow swipe is never read as a brake", !r.brakeSeen && wrap(r.ys[239]) < -0.5, `yaw ${r.ys[239].toFixed(2)}`); }
    // B: 動かしたあと止まって一定時間でブレーキ。指の揺れ(<6px)や短い欠落では止まらない。固まった時間は数えない
    { const mv = (extra: Ev[]): Ev[] => [{ t: 0, k: "down", ...centre(0, 0) }, { t: 40, k: "move", ...centre(0.4, 0) }, { t: 80, k: "move", ...centre(0.8, 0) }, ...extra];
      const stopped = sim("B", mv([{ t: 1800, k: "up" }]), 3, air()); check("B: after moving, a finger that stays still brakes", stopped.brakeSeen);
      const jitter: Ev[] = []; for (let i = 0; i < 40; i++) jitter.push({ t: 100 + i * 50, k: "move", ...centre(0.8, 0), x: centre(0.8, 0).x + (i % 2 ? 3 : -3) });
      const j = sim("B", mv([...jitter, { t: 2400, k: "up" }]), 3.5, air()); check("B: a finger that only shakes (3 px) still counts as stopped (brakes)", j.brakeSeen);
      const slow: Ev[] = []; for (let i = 0; i < 12; i++) slow.push({ t: 100 + i * 120, k: "move", ...centre(0.8, (i % 2 ? 0.05 : -0.05) * (i + 1) / 2) });
      const s = sim("B", mv([...slow, { t: 1700, k: "up" }]), 3, air()); check("B: a finger that keeps moving (>6 px steps) never brakes", !s.brakeSeen);
      const stall = sim("B", mv([{ t: 1100, k: "up" }]), 2.5, air(), { stallAt: [1200, 2000] }); check("B: a long frame stall is not counted as the finger standing still", !stall.brakeSeen, "stall 200-1000 ms"); }
    // C: 周辺から中心へ入って押し続けるとブレーキ。出ればブレーキは解ける
    { const r = sim("C", [{ t: 0, k: "down", ...centre(0.8, 0) }, { t: 400, k: "move", ...centre(0, 0) }, { t: 1500, k: "up" }], 2.5, air()); check("C: moving into the centre and staying brakes", r.brakeSeen); }
    { const e: Ev[] = [{ t: 0, k: "down", ...centre(0, 0) }, { t: 500, k: "move", ...centre(0.8, 0) }, { t: 1500, k: "up" }]; const r = sim("C", e, 2.5, air()); check("C: leaving the centre releases the brake and steers", r.layer.stats.brakeFrames < 45 && wrap(r.ys[149]) < -0.2, `brake frames ${r.layer.stats.brakeFrames}`); }
  }
  // 描画が遅れて「離した」の到着が遅れ、先にブレーキが入ってしまっても、イベントの時刻で短ければタップ(長ければ長押し)
  for (const m of ["A", "B", "C"] as SteerMode[]) {
    const quick = new SteerPad(), slow = new SteerPad(); quick.mode = slow.mode = m;
    for (const [pad, upT] of [[quick, 1060], [slow, 1900]] as const) { pad.down(1, RECT.cx, RECT.cy, 1000, RECT, 0); pad.poll(1700); /* 処理が遅れて、先に 0.7 秒ぶん進んだ */ pad.up(1, upT); }
    check(`${m}: a late-delivered release still counts as a tap when its own timestamp says 60 ms (and a real 0.9 s press is not a tap)`, quick.tapSeq === 1 && slow.tapSeq === 0, `quick ${quick.tapSeq} slow ${slow.tapSeq}`);
  }
  // 地上: 同じ◎で向き直って前進歩行(後退しない)、上=小ジャンプ、タップ=羽ばたき(小ジャンプ)
  { const gnd = () => { const f = at(0, 0.5, 0, 0, 0); f.pos.y = world.heightAt(0, 0) + 0.32; f.mode = "landed"; f.vel.set(0, 0, 0); f.walkV = 0; f.prevPos.copy(f.pos); return f; };
    for (const m of ["A", "B", "C"] as SteerMode[]) {
      const w = sim(m, hold(0.5, 0.7, 0, 2500), 3, gnd); const fwd = (w.f.pos.x - 0) * -Math.sin(0) + (w.f.pos.z - 0) * -Math.cos(0);
      check(`${m}: on the ground a deflected finger turns and walks forward (never backward)`, w.f.mode === "landed" && Math.hypot(w.f.pos.x, w.f.pos.z) > 0.4 && Math.abs(wrap(w.f.yaw)) > 0.05, `moved ${Math.hypot(w.f.pos.x, w.f.pos.z).toFixed(2)} m yaw ${w.f.yaw.toFixed(2)}`); void fwd;
      const j = sim(m, hold(0, -0.9, 0, 400), 1.2, gnd); check(`${m}: finger up on the ground is a small jump`, j.hs.some(h => h > world.heightAt(0, 0) + 0.32 + 0.15) || j.f.hopping);
      const t = sim(m, [{ t: 0, k: "down", ...centre(0, 0) }, { t: 80, k: "up" }], 1.2, gnd); check(`${m}: a short tap on the ground flaps (small jump)`, t.hs.some(h => h > world.heightAt(0, 0) + 0.32 + 0.1) || t.f.hopping || t.f.mode === "air");
    }
  }
  // 自動着地の進入中は、方向の指示を使わず、大きな指の動きを手動の入力として渡す(取消に使える)
  { const f = at(0, 70, 0, 0, 10), pad = new SteerPad(), layer = new SteerLayer(); pad.mode = "A"; pad.down(1, ...Object.values(centre(0.9, 0)) as [number, number], 0, RECT, 0);
    const raw = inp(); layer.apply(f, raw, pad, 1 / 60, true, 0); check("auto-landing: the finger passes through as a plain stick (so the existing cancel works)", Math.abs(raw.x) > 0.5 && layer.yawT === null, `x ${raw.x.toFixed(2)}`); }
  // 速さの異常な変化(ワープ・急停止)がない
  { const r = sim("B", hold(0.9, -0.5, 0, 2000), 6, air()); check("no warp or instant stop (speed change per step stays small)", r.layer.stats.speedJumps === 0 && r.layer.stats.maxYawRate < 2.2, `jumps ${r.layer.stats.speedJumps} max yaw rate ${r.layer.stats.maxYawRate.toFixed(2)}`); }
}
