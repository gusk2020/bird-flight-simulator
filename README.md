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

## C1 speed feel
- Dives now reach ~35 m/s (`maxDiveSpeed`/`flapMaxSpeed` in `src/params.ts`); flapping alone tops out ~18-22 m/s; braking holds a dive at ~17 m/s.
- 速度演出 (pause menu: なし/弱/標準/強): anime-style speed lines + vignette (2D canvas, 0 cost when off), world-space streaks, FOV/camera pull-back. Nothing is shown at normal speeds (<22 m/s). No frame skipping is used.
- Ground now carries a fine procedural texture (optical-flow cue when diving) and tree crowns use near/far LOD (triangles 106k -> ~66k measured).

## C2 ground life
- 朝焼け/朝は建物の窓・街灯が消灯（夕・夜は点灯、夜明けに向けて滑らかに消える）。
- 着地中は減速ボタンが「歩く」に。押し続けで歩行（スティックで向き）。羽ばたき短押し=小ジャンプ、長押し=離陸。
- 0.35m以下の段差は歩いて越え、それ以上は壁扱い。ベンチ/植え込み(約0.5m)へは小ジャンプで乗れ、1mの塀は乗れない。

## C3 wire perching
- Power lines are perches (`Layout.wires`, same data as the rendered wires). Hold 減速 while slow (<=8 m/s), not rising, and within 0.8 m of a wire to land; passing through never perches. Perched: 歩く moves along the wire, short flap = hop (to the next wire ~0.9 m away), long flap = take off.

## C4 living town
- `src/npc.ts` (logic, no rendering) + `src/npcView.ts` (instanced drawing). NPC birds (pigeon/sparrow/crow: fly, perch on wires/roofs, walk on the ground, flee when you rush at them, pigeon flocks you can join by flying alongside), pedestrians (walk lot sidewalks, stop/look at low birds, back away from fast ones), cars (left-hand lanes, signals, turns, following distance).
- Only the area around you is simulated in detail; far NPCs update at low rate or are re-placed near you. Menu: 街の動き (なし/少/標準/多), 画質 (自動/高/中/低). Activity follows the time of day.
- Not implemented: NPC/player collisions (everything passes through), car headlights, seasons.

## D1 one-hand controls
- 操作: 両手 / 右手 / 左手 (top button 操作 or pause menu; saved in localStorage `vindving.prefs.v1`, restored on start; the game always waits at the start screen).
- One-hand: touch anywhere on your half of the screen = floating stick (slide: turn / up-down). Tap = flap (on the ground: small hop). Long press = brake (on the ground: walk). Slid-then-held never becomes a brake; a long press never flaps on release.
- Thresholds live in `src/gesture.ts` (`GESTURE`), flap assist in `src/assist.ts` (`ASSIST`). The assist only adds `flapTap` when slow or low (never while braking, on the ground, hopping, perched, or just after a crash).

## D3: オート中の見せ方(カメラ・時間・天気・UI)
- カメラ: オート中だけ、10〜20秒ごとにカット(後方/ワイド/左右/高所/前方/一人称)をなめらかに切り替え。急降下・低空・着地・衝突では自動で通常の追従へ戻る。地面や屋根の下には入らない。
- 時間: オート中は 1日 = ゆったり20分 / 標準10分 / 高速3分。解除すると到達した時刻のまま(速度設定は保存)。
- 天気: 晴/曇/雨の間を連続的にゆっくり移り変わる(約60秒かけて変化)。解除しても到達した天気を維持。
- UI: オート中は約5秒操作がないと操作UIを隠し、タップで再表示(オート解除・行動方針・時間速度)。隠しても動作は止まらない。メニューでオフにできる。
- 設定(操作方式・行動方針・オート時間・UI自動非表示)は保存されるが、起動時に勝手にオートは始まらない。

## E1: カメラ安定化(羽ばたきの上下ブレ対策)
- 鳥の体・物理は変えず、カメラの「注視点の高さ」と「機首の揺れの伝わり方」だけをフィルタ。羽ばたき周期の往復は打ち消し、急降下・急上昇のような持続的な動きには遅れなく追従する。
- 着地・歩行中は素早く追従(地面の近くで浮かない)。一人称・三人称・オート観賞カットの全てに効く。
- 定量: `tools/camera_shake.ts`(羽ばたき周波数の上下振幅)。三人称 0.172→0.056 m、一人称 0.174→0.060 m。調整値は `tools/camera_tune.ts` が既存のカメラ試験(急降下・旋回・ブレーキ・建物)を全て満たす範囲から探索。
