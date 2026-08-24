import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import {
  SemanticTrace,
  SemanticUiPlanRunner,
} from "../../electron/semantic-ui-plan.mjs";
import { startFixtureCatalog } from "./harness/fixture-catalog.mjs";
import { launch } from "./harness/launch.mjs";
import { frontierTest } from "./harness/test-support.mjs";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "bookfactory-hatch",
);
const provenance = JSON.parse(
  readFileSync(path.join(fixtureRoot, "provenance.json"), "utf8"),
);
const bookFactorySource = readFileSync(
  path.join(fixtureRoot, provenance.fixed.fixture),
  "utf8",
);
const failingBookFactorySource = readFileSync(
  path.join(fixtureRoot, provenance.failing.fixture),
  "utf8",
);
const plan = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "fixtures", "bookfactory-semantic-plan.json"),
    "utf8",
  ),
);

frontierTest("semantic journey hatches and chats with the pinned BookFactory", async () => {
  assert.equal(
    createHash("sha256").update(bookFactorySource).digest("hex"),
    provenance.fixed.sha256,
  );
  const catalog = await startFixtureCatalog({
    agentSource: bookFactorySource,
    filename: "bookfactory_agent.py",
    id: "bookfactory",
    license: "BSD-style",
    name: "BookFactory",
  });

  frontierTest("semantic journey captures the pinned BookFactory hatch failure", async () => {
    assert.equal(
      createHash("sha256").update(failingBookFactorySource).digest("hex"),
      provenance.failing.sha256,
    );
    const catalog = await startFixtureCatalog({
      agentSource: failingBookFactorySource,
      filename: "bookfactory_agent.py",
      id: "bookfactory",
      license: "BSD-style",
      name: "BookFactory",
    });
    let app = null;
    try {
      app = await launch({
        env: { OPENRAPPTER_SEMANTIC_CONTROL: "1" },
        initialStoreSource: {
          key: "custom",
          url: catalog.catalogUrl,
        },
        scenario: "semantic-bookfactory-failure",
      });
      const tracePath = path.join(app.paths.root, "traces", "semantic-plan.jsonl");
      const trace = new SemanticTrace({
        filePath: tracePath,
        roots: [app.paths.root],
      });
      const runner = new SemanticUiPlanRunner({
        command: (command) => app.driver.command(command, { trace: false }),
        record: (event) => trace.record(event),
      });
      const result = await runner.run({
        schema: "openrappter-ui-plan/1.0",
        name: "bookfactory-fail-before",
        actions: [
          { action: "select_store_item", id: "bookfactory" },
          { action: "click_known", handle: "@store[bookfactory].hatch" },
          {
            action: "assert_visible_text",
            target: "shell",
            text: "Couldn't hatch BookFactory",
            timeoutMs: 30000
          },
          { action: "screenshot", name: "bookfactory-hatch-error" }
        ],
      });
      assert.equal(result.ok, true);
      const screenshot = result.results.find(
        (event) => event.action === "screenshot",
      )?.result?.path;
      assert.equal(existsSync(screenshot), true);
      const traceText = readFileSync(tracePath, "utf8");
      assert.match(traceText, /"action":"assert_visible_text"/);
      assert.match(traceText, /"action":"screenshot"/);
    } finally {
      const cleanup = await Promise.allSettled([
        app?.stop(),
        catalog.stop(),
      ]);
      const failure = cleanup.find((item) => item.status === "rejected");
      if (failure) throw failure.reason;
    }
  });
  let app = null;
  try {
    app = await launch({
      env: { OPENRAPPTER_SEMANTIC_CONTROL: "1" },
      initialStoreSource: {
        key: "custom",
        url: catalog.catalogUrl,
      },
      modelScript: {
        steps: [
          {
            when: {
              hasTool: "BookFactory",
              lastUser: "Turn these fixture notes into a one-paragraph chapter.",
            },
            response: {
              toolCalls: [{
                arguments: {
                  author: "Fixture Author",
                  chapter_title: "Fixture Chapter",
                  source: "Deterministic fixture notes.",
                },
                name: "BookFactory",
              }],
            },
          },
          {
            when: { hasToolResult: "BookFactory" },
            response: {
              text: "BOOKFACTORY_TOOL_INVOKED: Book factory complete and displayed.",
            },
          },
        ],
      },
      scenario: "semantic-bookfactory",
    });
    const semanticTracePath = path.join(
      app.paths.root,
      "traces",
      "semantic-plan.jsonl",
    );
    const trace = new SemanticTrace({
      filePath: semanticTracePath,
      roots: [app.paths.root],
    });
    const runner = new SemanticUiPlanRunner({
      command: (command) => app.driver.command(command, { trace: false }),
      record: (event) => trace.record(event),
    });

    const result = await runner.run(plan);

    assert.equal(result.ok, true);
    assert.equal(result.ran, plan.actions.length);
    assert.equal(runner.twinId, "bookfactory-1");
    const twinRoot = path.join(app.paths.betaHome, "twins", runner.twinId);
    const agentPath = path.join(twinRoot, "agents", "bookfactory_agent.py");
    assert.equal(readFileSync(agentPath, "utf8"), bookFactorySource);
    for (const artifact of [
      "00-source.md",
      "01-draft.md",
      "02-edited.md",
      "03-ceo-note.md",
      "04-final-chapter.md",
      "05-review.md",
    ]) {
      assert.equal(
        existsSync(path.join(twinRoot, "workspace", artifact)),
        true,
        `${artifact} must stay inside the twin workspace`,
      );
    }
    const traceText = readFileSync(semanticTracePath, "utf8");
    assert.match(traceText, /"action":"hatch"/);
    assert.match(traceText, /"action":"screenshot"/);
    assert.doesNotMatch(traceText, /token|Authorization/);
    assert(app.model.requests.some((request) => (
      request.request.messages.some((message) => (
        message.role === "tool" && message.name === "BookFactory"
      ))
    )));
    await app.driver.expect({
      selector: `.herd-tile.twin[data-twin-id="${runner.twinId}"]`,
      target: "shell",
      text: /BookFactory[\s\S]*ready/i,
      timeoutMs: 10_000,
    });
  } finally {
    const cleanup = await Promise.allSettled([
      app?.stop(),
      catalog.stop(),
    ]);
    const failure = cleanup.find((item) => item.status === "rejected");
    if (failure) throw failure.reason;
  }
});
