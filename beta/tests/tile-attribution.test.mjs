import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Article VI: a person's own action may get brief feedback, a driver's does not,
// and attribution is carried on the object rather than in a message. The only
// honest discriminator available in the page is event.isTrusted — a person's
// interaction is trusted, anything the driver dispatches is not.

const source = readFileSync(new URL("../ui/dimension-tiles.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../ui/dimension-tiles.css", import.meta.url), "utf8");

test("the actor is decided by whether the event was trusted", () => {
  assert.match(source, /actingActor = event\.isTrusted \? "person" : "driver"/);
  // Registration must not touch the DOM: herd mode imports this module headlessly.
  assert.match(source, /if \(typeof document !== "undefined"\) \{[\s\S]{0,200}addEventListener/);
});

test("a driver's change never toasts, and is stamped on the tile instead", () => {
  assert.match(
    source,
    /function announceChange\(actor, tileId, message, options\) \{\s*stampActor\(tileId, actor\);\s*if \(actor !== "person"\) return null;/,
    "announceChange must stamp first and then refuse to toast for a non-person",
  );
  // Every tile mutation routes its feedback through announceChange, not showToast.
  const lines = source.split("\n");
  for (const verb of ["Parked", "Made", "Folded", "Moved", "Bunched"]) {
    const index = lines.findIndex((l) => l.includes(`\`${verb} `));
    assert.ok(index >= 0, `expected a ${verb} message`);
    // The call may wrap, so read the statement rather than the single line.
    const statement = lines.slice(Math.max(0, index - 2), index + 1).join("\n");
    assert.match(
      statement,
      /announceChange\(/,
      `the ${verb} message must go through announceChange so a driver's action is silent`,
    );
    assert.doesNotMatch(
      statement,
      /(?<!\w)showToast\(`/,
      `the ${verb} message must not toast directly`,
    );
  }
});

test("each mutation captures the actor before it awaits", () => {
  // The mutation awaits IPC before it reports, so reading the actor afterwards
  // could attribute the change to whoever acted next.
  const captures = source.match(/const actor = actingActor;/g) || [];
  assert.ok(captures.length >= 5, `expected every mutation to capture the actor, saw ${captures.length}`);
});

test("the on-tile marker cannot swallow a click", () => {
  assert.match(css, /\.dimension-tile\.actor-marked::after \{[^}]*pointer-events: none/);
});
