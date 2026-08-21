import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { launch } from "./harness/launch.mjs";
import { frontierTest } from "./harness/test-support.mjs";

async function sendComposerWord(app, value, reply) {
  await app.driver.run([{
    action: "type",
    selector: "#input",
    typingDelayMs: 1,
    value,
  }]);
  await app.driver.run([{
    action: "click",
    selector: "#send",
    settleMs: 50,
  }]);
  return app.driver.expect({
    text: reply,
    timeoutMs: 30_000,
  });
}

frontierTest("Frontier silently quarantines a broken agent; Ring-1 self-report is bypassed", async () => {
  const app = await launch({
    modelScript: {
      steps: [{
        when: {
          lastUser: "verify the Frontier stays available",
          stream: true,
        },
        response: { text: "FRONTIER_REMAINS_AVAILABLE" },
      }],
    },
    scenario: "ambient-quarantine",
  });
  try {
    const brokenFilename = "ambient_broken_agent.py";
    const fixtureDirectory = path.join(app.paths.root, "fixtures");
    mkdirSync(fixtureDirectory, { recursive: true });
    const brokenTarget = path.join(fixtureDirectory, brokenFilename);
    const brokenPath = path.join(
      app.paths.grail,
      "agents",
      brokenFilename,
    );
    writeFileSync(
      brokenTarget,
      "from agents.basic_agent import BasicAgent\n"
        + "class AmbientBrokenAgent(BasicAgent)\n"
        + "    pass\n",
      { mode: 0o600 },
    );
    // Frontier reads global agent symlinks, while LineageStore's pristine
    // baseline inventory intentionally protects only regular factory files.
    symlinkSync(brokenTarget, brokenPath, "file");
    assert.equal(existsSync(brokenPath), true);

    // The baseline word uses the production startDefault route-restart path.
    // With no lineage overlay to fall back from, the dry-load quarantine tier
    // removes the invalid source before starting the replacement worker.
    await sendComposerWord(
      app,
      "baseline",
      "Reverted to Grail baseline",
    );

    const telemetry = await app.driver.routeTelemetry({ trace: false });
    const quarantine = telemetry.events
      .filter((event) => event.type === "composition-quarantine")
      .at(-1);
    assert(quarantine, "the recomposition must record a quarantine event");
    const excluded = quarantine.excluded_files.find(
      (entry) => entry.filename === brokenFilename,
    );
    assert(excluded, `quarantine telemetry must name ${brokenFilename}`);
    assert.match(
      excluded.reason,
      /loaded no agents|SyntaxError|invalid syntax|expected ':'/i,
    );
    assert.equal(
      existsSync(path.join(
        telemetry.active_composition_fingerprint.agent_directory,
        brokenFilename,
      )),
      false,
      "the broken source must remain outside the executable composition",
    );

    const healthResponse = await fetch(
      `${telemetry.active_route.url}/health`,
      { signal: AbortSignal.timeout(5_000) },
    );
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.status, "ok");
    for (const expected of [
      "ContextMemory",
      "HackerNews",
      "ManageMemory",
      "LearnNew",
    ]) {
      assert(
        health.agents.includes(expected),
        `healthy worker must retain ${expected}`,
      );
    }
    assert.equal(health.agents.includes("AmbientBroken"), false);

    await app.driver.command({
      action: "chat",
      timeoutMs: 30_000,
      value: "verify the Frontier stays available",
    });

    assert.equal(app.model.requests.length, 1);
    const request = app.model.requests[0].request;
    const systemContext = request.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content || ""))
      .join("\n");
    assert.doesNotMatch(systemContext, /<system_status>/);
    assert.doesNotMatch(systemContext, new RegExp(brokenFilename));

    // UI Driver v2's inspect returns a compact outline, not page text; the
    // visible-words check reads the whole shell body at the read cap.
    const shellState = await app.driver.command({
      action: "read",
      limit: 60_000,
      selector: "body",
      target: "shell",
    });
    assert.equal(typeof shellState.text, "string");
    assert.ok(shellState.text.length > 0, "the shell must have visible text");
    assert.doesNotMatch(
      shellState.text,
      /ambient_broken_agent|quarantin|failed to load/i,
    );
    const shellError = await app.driver.command({
      action: "read",
      selector: "#error",
      target: "shell",
    });
    assert.equal(shellError.text, "");
    const brainstemState = await app.driver.command({
      action: "read",
      limit: 60_000,
      selector: "body",
    });
    assert.equal(typeof brainstemState.text, "string");
    assert.ok(brainstemState.text.length > 0, "the Brainstem must have visible text");
    assert.doesNotMatch(
      brainstemState.text,
      /ambient_broken_agent|quarantin|failed to load/i,
    );
  } finally {
    await app.stop();
  }
});
