let failures = 0, passes = 0;
export function check(name: string, ok: boolean, detail = "") {
  if (ok) { passes++; console.log(`  ok   ${name}${detail ? "  (" + detail + ")" : ""}`); }
  else { failures++; console.log(`  FAIL ${name}${detail ? "  (" + detail + ")" : ""}`); }
}
export function suite(name: string) { console.log(`\n# ${name}`); }
export function finish() {
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}
