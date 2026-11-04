import { check, suite } from "./harness";
import { SurfaceIndex } from "../src/perches";
import { LandSpots, SPOTS, type SpotFrame } from "../src/landspots";
import { L, world } from "./common";
import { buildSurfaces } from "../src/perches";

// 針穴カメラ(水平画角 約 60°・縦横比 892:412)で、鳥の後ろ上から進行方向を見る。実機の三人称カメラと同じ並び(鳥の 7 m 後ろ・3 m 上)
const W = 892, H = 412;
function frame(bx: number, by: number, bz: number, yaw: number, t = 0, heightAt: (x: number, z: number) => number = () => 0): SpotFrame {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), cx = bx - fx * 7, cz = bz - fz * 7, cy = by + 3;
  const tanV = Math.tan(0.5), tanH = tanV * (W / H), pitch = -0.1;
  return { bx, by, bz, fx, fz, feetY: by - 0.32, cx, cy, cz, w: W, h: H, t, heightAt,
    project: (x, y, z, out) => { const rx = x - cx, ry = y - cy, rz = z - cz, fw = rx * fx + rz * fz, side = rx * fz - rz * fx; // side > 0: 右
      const up = ry * Math.cos(pitch) - fw * Math.sin(pitch), depth = fw * Math.cos(pitch) + ry * Math.sin(pitch);
      if (depth < 0.1) { out.x = out.y = 0; out.z = 1.1; return; } out.x = (side / depth) / tanH; out.y = (up / depth) / tanV; out.z = 0.5; } };
}
const mkIdx = (specs: [string, number, number, number, number, number][]) => { const idx = new SurfaceIndex(); for (const [k, x, z, hw, hd, top] of specs) idx.add(k as never, x - hw, x + hw, z - hd, z + hd, top); return idx; };

export function h8SpotTests() {
  suite("H8-B: landing spots - every landable perch in view is marked, individually");
  // --- 発見: 前方の視界内の足場を全部。件数に上限はない。早く(遠くから)見つかる
  { const idx = mkIdx([["roof", 0, -20, 4, 4, 8], ["bench", 3, -14, 0.4, 0.8, 0.5], ["sign", -4, -30, 0.3, 0.3, 4], ["pole", 6, -38, 0.2, 0.2, 6], ["rock", -8, -25, 1, 1, 1.2], ["fence", 10, -22, 0.3, 3, 1.1]]);
    const sp = new LandSpots(idx); sp.update(frame(0, 8, 0, 0), true);
    check("all six perches ahead are listed (no top-N cut), each with its own surface id", sp.list.length === 6 && new Set(sp.list.map(q => q.id)).size === 6, sp.list.map(q => q.kind + q.id).join(","));
    check("a perch 38 m ahead is found early (the old single marker appeared only when near)", !!sp.list.find(q => q.kind === "pole"));
    check("listed nearest first", sp.list.every((q, i) => i === 0 || sp.list[i - 1].d <= q.d));
    check("perches beyond the auto-landing reach are drawn but marked not near (a tap there is refused with a reason); a perch within reach is near", !sp.list.find(q => q.kind === "sign")!.near && !sp.list.find(q => q.kind === "pole")!.near && sp.list.find(q => q.kind === "bench")!.near === true, sp.list.map(q => q.kind + ":" + q.near).join(" "));
    const hi = new LandSpots(mkIdx([["roof", 0, -14, 4, 4, 14]])); hi.update(frame(0, 8, 0, 0), true); check("a perch far above the bird is shown but not near", hi.list.length === 1 && !hi.list[0].near); }
  // --- 通過後・視界外: すぐ消す。5 秒の残像なし。選択も解く
  { const idx = mkIdx([["bench", 0, -12, 0.4, 0.8, 0.5], ["roof", 40, -12, 4, 4, 8]]); const sp = new LandSpots(idx);
    sp.update(frame(0, 6, 0, 0, 0), true); const id = sp.list.find(q => q.kind === "bench")!.id; check("ahead: shown", !!sp.get(id));
    const px = sp.get(id)!.dx, py = sp.get(id)!.dy; sp.pressedId = id; check("press captures the id", sp.pressedId === id && sp.pick(px, py)!.id === id);
    sp.update(frame(0, 6, -13, 0, 0.1), true); check("passed (behind the bird): gone in that very frame, and the selection is released", !sp.get(id) && sp.pressedId === -1, `shown ${sp.list.length}`);
    check("a passed candidate is never valid for a late tap", !sp.valid(id, 0.2));
    const sp2 = new LandSpots(idx); sp2.update(frame(0, 6, 0, 0, 0), true); const id2 = sp2.list.find(q => q.kind === "roof")?.id;
    sp2.update(frame(0, 6, 0, Math.PI / 2, 0.1), true); check("turned away: candidates out of the view are removed", sp2.list.length === 0 || !sp2.get(id2 ?? -9)); }
  // --- 画面の縁のちらつき: いったん見えた目印は、少しはみ出すまで消えない
  { const idx = mkIdx([["bench", 12.5, -25, 0.4, 0.8, 0.5]]); const sp = new LandSpots(idx); let flips = 0, last = false;
    for (let i = 0; i < 60; i++) { sp.update(frame(i * 0.01, 6, 0, 0, i / 60), true); const v = sp.list.length > 0; if (i && v !== last) flips++; last = v; }
    check("at the screen edge, a small drift does not make the marker blink on and off", flips <= 1, `flips ${flips}`); }
  // --- 重複の整理: 同じ構造物(ベランダの床と手すり)は 1 つ
  { const idx = mkIdx([["balcony", 0, -15, 1.5, 1, 3], ["rail", 0, -15.4, 1.5, 0.1, 3.9], ["bench", 4, -15, 0.4, 0.8, 3.1]]); const sp = new LandSpots(idx); sp.update(frame(0, 6, 0, 0), true);
    check("a balcony floor and its railing (same spot) are one marker; the bench beside it stays", sp.list.length === 2 && sp.stats.merged >= 1, sp.list.map(q => q.kind).join(",")); }
  // --- 重なり: 画面上で重なる目印は、ずらして別々に押せる。名前で見分ける
  { const idx = mkIdx([["bench", 0, -15, 0.4, 0.8, 0.5], ["wall", 0.3, -17, 0.4, 2, 0.5], ["rock", -0.2, -19, 0.6, 0.6, 0.5]]); const sp = new LandSpots(idx);
    for (let i = 0; i < 40; i++) sp.update(frame(0, 8, 0, 0, i / 60), true);
    const ds: number[] = []; for (let i = 0; i < sp.list.length; i++) for (let j = i + 1; j < sp.list.length; j++) ds.push(Math.hypot(sp.list[i].dx - sp.list[j].dx, sp.list[i].dy - sp.list[j].dy));
    check("three markers that coincide on screen are spread apart (>= 0.9 x the separation) and flagged stacked", sp.list.length === 3 && Math.min(...ds) >= SPOTS.sepPx * 0.9 && sp.list.every(q => q.stacked), `min ${Math.min(...ds).toFixed(1)}`);
    check("none is moved further than the allowed shift from its true position", sp.list.every(q => Math.hypot(q.dx - q.x, q.dy - q.y) <= SPOTS.shiftPx + 1.5));
    // 狙った候補が正しく選ばれる: それぞれの表示位置を押すと、その候補
    check("pressing each displayed marker selects exactly that perch", sp.list.every(q => sp.pick(q.dx, q.dy)!.id === q.id));
    const a = sp.list[0], b = sp.list[1], mx = (a.dx * 0.7 + b.dx * 0.3), my = (a.dy * 0.7 + b.dy * 0.3); check("a press between two markers picks the nearer one", sp.pick(mx, my)!.id === a.id); }
  // --- 押している間に目印が動いても別の候補にならない(ID を押した瞬間に確定)。去ったら無効
  { const idx = mkIdx([["bench", 0, -15, 0.4, 0.8, 0.5], ["sign", 1.2, -15.5, 0.3, 0.3, 0.6]]); const sp = new LandSpots(idx); for (let i = 0; i < 30; i++) sp.update(frame(0, 6, -i * 0.05, 0, i / 60), true);
    const a = sp.list[0]; const id = sp.pick(a.dx, a.dy)!.id; sp.pressedId = id; for (let i = 30; i < 60; i++) sp.update(frame(0.3, 6, -i * 0.08, 0, i / 60), true);
    check("the pressed id stays the pressed id while the markers move", sp.pressedId === id && sp.valid(id, 1)); }
  // --- 遮蔽: 間に高い建物があれば出さない
  { const idx = mkIdx([["bench", 0, -30, 0.4, 0.8, 0.5]]); const tall = (x: number, z: number) => (Math.abs(x) < 6 && z < -12 && z > -16 ? 30 : 0);
    const sp = new LandSpots(idx); sp.update(frame(0, 6, 0, 0, 0, tall), true); const sp2 = new LandSpots(idx); sp2.update(frame(0, 6, 0, 0, 0), true);
    check("a perch hidden behind a tall building is not marked (the same perch in the open is)", sp.list.length === 0 && sp2.list.length === 1 && sp.stats.occluded >= 1); }
  // --- ON/OFF
  { const idx = mkIdx([["bench", 0, -12, 0.4, 0.8, 0.5]]); const sp = new LandSpots(idx); sp.update(frame(0, 6, 0, 0), true); sp.pressedId = sp.list[0].id;
    sp.setEnabled(false); check("OFF clears every marker and the selection at once", sp.list.length === 0 && sp.pressedId === -1);
    sp.update(frame(0, 6, 0, 0, 1), true); check("OFF stays empty", sp.list.length === 0); sp.setEnabled(true); sp.update(frame(0, 6, 0, 0, 2), true); check("ON again shows them", sp.list.length === 1);
    sp.update(frame(0, 6, 0, 0, 3), false); check("inactive (landed / auto flight / stunned): no markers", sp.list.length === 0); }
  // --- 本物の街: 密集地で複数の種類が出る。ID は Surface.id と一致。上限なし
  { const idx = buildSurfaces(L); const sp = new LandSpots(idx); let best = 0, kinds = 0, dups = 0;
    for (const [x, z] of [[0, 40], [30, 0], [-30, 20], [0, -40], [60, 60], [-60, -30]]) for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) { sp.update(frame(x, 14, z, yaw, 0, world.heightAt), true); if (sp.list.length > best) { best = sp.list.length; kinds = new Set(sp.list.map(q => q.kind)).size; } if (new Set(sp.list.map(q => q.id)).size !== sp.list.length) dups++; }
    check("real town: many candidates are shown at once, of several kinds, never a duplicate id", best >= 8 && kinds >= 3 && dups === 0, `max ${best} markers, ${kinds} kinds`);
    check("every listed marker is a real surface with the same id", sp.list.every(q => idx.all[q.id] === q.s)); }
}

import { Approach, APPROACH } from "../src/approach";
import { AUTOLAND } from "../src/autoland";
import { Flight } from "../src/flight";
export function h8cTests() {
  suite("H8-C: speed-based look-ahead and the approach target");
  // --- 先読み: 速いほど遠くの目印が見つかる。下限 45 m・上限 90 m
  { const idx = mkIdx([["pole", 0, -70, 0.2, 0.2, 6], ["pole", 3, -30, 0.2, 0.2, 6], ["pole", -3, -100, 0.2, 0.2, 6]]);
    const at = (v: number) => { const sp = new LandSpots(idx); sp.update({ ...frame(0, 8, 0, 0), speed: v }, true); return { n: sp.list.length, R: sp.rangeNow }; };
    const s6 = at(6), s10 = at(10), s14 = at(14);
    check("look-ahead range = clamp(speed x 7 s, 45 m, 90 m): slow 45 m, 10 m/s 70 m, fast 90 m", s6.R === SPOTS.range && Math.abs(s10.R - 70) < 1e-9 && s14.R === SPOTS.rangeMax, JSON.stringify({ s6, s10, s14 }));
    check("a perch 70 m ahead is marked at 10 m/s (not at 6 m/s); 100 m ahead is out even at the maximum", s10.n === 2 && s6.n === 1 && s14.n === 2, JSON.stringify({ s6, s10, s14 })); }
  // --- 去った理由の記録
  { const idx = mkIdx([["bench", 0, -12, 0.4, 0.8, 0.5], ["bench", 60, -12, 0.4, 0.8, 0.5]]); const sp = new LandSpots(idx);
    sp.update({ ...frame(0, 6, 0, 0, 0), speed: 8 }, true); const id = sp.list[0].id; sp.update({ ...frame(0, 6, -13, 0, 0.1), speed: 8 }, true);
    check("the reason a candidate vanished is recorded (behind)", sp.goneWhy(id) === "behind", String(sp.goneWhy(id))); }
  // --- 接近先: 遠い目印を選ぶ → 届く範囲に入るまで待つ → 範囲に入ったら安全検査をして始める。去ったら解除。手動操作中は操舵しない
  { const idx = mkIdx([["pole", 0, -60, 0.2, 0.2, 6]]); const s = idx.all[0]; const ap = new Approach(); const f = new Flight({ colliders: [], heightAt: () => 0, perchAt: () => null, perchPoint: () => null, wireDir: () => null, waterAt: () => false } as never);
    f.pos.set(0, 10, 0); f.vel.set(0, 0, -10); f.yaw = 0; ap.select(0, 0);
    let started = 0; const start = () => { started++; return true; };
    check("far (60 m): waits, no start attempt", ap.update(0.1, { s, d: 60, near: false }, null, start, () => "") === "waiting" && started === 0);
    check("inside the auto-landing reach: the existing start is attempted (and the approach ends as started)", ap.update(1, { s, d: AUTOLAND.maxRange - 1, near: true }, null, start, () => "") === "started" && started === 1 && !ap.active);
    ap.select(0, 2); check("the candidate vanished (offscreen): the selection is released, not left waiting", ap.update(2.1, null, "offscreen", start, () => "") === "cleared" && !ap.active && ap.stats.goneBy.offscreen === 1);
    ap.select(0, 3); let t = 3; let r = "waiting"; for (let i = 0; i < 30 && r === "waiting"; i++) { t += 0.2; r = ap.update(t, { s, d: 15, near: true }, null, () => false, () => "dangerous path"); }
    check("refused for a safety reason for 1.5 s: it gives up with that reason (no unsafe start)", r === "cleared" && ap.lastReason === "refused:dangerous path", ap.lastReason);
    ap.select(0, 10); r = "waiting"; t = 10; for (let i = 0; i < 20; i++) { t += 0.2; r = ap.update(t, { s, d: 40, near: false }, null, () => true, () => "too far"); } check("farther than the reach it keeps waiting (never starts early)", r === "waiting");
    ap.select(0, 20); check("times out after the maximum approach time", ap.update(20 + APPROACH.maxS + 1, { s, d: 40, near: false }, null, start, () => "") === "cleared" && ap.stats.timeout === 1);
    // 操舵: 目標が右にあれば右へ(x>0)、手動の入力があれば足さない、速さが足りなければ上昇を指示しない、近いと減速
    const raw = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false }; const right = { ...s, minX: 20, maxX: 20.4, minZ: -40, maxZ: -39.6, top: 12 } as typeof s;
    ap.select(0, 30); for (let i = 0; i < 30; i++) { raw.x = 0; raw.y = 0; raw.brake = false; ap.steer(f, raw, right, 1 / 60); }
    check("target to the right: steers right (x > 0) smoothly", raw.x > 0.05 && raw.x <= 1, `x ${raw.x.toFixed(2)}`);
    check("target above the bird at low speed: no climb command (no stall)", (() => { const g = new Flight({ colliders: [], heightAt: () => 0, perchAt: () => null, perchPoint: () => null, wireDir: () => null, waterAt: () => false } as never); g.pos.set(0, 10, 0); g.vel.set(0, 0, -8); g.yaw = 0; g.speed = 8; const rr = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false }; const hi = { ...s, minX: 0, maxX: 0.4, minZ: -30, maxZ: -29.6, top: 25 } as typeof s; const a2 = new Approach(); a2.select(0, 0); for (let i = 0; i < 30; i++) { rr.y = 0; a2.steer(g, rr, hi, 1 / 60); } return rr.y <= 0.001; })());
    const man = { x: 0.8, y: 0, flapHeld: false, flapTap: false, brake: false }; const lx = man.x; ap.steer(f, man, right, 1 / 60); check("manual stick input present: the approach adds no steering", Math.abs(man.x - lx) < 0.12, `x ${man.x.toFixed(2)}`);
    const fast = new Flight({ colliders: [], heightAt: () => 0, perchAt: () => null, perchPoint: () => null, wireDir: () => null, waterAt: () => false } as never); fast.pos.set(0, 10, 0); fast.vel.set(0, 0, -13); fast.yaw = 0; fast.speed = 13; const rb = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false }; ap.steer(fast, rb, { ...s, minX: 0, maxX: 0.4, minZ: -30, maxZ: -29.6, top: 8 } as typeof s, 1 / 60);
    check("fast and within 40 m: the ordinary brake input is used (speed above the limit)", rb.brake === true); }
}

import { SpotConfirm, CONFIRM } from "../src/spotconfirm";
export function h8dTests() {
  suite("H8-D: confirmation only when a tap could be mistaken for another candidate");
  const mk = (specs: [string, number, number, number, number, number][], steps = 40) => { const idx = mkIdx(specs); const sp = new LandSpots(idx); for (let i = 0; i < steps; i++) sp.update({ ...frame(0, 8, -i * 0.01, 0, i / 60), speed: 8 }, true); return sp; };
  // 孤立した目印: 近くに別の目印がなく、1 タップで始まる(確認なし)
  { const sp = mk([["bench", 0, -14, 0.4, 0.8, 0.5], ["pole", 12, -40, 0.2, 0.2, 6]]); const a = sp.list.find(q => q.kind === "bench")!;
    check("an isolated marker is not risky: one tap, no confirmation", !sp.assess(a.dx, a.dy, a).risky && sp.assess(a.dx, a.dy, a).neighbors === 0); }
  const mv = (specs: [string, number, number, number, number, number][], v: number) => { const idx = mkIdx(specs); const sp = new LandSpots(idx); for (let i = 0; i < 60; i++) sp.update({ ...frame(0, 8, -i * v / 60, 0, i / 60), speed: v }, true); return sp; };
  // 遠い(35 m 超)密集: H8-B のずらしでも 30 px 前後までしか離せないので、止まっていても確認を求める
  { const far = mv([["bench", 0, -40, 0.4, 0.8, 0.5], ["wall", 0.3, -42, 0.4, 2, 0.5], ["rock", -0.2, -44, 0.6, 0.6, 0.5]], 0.001);
    check("a far (> 35 m) stack of three markers is risky even when nothing moves (they cannot be spread beyond ~30 px)", far.list.length === 3 && far.list.every(q => far.assess(q.dx, q.dy, q).risky), far.list.map(q => q.kind + ":" + q.d.toFixed(0)).join(" ")); }
  // 近くて、ある程度離れている目印: 動いていても確認なし(過剰な確認を避ける)
  { const near = mv([["bench", 0, -20, 0.4, 0.8, 0.5], ["pole", 9, -26, 0.2, 0.2, 5]], 12); const a = near.list.find(q => q.kind === "bench")!;
    check("two well-separated close markers are not risky even in fast flight (no needless confirmation)", near.list.length === 2 && !near.assess(a.dx, a.dy, a).risky, `gap ${Math.hypot(near.list[0].dx - near.list[1].dx, near.list[0].dy - near.list[1].dy).toFixed(0)} px`); }
  // 確認の時間が残らない目印は確認を求めない(押しても確認前に消える): 遠く正面で落ち着いた目印は去らない、鳥の真横に迫った目印は去る
  { const calm = mv([["bench", 0, -40, 0.4, 0.8, 0.5]], 9), c = calm.list[0]; const soon = mv([["bench", 0, -8, 0.4, 0.8, 0.5]], 12), sn = soon.list[0];
    check("a calm marker far ahead does not leave within the confirm window; one about to pass the bird does", !!c && !calm.leavesSoon(c) && (!sn || soon.leavesSoon(sn)), `calm ${c ? calm.leavesSoon(c) : "-"} soon ${sn ? soon.leavesSoon(sn) : "none(already gone)"}`); }
  // assess() が、独立に計算した規則(触れた点の近くに別の候補の現在位置/軌跡があるか)と、街の実データの無数の押し方で一致する
  { const idx = buildSurfaces(L), sp = new LandSpots(idx); let agree = 0, tot = 0, risky = 0;
    for (const [x, z, yaw, v] of [[30, 0, Math.PI / 2, 9], [0, 40, 0, 12], [-30, 20, Math.PI, 7]] as const) { for (let i = 0; i < 40; i++) sp.update({ ...frame(x, 14, z - i * v / 60 * Math.cos(yaw), yaw, i / 60, world.heightAt), speed: v }, true);
      for (const q of sp.list) for (const [ox, oy] of [[0, 0], [10, 6], [-20, 12], [30, -8]]) { const tx = q.dx + ox, ty = q.dy + oy; const r = sp.assess(tx, ty, q); risky += r.risky ? 1 : 0; tot++;
        const tr = q.trail, last = tr[tr.length - 1]; let dr = 0; if (last) for (const p of tr) if (last.t - p.t <= SPOTS.driftS + 1e-6) dr = Math.max(dr, Math.hypot(last.x - p.x, last.y - p.y));
        let n = 0; for (const j of sp.list) { if (j.id === q.id) continue; const dn = Math.hypot(tx - j.dx, ty - j.dy); let dj = dn; for (const p of j.trail) dj = Math.min(dj, Math.hypot(tx - p.x, ty - p.y)); const fe = q.d > SPOTS.farM || j.d > SPOTS.farM ? SPOTS.riskFarPx : 0; if (dn <= SPOTS.staticPx + fe * 0.5 || (dr >= SPOTS.driftPx && dj <= SPOTS.riskPx + fe)) n++; }
        if ((n > 0 && !sp.leavesSoon(q)) === r.risky) agree++; } }
    check("assess() agrees with an independent computation of the rule on real-town touches", tot > 40 && agree === tot, `${agree}/${tot} agree; ${risky} risky`); }
  // 仮選択の状態管理
  { const c = new SpotConfirm(); c.ask(3, 0); check("ask pre-selects an id", c.active && c.id === 3 && c.stats.asked === 1);
    c.ask(5, 100); check("asking another id re-selects (counted), only one pre-selection exists", c.id === 5 && c.stats.reselected === 1);
    check("the pre-selection expires after the timeout", c.update(100 + CONFIRM.timeoutMs + 1, true, null) && !c.active && c.stats.timeout === 1);
    c.ask(7, 0); check("a candidate that left the view releases it with the reason recorded", c.update(10, false, "behind") && !c.active && c.stats.goneBy.behind === 1);
    c.ask(8, 0); c.clear("off"); c.ask(9, 0); c.clear("manual"); c.ask(10, 0); c.clear("mode"); c.ask(11, 0); c.clear("confirmed"); c.ask(12, 0); c.clear("cancelled");
    check("OFF / manual input / mode change / confirmation / cancel are counted separately", c.stats.off === 1 && c.stats.manual === 1 && c.stats.mode === 1 && c.stats.confirmed === 1 && c.stats.cancelled === 1); }
}
