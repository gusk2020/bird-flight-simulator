import { check, suite } from "./harness";
import { at, inp } from "./common";
import { Game, STEP } from "../src/game";

export function gameTests() {
  suite("game: start / pause / resume (A3)");
  const f = at(28, 60, 110); let cleared = 0, released = 0;
  const g = new Game(f, () => inp({ flapHeld: true }), () => { cleared++; }); g.onPause = () => { released++; };
  const p0 = f.pos.clone();
  check("ready: no physics before start", g.update(1) === 0 && f.pos.equals(p0) && g.gameTime === 0);
  g.start(); const n = g.update(0.1);
  check("running: physics advances", n > 0 && !f.pos.equals(p0) && g.gameTime > 0.09, `steps=${n}`);
  g.pause(); const pp = f.pos.clone(), gt = g.gameTime, steps = g.steps;
  check("pause releases input", released === 1 && g.state === "paused");
  for (let i = 0; i < 600; i++) g.update(1);   // 10分分の経過
  check("paused: game time and physics frozen", g.update(5) === 0 && g.gameTime === gt && g.steps === steps && f.pos.equals(pp));
  g.resume();
  const before = f.pos.clone(); g.update(30); // 画面復帰直後に巨大なdtが来ても
  check("resume: no teleport after long gap", f.pos.distanceTo(before) < 0.1 * 25 + 1, `moved=${f.pos.distanceTo(before).toFixed(2)}m`);
  g.update(0.001); const sx = g.steps; g.update(STEP * 0.5);
  check("fixed step: sub-step dt accumulates", g.steps - sx <= 1);
  check("suspend (screen off) pauses", (g.suspend(), g.state === "paused") && released === 2);
  g.suspend(); check("suspend while paused is idempotent", released === 2);
  g.resume(); g.reset(); check("reset keeps game usable", g.state === "running" && f.resets >= 2 && Number.isFinite(f.pos.x));
  const g2 = new Game(at(0, 50, 0), () => inp(), () => {}); g2.suspend();
  check("suspend before start stays ready", g2.state === "ready");
  check("tap flag cleared each step", cleared > 0);
}
