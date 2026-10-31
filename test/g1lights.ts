import { check, suite } from "./harness";
import { L } from "./common";
import { NpcWorld } from "../src/npc";
import * as THREE from "three";
import { NpcView } from "../src/npcView";
import { envAt } from "../src/env";

/** G1-1: 車のヘッドライト。three.js の描画なしで、NpcView が作るインスタンス数と透明度を確かめる(DOM不要) */
export function g1LightsTests() {
  suite("G1-1: car headlights");
  // 時刻との対応(窓・街灯と同じ点灯度): 昼0 / 夕方は上がり途中 / 夜1 / 朝0
  const lv = (h: number) => envAt(h).lights;
  check("lights level by time: noon 0, evening rising, night 1, dawn back to 0", lv(12) === 0 && lv(18) > 0.1 && lv(18) < 1 && lv(21) === 1 && lv(1) === 1 && lv(6) === 0 && lv(9) === 0, [12, 18, 21, 1, 6, 9].map(h => `${h}h=${lv(h).toFixed(2)}`).join(" "));
  const w = new NpcWorld(L, 11), view = new NpcView(), cam = { x: 0, y: 40, z: 0 } as never;
  w.setLevel(3, { x: 0, y: 40, z: 0, speed: 0, yaw: 0, air: true });
  for (let i = 0; i < 600; i++) w.update(1 / 60, { x: 0, y: 40, z: 0, speed: 0, yaw: 0, air: true }, 12);
  view.update(w, cam, 400, 0);
  const cars = w.visibleCars().length;
  check("daytime (lights=0): no headlamp is drawn", view.headlamps === 0 && cars > 3, `cars=${cars} lamps=${view.headlamps}`);
  view.update(w, cam, 400, 0.01); check("just below the threshold (0.01): still nothing", view.headlamps === 0);
  view.update(w, cam, 400, 1);
  check("night (lights=1): two lamps per visible car", view.headlamps === 2 * Math.min(cars, 18) && view.headlamps > 6, `lamps=${view.headlamps} cars=${cars}`);
  { // 向きの整合: 2灯の中点は車の進行方向(-sin yaw, -cos yaw)の約2.1m前、光円錐の中心線はさらに前方で、進行方向と平行
    const cs = w.visibleCars().slice(0, Math.min(cars, 18)); const m = new THREE.Matrix4(), v = new THREE.Vector3(), v2 = new THREE.Vector3(), a = new THREE.Vector3();
    let worst = 0, worstBeam = 0;
    cs.forEach((car, i) => {
      view.lamp.getMatrixAt(2 * i, m); v.setFromMatrixPosition(m); view.lamp.getMatrixAt(2 * i + 1, m); v2.setFromMatrixPosition(m);
      const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw), cx = (v.x + v2.x) / 2 - car.x, cz = (v.z + v2.z) / 2 - car.z;
      worst = Math.max(worst, Math.hypot(cx - fx * 2.12, cz - fz * 2.12), Math.abs(Math.hypot(v.x - v2.x, v.z - v2.z) - 1.3));
      view.beam.getMatrixAt(i, m); a.set(0, 0, -7).applyMatrix4(m); const bx = a.x - car.x, bz = a.z - car.z;
      worstBeam = Math.max(worstBeam, Math.hypot(bx - fx * 7, bz - fz * 7));
    });
    check("the lamps sit in front of each car (travel direction), 1.3 m apart", worst < 0.05, `max error ${worst.toFixed(3)} m over ${cs.length} cars`);
    check("the light cone points along the travel direction", worstBeam < 0.05, `max error ${worstBeam.toFixed(3)} m`);
  }
  view.update(w, cam, 400, 0.5); const mid = view.headlamps;
  view.update(w, cam, 400, 0); check("dawn/day turns them off again", mid === view.headlamps || view.headlamps === 0); check("...and they are gone at 0", view.headlamps === 0);
}
