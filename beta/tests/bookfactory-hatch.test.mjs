import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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

function dryLoadSources(t, sources) {
  const root = mkdtempSync(path.join(tmpdir(), "bookfactory-grail-"));
  const agents = path.join(root, "agents");
  mkdirSync(agents);
  for (const [filename, source] of Object.entries(sources)) {
    if (source.fixture) {
      copyFileSync(path.join(fixtureRoot, source.fixture), path.join(agents, filename));
    } else {
      writeFileSync(path.join(agents, filename), source.inline);
    }
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return routeManagerInternals.dryLoadAgentDirectory({
    python: testPython(),
    brainstemDir,
    agentDirectory: agents,
  });
}

function dryLoadFixture(t, fixture) {
  return dryLoadSources(t, {
    "bookfactory_agent.py": { fixture },
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

test("Grail controls distinguish aliases, distinct duplicates, and no agents", (t) => {
  const alias = dryLoadSources(t, {
    "alias_agent.py": {
      inline: `
from agents.basic_agent import BasicAgent
class CanonicalAgent(BasicAgent):
    def __init__(self):
        super().__init__("Canonical", {"name": "Canonical", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "ok"
AliasAgent = CanonicalAgent
`,
    },
  });
  assert.deepEqual(alias, { ok: true });

  const distinct = dryLoadSources(t, {
    "first_agent.py": {
      inline: `
from agents.basic_agent import BasicAgent
class FirstAgent(BasicAgent):
    def __init__(self):
        super().__init__("Shared", {"name": "Shared", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "first"
`,
    },
    "second_agent.py": {
      inline: `
from agents.basic_agent import BasicAgent
class SecondAgent(BasicAgent):
    def __init__(self):
        super().__init__("Shared", {"name": "Shared", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "second"
`,
    },
  });
  assert.equal(distinct.ok, false);
  assert.match(distinct.error, /distinct duplicate registered name 'Shared'/);

  const empty = dryLoadSources(t, {
    "empty_agent.py": { inline: "VALUE = 1\n" },
  });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty_agent\.py: no valid agents/);
});
