import assert from "node:assert/strict";
import test from "node:test";

import {
  createAutopilotInstallationSource,
  createFrameBridgeInstallationSource,
  createViewToggle,
  FORCE_MODE_BOOTSTRAP,
  instrumentRappUi,
} from "../electron/injection-sources.mjs";
import { createTwinLedgerBridgeSource } from "../electron/twin-ledger-bridge.mjs";

const banner = /^\/\*[\s\S]*Added by the OpenRappter host[\s\S]*\*\//;
const autopilotSource = createAutopilotInstallationSource({
  capability: "test-capability",
  classicSource: "function createAutopilot() {}\nwindow.rapp = createAutopilot();",
});

test("the twin ledger bridge declares itself in its delivered bytes", () => {
  const source = createTwinLedgerBridgeSource({ sink: "parent", twinId: "twin-1" });
  assert.match(source.slice(0, 400), banner);
  assert.match(source, /installTwinLedgerBridge|sink/);
});

test("the Autopilot payload declares itself in its delivered bytes", () => {
  assert.match(autopilotSource.slice(0, 700), banner);
  assert.match(autopilotSource, /rapp-autopilot\/1\.0/);
  assert.match(autopilotSource, /window\.rapp = createAutopilot/);
  assert.match(autopilotSource, /window\.__rappAutopilotCapability/);
});

test("the combined Brainstem frame payload opens with its own declaration", () => {
  const source = createFrameBridgeInstallationSource({
    autopilotSource,
    bridgeSource: "window.__rappBetaFrameBridge = true;",
  });
  assert.match(source.slice(0, 700), banner);
  assert.match(source, /Brainstem frame bridge/);
  assert.match(source, /dimension-tiles bridge/);
  assert.match(source, /window\.__rappBetaFrameBridge = true/);
  assert.match(source, /window\.rapp = createAutopilot/);
});

test("instrumented rapplication HTML declares both host-added scripts", () => {
  const html = instrumentRappUi("<html><head></head><body></body></html>", {
    autopilotSource,
  });
  assert.match(
    FORCE_MODE_BOOTSTRAP,
    /^<!-- Added by the OpenRappter host:/,
  );
  assert.doesNotMatch(FORCE_MODE_BOOTSTRAP, /Nothing else is changed/);
  assert.match(
    html,
    /<!-- Added by the OpenRappter host:[\s\S]*?<script>window\.__rappForceModeCapable=true;/,
  );
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  assert.match(scripts[1][1].slice(0, 700), banner);
});

test("the view toggle declares itself in the bytes it returns", () => {
  const source = createViewToggle(false);
  assert.match(
    source.trimStart(),
    /^<!-- Added by the OpenRappter host:/,
  );
  assert.match(source, /__rappViewToggle/);
});
