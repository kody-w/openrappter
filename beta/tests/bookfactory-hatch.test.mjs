import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { routeManagerInternals } from "../electron/route-manager.mjs";
import { testPython } from "./_python.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, "fixtures", "bookfactory-hatch");
const brainstemDir = path.resolve(here, "..", "..", "rapp_brainstem");
const provenance = JSON.parse(
  readFileSync(path.join(fixtureRoot, "provenance.json"), "utf8"),
);

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function dryLoadFixture(t, fixture) {
  const root = mkdtempSync(path.join(tmpdir(), "bookfactory-grail-"));
  const agents = path.join(root, "agents");
  mkdirSync(agents);
  copyFileSync(path.join(fixtureRoot, fixture), path.join(agents, "bookfactory_agent.py"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return routeManagerInternals.dryLoadAgentDirectory({
    python: testPython(),
    brainstemDir,
    agentDirectory: agents,
  });
}

test("pinned v0.3.0 BookFactory reproduces the real Grail hatch refusal", (t) => {
  const fixture = path.join(fixtureRoot, provenance.failing.fixture);
  assert.equal(sha256(fixture), provenance.failing.sha256);
  assert.equal(readFileSync(fixture).byteLength, provenance.failing.bytes);

  const result = dryLoadFixture(t, provenance.failing.fixture);

  assert.equal(result.ok, false);
  assert.match(result.error, /bookfactory_agent\.py: no valid agents/);
  assert.match(result.error, /distinct duplicate registered name 'BookFactory'/);
  assert.doesNotMatch(result.error, /Five-persona content pipeline|Raw source material/);
});

test("pinned v0.3.1 BookFactory passes the real Grail dry-load", (t) => {
  const fixture = path.join(fixtureRoot, provenance.fixed.fixture);
  assert.equal(sha256(fixture), provenance.fixed.sha256);
  assert.equal(readFileSync(fixture).byteLength, provenance.fixed.bytes);

  const result = dryLoadFixture(t, provenance.fixed.fixture);

  assert.deepEqual(result, { ok: true });
});
