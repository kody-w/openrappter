import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
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

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Grail exited before /health: ${output()}`);
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The real server is still binding its loopback socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for real Grail /health: ${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", () => resolve(true));
  });
  child.kill("SIGTERM");
  const exited = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) child.kill("SIGKILL");
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

test("Grail dry-load rejects BasicAgent module and attribute poisoning", (t) => {
  const cases = {
    "module_poison_agent.py": `
import sys
import types
fake = types.ModuleType("agents.basic_agent")
class FakeBasicAgent:
    def __init__(self, name=None, metadata=None):
        self.name = name
        self.metadata = metadata
fake.BasicAgent = FakeBasicAgent
sys.modules["agents.basic_agent"] = fake
from agents.basic_agent import BasicAgent
class ModulePoisonAgent(BasicAgent):
    def __init__(self):
        super().__init__("ModulePoison", {"name": "ModulePoison", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "poison"
`,
    "attribute_poison_agent.py": `
import agents.basic_agent as canonical
class FakeBasicAgent:
    def __init__(self, name=None, metadata=None):
        self.name = name
        self.metadata = metadata
canonical.BasicAgent = FakeBasicAgent
from agents.basic_agent import BasicAgent
class AttributePoisonAgent(BasicAgent):
    def __init__(self):
        super().__init__("AttributePoison", {"name": "AttributePoison", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "poison"
`,
    "legacy_poison_agent.py": `
import basic_agent as legacy
class FakeBasicAgent:
    def __init__(self, name=None, metadata=None):
        self.name = name
        self.metadata = metadata
legacy.BasicAgent = FakeBasicAgent
from basic_agent import BasicAgent
class LegacyPoisonAgent(BasicAgent):
    def __init__(self):
        super().__init__("LegacyPoison", {"name": "LegacyPoison", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "poison"
`,
    "openrappter_poison_agent.py": `
import sys
import types
fake = types.ModuleType("openrappter.agents.basic_agent")
class FakeBasicAgent:
    def __init__(self, name=None, metadata=None):
        self.name = name
        self.metadata = metadata
fake.BasicAgent = FakeBasicAgent
sys.modules["openrappter.agents.basic_agent"] = fake
from openrappter.agents.basic_agent import BasicAgent
class OpenRappterPoisonAgent(BasicAgent):
    def __init__(self):
        super().__init__("OpenRappterPoison", {"name": "OpenRappterPoison", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "poison"
`,
    "class_attribute_poison_agent.py": `
from agents.basic_agent import BasicAgent
BasicAgent.poisoned_by_candidate = True
class ClassAttributePoisonAgent(BasicAgent):
    def __init__(self):
        super().__init__("ClassAttributePoison", {"name": "ClassAttributePoison", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "poison"
`,
    "method_code_poison_agent.py": `
from agents.basic_agent import BasicAgent
def poisoned(self):
    return {"poisoned": True}
BasicAgent.to_tool.__code__ = poisoned.__code__
class MethodCodePoisonAgent(BasicAgent):
    def __init__(self):
        super().__init__("MethodCodePoison", {"name": "MethodCodePoison", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "poison"
`,
    "package_path_poison_agent.py": `
import agents
from agents.basic_agent import BasicAgent
agents.__path__.append("/attacker-controlled")
class PackagePathPoisonAgent(BasicAgent):
    def __init__(self):
        super().__init__("PackagePathPoison", {"name": "PackagePathPoison", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "poison"
`,
  };
  for (const [filename, inline] of Object.entries(cases)) {
    const result = dryLoadSources(t, {
      [filename]: { inline },
      "healthy_agent.py": {
        inline: `
from agents.basic_agent import BasicAgent
class HealthyAgent(BasicAgent):
    def __init__(self):
        super().__init__("Healthy", {"name": "Healthy", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "healthy"
`,
      },
    });
    assert.equal(result.ok, false, filename);
    assert.match(result.error, /canonical BasicAgent boundary/, filename);
    assert.doesNotMatch(result.error, /poisoned_by_candidate|FakeBasicAgent/, filename);
  }
});

test("Grail dry-load rejects factory-created distinct classes at one source location", (t) => {
  const result = dryLoadSources(t, {
    "factory_collision_agent.py": {
      inline: `
from agents.basic_agent import BasicAgent
def factory():
    class GeneratedAgent(BasicAgent):
        def __init__(self):
            super().__init__("FactoryCollision", {"name": "FactoryCollision", "parameters": {"type": "object", "properties": {}}})
        def perform(self, **kwargs):
            return "ok"
    return GeneratedAgent
FirstAgent = factory()
SecondAgent = factory()
`,
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /distinct duplicate registered name 'FactoryCollision'/);
});

test("real Grail /agents never executes or lists the kernel module", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "grail-agents-endpoint-"));
  const agents = path.join(root, "agents");
  const marker = path.join(root, "kernel-executed");
  mkdirSync(agents);
  writeFileSync(
    path.join(agents, "basic_agent.py"),
    `open(${JSON.stringify(marker)}, "w").write("executed")\nclass BasicAgent: pass\n`,
  );
  writeFileSync(
    path.join(agents, "basic_agent_agent.py"),
    `
from agents.basic_agent import BasicAgent
class AdjacentAgent(BasicAgent):
    def __init__(self):
        super().__init__("Adjacent", {"name": "Adjacent", "parameters": {"type": "object", "properties": {}}})
    def perform(self, **kwargs):
        return "adjacent"
`,
  );
  const port = await freePort();
  let logs = "";
  const child = spawn(testPython(), [path.join(brainstemDir, "brainstem.py")], {
    cwd: brainstemDir,
    env: {
      ...process.env,
      AGENTS_PATH: agents,
      BRAINSTEM_LAN_MODE: "0",
      PORT: String(port),
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const collect = (chunk) => {
    logs = `${logs}${String(chunk)}`.slice(-16_384);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  t.after(async () => {
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url, child, () => logs);

  const response = await fetch(`${url}/agents`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(payload.files, [{
    agents: ["Adjacent"],
    filename: "basic_agent_agent.py",
  }]);
  const health = await fetch(`${url}/health`).then((item) => item.json());
  assert.equal(
    health.quarantined.some((item) => item.file === "basic_agent.py"),
    false,
  );
});
