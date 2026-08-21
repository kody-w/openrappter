import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

import { launch } from "./harness/launch.mjs";
import { frontierTest } from "./harness/test-support.mjs";

function readText(filePath) {
  return readFileSync(filePath, "utf8").trim();
}

function findLocus(root, filename) {
  for (const name of readdirSync(root).sort()) {
    const directory = path.join(root, name);
    const manifestPath = path.join(directory, "locus.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.filename === filename) return { directory, manifest };
  }
  throw new Error(`Lineage locus not found for ${filename}.`);
}

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

frontierTest("lineage words move HEADs and promote environments through the composer", async () => {
  const app = await launch({ scenario: "lineage-words" });
  try {
    const locus = findLocus(
      app.paths.lineageHome,
      "context_memory_agent.py",
    );
    const headPath = path.join(locus.directory, "HEAD");
    const priorHeadPath = path.join(locus.directory, "PRIOR_HEAD");
    const prodHeadPath = path.join(locus.directory, "HEAD.prod");
    const promotionsPath = path.join(locus.directory, "promotions.json");
    const initialHead = readText(headPath);
    const initialRoute = app.route.url;
    assert.match(initialHead, /^rappid:@frontier\/context-memory-ring:/);

    await sendComposerWord(app, "baseline", "Reverted to Grail baseline");
    const baselineHead = readText(headPath);
    assert.match(baselineHead, /^rappid:@grail\/context-memory:/);
    assert.notEqual(baselineHead, initialHead);
    assert.equal(readText(priorHeadPath), initialHead);
    const baselineTelemetry = await app.driver.routeTelemetry({ trace: false });
    assert.notEqual(baselineTelemetry.active_route.url, initialRoute);

    await sendComposerWord(
      app,
      "restore",
      "Restored the latest verified molts",
    );
    assert.equal(readText(headPath), initialHead);
    // restore is the inverse of baseline and CONSUMES the displaced generation:
    // a stale PRIOR_HEAD must never be able to move a newer live ring back.
    assert.equal(existsSync(priorHeadPath), false);
    const restoreTelemetry = await app.driver.routeTelemetry({ trace: false });
    assert.notEqual(
      restoreTelemetry.active_route.url,
      baselineTelemetry.active_route.url,
    );

    await sendComposerWord(
      app,
      "environments",
      "Molt Lineage environments",
    );
    const transcript = await app.driver.command({
      action: "read",
      selector: "#chat",
    });
    assert.match(transcript.text, /default/);

    await sendComposerWord(app, "promote default prod", "prod");
    assert.equal(readText(prodHeadPath), initialHead);
    const promotions = JSON.parse(readFileSync(promotionsPath, "utf8"));
    assert(promotions.length > 0);
    const promotion = promotions.at(-1);
    assert.equal(promotion.from_env, "default");
    assert.equal(promotion.to_env, "prod");
    assert.equal(promotion.ok, true);
    assert.equal(promotion.source_head, initialHead);
    assert.equal(promotion.target_head, initialHead);
    await sendComposerWord(app, "environments", "prod");
    const promotedTranscript = await app.driver.command({
      action: "read",
      selector: "#chat",
    });
    assert.match(promotedTranscript.text, /prod/);

    assert.equal(
      app.model.requests.length,
      0,
      "lineage control words must be intercepted before the model",
    );
  } finally {
    await app.stop();
  }
});
