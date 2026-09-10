import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TeamsSettings } from "../electron/teams-settings.mjs";

test("remembered invitation credentials are encrypted and can be explicitly forgotten", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "rapp-teams-settings-"));
  try {
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text.split("").reverse().join("")),
      decryptString: (bytes) => bytes.toString().split("").reverse().join(""),
    };
    const store = new TeamsSettings({ directory, safeStorage });
    const url = "https://teams.microsoft.com/meet/123?p=not-a-real-passcode";
    assert.equal(store.read(), null);
    store.write({ identity: "r1", url, remember: true, speak: true });
    const persisted = readFileSync(store.file, "utf8");
    assert.equal(persisted.includes(url), false);
    assert.equal(persisted.includes("not-a-real-passcode"), false);
    assert.equal(store.read().url, url);
    assert.equal(store.read().speak, false);
    store.write({ identity: "r1", url, remember: false });
    assert.equal(existsSync(store.file), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("no plaintext fallback is possible when secure storage is unavailable", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "rapp-teams-settings-"));
  try {
    const store = new TeamsSettings({
      directory,
      safeStorage: { isEncryptionAvailable: () => false },
    });
    assert.throws(() => store.write({
      url: "https://teams.microsoft.com/meet/123",
      remember: true,
    }), /Secure storage/);
    assert.equal(existsSync(store.file), false);
    store.write({ url: "https://teams.microsoft.com/meet/123", remember: false });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
