import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../ui/chat-look.js");

const renderer = readFileSync(
  new URL("../ui/renderer.js", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const shell = readFileSync(
  new URL("../ui/index.html", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const {
  markArrived,
  markGroupLast,
} = globalThis.RappChatLook;

function fakeBubble(...classes) {
  const attributes = new Set();
  const names = new Set(classes);
  return {
    classList: {
      add: (...values) => values.forEach((value) => names.add(value)),
      contains: (value) => names.has(value),
      remove: (...values) => values.forEach((value) => names.delete(value)),
    },
    hasAttribute: (name) => attributes.has(name),
    removeAttribute: (name) => attributes.delete(name),
    setAttribute: (name) => attributes.add(name),
  };
}

test("renderer loads look data before creating chat markup", () => {
  assert.ok(
    shell.indexOf('<script src="chat-look.js"></script>')
      < shell.indexOf('<script src="renderer.js"></script>'),
  );
  assert.match(renderer, /function applyShellChatLook/);
  assert.match(renderer, /__rappSurgeonChatLook/);
  assert.match(renderer, /syncSurgeonMessageGroups/);
  assert.match(renderer, /syncTwinMessageGroups/);
});

test("Surgeon bubble grouping gains and loses the look classes", () => {
  const firstUser = fakeBubble("surgeon-message", "user");
  const lastUser = fakeBubble("surgeon-message", "user");
  const assistant = fakeBubble("surgeon-message", "assistant");

  markGroupLast([firstUser, lastUser, assistant]);
  assert.equal(firstUser.classList.contains("rapp-group-last"), false);
  assert.equal(lastUser.classList.contains("rapp-group-last"), true);
  assert.equal(lastUser.hasAttribute("data-group-last"), true);
  assert.equal(assistant.classList.contains("rapp-group-last"), true);

  markGroupLast([firstUser, lastUser, assistant], () => null);
  assert.equal(lastUser.classList.contains("rapp-group-last"), false);
  assert.equal(lastUser.hasAttribute("data-group-last"), false);
  assert.equal(assistant.classList.contains("rapp-group-last"), false);

  markArrived(assistant);
  assert.equal(assistant.classList.contains("rapp-message-arrived"), true);
  assert.equal(assistant.hasAttribute("data-rapp-arrived"), true);
  markArrived(assistant, false);
  assert.equal(assistant.classList.contains("rapp-message-arrived"), false);
  assert.equal(assistant.hasAttribute("data-rapp-arrived"), false);
});
