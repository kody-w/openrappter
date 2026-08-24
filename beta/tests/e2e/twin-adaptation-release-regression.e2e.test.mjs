import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";

import { TwinManager } from "../../electron/twin-manager.mjs";

const betaRoot = path.resolve(import.meta.dirname, "../..");
const readyOnlySource = `
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

class ReadyOnlyChatWorker {
  constructor(config) {
    this.config = config;
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/chat") {
          response.writeHead(404).end();
          return;
        }
        for await (const _chunk of request) {
          // Consume the real /chat request body.
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          response: '{"status":"ready","message":"Get emails for me"}',
          agent_logs: "tool=GetEmails",
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

test("reported ready-only email correction enters diagnosis and pins WorkIQ reuse", async (t) => {
  const directory = mkdtempSync(path.join(betaRoot, ".tester123-regression-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = {
    list: async () => [{
      id: "workiq",
      manifestName: "@kody-w/workiq",
      singletonSha256: "a".repeat(64),
    }],
  };
  const manager = new TwinManager({
    betaHome: directory,
    brainstemConfig: {},
    createWorkerProcess: (config) => new ReadyOnlyChatWorker(config),
    storeClient: store,
    rarClient: store,
  });
  t.after(() => manager.stopAll());
  const twin = await manager.hatchLocal({
    id: "TESTER123",
    name: "TESTER123",
    agentSources: [{
      filename: "buddy_role_agent.py",
      source: readyOnlySource,
    }],
  });

  const before = JSON.parse((await manager.chat(
    twin.id,
    "Get emails for me",
    { author: "Tester" },
  )).response);
  assert.deepEqual(before, {
    status: "ready",
    message: "Get emails for me",
  });
  assert.equal(Object.hasOwn(before, "messages"), false);

  assert.equal(
    typeof manager.adaptationPropose,
    "function",
    "before-fix failure: the twin acknowledged email but had no adaptation controller",
  );
  const diagnosis = await manager.adaptationPropose(twin.id, {
    capability: "email",
    request: "That only acknowledged readiness. Fetch real email and remember context.",
  });
  assert.equal(diagnosis.capability.diagnosis.signals.stub, true);
  assert.equal(diagnosis.capability.proposal.strategy, "REUSE_BIND");
  assert.equal(diagnosis.capability.proposal.capability_id, "@kody-w/workiq");
  assert.equal(
    diagnosis.capability.proposal.memory_binding,
    "BIND_EXISTING_MEMORY_AGENTS",
  );
});
