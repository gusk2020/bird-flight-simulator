import { check, suite } from "./harness";
import { at, inp, L } from "./common";
import { AUTO_DAY_SECONDS, CameraDirector, SHOTS, UI_HIDE_AFTER_S, UiHider, WeatherDrift, autoHoursPerSecond, weatherAtLevel } from "../src/autoview";
import { WEATHER } from "../src/weather";
import { FollowCam } from "../src/camera";
import { Autopilot } from "../src/autopilot";
import * as THREE from "three";

export function autoViewTests() {
  suite("auto view (D3)");
  check("auto day length: ゆったり 20 min, 標準 10 min, 高速 3 min", AUTO_DAY_SECONDS.slow === 1200 && AUTO_DAY_SECONDS.normal === 600 && AUTO_DAY_SECONDS.fast === 180);
  check("hours per second matches (24h in the stated minutes)", Math.abs(autoHoursPerSecond("normal") * 600 - 24) < 1e-9 && Math.abs(autoHoursPerSecond("fast") * 180 - 24) < 1e-9);
  { const a = weatherAtLevel(0), b = weatherAtLevel(2), m = weatherAtLevel(0.5);
    check("weather level 0/1/2 equal the three presets", weatherAtLevel(0).fogFar === WEATHER.clear.fogFar && weatherAtLevel(1).grey === WEATHER.cloudy.grey && b.rain === WEATHER.rain.rain);
    check("in-between levels interpolate smoothly", m.grey > a.grey && m.grey < WEATHER.cloudy.grey && weatherAtLevel(1.5).rain > 0 && weatherAtLevel(1.5).rain < 1); }
  { const d = new WeatherDrift(0, 3); let maxStep = 0, last = d.level, changes = 0, tgt = d.target;
    for (let i = 0; i < 60 * 60 * 20; i++) { const l = d.update(1 / 60); maxStep = Math.max(maxStep, Math.abs(l - last)); last = l; if (d.target !== tgt) { changes++; tgt = d.target; } }
    check("weather drift: never jumps (<= 1/60 level per second)", maxStep <= WeatherDrift.RATE / 60 + 1e-9);
    check("weather drift: changes slowly over 20 min (a few times, not every second)", changes >= 2 && changes <= 30, String(changes));
    check("weather drift: level stays within 0..2", last >= 0 && last <= 2); }
  { const d = new CameraDirector(5), f = at(0, 60, 0, 0, 14); f.step(1 / 60, inp()); f.agl = 60; let sw = 0, last = d.shot.name; const seen = new Set<string>();
    for (let i = 0; i < 60 * 300; i++) { d.update(1 / 60, f); if (d.shot.name !== last) { sw++; last = d.shot.name; seen.add(last); } }
    check("director: many different shots over 5 min, but not every second", seen.size >= 4 && sw >= 10 && sw <= 40, `${seen.size}/${sw}`); }
  { const d = new CameraDirector(9), f = at(0, 60, 0, 0, 14); f.step(1 / 60, inp()); f.agl = 60; for (let i = 0; i < 60 * 60; i++) d.update(1 / 60, f);
    f.pos.y = 3; f.agl = 3; d.update(1 / 60, f);
    check("director: low altitude / landing forces the chase shot", d.shot === SHOTS.chase);
    const g = at(0, 60, 0, 0, 14); g.step(1 / 60, inp()); g.agl = 60; g.vel.y = -12; const h = at(0, 60, 0, 0, 14); h.step(1 / 60, inp()); h.agl = 60; const e = new CameraDirector(9); for (let i = 0; i < 60 * 60; i++) e.update(1 / 60, h); e.update(1 / 60, g);
    check("director: a steep dive forces the chase shot", e.shot === SHOTS.chase); }
  { const cam = new THREE.PerspectiveCamera(), fc = new FollowCam(cam, { heightAt: L.heightAt }), f = at(0, 60, 0, 0, 14), bp = new THREE.Vector3(0, 60, 0); fc.update(1 / 60, f, bp, 0);
    const p0 = cam.position.clone(); fc.update(1 / 60, f, bp, 0); const still = cam.position.distanceTo(p0);
    fc.setShot(1.25, 1.5, 0.5); let worst = 0, prev = cam.position.clone(); for (let i = 0; i < 300; i++) { fc.update(1 / 60, f, bp, 0); worst = Math.max(worst, cam.position.distanceTo(prev)); prev.copy(cam.position); }
    check("camera: default shot leaves the camera unchanged", still < 1e-9);
    check("camera: shot switch moves the camera smoothly (<0.3 m per frame)", worst < 0.3 && cam.position.distanceTo(p0) > 2, worst.toFixed(3));
    const pp = cam.position.clone(); fc.setShot(0, 1, 0); for (let i = 0; i < 600; i++) fc.update(1 / 60, f, bp, 0);
    check("camera: returning to the chase shot comes back to the original place", cam.position.distanceTo(p0) < 0.05 && pp.distanceTo(p0) > 1); }
  { const f = at(0, 60, 0, 0, 14), p0 = f.pos.clone(); const cam = new THREE.PerspectiveCamera(), fc = new FollowCam(cam, { heightAt: L.heightAt }), d = new CameraDirector(2), bp = new THREE.Vector3(); let into = 0;
    const ap = new Autopilot(L, 3); ap.setPolicy("life"); ap.start(f); const o = inp();
    for (let i = 0; i < 60 * 150; i++) { o.flapTap = false; ap.drive(f, o, 1 / 60); f.step(1 / 60, o); const sh = d.update(1 / 60, f); fc.setShot(sh.yaw, sh.dist, sh.h); bp.copy(f.pos); fc.update(1 / 60, f, bp, 0); if (cam.position.y < L.heightAt(cam.position.x, cam.position.z) + 0.1) into++; }
    check("camera never goes under the ground/roof during a 2.5 min auto flight", into === 0, String(into)); void p0; }
  { const u = new UiHider(); let hid = false; for (let i = 0; i < 60 * (UI_HIDE_AFTER_S - 1); i++) hid = u.update(1 / 60, true);
    check("UI stays visible before 5 s", !hid); for (let i = 0; i < 120; i++) hid = u.update(1 / 60, true);
    check("UI hides after ~5 s idle during auto", hid); u.touch(); check("a tap shows it again and restarts the timer", !u.hidden && !u.update(1 / 60, true));
    for (let i = 0; i < 60 * 10; i++) u.update(1 / 60, false); check("never hides when auto is off", !u.hidden); }
}
