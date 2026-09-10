import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createTeamsPageControlSource } from "../electron/teams-page-control.mjs";

const source = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const main = source("../electron/main.mjs");
const preload = source("../electron/preload.cjs");
const mediaPreload = source("../electron/teams-media-preload.cjs");
const html = source("../ui/index.html");
const ui = source("../ui/teams-meeting.js");
const css = source("../ui/teams-meeting.css");

test("the Teams entry point is a semantic control in the existing shell", () => {
  assert.match(html, /id="teams-open" data-drive="shell\.teamsOpen"/);
  assert.match(html, />Meet now in Teams<\/button>/);
  for (const name of ["url", "identity", "camera", "vision", "listen", "speak", "stop", "show"]) {
    assert.match(html, new RegExp(`id="teams-${name}"`));
  }
  assert.match(html, /aria-labelledby="teams-title"/);
  assert.match(html, /id="teams-settings-open" data-drive="shell\.teamsSettings"/);
  assert.match(html, /id="teams-forget" data-drive="shell\.teamsForget"/);
  assert.match(html, /<script src="teams-meeting\.js"><\/script>/);
  assert.match(ui, /options: \{ \.\.\.preferences, speak: false \}/);
  assert.match(ui, /stop\.disabled = !active\(\)/);
  assert.match(ui, /state\.error \|\| localError/);
  assert.match(css, /body > main \{[\s\S]*top: var\(--teams-shell-chrome-height\)/);
  assert.match(css, /body > #surgeon-herd \{[\s\S]*height: calc\(100dvh - var\(--teams-shell-chrome-height\)\)/);
});

test("Teams commands use the one existing trusted shell bridge", () => {
  assert.equal((preload.match(/contextBridge\.exposeInMainWorld/g) || []).length, 1);
  assert.match(preload, /teamsPreferences: \(\) => ipcRenderer\.invoke\("beta:teams-preferences"\)/);
  assert.match(preload, /teamsCommand: \(command\) => ipcRenderer\.invoke\("beta:teams-command", command\)/);
  const handlers = main.slice(main.indexOf('ipcMain.handle("beta:teams-preferences"'), main.indexOf('ipcMain.handle("beta:get-state"'));
  assert.equal((handlers.match(/assertTrustedIpc\(event\)/g) || []).length, 2);
  assert.match(handlers, /Unsupported Teams operation/);
  assert.match(main, /teamsMeeting\?\.dispose\(\)/);
});

test("the external meeting preload has no file or generic execution bridge", () => {
  assert.match(mediaPreload, /event\.source !== window/);
  assert.match(mediaPreload, /event\.origin !== location\.origin/);
  assert.match(mediaPreload, /hosts\.has\(location\.hostname\)/);
  assert.doesNotMatch(mediaPreload, /node:fs|child_process|executeJavaScript|contextBridge\.exposeInMainWorld/);
  assert.match(mediaPreload, /payload\.wavBase64\.length > 350000/);
  assert.match(mediaPreload, /payload\.jpegBase64\.length > 131072/);
});

test("page automation accepts only bounded semantic commands", () => {
  assert.throws(() => createTeamsPageControlSource({ action: "eval", source: "anything" }));
  assert.throws(() => createTeamsPageControlSource({ action: "send-chat", key: "../other", text: "hello" }));
  assert.throws(() => createTeamsPageControlSource({ action: "send-chat", key: "test", text: "x".repeat(2001) }));
  const command = createTeamsPageControlSource({ action: "send-chat", key: "test-1", text: "<script>plain chat text</script>" });
  assert.match(command, /document\.execCommand\("insertText"/);
  assert.doesNotMatch(command, /\.innerHTML\s*=/);
  assert.match(command, /__rappMeetingReceipts/);
});
