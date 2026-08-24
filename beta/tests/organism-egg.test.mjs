import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { OrganismEggAdapter } from "../electron/organism-egg-adapter.mjs";
import {
  packEgg,
  verifyEgg,
} from "../electron/rapp-protocol.mjs";

const root = path.resolve(".test-output", "organism-egg-adapter");
const cli = path.join(root, "fake-openrappter.mjs");

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(cli, `
    let stdin = "";
    for await (const chunk of process.stdin) stdin += chunk;
    process.stdout.write(JSON.stringify({
      argv: process.argv.slice(2),
      home: process.env.OPENRAPPTER_HOME,
      passphraseReceived: stdin.trim().length > 0
    }));
  `);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("XPedition adapter exposes beta.11 typed capabilities and never puts passphrases in argv", async () => {
  const adapter = new OrganismEggAdapter({
    openRappterHome: path.join(root, "home"),
    packageDir: path.resolve("."),
    cliPath: cli,
  });
  const result = await adapter.apply(path.join(root, "fixture.egg"), {
    semantics: "restore",
    approval: "a".repeat(64),
    previewHandle: `${"b".repeat(64)}.00000000-0000-4000-8000-000000000000`,
    nonce: "00000000-0000-4000-8000-000000000000",
    targetRappid: `rappid:@openrappter/organism:${"c".repeat(64)}`,
    passphrase: "fixture-passphrase",
  });
  assert.equal(adapter.capabilities.requiredDesktop, "0.1.0-beta.11");
  assert.equal(adapter.capabilities.semanticControlMayApplySealed, false);
  assert.equal(result.passphraseReceived, true);
  assert.equal(result.argv.includes("fixture-passphrase"), false);
  assert.equal(result.home, path.join(root, "home"));
});

test("Quantum RAPPID UI shows dimensions, privacy, diff, reauth, MIDI, and native approval", () => {
  const html = readFileSync(path.resolve("ui", "index.html"), "utf8");
  const renderer = readFileSync(path.resolve("ui", "renderer.js"), "utf8");
  const main = readFileSync(path.resolve("electron", "main.mjs"), "utf8");
  const preload = readFileSync(path.resolve("electron", "preload.cjs"), "utf8");

  assert.match(html, /Quantum RAPPID · Import \/ Export \/ Backup/);
  assert.match(html, /organism-egg-passphrase/);
  assert.match(renderer, /dimensions\.midi/);
  assert.match(renderer, /reauth:/);
  assert.match(renderer, /excluded:/);
  assert.match(renderer, /approvalBinding/);
  assert.match(main, /showMessageBox/);
  assert.match(main, /Apply verified restore/);
  assert.match(preload, /organismEggApply/);
});

test("organism artifacts pass the existing beta RAPP/1 verifyEgg implementation directly", () => {
  const rappid = `rappid:@openrappter/organism:${"a".repeat(64)}`;
  const artifact = packEgg({
    variant: "rapplication",
    rappid,
    createdUtc: "2026-08-23T20:00:00.000Z",
    files: {
      "organism/manifest.json": Buffer.from(JSON.stringify({
        profile: "openrappter-organism-egg/1.0",
        organismRappid: rappid,
        synthetic: true,
      })),
    },
    payload: {
      profile: "openrappter-organism-egg/1.0",
      synthetic_fixture: true,
    },
  });
  assert.deepEqual(verifyEgg(artifact), [true, null, "ok"]);
});
