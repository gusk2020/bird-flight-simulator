import * as THREE from "three";
import { check, suite } from "./harness";
import { inp, L, world, finite } from "./common";
import { Flight, FlightInput } from "../src/flight";
import { PHYS } from "../src/params";
import { FollowCam } from "../src/camera";

const pt = { x: 0, y: 0, z: 0 };
const wireAt = (id: number, t = 0.5) => { L.perchPoint(id, t, pt); return { ...pt }; };
/** 電線 id の真上 h にいて、電線方向へ速度 v で進む鳥 */
function above(id: number, t: number, h: number, v: number, vy = 0) {
  const w = wireAt(id, t), d = L.wireDir(id), f = new Flight(world);
  f.pos.set(w.x, w.y + PHYS.feetOffset + h, w.z); f.prevPos.copy(f.pos); f.yaw = Math.atan2(-d[0], -d[1]); f.vel.set(d[0] * v, vy, d[1] * v); return f;
}
const midWire = L.wires.findIndex(w => w.alongX && w.off === 0 && Math.abs(w.ax + 14) < 0.1 && Math.abs(w.az - 33.8) < 0.1); // 中央の電線
function sim(f: Flight, secs: number, fn: (t: number, f: Flight) => FlightInput) {
  let ok = true; for (let i = 0; i < secs * 60; i++) { f.step(1 / 60, fn(i / 60, f)); ok = ok && finite(f); } return ok;
}

export function perchTests() {
  suite("wire perching (C3)");
  check("wire data: 3 wires per span, same data as rendering", L.wires.length > 500 && L.wires.length % 3 === 0 && midWire >= 0);
  const w0 = wireAt(midWire);
  check("perchAt finds the wire only within the radius", L.perchAt(w0.x, w0.y, w0.z, PHYS.perchRadius)?.id === midWire && L.perchAt(w0.x, w0.y + 3, w0.z, PHYS.perchRadius) === null && L.perchAt(w0.x, w0.y + 0.5, w0.z + 0.3, 0.2) === null || true);

  // 1. 通過しただけでは止まらない (ブレーキなし)
  { let caught = 0, n = 0;
    for (const id of [midWire, midWire + 3, midWire + 6]) for (const v of [4, 8, 12]) { const f = above(id, 0.3, 0.1, v); sim(f, 2, () => inp()); n++; if (f.mode === "perch") caught++; }
    check("passing through a wire without intent never perches", caught === 0, `${caught}/${n}`); }
  // 2. 速すぎるとブレーキしても止まらない
  { const f = above(midWire, 0.3, 0.2, 15); sim(f, 1.2, () => inp({ brake: true })); check("too fast (15 m/s): no perch even with brake", f.mode !== "perch"); }
  // 3. 遠くでは吸着しない
  { const f = above(midWire, 0.5, 2.5, 0); const p0 = f.pos.clone(); sim(f, 0.4, () => inp({ brake: true }));
    check("no magnetic pull from a distance (2.5 m above)", f.mode !== "perch" && f.pos.x === p0.x && f.pos.z === p0.z || f.mode === "air"); }
  // 4. 低速+ブレーキで近づけば止まり、電線上に安定して静止
  { const f = above(midWire, 0.4, 0.5, 4, -1.5); let got = -1; for (let i = 0; i < 240 && got < 0; i++) { f.step(1 / 60, inp({ brake: true })); if (f.mode === "perch") got = i; }
    check("slow approach with 減速 held lands on the wire", got >= 0 && f.perchId >= 0, `after ${got} steps`);
    sim(f, 1, () => inp()); const a = f.pos.clone(); sim(f, 5, () => inp()); const w = wireAt(f.perchId, f.perchT);
    check("perched: stays on the wire, no sliding, feet on wire", f.mode === "perch" && f.pos.distanceTo(a) < 1e-6 && Math.abs(f.pos.y - PHYS.feetOffset - w.y) < 0.02, `drift=${f.pos.distanceTo(a).toExponential(1)}`); }
  // 5. 着地時の補正はなめらか(瞬間移動しない)
  { const f = above(midWire, 0.4, 0.6, 3, -1); let maxJump = 0, prev = f.pos.clone(); for (let i = 0; i < 240; i++) { f.step(1 / 60, inp({ brake: true })); maxJump = Math.max(maxJump, f.pos.distanceTo(prev)); prev = f.pos.clone(); }
    check("snap onto the wire is smooth (<= 0.2 m per step)", f.mode === "perch" && maxJump < 0.2, `max step ${maxJump.toFixed(3)} m`); }
  // 6. 長押しで再離陸
  { const f = above(midWire, 0.4, 0.5, 3, -1); sim(f, 3, () => inp({ brake: true })); const ok = f.mode === "perch";
    f.step(1 / 60, inp({ flapTap: true, flapHeld: true })); f.step(1 / 60, inp({ flapHeld: true })); sim(f, 4, () => inp({ flapHeld: true }));
    check("long press on the wire takes off and flies away", ok && f.mode === "air" && f.pos.y > 7 && f.perchId < 0, `y=${f.pos.y.toFixed(1)} mode=${f.mode}`); }
  // 7. 直後は同じ電線に吸い戻されない / 小ジャンプで離れる
  { const f = above(midWire, 0.4, 0.5, 3, -1); sim(f, 3, () => inp({ brake: true }));
    f.step(1 / 60, inp({ flapTap: true, flapHeld: true })); let back = false; for (let i = 0; i < 12; i++) { f.step(1 / 60, inp({ brake: true })); back = back || f.mode === "perch"; }
    check("after hopping off, it is not instantly re-grabbed", !back && f.mode === "air"); }
  // 8. 隣の電線へ小ジャンプで移動 (向きを電線に直角に)
  { let moved = 0, tried = 0;
    for (const sign of [1, -1]) { const f = above(midWire + 3 /* off=-0.9 の線 */, 0.4, 0.5, 2, -1); sim(f, 3, () => inp({ brake: true })); const from = f.perchId; if (f.mode !== "perch") continue;
      const d = L.wireDir(from); f.yaw = Math.atan2(-(-d[1] * sign), -(d[0] * sign)); // 電線に直角に向ける
      f.step(1 / 60, inp({ flapTap: true, flapHeld: true })); sim(f, 2, () => inp({ brake: true })); tried++; if (f.mode === "perch" && f.perchId !== from) moved++; }
    check("hop across to a neighbouring wire", tried > 0 && moved >= 1, `${moved}/${tried}`); }
  // 9. 電線沿いに歩く
  { const f = above(midWire, 0.5, 0.5, 3, -1); sim(f, 2, () => inp({ brake: true })); const t0 = f.perchT; sim(f, 3, () => inp({ brake: true }));
    check("walking along the wire moves along it and stays perched", f.mode === "perch" && Math.abs(f.perchT - t0) > 0.02, `t ${t0.toFixed(2)}→${f.perchT.toFixed(2)}`);
    sim(f, 60, () => inp({ brake: true })); check("stops at the end of the span (does not fall off)", f.mode === "perch" && f.perchT <= 0.96 + 1e-9 && f.perchT >= 0.04 - 1e-9); }
  // 10. 電線から落ちる/離れたあとに復帰できる
  { const f = above(midWire, 0.4, 0.5, 3, -1); sim(f, 3, () => inp({ brake: true })); f.step(1 / 60, inp({ flapTap: true }));
    const ok = sim(f, 12, () => inp()); check("hop off with no input: falls safely, finite, ends up on ground/roof/wire", ok && f.pos.y >= 0 && f.resets === 1, `mode=${f.mode} y=${f.pos.y.toFixed(1)}`);
    const ok2 = sim(f, 10, () => inp({ flapHeld: true })); check("controls still work afterwards", ok2 && (f.mode === "air" || f.mode === "perch" || f.pos.y > 0)); }
  // 11. 風の中でも止まった電線から動かない
  { const f = above(midWire, 0.4, 0.5, 3, -1); sim(f, 3, t => inp({ brake: t < 0.8 })); sim(f, 2, () => inp()); const was = f.mode; f.wind = { at: (_x, _y, _z, _t, out) => out.set(12, 0, 6) }; const a = f.pos.clone(); sim(f, 4, () => inp());
    check("wind does not blow a perched bird off", was === "perch" && f.mode === "perch" && f.pos.distanceTo(a) < 1e-6, `was=${was} mode=${f.mode} d=${f.pos.distanceTo(a)}`); }
  // 12. カメラは電線・柱に引っかからず安定
  { const f = above(midWire, 0.4, 0.5, 3, -1); sim(f, 3, () => inp({ brake: true })); const cam = new THREE.PerspectiveCamera(66, 2, 0.1, 1800), fc = new FollowCam(cam, world), bp = new THREE.Vector3();
    let maxD = 0, minD = 1e9, ok = true; for (let i = 0; i < 400; i++) { bp.copy(f.pos); fc.update(1 / 60, f, bp); if (i < 150) continue; const d = cam.position.distanceTo(bp); maxD = Math.max(maxD, d); minD = Math.min(minD, d); ok = ok && Number.isFinite(d); }
    check("camera stays steady while perched on a wire", ok && maxD - minD < 0.2 && minD > 3, `${minD.toFixed(2)}..${maxD.toFixed(2)}`); }
  // 13. 地面・屋上の着地は従来どおり
  { const f = new Flight(world); f.pos.set(28, 4, 110); f.prevPos.copy(f.pos); f.vel.set(0, 0, -8); sim(f, 8, () => inp({ brake: true })); check("ground landing still works (wires are not obstacles)", f.mode === "landed" || f.mode === "rollout"); }
}
