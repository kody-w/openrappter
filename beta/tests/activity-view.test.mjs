import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Driver actions are not conversation. The step feed used to be appended inside
// #chat, which wrote machine steps into the record of an exchange with the model —
// and under deterministic driving most of those steps never reach the model at
// all. It now lives on its own activity strip, off unless someone asked to watch.
// See beta/CONSTITUTION.md Article VI and beta/docs/AUTOPILOT-CLI.md.

const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");

test("the driver step feed is never mounted inside the chat transcript", () => {
  const body = main.slice(main.indexOf("function driveFeed()"));
  const fn = body.slice(0, body.indexOf("\n  }") + 4);
  assert.doesNotMatch(
    fn,
    /getElementById\("chat"\)/,
    "driveFeed must not reach for the transcript container",
  );
  assert.doesNotMatch(
    fn,
    /chat\.appendChild/,
    "driver steps must never be appended to the chat transcript",
  );
  assert.match(fn, /const host = document\.body/);
});

test("the activity view is off unless it was turned on", () => {
  assert.match(
    main,
    /window\.__rappBetaActivityView = window\.__rappBetaActivityView === true/,
    "the flag must default to off rather than to on",
  );
  assert.match(
    main,
    /function driveFeed\(\) \{\s*if \(!window\.__rappBetaActivityView\) return null;/,
    "no feed element may be created while the activity view is off",
  );
  assert.match(main, /__rappBetaSetActivityView/);
});

test("the activity strip cannot intercept the person's clicks", () => {
  // It floats over the window; a strip that swallowed clicks would break the
  // two-player rule that nothing captures the person's input.
  assert.match(
    main,
    /\.beta-drive-feed\{position:fixed[^}]*/,
    "the strip must be fixed-position rather than in the document flow",
  );
  const rule = main.slice(main.indexOf('".beta-drive-feed{position:fixed'));
  assert.match(rule.slice(0, 400), /pointer-events:none/);
});
