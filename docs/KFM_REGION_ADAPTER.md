# KFM regional snapshot → Vind Ving adapter (Draft pilot)

**Permission:** User approved a Draft PR in Vind Ving, but no changes to main, Pages, or the existing live playable build. This branch follows that limit. Source: `gusk2020/kudo-fudo-miseisen` `src/sim/export41.ts` and `docs/SHARED-DATA41.md` (read-only). No changes to the KFM repository.

## Implemented
- `src/kfmRegion.ts` validates and reads `kfm.region.v1`; signed little-endian Int16 elevation, south-first Uint8 land (sea/land/lake), local equirectangular kilometre frame, population and road/railway polylines, source and licence.
- `regionToLayout(region, seed, focusPlaceId?)` gives an **existing full Vind Ving town Layout** and separate: bilinear regional ground heights (metres), land mask, city population-derived density, active road/rail proximity, suggested 49-lot use plan. Focus is named city or the most populous city; horizontal KFM kilometres convert to Vind metres (positive x east, positive z north). Facility ferry and closed/lost routes are not interpreted as physical streets.
- No random external data fetch; a caller passes the JSON. No UI button, no automatic file imports.
- Pure-data tests in `test/kfmRegion.ts` added to `test/all.ts`; malformed and oversized data rejected. **CI status is separately verifiable and must not be claimed green until verified.**

## Limitations / next stage
- **NOT rendered as Japanese geography yet**: `src/world.ts`, `src/main.ts`, flight physics and colliders remain entirely untouched. The terrain height is separate from the flight world on purpose: directly replacing `heightAt` would create invisible collision / landing hazards. The 49 `plannedLots` are metadata and do not replace existing buildings or perches.
- KFM's 5 km elevation grid cannot describe 56m blocks, roof edges, wires or the player's landing spots. Real integration needs a coherent world builder: local terrain mesh + elevating **all** buildings/colliders/perches/wires/land spots/flight start positions with the same ground reference, road orientation/density and building population budget; visual and physics must agree. Preserve existing default flight mode.
- Regional validity, attribution and offline sample integration should be confirmed before any public build. A national-sized region should be tiled/cropped for mobile memory.
- A simple experiment can consume KFM's already-exported `docs/data/region-sample-kanto-1900.json` via an explicit offline fixture in a later Draft branch, but no implicit network dependency or automatic public deployment.
- Source dataset licence array must be shown with future in-game import UI; raw JSON is not validated for provenance beyond shape/type.

## Testing and safety
- Expected: `npm run test:unit`, `npm run build`, existing browser/flight tests via CI. User-side Pixel 7a **not** yet checked.
- No existing gameplay files or Pages workflow modified. Do not merge, Ready, deploy or force-push without owner approval.
- User-facing reports must be short, outcomes only. Keep technical details and handoff here; smartphone operations minimal. Distinguish verified tests, inferred behavior and untested actual phone performance.
