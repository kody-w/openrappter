import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// docs/UI-AUTOSTEER-PROTOCOL.md stage 4: the bus is checked against an expected
// origin on both ends, and every command completes exactly once carrying the id
// it was given — never silence. The protocol's own tier-A reference broke both:
// it posted to "*", accepted a message from anywhere, and correlated nothing.

const studio = readFileSync(
  new URL(
    "../frontier/rapplications/agentic-app-studio/agents/agentic_app_studio_agent.py",
    import.meta.url,
  ),
  "utf8",
);

test("the generated app never posts to a wildcard origin", () => {
  const wildcards = studio
    .split("\n")
    .map((line, index) => [index + 1, line])
    .filter(([, line]) => /postMessage\([^)]*,\s*"\*"\s*\)/.test(line));
  assert.deepEqual(
    wildcards.map(([n, line]) => `${n}: ${line.trim()}`),
    [],
    "a reply posted to \"*\" is readable by whatever frame happens to be embedding the app",
  );
  assert.match(studio, /parent\.postMessage\(p,PARENT_ORIGIN\)/);
});

test("the generated app accepts drive messages only from its embedder", () => {
  assert.match(studio, /const PARENT_ORIGIN=/, "the expected origin must be captured at load");
  assert.match(studio, /if\(e\.source!==parent\)return;/);
  assert.match(studio, /if\(PARENT_ORIGIN&&e\.origin!==PARENT_ORIGIN\)return;/);
});

test("every drive command answers once, carrying its id", () => {
  // ask() threads the id through to both its answered and error paths.
  assert.match(studio, /async function ask\(q,id\)/);
  assert.match(studio, /emit\(\{event:"answered",text:w\.textContent\},id\)/);
  assert.match(studio, /emit\(\{event:"error",text:w\.textContent\},id\)/);
  // An unknown command is answered rather than dropped.
  assert.match(studio, /emit\(\{event:"error",text:"unknown command: "\+String\(m\.cmd\)\},id\)/);
  // And a throw inside the handler still answers.
  assert.match(studio, /catch\(err\)\{emit\(\{event:"error"[^}]*\},id\)/);
});
