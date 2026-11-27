/**
 * Non-invasive adapter for the "kfm.region.v1" regional snapshot exported by
 * 酷道・腐道・未成線.  All conversion is deterministic and in metres.
 *
 * This is deliberately NOT attached to the live World/flight renderer yet:
 * Vind Ving's roofs, colliders, wires and landing surfaces are authored in
 * its own flat local frame. Offsetting only heightAt would make birds collide
 * with invisible terrain. The pilot returns the existing usable layout and
 * regional terrain/settlement/transport information separately.
 */
import { generateLayout, type Layout, type LotUse } from "./layout";

export interface KfmRegion {
  format: "kfm.region.v1";
  source: { game: string; year: number; seed: number; note: string };
  licence: string[];
  frame: { kind: "equirect-local-km"; lon0: number; lat0: number; kmPerDegLon: number; kmPerDegLat: number; heightDatum: string };
  grid: { x0: number; y0: number; cellKm: number; nx: number; ny: number; elevM: string; land: string };
  places: { id: string; name: string; kind: string; x: number; y: number; pop: number }[];
  lines: { id: string; mode: "road" | "rail"; kind: string; state: string; facility?: string; pts: number[] }[];
}

export interface RegionLayoutPlan {
  /** Existing collision/perch-safe Vind Ving town, unchanged. */
  layout: Layout;
  /** Region origin in KFM km; Vind x/z are metres, and positive z is north. */
  focus: { x: number; y: number };
  source: KfmRegion["source"];
  licence: string[];
  /** Bilinear regional relief in metres, relative to the KFM sea datum. */
  terrainHeightAt(xMetres: number, zMetres: number): number;
  /** 0 sea / 1 land / 2 inland lake, or null outside the grid. */
  landAt(xMetres: number, zMetres: number): 0 | 1 | 2 | null;
  /** 0..1 regional urban influence inferred from exported population. */
  densityAt(xMetres: number, zMetres: number): number;
  /** Active road and railway corridor proximity in metres. */
  transportAt(xMetres: number, zMetres: number): { roadM: number; railM: number };
  /** Suggested terrain-aware uses of all 49 lots, for a future *coherent*
   * renderer/collider conversion; does NOT mutate the live layout. */
  plannedLots: { x: number; z: number; use: LotUse }[];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const MAX_CELLS = 500_000, MAX_LINES = 20_000;
const decode = (s: string): Uint8Array => {
  if (typeof s !== "string" || s.length > MAX_CELLS * 4 || s.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) throw new Error("Invalid KFM base64");
  const raw = atob(s), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

export function readKfmRegion(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid KFM snapshot");
  const f = raw as KfmRegion, g = f.grid;
  if (f.format !== "kfm.region.v1" || f.frame?.kind !== "equirect-local-km" || !g) throw new Error("Unsupported KFM format");
  if (!Number.isSafeInteger(g.nx) || !Number.isSafeInteger(g.ny) || g.nx < 2 || g.ny < 2 || g.nx * g.ny > MAX_CELLS ||
      !finite(g.cellKm) || g.cellKm <= 0 || !finite(g.x0) || !finite(g.y0)) throw new Error("Invalid KFM grid");
  if (![f.frame.lon0, f.frame.lat0, f.frame.kmPerDegLon, f.frame.kmPerDegLat].every(finite) ||
      f.frame.kmPerDegLat <= 0 || f.frame.kmPerDegLon <= 0) throw new Error("Invalid KFM projection");
  if (!f.source || !finite(f.source.year) || !finite(f.source.seed) || !Array.isArray(f.licence) ||
      !f.licence.every(x => typeof x === "string") || !Array.isArray(f.places) || !Array.isArray(f.lines) || f.lines.length > MAX_LINES) throw new Error("Invalid KFM metadata");
  const heightBytes = decode(g.elevM), land = decode(g.land), count = g.nx * g.ny;
  if (heightBytes.length !== count * 2 || land.length !== count || land.some(v => v > 2)) throw new Error("Invalid KFM raster length/land");
  const dv = new DataView(heightBytes.buffer), elev = new Int16Array(count);
  for (let k = 0; k < count; k++) elev[k] = dv.getInt16(k * 2, true);
  for (const p of f.places) if (!p || typeof p.id !== "string" || !finite(p.x) || !finite(p.y) || !finite(p.pop) || p.pop < 0) throw new Error("Invalid KFM place");
  for (const l of f.lines) {
    if (!l || !["road", "rail"].includes(l.mode) || typeof l.state !== "string" || !Array.isArray(l.pts) ||
        l.pts.length < 4 || l.pts.length % 2 || l.pts.length > 100_000 || !l.pts.every(finite)) throw new Error("Invalid KFM line");
  }
  const cell = (x: number, y: number) => {
    const i = Math.floor((x - g.x0) / g.cellKm), j = Math.floor((y - g.y0) / g.cellKm);
    return i >= 0 && i < g.nx && j >= 0 && j < g.ny ? j * g.nx + i : -1;
  };
  const heightAtKm = (x: number, y: number): number => {
    if (cell(x, y) < 0) return NaN;
    // Grid positions refer to CELL CENTRES (row 0 = south).
    const u = clamp((x - g.x0) / g.cellKm - .5, 0, g.nx - 1);
    const v = clamp((y - g.y0) / g.cellKm - .5, 0, g.ny - 1);
    const i = Math.floor(u), j = Math.floor(v), ix = Math.min(i + 1, g.nx - 1), jy = Math.min(j + 1, g.ny - 1);
    const tx = u - i, ty = v - j;
    const a = elev[j * g.nx + i] * (1 - tx) + elev[j * g.nx + ix] * tx;
    const b = elev[jy * g.nx + i] * (1 - tx) + elev[jy * g.nx + ix] * tx;
    return a * (1 - ty) + b * ty;
  };
  return { file: f, elev, land, landAtKm: (x: number, y: number) => { const k = cell(x, y); return k < 0 ? null : land[k] as 0 | 1 | 2; }, heightAtKm,
    lonLat: (x: number, y: number): [number, number] => [f.frame.lon0 + x / f.frame.kmPerDegLon, f.frame.lat0 + y / f.frame.kmPerDegLat] };
}

const segmentDist = (x: number, y: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax, dy = by - ay, q = dx * dx + dy * dy;
  const t = q ? clamp(((x - ax) * dx + (y - ay) * dy) / q, 0, 1) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};
const hashLot = (x: number, z: number, seed: number) => {
  let h = (Math.imul(Math.round(x), 73856093) ^ Math.imul(Math.round(z), 19349663) ^ Math.imul(seed, 83492791)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};

/** Converts one exported snapshot to a non-destructive, collision-safe town
 * plan. Region location is centred on a named place or the most populous
 * place; map X and Y become Vind's local X and Z, both multiplied by 1000. */
export function regionToLayout(raw: unknown, seed = 7, focusPlaceId?: string): RegionLayoutPlan {
  const r = readKfmRegion(raw), f = r.file;
  const focusPlace = focusPlaceId ? f.places.find(p => p.id === focusPlaceId) : [...f.places].sort((a, b) => b.pop - a.pop)[0];
  if (focusPlaceId && !focusPlace) throw new Error("Unknown KFM focus place");
  const focus = focusPlace ? { x: focusPlace.x, y: focusPlace.y } :
    { x: f.grid.x0 + f.grid.nx * f.grid.cellKm / 2, y: f.grid.y0 + f.grid.ny * f.grid.cellKm / 2 };
  const layout = generateLayout(seed);
  const coords = (x: number, z: number) => [focus.x + x / 1000, focus.y + z / 1000] as const;
  const corridors = f.lines.filter(l => l.state === "open" && l.facility !== "ferry" && (l.mode === "road" || l.mode === "rail"));
  const transportAt = (x: number, z: number) => {
    const [rx, ry] = coords(x, z); let road = Infinity, rail = Infinity;
    for (const l of corridors) for (let k = 0; k + 3 < l.pts.length; k += 2) {
      const d = segmentDist(rx, ry, l.pts[k], l.pts[k + 1], l.pts[k + 2], l.pts[k + 3]) * 1000;
      if (l.mode === "road") road = Math.min(road, d); else rail = Math.min(rail, d);
    }
    return { roadM: road, railM: rail };
  };
  const densityAt = (x: number, z: number) => {
    const [rx, ry] = coords(x, z);
    // Smooth broad influence: coarse KFM data is NOT a street-level land-use map.
    let influence = 0;
    for (const p of f.places) {
      const km = Math.hypot(rx - p.x, ry - p.y);
      influence += Math.log10(1 + p.pop) / 7 * Math.exp(-km / 12);
    }
    return clamp(influence, 0, 1);
  };
  const plannedLots = layout.lots.map(lot => {
    const den = densityAt(lot.x, lot.z), near = transportAt(lot.x, lot.z), t = hashLot(lot.x, lot.z, seed);
    const use: LotUse = lot.park ? "park" : r.landAtKm(...coords(lot.x, lot.z)) !== 1 ? "vacant" :
      den > .45 || near.roadM < 35 ? (t < .08 ? "park" : "town") :
      t < den * .75 ? "town" : t < .55 ? "paddy" : "vacant";
    return { x: lot.x, z: lot.z, use };
  });
  return { layout, focus, source: f.source, licence: [...f.licence],
    terrainHeightAt: (x, z) => r.heightAtKm(...coords(x, z)),
    landAt: (x, z) => r.landAtKm(...coords(x, z)),
    densityAt, transportAt, plannedLots };
}
