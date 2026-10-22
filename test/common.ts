import { Flight, FlightInput } from "../src/flight";
import { generateLayout } from "../src/layout";
export const L = generateLayout();
export const world = { colliders: L.colliders, heightAt: L.heightAt };
export const inp = (o: Partial<FlightInput> = {}): FlightInput => ({ x: 0, y: 0, flapHeld: false, flapTap: false, brake: false, ...o });
export const at = (x: number, y: number, z: number, yaw = 0, speed = 10) => {
  const f = new Flight(world); f.pos.set(x, y, z); f.prevPos.copy(f.pos); f.yaw = yaw;
  f.vel.set(-Math.sin(yaw) * speed, 0, -Math.cos(yaw) * speed); return f;
};
export const finite = (f: Flight) => [f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.vel.z, f.yaw, f.pitch, f.roll].every(Number.isFinite);
export function run(f: Flight, secs: number, fn: (t: number) => FlightInput) {
  let ok = true, maxSpeed = 0;
  for (let i = 0; i < secs * 60; i++) { f.step(1 / 60, fn(i / 60)); ok = ok && finite(f); maxSpeed = Math.max(maxSpeed, f.speed); }
  return { finite: ok, maxSpeed };
}
export const insideBuilding = (f: Flight) => L.colliders.some(c => f.pos.x > c.minX && f.pos.x < c.maxX && f.pos.z > c.minZ && f.pos.z < c.maxZ && f.pos.y - 0.32 < c.top - 0.3);
