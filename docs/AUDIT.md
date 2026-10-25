# Technical audit (performance / GC / design) — Vind Ving

Measured with `tools/bench.mjs` (headless Chromium + **software GL**, 892x412, dpr 1, 画質=高固定, 4 s per scenario, mean of 2 runs),
`tools/microbench.ts` (node/V8) and `tools/equiv.ts` (before/after behaviour equality). **None of these are Pixel 7a numbers.**
Software GL spends ~200 ms/frame rasterising, so FPS and "task ms" are not meaningful for comparison; JS time, allocation and
draw calls/triangles are.

## Verdicts
Confirmed and fixed (low risk, behaviour-identical):
- Paused/ready screen re-ran physics-free but full scene+NPC+draw every frame (paused: 183 ms/frame software GL, 31 KB/frame garbage) → draws only when something changed.
- Per-frame/per-step garbage: `for…of` iterators and `Math.hypot` in collision/wind/height lookups, `subarray` views in tree-LOD rebuild, `new Matrix4` per NPC wing, `filter/find` in NPC flock/escort/visible lists, tuple returned per pedestrian per frame, input object per physics step, sky colour rebuild every frame when time advances, vignette style written every frame.
Candidates not done (judged not worth the risk/complexity): spatial grid for colliders (heightAt 0.35 µs, physics step 2.6 µs), splitting `main.ts` (155 lines, one concern: wiring), removing `verify.yml` (could be a required status check; ~20 s duplicate), pinning Actions to SHAs, tree-shaking three (bundle 562 KB).
Keep as is: instancing/LOD design, NPC far-update throttling, fixed 60 Hz physics, adaptive quality, dependency set (only `three`; `playwright` is dev-only).

## Before → after (software GL; mean of 2 runs each)
| scenario | JS ms/frame | garbage KB/frame | draw calls / triangles |
|---|---|---|---|
| normal | 2.0 → 2.3 (noise) | 155 → 111 | 140 / 69k (same) |
| dive | 2.6 → 2.4 | 118 → 103 | 137 / 70k (same) |
| walk | 2.0 → 1.9 | 154 → 128 | 139 / 71k (same) |
| perch | 1.9 → 2.1 | 82 → 84 | 138 / 71k (same) |
| NPC max | 1.9 → 2.0 | 128 → 90 | 140 / 71k (same) |
| NPC off | 1.8 → 1.7 | 55 → 43 | 134 / 66k (same) |
| rain+wind | 1.7 → 1.9 | 88 → 53 | 141 / 69k (same) |
| **paused** | **1.4 → 0.09** | **31.5 → 0.2** | frames not drawn |
Note: at ~5 fps the loop runs 6 physics steps/frame, so physics share per frame is inflated vs. a 60 fps device.
Node micro-benchmarks (µs/call, 3 runs): Flight.step 5.2–8.1 → 2.6–4.4, heightAt 0.55 → 0.35, FollowCam.update 6.6 → 3.7–4.5, NpcWorld.update (14/40/16) ~46 → ~42–50 (unchanged).
Behaviour equality (`tools/equiv.ts`): glide, windy zig-zag, dive, land/walk/hop, wall, roof walk, wire perch and a 60 s NPC world are bit-identical (6 decimals) before/after.

## Future risks
- Real-device FPS/thermal behaviour is still unmeasured; `Quality` only reacts after 2 s below 38 fps.
- Browser tests depend on software-GL timing; two timing flakes were already fixed (resume distance, walking HUD). Prefer state/step-count assertions over wall-clock waits.
- Adding species/maps: `PHYS` is a single global (see docs/ROADMAP.md plan); layout is generated at load (fine up to a few hundred buildings, heightAt is O(colliders)).
- `__game` debug hook exposes internals in production (harmless, used by tests).
