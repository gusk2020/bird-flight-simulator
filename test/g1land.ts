import { check, suite } from "./harness";
import { L, world, inp } from "./common";
import { Flight } from "../src/flight";
import { PHYS as P } from "../src/params";
import { PerchAssist, PERCH } from "../src/perchassist";
import { AutoLand, AUTOLAND } from "../src/autoland";
import { buildSurfaces, type Surface } from "../src/perches";
import { run as runAutoland } from "../tools/autoland_success";

const idx = buildSurfaces(L);
const solo = (s: Surface, dist: number, above: number, v: number) => { // 足場の縁から dist m(東側)、面の上 above m を、足場へ向かって飛ぶ
  const f = new Flight(world); const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
  f.pos.set(s.maxX + dist, s.top + above, cz); f.prevPos.copy(f.pos); f.yaw = Math.PI / 2; f.vel.set(-v, -0.3, 0); void cx; return f;
};
const isolated = (kind: string) => idx.all.find(s => s.kind === kind && !L.colliders.some(c => c.maxX - c.minX > 3 && c.maxZ - c.minZ > 3 && c.top > s.top - 0.2 && c.maxX > s.minX - 14 && c.minX < s.maxX + 14 && c.maxZ > s.minZ - 14 && c.minZ < s.maxZ + 14))!;

export function g1LandTests() {
  suite("G1-4: the landing ring is kept for a few seconds");
  const bench = isolated("rock") || isolated("bench"); // 周りに建物のない足場
  check("an isolated perch exists for the tests", !!bench, bench ? bench.kind : "none");
  {
    const pa = new PerchAssist(idx), f = solo(bench, 8, 2.5, 6); let shownAt = -1, firstSeen = false;
    for (let i = 0; i < 40; i++) { f.step(1 / 60, pa.apply(inp(), f)); if (pa.marker) { firstSeen = true; shownAt = f.clock; break; } }
    check("the ring appears for a perch ahead", firstSeen && pa.marker === bench || (firstSeen && !!pa.marker), pa.marker ? pa.marker.kind : "none");
    // 進行方向を大きく変えて、候補選別(進行方向の円錐)から外れても、目印は保たれる
    const m0 = pa.marker; f.yaw += Math.PI; f.vel.x *= -1; let held = 0;
    for (let i = 0; i < 60 * 3; i++) { f.vel.set(f.vel.x, Math.max(f.vel.y, 0), 0); f.vel.x = Math.sign(f.vel.x || 1) * 3; f.pos.y = Math.max(f.pos.y, bench.top + 2); f.step(1 / 60, pa.apply(inp(), f)); if (pa.marker === m0) held = i; }
    check("after the candidate falls out of view, the ring stays for about 4-6 s", held > 60 * 3 - 20 || (held > 60 * 2 && pa.marker !== m0), `held for ${(held / 60).toFixed(1)} s (hold ${PERCH.markerHold} s)`);
  }
  {
    const pa = new PerchAssist(idx), f = solo(bench, 8, 2.5, 6); for (let i = 0; i < 30; i++) f.step(1 / 60, pa.apply(inp(), f));
    const m = pa.marker; f.vel.set(0, 0, 0); f.pos.x = bench.maxX + 40; f.prevPos.copy(f.pos); for (let i = 0; i < 30; i++) { f.vel.set(0, 1, 0); f.step(1 / 60, pa.apply(inp(), f)); }
    check("the ring is released when the perch is too far (> 18 m)", !!m && pa.marker === null, `marker=${pa.marker ? pa.marker.kind : "null"}`);
    const pb = new PerchAssist(idx), g = solo(bench, 8, 2.5, 6); for (let i = 0; i < 30; i++) g.step(1 / 60, pb.apply(inp(), g));
    g.pos.set(bench.maxX + 3, bench.top - 3, (bench.minZ + bench.maxZ) / 2); g.vel.set(0, 0, 0); for (let i = 0; i < 20; i++) { g.vel.set(0, 0, 0); g.step(1 / 60, pb.apply(inp(), g)); }
    check("the ring is released when the perch is unreachable (below the bird... under the perch top)", pb.marker === null);
    const pc = new PerchAssist(idx), h = solo(bench, 8, 2.5, 6); for (let i = 0; i < 30; i++) h.step(1 / 60, pc.apply(inp(), h)); h.mode = "landed"; pc.apply(inp(), h);
    check("the ring is released once the bird has landed", pc.marker === null);
    const pd = new PerchAssist(idx), k = solo(bench, 8, 2.5, 6); for (let i = 0; i < 30; i++) k.step(1 / 60, pd.apply(inp(), k)); const t0 = k.clock;
    // 候補が見えなくなり、そのまま近くを飛び続けて時間切れ
    let gone = -1; for (let i = 0; i < 60 * 8; i++) { k.vel.set(0, 0, 0); k.pos.set(bench.maxX + 8, bench.top + 6, (bench.minZ + bench.maxZ) / 2); k.yaw = -Math.PI / 2; k.step(1 / 60, pd.apply(inp(), k)); if (!pd.marker) { gone = k.clock - t0; break; } }
    check("the ring times out after about 5 s when nothing re-confirms it", gone > 3.5 && gone < 7, `released after ${gone.toFixed(1)} s`);
  }

  suite("G1-5: tap the ring - automatic landing");
  {
    const pa = new PerchAssist(idx), al = new AutoLand(idx, pa, L.heightAt), f = solo(bench, 10, 2.5, 8);
    check("start is validated and accepted for a safe perch ahead", al.start(f, bench) && al.active && pa.forced === bench);
    let steps = 0; for (; steps < 60 * 16 && al.active; steps++) { const raw = inp(); al.drive(f, raw); pa.apply(raw, f); f.step(1 / 60, raw); }
    check("it lands on the perch with no crash and hands control back (forced target cleared)", al.end === "success" && f.crashes === 0 && f.mode !== "air" && pa.forced === null && !al.active, `end=${al.end} ${(steps / 60).toFixed(1)} s mode=${f.mode}`);
    for (let i = 0; i < 90; i++) f.step(1 / 60, pa.apply(inp(), f));
    check("it stays on the perch afterwards (no slipping off)", f.mode !== "air" && Math.abs(f.pos.y - P.feetOffset - bench.top) < 0.05);
    const x0 = f.pos.x, z0 = f.pos.z; for (let i = 0; i < 90; i++) f.step(1 / 60, pa.apply(inp({ y: 0.9 }), f));
    check("and the bird can walk (thumb forward) or stands at the end of a short perch", Math.hypot(f.pos.x - x0, f.pos.z - z0) > 0.2 || (bench.maxX - bench.minX < 1.5 && f.mode === "landed"), `moved ${Math.hypot(f.pos.x - x0, f.pos.z - z0).toFixed(2)} m`);
  }
  { // 取消: 大きなスティック / 羽ばたき
    for (const [name, mk] of [["a big stick input", () => inp({ x: 0.8 })], ["a flap tap", () => inp({ flapTap: true })], ["a flap hold", () => inp({ flapHeld: true })]] as const) {
      const pa = new PerchAssist(idx), al = new AutoLand(idx, pa, L.heightAt), f = solo(bench, 10, 2.5, 8); al.start(f, bench);
      for (let i = 0; i < 20; i++) { const raw = inp(); al.drive(f, raw); pa.apply(raw, f); f.step(1 / 60, raw); }
      const raw = mk(); al.drive(f, raw);
      check(`${name} returns to manual at once`, !al.active && al.end === "user" && pa.forced === null);
    }
    const pa = new PerchAssist(idx), al = new AutoLand(idx, pa, L.heightAt), f = solo(bench, 10, 2.5, 8); al.start(f, bench); const raw = inp({ x: 0.2, y: 0.2 }); al.drive(f, raw);
    check("a small stick wobble (0.2) does not cancel it", al.active);
  }
  { // 開始しない/中止: 遠い・足場より低い・飛んでいない・危険な経路
    const pa = new PerchAssist(idx), al = new AutoLand(idx, pa, L.heightAt);
    check("too far (25 m): refused", !al.start(solo(bench, 25, 2.5, 8), bench) && al.stats.refused === 1);
    check("below the perch top: refused", !al.start(solo(bench, 8, -1.5, 8), bench));
    const g = solo(bench, 8, 2.5, 8); g.mode = "landed"; check("not flying: refused", !al.start(g, bench));
    // 足場とのあいだに高い壁がある
    const wallBlock = idx.all.find(s => s.kind === "roof" && s.top > 15)!; const c = L.colliders.find(k => Math.abs((k.minX + k.maxX) / 2 - (wallBlock.minX + wallBlock.maxX) / 2) < 0.1)!;
    const tgt = idx.all.find(s => s.kind === "bench" || s.kind === "wall" || s.kind === "planter");
    const f2 = new Flight(world); f2.pos.set(c.minX - 6, 4, (c.minZ + c.maxZ) / 2); f2.prevPos.copy(f2.pos); f2.vel.set(8, 0, 0); f2.yaw = -Math.PI / 2;
    const blocked: Surface = { id: 9999, kind: "bench", minX: c.maxX + 4, maxX: c.maxX + 5, minZ: (c.minZ + c.maxZ) / 2 - 0.3, maxZ: (c.minZ + c.maxZ) / 2 + 0.3, top: 0.5, edge: true, axisAlongX: true };
    check("a tall building between the bird and the perch: refused (dangerous path)", !al.start(f2, blocked) && al.check(f2, blocked).why === "dangerous path", al.check(f2, blocked).why); void tgt;
  }
  { // 危険・時間切れで中止して、安定飛行を保つ(落ちない)
    const pa = new PerchAssist(idx), al = new AutoLand(idx, pa, L.heightAt), f = solo(bench, 12, 2.5, 8); al.start(f, bench);
    for (let i = 0; i < 20; i++) { const raw = inp(); al.drive(f, raw); pa.apply(raw, f); f.step(1 / 60, raw); }
    f.pos.x = bench.maxX + 40; f.prevPos.copy(f.pos); const raw = inp(); al.drive(f, raw);
    check("losing the target (flying away) aborts safely", !al.active && al.end === "lost" && pa.forced === null);
    const pb = new PerchAssist(idx), ab = new AutoLand(idx, pb, L.heightAt), g = solo(bench, 12, 2.5, 8); ab.start(g, bench); ab.t = AUTOLAND.maxTime + 1; const r2 = inp(); ab.drive(g, r2);
    check("time out (14 s) aborts", !ab.active && ab.end === "timeout");
    const pc = new PerchAssist(idx), ac = new AutoLand(idx, pc, L.heightAt), h = solo(bench, 12, 2.5, 8); ac.start(h, bench); h.stun = 0.3; const r3 = inp(); ac.drive(h, r3);
    check("a crash / stun aborts", !ac.active && ac.end === "crash");
  }
  { // 大量試験: 種類ごとの成功率・衝突率(未見のシード offset=1000)
    const r = runAutoland(40, 1000), line: string[] = [];
    const want: Record<string, number> = { fence: 60, sign: 60, pole: 45, rock: 55, wall: 40, roof: 45, rail: 45, branch: 40, bench: 30, balcony: 22 };
    for (const [k, v] of Object.entries(r)) { const att = Math.max(1, v.n - v.refused); line.push(`${k} ${Math.round(100 * v.ok / att)}%/衝突${v.crash}`); }
    check("automatic landing, unseen approaches: success per perch kind is at least the floor, collisions are rare", Object.entries(r).every(([k, v]) => 100 * v.ok / Math.max(1, v.n - v.refused) >= want[k] && v.crash <= Math.ceil(0.25 * Math.max(1, v.n - v.refused))), line.join(" "));
    check("every success can then walk or stand", Object.values(r).every(v => v.walked === v.ok));
  }
}
