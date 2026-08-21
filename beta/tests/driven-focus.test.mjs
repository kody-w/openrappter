import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// A driven run shares the machine with a person who is using it. The window must
// stay real — a never-shown window makes the renderer behave differently and the
// run stops being a proof — but showing it must not activate the app and pull
// focus away from whatever they were doing. This is the two-player law applied to
// the application itself: automation works in the window without taking it.

// Normalised to LF at read. These tests locate regions of the source with
// searches like indexOf("\n}\n\nfunction ..."), which find nothing on a Windows
// checkout where the file is CRLF — the region comes back empty and the test
// fails claiming the code is missing. Normalising once fixes every search in
// this file rather than each pattern being hardened separately.
const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

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
  // mainWindow.show()/focus() or local win.show()/focus() would bypass the
  // driven-run check.
  // The notification handler's focus() is deliberate: a person clicked it.
  const offenders = [];
  for (const [index, line] of main.split("\n").entries()) {
    if (!/\b(mainWindow|win)\.(show|focus)\(\)/.test(line)) continue;
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

test("the primary window constructor cannot activate a driven launch", () => {
  const start = main.indexOf("function createWindow()");
  const end = main.indexOf("\n}\n\nfunction shortCommit", start);
  const createWindow = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(createWindow, /const headless = .*BRAINSTEM_BETA_HEADLESS/);
  assert.match(createWindow, /new BrowserWindow\(\{\s*show: false,/);
  assert.match(createWindow, /if \(!headless\) presentWindow\(win\)/);
  assert.doesNotMatch(
    createWindow,
    /show:\s*process\.env\.BRAINSTEM_BETA_HEADLESS !== "1"/,
  );
});

// A popped-out rapplication is meant to be worked with on its own screen — often
// fullscreen — while the Frontier chat carries on beside it. Parenting the pop-out
// to the main window makes it a child window, which on macOS shares the parent's
// fullscreen space: taking the pop-out fullscreen took over the Brainstem window
// and left it blank.
test("a popped-out rapplication is a top-level window, not a child", () => {
  const fn = main.slice(main.indexOf("function popOutTwin(id)"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.doesNotMatch(
    body,
    /parent:\s*mainWindow/,
    "popOutTwin must not parent the pop-out to the main window",
  );
  assert.match(body, /new BrowserWindow\(/);
});
