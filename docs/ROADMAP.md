# Roadmap / WIP (not implemented unless marked done)

| Stage | Status | PR |
|---|---|---|
| A quality (camera, dawn, start/pause, tests+CI) | implemented, awaiting audit | #3 |
| B environment (wind, updraft, weather, time cycle, load mgmt) | implemented, awaiting audit; depends on A | stage-b PR |
| C species + flocks | **plan only** | - |
| D living town | **plan only** | - |
| E game structure | **plan only** | - |

## Stage C plan (foundation first)
1. Extract per-species parameters from `src/params.ts` into `src/species.ts` (`SpeciesDef`: mass-ish scale, liftK, flapThrust, flapLift, turnRate, maxSpeed, strokeTime, wing/body geometry builder). `Flight` takes a `SpeciesDef` instead of the global `PHYS` (pigeon = current values, so behaviour is unchanged and covered by existing tests).
2. Sparrow (small, quick strokes, tight turns, low glide ratio, hops on ground) and crow (larger, slow strokes, high glide ratio, walks). Species change handling, not just looks: add unit tests asserting glide ratio / turn rate / stroke frequency ordering.
3. Ground locomotion states (walk / hop) added to `Flight.ground`.
4. NPC birds: reuse `Flight` with an AI input generator (steer toward waypoint, flap when below target altitude). Near NPCs (<60 m) stepped at 60 Hz, far ones at 10 Hz with straight-line interpolation. Cap ~12 birds.
5. Flocks: boids-lite (separation/alignment/cohesion) for NPC groups; player joins by flying within range and matching heading; leaves by steering away.

## Stage D plan
Pedestrian/car agents on the road graph from `layout.ts`, active only within ~120 m of the player; time-of-day activity curves from `env.ts` hours; foraging spots as data in `layout.ts`; hunger/fatigue as two scalars ticking only in `Game.update`; seasons as a tint/vegetation parameter next to `Env`.

## Stage E plan
Save/load of `{species, unlocks, settings, position}` in `localStorage` (versioned); mission/challenge definitions as data (checkpoint rings, landing targets) evaluated in `Game`; difficulty = crash consequence table; multiple maps = `generateLayout(seed, preset)`.
