import { check, suite } from "./harness";
import { generateLayout } from "../src/layout";
import { readKfmRegion, regionToLayout } from "../src/kfmRegion";

const encoded = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const sample = () => ({
  format: "kfm.region.v1", source: { game: "kudo-fudo-miseisen", year: 1900, seed: 7, note: "fictional" },
  licence: ["GEBCO Compilation Group (2026)"], frame: { kind: "equirect-local-km", lon0: 137, lat0: 37, kmPerDegLon: 90, kmPerDegLat: 110, heightDatum: "GEBCO 0m" },
  grid: { x0: 0, y0: 0, cellKm: 5, nx: 2, ny: 2,
    elevM: encoded([100, 0, 200, 0, 44, 1, 144, 1]), land: encoded([1, 1, 1, 0]) },
  places: [{ id: "tokyo", name: "東京", kind: "city", x: 2.5, y: 2.5, pop: 1000000 }],
  lines: [{ id: "r1", mode: "road", kind: "road", state: "open", pts: [2.5, 2.5, 7.5, 2.5] },
    { id: "rail", mode: "rail", kind: "rail", state: "open", pts: [2.5, 2.5, 2.5, 7.5] },
    { id: "old", mode: "road", kind: "road", state: "closed", pts: [0, 9, 10, 9] }]
});

export function kfmRegionTests() {
  suite("KFM: cross-game region adapter, no live-world changes");
  const src = sample(), dec = readKfmRegion(src), p = regionToLayout(src, 7, "tokyo");
  check("little-endian signed height and south-first rows", dec.elev[0] === 100 && dec.elev[1] === 200 && dec.elev[2] === 300 && dec.elev[3] === 400);
  check("KFM km to Vind metre axes (x/east, z/north)", p.terrainHeightAt(0, 0) === 100 && p.terrainHeightAt(5000, 0) === 200 && p.terrainHeightAt(0, 5000) === 300);
  check("interpolated height at exact cell midpoint", Math.abs(p.terrainHeightAt(2500, 2500) - 250) < 1e-9);
  check("outside raster returns missing, lake/sea retained", Number.isNaN(p.terrainHeightAt(-10000, 0)) && p.landAt(5000, 5000) === 0 && p.landAt(-10000, 0) === null);
  check("active corridors only; closed route excluded", p.transportAt(0, 0).roadM === 0 && p.transportAt(0, 0).railM === 0 &&
    p.transportAt(1000, 0).roadM === 0 && p.transportAt(0, 1000).railM === 0);
  check("population drives deterministic density", p.densityAt(0, 0) > p.densityAt(100000, 100000));
  check("lot plan exists without altering collision-safe town", p.plannedLots.length === p.layout.lots.length &&
    p.layout.houses.length === generateLayout(7).houses.length &&
    p.layout.colliders.length === generateLayout(7).colliders.length &&
    p.plannedLots.some(l => l.use === "town"));
  check("provenance and licences carried", p.source.year === 1900 && p.licence[0].includes("GEBCO"));
  const invalid = (mut: (v: ReturnType<typeof sample>) => void) => { const s = sample(); mut(s); try { readKfmRegion(s); return false; } catch { return true; } };
  check("rejects bad format, corrupt lengths, unsupported land and invalid routes",
    invalid(s => { s.format = "kfm.region.v2"; }) &&
    invalid(s => { s.grid.land = encoded([1]); }) &&
    invalid(s => { s.grid.land = encoded([1, 1, 1, 3]); }) &&
    invalid(s => { s.lines[0].pts = [0, 1, 2]; }));
  let rejected = false; try { regionToLayout(sample(), 7, "missing"); } catch { rejected = true; }
  check("rejects missing focus instead of silently choosing another city", rejected);
}
