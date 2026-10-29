import { check, suite } from "./harness";
import { inp, L, world, finite, insideBuilding } from "./common";
import { Flight, FlightInput } from "../src/flight";
import { PHYS } from "../src/params";

const landedAt = (x: number, z: number, yaw = 0) => {
  const f = new Flight(world); f.pos.set(x, world.heightAt(x, z) + PHYS.feetOffset, z); f.prevPos.copy(f.pos); f.vel.set(0, 0, 0); f.yaw = yaw; f.mode = "landed"; return f;
};
const walkIn = (o: Partial<FlightInput> = {}) => inp({ brake: true, ...o });
function sim(f: Flight, secs: number, fn: (t: number, f: Flight) => FlightInput) {
  let transitions = 0, last = f.mode === "air", ok = true, minY = 1e9, maxY = -1e9, inside = false;
  for (let i = 0; i < secs * 60; i++) {
    f.step(1 / 60, fn(i / 60, f)); ok = ok && finite(f); const a = f.mode === "air"; if (a !== last) transitions++; last = a;
    minY = Math.min(minY, f.pos.y); maxY = Math.max(maxY, f.pos.y); inside = inside || insideBuilding(f);
  }
  return { transitions, ok, minY, maxY, inside };
}

export function walkTests() {
  suite("ground: walking, hopping, steps (C2)");
  { const f = landedAt(28, 110); const r = sim(f, 2, () => inp());
    check("landed bird stays put", f.mode === "landed" && f.vel.length() === 0 && r.transitions === 0); }
  { const f = landedAt(28, 110); const p0 = f.pos.clone(); let vmax = 0; const r = sim(f, 2, () => walkIn()); vmax = f.walkV;
    check("hold 歩く: walks forward at ~walkSpeed, stays grounded", f.mode === "landed" && f.walking && Math.abs(vmax - PHYS.walkSpeed) < 0.2 && f.pos.distanceTo(p0) > 2.5 && f.pos.distanceTo(p0) < 4.2 && r.transitions === 0, `walkV=${vmax.toFixed(2)} dist=${f.pos.distanceTo(p0).toFixed(2)}`);
    sim(f, 0.6, () => inp()); check("release stops within 0.6 s", !f.walking && f.vel.length() < 0.05); }
  { const f = landedAt(28, 110); sim(f, 1, () => walkIn({ x: 1 })); const y1 = f.yaw;
    check("stick turns the bird while walking", Math.abs(y1) > 1 && f.mode === "landed", `yaw=${y1.toFixed(2)}`); }
  { const a = L.apts[0]; const f = landedAt(a.x, a.z + 7.5 + 3, 0); const r = sim(f, 4, () => walkIn());
    check("walking into a building stops at the wall (no clipping)", !r.inside && f.mode === "landed" && f.pos.z > a.z + 7.5 + 0.2); }
  { const w = L.lows.find(l => l.kind === "wall")!; const f = landedAt(w.x, w.z + 3, 0); const r = sim(f, 4, () => walkIn());
    check("a 1 m wall is not climbed by walking", !r.inside && r.maxY < PHYS.feetOffset + 0.3 && f.pos.z > w.z + w.hd, `maxY=${r.maxY.toFixed(2)} z=${f.pos.z.toFixed(2)}`); }
  { const f = landedAt(28, 110); f.step(1 / 60, inp({ flapTap: true, flapHeld: true })); let peak = 0, stun = false, strokes = f.strokes;
    for (let i = 0; i < 180; i++) { f.step(1 / 60, inp()); peak = Math.max(peak, f.pos.y - PHYS.feetOffset - world.heightAt(f.pos.x, f.pos.z)); stun = stun || f.stun > 0; }
    check("short tap = small hop (0.4–0.9 m), lands, no takeoff, no stun", peak > 0.4 && peak < 0.9 && f.mode !== "air" && f.strokes === strokes && !stun, `peak=${peak.toFixed(2)} mode=${f.mode}`); }
  { const f = landedAt(28, 110); f.step(1 / 60, inp({ flapTap: true, flapHeld: true })); sim(f, 4, () => inp({ flapHeld: true }));
    check("long press = hop turns into a normal takeoff and flies", f.mode === "air" && f.pos.y > 3, `y=${f.pos.y.toFixed(1)}`); }
  { const f = landedAt(28, 110); f.step(1 / 60, inp({ flapHeld: true })); sim(f, 2, () => inp({ flapHeld: true }));
    check("held flap without a press edge still takes off", f.mode === "air" && f.pos.y > 1.5, `y=${f.pos.y.toFixed(1)}`); }
  { const f = landedAt(28, 110); sim(f, 1, () => walkIn()); f.step(1 / 60, walkIn({ flapTap: true })); const x0 = f.pos.clone(); sim(f, 1.5, () => inp());
    check("hopping while walking carries forward momentum", f.pos.distanceTo(x0) > 1 && f.mode !== "air"); }
  { // 低い障害物(植え込み0.45m / ベンチ0.5m)へ小ジャンプで乗る
    const o = L.lows.find(l => l.kind === "planter")!; let landed = 0, bad = 0, n = 0;
    for (let d = 0.9; d <= 1.6; d += 0.1) {
      const f = landedAt(o.x, o.z + o.hd + d, 0); f.step(1 / 60, inp({ flapTap: true, flapHeld: true })); const r = sim(f, 2, () => inp()); n++;
      if (r.inside) bad++; if (Math.abs(f.pos.y - PHYS.feetOffset - o.top) < 0.02) landed++;
    }
    check("small hop can land on a low planter", landed >= 1 && bad === 0, `${landed}/${n} landed on top, ${bad} clipped`);
    const w = L.lows.find(l => l.kind === "wall")!; let on = 0;
    for (let d = 0.9; d <= 1.6; d += 0.1) { const f = landedAt(w.x, w.z + Math.max(w.hd, 0.25) + d, 0); f.step(1 / 60, inp({ flapTap: true, flapHeld: true })); sim(f, 2, () => inp()); if (Math.abs(f.pos.y - PHYS.feetOffset - w.top) < 0.02) on++; }
    check("a 1 m wall is too high for a small hop", on === 0, `${on} landed on top`); }
  { const f = landedAt(30, 56, Math.PI / 2); const h0 = f.pos.y; const r = sim(f, 5, () => walkIn());
    check("walking over a curb: stays grounded, rises by the step height, no flicker", f.pos.x < 22.5 && f.mode === "landed" && r.transitions === 0 && Math.abs(f.pos.y - h0 - 0.12) < 1e-6, `x=${f.pos.x.toFixed(1)} dy=${(f.pos.y - h0).toFixed(3)}`); }
  { const a = L.apts[0], top = a.floors * 3.1; const f = landedAt(a.x - 9, a.z + 6, Math.PI); f.pos.y = top + PHYS.feetOffset; f.prevPos.copy(f.pos);
    let leftRoof = false; const r = sim(f, 20, (t, ff) => { if (ff.mode === "air") leftRoof = true; return t < 4 ? walkIn() : inp({ y: leftRoof ? 0 : 0 }); });
    check("walking off a roof edge: falls, stays finite, recovers", r.ok && leftRoof && f.pos.y >= 0, `mode=${f.mode} y=${f.pos.y.toFixed(1)}`); }
}
