import { check, suite } from "./harness";
import { L, world } from "./common";
import { Flight, type FlightInput } from "../src/flight";
import { PHYS as P } from "../src/params";
import { PerchAssist, PERCH } from "../src/perchassist";
import { buildSurfaces, type Surface } from "../src/perches";
import { run } from "../tools/perch_success";

const idx = buildSurfaces(L);
const I = (o: Partial<FlightInput> = {}): FlightInput => ({ x: 0, y: 0, flapHeld: false, flapTap: false, brake: false, ...o });
/** 足場 s の長手方向の中央へ、横から(軸と直角に)水平に近づく */
function side(s: Surface, off: number, feetAbove: number, speed: number) {
  const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, f = new Flight(world);
  const nx = s.axisAlongX ? 0 : 1, nz = s.axisAlongX ? 1 : 0, half = s.axisAlongX ? (s.maxZ - s.minZ) / 2 : (s.maxX - s.minX) / 2;
  f.pos.set(cx + nx * (half + off), s.top + feetAbove + P.feetOffset, cz + nz * (half + off)); f.prevPos.copy(f.pos);
  f.yaw = Math.atan2(nx, nz); f.vel.set(-nx * speed, 0, -nz * speed); return f;
}
export function f2LandingTests() {
  suite("F2: touch-down snap onto small perches");
  const wall = idx.all.find(s => s.kind === "wall" && s.maxX - s.minX > 6)!;
  { // ゆっくり横から上面すれすれへ: 側面に当たる前に上に乗る → 1.5秒後も上 → 歩ける
    const f = side(wall, 1.2, 0.05, 3), pa = new PerchAssist(idx); let maxJump = 0;
    for (let i = 0; i < 90; i++) { const x = f.pos.x, y = f.pos.y, z = f.pos.z; f.step(1 / 60, pa.apply(I(), f)); maxJump = Math.max(maxJump, Math.hypot(f.pos.x - x, f.pos.y - y, f.pos.z - z) - f.vel.length() / 60); }
    const on = f.mode === "landed" && Math.abs(f.pos.y - P.feetOffset - wall.top) < 0.05;
    check("slow side approach level with a 1 m wall top: lands on it (no crash) and stays", on && f.crashes === 0 && pa.stats.snaps === 1, `mode=${f.mode} feet=${(f.pos.y - P.feetOffset).toFixed(2)} crashes=${f.crashes}`);
    check("the snap moves the bird only a short distance (< 1 m incl. the step up)", maxJump < 1.0, `max extra move per step ${maxJump.toFixed(2)} m`);
    const x0 = f.pos.x; for (let i = 0; i < 120; i++) f.step(1 / 60, pa.apply(I({ y: 0.9 }), f));
    check("after the snap the bird can walk on it", f.mode === "landed" && Math.abs(f.pos.x - x0) > 1, `${Math.abs(f.pos.x - x0).toFixed(2)} m`); }
  { // 0.3m 下(側面に当たる高さ)からでも、遅ければ上に乗る
    const f = side(wall, 1.0, -0.3, 2.5), pa = new PerchAssist(idx); for (let i = 0; i < 60; i++) f.step(1 / 60, pa.apply(I(), f));
    check("slightly below the top (0.3 m) and slow: stepped up onto it instead of hitting the side", f.mode === "landed" && f.crashes === 0 && Math.abs(f.pos.y - P.feetOffset - wall.top) < 0.05); }
  { // 速すぎる: 着地にしない(通常の物理のまま)
    const f = side(wall, 1.5, -0.2, 12), pa = new PerchAssist(idx); for (let i = 0; i < 40; i++) f.step(1 / 60, pa.apply(I(), f));
    check("fast (12 m/s) into the side is NOT turned into a landing", pa.stats.snaps === 0, `snaps=${pa.stats.snaps} crashes=${f.crashes}`); }
  { // 遠い: 1.5m 横を通過しても吸い寄せない
    const s = wall, f = new Flight(world), pa = new PerchAssist(idx); const cz = (s.minZ + s.maxZ) / 2;
    f.pos.set(s.maxX + 3, s.top + 0.1 + P.feetOffset, cz + 1.5 + (s.maxZ - s.minZ) / 2); f.prevPos.copy(f.pos); f.yaw = Math.PI / 2; f.vel.set(-4, 0, 0);
    for (let i = 0; i < 90; i++) f.step(1 / 60, pa.apply(I(), f));
    check("no remote pull: passing 1.5 m to the side does not snap", pa.stats.snaps === 0); }
  { // 足場から歩いて降りる/飛び立つときは引き戻さない
    const f = new Flight(world), pa = new PerchAssist(idx); const s = wall; f.pos.set(s.maxX - 0.3, s.top + P.feetOffset, (s.minZ + s.maxZ) / 2); f.prevPos.copy(f.pos); f.mode = "landed"; f.yaw = -Math.PI / 2;
    for (let i = 0; i < 120 && f.mode !== "air"; i++) f.step(1 / 60, pa.apply(I({ y: 1 }), f)); // 端で止まる
    f.step(1 / 60, pa.apply(I({ flapTap: true }), f)); let back = false; for (let i = 0; i < 60; i++) { f.step(1 / 60, pa.apply(I(), f)); if (f.mode === "landed" && Math.abs(f.pos.y - P.feetOffset - s.top) < 0.05 && i < 30) back = true; }
    check("hopping off the wall end is not pulled back onto the same wall", !back && pa.stats.snaps === 0, `snaps=${pa.stats.snaps}`); }
  { // 足場の真上をゆっくり高めに通る: 位置は変えず速度だけを穏やかに(上限つき)変えて降ろす
    const f = new Flight(world), pa = new PerchAssist(idx), s = wall; f.pos.set((s.minX + s.maxX) / 2 + 1, s.top + 1.2 + P.feetOffset, (s.minZ + s.maxZ) / 2); f.prevPos.copy(f.pos); f.yaw = -Math.PI / 2; f.vel.set(3.5, -0.2, 0);
    let maxDv = 0; for (let i = 0; i < 90 && f.mode === "air"; i++) { const v = f.vel.clone(); f.step(1 / 60, pa.apply(I(), f)); if (f.mode === "air") maxDv = Math.max(maxDv, f.vel.clone().sub(v).length()); }
    check("slow and 1.2 m above a wall: settles down onto it (velocity-only, capped)", f.mode === "landed" && Math.abs(f.pos.y - P.feetOffset - s.top) < 0.05 && pa.stats.settles > 0, `mode=${f.mode} settles=${pa.stats.settles} maxDv/step=${maxDv.toFixed(2)}`); }

  suite("F2: landing success and collisions per perch (varied approach speed/height/angle, 40 each)");
  const r = run(40), want: Record<string, number> = { bench: 30, wall: 40, fence: 80, rock: 50, balcony: 45, rail: 30, sign: 55, branch: 8, pole: 35 };
  for (const [k, minPct] of Object.entries(want)) { const v = r[k]; if (!v) continue; const crashes = Object.entries(v.why).filter(([w]) => w.startsWith("補助あり") && w.includes("crash")).reduce((a, [, n]) => a + n, 0);
    check(`${k}: assisted air landing >= ${minPct}%`, v.air[1] * 100 / 40 >= minPct && v.air[1] >= v.air[0], `${v.air[0]}/40 -> ${v.air[1]}/40, collisions ${crashes}/40`); }
}
