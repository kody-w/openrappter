import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (r) => readFileSync(path.join(root, r), "utf8");

test("the Frontier style guide exists and locks the brandmark rule", () => {
  assert.ok(existsSync(path.join(root, "docs/STYLE-GUIDE.md")), "STYLE-GUIDE.md missing");
  const sg = read("docs/STYLE-GUIDE.md");
  assert.match(sg, /brandmark/i);
  assert.match(sg, /never redraw|do not redraw|never redraw or approximate/i);
});

test("the style guide's accent tokens match the actual UI", () => {
  const sg = read("docs/STYLE-GUIDE.md");
  const css = read("ui/index.html");
  // brand blue and twin purple are the two identity accents the guide documents;
  // both must be real, in-use tokens (guide stays truthful to the code).
  for (const token of ["#58a6ff", "#7c6bd0"]) {
    assert.ok(sg.includes(token), `style guide should document ${token}`);
    assert.ok(css.includes(token), `${token} should be used in the UI CSS`);
  }
});

test("the style guide encodes the kernel invariants", () => {
  const sg = read("docs/STYLE-GUIDE.md");
  assert.match(sg, /chat is the only wire|only wire/i);
  assert.match(sg, /never forked|not forked|overrides/i);
});
