import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (r) => (
  readFileSync(path.join(root, r), "utf8").replaceAll("\r\n", "\n")
);
const bytes = (r) => statSync(path.join(root, r)).size;

const OPENRAPPTER_DINO_PREFIX = "M238 614c40-182 157-302 320-302";

test("the app icon is the OpenRappter dinosaur, not the Brainstem glyph", () => {
  const svg = read("build/icon.svg");
  assert.ok(svg.includes(OPENRAPPTER_DINO_PREFIX), "icon.svg must carry the OpenRappter dinosaur");
  assert.match(svg, /id="dino"/);
  assert.match(svg, /rx="224"/);
  assert.match(svg, /#58f5d2/i);
  assert.doesNotMatch(svg, /M184 0c-30\.9 0-56\.5 22\.7-61\.1 52\.3/);
});

test("the renderer uses the packaged OpenRappter icon and theme color", () => {
  const html = read("ui/index.html");
  assert.match(html, /<link rel="icon" href="\.\.\/build\/icon\.svg">/);
  assert.match(html, /name="theme-color" content="#07111f"/);
});

test("every packaged icon artifact exists and is non-empty", () => {
  for (const f of ["build/icon.svg", "build/icon.png", "build/icon.icns", "build/icon.ico", "build/manifest.webmanifest"]) {
    assert.ok(existsSync(path.join(root, f)), `${f} missing`);
    assert.ok(bytes(f) > 0, `${f} empty`);
  }
});

test("the multi-size icon set covers desktop + mobile (iOS/Android/PWA) sizes", () => {
  const need = [16, 32, 48, 64, 128, 152, 167, 180, 192, 256, 512, 1024];
  for (const s of need) {
    const f = `build/icons/${s}x${s}.png`;
    assert.ok(existsSync(path.join(root, f)), `${f} missing`);
    assert.ok(bytes(f) > 0, `${f} empty`);
  }
});

test("the web manifest is valid JSON and every icon it lists exists", () => {
  const m = JSON.parse(read("build/manifest.webmanifest"));
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 6);
  assert.equal(m.name, "OpenRappter");
  assert.equal(m.short_name, "OpenRappter");
  assert.equal(m.theme_color, "#07111f");
  for (const icon of m.icons) {
    assert.ok(existsSync(path.join(root, "build", icon.src)), `manifest icon ${icon.src} missing`);
  }
});

test("main wires the brandmark as the runtime window + dock icon", () => {
  const main = read("electron/main.mjs");
  assert.match(main, /nativeImage/);
  assert.match(main, /appIcon = existsSync\(appIconFile\)/);
  assert.match(main, /icon: appIcon/);            // the main BrowserWindow
  assert.match(main, /app\.dock\.setIcon\(appIcon\)/);
});

test("packaging declares the brandmark icon on every platform", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.build.mac.icon, "build/icon.icns");
  assert.equal(pkg.build.win.icon, "build/icon.ico");
  assert.equal(pkg.build.linux.icon, "build/icons");
});
