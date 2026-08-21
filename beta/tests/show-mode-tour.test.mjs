import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { uiDriverInternals } from "../electron/ui-driver-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const tour = read("ui/show-mode-tour.js");
const ui = read("ui/index.html");
const renderer = read("ui/renderer.js");
const standalone = read("show-mode.html");
const brainSurgeon = read("electron/brain-surgeon.mjs");
const uiDriverServer = read("electron/ui-driver-server.mjs");
const uiDriverAgent = read("scripts/brainstem_ui_driver_agent.py");
const pkg = JSON.parse(read("package.json"));

test("Show Mode click-through ships as a CSP-safe separate script in the shell", () => {
  execFileSync(process.execPath, ["--check", path.join(root, "ui/show-mode-tour.js")]);
  assert.match(ui, /<script src="show-mode-tour\.js"><\/script>/);
  assert.match(ui, /script-src 'self'/);
  assert.doesNotMatch(ui, /<script>[^<]*rappShowModeTour/);
  assert.match(tour, /window\.rappShowModeTour = \{/);
  assert.match(tour, /rapp-beta:show-mode-tour/);
  assert.match(tour, /data-show-mode-tour/);
});

test("the click-through walks the whole Show Mode loop with synthetic content", () => {
  for (const id of ["welcome", "interview", "pill", "doors", "import", "analyze", "edit", "approve", "preview", "test", "confirm", "promote", "why", "end"]) {
    assert.match(tour, new RegExp(`id: "${id}"`), `missing step ${id}`);
  }
  assert.match(tour, /Record live/);
  assert.match(tour, /Import a video/);
  assert.match(tour, /Drop screenshots/);
  assert.match(tour, /Paste a transcript/);
  assert.match(tour, /synthetic/i);
  assert.match(tour, /Copilot Studio/);
  assert.match(tour, /Scout/);
  assert.match(tour, /Cowork/);
  assert.match(tour, /Nothing runs live|Preview only/);
  assert.match(tour, /You don't have access to the customer tenant/);
  assert.match(tour, /proof of value on the same call/i);
});

test("the click-through sits beside the interview loop and never sends a prompt", () => {
  assert.match(renderer, /Show Mode: click-through preview/);
  assert.match(renderer, /starter\.tour/);
  assert.match(renderer, /rapp-beta:show-mode-tour/);
  assert.match(ui, /id="show-mode-interview-prompt"/);
  assert.match(ui, /Can't describe it\? Show it\./);
  assert.match(ui, /show-mode-preview/);
  assert.doesNotMatch(renderer, /openBrowser|openVscode|restart/);
});

test("the standalone Pages replica drives the same script", () => {
  assert.match(standalone, /<script src="ui\/show-mode-tour\.js"><\/script>/);
  assert.match(standalone, /id="explorer"/);
  assert.match(standalone, /id="surgeon"/);
  assert.match(standalone, /show-mode-preview/);
  assert.match(standalone, /rappShowModeTour\.start\(0\)/);
});

test("the UI driver exposes tour and force_mode as top-level commands only", () => {
  assert.equal(uiDriverInternals.validateCommand({ action: "tour", value: "status" }).action, "tour");
  assert.equal(uiDriverInternals.validateCommand({ action: "force_mode", value: "on" }).action, "force_mode");
  assert.throws(
    () => uiDriverInternals.validateCommand({ action: "run", steps: [{ action: "tour", value: "next" }] }),
    /top-level/,
  );
  assert.throws(
    () => uiDriverInternals.validateCommand({ action: "run", steps: [{ action: "force_mode", value: "on" }] }),
    /top-level/,
  );
  assert.equal(typeof uiDriverInternals.setForceMode, "function");
  assert.equal(typeof uiDriverInternals.runTourCommand, "function");
  assert.match(uiDriverServer, /brainstem-ai-force-mode/);
  assert.match(uiDriverServer, /FORCE_MODE_IDLE_MS/);
  assert.match(uiDriverServer, /command\.forceMode === true/);
  assert.match(uiDriverServer, /window\.rappShowModeTour/);
});

test("Brain Surgeon and the Python driver can light AI force mode and walk the click-through", () => {
  assert.match(brainSurgeon, /name: "set_ai_force_mode"/);
  assert.match(brainSurgeon, /name: "show_mode_click_through"/);
  assert.match(brainSurgeon, /force_mode: \{/);
  assert.match(brainSurgeon, /AI FORCE MODE \(hidden until asked for\)/);
  assert.match(brainSurgeon, /action: "tour"/);
  assert.match(uiDriverAgent, /"force_mode"/);
  assert.match(uiDriverAgent, /"tour"/);
  assert.match(uiDriverAgent, /AI force mode is hidden until asked for/);
  assert.match(pkg.scripts.check, /show-mode-tour\.js/);
  assert.equal(pkg.scripts["show-mode:capture"], "node scripts/show-mode-capture.mjs");
  assert.ok(pkg.build.files.includes("scripts/show-mode-capture.mjs"));
});
