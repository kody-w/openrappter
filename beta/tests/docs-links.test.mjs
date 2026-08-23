import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The Frontier carries a lot of prose that cross-references itself, and a moved
// or renamed document breaks those links silently — the text still reads fine.
// Walk every markdown file under beta/ and prove each relative target exists.

const betaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function markdownFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...markdownFiles(full));
    else if (entry.endsWith(".md")) found.push(full);
  }
  return found;
}

const LINK = /\]\(([^)\s#]+)(?:#[^)]*)?\)/g;

test("every relative link in a Frontier document resolves", () => {
  const files = markdownFiles(betaRoot);
  assert.ok(files.length > 10, "expected the Frontier to carry documentation");
  const broken = [];
  for (const file of files) {
    const body = readFileSync(file, "utf8");
    for (const [index, line] of body.split("\n").entries()) {
      for (const match of line.matchAll(LINK)) {
        const target = match[1];
        if (/^(?:https?:|mailto:)/i.test(target)) continue;
        const resolved = path.resolve(path.dirname(file), target);
        if (!existsSync(resolved)) {
          broken.push(
            `${path.relative(betaRoot, file)}:${index + 1} -> ${target}`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    broken,
    [],
    "These documents link to files that do not exist:\n" + broken.join("\n"),
  );
});
