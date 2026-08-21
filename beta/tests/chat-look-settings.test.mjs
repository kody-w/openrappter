import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  changeChatLook,
  readAmbientSettings,
  readChatLookSettings,
  resolveChatTypingEnabled,
  writeAmbientSettings,
  writeChatLookSettings,
} from "../electron/chat-look-settings.mjs";

test("chat look settings round-trip through the same change used by IPC", (t) => {
  const betaHome = mkdtempSync(path.join(tmpdir(), "rapp-chat-look-"));
  t.after(() => rmSync(betaHome, { recursive: true, force: true }));

  assert.deepEqual(
    readChatLookSettings({ betaHome, env: {} }),
    {
      chatLook: "messages",
      chatLookOverridden: false,
      chatTypingEnabled: false,
      file: path.join(betaHome, "settings.json"),
      storedChatLook: "messages",
    },
  );

  writeChatLookSettings({ betaHome, chatLook: "messages" });
  const applied = [];
  const changed = changeChatLook({
    apply: (value) => applied.push(value),
    betaHome,
    chatLook: "business",
    env: {},
  });
  assert.equal(changed.chatLook, "business");
  assert.equal(changed.chatTypingEnabled, false);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].chatLook, "business");

  const file = path.join(betaHome, "settings.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    chatLook: "business",
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(
    readChatLookSettings({ betaHome, env: {} }).chatLook,
    "business",
  );
});

test("environment look and typing overrides remain authoritative", (t) => {
  const betaHome = mkdtempSync(path.join(tmpdir(), "rapp-chat-look-env-"));
  t.after(() => rmSync(betaHome, { recursive: true, force: true }));
  writeChatLookSettings({ betaHome, chatLook: "messages" });

  const forcedBusiness = readChatLookSettings({
    betaHome,
    env: {
      RAPP_CHAT_LOOK: "business",
      RAPP_CHAT_TYPING: "1",
    },
  });
  assert.equal(forcedBusiness.chatLook, "business");
  assert.equal(forcedBusiness.storedChatLook, "messages");
  assert.equal(forcedBusiness.chatLookOverridden, true);
  assert.equal(forcedBusiness.chatTypingEnabled, true);

  assert.equal(resolveChatTypingEnabled("messages", {}), false);
  assert.equal(resolveChatTypingEnabled("business", {}), false);
  assert.equal(
    resolveChatTypingEnabled("messages", { RAPP_CHAT_TYPING: "0" }),
    false,
  );
  assert.equal(
    resolveChatTypingEnabled("messages", { RAPP_CHAT_STREAM: "hold" }),
    true,
  );
  assert.equal(
    resolveChatTypingEnabled("business", { RAPP_CHAT_TYPING: "1" }),
    true,
  );
});

test("trusted IPC and both menus use the persistent chat look change", () => {
  const main = readFileSync(
    new URL("../electron/main.mjs", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const preload = readFileSync(
    new URL("../electron/preload.cjs", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");

  assert.match(main, /ipcMain\.handle\("beta:set-chat-look"/);
  assert.match(main, /assertTrustedIpc\(event\)/);
  assert.match(main, /handleChatLookChange\(nextLook\)/);
  assert.match(main, /changeChatLook\(\{[\s\S]*?betaHome/);
  assert.match(main, /id: "chat-look-messages"/);
  assert.match(main, /id: "chat-look-business"/);
  assert.match(main, /beta-chat-look-messages/);
  assert.match(main, /rapp-beta:set-chat-look/);
  assert.match(preload, /setChatLook:/);
});

test("ambient location settings round-trip without discarding chat look", (t) => {
  const betaHome = mkdtempSync(path.join(tmpdir(), "rapp-ambient-settings-"));
  t.after(() => rmSync(betaHome, { recursive: true, force: true }));
  writeChatLookSettings({ betaHome, chatLook: "business" });

  assert.deepEqual(readAmbientSettings({ betaHome }), {
    approximateFallback: false,
    file: path.join(betaHome, "settings.json"),
    granularity: "precise",
    userLocation: null,
  });
  const saved = writeAmbientSettings({
    approximateFallback: true,
    betaHome,
    granularity: "city",
    userLocation: {
      label: "home",
      lat: 47.6062,
      lon: -122.3321,
    },
  });
  assert.deepEqual(saved.userLocation, {
    accuracy_m: 0,
    label: "home",
    lat: 47.6062,
    lon: -122.3321,
  });
  assert.equal(readChatLookSettings({ betaHome, env: {} }).chatLook, "business");
  assert.deepEqual(readAmbientSettings({ betaHome }), saved);
  assert.throws(
    () => writeAmbientSettings({
      betaHome,
      granularity: "precise",
      userLocation: { label: "bad", lat: 91, lon: -122 },
    }),
    /valid latitude/,
  );
  assert.throws(
    () => writeAmbientSettings({
      betaHome,
      granularity: "precise",
      userLocation: { label: "unresolved address" },
    }),
    /does not send labels or addresses to a geocoder/,
  );
  const redacted = writeAmbientSettings({
    betaHome,
    granularity: "precise",
    userLocation: {
      label: "password: precise-address",
      lat: 47.6062,
      lon: -122.3321,
    },
  });
  assert.match(redacted.userLocation.label, /\[redacted:password\]/);
  assert.doesNotMatch(
    readFileSync(path.join(betaHome, "settings.json"), "utf8"),
    /precise-address/,
  );
  if (process.platform !== "win32") {
    assert.equal(
      statSync(path.join(betaHome, "settings.json")).mode & 0o777,
      0o600,
    );
  }
});
