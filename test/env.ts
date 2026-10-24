import { check, suite } from "./harness";
import { envAt, TIME_PRESETS } from "../src/env";

export function envTests() {
  suite("environment (A2: dawn / continuous cycle)");
  const warm = (c: number) => ((c >> 16) & 255) - (c & 255); // R - B
  const dawn = envAt(6), noon = envAt(12), dusk = envAt(17.5), night = envAt(0);
  check("presets include 朝", TIME_PRESETS.some(p => p.name === "朝") && TIME_PRESETS.length === 4);
  check("dawn horizon is warm (orange/pink)", warm(dawn.hor) > 60, `R-B=${warm(dawn.hor)}`);
  check("noon horizon is not warm", warm(noon.hor) < 20);
  check("dawn sun is low and east of noon sun", dawn.sunDir[1] < noon.sunDir[1] && dawn.sunDir[0] > 0);
  check("windows/lamps: on at night and dusk, OFF at dawn and noon", night.lights === 1 && dawn.lights === 0 && noon.lights === 0 && dusk.lights > 0.3);
  check("lights fade out smoothly toward morning", envAt(4.5).lights === 1 && envAt(5).lights > 0 && envAt(5).lights < 1 && envAt(5.6).lights === 0 && envAt(7).lights === 0);
  check("dawn is brighter than night, darker than noon", dawn.sunI > night.sunI && dawn.sunI < noon.sunI);
  check("cycle wraps (0h == 24h)", JSON.stringify(envAt(0)) === JSON.stringify(envAt(24)) && JSON.stringify(envAt(-1)) === JSON.stringify(envAt(23)));
  let maxStep = 0, prev = envAt(0), finite = true;
  for (let h = 0.05; h <= 24; h += 0.05) {
    const e = envAt(h); finite = finite && Number.isFinite(e.sunI) && Number.isFinite(e.lights);
    maxStep = Math.max(maxStep, Math.abs(e.sunI - prev.sunI), Math.abs(e.lights - prev.lights), Math.abs(e.hemiI - prev.hemiI)); prev = e;
  }
  check("continuous: no jumps across the 24h cycle", finite && maxStep < 0.25, `max step=${maxStep.toFixed(3)}`);
}
