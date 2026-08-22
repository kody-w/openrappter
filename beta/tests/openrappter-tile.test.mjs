import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OPENRAPPTER_TILE_SCHEMA,
  OpenRappterTileStore,
  verifyOpenRappterTile,
} from "../electron/openrappter-tile.mjs";

const betaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (relative) => fs.readFileSync(path.join(betaRoot, relative), "utf8");

function fixture(t, { now = "2026-08-21T12:00:00.000Z" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrappter-tile-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const betaHome = path.join(home, "beta-home");
  const brainstemDir = path.join(home, "brainstem");

  fs.mkdirSync(path.join(betaHome, "routing"), { recursive: true });
  fs.mkdirSync(path.join(betaHome, "tiles"), { recursive: true });
  fs.mkdirSync(path.join(betaHome, "logs"), { recursive: true });
  fs.mkdirSync(path.join(betaHome, "captures"), { recursive: true });
  fs.mkdirSync(path.join(brainstemDir, "agents", "__pycache__"), { recursive: true });
  fs.mkdirSync(
    path.join(brainstemDir, ".brainstem_data", "shared_memories"),
    { recursive: true },
  );

  fs.writeFileSync(path.join(brainstemDir, "soul.md"), "You are local.\n");
  fs.writeFileSync(path.join(brainstemDir, "agents", "hello_agent.py"), "print('hello')\n");
  fs.writeFileSync(path.join(brainstemDir, "agents", "hello_agent.py.card"), "{}\n");
  fs.writeFileSync(path.join(brainstemDir, "agents", "__pycache__", "hello.pyc"), "compiled");
  fs.writeFileSync(path.join(brainstemDir, ".copilot_token"), "secret-token");
  fs.writeFileSync(path.join(brainstemDir, ".env"), "SECRET=value\n");
  fs.writeFileSync(
    path.join(brainstemDir, ".brainstem_data", "shared_memories", "memory.json"),
    '{"memory":"kept"}\n',
  );
  fs.writeFileSync(path.join(betaHome, "settings.json"), '{"viewMode":{"mode":"arena"}}\n');
  fs.writeFileSync(
    path.join(betaHome, "neighborhood.json"),
    '{"schema":"openrappter-good-ai-neighbor/1.0","neighborhood_id":"openrappter:local"}\n',
  );
  fs.writeFileSync(path.join(betaHome, "routing", "identity.json"), '{"caller":"local"}\n');
  fs.writeFileSync(path.join(betaHome, "tiles", "tile-local.json"), '{"tile":"parked"}\n');
  fs.writeFileSync(path.join(betaHome, "logs", "ui-driver.jsonl"), "private log\n");
  fs.writeFileSync(path.join(betaHome, "captures", "screen.png"), "image bytes\n");

  return {
    betaHome,
    brainstemDir,
    home,
    store: new OpenRappterTileStore({
      betaHome,
      brainstemDir,
      now: () => new Date(now),
    }),
  };
}

function entryText(tile, entryPath) {
  const entry = tile.files.find((candidate) => candidate.path === entryPath);
  assert.ok(entry, `${entryPath} must be present`);
  return Buffer.from(entry.content_base64, "base64").toString("utf8");
}

test("OpenRappter exports itself as one verified local tile", (t) => {
  const { store } = fixture(t);
  const tile = store.createTile();

  assert.equal(tile.schema, OPENRAPPTER_TILE_SCHEMA);
  assert.equal(tile.kind, "openrappter.local");
  assert.equal(tile.local, true);
  assert.match(tile.rappid, /^rappid:@openrappter\/local:[0-9a-f]{64}$/);
  assert.deepEqual(
    tile.files.map((entry) => entry.path),
    [
      "brainstem/agents/hello_agent.py",
      "brainstem/agents/hello_agent.py.card",
      "brainstem/data/shared_memories/memory.json",
      "brainstem/soul.md",
      "openrappter/neighborhood.json",
      "openrappter/routing/identity.json",
      "openrappter/settings.json",
      "openrappter/tiles/tile-local.json",
    ],
  );
  assert.equal(entryText(tile, "brainstem/soul.md"), "You are local.\n");

  const encoded = JSON.stringify(tile);
  for (const forbidden of [
    "secret-token",
    "SECRET=value",
    "__pycache__",
    "private log",
    "image bytes",
  ]) {
    assert.equal(encoded.includes(forbidden), false, `${forbidden} must not enter the tile`);
  }
  assert.deepEqual(verifyOpenRappterTile(tile), tile);
});

test("tile identity is content-addressed, not clock-addressed", (t) => {
  const first = fixture(t, { now: "2026-08-21T12:00:00.000Z" });
  const secondStore = new OpenRappterTileStore({
    betaHome: first.betaHome,
    brainstemDir: first.brainstemDir,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  const a = first.store.createTile();
  const b = secondStore.createTile();
  assert.notEqual(a.created_at, b.created_at);
  assert.equal(a.content_hash, b.content_hash);
  assert.equal(a.rappid, b.rappid);
  fs.writeFileSync(
    path.join(first.brainstemDir, "soul.md"),
    "A changed body with the same identity.\n",
  );
  const changed = first.store.createTile();
  assert.equal(changed.rappid, a.rappid, "identity is minted once");
  assert.notEqual(changed.content_hash, a.content_hash, "content address tracks the changed body");
});

test("verification rejects tampering, duplicate paths, and traversal", (t) => {
  const { store } = fixture(t);
  const tile = store.createTile();

  const tampered = structuredClone(tile);
  tampered.files[0].content_base64 = Buffer.from("edited").toString("base64");
  assert.throws(() => verifyOpenRappterTile(tampered), /byte count|sha256|hash/i);

  const duplicate = structuredClone(tile);
  duplicate.files.push(structuredClone(duplicate.files[0]));
  assert.throws(() => verifyOpenRappterTile(duplicate), /duplicate/i);

  const traversal = structuredClone(tile);
  traversal.files[0].path = "../.copilot_token";
  assert.throws(() => verifyOpenRappterTile(traversal), /path|allowlist|relative/i);

  const hidden = structuredClone(tile);
  hidden.files[0].path = "brainstem/agents/.hidden_agent.py";
  assert.throws(() => verifyOpenRappterTile(hidden), /path|allowlist|hidden/i);
});

test("import restores managed state and first backs up what it replaces", (t) => {
  const { betaHome, brainstemDir, store } = fixture(t);
  const exported = path.join(path.dirname(betaHome), "local.openrappter.tile");
  store.exportTile(exported);

  fs.writeFileSync(path.join(brainstemDir, "soul.md"), "mutated soul\n");
  fs.writeFileSync(path.join(brainstemDir, "agents", "hello_agent.py"), "print('mutated')\n");
  fs.writeFileSync(path.join(brainstemDir, "agents", "later_agent.py"), "print('later')\n");
  fs.writeFileSync(path.join(betaHome, "settings.json"), '{"viewMode":{"mode":"herd"}}\n');
  fs.writeFileSync(
    path.join(betaHome, "neighborhood.json"),
    '{"schema":"openrappter-good-ai-neighbor/1.0","neighborhood_id":"openrappter:mutated"}\n',
  );

  const result = store.importTile(exported);
  assert.equal(result.imported, 8);
  assert.ok(fs.existsSync(result.backup), "pre-import backup must exist");
  assert.equal(fs.readFileSync(path.join(brainstemDir, "soul.md"), "utf8"), "You are local.\n");
  assert.equal(
    fs.readFileSync(path.join(brainstemDir, "agents", "hello_agent.py"), "utf8"),
    "print('hello')\n",
  );
  assert.equal(
    fs.readFileSync(path.join(betaHome, "settings.json"), "utf8"),
    '{"viewMode":{"mode":"arena"}}\n',
  );
  assert.equal(
    fs.readFileSync(path.join(betaHome, "neighborhood.json"), "utf8"),
    '{"schema":"openrappter-good-ai-neighbor/1.0","neighborhood_id":"openrappter:local"}\n',
    "the estate manifest must round-trip with the verified self tile",
  );
  assert.equal(
    fs.existsSync(path.join(brainstemDir, "agents", "later_agent.py")),
    false,
    "restore removes managed state created after the exported tile",
  );

  const backup = store.readTile(result.backup);
  assert.equal(entryText(backup, "brainstem/soul.md"), "mutated soul\n");
});

test("import refuses symlink drift before touching either species", (t) => {
  const { betaHome, brainstemDir, home, store } = fixture(t);
  const exported = path.join(home, "safe.openrappter.tile");
  store.exportTile(exported);
  const outside = path.join(home, "outside-agent.py");
  fs.writeFileSync(outside, "outside stays outside\n");
  const agent = path.join(brainstemDir, "agents", "hello_agent.py");
  fs.rmSync(agent);
  fs.symlinkSync(outside, agent);

  assert.throws(() => store.importTile(exported), /symlink|regular file|managed path/i);
  assert.equal(fs.lstatSync(agent).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside stays outside\n");
  assert.equal(
    fs.readFileSync(path.join(betaHome, "settings.json"), "utf8"),
    '{"viewMode":{"mode":"arena"}}\n',
  );
});

test("managed directory symlinks fail before export, backup, or deletion", (t) => {
  const { brainstemDir, home, store } = fixture(t);
  const exported = path.join(home, "safe-root.openrappter.tile");
  store.exportTile(exported);
  const agents = path.join(brainstemDir, "agents");
  const outside = path.join(home, "outside-agents");
  fs.renameSync(agents, outside);
  fs.symlinkSync(outside, agents);

  assert.throws(() => store.createTile(), /managed root|symlink|real directory/i);
  assert.throws(() => store.backup(), /managed root|symlink|real directory/i);
  assert.throws(() => store.importTile(exported), /managed root|symlink|real directory/i);
  assert.equal(
    fs.readFileSync(path.join(outside, "hello_agent.py"), "utf8"),
    "print('hello')\n",
    "a managed-root alias must never delete or rewrite its external target",
  );
});

test("top-level tile roots reject symlink aliases before any scan", (t) => {
  const { betaHome, brainstemDir, home } = fixture(t);
  const betaAlias = path.join(home, "beta-alias");
  const brainstemAlias = path.join(home, "brainstem-alias");
  fs.symlinkSync(betaHome, betaAlias);
  fs.symlinkSync(brainstemDir, brainstemAlias);

  assert.throws(
    () => new OpenRappterTileStore({
      betaHome: betaAlias,
      brainstemDir,
    }),
    /betaHome.*symlink/i,
  );
  assert.throws(
    () => new OpenRappterTileStore({
      betaHome,
      brainstemDir: brainstemAlias,
    }),
    /brainstemDir.*symlink/i,
  );
});

test("verified tiles can explicitly restore a missing identity after reinstall", (t) => {
  const source = fixture(t);
  const exported = path.join(source.home, "recovery.openrappter.tile");
  const sourceTile = source.store.exportTile(exported).tile;
  const recoveredHome = path.join(source.home, "reinstalled");
  const recoveredBeta = path.join(recoveredHome, "desktop");
  const recoveredBrainstem = path.join(
    recoveredHome,
    "brainstem",
    "src",
    "rapp_brainstem",
  );
  fs.mkdirSync(recoveredBeta, { recursive: true });
  fs.mkdirSync(recoveredBrainstem, { recursive: true });
  const recovered = new OpenRappterTileStore({
    betaHome: recoveredBeta,
    brainstemDir: recoveredBrainstem,
    now: () => new Date("2026-08-21T13:00:00.000Z"),
  });
  const recoveredIdentity = path.join(
    recoveredBeta,
    "identity",
    "openrappter.json",
  );

  assert.throws(
    () => recovered.importTile(exported),
    /identity is missing|explicit adopt/i,
  );
  assert.equal(fs.existsSync(recoveredIdentity), false);
  const result = recovered.importTile(exported, { adoptIdentity: true });
  assert.equal(result.rappid, sourceTile.rappid);
  const identity = JSON.parse(fs.readFileSync(recoveredIdentity, "utf8"));
  assert.equal(identity.rappid, sourceTile.rappid);
  assert.equal(identity.origin, "adopted-from-verified-tile");
  assert.equal(recovered.createTile().content_hash, sourceTile.content_hash);
});

test("exports and backups are private and collision-safe", (t) => {
  const { home, store } = fixture(t);
  const previousUmask = process.umask(0o000);
  t.after(() => process.umask(previousUmask));

  const exported = path.join(home, "portable.openrappter.tile");
  store.exportTile(exported);
  const first = store.backup();
  const second = store.backup();
  assert.equal(fs.statSync(exported).mode & 0o777, 0o600);
  assert.equal(fs.statSync(first).mode & 0o777, 0o600);
  assert.equal(fs.statSync(second).mode & 0o777, 0o600);
  assert.notEqual(first, second, "two backups in one millisecond need distinct paths");
  assert.deepEqual(store.listBackups(), [second, first]);
});

test("the desktop and CLI expose self-tile export, import, and backup", () => {
  const main = readSource("electron/main.mjs");
  const preload = readSource("electron/preload.cjs");
  const ui = readSource("ui/index.html");
  const renderer = readSource("ui/renderer.js");
  const packageJson = JSON.parse(readSource("package.json"));
  const unixInstaller = readSource("install.sh");
  const windowsInstaller = readSource("install.cmd");

  for (const channel of [
    "beta:openrappter-tile-describe",
    "beta:openrappter-tile-export",
    "beta:openrappter-tile-import",
    "beta:openrappter-tile-backup",
  ]) {
    assert.ok(main.includes(channel), `${channel} must be handled`);
    assert.ok(preload.includes(channel), `${channel} must be exposed`);
  }
  assert.match(ui, /id="openrappter-self-tile"/);
  assert.match(ui, /id="openrappter-tile-export"/);
  assert.match(ui, /id="openrappter-tile-import"/);
  assert.match(ui, /id="openrappter-tile-backup"/);
  assert.match(renderer, /openrappterTileExport/);
  assert.match(renderer, /openrappterTileImport/);
  assert.match(renderer, /openrappterTileBackup/);
  assert.ok(packageJson.build.files.includes("scripts/openrappter-tile.mjs"));
  assert.match(packageJson.scripts["tile:describe"], /openrappter-tile\.mjs describe/);
  assert.match(readSource("scripts/openrappter-tile.mjs"), /adoptIdentity: true/);
  assert.match(unixInstaller, /\.local\/bin\/openrappter-tile/);
  assert.match(windowsInstaller, /openrappter-tile\.cmd/);
});
