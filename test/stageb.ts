import * as THREE from "three";
import { check, suite } from "./harness";
import { at, inp, run, L } from "./common";
import { Wind, bearingName } from "../src/wind";
import { WEATHER, applyWeather } from "../src/weather";
import { envAt } from "../src/env";
import { Quality, PIXEL_RATIOS } from "../src/quality";

export function stageBTests() {
  suite("wind (B)");
  const w = new Wind(L.colliders); w.set(270, 4, 0);
  const v = w.at(0, 30, 0, 0, new THREE.Vector3());
  check("west wind blows toward +x", v.x > 2 && Math.abs(v.z) < 0.01, `(${v.x.toFixed(2)},${v.z.toFixed(2)})`);
  w.set(0, 4, 0); const vn = w.at(0, 30, 0, 0, new THREE.Vector3());
  check("north wind blows toward +z (south)", vn.z > 2 && Math.abs(vn.x) < 0.01, `(${vn.x.toFixed(2)},${vn.z.toFixed(2)})`);
  check("bearing names", bearingName(270) === "西" && bearingName(0) === "北" && bearingName(361) === "北");
  w.set(270, 0, 0); check("calm = zero vector", w.at(10, 10, 10, 1, new THREE.Vector3()).length() === 0);
  w.set(270, 6, 0.6); let maxg = 0, fin = true;
  for (let t = 0; t < 60; t += 0.1) { const g = w.at(5, 20, 5, t, new THREE.Vector3()); fin = fin && Number.isFinite(g.length()); maxg = Math.max(maxg, g.length()); }
  check("gusts stay finite and bounded", fin && maxg < 14, `max=${maxg.toFixed(1)}`);
  // 建物の風上側に上昇気流、風下側にはない
  w.set(270, 6, 0);
  const a = L.apts[0], ac = L.colliders.find(c => Math.abs((c.minX + c.maxX) / 2 - a.x) < 0.01 && c.top === a.floors * 3.1)!;
  const mid = (ac.top) * 0.5, zc = (ac.minZ + ac.maxZ) / 2;
  const up = w.at(ac.minX - 4, mid, zc, 0, new THREE.Vector3()), lee = w.at(ac.maxX + 4, mid, zc, 0, new THREE.Vector3()), far = w.at(ac.minX - 60, mid, zc, 0, new THREE.Vector3());
  check("updraft on the windward side of a building", up.y > 1, `vy=${up.y.toFixed(2)}`);
  check("no updraft on the leeward side or far away", lee.y < 0.3 && far.y === 0, `lee=${lee.y.toFixed(2)} far=${far.y}`);

  suite("wind in flight (B)");
  { const calm = at(28, 80, 110, 0, 10), windy = at(28, 80, 110, 0, 10);
    const ww = new Wind(L.colliders); ww.set(270, 5, 0); windy.wind = ww;
    run(calm, 8, () => inp()); const r = run(windy, 8, () => inp());
    check("crosswind pushes the ground track sideways", r.finite && windy.pos.x - calm.pos.x > 18, `drift=${(windy.pos.x - calm.pos.x).toFixed(1)}m`);
    check("airspeed unaffected by crosswind", Math.abs(windy.airspeed - calm.airspeed) < 1.5, `${windy.airspeed.toFixed(1)} vs ${calm.airspeed.toFixed(1)}`);
    const head = at(28, 80, 110, 0, 10), hw = new Wind(L.colliders); hw.set(0, 5, 0); head.wind = hw; // 北風 = 向かい風 (機首は北=-z)
    run(head, 8, () => inp());
    check("headwind slows ground speed", head.speed < head.airspeed - 2, `ground=${head.speed.toFixed(1)} air=${head.airspeed.toFixed(1)}`); }
  { const clear = at(28, 80, 110), rain = at(28, 80, 110); rain.liftScale = WEATHER.rain.liftScale; rain.dragScale = WEATHER.rain.dragScale;
    run(clear, 10, () => inp()); run(rain, 10, () => inp());
    check("rain degrades glide (lower altitude after 10 s)", rain.pos.y < clear.pos.y - 1, `${rain.pos.y.toFixed(1)} < ${clear.pos.y.toFixed(1)}`); }
  { const f = at(28, 40, 110), ww = new Wind(L.colliders); ww.set(200, 12, 1); f.wind = ww; f.liftScale = 0.93; f.dragScale = 1.12;
    const r = run(f, 30, t => inp({ x: Math.sin(t), y: Math.cos(t * 0.7), flapHeld: t % 5 < 2 }));
    check("strong gusty wind + rain: stays finite and controllable", r.finite && f.resets === 1 + (f.pos.y < 0 ? 1 : 0), `resets=${f.resets - 1}`); }

  suite("weather (B)");
  const noon = envAt(12), clear = applyWeather(noon, "clear"), rainE = applyWeather(noon, "rain"), cloudy = applyWeather(noon, "cloudy");
  const sat = (c: number) => Math.max((c >> 16) & 255, (c >> 8) & 255, c & 255) - Math.min((c >> 16) & 255, (c >> 8) & 255, c & 255);
  check("clear weather leaves the environment unchanged", JSON.stringify(clear) === JSON.stringify(noon));
  check("rain/cloudy: dimmer sun, greyer sky", rainE.sunI < cloudy.sunI && cloudy.sunI < clear.sunI && sat(rainE.top) < sat(clear.top) && sat(cloudy.hor) <= sat(clear.hor));
  check("rain: shorter visibility, rain on", WEATHER.rain.fogFar < WEATHER.clear.fogFar && WEATHER.rain.rain === 1 && WEATHER.clear.rain === 0);
  let ok = true; for (let h = 0; h < 24; h += 0.5) for (const k of ["clear", "cloudy", "rain"] as const) { const e = applyWeather(envAt(h), k); ok = ok && Number.isFinite(e.sunI) && e.top >= 0 && e.top <= 0xffffff; }
  check("all hours x weathers produce valid values", ok);

  suite("quality / load management (B)");
  { const q = new Quality(); let changed = false;
    for (let i = 0; i < 200; i++) changed = q.update(1 / 20) || changed;
    check("sustained low FPS lowers resolution", changed && q.level >= 1 && q.pixelRatio < PIXEL_RATIOS[0], `level=${q.level}`);
    for (let i = 0; i < 4000; i++) q.update(1 / 20);
    check("never below the lowest level", q.level === PIXEL_RATIOS.length - 1);
    for (let i = 0; i < 6000; i++) q.update(1 / 60);
    check("recovers resolution when FPS is high for a long time", q.level < PIXEL_RATIOS.length - 1, `level=${q.level}`); }
  { const q = new Quality(); for (let i = 0; i < 5000; i++) q.update(1 / 45);
    check("mid FPS (45) is stable: no oscillation", q.level === 0); }
  { const q = new Quality(); let c = false; for (let i = 0; i < 100; i++) c = q.update(5) || c; for (let i = 0; i < 100; i++) c = q.update(0) || c;
    check("ignores abnormal frame times (resume / hidden tab)", !c && q.level === 0); }
}
