import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  tester123EmailContract,
  TwinAdaptationController,
} from "../../electron/twin-adaptation-controller.mjs";
import { TwinManager } from "../../electron/twin-manager.mjs";

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

test("TESTER123 corrects ready-only email by staging pinned WorkIQ and isolated memory without touching a live install", async (t) => {
  const directory = mkdtempSync(path.join(betaRoot, ".tester123-e2e-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let healthFails = false;
  const manager = new TwinManager({
    betaHome: directory,
    brainstemConfig: {},
    createWorkerProcess: () => ({
      start: async () => {},
      stop: async () => {},
    }),
    createAdaptationController: (options) => new TwinAdaptationController({
      ...options,
      verifier: () => ({ ok: true }),
      loaderValidator: () => ({ ok: true }),
      healthRunner: () => (
        healthFails
          ? { ok: false, error: "fixture post-activation contract violation" }
          : { ok: true }
      ),
    }),
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
    permissions: ["network", "data_source", "credential"],
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
  healthFails = true;
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

  healthFails = false;
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
