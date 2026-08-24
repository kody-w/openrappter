import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  tester123EmailContract,
  TwinAdaptationController,
  twinAdaptationInternals,
} from "../electron/twin-adaptation-controller.mjs";

const root = path.resolve(import.meta.dirname, "..");
const READY_ONLY_SOURCE = `
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
const WORKIQ_SOURCE = `
from agents.basic_agent import BasicAgent

class WorkIQAgent(BasicAgent):
    def __init__(self):
        self.name = "WorkIQ"
        self.metadata = {
            "name": self.name,
            "description": "Read Microsoft 365 mail through a bound provider.",
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string"}
            }},
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return '{"status":"unavailable","messages":[]}'
`;
const FORMAT_SOURCE = WORKIQ_SOURCE
  .replaceAll("WorkIQAgent", "FormatAgent")
  .replaceAll('"WorkIQ"', '"Formatter"');

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(root, ".twin-adaptation-test-"));
  const agentsDir = path.join(directory, "agents");
  mkdirSync(agentsDir);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    agentsDir,
    directory,
    controller: new TwinAdaptationController({
      root: path.join(directory, "molter"),
      twinKey: options.twinKey || "TESTER123",
      agentsDir,
      verifier: options.verifier || (() => ({ ok: true })),
      shadowRunner: options.shadowRunner,
      loaderValidator: options.loaderValidator,
      healthRunner: options.healthRunner,
      autoActivateReadOnly: options.autoActivateReadOnly,
      watchTurns: options.watchTurns,
    }),
  };
}

function proposeEmail(controller) {
  controller.observe("email", {
    type: "explicit_correction",
    code: "ready-only-email",
  });
  return controller.diagnose("email", {
    request: "Get emails for me",
    tools: ["GetEmails"],
    stub_detected: true,
    has_data_path: false,
    rar: [{
      id: "@kody-w/workiq",
      sha256: "a".repeat(64),
      verified: true,
    }],
    auth: "missing",
    health: "ready",
    permissions: [],
  });
}

function stageWorkIq(controller, extra = {}) {
  return controller.stage("email", {
    source: WORKIQ_SOURCE,
    binding: {
      provider: {
        id: "@kody-w/workiq",
        sha256: "a".repeat(64),
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
    behavior_contract: tester123EmailContract(),
    permissions: ["network", "data_source", "credential"],
    tool_name: "WorkIQ",
    ...extra,
  });
}

function exactApproval(snapshot) {
  const capability = snapshot.capability;
  const generation = capability.generations.find(
    (item) => item.candidate_hash === capability.staged_hash,
  );
  return {
    generation,
    approval: {
      actor: "human-ui",
      action_bound: true,
      candidate_hash: generation.candidate_hash,
      contract_hash: generation.behavior_contract_hash,
      base_hash: generation.base_hash,
      permission_diff: generation.permission_diff,
    },
  };
}

test("adaptation starts only on explicit intent or bounded repeated safe evidence", (t) => {
  const { controller } = fixture(t);
  const first = controller.observe("email", {
    type: "constant_output",
    code: "ready-envelope",
    tool: "GetEmails",
    raw: "secret mailbox content",
  });
  assert.equal(first.accepted, false);
  const second = controller.observe("email", {
    type: "constant_output",
    code: "ready-envelope",
    tool: "GetEmails",
    raw: "different secret",
  });
  assert.equal(second.accepted, true);
  const serialized = JSON.stringify(controller.inspect("email"));
  assert.doesNotMatch(serialized, /secret mailbox content|different secret/);
  assert.throws(
    () => controller.observe("other", { type: "model_hunch" }),
    /closed safe signal/,
  );
});

test("TESTER123 diagnosis calls the ready-only email agent a stub and prefers WorkIQ REUSE/BIND", (t) => {
  const { controller } = fixture(t);
  const result = proposeEmail(controller);
  assert.equal(result.capability.state, "proposed");
  assert.equal(result.capability.diagnosis.signals.stub, true);
  assert.equal(result.capability.proposal.strategy, "REUSE_BIND");
  assert.equal(result.capability.proposal.capability_id, "@kody-w/workiq");
  assert.equal(
    result.capability.proposal.memory_binding,
    "BIND_EXISTING_MEMORY_AGENTS",
  );
  assert.equal(result.memory_binding.verified, false);
});

test("TESTER123 stages pinned WorkIQ, proves fixture mail/truthful empty/auth, and requires exact human approval", (t) => {
  const { controller } = fixture(t);
  proposeEmail(controller);
  const staged = stageWorkIq(controller);
  assert.equal(staged.capability.state, "approval_required");
  const { generation, approval } = exactApproval(staged);
  assert.deepEqual(generation.permission_diff.added, [
    "credential",
    "data_source",
    "network",
  ]);
  assert.equal(
    generation.behavior_contract.cases[0].fixture_output.messages.length,
    1,
  );
  assert.equal(
    generation.behavior_contract.cases[1].fixture_output.status,
    "no_data",
  );
  assert.equal(
    generation.behavior_contract.cases[2].fixture_output.status,
    "auth_required",
  );
  assert.throws(
    () => controller.approve("email", { ...approval, actor: "agent" }),
    /cannot approve/,
  );
  assert.throws(
    () => controller.approve("email", {
      ...approval,
      candidate_hash: "f".repeat(64),
    }),
    /stale|not bound/,
  );
  for (const mutated of [
    { ...approval, action_bound: false },
    { ...approval, contract_hash: "e".repeat(64) },
    { ...approval, base_hash: "d".repeat(64) },
    {
      ...approval,
      permission_diff: {
        ...approval.permission_diff,
        added: [...approval.permission_diff.added, "send"],
      },
    },
  ]) {
    assert.throws(
      () => controller.approve("email", mutated),
      /cannot approve|stale|not bound/,
    );
  }
  const approved = controller.approve("email", approval);
  assert.equal(approved.capability.state, "activatable");
  const healthy = controller.activate("email", generation.candidate_hash);
  assert.equal(healthy.capability.state, "healthy");
  assert.equal(healthy.capability.active_hash, generation.candidate_hash);
  const molterState = JSON.parse(readFileSync(path.join(
    path.dirname(controller.statePath),
    "state.json",
  ), "utf8"));
  assert.equal(molterState.capabilities.email.molts[0].sha256, generation.sha256);
  assert.equal(molterState.capabilities.email.live_generation, 0);
  assert.match(
    readFileSync(path.join(
      path.dirname(controller.statePath),
      "ACTIVE.json",
    ), "utf8"),
    new RegExp(generation.candidate_hash),
  );
});

test("stub detector rejects a static ready handshake and rolls back without going live", (t) => {
  const { controller } = fixture(t, {
    shadowRunner: ({ contract }) => ({
      results: contract.cases.map(() => ({
        ok: true,
        output: { status: "ready", message: "Get emails for me" },
      })),
    }),
  });

  proposeEmail(controller);
  const failed = controller.stage("email", {
    source: READY_ONLY_SOURCE,
    binding: { verified: true },
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  assert.equal(failed.capability.state, "rolled_back");
  assert.equal(failed.capability.active_hash, null);
  assert.equal(failed.capability.quarantine.length, 1);
  assert.match(failed.capability.quarantine[0].lesson, /stub|ready/i);
});

test("stub mutation matrix rejects adjacent ready/ack success disguises", () => {
  const contract = tester123EmailContract();
  for (const output of [
    { status: "ready" },
    { status: "ok", message: "accepted" },
    { status: "accepted", ack: true },
    { message: "acknowledged", acknowledged: true },
  ]) {
    const verdict = twinAdaptationInternals.verifyShadowResults(
      contract,
      contract.cases.map(() => ({ ok: true, output })),
    );
    assert.equal(verdict.ok, false, JSON.stringify(output));
    assert.match(verdict.reason, /stub|ready/i);
  }
  const truthful = twinAdaptationInternals.verifyShadowResults(
    contract,
    contract.cases.map((item) => ({
      ok: true,
      output: item.fixture_output,
    })),
  );
  assert.equal(truthful.ok, true);
});

test("shadow output must satisfy the declared schema before activation", (t) => {
  const { controller } = fixture(t, {
    shadowRunner: ({ contract }) => ({
      results: contract.cases.map((item, index) => ({
        ok: true,
        output: index === 0
          ? { status: "success", messages: "not-an-array" }
          : item.fixture_output,
      })),
    }),
  });
  proposeEmail(controller);
  const failed = stageWorkIq(controller);
  assert.equal(failed.capability.state, "rolled_back");
  assert.match(failed.capability.quarantine[0].lesson, /output_schema/);
});

test("same-or-lower local read permissions are activatable without elevated approval", (t) => {
  const { controller } = fixture(t);
  controller.observe("format", { type: "explicit_request" });
  controller.diagnose("format", {
    request: "format local data",
    has_data_path: true,
    tools: ["Formatter"],
  });
  const contract = {
    name: "format",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    cases: [
      { id: "a", input: { query: "a" }, expect: { status: "success" } },
      { id: "b", input: { query: "b" }, expect: { status: "no_data" } },
    ],
  };
  const staged = controller.stage("format", {
    source: WORKIQ_SOURCE,
    behavior_contract: contract,
    permissions: ["read_local"],
  });
  assert.equal(staged.capability.state, "activatable");
});

test("new send permission is denied unless separately approved before staging", (t) => {
  const { controller } = fixture(t);
  proposeEmail(controller);
  assert.throws(
    () => stageWorkIq(controller, {
      permissions: ["network", "data_source", "credential", "send"],
    }),
    /send\/reply stays denied/,
  );
});

test("post-activation health failure quarantines the candidate and restores last known good", (t) => {
  let failHealth = false;
  const { controller, agentsDir } = fixture(t, {
    healthRunner: () => (
      failHealth ? { ok: false, error: "contract probe failed" } : { ok: true }
    ),
  });
  controller.observe("email", { type: "explicit_request" });
  controller.diagnose("email", {
    request: "email",
    has_data_path: true,
    tools: ["WorkIQ"],
  });
  const first = controller.stage("email", {
    source: WORKIQ_SOURCE,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  const firstHash = first.capability.staged_hash;
  controller.activate("email", firstHash);

  controller.observe("email", { type: "explicit_correction" });
  controller.diagnose("email", {
    request: "improve email",
    has_data_path: true,
    tools: ["WorkIQ"],
  });
  const second = controller.stage("email", {
    source: `${WORKIQ_SOURCE}\n# generation two\n`,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  failHealth = true;
  const rolled = controller.activate("email", second.capability.staged_hash);
  assert.equal(rolled.capability.state, "rolled_back");
  assert.equal(rolled.capability.active_hash, firstHash);
  assert.equal(
    readFileSync(path.join(agentsDir, "email_agent.py"), "utf8"),
    WORKIQ_SOURCE,
  );
  assert.equal(rolled.capability.generations.length, 2);
});

test("loader collision failure rolls back and records the quarantine lesson", (t) => {
  let calls = 0;
  const { controller } = fixture(t, {
    loaderValidator: () => {
      calls += 1;
      return calls === 1
        ? { ok: true }
        : { ok: false, error: "duplicate tool name WorkIQ" };
    },
  });
  controller.observe("email", { type: "explicit_request" });
  controller.diagnose("email", { request: "email", has_data_path: true });
  const first = controller.stage("email", {
    source: WORKIQ_SOURCE,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  controller.activate("email", first.capability.staged_hash);
  controller.observe("email", { type: "explicit_correction" });
  controller.diagnose("email", { request: "email", has_data_path: true });
  const second = controller.stage("email", {
    source: `${WORKIQ_SOURCE}\n# collision generation\n`,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  const rolled = controller.activate("email", second.capability.staged_hash);
  assert.equal(rolled.capability.state, "rolled_back");
  assert.match(rolled.capability.quarantine.at(-1).lesson, /duplicate tool name/);
});

test("first-turn regression watch automatically rolls back the active generation", (t) => {
  const { controller } = fixture(t, { watchTurns: 3 });
  controller.observe("email", { type: "explicit_request" });
  controller.diagnose("email", { request: "email", has_data_path: true });
  const staged = controller.stage("email", {
    source: WORKIQ_SOURCE,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  controller.activate("email", staged.capability.staged_hash);
  const rolled = controller.recordRuntime("email", { type: "constant_output" });
  assert.equal(rolled.capability.state, "rolled_back");
  assert.match(rolled.capability.quarantine.at(-1).lesson, /first-turn watch/);
});

test("first-turn regression watch expires after its configured healthy turns", (t) => {
  const { controller } = fixture(t, { watchTurns: 2 });
  controller.observe("email", { type: "explicit_request" });
  controller.diagnose("email", { request: "email", has_data_path: true });
  const staged = controller.stage("email", {
    source: WORKIQ_SOURCE,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  controller.activate("email", staged.capability.staged_hash);
  controller.recordRuntime("email", { type: "healthy_turn" });
  const completed = controller.recordRuntime("email", { type: "healthy_turn" });
  assert.equal(completed.capability.watch, null);
  const later = controller.recordRuntime("email", { type: "constant_output" });
  assert.equal(later.capability.state, "healthy");
});

test("first-generation rollback restores exact pre-adaptation code and memory", (t) => {
  const { controller, agentsDir } = fixture(t);
  const baseline = "ORIGINAL = 'keep me'\n";
  writeFileSync(path.join(agentsDir, "email_agent.py"), baseline);
  const originalMemory = controller.inspect().memory_binding;
  controller.observe("email", { type: "explicit_request" });
  controller.diagnose("email", { request: "email", has_data_path: true });
  const staged = controller.stage("email", {
    source: WORKIQ_SOURCE,
    binding: {
      memory: {
        recall: "ContextMemory",
        save: "ManageMemory",
        verified: true,
      },
      verified: true,
    },
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  controller.activate("email", staged.capability.staged_hash);
  const rolled = controller.recordRuntime("email", { type: "constant_output" });
  assert.equal(rolled.capability.state, "rolled_back");
  assert.equal(
    readFileSync(path.join(agentsDir, "email_agent.py"), "utf8"),
    baseline,
  );
  assert.deepEqual(rolled.memory_binding, originalMemory);
});

test("baseline capture failure leaves the original live agent untouched", (t) => {
  const { controller, agentsDir } = fixture(t);
  const original = "ORIGINAL = 'capture must not delete this'\n";
  writeFileSync(path.join(agentsDir, "email_agent.py"), original);
  controller.observe("email", { type: "explicit_request" });
  controller.diagnose("email", { request: "email", has_data_path: true });
  const staged = controller.stage("email", {
    source: WORKIQ_SOURCE,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  writeFileSync(path.join(path.dirname(controller.statePath), "baselines"), "blocked");
  const failed = controller.activate("email", staged.capability.staged_hash);
  assert.equal(failed.capability.state, "rolled_back");
  assert.equal(
    readFileSync(path.join(agentsDir, "email_agent.py"), "utf8"),
    original,
  );
});

test("binding-only rollback clears its pointer and restores the prior descriptor", (t) => {
  const { controller } = fixture(t);
  const originalMemory = controller.inspect().memory_binding;
  proposeEmail(controller);
  const staged = controller.stage("email", {
    binding: {
      provider: {
        id: "@kody-w/workiq",
        sha256: "a".repeat(64),
        verified: true,
      },
      memory: {
        recall: "ContextMemory",
        save: "ManageMemory",
        verified: true,
      },
      verified: true,
    },
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  controller.activate("email", staged.capability.staged_hash);
  const rolled = controller.recordRuntime("email", { type: "missing_binding" });
  assert.equal(rolled.capability.state, "rolled_back");
  assert.equal(rolled.capability.active_hash, null);
  assert.equal(existsSync(controller.pointerPath), false);
  assert.deepEqual(rolled.memory_binding, originalMemory);
});

test("tampered archives and symlink swaps never rehydrate or activate", {
  skip: process.platform === "win32",
}, (t) => {
  const { controller, directory, agentsDir } = fixture(t);
  controller.observe("email", { type: "explicit_request" });
  controller.diagnose("email", { request: "email", has_data_path: true });
  const staged = controller.stage("email", {
    source: WORKIQ_SOURCE,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });

  const hash = staged.capability.staged_hash;
  controller.activate("email", hash);
  const generation = controller.inspect("email").capability.generations[0];
  const archived = path.join(
    directory,
    "molter",
    "molts",
    "email",
    generation.generation_name,
    "agent.py",
  );
  rmSync(archived);
  const victim = path.join(directory, "victim.py");
  writeFileSync(victim, "DO_NOT_LOAD = True\n");
  symlinkSync(victim, archived);
  assert.equal(lstatSync(archived).isSymbolicLink(), true);

  const restartedAgents = path.join(directory, "restarted-agents");
  mkdirSync(restartedAgents);
  const restarted = new TwinAdaptationController({
    root: path.join(directory, "molter"),
    twinKey: "TESTER123",
    agentsDir: restartedAgents,
  });
  const result = restarted.rehydrate();
  assert.equal(result.ok, false);
  assert.equal(existsSync(path.join(restartedAgents, "email_agent.py")), false);
  assert.equal(readFileSync(victim, "utf8"), "DO_NOT_LOAD = True\n");
});

test("content hash rejects an ordinary-file archive tamper on every platform", (t) => {
  const { controller, directory } = fixture(t);
  controller.observe("email", { type: "explicit_request" });
  controller.diagnose("email", { request: "email", has_data_path: true });
  const staged = controller.stage("email", {
    source: WORKIQ_SOURCE,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  controller.activate("email", staged.capability.staged_hash);
  const generation = controller.inspect("email").capability.generations[0];
  const archived = path.join(
    directory,
    "molter",
    "molts",
    "email",
    generation.generation_name,
    "agent.py",
  );
  chmodSync(archived, 0o600);
  writeFileSync(archived, "TAMPERED = True\n");
  const nextAgents = path.join(directory, "tamper-restart");
  mkdirSync(nextAgents);
  const restarted = new TwinAdaptationController({
    root: path.join(directory, "molter"),
    twinKey: "TESTER123",
    agentsDir: nextAgents,
  });
  assert.equal(restarted.rehydrate().ok, false);
  assert.equal(existsSync(path.join(nextAgents, "email_agent.py")), false);
});

test("stale base, deterministic replay mismatch, and concurrent proposals fail closed", (t) => {
  const { controller, directory } = fixture(t);
  proposeEmail(controller);
  assert.throws(
    () => stageWorkIq(controller, { base_hash: "b".repeat(64) }),
    /Stale base/,
  );
  assert.equal(
    existsSync(path.join(directory, "molter", "molts", "email")),
    false,
  );
  assert.throws(
    () => stageWorkIq(controller, { expected_hash: "c".repeat(64) }),
    /Deterministic candidate identity/,
  );

  const one = fixture(t, { twinKey: "concurrent" });
  const two = new TwinAdaptationController({
    root: path.join(one.directory, "molter"),
    twinKey: "concurrent",
    agentsDir: one.agentsDir,
  });
  proposeEmail(one.controller);
  assert.throws(
    () => proposeEmail(two),
    /already proposed|cannot free-run/,
  );
  const first = stageWorkIq(one.controller);
  assert.equal(first.capability.generations[0].generation, 0);
  assert.equal(
    readFileSync(path.join(
      one.directory,
      "molter",
      "molts",
      "email",
      "gen-000",
      "agent.py",
    ), "utf8"),
    WORKIQ_SOURCE,
  );
});

test("memory descriptors are explicit, verified honestly, and isolated per twin", (t) => {
  const first = fixture(t, { twinKey: "TESTER123" });
  const second = fixture(t, { twinKey: "OTHER" });
  const bound = first.controller.bindMemory({
    recall: "ContextMemory",
    save: "ManageMemory",
    verified: true,
  });
  assert.equal(bound.verified, true);
  assert.notEqual(
    bound.namespace,
    second.controller.inspect().memory_binding.namespace,
  );
  assert.equal(second.controller.inspect().memory_binding.verified, false);
  assert.doesNotMatch(
    readFileSync(first.controller.bindingPath, "utf8"),
    new RegExp(second.controller.inspect().memory_binding.namespace),
  );
});

test("restart restores only the healthy content-hashed head and ignores crash temp files", (t) => {
  const { controller, directory } = fixture(t);
  controller.observe("email", { type: "explicit_request" });
  controller.diagnose("email", { request: "email", has_data_path: true });
  const staged = controller.stage("email", {
    source: WORKIQ_SOURCE,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });

  controller.activate("email", staged.capability.staged_hash);
  writeFileSync(
    path.join(directory, "molter", "ACTIVE.json.999.crash.tmp"),
    '{"candidate_hash":"tampered"}',
  );
  const nextAgents = path.join(directory, "next-agents");
  mkdirSync(nextAgents);
  const restarted = new TwinAdaptationController({
    root: path.join(directory, "molter"),
    twinKey: "TESTER123",
    agentsDir: nextAgents,
  });
  const result = restarted.rehydrate();
  assert.equal(result.ok, true);
  assert.deepEqual(result.restored, [staged.capability.staged_hash]);
  assert.equal(
    readFileSync(path.join(nextAgents, "email_agent.py"), "utf8"),
    WORKIQ_SOURCE,
  );
});

test("content-hashed active pointer preserves and rehydrates multiple capability heads", (t) => {
  const { controller, directory } = fixture(t);
  controller.observe("email", { type: "explicit_request" });
  controller.diagnose("email", { request: "email", has_data_path: true });
  const email = controller.stage("email", {
    source: WORKIQ_SOURCE,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  controller.activate("email", email.capability.staged_hash);

  controller.observe("format", { type: "explicit_request" });
  controller.diagnose("format", { request: "format", has_data_path: true });
  const format = controller.stage("format", {
    source: FORMAT_SOURCE,
    behavior_contract: tester123EmailContract(),
    permissions: [],
  });
  controller.activate("format", format.capability.staged_hash);
  const pointer = JSON.parse(readFileSync(controller.pointerPath, "utf8"));
  assert.deepEqual(Object.keys(pointer.heads).sort(), ["email", "format"]);

  const nextAgents = path.join(directory, "multi-restart");
  mkdirSync(nextAgents);
  const restarted = new TwinAdaptationController({
    root: path.join(directory, "molter"),
    twinKey: "TESTER123",
    agentsDir: nextAgents,
  });
  const result = restarted.rehydrate();
  assert.equal(result.ok, true);
  assert.equal(result.restored.length, 2);
  assert.equal(existsSync(path.join(nextAgents, "email_agent.py")), true);
  assert.equal(existsSync(path.join(nextAgents, "format_agent.py")), true);
});

test("evidence and events stay bounded while immutable version history remains", (t) => {
  const { controller } = fixture(t);
  for (let index = 0; index < 60; index += 1) {
    controller.observe("email", {
      type: "tool_error",
      code: `error-${index}`,
    });
  }
  const inspected = controller.inspect("email");
  assert.equal(inspected.capability.evidence.length, 32);
  assert.ok(JSON.stringify(inspected).length < 200_000);
});

test("controller metadata never exposes source or a live filesystem source path", (t) => {
  const { controller } = fixture(t);
  proposeEmail(controller);
  const staged = stageWorkIq(controller);
  const serialized = JSON.stringify(staged);
  assert.doesNotMatch(serialized, /class WorkIQAgent/);
  assert.doesNotMatch(serialized, /source_path/);
});

test("helper identities are canonical and ready-only envelopes are detected", () => {
  assert.equal(
    twinAdaptationInternals.looksLikeStaticAck('{"status":"ready"}'),
    true,
  );
  assert.equal(
    twinAdaptationInternals.looksLikeStaticAck({
      status: "success",
      messages: [{ id: "1" }],
    }),
    false,
  );
  assert.equal(
    twinAdaptationInternals.sha256("same"),
    twinAdaptationInternals.sha256("same"),
  );
});
