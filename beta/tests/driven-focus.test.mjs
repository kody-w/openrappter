import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// A driven run shares the machine with a person who is using it. The window must
// stay real — a never-shown window makes the renderer behave differently and the
// run stops being a proof — but showing it must not activate the app and pull
// focus away from whatever they were doing. This is the two-player law applied to
// the application itself: automation works in the window without taking it.

const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");

test("a driven run shows its window without taking focus", () => {
  assert.match(
    main,
    /const drivenRun = process\.env\.BRAINSTEM_BETA_E2E === "1"/,
    "the driven-run signal must come from the harness's own env var",
  );
  assert.match(
    main,
    /function presentWindow\([\s\S]*?if \(drivenRun\) \{\s*window\.showInactive\(\);\s*return;/,
    "a driven run must use showInactive and return before show()/focus()",
  );
  assert.match(
    main,
    /drivenRun && process\.platform === "darwin"[\s\S]*?setActivationPolicy\("accessory"\)/,
    "on macOS the app must not become the active application during a driven run",
  );
});

test("no window is shown or focused outside presentWindow", () => {
  // mainWindow.show()/focus() called directly would bypass the driven-run check.
  // The notification handler's focus() is deliberate: a person clicked it.
  const offenders = [];
  for (const [index, line] of main.split("\n").entries()) {
    if (!/mainWindow\.(show|focus)\(\)/.test(line)) continue;
    const context = main.split("\n").slice(Math.max(0, index - 6), index).join("\n");
    if (/notification|\.on\("click"/i.test(context)) continue;
    offenders.push(`${index + 1}: ${line.trim()}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "Call presentWindow() instead — a direct show()/focus() steals the screen\n"
      + "during a driven run. See beta/tests/driven-focus.test.mjs.\n"
      + offenders.join("\n"),
  );
});
