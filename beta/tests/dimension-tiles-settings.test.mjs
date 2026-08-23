import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  changeViewModeSettings,
  composeDimensionTilesFrameBridgeSource,
  parseViewModeCommand,
  readViewModeSettings,
  writeViewModeSettings,
} from "../electron/dimension-tiles.mjs";

test("view mode defaults to herd and persists beside Chat Look", (t) => {
  const betaHome = mkdtempSync(path.join(tmpdir(), "rapp-dimension-tiles-"));
  t.after(() => rmSync(betaHome, { recursive: true, force: true }));

  assert.deepEqual(readViewModeSettings({ betaHome, env: {} }), {
    viewMode: {
      mode: "herd",
      surface: "herd",
      layout: "ring",
      customLayoutPath: null,
    },
    viewModeOverridden: false,
    file: path.join(betaHome, "settings.json"),
    storedViewMode: {
      mode: "herd",
      surface: "herd",
      layout: "ring",
      customLayoutPath: null,
    },
  });

  writeViewModeSettings({
    betaHome,
    viewMode: { mode: "arena", layout: "stack" },
  });
  const changed = changeViewModeSettings({
    betaHome,
    viewMode: { layout: "grid" },
    env: {},
  });
  assert.deepEqual(changed.viewMode, {
    mode: "arena",
    surface: "herd",
    layout: "grid",
    customLayoutPath: null,
  });
  const file = path.join(betaHome, "settings.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    viewMode: {
      mode: "arena",
      surface: "herd",
      layout: "grid",
      customLayoutPath: null,
    },
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test("RAPP_VIEW_MODE is authoritative and unknown values fall back to herd", (t) => {
  const betaHome = mkdtempSync(path.join(tmpdir(), "rapp-dimension-tiles-env-"));
  t.after(() => rmSync(betaHome, { recursive: true, force: true }));
  writeViewModeSettings({ betaHome, viewMode: { mode: "arena" } });

  const forced = readViewModeSettings({
    betaHome,
    env: { RAPP_VIEW_MODE: "herd" },
  });
  assert.equal(forced.viewMode.mode, "herd");
  assert.equal(forced.storedViewMode.mode, "arena");
  assert.equal(forced.viewModeOverridden, true);
  assert.equal(
    readViewModeSettings({
      betaHome,
      env: { RAPP_VIEW_MODE: "arena" },
    }).viewMode.mode,
    "arena",
  );
  assert.equal(
    readViewModeSettings({
      betaHome,
      env: { RAPP_VIEW_MODE: "unknown" },
    }).viewMode.mode,
    "herd",
  );
});

test("view mode composer words are exact and trimmed", () => {
  assert.deepEqual(parseViewModeCommand("agent arena"), {
    action: "set-view-mode",
    mode: "arena",
    original: "agent arena",
  });
  assert.equal(parseViewModeCommand("  herd \n")?.mode, "herd");
  assert.equal(parseViewModeCommand("Agent Arena"), null);
  assert.equal(parseViewModeCommand("please enable agent arena"), null);
});

test("the active tile view persists herd, arena, and binder surfaces", (t) => {
  const betaHome = mkdtempSync(path.join(tmpdir(), "rapp-tile-surfaces-"));
  t.after(() => rmSync(betaHome, { recursive: true, force: true }));
  writeViewModeSettings({
    betaHome,
    viewMode: { mode: "arena", surface: "binder" },
  });
  assert.equal(
    readViewModeSettings({ betaHome, env: {} }).viewMode.surface,
    "binder",
  );
  writeViewModeSettings({
    betaHome,
    viewMode: { mode: "arena", surface: "unknown" },
  });
  assert.equal(
    readViewModeSettings({ betaHome, env: {} }).viewMode.surface,
    "herd",
  );
});

test("herd-mode bridge composition is byte-identical", (t) => {
  const checkpointSource = "checkpoint-frame-bridge\n\u0000bytes";
  const herd = composeDimensionTilesFrameBridgeSource(checkpointSource, {
    mode: "herd",
    surface: "herd",
    layout: "ring",
    customLayoutPath: null,
  });
  assert.equal(herd, checkpointSource);
  assert.doesNotMatch(herd, /ArenaBridge|dimension.tile|agent arena/i);
  t.diagnostic("herd-mode bridge composition: byte-identical");
});

test("main, preload, and both menus expose the guarded toggle", () => {
  const main = readFileSync(
    new URL("../electron/main.mjs", import.meta.url),
    "utf8",
  );
  const preload = readFileSync(
    new URL("../electron/preload.cjs", import.meta.url),
    "utf8",
  );
  const tiles = readFileSync(
    new URL("../electron/dimension-tiles.mjs", import.meta.url),
    "utf8",
  );
  assert.match(main, /ipcMain\.handle\("beta:set-view-mode"/);
  assert.match(main, /id: "agent-arena"/);
  assert.match(main, /label: "Agent Arena"/);
  assert.match(main, /composeDimensionTilesFrameBridgeSource\(checkpointSource, viewMode\)/);
  assert.match(preload, /setViewMode:/);
  assert.match(tiles, /id = "beta-agent-arena-toggle"/);
  assert.match(tiles, /textContent = "Agent Arena"/);
});
