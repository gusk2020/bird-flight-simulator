import { check, suite } from "./harness";
import { at, inp, run, L, world } from "./common";
import { GESTURE, OneHandGesture } from "../src/gesture";
import { ASSIST, FlapAssist } from "../src/assist";
import { DEFAULT_PREFS, PREFS_KEY, loadPrefs, sanitizePrefs, savePrefs } from "../src/settings";
import { Flight } from "../src/flight";

export function oneHandTests() {
  suite("one-hand gestures (D1)");
  const t0 = 1000;
  { const g = new OneHandGesture(); g.down(1, 500, 300, t0); g.poll(t0 + 100); g.up(1, t0 + 120);
    check("short touch = tap (one flap)", g.consumeTap() && !g.consumeTap() && !g.brake && !g.active); }
  { const g = new OneHandGesture(); g.down(1, 500, 300, t0); g.poll(t0 + GESTURE.longPressMs + 1);
    check("hold without moving = brake (long press)", g.brake && g.phase === "brake"); g.up(1, t0 + 900);
    check("releasing after a long press does NOT flap and clears brake", !g.consumeTap() && !g.brake && !g.active); }
  { const g = new OneHandGesture(); g.down(1, 500, 300, t0); g.move(1, 500 + GESTURE.moveThresholdPx + 3, 300); g.poll(t0 + 2000);
    check("moving past the threshold = stick; time passing never turns it into a brake", g.phase === "stick" && !g.brake && g.x !== 0);
    g.move(1, 500, 300); g.poll(t0 + 5000); g.up(1, t0 + 5100);
    check("returning to the origin keeps it a stick; release gives no tap", !g.consumeTap() && !g.brake); }
  { const g = new OneHandGesture(); g.down(1, 500, 300, t0, 60); g.move(1, 500 + 60, 300 - 60); check("stick: right+up -> x>0, y>0, clamped to the unit circle", g.x > 0.6 && g.y > 0.6 && g.x * g.x + g.y * g.y <= 1.0001); g.move(1, 500, 300 + 60); check("stick: down -> y<0", g.y < -0.9);
    g.move(1, 504, 302); check("small movement inside the move threshold stays pending (no stick output)", g.phase === "stick" || (g.x === 0 && g.y === 0)); }
  { const g = new OneHandGesture(); g.down(1, 500, 300, t0); g.poll(t0 + GESTURE.longPressMs + 1); g.move(1, 500 + 40, 300);
    check("moving during a long press switches to stick and releases the brake", g.phase === "stick" && !g.brake); }
  { const g = new OneHandGesture(); check("only the first finger is accepted", g.down(1, 500, 300, t0) && !g.down(2, 600, 300, t0 + 10)); g.move(2, 800, 300); check("other fingers' moves are ignored", g.x === 0); g.up(2, t0 + 20); check("other fingers' release is ignored", g.active); g.up(1, t0 + 50); check("then the first finger can finish as a tap", g.consumeTap()); }
  { const g = new OneHandGesture(); g.down(1, 500, 300, t0); g.move(1, 560, 300); g.cancel(); check("cancel (pointercancel / pause / app switch) clears everything", !g.active && g.x === 0 && g.y === 0 && !g.brake && !g.consumeTap()); }
  { const g = new OneHandGesture(); g.down(1, 500, 300, t0); g.up(1, t0 + 270); check("no dead zone: a release at 270 ms (between the old 250 ms tap limit and the 300 ms long press) is a tap", g.consumeTap() && !g.brake); }
  { const g = new OneHandGesture(); g.down(1, 500, 300, t0); g.up(1, t0 + GESTURE.longPressMs - 1); check("release 1 ms before the long press is a tap", g.consumeTap()); }
  { const g = new OneHandGesture(); g.down(1, 500, 300, t0); g.up(1, t0 + GESTURE.longPressMs); check("release at exactly the long-press time is not a tap (it is a long press)", !g.consumeTap()); }
  { const g = new OneHandGesture(); for (let i = 0; i < 50; i++) { g.down(i + 1, 500, 300, t0 + i * 10); g.up(i + 1, t0 + i * 10 + 20); } let n = 0; while (g.consumeTap()) n++; check("rapid tapping: every tap counts once", n === 50, `${n}`); }

  suite("flap assist (D1)");
  const mkAir = (speed: number, y: number) => { const f = at(28, y, 110, 0, speed); f.step(1 / 60, inp()); return f; };
  { const a = new FlapAssist(); a.enabled = true; const f = mkAir(4, 40); f.strokeT = -1; const i = a.apply(inp(), f); check("assist flaps when speed is too low", i.flapTap && a.autoFlaps === 1); }
  { const a = new FlapAssist(); a.enabled = true; const f = mkAir(10, 60); check("no assist during normal gliding", !a.apply(inp(), f).flapTap); }
  { const a = new FlapAssist(); a.enabled = true; const f = mkAir(4, 40); check("no assist while braking (long press) - landing approach", !a.apply(inp({ brake: true }), f).flapTap); }
  { const a = new FlapAssist(); a.enabled = false; const f = mkAir(4, 40); check("disabled assist (two-hand mode) never flaps", !a.apply(inp(), f).flapTap); }
  { const a = new FlapAssist(); a.enabled = true; const f = mkAir(4, 40); a.apply(inp(), f); const f2 = mkAir(4, 40); f2.clock = f.clock + 0.2; check("cooldown prevents spamming", !a.apply(inp(), f2).flapTap); f2.clock = f.clock + ASSIST.cooldown + 0.1; check("...and flaps again after the cooldown", a.apply(inp(), f2).flapTap); }
  { const a = new FlapAssist(); a.enabled = true; const f = new Flight(world); f.pos.set(28, 0.32, 110); f.mode = "landed"; check("no assist on the ground: taps stay available for hops", !a.apply(inp(), f).flapTap); }
  { const a = new FlapAssist(); a.enabled = true; const f = mkAir(3, 40); f.hopping = true; check("no assist during a small hop", !a.apply(inp(), f).flapTap); }
  { // 実際に使うと: 低速からでも自動羽ばたきで高度を保つ/回復し、墜落しない
    const a = new FlapAssist(); a.enabled = true; const f = at(28, 30, 150, 0, 3); let fin = true, minY = 99;
    for (let i = 0; i < 60 * 14; i++) { f.step(1 / 60, a.apply(inp(), f)); fin = fin && Number.isFinite(f.pos.y); if (i > 60 * 6) minY = Math.min(minY, f.pos.y); }
    check("with assist, a slow bird recovers and keeps cruising (14 s along a road, never touches down)", fin && f.mode === "air" && minY > 4 && a.autoFlaps > 4, `minY=${minY.toFixed(1)} flaps=${a.autoFlaps}`);
    const b = at(28, 30, 150, 0, 3); for (let i = 0; i < 60 * 14; i++) b.step(1 / 60, inp());
    check("(control) without assist the same bird ends up on the ground", b.mode !== "air" && b.pos.y < 2, `y=${b.pos.y.toFixed(1)} mode=${b.mode}`); }
  { // 減速(長押し)を続ければ補助が止まり、通常どおり着地できる
    const a = new FlapAssist(); a.enabled = true; const f = at(28, 12, 110, 0, 9); for (let i = 0; i < 60 * 20; i++) f.step(1 / 60, a.apply(inp({ brake: true }), f));
    check("holding the brake lets the bird land normally (assist stays off)", f.mode !== "air" && a.autoFlaps === 0, `mode=${f.mode}`); }
  { // 地上のタップは小ジャンプへ渡る(補助に消費されない)
    const a = new FlapAssist(); a.enabled = true; const f = new Flight(world); f.pos.set(28, world.heightAt(28, 110) + 0.32, 110); f.prevPos.copy(f.pos); f.mode = "landed";
    f.step(1 / 60, a.apply(inp({ flapTap: true }), f)); check("a tap while landed becomes a small hop", f.mode === "air" && f.hopping && f.vel.y > 2); }

  suite("saved settings (D1)");
  const mem = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
  { const s = mem(); check("empty storage -> defaults", JSON.stringify(loadPrefs(s)) === JSON.stringify(DEFAULT_PREFS) && DEFAULT_PREFS.control === "both");
    savePrefs({ ...DEFAULT_PREFS, control: "left", autoPolicy: "scenic", autoTimeSpeed: "fast", autoHideUi: false }, s); const p = loadPrefs(s);
    check("saved preferences round-trip", p.control === "left" && p.autoPolicy === "scenic" && p.autoTimeSpeed === "fast" && p.autoHideUi === false); }
  { const s = mem(); s.m.set(PREFS_KEY, "{not json"); check("corrupted JSON -> safe defaults", JSON.stringify(loadPrefs(s)) === JSON.stringify(DEFAULT_PREFS));
    s.m.set(PREFS_KEY, JSON.stringify({ control: "banana", autoPolicy: 5, autoTimeSpeed: "fast", autoHideUi: "yes" })); const p = loadPrefs(s);
    check("invalid fields fall back one by one, valid ones are kept", p.control === "both" && p.autoPolicy === "random" && p.autoTimeSpeed === "fast" && p.autoHideUi === true);
    check("non-object JSON -> defaults", JSON.stringify(sanitizePrefs(42)) === JSON.stringify(DEFAULT_PREFS) && JSON.stringify(sanitizePrefs(null)) === JSON.stringify(DEFAULT_PREFS)); }
  { const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } }; check("a throwing storage (private mode) never breaks the game", JSON.stringify(loadPrefs(bad)) === JSON.stringify(DEFAULT_PREFS) && (savePrefs(DEFAULT_PREFS, bad), true)); }
  void L; void run;
}
