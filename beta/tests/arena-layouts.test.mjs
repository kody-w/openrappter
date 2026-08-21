import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARENA_LAYOUT_NAMES,
  ARENA_LAYOUTS,
  DEFAULT_VIEW_MODE,
  MAX_CUSTOM_LAYOUT_BYTES,
  normalizeViewModeSettings,
  readCustomLayout,
  resolveCustomLayout,
  validateCustomLayout,
} from "../electron/arena-layouts.mjs";

function customFixture() {
  return {
    name: "Moonlit tiles",
    surfaceColor: "#123456",
    seatPositions: [
      { x: 50, y: 8, rotation: 0 },
      { x: 86, y: 50, rotation: 90 },
      { x: 50, y: 92, rotation: 180 },
      { x: 14, y: 50, rotation: -90 },
    ],
    tileSize: { width: 180, height: 260 },
    arrangePattern: "clockwise",
    faceDownRule: "folded",
  };
}

test("built-in arena layouts all use original layout metadata", () => {
  assert.deepEqual(Object.keys(ARENA_LAYOUTS), [...ARENA_LAYOUT_NAMES]);
  for (const layout of Object.values(ARENA_LAYOUTS)) {
    assert.equal(typeof layout.label, "string");
    assert.equal(typeof layout.layout, "string");
    assert.equal(typeof layout.tileLook, "string");
  }
});

test("custom layout validator bounds local visual primitives", () => {
  assert.deepEqual(validateCustomLayout(customFixture()), customFixture());
  assert.throws(
    () => validateCustomLayout({
      ...customFixture(),
      surfaceColor: "url(https://x)",
    }),
    /six-digit hexadecimal/,
  );
  assert.throws(
    () => validateCustomLayout({
      ...customFixture(),
      seatPositions: [{ x: 101, y: 0 }],
    }),
    /seat 1 x/,
  );
  assert.throws(
    () => validateCustomLayout({
      ...customFixture(),
      logo: "https://example.com/a.png",
    }),
    /unsupported fields: logo/,
  );
  assert.throws(
    () => validateCustomLayout({ ...customFixture(), faceDownRule: "remote" }),
    /faceDownRule/,
  );
});

test("custom layout loader accepts only size-bounded local JSON", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-arena-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "arena.json");
  writeFileSync(file, JSON.stringify(customFixture()), { mode: 0o600 });
  assert.deepEqual(readCustomLayout(file), {
    file,
    layout: customFixture(),
  });
  assert.throws(
    () => readCustomLayout("https://example.com/arena.json"),
    /local JSON file/,
  );
  const large = path.join(root, "large.json");
  writeFileSync(large, " ".repeat(MAX_CUSTOM_LAYOUT_BYTES + 1));
  assert.throws(() => readCustomLayout(large), /limited to 65536 bytes/);
});

test("a stale custom layout cannot break herd mode", () => {
  let reads = 0;
  const herd = resolveCustomLayout({
    mode: "herd",
    layout: "custom",
    customLayoutPath: "/deleted/arena.json",
  }, {
    read() {
      reads += 1;
      throw new Error("should not read");
    },
  });
  assert.deepEqual(herd, { error: null, layout: null });
  assert.equal(reads, 0);

  const arena = resolveCustomLayout({
    mode: "arena",
    layout: "custom",
    customLayoutPath: "/deleted/arena.json",
  }, {
    read() {
      throw new Error("file is gone");
    },
  });
  assert.equal(arena.layout, null);
  assert.match(arena.error, /file is gone/);
});

// The preload runs as CommonJS and cannot import arena-layouts.mjs, so it carries
// a duplicated fallback for a missing or malformed --rapp-view-mode argument. A
// stale duplicate is invisible at runtime — normalizeViewModeSettings would repair
// the value everywhere except in the preload itself, leaving the renderer keyed on
// a layout name that no longer exists. Pin the copies together.
test("the preload's fallback view mode is the real default", () => {
  const source = readFileSync(
    new URL("../electron/preload.cjs", import.meta.url),
    "utf8",
  );
  const match = source.match(/let viewMode = (\{[\s\S]*?\});/);
  assert.ok(match, "preload.cjs must declare a literal viewMode fallback");
  const literal = match[1]
    .replace(/([A-Za-z_$][\w$]*)\s*:/g, '"$1":')
    .replace(/,(\s*})/g, "$1");
  const fallback = JSON.parse(literal);
  assert.deepEqual(fallback, { ...DEFAULT_VIEW_MODE });
  assert.deepEqual(
    normalizeViewModeSettings(fallback),
    fallback,
    "the fallback must already be a valid, normalized view mode",
  );
});
