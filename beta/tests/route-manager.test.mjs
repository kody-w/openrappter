import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openLedger } from "../electron/ledger.mjs";
import { BetaRouteManager } from "../electron/route-manager.mjs";


function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-route-manager-"));
  const brainstemDir = path.join(root, "brainstem");
  const agentsDir = path.join(brainstemDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "global_agent.py"),
    "class GlobalAgent:\n    def perform(self, **kwargs): return 'global'\n",
  );
  writeFileSync(
    path.join(agentsDir, "context_memory_agent.py"),
    "class ContextMemoryAgent: pass\n",
  );
  writeFileSync(
    path.join(agentsDir, "manage_memory_agent.py"),
    "class ManageMemoryAgent: pass\n",
  );
  const manager = new BetaRouteManager({
    betaHome: path.join(root, "beta-home"),
    brainstemConfig: {
      brainstemDir,
      python: "/tmp/python",
    },
    owner: "microsoft",
    lineageRoot: path.join(root, "lineage"),
    seedLineageDefaults: false,
    compositionValidator: () => true,
  });
  return { root, manager };
}

test("route compositions combine global and scoped agents without byte copies", async () => {
  const { root, manager } = fixture();
  try {
    const installed = await manager.installScopedAgent({
      filename: "role_agent.py",
      source: "class RoleAgent:\n    def perform(self, **kwargs): return 'role'\n",
    });
    assert.match(installed.user_rappid, /^rappid:@microsoft\//);

    const descriptor = manager.compositionDescriptor();
    assert.deepEqual(
      descriptor.entries.map((entry) => entry.filename),
      [
        "context_memory_agent.py",
        "global_agent.py",
        "manage_memory_agent.py",
        "role_agent.py",
      ],
    );
    const materialized = manager.materializeComposition(descriptor);
    const manifest = JSON.parse(
      readFileSync(
        path.join(materialized.compositionDirectory, "complete.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.agents.length, 4);
    assert.ok(
      manifest.agents.every((agent) => ["hardlink", "copy"].includes(agent.method)),
    );

    const globalEntry = descriptor.entries.find(
      (entry) => entry.filename === "global_agent.py",
    );
    const materializedGlobal = path.join(
      materialized.agentDirectory,
      "global_agent.py",
    );
    if (manifest.agents.find((agent) => agent.filename === "global_agent.py").method === "hardlink") {
      assert.equal(
        statSync(globalEntry.objectPath).ino,
        statSync(materializedGlobal).ino,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tile compositions carry routed agents while a blank primary keeps only the baseline", async () => {
  const { root, manager } = fixture();
  try {
    await manager.installScopedAgent({
      filename: "tile_proof_agent.py",
      source: "class TileProofAgent:\n    def perform(self, **kwargs): return 'tile'\n",
    });
    const descriptor = manager.compositionDescriptor();
    const materialized = manager.materializeComposition(descriptor);
    manager.activeRoute = {
      compositionHash: descriptor.compositionHash,
      stackRappid: descriptor.stack.rappid,
      url: "http://127.0.0.1:7000",
    };
    manager.workers.set(descriptor.compositionHash, {
      agentDirectory: materialized.agentDirectory,
      compositionDirectory: materialized.compositionDirectory,
      process: { stop: async () => {} },
      route: manager.activeRoute,
    });

    const payload = manager.activeTileAgentPayload();
    assert.deepEqual(payload.map((agent) => agent.filename), [
      "tile_proof_agent.py",
    ]);
    const tile = manager.tileCompositionDescriptor(payload);
    assert.deepEqual(
      tile.entries.map((entry) => [entry.filename, entry.scope]),
      [
        ["context_memory_agent.py", "memory"],
        ["global_agent.py", "global"],
        ["manage_memory_agent.py", "memory"],
        ["tile_proof_agent.py", "tile"],
      ],
    );
    const blank = manager.tileCompositionDescriptor();
    assert.equal(
      blank.entries.some((entry) => entry.filename === "tile_proof_agent.py"),
      false,
    );
    assert.notEqual(blank.compositionHash, tile.compositionHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ephemeral agents participate in one composition and collisions fail closed", () => {
  const { root, manager } = fixture();
  try {
    manager.compositionDescriptor();
    const objectCount = readdirSync(manager.objectRoot).length;
    const eggCount = readdirSync(manager.eggRoot).length;
    const descriptor = manager.compositionDescriptor({
      ephemeralAgent: {
        filename: "temporary_agent.py",
        source: "class TemporaryAgent:\n    def perform(self, **kwargs): return 'once'\n",
      },
    });
    assert.equal(descriptor.ephemeral, true);
    assert.ok(
      descriptor.entries.some((entry) => entry.filename === "temporary_agent.py"),
    );
    const repeated = manager.compositionDescriptor({
      ephemeralAgent: {
        filename: "temporary_agent.py",
        source: "class TemporaryAgent:\n    def perform(self, **kwargs): return 'once'\n",
      },
    });
    assert.notEqual(descriptor.compositionHash, repeated.compositionHash);
    assert.equal(readdirSync(manager.objectRoot).length, objectCount);
    assert.equal(readdirSync(manager.eggRoot).length, eggCount);
    assert.throws(
      () => manager.compositionDescriptor({
        ephemeralAgent: {
          filename: "global_agent.py",
          source: "print('collision')\n",
        },
      }),
      /composition collision/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global source revisions create a new composition hash", () => {
  const { root, manager } = fixture();
  try {
    const first = manager.compositionDescriptor().compositionHash;
    writeFileSync(
      path.join(manager.brainstemConfig.brainstemDir, "agents", "global_agent.py"),
      "class GlobalAgent:\n    def perform(self, **kwargs): return 'changed'\n",
    );
    const second = manager.compositionDescriptor().compositionHash;
    assert.notEqual(first, second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested stacks inherit agents, preserve overlay order, and share memory", async () => {
  const { root, manager } = fixture();
  try {
    const identity = manager.identity();
    const rootStack = identity.default_stack_rappid;
    const child = await manager.createStack({
      name: "sales",
      parentRappid: rootStack,
    });
    const leaf = await manager.createStack({
      name: "regulated",
      parentRappid: child.rappid,
    });
    const firstOverlay = await manager.createStack({
      name: "evidence",
      parentRappid: rootStack,
    });
    const secondOverlay = await manager.createStack({
      name: "voice",
      parentRappid: rootStack,
    });
    await manager.installScopedAgent({
      filename: "root_role_agent.py",
      source: "class RootRoleAgent:\n    def perform(self, **kwargs): return 'root'\n",
      stackRappid: rootStack,
    });
    await manager.installScopedAgent({
      filename: "leaf_role_agent.py",
      source: "class LeafRoleAgent:\n    def perform(self, **kwargs): return 'leaf'\n",
      stackRappid: leaf.rappid,
    });
    await manager.installScopedAgent({
      filename: "evidence_role_agent.py",
      source: "class EvidenceRoleAgent:\n    def perform(self, **kwargs): return 'evidence'\n",
      stackRappid: firstOverlay.rappid,
    });
    await manager.installScopedAgent({
      filename: "voice_role_agent.py",
      source: "class VoiceRoleAgent:\n    def perform(self, **kwargs): return 'voice'\n",
      stackRappid: secondOverlay.rappid,
    });

    const before = manager.compositionDescriptor();
    const beforeMemory = before.entries
      .filter((entry) => entry.scope === "memory")
      .map((entry) => entry.address);
    const selection = await manager.selectStack({
      stackRappid: leaf.rappid,
      overlayRappids: [secondOverlay.rappid, firstOverlay.rappid],
    });
    assert.deepEqual(selection.overlay_stack_rappids, [
      secondOverlay.rappid,
      firstOverlay.rappid,
    ]);

    const descriptor = manager.compositionDescriptor();
    assert.equal(descriptor.identity.memory_guid, identity.memory_guid);
    assert.deepEqual(
      descriptor.entries
        .filter((entry) => entry.scope === "memory")
        .map((entry) => entry.address),
      beforeMemory,
    );
    assert.deepEqual(
      descriptor.selectedStacks.map((stack) => stack.rappid),
      [
        rootStack,
        child.rappid,
        leaf.rappid,
        secondOverlay.rappid,
        firstOverlay.rappid,
      ],
    );
    assert.deepEqual(
      descriptor.entries
        .filter((entry) => entry.scope.startsWith("stack:"))
        .map((entry) => entry.filename),
      [
        "evidence_role_agent.py",
        "leaf_role_agent.py",
        "root_role_agent.py",
        "voice_role_agent.py",
      ],
    );

    const tree = manager.stackTree();
    const rootNode = tree.find((stack) => stack.rappid === rootStack);
    const childNode = rootNode.children.find((stack) => stack.rappid === child.rappid);
    const leafNode = childNode.children.find((stack) => stack.rappid === leaf.rappid);
    const voiceNode = rootNode.children.find(
      (stack) => stack.rappid === secondOverlay.rappid,
    );
    const evidenceNode = rootNode.children.find(
      (stack) => stack.rappid === firstOverlay.rappid,
    );
    assert.equal(leafNode.active, true);
    assert.equal(voiceNode.overlay_order, 1);
    assert.equal(evidenceNode.overlay_order, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent stack churn can return the tree to its exact baseline", async () => {
  const { root, manager } = fixture();
  try {
    const identity = manager.identity();
    const baseline = manager.stackTree();
    const child = await manager.createStack({
      name: "buzzsaw-role",
      parentRappid: identity.default_stack_rappid,
    });
    const overlay = await manager.createStack({
      name: "buzzsaw-overlay",
      parentRappid: identity.default_stack_rappid,
    });
    await manager.installScopedAgent({
      filename: "stack_churn_agent.py",
      source: "class StackChurnAgent:\n    def perform(self, **kwargs): return 'STACK_CHURN_READY'\n",
      stackRappid: child.rappid,
    });
    await manager.selectStack({
      stackRappid: child.rappid,
      overlayRappids: [overlay.rappid],
    });
    await manager.removeScopedAgent({
      filename: "stack_churn_agent.py",
      stackRappid: child.rappid,
    });
    await manager.selectStack({
      stackRappid: identity.default_stack_rappid,
      overlayRappids: [],
    });
    await manager.removeStack({ stackRappid: child.rappid });
    await manager.removeStack({ stackRappid: overlay.rappid });

    assert.deepEqual(manager.stackTree(), baseline);
    assert.equal(existsSync(manager.stackPath(child.rappid)), false);
    assert.equal(existsSync(manager.stackPath(overlay.rappid)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent route callback telemetry binds request ID and proof response", async () => {
  const { root, manager } = fixture();
  try {
    const descriptor = manager.compositionDescriptor();
    const materialized = manager.materializeComposition(descriptor);
    const route = {
      url: "http://127.0.0.1:7000",
      compositionHash: descriptor.compositionHash,
      stackRappid: descriptor.stack.rappid,
    };
    manager.activeRoute = route;
    manager.workers.set(descriptor.compositionHash, {
      activeRequests: 0,
      agentDirectory: materialized.agentDirectory,
      compositionDirectory: materialized.compositionDirectory,
      process: { stop: async () => {} },
      route,
    });

    await manager.withRoute({}, async () => ({
      agentLogs: "AGENT CALLED STACKCHURNPROOF",
      requestId: 7,
      response: "STACK_CHURN_READY",
    }));
    const event = manager.telemetrySnapshot().events.find(
      (candidate) => candidate.type === "route-callback-end",
    );
    assert.equal(event.request_id, 7);
    assert.equal(event.response_preview, "STACK_CHURN_READY");
    assert.equal(event.agent_logs_preview, "AGENT CALLED STACKCHURNPROOF");
    assert.ok(event.composition_fingerprint.source_hash);
    assert.ok(
      event.composition_fingerprint.files.includes("global_agent.py"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active-agent deletion persists for stack and global sources", async () => {
  const { root, manager } = fixture();
  try {
    await manager.installScopedAgent({
      filename: "delete_me_agent.py",
      source: "class DeleteMeAgent: pass\n",
    });

    const descriptor = manager.compositionDescriptor();
    const materialized = manager.materializeComposition(descriptor);
    manager.activeRoute = {
      compositionHash: descriptor.compositionHash,
      stackRappid: descriptor.stack.rappid,
      url: "http://127.0.0.1:7000",
    };
    manager.workers.set(descriptor.compositionHash, {
      activeRequests: 0,
      agentDirectory: materialized.agentDirectory,
      compositionDirectory: materialized.compositionDirectory,
      process: { stop: async () => {} },
      route: manager.activeRoute,
    });

    const scoped = await manager.removeActiveAgent({
      filename: "delete_me_agent.py",
    });
    assert.match(scoped.scope, /^stack:/);
    assert.equal(manager.loadStack(descriptor.stack.rappid).agents.length, 0);

    const global = await manager.removeActiveAgent({
      filename: "global_agent.py",
    });
    assert.equal(global.scope, "global");
    assert.equal(
      existsSync(path.join(root, "brainstem", "agents", "global_agent.py")),
      false,
    );
    await assert.rejects(
      () => manager.removeActiveAgent({
        filename: "context_memory_agent.py",
      }),
      /generated from the Frontier identity/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("route telemetry writes complete install and removal rows to the ledger", async () => {
  const { root, manager } = fixture();
  const ledger = openLedger(path.join(root, "ledger-home"));
  manager.ledger = ledger;
  try {
    const source = [
      "class WeatherAgent:",
      "    def __init__(self):",
      "        self.name = \"WeatherAgent\"",
      "    def perform(self, **kwargs): return 'sunny'",
      "",
    ].join("\n");
    const installed = await manager.installScopedAgent({
      filename: "weather_agent.py",
      origin: "store",
      source,
    });
    await manager.removeScopedAgent({
      filename: "weather_agent.py",
      origin: "store",
    });

    const events = ledger.database.prepare(`
      SELECT event, filename, tool_name, rappid, sha256, source_path, origin
      FROM agents
      ORDER BY id
    `).all();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(({ event }) => event), ["installed", "removed"]);
    for (const event of events) {
      assert.equal(event.filename, "weather_agent.py");
      assert.equal(event.tool_name, "WeatherAgent");
      assert.equal(event.rappid, installed.agent.agent_rappid);
      assert.match(event.sha256, /^[a-f0-9]{64}$/);
      assert.equal(event.source_path, installed.agent.object_path);
      assert.equal(event.origin, "store");
    }
    assert.equal(
      ledger.database.prepare("SELECT count(*) AS total FROM sources").get().total,
      1,
    );
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger-only agent rows do not inflate route telemetry responses", () => {
  const { root, manager } = fixture();
  let ledgerEvent = null;
  manager.ledger = {
    recordRouteEvent: (event) => {
      ledgerEvent = event;
    },
  };
  try {
    const event = manager.recordTelemetry("lineage-promote", {
      agent_rows: [{
        filename: "context_memory_agent.py",
        origin: "lineage",
        rappid: "rappid:@frontier/context-memory-ring:test",
        sha256: "a".repeat(64),
        source_path: "/private/lineage/source.py",
        tool_name: "ContextMemory",
      }],
      changed: 1,
    });
    assert.equal(ledgerEvent.agent_rows.length, 1);
    assert.equal(event.agent_rows, undefined);
    assert.equal(event.agent_row_count, 1);
    assert.equal(manager.telemetry.at(-1).agent_rows, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inherited and overlay filename collisions fail closed", async () => {
  const { root, manager } = fixture();
  try {
    const identity = manager.identity();
    const child = await manager.createStack({
      name: "child",
      parentRappid: identity.default_stack_rappid,
    });
    await manager.installScopedAgent({
      filename: "collision_agent.py",
      source: "class ParentCollisionAgent:\n    def perform(self, **kwargs): return 'parent'\n",
      stackRappid: identity.default_stack_rappid,
    });
    await manager.installScopedAgent({
      filename: "collision_agent.py",
      source: "class ChildCollisionAgent:\n    def perform(self, **kwargs): return 'child'\n",
      stackRappid: child.rappid,
    });
    await manager.selectStack({
      stackRappid: child.rappid,
      overlayRappids: [],
    });
    assert.throws(
      () => manager.compositionDescriptor(),
      /composition collision/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy stack manifests acquire a deterministic display name", () => {
  const { root, manager } = fixture();
  try {
    const identity = manager.identity();
    const stackPath = manager.stackPath(identity.default_stack_rappid);
    const legacy = JSON.parse(readFileSync(stackPath, "utf8"));
    delete legacy.name;
    writeFileSync(stackPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const tree = manager.stackTree();
    assert.equal(tree[0].name, "default");
    assert.equal(
      JSON.parse(readFileSync(stackPath, "utf8")).name,
      "default",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ephemeral cleanup preserves the live route while removing the tool", async () => {
  const { root, manager } = fixture();
  try {
    const defaultDescriptor = manager.compositionDescriptor();
    const ephemeralDescriptor = manager.compositionDescriptor({
      ephemeralAgent: {
        filename: "walkthrough_agent.py",
        source: "class WalkthroughAgent:\n    def perform(self, **kwargs): return 'ready'\n",
      },
    });
    const materialized = manager.materializeComposition(ephemeralDescriptor);
    let previousDefaultStopped = false;
    manager.workers.set(defaultDescriptor.compositionHash, {
      process: {
        stop: async () => {
          previousDefaultStopped = true;
        },
      },
      route: {
        url: "http://127.0.0.1:7000",
        compositionHash: defaultDescriptor.compositionHash,
      },
    });
    const route = {
      url: "http://127.0.0.1:7001",
      compositionHash: ephemeralDescriptor.compositionHash,
      stackRappid: ephemeralDescriptor.stack.rappid,
    };
    manager.workers.set(ephemeralDescriptor.compositionHash, {
      agentDirectory: materialized.agentDirectory,
      compositionDirectory: materialized.compositionDirectory,
      process: { stop: async () => {} },
      route,
      ephemeral: true,
    });
    manager.activeRoute = route;

    const retired = await manager.retireEphemeralWorker(ephemeralDescriptor);
    assert.equal(previousDefaultStopped, true);
    assert.equal(retired.url, "http://127.0.0.1:7001");
    assert.equal(retired.compositionHash, defaultDescriptor.compositionHash);
    assert.equal(manager.activeRoute, retired);
    assert.equal(
      existsSync(path.join(materialized.agentDirectory, "walkthrough_agent.py")),
      false,
    );
    assert.ok(
      manager.activeAgentFiles().every(
        (agent) => agent.filename !== "walkthrough_agent.py",
      ),
    );
    const retiredManifest = JSON.parse(
      readFileSync(
        path.join(materialized.compositionDirectory, "complete.json"),
        "utf8",
      ),
    );
    assert.equal(retiredManifest.retired_ephemeral, true);
    assert.ok(
      retiredManifest.agents.every(
        (agent) => agent.filename !== "walkthrough_agent.py",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary route changes retire the superseded worker", async () => {
  const { root, manager } = fixture();
  try {
    let stopped = false;
    const oldRoute = {
      url: "http://127.0.0.1:7000",
      compositionHash: "old-composition",
    };
    const oldWorker = {
      activeRequests: 1,
      process: {
        stop: async () => {
          stopped = true;
        },
      },
      route: oldRoute,
    };
    manager.activeRoute = oldRoute;
    manager.workers.set(oldRoute.compositionHash, oldWorker);
    manager.compositionDescriptor = () => ({
      compositionHash: "new-composition",
    });
    manager.startWorker = async () => {
      const route = {
        url: "http://127.0.0.1:7001",
        compositionHash: "new-composition",
      };
      manager.workers.set(route.compositionHash, {
        activeRequests: 0,
        process: { stop: async () => {} },
        route,
      });
      return route;
    };
    setTimeout(() => {
      oldWorker.activeRequests = 0;
    }, 10);

    const route = await manager.startDefault();
    assert.equal(route.compositionHash, "new-composition");
    assert.equal(stopped, true);
    assert.equal(manager.workers.has("old-composition"), false);
    assert.equal(manager.activeRoute, route);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("consecutive ephemeral turns reuse the live worker and clean up each time", async () => {
  const { root, manager } = fixture();
  try {
    const defaultDescriptor = manager.compositionDescriptor();
    const materialized = manager.materializeComposition(defaultDescriptor);
    const defaultRoute = {
      url: "http://127.0.0.1:7000",
      compositionHash: defaultDescriptor.compositionHash,
      stackRappid: defaultDescriptor.stack.rappid,
    };
    manager.activeRoute = defaultRoute;
    manager.workers.set(defaultDescriptor.compositionHash, {
      activeRequests: 0,
      agentDirectory: materialized.agentDirectory,
      compositionDirectory: materialized.compositionDirectory,
      process: { stop: async () => {} },
      route: defaultRoute,
    });
    manager.startWorker = async (descriptor) => {
      const ephemeral = manager.materializeComposition(descriptor);
      const route = {
        url: `http://127.0.0.1:${descriptor.compositionHash.slice(0, 4)}`,
        compositionHash: descriptor.compositionHash,
        stackRappid: descriptor.stack.rappid,
      };
      manager.workers.set(descriptor.compositionHash, {
        activeRequests: 0,
        agentDirectory: ephemeral.agentDirectory,
        compositionDirectory: ephemeral.compositionDirectory,
        process: { stop: async () => {} },
        route,
      });
      return route;
    };
    const request = {
      ephemeralAgent: {
        filename: "repeat_agent.py",
        source: "class RepeatAgent:\n    def perform(self, **kwargs): return 'ready'\n",
      },
    };
    const seenUrls = [];
    for (let turn = 0; turn < 2; turn += 1) {
      await manager.withRoute(request, async (route) => {
        seenUrls.push(route.url);
        assert.equal(
          existsSync(path.join(
            manager.workers.get(route.compositionHash).agentDirectory,
            "repeat_agent.py",
          )),
          true,
        );
      });
      assert.equal(
        existsSync(path.join(materialized.agentDirectory, "repeat_agent.py")),
        false,
      );
    }
    assert.deepEqual(seenUrls, [defaultRoute.url, defaultRoute.url]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-route ephemeral requests serialize without overlap", async () => {
  const { root, manager } = fixture();
  try {
    const descriptor = manager.compositionDescriptor();
    const materialized = manager.materializeComposition(descriptor);
    const route = {
      url: "http://127.0.0.1:7000",
      compositionHash: descriptor.compositionHash,
      stackRappid: descriptor.stack.rappid,
    };
    manager.activeRoute = route;
    manager.workers.set(descriptor.compositionHash, {
      activeRequests: 0,
      agentDirectory: materialized.agentDirectory,
      compositionDirectory: materialized.compositionDirectory,
      process: { stop: async () => {} },
      route,
    });
    let active = 0;
    let maximumActive = 0;
    const order = [];
    const run = (name) => manager.withRoute({
      ephemeralAgent: {
        filename: `${name}_agent.py`,
        source: `class ${name}Agent:\n    def perform(self, **kwargs): return '${name}'\n`,
      },
    }, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`${name}:end`);
      active -= 1;
    });

    await Promise.all([run("First"), run("Second")]);
    assert.equal(maximumActive, 1);
    assert.deepEqual(order, [
      "First:start",
      "First:end",
      "Second:start",
      "Second:end",
    ]);
    assert.equal(
      readdirSync(materialized.agentDirectory)
        .some((filename) => /first_agent|second_agent/i.test(filename)),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("route replacement waits for ephemeral cleanup before stopping old worker", async () => {
  const { root, manager } = fixture();
  try {
    const descriptor = manager.compositionDescriptor();
    const materialized = manager.materializeComposition(descriptor);
    let oldStopped = false;
    const oldRoute = {
      url: "http://127.0.0.1:7000",
      compositionHash: descriptor.compositionHash,
      stackRappid: descriptor.stack.rappid,
    };
    manager.activeRoute = oldRoute;
    manager.workers.set(descriptor.compositionHash, {
      activeRequests: 0,
      agentDirectory: materialized.agentDirectory,
      compositionDirectory: materialized.compositionDirectory,
      process: {
        stop: async () => {
          oldStopped = true;
        },
      },
      route: oldRoute,
    });
    let releaseEphemeral;
    let ephemeralStarted;
    const started = new Promise((resolve) => {
      ephemeralStarted = resolve;
    });
    const ephemeral = manager.withRoute({
      ephemeralAgent: {
        filename: "slow_agent.py",
        source: "class SlowAgent:\n    def perform(self, **kwargs): return 'slow'\n",
      },
    }, async () => {
      ephemeralStarted();
      await new Promise((resolve) => {
        releaseEphemeral = resolve;
      });
    });
    await started;

    manager.compositionDescriptor = () => ({
      compositionHash: "new-composition",
    });
    manager.startWorker = async () => {
      const route = {
        url: "http://127.0.0.1:7001",
        compositionHash: "new-composition",
      };
      manager.workers.set(route.compositionHash, {
        activeRequests: 0,
        process: { stop: async () => {} },
        route,
      });
      return route;
    };
    let replacementFinished = false;
    const replacement = manager.startDefault().then((route) => {
      replacementFinished = true;
      return route;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(replacementFinished, false);
    assert.equal(manager.activeRoute, oldRoute);
    assert.equal(oldStopped, false);

    releaseEphemeral();
    await ephemeral;
    const newRoute = await replacement;
    assert.equal(newRoute.compositionHash, "new-composition");
    assert.equal(manager.activeRoute, newRoute);
    assert.equal(oldStopped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ephemeral request queued behind replacement uses the new active route", async () => {
  const { root, manager } = fixture();
  try {
    const originalDescriptor = manager.compositionDescriptor.bind(manager);
    const oldDescriptor = originalDescriptor();
    const oldMaterialized = manager.materializeComposition(oldDescriptor);
    let oldStopped = false;
    const oldRoute = {
      url: "http://127.0.0.1:7000",
      compositionHash: oldDescriptor.compositionHash,
      stackRappid: oldDescriptor.stack.rappid,
    };
    manager.activeRoute = oldRoute;
    manager.workers.set(oldDescriptor.compositionHash, {
      activeRequests: 0,
      agentDirectory: oldMaterialized.agentDirectory,
      compositionDirectory: oldMaterialized.compositionDirectory,
      process: {
        stop: async () => {
          oldStopped = true;
        },
      },
      route: oldRoute,
    });

    const newDescriptor = {
      ...oldDescriptor,
      compositionHash: "replacement-composition",
    };
    const newMaterialized = manager.materializeComposition(newDescriptor);
    let releaseStart;
    let startEntered;
    const entered = new Promise((resolve) => {
      startEntered = resolve;
    });
    manager.compositionDescriptor = (options = {}) => (
      options.ephemeralAgent
        ? originalDescriptor(options)
        : newDescriptor
    );
    manager.startWorker = async (descriptor) => {
      startEntered();
      await new Promise((resolve) => {
        releaseStart = resolve;
      });
      const route = {
        url: "http://127.0.0.1:7001",
        compositionHash: descriptor.compositionHash,
        stackRappid: descriptor.stack.rappid,
      };
      manager.workers.set(descriptor.compositionHash, {
        activeRequests: 0,
        agentDirectory: newMaterialized.agentDirectory,
        compositionDirectory: newMaterialized.compositionDirectory,
        process: { stop: async () => {} },
        route,
      });
      return route;
    };

    const replacement = manager.startDefault();
    await entered;
    let ephemeralUrl = null;
    const ephemeral = manager.withRoute({
      ephemeralAgent: {
        filename: "queued_agent.py",
        source: "class QueuedAgent:\n    def perform(self, **kwargs): return 'queued'\n",
      },
    }, async (route) => {
      ephemeralUrl = route.url;
      assert.equal(
        existsSync(path.join(newMaterialized.agentDirectory, "queued_agent.py")),
        true,
      );
    });
    releaseStart();
    const newRoute = await replacement;
    await ephemeral;

    assert.equal(newRoute.url, "http://127.0.0.1:7001");
    assert.equal(ephemeralUrl, newRoute.url);
    assert.equal(manager.activeRoute, newRoute);
    assert.equal(oldStopped, true);
    assert.equal(
      existsSync(path.join(newMaterialized.agentDirectory, "queued_agent.py")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
