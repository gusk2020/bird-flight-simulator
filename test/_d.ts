import { Flight } from "../src/flight";
import { generateLayout } from "../src/layout";
import { buildSurfaces } from "../src/perches";
import { PerchAssist } from "../src/perchassist";
import { AutoLand } from "../src/autoland";
import { PHYS as P } from "../src/params";
const L = generateLayout(); const world = { colliders: L.colliders, heightAt: L.heightAt, perchAt: L.perchAt, perchPoint: L.perchPoint, wireDir: L.wireDir, waterAt: L.waterAt };
const idx = buildSurfaces(L); const ss = idx.all.filter(s => s.kind === "rail");
let seed = 3; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
let shown = 0;
for (let i = 0; i < 80 && shown < 4; i++) { const s = ss[i % ss.length]; seed = 500 + i * 7 + s.id;
  const f = new Flight(world), pa = new PerchAssist(idx), al = new AutoLand(idx, pa, L.heightAt);
  const apt = L.apts.find(a => Math.abs((s.minX + s.maxX) / 2 - a.x) < a.w / 2 + 0.1 && Math.abs((s.minZ + s.maxZ) / 2 - a.z) < a.d / 2 + 1.5)!;
  const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2, ang = ((s.minZ + s.maxZ) / 2 > apt.z ? Math.PI / 2 : -Math.PI / 2) + (rnd() - 0.5) * 1.6, dist = 6 + rnd() * 10, h0 = s.top + 0.8 + rnd() * 4.2;
  f.pos.set(cx + Math.cos(ang) * dist, h0, cz + Math.sin(ang) * dist); f.prevPos.copy(f.pos); const toward = Math.atan2(-(cx - f.pos.x), -(cz - f.pos.z)); f.yaw = toward + (rnd() - 0.5) * 1.57; const v0 = 6 + rnd() * 5; f.vel.set(-Math.sin(f.yaw) * v0, -0.5, -Math.cos(f.yaw) * v0);
  if (!al.start(f, s)) continue;
  const log: string[] = []; const c0 = f.crashes;
  for (let k = 0; k < 60 * 6 && al.active; k++) { const raw = { x: 0, y: 0, flapHeld: false, flapTap: false, brake: false }; al.drive(f, raw); pa.apply(raw, f); f.step(1 / 60, raw);
    if (k % 8 === 0) { const d = Math.hypot(f.pos.x - Math.max(s.minX, Math.min(s.maxX, f.pos.x)), f.pos.z - Math.max(s.minZ, Math.min(s.maxZ, f.pos.z))); log.push(`t${(k/60).toFixed(1)} d${d.toFixed(1)} h${(f.pos.y - P.feetOffset - s.top).toFixed(2)} v${f.speed.toFixed(1)} vy${f.vel.y.toFixed(1)} z${(f.pos.z - cz).toFixed(1)} x${(f.pos.x - cx).toFixed(1)}`); }
    if (f.crashes > c0) { log.push("CRASH " + f.pos.x.toFixed(1) + "," + f.pos.z.toFixed(1)); break; } }
  if (f.crashes > c0) { shown++; console.log(i, "rail", JSON.stringify([s.minX.toFixed(1), s.maxX.toFixed(1), s.minZ.toFixed(1), s.maxZ.toFixed(1), s.top]), "apt", apt.x, apt.z, apt.d); console.log(log.join("\n")); } }
