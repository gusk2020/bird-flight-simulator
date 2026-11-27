# KFM region → flyable terrain (import pilot)

Branch `feat/kfm-region-import-pilot`, based on `feat/kfm-region-adapter-draft` (4b76195). Draft; not for `main` / Pages without owner approval.
Scope: the KFM (`gusk2020/kudo-fudo-miseisen`, branch `claude/s43-overhaul`) → Vind Ving path only. No shared format, no shared library, no change to the default world.

## What it does
`region.html` (a separate page; not part of `npm run build`) loads a `kfm.region.v1` JSON, shows its **terrain** in 3D and lets the bird fly, land and collide on that same terrain.
Buildings, wires, landing surfaces and obstacles are **not in the data and are not made up**: only ground and water exist. KFM's roads/rails (open ones, ferries excluded) are drawn as lines and places as poles, labelled as the game's fictional history.

Try it: `npm run dev` then open `/region.html`; press "KFMの公開サンプルを読み込む" (fetches the public sample from the KFM repo on GitHub) or choose a JSON file. For a one-file build (no server; e.g. a phone preview): `node tools/bundle_region.mjs out.html test/fixtures/kfm-region-sample-kanto-1900.json`.
"標準のVind Vingへ戻る" goes back to `./index.html`, which is unchanged.

## One height array for drawing and flight
`src/regionTerrain.ts` builds `TerrainField` once: vertices are the KFM cell centres (no extra vertices), heights in Vind metres, a water flag per vertex, and one triangle layout (`terrainIndices`; diagonal a–d of each quad).
- Drawing (`src/regionView.ts`) uses `field.heights` and `terrainIndices` directly.
- Flight uses `field.heightAt` / `field.waterAt`, which interpolate over the same two triangles of each quad.
- `test/regionTerrain.ts` checks, with an independent triangle search over the mesh arrays only, that the two agree at 400 arbitrary points (max diff ~1e-13 m) and exactly at every vertex.
- Sea and lake vertices are water at 0 m (KFM stores a negative "depth for shading" in sea cells; it is not used as terrain). Land vertices below 0 m would be clipped to 0 (count shown on screen; 0 in the sample). Outside the vertex grid: ground 0 m, no data, a warning is shown; the cliff to that plane is closed visually by a skirt.

## Transform (one place: `regionTransform`)
Read from the schema: `grid.x0/y0/cellKm/nx/ny`, `frame.lon0/lat0/kmPerDegLon/kmPerDegLat`, `frame.heightDatum`, row 0 = south, values at cell centres.
- Vind x = east, y = up, **z = south** (three.js is right-handed; north is -z, so yaw 0 faces north). Origin = centre of the vertex grid.
- Scale: `REGION_SCALES`. Default **1/20** (1 km → 50 m, horizontal and vertical identical, so slope angles are real; no vertical exaggeration). Reason: real size takes about 2.8 h to cross 200 km at 20 m/s. **1/1** is selectable. The bird is not scaled. The chosen scale and reason are shown on screen and in the HUD. Nothing is scaled silently; the scale can be changed later by editing one array.
- Finding: the draft adapter (`kfmRegion.ts`) maps "+z = north". In a right-handed scene that mirrors the map. The pilot therefore does not use `regionToLayout`; it only reuses `readKfmRegion` (validation and decoding). The adapter itself is unchanged here.

## Resolution (three different things, kept apart)
- Nominal grid spacing: `grid.cellKm` (5 km in the sample). It is what the mesh uses.
- Effective terrain resolution: **not stated in the schema.** From KFM's own sources (not from the file): the underlying DEM is ~9.8 km (0.0879°), so the 5 km grid is an interpolation of it, and the game adds generated detail. The export does not say which cells are measured, interpolated or generated.
- Generated detail: the pilot adds none (no extra vertices, no noise). The on-screen text says fine relief is not measured.

## Flight limits
`Flight` had a fixed ±205 m box and a 160 m altitude cap (`PHYS.bound`, `PHYS.maxAltitude`). They are now instance fields (`flight.bound`, `flight.maxAltitude`) that default to those same values, so the default world behaves as before. The region page sets them from the terrain (`setFlightLimits`: grid extent + 2 cells; highest vertex + 160 m).

## Errors
Parse and validation failures are shown in Japanese with the original message in brackets; input is never corrected silently (wrong format string, bad lengths, a land value outside 0/1/2, cell size ≤ 0 … are refused). Tested.

## Not done / not verified
- Buildings, wires, perch/landing surfaces, NPCs, wind, weather, season, assists, auto-flight, one-hand controls: none in the region page (manual two-hand controls only).
- Land use is not shown; colours are a height ramp (decoration). Lakes (`land = 2`) are treated as water at 0 m (the sample has none; the lake level semantics are an assumption).
- A region wider than ~700×700 cells is refused by the adapter reader (500k cells).
- Real device (Pixel 7a) performance and touch feel: not checked. Desktop software-GL checks only.
- The KFM exporter is still a function without a UI; the sample JSON is the only real data used.

## Data
`test/fixtures/kfm-region-sample-kanto-1900.json` is an unmodified copy of KFM `docs/data/region-sample-kanto-1900.json` (see `test/fixtures/README.md`); it is used by tests and, optionally, embedded into the one-file bundle. It is not served by the app. Its `licence` array is shown when a file is loaded.
