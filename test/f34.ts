import { check, suite } from "./harness";
import { at, inp } from "./common";
import { FlapAssist, ASSIST } from "../src/assist";
import { OneHandGesture, GESTURE } from "../src/gesture";

export function f34Tests() {
  suite("F3: one-hand stick shaping");
  { const g = new OneHandGesture(); g.down(1, 500, 300, 0, 60); g.move(1, 500 + 10, 300); check("a 10 px wobble stays a tap/press (move threshold 16 px)", g.phase === "pending" && g.x === 0);
    g.move(1, 500 + 12, 300); g.up(1, 120); check("...and releasing it quickly is still a tap", g.consumeTap()); }
  { const g = new OneHandGesture(); g.down(1, 500, 300, 0, 60); const xs: number[] = [];
    for (let px = 17; px <= 60; px += 1) { g.move(1, 500 + px, 300); xs.push(g.x); }
    const jump = Math.max(...xs.slice(1).map((v, i) => Math.abs(v - xs[i])));
    check("no jump at the dead-zone edge, small deflections are gentle (expo), full deflection reaches 1", xs[0] < 0.1 && jump < 0.06 && Math.abs(xs[xs.length - 1] - 1) < 1e-9 && xs[Math.floor(xs.length / 2)] < 0.5, `first=${xs[0].toFixed(3)} mid=${xs[Math.floor(xs.length / 2)].toFixed(2)} maxStep=${jump.toFixed(3)} expo=${GESTURE.expo}`); }

  suite("F4: stronger flap assist (one-hand)");
  const open = (alt: number, v: number) => at(28, alt, 150, 0, v); // 道路の上を道路に沿って(建物にぶつからない。世界の端は±205m)
  const fly = (a: FlapAssist | null, alt: number, v: number, secs: number, fn = () => inp()) => { const f = open(alt, v); const y0 = f.pos.y; let minAgl = 99;
    for (let i = 0; i < secs * 60; i++) { f.step(1 / 60, a ? a.apply(fn(), f) : fn()); minAgl = Math.min(minAgl, f.agl); if (f.mode !== "air") break; } return { f, drop: y0 - f.pos.y, minAgl }; };
  { const a = new FlapAssist(); a.enabled = true; const r = fly(a, 25, 9, 8), b = fly(null, 25, 9, 8);
    check("hands off for 8 s at 25 m: loses little height (vs. without assist)", r.f.mode === "air" && r.drop < 6 && r.drop < b.drop - 3, `drop ${r.drop.toFixed(1)} m (without assist ${b.drop.toFixed(1)} m), flaps ${a.autoFlaps}`); }
  { const a = new FlapAssist(); a.enabled = true; const r = fly(a, 12, 6, 6);
    check("slow (6 m/s) and low (12 m), hands off: does not crash into the ground within 6 s", r.f.mode === "air" && r.minAgl > 3, `minAgl=${r.minAgl.toFixed(1)}`); }
  { const a = new FlapAssist(); a.enabled = true; const r = fly(a, 30, 9, 90);
    check("hands off for a long time: no endless flight - it glides down and lands within 90 s", r.f.mode !== "air", `mode=${r.f.mode} drop=${r.drop.toFixed(1)} flaps=${a.autoFlaps}`); }
  { const a = new FlapAssist(); a.enabled = true; let flapsHigh = 0; const f = open(60, 10); f.step(1 / 60, inp());
    for (let i = 0; i < 60 * 5 && f.mode === "air"; i++) { const n0 = a.autoFlaps; f.step(1 / 60, a.apply(inp({ y: -0.8 }), f)); if (a.autoFlaps > n0 && f.agl > 5) flapsHigh++; }
    check("an intentional dive (stick down) is not interrupted by auto flaps", flapsHigh === 0, `flaps above 5 m: ${flapsHigh}`); }
  { const a = new FlapAssist(); a.enabled = true; const f = open(4, 5); f.vel.y = -1.5; let n = 0; for (let i = 0; i < 60; i++) { const o = a.apply(inp(), f, true); if (o.flapTap) n++; f.step(1 / 60, o); }
    check("next to a landing target (perch assist aiming): never flaps up", n === 0); }
  { const a = new FlapAssist(); a.enabled = true; const f = open(20, 10); for (let i = 0; i < 60 * 6; i++) f.step(1 / 60, a.apply(inp({ x: 0.3 }), f));
    const flapsPerMin = a.autoFlaps / 6 * 60; check("steering normally at a good speed: the assist stays mostly quiet (gliding is kept)", flapsPerMin <= 25, `${flapsPerMin.toFixed(0)}/min (cooldown ${ASSIST.cooldown}s)`); }
}
