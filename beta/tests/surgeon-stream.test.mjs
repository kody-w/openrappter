import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../ui/stream-pacing.js");

const { setStreamArriving } = globalThis.RappStreamPacing;
const renderer = readFileSync(
  new URL("../ui/renderer.js", import.meta.url),
  "utf8",
);
const shell = readFileSync(
  new URL("../ui/index.html", import.meta.url),
  "utf8",
);

function fakeElement() {
  const classes = new Set();
  return {
    classList: {
      contains: (value) => classes.has(value),
      toggle(value, active) {
        if (active) classes.add(value);
        else classes.delete(value);
      },
    },
  };
}

test("Surgeon streaming caret class turns on and off", () => {
  const bubble = fakeElement();

  setStreamArriving(bubble, true);
  assert.equal(bubble.classList.contains("stream-arriving"), true);
  setStreamArriving(bubble, false);
  assert.equal(bubble.classList.contains("stream-arriving"), false);
});

test("Surgeon smooth mode uses the shared pacer and caret lifecycle", () => {
  assert.ok(
    shell.indexOf('<script src="stream-follow.js"></script>')
      < shell.indexOf('<script src="renderer.js"></script>'),
  );
  assert.ok(
    shell.indexOf('<script src="stream-follow.js"></script>')
      < shell.indexOf('<script src="renderer.js"></script>'),
  );
  assert.ok(
    shell.indexOf('<script src="stream-pacing.js"></script>')
      < shell.indexOf('<script src="renderer.js"></script>'),
  );
  assert.match(renderer, /createTailFollower\(/);
  assert.match(renderer, /function createSurgeonPacer/);
  assert.match(renderer, /createStreamPacer\(/);
  assert.match(renderer, /setStreamArriving\(session\.streamEl, true\)/);
  assert.match(renderer, /setStreamArriving\(session\.streamEl, false\)/);
  assert.match(renderer, /session\.pacer\?\.flush\(\)/);
  assert.match(renderer, /createTailFollower\(/);
  assert.match(renderer, /streamFollower\.contentChanged\(\)/);
  assert.match(renderer, /streamFollower\?\.complete\(\)/);
  assert.match(renderer, /--rapp-surgeon-composer-clearance/);
  assert.doesNotMatch(
    renderer,
    /Math\.ceil\(composer\.getBoundingClientRect\(\)\.height\)/,
  );
  assert.match(renderer, /handleSurgeonUserScroll/);
  assert.match(renderer, /userIntentUntil/);
  assert.match(renderer, /surgeonLog\.addEventListener\("scroll"/);
  assert.match(
    shell,
    /html\[data-rapp-stream="smooth"\] \.surgeon-message\.assistant\.stream-arriving::after/,
  );
  assert.match(
    shell,
    /html\[data-rapp-stream="smooth"\] #surgeon-log \{[\s\S]*?padding-bottom:[\s\S]*?scroll-padding-bottom:/,
  );
});

test("twin tile chat remains non-streaming and needs no pacing scheduler", () => {
  const twinManager = readFileSync(
    new URL("../electron/twin-manager.mjs", import.meta.url),
    "utf8",
  );

  assert.match(twinManager, /fetch\(`\$\{twin\.url\}\/chat`/);
  assert.doesNotMatch(twinManager, /twin\.url\}\/chat\/stream/);
});
