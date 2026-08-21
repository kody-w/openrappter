import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { startFixtureCatalog } from "./harness/fixture-catalog.mjs";
import { launch } from "./harness/launch.mjs";
import { frontierTest } from "./harness/test-support.mjs";

frontierTest("store source switch hatches a sha-pinned twin that can chat", async () => {
  const catalog = await startFixtureCatalog();
  let app = null;
  try {
    app = await launch({
      initialStoreSource: {
        key: "bootstrap",
        url: catalog.bootstrapCatalogUrl,
      },
      modelScript: {
        steps: [{
          when: { lastUser: "diagnose the fixture" },
          response: { text: "TWIN_FIXTURE_REPLY" },
        }],
      },
      scenario: "store-hatch",
    });

    await app.driver.run([
      {
        action: "click",
        optional: true,
        selector: "#enter",
        settleMs: 100,
      },
      {
        action: "click",
        selector: "#surgeon-herd-btn",
        settleMs: 100,
      },
      {
        action: "click",
        selector: "#surgeon-herd .hstore",
        settleMs: 100,
      },
    ], { target: "shell" });
    await app.driver.expect({
      selector: ".store-picker",
      target: "shell",
      text: "This RAR source lists no agents",
      timeoutMs: 10_000,
    });
    await app.driver.run([
      {
        action: "click",
        targetText: "Custom…",
        settleMs: 100,
      },
      {
        action: "type",
        selector: ".store-custom-row input",
        typingDelayMs: 0,
        value: catalog.catalogUrl,
      },
      {
        action: "click",
        selector: ".store-custom-row button",
        settleMs: 200,
      },
    ], { target: "shell" });
    await app.driver.expect({
      selector: `.store-row[data-store-id="${catalog.id}"] .store-hatch`,
      target: "shell",
      text: catalog.name,
      timeoutMs: 10_000,
    });

    const storeSource = JSON.parse(readFileSync(
      path.join(app.paths.betaHome, "store-source.json"),
      "utf8",
    ));
    assert.deepEqual(storeSource, {
      key: "custom",
      url: catalog.catalogUrl,
    });

    await app.driver.run([{
      action: "click",
      selector: `.store-row[data-store-id="${catalog.id}"] .store-hatch`,
      settleMs: 100,
    }], { target: "shell" });
    const twinId = `${catalog.id}-1`;
    await app.driver.expect({
      selector: `.herd-tile.twin[data-twin-id="${twinId}"] .hst`,
      target: "shell",
      text: /ready/i,
      timeoutMs: 30_000,
    });

    const agentPath = path.join(
      app.paths.betaHome,
      "twins",
      twinId,
      "agents",
      "tiny_fixture_agent.py",
    );
    assert.equal(existsSync(agentPath), true);
    assert.equal(readFileSync(agentPath, "utf8"), catalog.agentSource);

    await app.driver.run([
      {
        action: "type",
        selector: `.herd-tile.twin[data-twin-id="${twinId}"] .twin-comp textarea`,
        typingDelayMs: 0,
        value: "diagnose the fixture",
      },
      {
        action: "click",
        selector: `.herd-tile.twin[data-twin-id="${twinId}"] .tw-send`,
        settleMs: 100,
      },
    ], { target: "shell" });
    await app.driver.expect({
      selector: `.herd-tile.twin[data-twin-id="${twinId}"] .twin-chat`,
      target: "shell",
      text: "TWIN_FIXTURE_REPLY",
      timeoutMs: 20_000,
    });

    assert(catalog.requests.includes("/index.json"));
    assert(catalog.requests.includes("/bootstrap.json"));
    assert(catalog.requests.includes("/tiny_fixture_agent.py"));
    assert(app.model.requests.some((request) => (
      request.request.messages.some((message) => (
        message.role === "user" && message.content === "diagnose the fixture"
      ))
    )));
  } finally {
    const cleanup = await Promise.allSettled([
      app?.stop(),
      catalog.stop(),
    ]);
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
});
