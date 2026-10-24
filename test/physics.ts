import { check, suite } from "./harness";
import { at, inp, run, L, insideBuilding } from "./common";
import { Flight } from "../src/flight";
import { PHYS } from "../src/params";

export function physicsTests() {
  suite("physics");
  { const f = at(28, 60, 110); const r = run(f, 20, () => inp());
    check("glide: finite, descends gently, no stall", r.finite && f.pos.y < 60 && f.pos.y > 20 && !f.stall, `y=${f.pos.y.toFixed(1)} v=${f.speed.toFixed(1)}`);
    check("glide: speed in sane range", f.speed > 6 && f.speed < 14); }
  { const f = at(28, 30, 110); const r = run(f, 15, () => inp({ flapHeld: true }));
    check("flap: climbs, level-flap speed stays under flapMaxSpeed", f.pos.y > 50 && r.maxSpeed <= PHYS.flapMaxSpeed + 1, `y=${f.pos.y.toFixed(0)} max=${r.maxSpeed.toFixed(1)}`); }
  { const f = at(28, 100, 110); const r = run(f, 15, () => inp({ y: 1 }));
    check("hard pull-up: stays finite and airborne, recovers from stall", r.finite && f.pos.y > 20 && f.speed > 5); }
  { const f = at(28, 100, 110); const r = run(f, 6, () => inp({ y: -1 }));
    check("dive: gains speed but capped, finite", r.finite && f.pos.y < 100 && r.maxSpeed <= PHYS.maxDiveSpeed + 1e-6); }
  { const f = at(28, 100, 110); const y0 = f.yaw; run(f, 3, () => inp({ x: 1 }));
    check("full turn: yaw changes ~> 2 rad in 3 s", Math.abs(y0 - f.yaw) > 2, `${Math.abs(y0 - f.yaw).toFixed(2)}`); }
  { const f = at(28, 6, 110); run(f, 12, t => inp({ brake: t > 2 }));
    check("lands softly and stops", f.mode === "landed" && f.crashes === 0, `mode=${f.mode}`);
    run(f, 4, () => inp({ flapHeld: true }));
    check("re-takeoff by flapping", f.mode === "air" && f.pos.y > 3, `y=${f.pos.y.toFixed(1)}`); }
  { const a = L.apts[0]; const f = at(a.x, 10, a.z + 40); const r = run(f, 6, () => inp());
    check("wall: no tunnelling into building", r.finite && !insideBuilding(f)); }
  { const a = L.apts[0], top = a.floors * 3.1; const f = at(a.x - 6, top + 1.2, a.z, 0, 3); run(f, 6, () => inp());
    check("rooftop: lands and rests on the roof", f.mode !== "air" && Math.abs(f.pos.y - 0.32 - top) < 0.05, `y=${f.pos.y.toFixed(2)} top=${top.toFixed(2)}`);
    run(f, 3, () => inp({ flapHeld: true }));
    check("rooftop: can take off again", f.mode === "air" && f.pos.y > top + 1, `y=${f.pos.y.toFixed(1)}`); }
  { const f = at(28, 50, 110); f.pos.x = NaN; run(f, 1, () => inp());
    check("NaN state is reset to a finite state", Number.isFinite(f.pos.x) && f.resets >= 2); }
  { const f = at(28, 40, 110); run(f, 10, t => inp({ y: t < 4 ? -1 : 0 }));
    const r = run(f, 8, () => inp({ flapHeld: true }));
    check("crash dive: controls recover afterwards", r.finite && f.mode === "air" && f.pos.y > 5, `mode=${f.mode}`); }
  { const f = new Flight({ colliders: L.colliders, heightAt: L.heightAt }); f.pos.y = -50; f.step(1 / 60, inp());
    check("falling out of the world resets", f.pos.y > 0); }

  suite("physics: high-speed dive (C1)");
  { const f = at(28, 150, 110); let t30 = -1, mx = 0, fin = true;
    for (let i = 0; i < 600 && f.mode === "air"; i++) { f.step(1 / 60, inp({ y: -1 })); fin = fin && Number.isFinite(f.speed); mx = Math.max(mx, f.speed); if (t30 < 0 && f.speed >= 30) t30 = i / 60; }
    check("steep dive reaches 30 m/s within 5 s", t30 > 0 && t30 < 5, `t30=${t30.toFixed(1)}s max=${mx.toFixed(1)}`);
    check("steep dive speed bounded by maxDiveSpeed", fin && mx <= PHYS.maxDiveSpeed + 1e-6); }
  { const f = at(28, 150, 110); let mx = 0; for (let i = 0; i < 600; i++) { f.step(1 / 60, inp({ y: -1, brake: true })); mx = Math.max(mx, f.speed); }
    check("braking in a dive keeps speed moderate (<= 22 m/s) and still descends", mx <= 22 && f.pos.y < 100 || f.mode !== "air", `max=${mx.toFixed(1)} y=${f.pos.y.toFixed(0)}`); }
  { const f = at(28, 150, 110); let mx = 0; for (let i = 0; i < 420; i++) { f.step(1 / 60, inp({ y: -1, brake: i > 240 })); mx = Math.max(mx, f.speed); }
    check("brake after fast dive decelerates", f.speed < mx - 5, `peak=${mx.toFixed(1)} now=${f.speed.toFixed(1)}`); }
  { // 高速で建物へ突っ込んでもすり抜けない (36方位 x 3高度)
    let bad = 0, n = 0;
    for (const a of [L.apts[0], L.apts[3], L.houses[0]] as { x: number; z: number }[]) for (let k = 0; k < 36; k++) for (const hy of [8, 20]) {
      const yaw = (k / 36) * Math.PI * 2, d = 70, f = at(a.x + Math.sin(yaw) * d, hy, a.z + Math.cos(yaw) * d, yaw + Math.PI, 38); f.vel.setLength(38);
      for (let i = 0; i < 360; i++) { f.step(1 / 60, inp({ y: -0.3 })); if (insideBuilding(f)) { bad++; break; } } n++;
    }
    check("no tunnelling at 38 m/s into buildings", bad === 0, `${n} runs, ${bad} bad`); }
  { const a = L.apts[1], top = a.floors * 3.1; let bad = 0;
    for (let k = 0; k < 12; k++) { const f = at(a.x + (k - 6), top + 80, a.z + (k % 3) - 1, 0, 1); for (let i = 0; i < 600; i++) { f.step(1 / 60, inp({ y: -1 })); if (insideBuilding(f)) { bad++; break; } } }
    check("no falling through a roof in a vertical dive", bad === 0, `${bad} bad`); }
}
