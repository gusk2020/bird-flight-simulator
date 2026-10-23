# Vind Ving

*Bird Life & Flight Simulator*

Vind Ving (ヴィンド・ヴィング) is an AI-assisted experimental bird flight game for mobile browsers.

Repository and GitHub Pages URLs retain the existing `bird-flight-simulator` name to avoid disruption.

## Concept
- Fly as pigeons, sparrows, and crows in fictional Japanese towns.
- Prioritize enjoyable touch controls and repeated playtest/feedback iterations.
- Third-person and first-person cameras; assisted flight with flapping, gliding and wind.
- Later: multiple areas, day/night, seasons, weather, NPC birds and humans, optional missions.

## Development approach
- Owner: playtest on Android (Pixel 7a), decide what feels fun.
- ChatGPT: plan, prepare implementation requests, review code and tests.
- Claude: primary implementation, testing and fixes.
- Small playable iterations; no requirement for novelty or early polish.

## First prototype (v0.1)
- One pigeon and a small lightweight 3D test neighborhood.
- Touch controls for steering, altitude, flapping/gliding; assisted landing.
- Third-person camera with optional first-person switch.
- Deployable static web build; test on Android browser.
- Measure frame rate and identify control issues before adding systems.

## Guardrails
- Prefer open-source libraries/assets with verified compatible licenses.
- Do not reuse proprietary game code or assets without permission.
- Keep scope light enough for smartphone browsers.
- Use Draft PRs for implementation and review; do not merge without owner approval.

## v0.1
- Controls (landscape recommended): left-half drag = turn / climb-dive, 羽ばたき (hold = continuous), 減速 (brake / flare), top buttons: 時間帯 (day/dusk/night), 視点 (3rd/1st person), リセット.
- Land on roads, lots and rooftops; flap while landed to take off. Hard impacts stun briefly but never lock controls.
- Code: `src/params.ts` (all flight tuning numbers), `flight.ts` (fixed 60Hz physics, no rendering), `layout.ts` (town data), `world.ts`, `birdModel.ts`, `camera.ts`, `input.ts`.
- `npm run dev` / `npm run build` / `npm run test:sim` (headless physics scenarios).
- Trees and utility poles have no collision. No external models or assets are used (all geometry is generated).

## Stage A (quality)
- Camera: follows via a smoothed *offset from the bird* (yaw/pitch), not a lagged world position, so distance and view no longer drift during dives/brakes.
- 時間帯: 朝・昼・夕・夜 (`src/env.ts` keyframes by hour 0-24, ready for a continuous day cycle); windows and street lamps light up at dawn/dusk/night.
- Game flow (`src/game.ts`): 開始 / ⏸ 一時停止 / 再開. Pause freezes physics and game time, clears input, and the screen-off / app-switch / blur auto-pauses. Reset still works.
- Tests (all fail CI on error): `npm run test:unit` (physics, camera, game flow, environment), `npm run test:browser` (Chromium, touch/pause/landing/dive), `npm test` runs everything. CI: `.github/workflows/ci.yml`.
