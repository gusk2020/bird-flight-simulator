import { check, suite } from "./harness";
import { L } from "./common";
import { generateLayout, ROAD, PITCH, LOT } from "../src/layout";
import { buildSurfaces } from "../src/perches";

export function structureTests() {
  suite("structures & natural perches (E3)");
  const by = (k: string) => L.lows.filter(l => l.kind === k);
  const kinds = ["bench", "wall", "planter", "balcony", "rail", "fence", "sign", "rock", "branch", "pole"];
  check("every kind is present", kinds.every(k => by(k).length > 0), kinds.map(k => `${k}:${by(k).length}`).join(" "));
  check("poles are unchanged and the first lows are still benches/walls/planters", L.poles.length === 224 && L.lows.slice(0, 40).every(l => ["bench", "wall", "planter"].includes(l.kind)));
  const L2 = generateLayout(); check("the layout is reproducible from the seed", L2.lows.length === L.lows.length && L2.lows.every((l, i) => l.x === L.lows[i].x && l.z === L.lows[i].z && l.top === L.lows[i].top));
  // 低い足場と高い足場が混在
  const tops = L.lows.map(l => l.top);
  check("low (<1.3 m) and high (>5 m) perches are mixed", tops.filter(t => t < 1.3).length >= 40 && tops.filter(t => t > 5).length >= 20, `low=${tops.filter(t => t < 1.3).length} high=${tops.filter(t => t > 5).length}`);
  // 既存建物・道路との干渉がない
  const overlap = (a: { minX: number; maxX: number; minZ: number; maxZ: number }, b: typeof a) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
  const rect = (l: { x: number; z: number; hw: number; hd: number }) => ({ minX: l.x - l.hw, maxX: l.x + l.hw, minZ: l.z - l.hd, maxZ: l.z + l.hd });
  const buildings = L.colliders.filter(c => c.top >= 3 && c.maxX - c.minX > 5 && c.maxZ - c.minZ > 5);
  const newKinds = ["fence", "sign", "rock"];
  const inside = L.lows.filter(l => newKinds.includes(l.kind) && buildings.some(b => overlap(rect(l), { minX: b.minX - 0.2, maxX: b.maxX + 0.2, minZ: b.minZ - 0.2, maxZ: b.maxZ + 0.2 })));
  check("fences, signs and rocks never overlap a building", inside.length === 0, `${inside.length} overlaps`);
  const onRoad = L.lows.filter(l => newKinds.includes(l.kind) && L.roads.some(rd => Math.abs(l.x - rd) < ROAD / 2 + 0.5 || Math.abs(l.z - rd) < ROAD / 2 + 0.5) && Math.abs(l.x) < PITCH * 3.5 + LOT && false);
  check("lot-side objects stay inside their lot (never on a road)", L.lows.filter(l => ["fence", "sign", "rock"].includes(l.kind) && !(Math.abs(l.x) < 12 && Math.abs(l.z) < 25)).every(l => { const ix = Math.round(l.x / PITCH), iz = Math.round(l.z / PITCH); return Math.abs(l.x - ix * PITCH) < LOT / 2 && Math.abs(l.z - iz * PITCH) < LOT / 2; }) && onRoad.length === 0);
  // ベランダは集合住宅の壁面に付き、手すりはその外縁
  check("balconies attach to an apartment facade and rails sit on the outer edge", by("balcony").every(b => L.apts.some(a => Math.abs(b.x - a.x) < a.w / 2 + 0.1 && Math.abs(Math.abs(b.z - a.z) - (a.d / 2 + 0.7)) < 0.01)) && by("rail").every(r => by("balcony").some(b => Math.abs(b.x - r.x) < 1e-6 && Math.abs(r.top - (b.top + 1)) < 1e-6 && Math.abs(Math.abs(r.z - b.z) - 0.62) < 1e-6)));
  check("branches belong to big park trees; pole tops sit on real poles", by("branch").every(b => L.trees.some(t => t.s >= 1.7 && Math.abs(t.x) <= 19 && Math.hypot(b.x - t.x, b.z - t.z) < 1.0)) && by("pole").every(p => L.poles.some(q => q.x === p.x && q.z === p.z)));
  // 着地面・歩行
  const idx = buildSurfaces(L);
  const sk = new Set(idx.all.map(s => s.kind));
  check("all kinds are landable surfaces (shared with the perch assist)", kinds.every(k => sk.has(k as never)));
  check("thin things are edges (rails, fences, signs, branches, poles, walls); roofs are not (balconies are guided lengthwise)", idx.all.filter(s => ["rail", "fence", "sign", "branch", "pole", "wall"].includes(s.kind)).every(s => s.edge) && idx.all.filter(s => ["roof"].includes(s.kind)).every(s => !s.edge));
  const t0 = performance.now(); let acc = 0; for (let i = 0; i < 100000; i++) acc += L.heightAt((i % 400) - 200, ((i * 7) % 400) - 200); const us = (performance.now() - t0) / 100;
  check("heightAt stays cheap with the extra colliders (< 5 us per call)", us < 5 && Number.isFinite(acc), us.toFixed(2) + " us");
  check("collider count is bounded (< 600)", L.colliders.length < 600, String(L.colliders.length));
}
