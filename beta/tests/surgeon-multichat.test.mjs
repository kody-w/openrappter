import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { uiDriverInternals } from "../electron/ui-driver-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (r) => (
  readFileSync(path.join(root, r), "utf8").replaceAll("\r\n", "\n")
);
const renderer = read("ui/renderer.js");
const ui = read("ui/index.html");
const preload = read("electron/preload.cjs");
const main = read("electron/main.mjs");
const typingDelivery = read("ui/typing-delivery.js");

test("renderer models several Copilot chats as tabs + a herd grid", () => {
  execFileSync(process.execPath, ["--check", path.join(root, "ui/renderer.js")]);
  assert.match(renderer, /let surgeonSessions = \[\]/);
  assert.match(renderer, /function newSurgeonSession/);
  assert.match(renderer, /function closeSurgeonSession/);
  assert.match(renderer, /function renderSurgeonTabs/);
  assert.match(renderer, /function enterSurgeonHerd/);
  assert.match(renderer, /function exitSurgeonHerd/);
  assert.match(renderer, /function toggleSurgeonHerd/);
  // each event routes to its own session by id
  assert.match(renderer, /surgeonSessions\.find\(\(s\) => s\.id === event\.sessionId\)/);
  // sends and resets carry the session id
  assert.match(renderer, /brainstemBeta\.surgeonSend\(session\.id, text\)/);
  assert.match(renderer, /brainstemBeta\.surgeonClose\(/);
  // clearSurgeonUi survives (installer-contract depends on it) but is per-session
  assert.match(renderer, /function clearSurgeonUi\(\)/);
});

test("the shell has the tab strip, herd button, and wrapping herd grid", () => {
  assert.match(ui, /id="surgeon-tabs"/);
  assert.match(ui, /id="surgeon-herd-btn"/);
  assert.match(ui, /title="Herd view"/);
  assert.match(ui, /\.surgeon-session/);
  assert.match(ui, /body\.surgeon-herd-open main/);
  assert.match(
    ui,
    /#surgeon-herd \.herd-grid \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: repeat\(auto-fill, minmax\(300px, 1fr\)\)/,
  );
  assert.match(
    ui,
    /@media \(max-width: 640px\) \{[\s\S]*?#surgeon-herd \.herd-grid \{ grid-template-columns: 1fr; \}/,
  );
  assert.doesNotMatch(ui, /#surgeon-herd \.herd-grid \{[\s\S]*?scroll-snap-type/);
  // the log is a plain scroll container; sessions carry the flex/gap/padding
  assert.match(ui, /\.surgeon-session \{\s*display: flex;/);
});

test("preload and main key Rappter Surgeon by session id", () => {
  assert.match(preload, /surgeonSend: \(sessionId, prompt\)/);
  assert.match(preload, /surgeonClose:/);
  assert.match(preload, /beta:surgeon-close/);
  assert.match(main, /const rappterSurgeons = new Map\(\)/);
  assert.match(main, /ensureRappterSurgeon\(sessionId\)\.send\(prompt\)/);
  assert.match(main, /emitSurgeonEvent\(\{ \.\.\.event, sessionId: id \}\)/);
  assert.match(main, /beta:surgeon-close/);
});

test("the shared driver bus serializes every caller once per visible frame", async () => {
  assert.doesNotMatch(main, /UI_STAGE_ACTIONS|uiStageChain|rawUiCommand/);
  assert.match(main, /async function executeUiCommand/);
  assert.equal(uiDriverInternals.frameKeyForCommand({ action: "click" }), "brainstem");
  assert.equal(
    uiDriverInternals.frameKeyForCommand({ action: "inspect", target: "shell" }),
    "shell",
  );
  assert.equal(
    uiDriverInternals.frameKeyForCommand({ action: "click", twin: "alpha" }),
    "twin:alpha",
  );

  const queue = uiDriverInternals.createFrameQueue();
  const releaseFirst = await queue.enter("brainstem");
  let secondEntered = false;
  const second = queue.enter("brainstem").then((release) => {
    secondEntered = true;
    return release;
  });
  const releaseShell = await queue.enter("shell");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, false);
  releaseShell();
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondEntered, true);
  releaseSecond();
  assert.equal(queue.size, 0);
});

test("Rappter Surgeon keeps the accessible typing bubble for explicit hold mode", () => {
  assert.match(typingDelivery, /function createDelivery/);
  assert.ok(
    ui.indexOf('<script src="typing-delivery.js"></script>')
      < ui.indexOf('<script src="renderer.js"></script>'),
  );
  assert.match(main, /readChatLookSettings/);
  assert.match(main, /resolveChatStreamMode\(process\.env\)/);
  assert.match(main, /--rapp-chat-stream=/);
  assert.match(main, /--rapp-chat-look=/);
  assert.match(preload, /chatStreamMode/);
  assert.match(preload, /chatLook/);
  assert.match(renderer, /chatTypingEnabled = chatStreamMode === "hold"/);
  assert.match(renderer, /createSurgeonDelivery/);
  assert.match(renderer, /session\.delivery\?\.push/);
  assert.match(renderer, /session\.delivery\?\.finish/);
  assert.match(renderer, /session\.delivery\?\.fail/);
  assert.match(renderer, /aria-live", "polite"/);
  assert.match(renderer, /Rappter Surgeon is typing…/);
  assert.match(ui, /\.surgeon-message\.assistant\.typing/);
  assert.match(ui, /@media \(prefers-reduced-motion: reduce\)/);
});
