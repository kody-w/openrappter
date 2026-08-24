import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";

import {
  tester123EmailContract,
} from "../../electron/twin-adaptation-controller.mjs";
import { routeManagerInternals } from "../../electron/route-manager.mjs";
import { TwinManager } from "../../electron/twin-manager.mjs";
import { testPython } from "../_python.mjs";

const betaRoot = path.resolve(import.meta.dirname, "../..");
const testerSource = `
from agents.basic_agent import BasicAgent
class BuddyRole(BasicAgent):
    def __init__(self):
        self.name = "GetEmails"
        self.metadata = {
            "name": self.name,
            "description": "Get emails for me",
            "parameters": {"type": "object", "properties": {}},
        }
        super().__init__(name=self.name, metadata=self.metadata)
    def perform(self, **kwargs):
        return '{"status":"ready","message":"Get emails for me"}'
`;
const workIqSource = `
import json
import os
import re
from agents.basic_agent import BasicAgent
class WorkIQAgent(BasicAgent):
    def __init__(self):
        self.name = "WorkIQ"
        self.metadata = {
            "name": self.name,
            "description": "Read-only Microsoft 365 email",
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string"}
            }},
        }
        super().__init__(name=self.name, metadata=self.metadata)
    def perform(self, **kwargs):
        return '{"status":"unavailable","messages":[]}'
`;
const workIqSha256 = createHash("sha256").update(workIqSource).digest("hex");

const EXECUTE_AGENT = String.raw`
import importlib.util
import json
import os
import sys

agents_dir, prompt = sys.argv[1:3]
filename = "email_agent.py" if os.path.exists(
    os.path.join(agents_dir, "email_agent.py")
) else "buddy_role_agent.py"
class_name = (
    "TwinReadOnlyEmailBindingAgent"
    if filename == "email_agent.py"
    else "BuddyRole"
)
spec = importlib.util.spec_from_file_location(
    "_fixture_twin_agent",
    os.path.join(agents_dir, filename),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
agent = getattr(module, class_name)()
fixture = None
for value in ("has_data", "no_data", "auth_required"):
    if "fixture:" + value in prompt:
        fixture = value
kwargs = {"query": prompt}
if fixture:
    kwargs["provider_fixture"] = fixture
result = agent.perform(**kwargs)
print(json.dumps({"result": result, "tool": agent.name}))
`;

const VALIDATE_AGENT_SET = String.raw`
import ast
import glob
import os
import sys

names = set()
for filename in sorted(glob.glob(os.path.join(sys.argv[1], "*_agent.py"))):
    source = open(filename, encoding="utf-8").read()
    tree = ast.parse(source)
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        for child in ast.walk(node):
            if not isinstance(child, ast.Assign):
                continue
            for target in child.targets:
                if (isinstance(target, ast.Attribute)
                        and target.attr == "name"
                        and isinstance(child.value, ast.Constant)
                        and isinstance(child.value.value, str)):
                    if child.value.value in names:
                        raise SystemExit("duplicate tool " + child.value.value)
                    names.add(child.value.value)
print(len(names))
`;

function writeFixtureBrainstem(directory) {
  const brainstemDir = path.join(directory, "brainstem");
  const agents = path.join(brainstemDir, "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(path.join(agents, "__init__.py"), "");
  writeFileSync(
    path.join(agents, "basic_agent.py"),
    [
      "class BasicAgent:",
      "    def __init__(self, name=None, metadata=None):",
      "        self.name = name",
      "        self.metadata = metadata",
      "",
    ].join("\n"),
  );
  return brainstemDir;
}

class FixtureChatWorker {
  constructor(config, brainstemDir) {
    this.config = config;
    this.brainstemDir = brainstemDir;
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/chat") {
          response.writeHead(404).end();
          return;
        }
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const run = spawnSync(
          testPython(),
          [
            "-c",
            EXECUTE_AGENT,
            this.config.env.AGENTS_PATH,
            String(body.user_input || ""),
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              MOLTER_SHADOW: "1",
              PYTHONDONTWRITEBYTECODE: "1",
              PYTHONPATH: this.brainstemDir,
            },
          },
        );
        if (run.status !== 0) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: run.stderr || run.stdout }));
          return;
        }
        const executed = JSON.parse(
          String(run.stdout).trim().split(/\r?\n/).at(-1),
        );
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          response: executed.result,
          agent_logs: `tool=${executed.tool}`,
          session_id: body.session_id,
        }));
      });
      this.server.once("error", reject);
      this.server.listen(this.config.port, "127.0.0.1", resolve);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }
}

test("TESTER123 corrects ready-only email by staging pinned WorkIQ and isolated memory without touching a live install", async (t) => {
  const directory = mkdtempSync(path.join(betaRoot, ".tester123-e2e-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const brainstemDir = writeFixtureBrainstem(directory);
  let failNextVerification = false;
  const routeManager = {
    compositionValidator: (agentsDir) => {
      const result = spawnSync(
        testPython(),
        ["-c", VALIDATE_AGENT_SET, agentsDir],
        { encoding: "utf8" },
      );
      return result.status === 0
        ? { ok: true }
        : { ok: false, error: result.stderr || result.stdout };
    },
    moltVerifier: (source, options = {}) => {
      if (failNextVerification) {
        failNextVerification = false;
        return {
          ok: false,
          error: "fixture post-activation contract violation",
        };
      }
      return routeManagerInternals.verifyMoltWithMolter({
        python: testPython(),
        brainstemDir,
        source,
        behaviorContract: options.behaviorContract,
        permissions: options.permissions,
      });
    },
  };
  const manager = new TwinManager({
    betaHome: directory,
    brainstemConfig: { brainstemDir, python: testPython() },
    createWorkerProcess: (config) => new FixtureChatWorker(
      config,
      brainstemDir,
    ),
    routeManager,
    storeClient: {
      list: async () => [{
        id: "@kody-w/workiq",
        sha256: workIqSha256,
        verified: true,
      }],
      download: async (id) => {
        assert.equal(id, "@kody-w/workiq");
        return {
          id,
          filename: "workiq_agent.py",
          source: workIqSource,
          sha256: workIqSha256,
          entry: { name: "WorkIQ" },
        };
      },
    },
  });
  const twin = await manager.hatchLocal({
    id: "TESTER123",
    name: "TESTER123",
    agentSources: [{
      filename: "buddy_role_agent.py",
      source: testerSource,
    }],
  });
  const before = await manager.chat(
    twin.id,
    "Get emails for me",
    { author: "Tester" },
  );
  const readyOnly = JSON.parse(before.response);
  assert.equal(readyOnly.status, "ready");
  assert.equal(Object.hasOwn(readyOnly, "messages"), false);

  const diagnosis = await manager.adaptationPropose(twin.id, {
    capability: "email",
    request: "That only returned ready; actually get my emails and remember context.",
  });
  assert.equal(diagnosis.capability.diagnosis.signals.stub, true);
  assert.equal(diagnosis.capability.proposal.strategy, "REUSE_BIND");
  assert.equal(diagnosis.capability.proposal.capability_id, "@kody-w/workiq");
  assert.equal(diagnosis.memory_binding.verified, false);

  const staged = await manager.adaptationStage(twin.id, {
    capability: "email",
    source: workIqSource,
    sourceHash: workIqSha256,
    binding: {
      provider: {
        id: "@kody-w/workiq",
        sha256: workIqSha256,
        mode: "read_only",
        verified: true,
      },
      memory: {
        recall: "ContextMemory",
        save: "ManageMemory",
        verified: false,
      },
      verified: true,
    },
    permissions: ["network", "data_source", "credential", "shell"],
    behaviorContract: tester123EmailContract(),
  });
  assert.equal(staged.capability.state, "approval_required");
  const candidate = staged.capability.generations[0];
  assert.equal(
    candidate.behavior_contract.cases[0].fixture_output.messages[0].subject,
    "Quarterly planning",
  );
  assert.equal(
    candidate.behavior_contract.cases[1].fixture_output.status,
    "no_data",
  );
  assert.equal(
    candidate.behavior_contract.cases[2].fixture_output.status,
    "auth_required",
  );

  assert.throws(
    () => manager.adaptationActivate(
      twin.id,
      "email",
      candidate.candidate_hash,
    ),
    /not activatable/,
  );
  manager.adaptationApprove(twin.id, "email", {
    candidate_hash: candidate.candidate_hash,
    contract_hash: candidate.behavior_contract_hash,
    base_hash: candidate.base_hash,
    permission_diff: candidate.permission_diff,
  });
  const active = manager.adaptationActivate(
    twin.id,
    "email",
    candidate.candidate_hash,
  );
  assert.equal(active.capability.state, "healthy");
  assert.equal(active.capability.generations.length, 1);
  assert.equal(active.memory_binding.verified, false);

  const hasData = JSON.parse((await manager.chat(
    twin.id,
    "Get emails for me fixture:has_data",
    { author: "Tester" },
  )).response);
  assert.equal(hasData.status, "success");
  assert.equal(hasData.messages.length, 1);
  assert.equal(hasData.messages[0].subject, "Quarterly planning");

  const noData = JSON.parse((await manager.chat(
    twin.id,
    "Get emails for nobody fixture:no_data",
    { author: "Tester" },
  )).response);
  assert.deepEqual(noData, { status: "no_data", messages: [] });

  const auth = JSON.parse((await manager.chat(
    twin.id,
    "Get emails for me fixture:auth_required",
    { author: "Tester" },
  )).response);
  assert.deepEqual(auth, { status: "auth_required", messages: [] });

  await manager.adaptationPropose(twin.id, {
    capability: "email",
    request: "Refine the structured message projection.",
  });
  const second = await manager.adaptationStage(twin.id, {
    capability: "email",
    source: `${workIqSource}\n# candidate two\n`,
    binding: candidate.binding,
    permissions: candidate.permissions,
    behaviorContract: tester123EmailContract(),
  });
  assert.equal(second.capability.state, "activatable");
  failNextVerification = true;
  const rolled = manager.adaptationActivate(
    twin.id,
    "email",
    second.capability.staged_hash,
  );
  assert.equal(rolled.capability.state, "rolled_back");
  assert.equal(rolled.capability.active_hash, candidate.candidate_hash);
  assert.equal(rolled.capability.generations.length, 2);
  assert.equal(rolled.capability.quarantine.length, 1);

  const molterHome = manager.get(twin.id).molterHome;
  const namespace = rolled.memory_binding.namespace;
  await manager.close(twin.id);
  assert.equal(existsSync(molterHome), true);

  failNextVerification = false;
  const restarted = await manager.hatchLocal({
    id: "TESTER123",
    name: "TESTER123",
    agentSources: [{
      filename: "buddy_role_agent.py",
      source: testerSource,
    }],
  });
  const afterRestart = manager.adaptationInspect(restarted.id, "email");
  assert.equal(afterRestart.capability.active_hash, candidate.candidate_hash);
  assert.equal(afterRestart.memory_binding.namespace, namespace);
  const restoredSource = readFileSync(
    path.join(manager.get(restarted.id).dir, "agents", "email_agent.py"),
    "utf8",
  );
  assert.match(restoredSource, /class WorkIQAgent/);
  assert.match(restoredSource, /class TwinReadOnlyEmailBindingAgent/);

  const twinManagerSource = readFileSync(
    path.join(betaRoot, "electron", "twin-manager.mjs"),
    "utf8",
  );
  assert.match(twinManagerSource, /fetch\(`\$\{twin\.url\}\/chat`/);
  assert.doesNotMatch(
    twinManagerSource,
    /fetch\([^)]*\/api\/(?:adapt|agent|twin-management)/,
  );
  await manager.stopAll();
});
