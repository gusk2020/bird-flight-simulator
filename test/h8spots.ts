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
