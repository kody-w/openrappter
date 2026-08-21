import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTwinLedgerBridgeSource } from "../electron/twin-ledger-bridge.mjs";

// UI Autosteer stage 3: "the injected bytes themselves carry a banner comment
// naming what was added and why — source-file comments in the injector do not
// count, the declaration travels with the code." PROVE obligation 2 requires
// reading that banner out of the shipped artifact. This is that obligation, run.

const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");

test("the twin ledger bridge declares itself in its delivered bytes", () => {
  const source = createTwinLedgerBridgeSource({ sink: "parent", twinId: "twin-1" });
  assert.match(
    source.slice(0, 400),
    /^\/\*[\s\S]*Added by the RAPP Brainstem Frontier host[\s\S]*\*\//,
    "the delivered source must open with a banner naming what was added",
  );
  // The banner must survive whatever else changes about the payload.
  assert.match(source, /installTwinLedgerBridge|sink/);
});

test("host injections into a frame declare themselves", () => {
  const constants = [
    ["FORCE_MODE_BOOTSTRAP", /const FORCE_MODE_BOOTSTRAP = ([\s\S]*?);\n\n/],
    ["VIEW_TOGGLE", /const VIEW_TOGGLE = \(startMobile\) => `([\s\S]{0,600})/],
  ];
  for (const [name, pattern] of constants) {
    const match = main.match(pattern);
    assert.ok(match, `${name} must exist in main.mjs`);
    assert.match(
      match[1],
      /Added by the RAPP Brainstem Frontier host/,
      `${name} must declare itself inside the bytes it injects, not only in a `
        + "comment beside the injector",
    );
  }
});
