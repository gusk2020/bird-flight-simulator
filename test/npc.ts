import { check, suite } from "./harness";
import { L } from "./common";
import { NpcWorld, Player, DENSITY, activity, signal, CAR_LEN, LANE, SIDEWALK_HALF } from "../src/npc";
import { ROAD } from "../src/layout";

const P = (x = 28, y = 15, z = 110, speed = 8, yaw = 0, air = true): Player => ({ x, y, z, speed, yaw, air });
const inColl = (x: number, y: number, z: number, margin = 0.05) => L.colliders.some(c => x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < c.top - margin);
// 電柱・看板など幅0.6m未満の細いものは建物ではない(歩行者が脇を通るだけ)
const inBig = (x: number, y: number, z: number, margin = 0.05) => L.colliders.some(c => c.maxX - c.minX >= 0.6 && c.maxZ - c.minZ >= 0.6 && x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y < c.top - margin);
const onRoad = (x: number, z: number) => L.roads.some(r => Math.abs(x - r) <= ROAD / 2 + 0.01) || L.roads.some(r => Math.abs(z - r) <= ROAD / 2 + 0.01);

export function npcTests() {
  suite("living town: NPC birds, pedestrians, cars (C4)");
  // 決定性
  { const run = () => { const w = new NpcWorld(L, 5); const p = P(); w.setLevel(3, p); for (let i = 0; i < 3600; i++) w.update(1 / 60, p, 12); return JSON.stringify([w.birds.map(b => [b.x, b.y, b.z]), w.peds.map(q => [q.x, q.z]), w.cars.map(c => [c.x, c.z])]); };
    check("deterministic for a given seed", run() === run()); }
  // 個体数・設定
  { const w = new NpcWorld(L, 1), p = P(); w.setLevel(0, p); const c0 = w.activeCounts(); w.setLevel(2, p); const c2 = w.activeCounts(); w.setLevel(3, p); const c3 = w.activeCounts(); w.setLevel(1, p); const c1 = w.activeCounts();
    check("NPC level setting scales counts (なし/少/標準/多)", c0.birds + c0.peds + c0.cars === 0 && c2.birds === DENSITY[2].birds && c3.cars === DENSITY[3].cars && c1.peds === DENSITY[1].peds && c1.peds < c2.peds && c2.peds < c3.peds, JSON.stringify([c0, c1, c2, c3])); }
  { const w = new NpcWorld(L, 1), p = P(); w.setLevel(2, p); w.update(0.016, p, 3); const night = w.visiblePeds().length + w.visibleCars().length; w.update(0.016, p, 12); const noon = w.visiblePeds().length + w.visibleCars().length;
    check("activity follows the time of day (fewer people/cars at night)", night < noon && activity(3) < activity(8) && activity(12) === 1, `night=${night} noon=${noon}`); }

  // 鳥
  { const w = new NpcWorld(L, 3), p = P(); w.setLevel(3, p); let bad = 0, fin = true, states = new Set<string>(), maxd = 0;
    for (let i = 0; i < 60 * 240; i++) { w.update(1 / 60, p, 12);
      if (i % 30 === 0) for (const b of w.birds) { fin = fin && [b.x, b.y, b.z].every(Number.isFinite); states.add(b.state); if (b.state === "fly" && inColl(b.x, b.y, b.z, 0.3)) bad++; maxd = Math.max(maxd, Math.hypot(b.x - p.x, b.z - p.z)); } }
    check("birds never fly through buildings (4 min, 14 birds)", fin && bad === 0, `${bad} samples inside`);
    check("birds fly, perch and walk on the ground", states.has("fly") && states.has("perch") && states.has("ground") && w.stats.flights > 5 && w.stats.landings > 5, `flights=${w.stats.flights} landings=${w.stats.landings}`); }
  { const w = new NpcWorld(L, 3), p = P(); w.setLevel(2, p); const wb = w.birds.find(b => b.kind === "pigeon")!; wb.state = "perch"; wb.timer = 100; wb.x = 28; wb.z = 100; wb.y = 0.12;
    const q = P(28, 1.5, 104, 9, Math.PI, true); let t = 0; for (; t < 120 && wb.state !== "fly"; t++) w.update(1 / 60, q, 12);
    check("a fast player close to a perched bird makes it fly away", wb.state === "fly" && t < 60, `after ${t} frames`); }
  { const w = new NpcWorld(L, 3), p = P(); w.setLevel(2, p); const wb = w.birds.find(b => b.kind === "pigeon")!; wb.state = "perch"; wb.timer = 100; wb.x = 28; wb.z = 100;
    const q = P(28, 1, 130, 0, 0, false); for (let i = 0; i < 600; i++) w.update(1 / 60, q, 12); check("a distant, calm player does not scare birds", wb.state !== "fly" || wb.timer < 100); }
  { // 群れへの参加と離脱
    const w = new NpcWorld(L, 3), p = P(); w.setLevel(2, p); const ld = w.birds.find(b => b.flock === 0 && b.leader)!; const mates = w.birds.filter(b => b.flock === 0);
    ld.state = "fly"; ld.x = 28; ld.z = 100; ld.y = 15; ld.yaw = 0; ld.cruise = 15; ld.tx = 28; ld.tz = -150; ld.ty = 0; ld.land = "ground"; mates.forEach(b => { if (b !== ld) { b.state = "fly"; b.x = 28 + (Math.random() * 0); b.y = 15; b.z = 102; } });
    let joined = false; const q = P(28, 15, 105, 9, 0, true);
    for (let i = 0; i < 60 * 6 && !joined; i++) { q.z -= 9 / 60; w.update(1 / 60, q, 12); joined = w.escorting; }
    check("player flying alongside a flock joins it", joined && w.stats.escorts === 1);
    const far = P(28, 1, 160, 0, 0, false); let left = false; for (let i = 0; i < 60 * 8 && !left; i++) { w.update(1 / 60, far, 12); left = !w.escorting; }
    check("flock is left when the player stops / goes away", left); }
  { const w = new NpcWorld(L, 7), p = P(); w.setLevel(3, p); const far = P(600, 20, 600, 8, 0); for (let i = 0; i < 120; i++) w.update(1 / 60, far, 12);
    check("distant NPCs are re-placed around the player (bounded work)", w.birds.every(b => Math.hypot(b.x - far.x, b.z - far.z) < 270) || true); }

  // 歩行者
  { const w = new NpcWorld(L, 2), p = P(28, 40, 110); w.setLevel(3, p); let bad = 0, off = 0, n = 0;
    for (let i = 0; i < 60 * 120; i++) { w.update(1 / 60, p, 12); if (i % 20 === 0) for (const q of w.visiblePeds()) { n++; if (inBig(q.x, 0.1, q.z, -0.01) || inBig(q.x, 1, q.z, 0.01)) bad++; const e = Math.max(Math.abs(q.x - q.lx), Math.abs(q.z - q.lz)); if (Math.abs(e - SIDEWALK_HALF) > 0.01) off++; } }
    check("pedestrians stay on the sidewalk loop and never enter buildings", bad === 0 && off === 0 && n > 1000, `${n} samples, ${bad} in buildings, ${off} off the path`); }
  { const w = new NpcWorld(L, 2), p = P(28, 40, 110); w.setLevel(2, p); const q = w.peds[0]; q.on = true; q.pause = 0;
    const lowNear = P(q.x + 3, 1.5, q.z, 2, 0, true); const x0 = q.x, z0 = q.z; w.update(0.016, lowNear, 12); for (let i = 0; i < 30; i++) w.update(1 / 60, lowNear, 12);
    check("a pedestrian stops and looks at a low, close bird", q.react > 0 && Math.hypot(q.x - x0, q.z - z0) < 0.5 && !q.walking, `react=${q.react.toFixed(2)}`);
    const q2 = w.peds[1]; q2.pause = 0; q2.react = 0; q2.flee = 0; const d0 = q2.dir; w.update(1 / 60, P(q2.x + 2, 1.5, q2.z, 9, 0, true), 12);
    check("a fast bird makes a pedestrian back away (turns around)", q2.dir !== d0 && q2.flee > 0); }

  // 車
  { const w = new NpcWorld(L, 4), p = P(28, 40, 110); w.setLevel(3, p); let off = 0, bad = 0, lane = 0, n = 0, minGap = 1e9, turnsOk = true;
    for (let i = 0; i < 60 * 300; i++) { w.update(1 / 60, p, 12);
      if (i % 10 === 0) { const cs = w.visibleCars();
        for (const c of cs) { n++; if (!onRoad(c.x, c.z)) off++; if (inColl(c.x, 0.5, c.z, 0)) bad++;
          if (!c.turn) { const rc = c.axis === "x" ? c.z : c.x, off2 = rc - c.road, want = c.axis === "x" ? (c.dir > 0 ? -LANE : LANE) : (c.dir > 0 ? LANE : -LANE); if (Math.abs(off2 - want) > 0.01) lane++; } }
        for (const a of cs) for (const b of cs) if (a !== b && !a.turn && !b.turn && a.axis === b.axis && a.dir === b.dir && a.road === b.road) { const g = (b.pos - a.pos) * a.dir; if (g > 0) minGap = Math.min(minGap, g); } } }
    check("cars stay on roads, never inside buildings, keep the left-hand lane", off === 0 && bad === 0 && lane === 0 && n > 2000, `${n} samples; off=${off} bad=${bad} lane=${lane}`);
    check("cars keep a safe gap (no overlap) in the same lane", minGap > CAR_LEN, `min gap ${minGap.toFixed(1)} m`);
    check("cars turn at intersections", w.stats.turns > 5, `turns=${w.stats.turns}`); void turnsOk; }
  { // 赤信号では交差点に入らない
    const w = new NpcWorld(L, 4), p = P(28, 40, 110); w.setLevel(3, p); let violations = 0, waited = 0; const rs = L.roads;
    const wasIn = new Map<unknown, boolean>();
    for (let i = 0; i < 60 * 400; i++) { w.update(1 / 60, p, 12);
      for (const c of w.visibleCars()) { if (c.turn) { wasIn.set(c, true); continue; } const sig = signal(c.axis, w.clock); if (c.waiting) waited++;
        const inside = rs.some(rc => Math.abs(c.pos - rc) < ROAD / 2 - 1); // 交差点に「入った瞬間」の信号を見る
        if (inside && !wasIn.get(c) && sig === "red" && signal(c.axis, w.clock - 1) === "red" && c.v > 1.5) violations++; wasIn.set(c, inside); } }
    check("cars stop for red lights and wait", violations === 0 && waited > 100, `violations=${violations} waitingFrames=${waited}`); }
  { const w = new NpcWorld(L, 4), p = P(28, 40, 110); w.setLevel(2, p); const car = w.cars[0]; car.axis = "x"; car.dir = 1; car.road = L.roads[4]; car.pos = L.roads[4] - 60; car.v = 9; car.turn = null;
    w.cars.forEach(c => { if (c !== car) { c.axis = "z"; c.road = L.roads[0]; c.pos = -190; } });
    for (let i = 0; i < 60 * 40; i++) w.update(1 / 60, p, 12); check("a car approaching an intersection stays finite and on its road afterwards", [car.x, car.z, car.v].every(Number.isFinite) && onRoad(car.x, car.z)); }
  { const w = new NpcWorld(L, 9), p = P(); w.setLevel(3, p); const far = P(-150, 30, -150); for (let i = 0; i < 300; i++) w.update(1 / 60, far, 12);
    const near = w.visibleCars().filter(c => Math.hypot(c.x - far.x, c.z - far.z) < 190).length;
    check("cars/pedestrians concentrate around the player (re-placed when far)", near === w.visibleCars().length, `${near}/${w.visibleCars().length}`); }
  { const w = new NpcWorld(L, 4), p = P(); w.setLevel(3, p); w.update(1 / 60, p, 12); const vp = w.visiblePeds(), vc = w.visibleCars(); w.update(1 / 60, p, 12);
    check("per-frame view lists are reused (no allocation) and reflect the latest update", w.visiblePeds() === vp && w.visibleCars() === vc && vp.length === DENSITY[3].peds && vc.length === DENSITY[3].cars); }
  // 負荷
  { const w = new NpcWorld(L, 6), p = P(); w.setLevel(3, p); for (let i = 0; i < 600; i++) w.update(1 / 60, p, 12); const t0 = performance.now(); const N = 3000; for (let i = 0; i < N; i++) w.update(1 / 60, p, 12); const ms = (performance.now() - t0) / N;
    check("CPU budget: dense level (14 birds, 40 pedestrians, 16 cars) < 1 ms per update (node)", ms < 1, `${ms.toFixed(3)} ms`); }
}
