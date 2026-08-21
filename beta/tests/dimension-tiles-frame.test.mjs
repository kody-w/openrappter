import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  composeDimensionTilesFrameBridgeSource,
} from "../electron/dimension-tiles.mjs";

const arena = {
  mode: "arena",
  surface: "herd",
  layout: "ring",
  customLayoutPath: null,
};

test("tile frame bridge exists only in Agent Arena bridge source", () => {
  const checkpoint = "window.__checkpointBridge = true;";
  assert.equal(
    composeDimensionTilesFrameBridgeSource(checkpoint, {
      ...arena,
      mode: "herd",
    }),
    checkpoint,
  );
  const source = composeDimensionTilesFrameBridgeSource(checkpoint, arena);
  assert.match(source, /window\.__rappBetaArenaBridge/);
  assert.match(source, /window\.fetch = tileFetch/);
  assert.match(source, /rapp-beta:tile-capture/);
  assert.match(source, /rapp-beta:tile-wake/);
  assert.match(source, /rapp-beta:tile-parked/);
  assert.match(source, /pendingRequestIds/);
  assert.match(source, /__rappBetaDeferredTileCompletions/);
  assert.match(source, /header\.draggable = true/);
  assert.match(source, /application\/x-rapp-brainstem-chat/);
  assert.match(source, /rapp-beta:chat-drag-start/);
  assert.match(source, /rapp-beta:chat-drag-end/);
  assert.match(source, /rapp-beta:tile-drop-primary/);
  assert.match(source, /rapp-beta:tile-frame-ready/);
  assert.match(source, /header\.dataset\.drive = "brainstem\.primary"/);
  assert.match(source, /rapp-beta:tile-keyboard-park/);
});

test("tile capture and restore use the page sanitizer", () => {
  const source = composeDimensionTilesFrameBridgeSource("", arena);
  const uses = source.match(/window\.sanitizeMarkdownFragment/g) || [];
  assert.ok(uses.length >= 4);
  assert.match(source, /sanitizedHtml\(bubble\)/);
  assert.match(source, /replyHtml\(reply\)/);
  assert.match(source, /bubble\.replaceChildren/);
});

test("wake history substitutes by prefix and clear stops future splicing", () => {
  const source = composeDimensionTilesFrameBridgeSource("", arena);
  assert.match(
    source,
    /activeHistory\s*\?\s*\[\.\.\.wireHistory\(activeHistory\), \.\.\.incomingHistory\]/,
  );
  assert.match(source, /body\.conversation_history = effectiveHistory/);
  assert.match(source, /if \(\s*!internalClear[\s\S]*activeHistory = null/);
  assert.match(source, /markPendingForTile[\s\S]*activeHistory = null/);
});

test("parking preserves an accepted delayed wire while kernel Clear runs", () => {
  const source = composeDimensionTilesFrameBridgeSource("", arena);
  assert.match(source, /request\.preserveOnClear/);
  assert.match(source, /controller\.abort\(originalSignal\?\.reason\)/);
  assert.match(source, /clearKernel\(\{ preservePending: true \}\)/);
  assert.match(source, /rapp-beta:tile-pending-complete/);
  assert.match(source, /rapp-beta:tile-completion-ack/);
  assert.match(source, /canonicalHistory/);
  assert.match(source, /rapp-beta:tile-detached/);
});

test("tile drops reuse the kernel overlay and retain the postMessage fallback", () => {
  const source = composeDimensionTilesFrameBridgeSource("", arena);
  assert.match(source, /document\.getElementById\("drop-overlay"\)/);
  assert.match(source, /function showDropOverlay/);
  assert.match(source, /event\.relatedTarget === null/);
  assert.match(source, /armedTileId/);
  assert.match(source, /application\/x-rapp-dimension-tile/);
});

test("abandoning a staged race disarms it, so the next conversation is not filed into the contender", () => {
  // prepareRace arms nextRaceTileId and only the chat POST consumed it, so
  // every abandonment path (clear, wake, fold, disable) left it armed and the
  // NEXT conversation's reply and history were written into the contender.
  const source = readFileSync(
    new URL("../electron/dimension-tiles.mjs", import.meta.url),
    "utf8",
  );
  const armed = source.indexOf("nextRaceTileId = tileId;");
  assert.ok(armed > 0, "prepareRace still arms the race");
  const disarms = source.split("nextRaceTileId = null;").length - 1;
  assert.ok(
    disarms >= 6,
    `every abandonment path must disarm the race; found ${disarms} clear sites`,
  );
  for (const path of [
    "function markPendingForTile",
    "rapp-beta:tile-clear",
  ]) {
    const at = source.indexOf(path);
    assert.ok(at > 0, `${path} exists`);
    const window = source.slice(at, at + 700);
    assert.match(
      window,
      /nextRaceTileId = null;/,
      `${path} must disarm a staged race`,
    );
  }
});
