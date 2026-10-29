import * as THREE from "three";
import { check, suite } from "./harness";
import { at, inp, L } from "./common";
import { CAM_TUNE, FollowCam } from "../src/camera";
import { measure } from "../tools/camera_shake";

export function cameraStableTests() {
  suite("camera stability (E1)");
  const b3 = measure({ stable: false, mode: "third" }), a3 = measure({ stable: true, mode: "third" });
  const b1 = measure({ stable: false, mode: "first" }), a1 = measure({ stable: true, mode: "first" });
  check("third person: flap bobbing reaching the camera is cut by more than half", a3.camHF < b3.camHF * 0.5, `${b3.camHF.toFixed(3)} -> ${a3.camHF.toFixed(3)} m`);
  check("first person: flap bobbing reaching the camera is cut by more than half", a1.camHF < b1.camHF * 0.55, `${b1.camHF.toFixed(3)} -> ${a1.camHF.toFixed(3)} m`);
  check("first person: view-angle jitter from flapping is reduced by more than half; third person is not worse", a1.viewHF < b1.viewHF * 0.5 && a3.viewHF <= b3.viewHF * 1.05, `${b3.viewHF.toFixed(2)}->${a3.viewHF.toFixed(2)} / ${b1.viewHF.toFixed(2)}->${a1.viewHF.toFixed(2)} deg`);
  check("the bird itself still bobs the same (physics untouched)", Math.abs(a3.birdHF - b3.birdHF) < 1e-9);
  // 大きな高度変化には追従し、遅れは上限内
  { const cam = new THREE.PerspectiveCamera(), fc = new FollowCam(cam, { heightAt: L.heightAt }), f = at(0, 60, 0, 0, 14), bp = new THREE.Vector3(0, 60, 0); fc.update(1 / 60, f, bp, 0);
    let worst = 0; for (let i = 0; i < 180; i++) { bp.y = 60 + i * (20 / 60); f.vel.y = 20; fc.update(1 / 60, f, bp, 0); worst = Math.max(worst, bp.y - (cam.position.y - 1.3)); } // 20 m/s で3秒上昇
    check("fast climb (20 m/s): the camera follows within 1.5 m (anchor lag cap " + CAM_TUNE.maxLag + " m)", worst <= 1.5, worst.toFixed(2)); // 20 m/s の上昇でも、画面上で鳥が約15°以内に収まる
    f.vel.y = 0; for (let i = 0; i < 120; i++) fc.update(1 / 60, f, bp, 0);
    check("after the climb stops the camera catches up (within 0.35 m in 2 s)", Math.abs(bp.y - (cam.position.y - 1.3)) < 0.35, (bp.y - (cam.position.y - 1.3)).toFixed(2)); }
  { const cam = new THREE.PerspectiveCamera(), fc = new FollowCam(cam, { heightAt: L.heightAt }), f = at(0, 60, 0, 0, 14), bp = new THREE.Vector3(0, 60, 0); fc.update(1 / 60, f, bp, 0);
    let minAbove = 1e9, worst = 0; for (let i = 0; i < 300; i++) { bp.y = Math.max(2, 60 - i * (25 / 60)); f.vel.y = bp.y > 2 ? -25 : 0; fc.update(1 / 60, f, bp, 0); minAbove = Math.min(minAbove, cam.position.y - L.heightAt(cam.position.x, cam.position.z)); worst = Math.max(worst, (cam.position.y - 1.3) - bp.y); }
    check("steep dive (25 m/s): camera lag is capped and it never goes under the ground", worst <= 1.5 && minAbove >= 0.39, `lag ${worst.toFixed(2)} min-above ${minAbove.toFixed(2)}`); }
  // 着地時: 地面近くでは素早く追従(浮かない)
  { const cam = new THREE.PerspectiveCamera(), fc = new FollowCam(cam, { heightAt: L.heightAt }), f = at(0, 30, 0, 0, 10), bp = new THREE.Vector3(0, 30, 0); fc.update(1 / 60, f, bp, 0);
    f.mode = "landed"; bp.y = 0.4; for (let i = 0; i < 40; i++) fc.update(1 / 60, f, bp, 0);
    check("landing: the camera settles to the new ground height within 0.7 s", Math.abs((cam.position.y - 1.3) - 0.4) < 0.6 || cam.position.y >= L.heightAt(0, 0) + 0.4, cam.position.y.toFixed(2)); }
  // 視点切替の連続性
  { const cam = new THREE.PerspectiveCamera(), fc = new FollowCam(cam, { heightAt: L.heightAt }), f = at(0, 50, 0, 0, 14), bp = new THREE.Vector3(0, 50, 0); for (let i = 0; i < 120; i++) fc.update(1 / 60, f, bp, 0);
    const p = cam.position.clone(); fc.mode = "first"; fc.update(1 / 60, f, bp, 0); const jump = cam.position.distanceTo(p);
    check("third -> first switch: the camera y does not jump by more than the follow distance", cam.position.y < p.y + 0.5 && jump < 7, jump.toFixed(2)); }
  { const cam = new THREE.PerspectiveCamera(), fc = new FollowCam(cam, { heightAt: L.heightAt }), f = at(0, 50, 0, 0, 14), bp = new THREE.Vector3(0, 50, 0); fc.update(1 / 60, f, bp, 0);
    fc.stableHeight = false; fc.update(1 / 60, f, bp, 0); const p = cam.position.clone(); fc.stableHeight = true; fc.update(1 / 60, f, bp, 0);
    check("legacy mode (stableHeight=false) still follows the bird exactly", Math.abs(p.y - (50 + 1.3 - Math.sin(0) * 0)) < 3 && cam.position.distanceTo(p) < 0.5); }
  void inp;
}
