import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const renderer = readFileSync(
  new URL("../ui/renderer.js", import.meta.url),
  "utf8",
);
const tilesSource = readFileSync(
  new URL("../ui/dimension-tiles.js", import.meta.url),
  "utf8",
);
const frameSource = readFileSync(
  new URL("../electron/dimension-tiles.mjs", import.meta.url),
  "utf8",
);
const tilesCss = readFileSync(
  new URL("../ui/dimension-tiles.css", import.meta.url),
  "utf8",
);
const shell = readFileSync(
  new URL("../ui/index.html", import.meta.url),
  "utf8",
);

test("herd mode loads no tile script, stylesheet, DOM, or listeners", async (t) => {
  assert.doesNotMatch(shell, /dimension-tiles\.(?:js|css)/);
  assert.match(
    renderer,
    /dimensionTilesRequested = state\.viewMode\?\.mode === "arena"/,
  );
  assert.match(
    renderer,
    /if \(dimensionTilesRequested\) \{[\s\S]*syncDimensionTiles\(state, tilesGeneration\)/,
  );
  assert.match(
    renderer,
    /else if \([\s\S]*tilesWereRequested[\s\S]*dimensionTilesLoader[\s\S]*window\.RappDimensionTiles/,
  );
  assert.match(tilesSource, /__rappDimensionTilesScript/);
  assert.match(renderer, /generation !== dimensionTilesGeneration/);

  delete globalThis.RappDimensionTiles;
  await import(`../ui/dimension-tiles.js?mode-off=${Date.now()}`);
  assert.equal(globalThis.RappDimensionTiles.enabled(), false);
  globalThis.RappDimensionTiles.disable();
  assert.equal(globalThis.RappDimensionTiles.enabled(), false);
  t.diagnostic("herd-mode renderer: 0 tile DOM, 0 tile listeners, 0 tile CSS");
});

test("every tile move and the Brainstem primary title bar has a drive handle", () => {
  assert.match(frameSource, /header\.dataset\.drive = "brainstem\.primary"/);
  assert.match(tilesSource, /herd\.tile\[\$\{id\}\]/);
  for (const move of ["fold", "race"]) {
    assert.match(tilesSource, new RegExp(`driveTile\\(tile\\.id, "${move}"\\)`));
  }
  for (const surface of ["herd", "arena", "binder"]) {
    assert.match(tilesSource, new RegExp(`tiles\\.surface\\.\\$\\{name\\}`));
    assert.match(tilesSource, new RegExp(`"${surface}"`));
  }
  assert.match(tilesSource, /tiles\.bunch\[/);
  assert.match(tilesSource, /arena\.arrange/);
  assert.match(tilesSource, /arena\.layout/);
  assert.match(tilesSource, /arena\.raceTarget/);
  assert.match(tilesSource, /\.api\.twinChat/);
});

test("tiles support drag, threshold swipes, buttons, and keyboard paths", () => {
  assert.match(tilesSource, /application\/x-rapp-brainstem-chat/);
  assert.match(tilesSource, /application\/x-rapp-dimension-tile/);
  assert.match(tilesSource, /movement >= 72/);
  assert.match(tilesSource, /movement <= -72/);
  assert.match(tilesSource, /pointermove/);
  assert.match(tilesCss, /touch-action:\s*pan-y/);
  assert.match(tilesSource, /event\.key === "ArrowRight"/);
  assert.match(tilesSource, /event\.key === "ArrowLeft"/);
  assert.match(tilesSource, /event\.key\.toLowerCase\(\) === "r"/);
  assert.match(tilesSource, /\["h", "a", "b"\]/);
  assert.match(tilesSource, /event\.key === " "/);
  assert.doesNotMatch(tilesSource, />Wake</);
});

test("binder pages, bunches, and drop feedback reuse the tile surface", () => {
  assert.match(tilesSource, /dimension-tile-binder-page/);
  assert.match(tilesSource, /dimension-tile-bunch/);
  assert.match(tilesSource, /Keep in the binder/);
  assert.match(tilesSource, /Park as a tile/);
  assert.match(tilesSource, /Bunch these tiles/);
  assert.match(tilesCss, /\.dimension-tile-drop-overlay/);
  assert.match(tilesCss, /border:\s*6px dashed/);
  assert.match(tilesCss, /pointer-events:\s*none/);
});

test("Agent Arena includes all layouts and four arrange moves", () => {
  for (const layout of ["ring", "row", "focus", "grid", "stack", "custom"]) {
    assert.match(tilesSource, new RegExp(`${layout}:`));
  }
  for (const move of ["reorder", "spread", "distribute", "open-one"]) {
    assert.match(tilesSource, new RegExp(`"${move}"`));
  }
  assert.match(
    tilesSource,
    /Agent Arena — parked conversations compete side by side/,
  );
  assert.match(tilesSource, /renderOverflow\(surface, active\.slice\(12\)\)/);
  assert.doesNotMatch(tilesSource, /folded\.slice\(/);
  assert.match(tilesSource, /if \(!SCRIPT_STATE\.enabled\) return null/);
});

// The herd and the arena are separate surfaces, not two renderings of one. The
// arena's chrome — the felt it competes on and the ring drawn over it — must be
// scoped so that switching to the herd surface shows a plain grid of parked
// tiles. Before this was enforced, the base .dimension-tile-surface rule carried
// the felt and an elliptical ::before, so the herd surface was drawn inside the
// arena's ring.
test("arena chrome is the arena's, and never reaches the herd surface", () => {
  const felt = tilesCss.match(/^([^\n{]*)\{[^}]*var\(--arena-surface\)[^}]*\}/gm) || [];
  const feltSelectors = felt
    .map((rule) => rule.slice(0, rule.indexOf("{")).trim())
    .filter((selector) => !selector.startsWith(":root"));
  assert.ok(feltSelectors.length > 0, "the arena felt must still be styled somewhere");
  for (const selector of feltSelectors) {
    assert.match(
      selector,
      /\.tile-surface-arena\b/,
      `arena felt must be scoped to the arena surface, found: ${selector}`,
    );
  }

  // The ring outline is arena chrome for the same reason.
  assert.doesNotMatch(
    tilesCss,
    /^\.dimension-tile-surface::before\s*\{/m,
    "the ring outline must not be an unscoped surface decoration",
  );
  assert.match(tilesCss, /\.tile-surface-arena \.dimension-tile-surface::before/);

  // And the herd surface says plainly that it carries neither.
  assert.match(
    tilesCss,
    /\.tile-surface-herd \.dimension-tile-surface \{[^}]*background:\s*transparent[^}]*box-shadow:\s*none/,
  );
});

test("arena arrangements never apply off the arena surface", () => {
  // A tile-layout-* class on the container is what selects an arena
  // arrangement. The herd is a grid and the binder is pages; applying an
  // arrangement to either would re-skin one surface as another.
  assert.match(
    tilesSource,
    /if \(selectedSurface === "arena"\) \{\s*herd\.classList\.add\(`tile-layout-\$\{layoutName\}`\)/,
  );
  assert.doesNotMatch(
    tilesSource,
    /classList\.add\("dimension-tile-view", `tile-layout-/,
    "the container must not receive an arrangement class unconditionally",
  );
});

// The wake handshake had exactly two chances to land — the frame's ready message
// and the end of wakeTile's route transition — and both can legitimately miss: the
// ready message arrives while routeTransition is still true, and a second
// navigation then nulls frameReadyGeneration while frameChanged returns early
// because a wake is pending. With no retry the tile was dropped silently and the
// chat showed a fresh Brainstem instead of the restored conversation, which is the
// cross-platform e2e failure in "tile drag semantics".
test("a wake that cannot be delivered yet is retried, then fails loudly", () => {
  assert.match(
    tilesSource,
    /function deliverPendingWake\(\)[\s\S]*?\) \{\s*scheduleWakeRetry\(\);\s*return false;/,
    "a wake that cannot land now must arm a retry instead of being dropped",
  );
  assert.match(
    tilesSource,
    /Date\.now\(\) > SCRIPT_STATE\.pendingWakeDeadline[\s\S]{0,320}showError\(/,
    "the retry must be bounded and surface a failure rather than looping forever",
  );
  // Delivering, or discovering there is nothing to deliver, must disarm the retry.
  const fn = tilesSource.slice(tilesSource.indexOf("function deliverPendingWake()"));
  assert.equal(
    (fn.slice(0, fn.indexOf("\n  }")).match(/clearWakeRetry\(\)/g) || []).length,
    2,
    "both exits from deliverPendingWake must clear the retry timer",
  );
});
