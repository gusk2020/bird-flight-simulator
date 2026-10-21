import * as THREE from "three";

// ---- scene ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ccfee);
scene.fog = new THREE.Fog(0x9ccfee, 80, 400);
const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 600);
scene.add(new THREE.HemisphereLight(0xffffff, 0x667755, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(50, 100, 30);
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshLambertMaterial({ color: 0x6a9c55 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const buildings: { x: number; z: number; hw: number; hd: number; h: number }[] = [];
[[30, -40, 14, 12, 30], [-35, -70, 16, 16, 45], [60, -90, 12, 20, 22], [-60, -20, 12, 12, 18], [0, -130, 20, 14, 38], [90, -20, 14, 14, 26]]
  .forEach(([x, z, w, d, h], i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: [0xcfc8b8, 0xb8c4cf, 0xd8b8b0][i % 3] }));
    m.position.set(x, h / 2, z);
    scene.add(m);
    buildings.push({ x, z, hw: w / 2, hd: d / 2, h });
  });

// ---- pigeon (placeholder shape; faces -Z) ----
const bird = new THREE.Group();
const grey = new THREE.MeshLambertMaterial({ color: 0x8a8f9a });
const body = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), grey);
body.scale.set(1, 0.9, 1.7);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), new THREE.MeshLambertMaterial({ color: 0x5a6a80 }));
head.position.set(0, 0.2, -0.6);
const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.15, 6), new THREE.MeshLambertMaterial({ color: 0xe0a030 }));
beak.rotation.x = -Math.PI / 2; beak.position.set(0, 0.18, -0.8);
const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.4), grey);
tail.position.set(0, 0, 0.7);
const wingGeo = new THREE.BoxGeometry(0.9, 0.04, 0.45);
wingGeo.translate(0.45, 0, 0);
const wingL = new THREE.Mesh(wingGeo, grey);
const wingR = new THREE.Mesh(wingGeo, grey);
wingL.scale.x = -1;
wingL.position.set(-0.2, 0.05, -0.1); wingR.position.set(0.2, 0.05, -0.1);
bird.add(body, head, beak, tail, wingL, wingR);
scene.add(bird);

// ---- input ----
let steerX = 0, steerY = 0; // -1..1, up = +1 (climb)
let flapQueued = false, glideHeld = false;
const stickEl = document.getElementById("stick")!;
const knob = document.getElementById("knob")!;
let stickId = -1, ox = 0, oy = 0;
const R = 60;
stickEl.addEventListener("pointerdown", e => {
  stickId = e.pointerId; ox = e.clientX; oy = e.clientY; stickEl.setPointerCapture(e.pointerId);
  knob.style.display = "block"; knob.style.left = ox + "px"; knob.style.top = oy + "px";
});
stickEl.addEventListener("pointermove", e => {
  if (e.pointerId !== stickId) return;
  const dx = e.clientX - ox, dy = e.clientY - oy;
  steerX = Math.max(-1, Math.min(1, dx / R)); steerY = Math.max(-1, Math.min(1, -dy / R));
  knob.style.left = ox + steerX * R + "px"; knob.style.top = oy - steerY * R + "px";
});
const endStick = (e: PointerEvent) => {
  if (e.pointerId !== stickId) return;
  stickId = -1; steerX = steerY = 0; knob.style.display = "none";
};
stickEl.addEventListener("pointerup", endStick);
stickEl.addEventListener("pointercancel", endStick);
document.getElementById("flap")!.addEventListener("pointerdown", () => { flapQueued = true; });
const glide = document.getElementById("glide")!;
glide.addEventListener("pointerdown", () => { glideHeld = true; });
["pointerup", "pointercancel", "pointerleave"].forEach(t => glide.addEventListener(t, () => { glideHeld = false; }));
// keyboard for desktop testing
const keys = new Set<string>();
addEventListener("keydown", e => { keys.add(e.code); if (e.code === "Space") flapQueued = true; });
addEventListener("keyup", e => keys.delete(e.code));

// ---- flight model (simple approximation) ----
const G = 9.8, MASS = 1, WING_LIFT = 0.12, DRAG_K = 0.012, FLAP_THRUST = 7, FLAP_LIFT = 5;
const pos = new THREE.Vector3(0, 12, 20);
const vel = new THREE.Vector3(0, 0, -9);
let yaw = 0, pitch = 0, roll = 0, flapAnim = 0;
const fwd = new THREE.Vector3(), up = new THREE.Vector3(), tmp = new THREE.Vector3();
const hud = document.getElementById("hud")!;

function step(dt: number) {
  let sx = steerX, sy = steerY;
  if (keys.has("ArrowLeft") || keys.has("KeyA")) sx -= 1;
  if (keys.has("ArrowRight") || keys.has("KeyD")) sx += 1;
  if (keys.has("ArrowUp") || keys.has("KeyW")) sy += 1;
  if (keys.has("ArrowDown") || keys.has("KeyS")) sy -= 1;
  sx = Math.max(-1, Math.min(1, sx)); sy = Math.max(-1, Math.min(1, sy));
  const gliding = glideHeld || keys.has("ShiftLeft");

  // turning (bank-style) and pitch input
  yaw -= sx * 1.4 * dt;
  const pitchTarget = sy * 0.7;
  pitch += (pitchTarget - pitch) * Math.min(1, 3 * dt);
  roll += (-sx * 0.8 - roll) * Math.min(1, 5 * dt);

  fwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  // wing normal: perpendicular to forward, in the vertical plane
  up.set(Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch));

  const speed = vel.length();
  const f = new THREE.Vector3(0, -G * MASS, 0);                      // gravity
  f.addScaledVector(up, WING_LIFT * (gliding ? 1.3 : 1) * speed * speed * 0.5 * Math.max(0, fwd.dot(tmp.copy(vel).normalize())) * (speed > 0.1 ? 1 : 0)); // lift
  const dragK = DRAG_K * (gliding ? 0.6 : 1);
  f.addScaledVector(vel, -dragK * speed);                            // drag
  if (flapQueued) {                                                  // flap = impulse forward + up
    vel.addScaledVector(fwd, FLAP_THRUST * 0.35);
    vel.y += FLAP_LIFT * 0.45;
    flapAnim = 1; flapQueued = false;
  }
  vel.addScaledVector(f, dt / MASS);
  // inertia/steering: slowly align velocity with heading so turns carry through
  if (speed > 0.5) {
    const align = Math.min(1, 1.8 * dt);
    tmp.copy(fwd).multiplyScalar(speed);
    vel.lerp(tmp, align * 0.5);
  }
  if (vel.length() > 30) vel.setLength(30);
  pos.addScaledVector(vel, dt);

  // collisions: ground and building tops/walls (simple push-out)
  if (pos.y < 0.4) { pos.y = 0.4; if (vel.y < 0) vel.y = 0; vel.x *= 0.9; vel.z *= 0.9; }
  for (const b of buildings) {
    const dx = pos.x - b.x, dz = pos.z - b.z;
    if (Math.abs(dx) < b.hw + 0.4 && Math.abs(dz) < b.hd + 0.4 && pos.y < b.h + 0.4) {
      if (pos.y > b.h - 0.6) { pos.y = b.h + 0.4; if (vel.y < 0) vel.y = 0; }
      else if (b.hw + 0.4 - Math.abs(dx) < b.hd + 0.4 - Math.abs(dz)) { pos.x = b.x + Math.sign(dx || 1) * (b.hw + 0.4); vel.x = 0; }
      else { pos.z = b.z + Math.sign(dz || 1) * (b.hd + 0.4); vel.z = 0; }
    }
  }
  pos.x = Math.max(-480, Math.min(480, pos.x)); pos.z = Math.max(-480, Math.min(480, pos.z));

  // visuals
  bird.position.copy(pos);
  bird.rotation.set(pitch, yaw, roll, "YXZ");
  flapAnim = Math.max(0, flapAnim - dt * 4);
  const ang = gliding ? 0.05 : Math.sin(flapAnim * Math.PI) * 0.9;
  wingR.rotation.z = ang; wingL.rotation.z = -ang;
  // chase camera
  const camTarget = tmp.set(Math.sin(yaw) * 5, 0, Math.cos(yaw) * 5).add(pos).add(new THREE.Vector3(0, 2 + pitch * -1.5, 0));
  camera.position.lerp(camTarget, Math.min(1, 4 * dt));
  camera.lookAt(pos.x, pos.y + 0.3, pos.z);
  hud.textContent = `高度 ${pos.y.toFixed(0)}m  速度 ${vel.length().toFixed(0)}m/s`;
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}
addEventListener("resize", resize); resize();
camera.position.set(0, 14, 25);
let last = performance.now();
renderer.setAnimationLoop(now => {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  step(dt); renderer.render(scene, camera);
});
