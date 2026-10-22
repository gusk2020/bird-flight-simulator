import assert from "node:assert/strict";
import { Flight, FlightInput } from "../src/flight";
import { generateLayout } from "../src/layout";
const L = generateLayout();
const world = { colliders: L.colliders, heightAt: L.heightAt };
const inp = (o: Partial<FlightInput> = {}): FlightInput => ({ x: 0, y: 0, flapHeld: false, flapTap: false, brake: false, ...o });
const run = (name: string, f: Flight, secs: number, fn: (t: number) => FlightInput, log = 0) => {
  let bad = false;
  for (let i = 0; i < secs * 60; i++) {
    const t = i / 60; f.step(1 / 60, fn(t));
    if (log && i % (log * 60) === 0) console.log(`  t=${t.toFixed(0)} y=${f.pos.y.toFixed(1)} v=${f.speed.toFixed(1)} vy=${f.vel.y.toFixed(1)} pitch=${f.pitch.toFixed(2)} stall=${f.stall} mode=${f.mode}`);
    const values = [f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.vel.z, f.yaw, f.pitch, f.roll, f.speed];
    if (!values.every(Number.isFinite)) bad = true;
    assert.ok(values.every(Number.isFinite), name + ": nonfinite state at step " + i);
    assert.ok(f.pos.y >= -5, name + ": fell below safety floor at step " + i);
    assert.ok(["air", "rollout", "landed"].includes(f.mode), name + ": invalid mode");
    assert.ok(f.stun >= 0, name + ": negative stun time");
  }
  assert.equal(bad, false);
  console.log(name, `-> y=${f.pos.y.toFixed(1)} v=${f.speed.toFixed(1)} mode=${f.mode} crashes=${f.crashes} resets=${f.resets - 1} nan=${bad}`);
};
const at = (x: number, y: number, z: number, yaw = 0, vz = -10) => { const f = new Flight(world); f.pos.set(x, y, z); f.prevPos.copy(f.pos); f.yaw = yaw; f.vel.set(-Math.sin(yaw) * -vz * -1, 0, 0); f.vel.set(-Math.sin(yaw) * 10, 0, -Math.cos(yaw) * 10); return f; };
console.log("1 glide, no input"); run("glide", at(28, 60, 110), 20, () => inp(), 4);
console.log("2 hold flap"); run("flap", at(28, 30, 110), 15, () => inp({ flapHeld: true }), 3);
console.log("3 hard pull-up, no flap"); run("pullup", at(28, 100, 110), 15, () => inp({ y: 1 }), 2);
console.log("4 dive"); run("dive", at(28, 100, 110), 6, () => inp({ y: -1 }), 1);
console.log("5 full turn"); { const f = at(28, 100, 110); const y0 = f.yaw; run("turn", f, 3, () => inp({ x: 1 })); assert.ok(Math.abs(y0 - f.yaw) > 0.2, "turn input must change yaw"); console.log("  yaw change/3s", (y0 - f.yaw).toFixed(2), "alt", f.pos.y.toFixed(1)); }
console.log("6 land then takeoff"); { const f = at(28, 6, 110); run("land", f, 12, (t) => inp({ brake: t > 2 }), 2);
  run("takeoff", f, 4, () => inp({ flapHeld: true }), 1); }
console.log("7 wall: fly into apartment"); { const a = L.apts[0]; const f = at(a.x, 10, a.z + 40); run("wall", f, 6, () => inp()); const inside = L.colliders.some(c => f.pos.x > c.minX && f.pos.x < c.maxX && f.pos.z > c.minZ && f.pos.z < c.maxZ && f.pos.y - 0.1 < c.top); assert.equal(inside, false, "bird must not remain inside a building"); }
console.log("8 roof landing"); { const a = L.apts[0]; const top = a.floors * 3.1; const f = at(a.x, top + 1.5, a.z + 17); run("roof", f, 8, () => inp(), 1); console.log("  top", top); }
console.log("9 reset recovers"); { const f = at(28, 50, 110); f.pos.x = NaN; run("nan", f, 1, () => inp()); assert.ok(f.resets >= 2, "NaN must trigger automatic reset"); }
console.log("10 recovery after crash stun"); { const f = at(28, 40, 110); run("crashdive", f, 10, (t) => inp({ y: t < 4 ? -1 : 0 }), 2); run("next", f, 10, () => inp({ flapHeld: true }), 3); }

// Targeted state-transition tests with deterministic setup.
{
  const f = at(28, 50, 110);
  const initial = f.pos.clone();
  run("flap impulse", f, 1, () => inp({ flapHeld: true }));
  assert.ok(f.strokes > 0, "holding flap must produce strokes");
  assert.ok(f.pos.distanceTo(initial) > 0.1, "bird must move while flying");
}
{
  const f = at(28, 30, 110);
  f.mode = "landed"; f.vel.set(0, 0, 0);
  f.pos.y = world.heightAt(f.pos.x, f.pos.z) + 0.4;
  f.step(1 / 60, inp({ flapTap: true }));
  assert.equal(f.mode, "air", "flapping while landed must launch");
  assert.ok(f.vel.y > 0, "takeoff should give upward velocity");
}
{
  const f = at(28, 50, 110);
  f.pos.y = -100;
  f.step(1 / 60, inp());
  assert.ok(f.resets >= 2, "out-of-bounds fall must recover");
}
console.log("PASS: all flight assertions");
