import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RappterSurgeon,
  rappterSurgeonInternals,
} from "../electron/rappter-surgeon.mjs";

test("Rappter Surgeon keeps the full Copilot loop and RAPP delegation tools", async () => {
  let config;
  let sendTimeout;
  const session = {
    on: () => () => {},
    sendAndWait: async (_request, timeout) => {
      sendTimeout = timeout;
      return { data: { content: "ready" } };
    },
    disconnect: async () => {},
  };
  const runtime = {
    createSession: async (value) => {
      config = value;
      return session;
    },
  };
  const surgeon = new RappterSurgeon({
    runtime,
    brainstemUrl: "http://127.0.0.1:7071",
    uiCommand: async () => ({}),
  });

  const result = await surgeon.send("hello");
  assert.equal(result.content, "ready");
  assert.equal(config.enableConfigDiscovery, true);
  assert.equal(sendTimeout, 60 * 60 * 1000);
  assert.equal(typeof config.onPermissionRequest, "function");
  assert.match(config.systemMessage.content, /real GitHub Copilot coding-agent loop/);
  assert.deepEqual(
    config.tools.map((tool) => tool.name),
    [
      "delegate_to_brainstem",
      "inspect_visible_brainstem",
      "show_rapp_identity",
      "ensure_copilot_studio_deploy_agents",
      "list_active_agent_files",
      "copilot_studio_deployment_defaults",
      "copilot_studio_auth_status",
      "start_copilot_studio_login",
      "poll_copilot_studio_login",
      "show_copilot_studio_agent_link",
      "create_agent_stack",
      "select_agent_stack",
      "remove_agent_stack",
      "install_scoped_agent",
      "list_scoped_agents",
      "remove_scoped_agent",
      "drive_visible_brainstem",
      "drive_twin",
      "set_ai_force_mode",
      "show_mode_click_through",
      "summon_dogg_neighborhood",
      "list_rapplications",
      "hatch_rapplication",
      "inspect_twin_adaptation",
      "propose_twin_adaptation",
      "stage_twin_adaptation",
      "rollback_twin_adaptation",
      "loop_brainstem_with_twin",
      "deploy_to_copilot_studio",
      "open_auth_window",
      "capture_visible_brainstem",
      "check_beta_updates",
      "clear_brainstem_chat",
      "refresh_brainstem_view",
      "start_demo_recording",
      "stop_demo_recording",
    ],
  );
  const stopRecording = config.tools.find(
    (tool) => tool.name === "stop_demo_recording",
  );
  assert.deepEqual(
    stopRecording.parameters.properties.recap_mode.enum,
    ["baseline", "repeat-ephemeral", "stack-churn", "control-handoff"],
  );
  const inspect = config.tools.find(
    (tool) => tool.name === "inspect_visible_brainstem",
  );
  assert.equal(inspect.parameters.properties.limit.maximum, 80);
  assert.deepEqual(
    inspect.parameters.properties.target.enum,
    ["brainstem", "shell"],
  );
  assert.equal(inspect.parameters.properties.since.type, "string");
  const drive = config.tools.find(
    (tool) => tool.name === "drive_visible_brainstem",
  );
  assert.deepEqual(
    drive.parameters.properties.target.enum,
    ["brainstem", "shell"],
  );
  assert.equal(
    drive.parameters.properties.steps.items.properties.handle.type,
    "string",
  );
  assert.equal(
    drive.parameters.properties.steps.items.properties.until.type,
    "object",
  );
  assert.ok(
    drive.parameters.properties.steps.items.properties.action.enum.includes("expect"),
  );
  const capture = config.tools.find(
    (tool) => tool.name === "capture_visible_brainstem",
  );
  assert.equal(capture.parameters.properties.include_text.type, "boolean");
  assert.equal(
    rappterSurgeonInternals.compactDriverSummary({
      results: [{ summary: "▶ clicked @brainstem.send ✓" }],
    }),
    "▶ clicked @brainstem.send ✓",
  );
});

test("temporary agent filenames are normalized safely", () => {
  assert.equal(
    rappterSurgeonInternals.cleanFilename("demo.py"),
    "demo_agent.py",
  );
  assert.equal(
    rappterSurgeonInternals.cleanFilename("../customer demo_agent.py"),
    "customer_demo_agent.py",
  );
  assert.throws(
    () => rappterSurgeonInternals.cleanFilename("basic_agent.py"),
    /safe agent filename/,
  );
});

test("fresh delegation waits for its frame before reapplying the chat lease", async () => {
  const commands = [];
  const routeRequests = [];
  const surgeon = new RappterSurgeon({
    runtime: {},
    brainstemUrl: "http://127.0.0.1:7071",
    routeManager: {
      withRoute: async (options, callback) => {
        routeRequests.push(options);
        return callback({ url: "http://127.0.0.1:7081" });
      },
    },
    uiCommand: async (command) => {
      commands.push(command);
      if (command.action === "chat") throw new Error("composer unavailable");
      return {};
    },
  });

  await assert.rejects(
    surgeon.delegateToBrainstem({
      prompt: "do it",
      ephemeral_agent: {
        filename: "temporary_agent.py",
        source: "print('temporary')",
      },
    }),
    /composer unavailable/,
  );
  assert.deepEqual(routeRequests, [{
    ephemeralAgent: {
      filename: "temporary_agent.py",
      source: "print('temporary')",
    },
  }]);
  const token = commands[0].token;
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(commands, [
    {
      action: "set_chat_lease",
      locked: true,
      token,
    },
    {
      action: "wait",
      selector: "#input",
      timeoutMs: 1000,
    },
    {
      action: "set_chat_lease",
      locked: true,
      token,
    },
    {
      action: "chat",
      value: "do it",
      label: "Delegating this outcome to the Brainstem",
      timeoutMs: 180000,
    },
    {
      action: "set_chat_lease",
      locked: false,
      token,
    },
  ]);
});

test("concurrent delegations retain independent chat lease tokens", async () => {
  const activeTokens = new Set();
  const chatResolvers = [];
  let chatsStarted = 0;
  let resolveChatsStarted;
  const chatsReady = new Promise((resolve) => {
    resolveChatsStarted = resolve;
  });
  const surgeon = new RappterSurgeon({
    runtime: {},
    brainstemUrl: "http://127.0.0.1:7071",
    routeManager: {
      withRoute: async (_options, callback) => (
        callback({ url: "http://127.0.0.1:7081" })
      ),
      recordTelemetry: () => {},
    },
    uiCommand: async (command) => {
      if (command.action === "set_chat_lease") {
        if (command.locked) activeTokens.add(command.token);
        else activeTokens.delete(command.token);
        return {};
      }
      if (command.action === "wait") return {};
      if (command.action === "chat") {
        chatsStarted += 1;
        if (chatsStarted === 2) resolveChatsStarted();
        return new Promise((resolve) => chatResolvers.push(resolve));
      }
      return {};
    },
  });
  const request = (marker) => surgeon.delegateToBrainstem({
    prompt: marker,
    ephemeral_agent: {
      filename: `${marker}_agent.py`,
      source: `class ${marker}Agent: pass`,
    },
  });

  const first = request("first");
  const second = request("second");
  await chatsReady;
  assert.equal(activeTokens.size, 2);
  chatResolvers[0]({ response: "first" });
  await first;
  assert.equal(activeTokens.size, 1);
  chatResolvers[1]({ response: "second" });
  await second;
  assert.equal(activeTokens.size, 0);
});

test("separate Surgeons reapply the shared lease registry after route swaps", async () => {
  const registry = new Set();
  const visibleTokens = new Set();
  const uiCommand = async (command) => {
    if (command.action === "set_chat_lease") {
      if (command.locked) visibleTokens.add(command.token);
      else visibleTokens.delete(command.token);
      return {};
    }
    if (command.action === "wait") return {};
    if (command.action === "chat") return { response: command.value };
    return {};
  };
  const routeManager = {
    withRoute: async (_options, callback) => {
      visibleTokens.clear();
      return callback({ url: "http://127.0.0.1:7081" });
    },
    recordTelemetry: () => {},
  };
  const first = new RappterSurgeon({
    chatLeaseRegistry: registry,
    routeManager,
    runtime: {},
    uiCommand,
  });
  const second = new RappterSurgeon({
    chatLeaseRegistry: registry,
    routeManager,
    runtime: {},
    uiCommand,
  });

  const firstToken = await first.acquireChatLease();
  const secondToken = await second.acquireChatLease();
  visibleTokens.clear();
  await first.syncChatLeases();
  assert.deepEqual(
    [...visibleTokens].sort(),
    [firstToken, secondToken].sort(),
  );
  await first.releaseChatLease(firstToken);
  assert.equal(registry.has(firstToken), false);
  assert.equal(registry.has(secondToken), true);
  await second.releaseChatLease(secondToken);
  assert.equal(registry.size, 0);
});

test("a delegation whose composer was taken back reports yielded_to_user and does not re-drive", async () => {
  const commands = [];
  const events = [];
  const surgeon = new RappterSurgeon({
    runtime: {},
    brainstemUrl: "http://127.0.0.1:7071",
    onEvent: (event) => events.push(event),
    routeManager: {
      recordTelemetry: () => {},
      withRoute: async (_options, callback) => callback(),
    },
    uiCommand: async (command) => {
      commands.push(command);
      if (command.action === "chat") {
        return {
          yielded_to_user: true,
          reason: "person_took_composer",
        };
      }
      return {};
    },
  });

  const result = JSON.parse(await surgeon.delegateToBrainstem({
    prompt: "do it",
    ephemeral_agent: {
      filename: "temporary_agent.py",
      source: "print('temporary')",
    },
  }));

  assert.equal(result.yielded_to_user, true);
  assert.equal(
    events.filter((event) => event.type === "lease").length,
    1,
  );
  assert.equal(
    commands.filter((command) => command.action === "chat").length,
    1,
  );
  assert.equal(commands.at(-1).action, "set_chat_lease");
  assert.equal(commands.at(-1).locked, false);
  assert.equal(typeof commands.at(-1).token, "string");
});

test("a failed lease release cannot replace the delegation's result", async () => {
  const commands = [];
  const registry = new Set();
  const telemetry = [];
  const surgeon = new RappterSurgeon({
    chatLeaseRegistry: registry,
    runtime: {},
    brainstemUrl: "http://127.0.0.1:7071",
    routeManager: {
      recordTelemetry: (type, data) => telemetry.push({ type, ...data }),
      withRoute: async (_options, callback) => callback(),
    },
    uiCommand: async (command) => {
      commands.push(command);
      if (command.action === "chat") return { response: "ok" };
      if (command.action === "set_chat_lease" && !command.locked) {
        throw new Error("frame disappeared during release");
      }
      return {};
    },
  });

  const result = JSON.parse(await surgeon.delegateToBrainstem({
    prompt: "do it",
    ephemeral_agent: {
      filename: "temporary_agent.py",
      source: "print('temporary')",
    },
  }));
  const token = commands.find(
    (command) => command.action === "set_chat_lease" && command.locked,
  ).token;

  assert.equal(result.response, "ok");
  assert.deepEqual(
    telemetry.filter((event) => event.type === "chat-lease-released"),
    [{ type: "chat-lease-released", lease_count: 0 }],
  );
  assert.equal(surgeon.chatLeaseTokens.has(token), false);
  assert.equal(registry.has(token), false);
});

test("Rappter Surgeon manages nested RAPPID stacks and visibly reloads selection", async () => {
  const calls = [];
  const routeManager = {
    listScopedAgents: async (options = {}) => {
      calls.push(["list", options]);
      return { caller_rappid: "caller", stack_tree: [] };
    },
    createStack: async (options) => {
      calls.push(["create", options]);
      return { rappid: "child", name: options.name };
    },
    stackTree: () => [{ rappid: "child", name: "child", children: [] }],
    selectStack: async (options) => {
      calls.push(["select", options]);
      return {
        active_stack_rappid: options.stackRappid,
        overlay_stack_rappids: options.overlayRappids,
      };
    },
    startDefault: async () => {
      calls.push(["start"]);
      return { url: "http://127.0.0.1:7081", compositionHash: "hash" };
    },
  };
  const surgeon = new RappterSurgeon({
    runtime: {},
    brainstemUrl: "http://127.0.0.1:7071",
    routeManager,
    uiCommand: async () => ({}),
  });

  assert.equal(
    JSON.parse(await surgeon.showRappIdentity()).caller_rappid,
    "caller",
  );
  assert.equal(
    JSON.parse(await surgeon.createAgentStack({
      name: "regulated",
      parent_stack_rappid: "parent",
    })).stack.rappid,
    "child",
  );
  const selected = JSON.parse(await surgeon.selectAgentStack({
    stack_rappid: "leaf",
    overlay_stack_rappids: ["voice", "evidence"],
  }));
  assert.equal(selected.active_route.compositionHash, "hash");
  assert.deepEqual(calls, [
    ["list", {}],
    ["create", { name: "regulated", parentRappid: "parent" }],
    ["select", {
      stackRappid: "leaf",
      overlayRappids: ["voice", "evidence"],
    }],
    ["start"],
  ]);
});

test("Rappter Surgeon validates and injects bundled Copilot Studio agents", async (t) => {
  const active = [];
  let restarted = 0;
  const betaHome = mkdtempSync(path.join(tmpdir(), "rappter-surgeon-studio-"));
  t.after(() => rmSync(betaHome, { recursive: true, force: true }));
  const surgeon = new RappterSurgeon({
    runtime: {},
    brainstemUrl: "http://127.0.0.1:7071",
    routeManager: {
      betaHome,
      activeAgentFiles: () => active,
      installScopedAgent: async ({ filename, source }) => {
        assert.match(source, /__manifest__/);
        active.push({
          filename,
          scope: "stack:test",
          address: filename,
          source,
        });
      },
      readActiveAgent: (filename) => active.find(
        (agent) => agent.filename === filename,
      )?.source || "",
      startDefault: async () => {
        restarted += 1;
        return { url: "http://127.0.0.1:7081" };
      },
    },
    uiCommand: async () => ({}),
  });

  test("Rappter Surgeon emits a clickable Copilot Studio agent link", async () => {
    const events = [];
    const surgeon = new RappterSurgeon({
      runtime: {},
      brainstemUrl: "http://127.0.0.1:7071",
      uiCommand: async () => ({}),
      onEvent: (event) => events.push(event),
    });
    const value = JSON.parse(await surgeon.showCopilotStudioAgentLink({
      environment_id: "ee67a404-325c-e726-a18a-886fe708ca0b",
      agent_id: "52670b23-8a6e-4a86-9502-7e793b127ad4",
      display_name: "RAPP News Memory One Click",
    }));
    assert.equal(
      value.url,
      "https://copilotstudio.preview.microsoft.com/environments/"
        + "ee67a404-325c-e726-a18a-886fe708ca0b/agents/"
        + "52670b23-8a6e-4a86-9502-7e793b127ad4",
    );
    assert.equal(events[0].artifact.kind, "link");
  });

  const first = JSON.parse(await surgeon.ensureCopilotStudioAgents());
  assert.deepEqual(first.injected, [
    "rar_kody_w_copilot_studio_parity_deploy_agent.py",
    "rar_kody_w_factory_agent.py",
  ]);
  assert.equal(first.active[0].version, "1.0.14");
  assert.equal(first.active[1].version, "1.0.4");
  assert.equal(first.active[0].tool_name, "CopilotStudioDeployBeta");
  assert.equal(first.active[1].tool_name, "RappCopilotStudioFactoryBeta");
  assert.equal(existsSync(first.parity_cases_path), true);
  assert.equal(existsSync(first.industry_matrix_path), true);
  assert.equal(restarted, 1);
  const second = JSON.parse(await surgeon.ensureCopilotStudioAgents());
  assert.deepEqual(second.injected, []);
  assert.equal(restarted, 1);
});

test("deployment agent validation rejects stale filenames", () => {
  assert.equal(
    rappterSurgeonInternals.deploymentAgentSourceMatches(
      '__manifest__ = {"version": "9.9.9"}\nself.name = "WrongTool"',
      {
        toolName: "CopilotStudioDeployBeta",
        minimumVersion: "1.0.4",
        requiredMarker: "BETA_DRAFT_ONLY = True",
      },
    ),
    false,
  );
  assert.equal(
    rappterSurgeonInternals.deploymentAgentSourceMatches(
      '__manifest__ = {"version": "1.0.14"}\n'
        + 'BETA_DRAFT_ONLY = True\nself.name = "CopilotStudioDeployBeta"',
      {
        toolName: "CopilotStudioDeployBeta",
        minimumVersion: "1.0.14",
        requiredMarker: "BETA_DRAFT_ONLY = True",
      },
    ),
    true,
  );
});
