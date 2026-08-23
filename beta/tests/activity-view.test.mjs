import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { createActivityViewInstallationSource } from "../electron/activity-view.mjs";
import { createFakeWindow, FakeDocument } from "./helpers/fake-dom.mjs";

// Normalised to LF at read. These tests locate regions of the source with
// searches like indexOf("\n}\n\nfunction ..."), which find nothing on a Windows
// checkout where the file is CRLF — the region comes back empty and the test
// fails claiming the code is missing. Normalising once fixes every search in
// this file rather than each pattern being hardened separately.
const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

function installActivityView() {
  const document = new FakeDocument();
  const chat = document.createElement("div");
  chat.id = "chat";
  document.body.appendChild(chat);
  const window = createFakeWindow(document);
  window.window = window;
  vm.runInContext(
    createActivityViewInstallationSource(),
    vm.createContext(window),
  );
  return { chat, document, window };
}

test("the driver step feed mounts on the body, never in the transcript", () => {
  const { chat, document, window } = installActivityView();
  assert.equal(window.__rappBetaSetActivityView(true), true);
  assert.equal(window.__rappBetaRenderDriveStep("driver step"), true);
  const feed = document.getElementById("beta-drive-feed");
  assert.equal(feed.parentElement, document.body);
  assert.equal(
    chat.querySelectorAll("#beta-drive-feed,[data-drive-step-tile]").length,
    0,
    "no driver step may land inside #chat",
  );
});

test("the activity view is off by default and disabling it removes its surface", () => {
  const { document, window } = installActivityView();
  assert.equal(window.__rappBetaRenderDriveStep("hidden step"), false);
  assert.equal(document.getElementById("beta-drive-feed"), null);

  window.__rappBetaSetActivityView(true);
  assert.equal(window.__rappBetaRenderDriveStep("visible step"), true);
  assert.ok(document.getElementById("beta-drive-feed"));
  assert.equal(window.__rappBetaSetActivityView(false), false);
  assert.equal(document.getElementById("beta-drive-feed"), null);
});

test("the activity strip cannot intercept the person's clicks", () => {
  assert.match(
    main,
    /\.beta-drive-feed\{position:fixed[^}]*/,
    "the strip must be fixed-position rather than in the document flow",
  );
  const rule = main.slice(main.indexOf('".beta-drive-feed{position:fixed'));
  assert.match(rule.slice(0, 400), /pointer-events:none/);
});
