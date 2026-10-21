# Bird Flight Simulator

AI-assisted experimental bird flight game for mobile browsers.

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
