import { check, suite } from "./harness";
import { inp, L, world } from "./common";
import { Flight } from "../src/flight";
import { Forage, FORAGE } from "../src/forage";
import { Autopilot } from "../src/autopilot";
import { PHYS as P } from "../src/params";

const groundFlight = (x: number, z: number, yaw = 0) => { const f = new Flight(world); f.pos.set(x, world.heightAt(x, z) + P.feetOffset, z); f.prevPos.copy(f.pos); f.mode = "landed"; f.yaw = yaw; return f; };
const lotOf = (use: string) => L.lots.find(l => l.use === use)!;

export function forageTests() {
  suite("fields, paddies and foraging (E4)");
  const uses = (u: string) => L.lots.filter(l => l.use === u).length;
  check("5 paddy lots and 5 vacant lots (outer two rings only); the park is unchanged", uses("paddy") === 5 && uses("vacant") === 5 && uses("park") === 1 && L.lots.filter(l => (l.use === "paddy" || l.use === "vacant")).every(l => Math.max(Math.abs(l.x), Math.abs(l.z)) >= 112));
  const pd = lotOf("paddy"), vc = lotOf("vacant");
  check("no houses, apartments or colliders were left inside paddy/vacant lots (except the vacant rocks)", L.houses.every(h => ![pd, vc].some(l => Math.abs(h.x - l.x) < 23 && Math.abs(h.z - l.z) < 23)) && L.apts.every(a => ![pd, vc].some(l => Math.abs(a.x - l.x) < 23 && Math.abs(a.z - l.z) < 23)) && !L.colliders.some(c => Math.abs((c.minX + c.maxX) / 2 - pd.x) < 22 && Math.abs((c.minZ + c.maxZ) / 2 - pd.z) < 22));
  { let water = 0, ridge = 0, n = 0; for (let x = -23; x < 23; x += 0.5) for (let z = -23; z < 23; z += 0.5) { n++; const g = L.groundAt(pd.x + x, pd.z + z); if (g === "water") water++; else if (g === "ridge") ridge++; }
    check("a paddy is ~70-80% water with ridges (あぜ) around and between plots", water / n > 0.65 && water / n < 0.85 && ridge / n > 0.15 && L.groundAt(pd.x, pd.z) === "water" && L.groundAt(pd.x + 22, pd.z) === "ridge" && L.groundAt(pd.x + 7.2, pd.z) === "ridge", `water=${(100 * water / n).toFixed(0)}% ridge=${(100 * ridge / n).toFixed(0)}%`); }
  check("ground kinds: vacant=soil, park=grass, house lots=paved, roads=road, outside the town=grass", L.groundAt(vc.x, vc.z) === "soil" && L.groundAt(0, 0) === "grass" && L.groundAt(L.lots.find(l => l.use === "town")!.x, L.lots.find(l => l.use === "town")!.z) === "paved" && L.groundAt(L.roads[0], 0) === "road" && L.groundAt(300, 300) === "grass");
  // 歩いて水に入らない
  { const f = groundFlight(pd.x + 21.5, pd.z, Math.PI / 2); // あぜ道の上で水の方(-x)を向く
    for (let i = 0; i < 60 * 6; i++) f.step(1 / 60, inp({ brake: true }));
    check("walking along a ridge toward the water never enters the water", !L.waterAt(f.pos.x, f.pos.z) && f.mode === "landed" && f.pos.x > pd.x + 20.9, `x=${(f.pos.x - pd.x).toFixed(2)}`); }
  { const f = groundFlight(pd.x + 21.5, pd.z, Math.PI / 2); for (let i = 0; i < 20; i++) f.step(1 / 60, inp({ brake: true })); for (let i = 0; i < 60; i++) f.step(1 / 60, inp({ flapHeld: true }));
    check("a bird at the water's edge can still take off", f.mode === "air" || f.hopping); }
  { const f = new Flight(world); f.pos.set(pd.x, 3, pd.z); f.prevPos.copy(f.pos); f.vel.set(0, -2, 0); for (let i = 0; i < 200; i++) f.step(1 / 60, inp());
    check("a bird that lands in the water is not stuck: it can take off again", f.mode !== "air"); for (let i = 0; i < 60; i++) f.step(1 / 60, inp({ flapHeld: true })); check("...and does", f.mode === "air" || f.hopping || f.strokes > 0); }
  // ついばみ
  { const f = groundFlight(vc.x - 10, vc.z, -Math.PI / 2), fg = new Forage(L.groundAt, 5); let seq = 0, maxHead = 0, pecks = 0; const dist: number[] = []; let lastX = f.pos.x, lastSt = fg.state; let walkedSince = 0;
    for (let i = 0; i < 60 * 60; i++) { const a = fg.apply(inp({ brake: true, x: 0 }), f, true); f.step(1 / 60, a); maxHead = Math.max(maxHead, fg.head); walkedSince += Math.hypot(f.pos.x - lastX, 0); lastX = f.pos.x;
      if (fg.state === "pause" && lastSt === "idle") { seq++; dist.push(walkedSince); walkedSince = 0; } lastSt = fg.state; if (f.pos.x > vc.x + 10) { f.pos.x = vc.x - 10; lastX = f.pos.x; } }
    pecks = fg.stats.pecks;
    check("walking on soil: it walks, stops, and pecks in sequences (about every 1.4-3.6 m)", seq >= 8 && dist.slice(1).every(d => d > 0.9 && d < 4.4), `seq=${seq} dist=${dist.slice(1, 6).map(d => d.toFixed(1)).join(",")}`);
    check("each sequence has 1-3 pecks and the head goes down well", pecks >= seq && pecks <= seq * 3 + 3 && maxHead > 0.8, `pecks=${pecks} seq=${seq} head=${maxHead.toFixed(2)}`); }
  { const f = groundFlight(L.lots.find(l => l.use === "town")!.x + 3, L.lots.find(l => l.use === "town")!.z + 20.5), fg = new Forage(L.groundAt, 5); for (let i = 0; i < 60 * 20; i++) { f.step(1 / 60, fg.apply(inp({ brake: true }), f, true)); if (Math.abs(f.pos.x) > 250) break; }
    check("on paved ground there is no pecking", fg.stats.sequences === 0 && fg.head < 0.01); }
  { const f = groundFlight(vc.x, vc.z), fg = new Forage(L.groundAt, 9); for (let i = 0; i < 60 * 30; i++) f.step(1 / 60, fg.apply(inp({}), f, true));
    check("standing still on soil it still pecks now and then", fg.stats.sequences >= 3 && fg.stats.pecks >= 3, `${fg.stats.sequences} sequences`); }
  { const f = groundFlight(vc.x - 5, vc.z), fg = new Forage(L.groundAt, 5); let started = -1;
    for (let i = 0; i < 60 * 20 && started < 0; i++) { f.step(1 / 60, fg.apply(inp({ brake: true }), f, true)); if (fg.state === "pause") started = i; }
    const a = fg.apply(inp({ brake: true, flapHeld: true }), f, true);
    check("a strong input (flap) interrupts the pecking at once and keeps the walk request", started >= 0 && fg.state === "idle" && a.brake && fg.stats.interrupts === 1);
    const g = groundFlight(vc.x - 5, vc.z), fg2 = new Forage(L.groundAt, 5); started = -1;
    for (let i = 0; i < 60 * 20 && started < 0; i++) { g.step(1 / 60, fg2.apply(inp({ brake: true }), g, true)); if (fg2.state === "pause") started = i; }
    fg2.apply(inp({ brake: true, x: 0.9 }), g, true); check("a big stick input interrupts it too, a small one does not", fg2.state === "idle" && (() => { const h = groundFlight(vc.x - 5, vc.z), fg3 = new Forage(L.groundAt, 5); let s = -1; for (let i = 0; i < 1200 && s < 0; i++) { h.step(1 / 60, fg3.apply(inp({ brake: true }), h, true)); if (fg3.state === "pause") s = i; } fg3.apply(inp({ brake: true, x: 0.2 }), h, true); return fg3.state !== "idle"; })()); }
  { const f = new Flight(world); f.pos.set(vc.x, 20, vc.z); f.prevPos.copy(f.pos); const fg = new Forage(L.groundAt, 3); for (let i = 0; i < 300; i++) f.step(1 / 60, fg.apply(inp(), f, true));
    check("never pecks in the air or while hopping", fg.stats.sequences === 0);
    const h = groundFlight(vc.x, vc.z); h.step(1 / 60, inp({ flapTap: true })); const s0 = fg.stats.sequences; for (let i = 0; i < 20; i++) h.step(1 / 60, fg.apply(inp(), h, true)); check("(hopping)", fg.stats.sequences === s0); }
  // オート: ついばみ中も固着扱いにならず、テレポートしない。30分×方針で数える
  { const out: string[] = []; let tele = 0, pecks = 0, crashes = 0, seqs = 0;
    for (const [p, sd] of [["life", 21], ["adventure", 22], ["random", 23]] as const) {
      const f = new Flight(world); f.pos.set(28, 30, 110); f.prevPos.copy(f.pos); f.vel.set(0, 0, -10); const ap = new Autopilot(L, sd); ap.setPolicy(p); ap.start(f); const fg = new Forage(L.groundAt, sd); const o = inp();
      for (let i = 0; i < 60 * 600; i++) { o.flapTap = false; ap.busy = fg.active; f.step(1 / 60, fg.apply(ap.drive(f, o, 1 / 60), f, false)); }
      tele += ap.stats.teleports; pecks += fg.stats.pecks; seqs += fg.stats.sequences; crashes += f.crashes; out.push(`${p}:${fg.stats.sequences}`);
      check(`autopilot ${p} never stands in the paddy water (10 min)`, !L.waterAt(f.pos.x, f.pos.z) || f.mode === "air"); }
    check("autopilot with pecking: no teleports in 30 min of play, and it pecks", tele === 0 && pecks > 0, `tele=${tele} sequences=${out.join(" ")} crashes=${crashes}`); }
  void FORAGE;
}
