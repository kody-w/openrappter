import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (r) => readFileSync(path.join(root, r), "utf8");

test("the OpenRappter style guide locks its own dinosaur brandmark", () => {
  assert.ok(existsSync(path.join(root, "docs/STYLE-GUIDE.md")), "STYLE-GUIDE.md missing");
  const sg = read("docs/STYLE-GUIDE.md");
  assert.match(sg, /OpenRappter dinosaur/i);
  assert.match(sg, /never redraw|do not redraw|never redraw or approximate/i);
  assert.match(sg, /distinct from.*Brainstem|Brainstem.*distinct/i);
  assert.doesNotMatch(sg, /brain glyph.*single, fixed identity mark/i);
});

test("the style guide's accent tokens match the actual UI", () => {
  const sg = read("docs/STYLE-GUIDE.md");
  const css = read("ui/index.html");
  const icon = read("build/icon.svg");
  for (const token of ["#58f5d2", "#72b5ff", "#07111f", "#7c6bd0"]) {
    assert.ok(sg.includes(token), `style guide should document ${token}`);
    assert.ok(
      css.includes(token) || icon.includes(token),
      `${token} should be used in the actual OpenRappter UI or icon`,
    );
  }
});

test("the style guide encodes the kernel invariants", () => {
  const sg = read("docs/STYLE-GUIDE.md");
  assert.match(sg, /chat is the only wire|only wire/i);
  assert.match(sg, /unchanged Brainstem|Brainstem.*component/i);
  assert.match(sg, /Rappter Surgeon/);
  assert.match(sg, /Apache-2\.0/);
});
