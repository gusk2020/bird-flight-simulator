import * as THREE from "three";
import { check, suite } from "./harness";
import { at, inp, world } from "./common";
import { Flight, FlightInput } from "../src/flight";
import { FollowCam } from "../src/camera";
import { L } from "./common";

interface Res { maxJump: number; ndc: number; minD: number; maxD: number; acc: number; finalY: number; lag: number }
export function probe(setup: (f: Flight) => void, fn: (t: number) => FlightInput, secs: number, fps: number, jitter = false): Res {
  const f = new Flight(world); setup(f); f.prevPos.copy(f.pos);
  const cam = new THREE.PerspectiveCamera(66, 2, 0.1, 1800), fc = new FollowCam(cam, world);
  const STEP = 1 / 60; let acc = 0, t = 0, seed = 5;
  let prevDir: THREE.Vector3 | null = null, maxJump = 0, ndc = 0, minD = 1e9, maxD = 0, maxAcc = 0, lag = 0;
  const prevCam = new THREE.Vector3(), prevVel = new THREE.Vector3(), bp = new THREE.Vector3(), v = new THREE.Vector3(), nd = new THREE.Vector3();
  const n = Math.round(secs * fps);
  for (let i = 0; i < n; i++) {
    let dt = 1 / fps; if (jitter) { seed = (seed * 1664525 + 1013904223) >>> 0; dt *= 0.5 + (seed / 4294967296) * 1.5; }
    acc += dt; while (acc >= STEP) { f.step(STEP, fn(t)); acc -= STEP; t += STEP; }
    bp.lerpVectors(f.prevPos, f.pos, acc / STEP);
    fc.update(dt, f, bp); cam.updateMatrixWorld(); cam.getWorldDirection(v);
    if (prevDir) maxJump = Math.max(maxJump, v.angleTo(prevDir) * 180 / Math.PI / (dt * 60));
    prevDir = v.clone();
    nd.copy(bp).project(cam); ndc = Math.max(ndc, Math.hypot(nd.x, nd.y));
    const d = cam.position.distanceTo(bp); minD = Math.min(minD, d); maxD = Math.max(maxD, d);
    const cv = cam.position.clone().sub(prevCam).divideScalar(dt);
    if (i > 3) maxAcc = Math.max(maxAcc, cv.clone().sub(prevVel).length() / dt);
    prevVel.copy(cv); prevCam.copy(cam.position);
    // 鳥が画面中心の何度ずれて見えているか(背景がついてこない指標)
    lag = Math.max(lag, v.angleTo(bp.clone().sub(cam.position).normalize()) * 180 / Math.PI);
  }
  return { maxJump, ndc, minD, maxD, acc: maxAcc, finalY: f.pos.y, lag };
}
const air = (x: number, y: number, z: number, yaw = 0) => (f: Flight) => { f.pos.set(x, y, z); f.yaw = yaw; f.vel.set(-Math.sin(yaw) * 10, 0, -Math.cos(yaw) * 10); };

export function cameraTests() {
  suite("camera (A1: dive / brake / turn / building)");
  const a = L.apts[0];
  const cases: [string, (f: Flight) => void, (t: number) => FlightInput][] = [
    ["steep dive", air(28, 140, 110), () => inp({ y: -1 })],
    ["dive then brake", air(28, 140, 110), t => inp({ y: -1, brake: t > 1.5 })],
    ["hard turns", air(28, 100, 110), t => inp({ x: t % 2 < 1 ? 1 : -1 })],
    ["flap then hard brake", air(28, 100, 110), t => inp({ flapHeld: t < 3, brake: t > 3 })],
    ["near building", air(a.x, 12, a.z + 45), () => inp({ x: 0.3 })],
  ];
  for (const fps of [60, 30]) for (const [name, setup, fn] of cases) {
    const r = probe(setup, fn, 5, fps, fps === 30);
    const tag = `${name} @${fps}fps`;
    check(`${tag}: camera distance stays stable`, r.maxD - r.minD < 1.2 && r.maxD < 7, `${r.minD.toFixed(1)}..${r.maxD.toFixed(1)}`);
    check(`${tag}: bird stays near screen centre`, r.ndc < 0.3 && r.lag < 14, `ndc=${r.ndc.toFixed(2)} off=${r.lag.toFixed(1)}deg`);
    check(`${tag}: no view jump`, r.maxJump < 4, `${r.maxJump.toFixed(2)}deg/60Hz-frame`);
    if (name.includes("dive")) check(`${tag}: no camera shake`, r.acc < 60, `${r.acc.toFixed(0)}m/s2`);
  }
  // 急降下中は視線が機体の降下方向に追従する(背景が遅れない)
  const f = new Flight(world); air(28, 140, 110)(f); f.prevPos.copy(f.pos);
  const cam = new THREE.PerspectiveCamera(66, 2, 0.1, 1800), fc = new FollowCam(cam, world); const bp = new THREE.Vector3(), v = new THREE.Vector3();
  let t = 0; for (let i = 0; i < 180; i++) { f.step(1 / 60, inp({ y: -1 })); bp.copy(f.pos); fc.update(1 / 60, f, bp); t += 1 / 60; }
  cam.updateMatrixWorld(); cam.getWorldDirection(v);
  check("dive: camera looks downward along the dive", v.y < -0.2 && f.pitch < -0.5, `view.y=${v.y.toFixed(2)} pitch=${f.pitch.toFixed(2)}`);
}
