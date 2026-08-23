import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertOpenRappterSpeciesIsolation } from "../electron/species-isolation.mjs";

test("OpenRappter accepts only species-owned mutable roots", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "species-isolation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const openRappterHome = path.join(home, ".openrappter");
  const brainstemHome = path.join(openRappterHome, "brainstem");
  const brainstemDir = path.join(brainstemHome, "src", "rapp_brainstem");
  const betaHome = path.join(openRappterHome, "desktop");
  fs.mkdirSync(brainstemDir, { recursive: true });
  const canonicalHome = fs.realpathSync(home);
  assert.deepEqual(
    assertOpenRappterSpeciesIsolation({
      home,
      openRappterHome,
      betaHome,
      brainstemHome,
      brainstemDir,
    }),
    {
      openRappterHome: path.join(canonicalHome, ".openrappter"),
      betaHome: path.join(canonicalHome, ".openrappter", "desktop"),
      brainstemHome: path.join(canonicalHome, ".openrappter", "brainstem"),
      brainstemDir: path.join(
        canonicalHome,
        ".openrappter",
        "brainstem",
        "src",
        "rapp_brainstem",
      ),
      standaloneBrainstemHome: path.join(canonicalHome, ".brainstem"),
    },
  );
});

test("OpenRappter refuses every path back into bare Brainstem", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "species-isolation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const standalone = path.join(home, ".brainstem");
  fs.mkdirSync(path.join(standalone, "src", "rapp_brainstem"), { recursive: true });
  const safeHome = path.join(home, ".openrappter");
  for (const value of [
    {
      openRappterHome: standalone,
      betaHome: path.join(standalone, "desktop"),
      brainstemHome: path.join(standalone, "openrappter"),
      brainstemDir: path.join(standalone, "src", "rapp_brainstem"),
    },
    {
      openRappterHome: safeHome,
      betaHome: path.join(safeHome, "desktop"),
      brainstemHome: standalone,
      brainstemDir: path.join(standalone, "src", "rapp_brainstem"),
    },
    {
      openRappterHome: safeHome,
      betaHome: path.join(safeHome, "desktop"),
      brainstemHome: path.join(safeHome, "brainstem"),
      brainstemDir: path.join(standalone, "src", "rapp_brainstem"),
    },
    {
      openRappterHome: safeHome,
      betaHome: path.join(standalone, "openrappter-desktop"),
      brainstemHome: path.join(safeHome, "brainstem"),
      brainstemDir: path.join(safeHome, "brainstem", "src", "rapp_brainstem"),
    },
  ]) {
    assert.throws(
      () => assertOpenRappterSpeciesIsolation({ home, ...value }),
      /species|Brainstem|shared|isolation/i,
    );
  }
});

test("a symlink cannot disguise bare Brainstem as OpenRappter state", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "species-isolation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const standalone = path.join(home, ".brainstem");
  const safeHome = path.join(home, ".openrappter");
  fs.mkdirSync(path.join(standalone, "src", "rapp_brainstem"), { recursive: true });
  fs.mkdirSync(safeHome, { recursive: true });
  const disguised = path.join(safeHome, "brainstem");
  fs.symlinkSync(standalone, disguised);
  assert.throws(
    () => assertOpenRappterSpeciesIsolation({
      home,
      openRappterHome: safeHome,
      betaHome: path.join(safeHome, "desktop"),
      brainstemHome: disguised,
      brainstemDir: path.join(disguised, "src", "rapp_brainstem"),
    }),
    /species|Brainstem|shared|isolation/i,
  );
});

test("the application and installers enforce species isolation", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const main = fs.readFileSync(path.join(root, "electron", "main.mjs"), "utf8");
  const unix = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  const windows = fs.readFileSync(path.join(root, "install.cmd"), "utf8");
  assert.match(main, /assertOpenRappterSpeciesIsolation/);
  assert.match(unix, /canonical_future_directory/);
  assert.match(unix, /paths_overlap/);
  assert.match(windows, /GetFullPath/);
  assert.match(windows, /ReparsePoint/);
});

test("the Unix installer rejects lexical and symlink drift before writes", {
  skip: process.platform === "win32",
}, (t) => {
  const root = path.resolve(import.meta.dirname, "..");
  const installer = path.join(root, "install.sh");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "species-installer-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bare = path.join(home, ".brainstem");
  fs.mkdirSync(bare);
  const run = (extra = {}) => spawnSync("bash", [installer], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      BRAINSTEM_BETA_VALIDATE_PATHS_ONLY: "1",
      ...extra,
    },
  });

  assert.equal(run().status, 0);
  const lexicalTarget = path.join(bare, "openrappter");
  const lexical = run({
    OPENRAPPTER_HOME: path.join(
      home,
      ".openrappter",
      "..",
      ".brainstem",
      "openrappter",
    ),
  });
  assert.notEqual(lexical.status, 0);
  assert.match(lexical.stderr, /species driftback/i);
  assert.equal(fs.existsSync(lexicalTarget), false);

  const alias = path.join(home, "brainstem-alias");
  fs.symlinkSync(bare, alias);
  const disguised = run({
    OPENRAPPTER_HOME: path.join(alias, "openrappter"),
  });
  assert.notEqual(disguised.status, 0);
  assert.match(disguised.stderr, /species driftback/i);
  assert.equal(fs.existsSync(lexicalTarget), false);
});
