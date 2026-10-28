import type { Env } from "./env";

export type Weather = "clear" | "cloudy" | "rain";
export interface WeatherDef { name: string; sun: number; hemi: number; grey: number; fogNear: number; fogFar: number; cloudOpacity: number; liftScale: number; dragScale: number; rain: number; windMul: number }
export const WEATHER: Record<Weather, WeatherDef> = {
  clear:  { name: "晴", sun: 1, hemi: 1, grey: 0, fogNear: 140, fogFar: 900, cloudOpacity: 0.9, liftScale: 1, dragScale: 1, rain: 0, windMul: 1 },
  cloudy: { name: "曇", sun: 0.45, hemi: 0.9, grey: 0.55, fogNear: 110, fogFar: 750, cloudOpacity: 1, liftScale: 1, dragScale: 1, rain: 0, windMul: 1.3 },
  rain:   { name: "雨", sun: 0.25, hemi: 0.8, grey: 0.75, fogNear: 50, fogFar: 380, cloudOpacity: 1, liftScale: 0.93, dragScale: 1.12, rain: 1, windMul: 1.8 },
};
const lum = (c: number) => { const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255; return 0.3 * r + 0.59 * g + 0.11 * b; };
function greyer(c: number, t: number, dark: number) {
  const l = lum(c) * dark, ch = (v: number) => Math.round(v + (l - v) * t);
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}
/** 時刻の環境に天気を重ねる(純関数) */
export function applyWeather(e: Env, w: Weather): Env { return applyWeatherDef(e, WEATHER[w]); }
export function applyWeatherDef(e: Env, d: WeatherDef): Env {
  return { ...e,
    top: greyer(e.top, d.grey, 0.9), hor: greyer(e.hor, d.grey, 0.95), fog: greyer(e.fog, d.grey, 0.95),
    hemiSky: greyer(e.hemiSky, d.grey, 1), sun: greyer(e.sun, d.grey, 1), cloud: greyer(e.cloud, d.grey > 0 ? Math.min(1, d.grey + 0.2) : 0, d.grey > 0 ? 0.8 : 1),
    sunI: e.sunI * d.sun, hemiI: e.hemiI * d.hemi };
}
